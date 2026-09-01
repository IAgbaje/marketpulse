-- =============================================================================
-- 20260831000001_core_schema.sql — MarketPulse base schema (Technical Requirements §2, §8, §9)
--
-- This is the Phase-0 schema. Fields marked below CANNOT be retrofitted cheaply
-- once user history accumulates (TR §2) — they are all present here.
--
-- Decisions this migration commits, that TR flagged as still-open:
--
--  * locations hierarchy (§2.1): Nigeria's admin structure is a FIXED 5 levels
--    (country → state → LGA → area → market). Denormalised ancestor FKs
--    (state_id, lga_id, area_id) alongside parent_id — every rollup becomes a
--    plain indexed filter, no recursive CTE, no ltree dependency.
--
--  * aggregation mechanism (§9.4): "enqueued immediately on trip edit/delete"
--    needs a real queue — pg_cron is a scheduler, not a queue. Implemented as
--    `aggregate_refresh_queue` (job table) + AFTER triggers on purchase_lines
--    and shopping_trips + `drain_aggregate_refresh_queue()` (advisory-locked,
--    SKIP LOCKED, recomputes each bucket from raw lines as a fresh snapshot —
--    the §7.1 dedupe-safety condition) + a nightly full rebuild. pg_cron only
--    *drains* the queue; it never *is* the queue.
--
-- Invariants carried in (TR §7):
--  * Money is integer kobo (bigint). currency is a mandatory sibling of every
--    amount. No floats in stored money.
--  * qty_in_base_unit is an integer count of base sub-units: grams, millilitres,
--    or pieces×1000 (so "half a piece" is representable) — see §7.6.
--  * Aggregate privacy/quality floor: >= 5 DISTINCT users after per-(user,
--    commodity, market, day) dedupe; publish p25 / median / p75, never min–max.
--  * Recall pollution: trips with capture_method='recall' are excluded from
--    crowd aggregates (kept in personal history).
--  * Conflict resolution: whole-trip granularity, ordered by server_received_at,
--    never device clock. local_edited_at is carried through for the
--    "edited on another device" UI (§7.1), not for ordering.
--  * RLS is written as `user_id = auth.uid()` — never `auth.role() =
--    'authenticated'`, which would change behaviour at the anonymous→permanent
--    upgrade boundary (§2.3).
--
-- Reversibility: DOWN block at the foot of the file.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- trigram indexes for name/alias search

-- pg_cron is enabled here if it is available; if the platform has not
-- allow-listed it yet, the migration still applies and the two schedules at the
-- foot are skipped (re-run just those after enabling it via the dashboard).
DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron not enabled (%). Aggregate schedules will be skipped — enable pg_cron and run section 5 manually.', SQLERRM;
END
$cron$;

-- =============================================================================
-- 1. REFERENCE DATA  (seeded from marketpulse/data/*.json — read-only to clients)
-- =============================================================================

-- 1.1 locations — fixed 5-level hierarchy, ancestor chain denormalised.
CREATE TYPE location_level AS ENUM ('country', 'state', 'lga', 'area', 'market');
CREATE TYPE market_kind    AS ENUM ('open_market', 'supermarket', 'unknown');

CREATE TABLE locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  level        location_level NOT NULL,
  name         text NOT NULL,
  parent_id    uuid REFERENCES locations (id),
  -- Denormalised ancestors (§2.1). Computed once at seed time, never recomputed.
  country_id   uuid REFERENCES locations (id),
  state_id     uuid REFERENCES locations (id),
  lga_id       uuid REFERENCES locations (id),
  area_id      uuid REFERENCES locations (id),
  -- Phase-0-critical (§2): one of the six fields §13 calls the entire B2B asset.
  market_type  market_kind NOT NULL DEFAULT 'unknown',
  -- Filled at stage 8 when PostGIS arrives; nullable now (PostGIS is NOT an MVP
  -- dependency — the MVP location model is these FK relations, not geometry).
  centroid_lat double precision,
  centroid_lon double precision,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT market_type_only_on_markets
    CHECK (market_type = 'unknown' OR level = 'market')
);
CREATE INDEX idx_locations_level      ON locations (level);
CREATE INDEX idx_locations_parent     ON locations (parent_id);
CREATE INDEX idx_locations_state      ON locations (state_id);
CREATE INDEX idx_locations_lga        ON locations (lga_id);
CREATE INDEX idx_locations_area       ON locations (area_id);
CREATE INDEX idx_locations_name_trgm  ON locations USING gin (name gin_trgm_ops);

-- 1.2 commodities — mirrors marketpulse/data/commodities.json
CREATE TYPE commodity_base_unit AS ENUM ('g', 'ml', 'piece');
CREATE TYPE purchase_form       AS ENUM ('loose', 'pre_packed', 'bulk');

CREATE TABLE commodities (
  id               text PRIMARY KEY,               -- slug, e.g. 'rice_local'
  canonical_name   text NOT NULL,
  category         text NOT NULL,
  base_unit        commodity_base_unit NOT NULL,
  substitute_group text,                            -- Phase-0-critical (§2)
  perishable       boolean NOT NULL DEFAULT false,
  grade_sensitive  boolean NOT NULL DEFAULT false,  -- aggregate must disclose caveat (§11.2)
  nbs_hfcp_mapped  boolean NOT NULL DEFAULT false,  -- false ⇒ no seeded crowd band (§11.4)
  retired          boolean NOT NULL DEFAULT false,  -- design-for-deletion: never hard-delete with history
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_commodities_substitute_group ON commodities (substitute_group);
CREATE INDEX idx_commodities_category ON commodities (category);

CREATE TABLE commodity_aliases (
  commodity_id text NOT NULL REFERENCES commodities (id) ON DELETE CASCADE,
  alias        text NOT NULL,
  PRIMARY KEY (commodity_id, alias)
);
CREATE INDEX idx_commodity_aliases_alias_trgm ON commodity_aliases USING gin (alias gin_trgm_ops);

-- 1.3 commodity_units — informal-measure → base-unit conversions.
-- factor is an EXACT rational (base units per 1 unit_code). confidence MUST
-- propagate to lower aggregate confidence downstream (§11.5).
CREATE TYPE conversion_confidence AS ENUM ('high', 'medium', 'low');

CREATE TABLE commodity_units (
  id             text PRIMARY KEY,
  unit_code      text NOT NULL,                    -- 'paint_rubber', 'derica', 'crate', ...
  to_base_unit   commodity_base_unit NOT NULL,
  commodity_id   text REFERENCES commodities (id), -- NULL ⇒ commodity-independent ('*')
  factor_num     bigint NOT NULL CHECK (factor_num > 0),
  factor_den     bigint NOT NULL CHECK (factor_den > 0),
  confidence     conversion_confidence NOT NULL,
  grade_sensitive boolean NOT NULL DEFAULT false,
  note           text,
  CONSTRAINT grade_sensitive_never_high
    CHECK (NOT grade_sensitive OR confidence <> 'high')
);
CREATE UNIQUE INDEX uq_commodity_units_scope
  ON commodity_units (unit_code, COALESCE(commodity_id, '*'), to_base_unit);

-- =============================================================================
-- 2. USER DATA
-- =============================================================================

-- 2.1 users — profile extension of auth.users. Auto-created for every auth user
-- (including anonymous) so FKs and the §2.3 merge have a stable target.
CREATE TABLE users (
  id             uuid PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  home_location_id uuid REFERENCES locations (id),
  display_name   text,
  -- §2.2: local Dexie schema version the client last synced with. When the
  -- server's minimum-supported client moves past this, prompt a PWA update.
  schema_version integer NOT NULL DEFAULT 1,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION handle_new_auth_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.users (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();

-- 2.2 shopping_trips
CREATE TYPE trip_status   AS ENUM ('draft', 'confirmed');
CREATE TYPE capture_method AS ENUM ('same_day', 'recall');

CREATE TABLE shopping_trips (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Client-supplied, stable across offline retries → idempotent sync (§7).
  client_trip_id    uuid NOT NULL,
  market_id         uuid NOT NULL REFERENCES locations (id),
  trip_date         date NOT NULL,
  status            trip_status NOT NULL DEFAULT 'confirmed',
  -- Phase-0-critical (§2): >48h post-trip ⇒ 'recall'; recall trips are excluded
  -- from crowd aggregates. Set by trigger below, not trusted from the client.
  capture_method    capture_method NOT NULL DEFAULT 'same_day',
  currency          text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  note              text,
  -- Conflict resolution (§9.2): server_received_at is the ONLY ordering key.
  server_received_at timestamptz NOT NULL DEFAULT now(),
  -- Carried through the sync queue for the "edited on another device" UI (§7.1).
  local_edited_at   timestamptz,
  last_edited_device text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_trip_id)
);
CREATE INDEX idx_trips_user           ON shopping_trips (user_id);
CREATE INDEX idx_trips_market_date    ON shopping_trips (market_id, trip_date);
CREATE INDEX idx_trips_received       ON shopping_trips (server_received_at);

-- Set capture_method authoritatively from the clock, and bump ordering fields.
CREATE OR REPLACE FUNCTION trips_before_write()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (now()::date - NEW.trip_date) > 2 THEN
    NEW.capture_method := 'recall';
  ELSE
    NEW.capture_method := COALESCE(NEW.capture_method, 'same_day');
  END IF;
  IF TG_OP = 'UPDATE' THEN
    NEW.server_received_at := now();
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_trips_before_write
  BEFORE INSERT OR UPDATE ON shopping_trips
  FOR EACH ROW EXECUTE FUNCTION trips_before_write();

-- 2.3 purchase_lines — the atomic price observation. Every crowd data point
-- originates here.
CREATE TABLE purchase_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           uuid NOT NULL REFERENCES shopping_trips (id) ON DELETE CASCADE,
  -- Denormalised for RLS and for aggregate dedupe; set by trigger from the trip.
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_line_id    uuid NOT NULL,
  commodity_id      text NOT NULL REFERENCES commodities (id),
  -- What the user actually entered.
  unit_code         text NOT NULL,           -- 'kg', 'derica', 'paint_rubber', 'piece', ...
  qty_entered       numeric(14,4) NOT NULL CHECK (qty_entered > 0),
  -- Converted to the commodity's base sub-unit. Integer. Phase-0-critical (§2).
  qty_in_base_unit  bigint NOT NULL CHECK (qty_in_base_unit > 0),
  -- Money: integer kobo, with its mandatory currency sibling. Phase-0-critical.
  paid_price_kobo   bigint NOT NULL CHECK (paid_price_kobo >= 0),
  currency          text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  -- Phase-0-critical (§2): pack-size discounts render as false price drops
  -- without this.
  purchase_form     purchase_form NOT NULL DEFAULT 'loose',
  -- Display / comparison ONLY — micro-kobo per base unit. NEVER summed in the
  -- decomposition (that path uses exact BigInt rationals, see marketpulse/lib/
  -- engine/). Generated so it can never drift from the source columns.
  unit_price_micro_kobo bigint
    GENERATED ALWAYS AS (
      round(paid_price_kobo::numeric * 1000000 / NULLIF(qty_in_base_unit, 0))::bigint
    ) STORED,
  -- Outlier handling (US-3.3): flagged lines left unconfirmed are excluded from
  -- both crowd aggregates and the decomposition's four buckets (they surface as
  -- the EXCLUDED_DELTA reconciliation line).
  flagged_outlier   boolean NOT NULL DEFAULT false,
  outlier_confirmed boolean,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trip_id, client_line_id)
);
CREATE INDEX idx_lines_trip      ON purchase_lines (trip_id);
CREATE INDEX idx_lines_user      ON purchase_lines (user_id);
CREATE INDEX idx_lines_commodity ON purchase_lines (commodity_id);
-- Hot path for bucket recompute: raw lines by (commodity, trip) — join to trip
-- for market/date. Partial index skips excluded outliers.
CREATE INDEX idx_lines_agg_source ON purchase_lines (commodity_id)
  WHERE NOT (flagged_outlier AND outlier_confirmed IS NOT TRUE);

CREATE OR REPLACE FUNCTION lines_set_user_id()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT t.user_id INTO NEW.user_id FROM shopping_trips t WHERE t.id = NEW.trip_id;
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'purchase_lines: trip % not found', NEW.trip_id;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER trg_lines_set_user_id
  BEFORE INSERT OR UPDATE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION lines_set_user_id();

-- 2.4 user_budgets
CREATE TYPE budget_source AS ENUM ('derived_from_trip', 'manual');

CREATE TABLE user_budgets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  amount_kobo   bigint NOT NULL CHECK (amount_kobo >= 0),
  currency      text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  period_kind   text NOT NULL DEFAULT 'monthly' CHECK (period_kind = 'monthly'),
  effective_from date NOT NULL,
  source        budget_source NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, effective_from)
);
CREATE INDEX idx_user_budgets_user ON user_budgets (user_id);

-- 2.5 watchlist
CREATE TABLE watchlist (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  commodity_id   text NOT NULL REFERENCES commodities (id),
  market_id      uuid REFERENCES locations (id),        -- NULL ⇒ any market
  threshold_kobo bigint CHECK (threshold_kobo IS NULL OR threshold_kobo >= 0),
  currency       text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, commodity_id, market_id)
);
CREATE INDEX idx_watchlist_user ON watchlist (user_id);

-- =============================================================================
-- 3. SERVING LAYER — price_aggregates + the refresh queue (§9.4)
-- =============================================================================

-- Incrementally maintained. NEVER read raw purchase_lines at scale for crowd
-- bands or the map — read this table.
CREATE TABLE price_aggregates (
  commodity_id        text NOT NULL REFERENCES commodities (id),
  market_id           uuid NOT NULL REFERENCES locations (id),
  period_month        date NOT NULL,          -- first day of the month
  currency            text NOT NULL,
  -- Published band (kobo per base unit). p25 / median / p75 — never min–max.
  p25_kobo            bigint,
  median_kobo         bigint,
  p75_kobo            bigint,
  -- The privacy / quality floor (§7): >= 5 DISTINCT users after per-(user,
  -- commodity, market, day) dedupe. Below 5 ⇒ band columns stay NULL and the
  -- client shows the designed empty state.
  distinct_user_count integer NOT NULL DEFAULT 0,
  observation_count   integer NOT NULL DEFAULT 0,
  -- True if ANY contributing commodity row is grade_sensitive — client discloses.
  grade_caveat        boolean NOT NULL DEFAULT false,
  computed_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (commodity_id, market_id, period_month, currency)
);
CREATE INDEX idx_price_aggregates_market ON price_aggregates (market_id, period_month);

-- The queue. pg_cron drains it; triggers fill it. A partial unique index
-- collapses duplicate pending enqueues for the same bucket.
CREATE TABLE aggregate_refresh_queue (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  commodity_id text NOT NULL,
  market_id    uuid NOT NULL,
  period_month date NOT NULL,
  currency     text NOT NULL,
  enqueued_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX uq_refresh_queue_pending
  ON aggregate_refresh_queue (commodity_id, market_id, period_month, currency)
  WHERE processed_at IS NULL;

-- 3.1 enqueue helper
CREATE OR REPLACE FUNCTION enqueue_bucket(
  p_commodity_id text, p_market_id uuid, p_period_month date, p_currency text
) RETURNS void LANGUAGE sql AS $$
  INSERT INTO aggregate_refresh_queue (commodity_id, market_id, period_month, currency)
  VALUES (p_commodity_id, p_market_id, p_period_month, p_currency)
  ON CONFLICT DO NOTHING;
$$;

-- 3.2 triggers: any change to a line, or to a trip's market/date, dirties the
-- affected bucket(s).
-- Enqueue the bucket a single line belongs to, given commodity + trip.
CREATE OR REPLACE FUNCTION enqueue_line_bucket(p_commodity_id text, p_trip_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE m uuid; d date; cur text;
BEGIN
  IF p_commodity_id IS NULL OR p_trip_id IS NULL THEN RETURN; END IF;
  SELECT t.market_id, date_trunc('month', t.trip_date)::date, t.currency
    INTO m, d, cur FROM shopping_trips t WHERE t.id = p_trip_id;
  IF m IS NOT NULL THEN
    PERFORM enqueue_bucket(p_commodity_id, m, d, cur);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION lines_enqueue_bucket()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM enqueue_line_bucket(NEW.commodity_id, NEW.trip_id);
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM enqueue_line_bucket(OLD.commodity_id, OLD.trip_id);
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_lines_enqueue
  AFTER INSERT OR UPDATE OR DELETE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION lines_enqueue_bucket();

CREATE OR REPLACE FUNCTION trips_enqueue_buckets()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_trip_id uuid;
BEGIN
  -- On UPDATE, only act when the trip moved market/month or capture_method flipped
  -- (a line-level change already enqueued via the purchase_lines trigger).
  IF TG_OP = 'UPDATE'
     AND NEW.market_id IS NOT DISTINCT FROM OLD.market_id
     AND date_trunc('month', NEW.trip_date) IS NOT DISTINCT FROM date_trunc('month', OLD.trip_date)
     AND NEW.capture_method IS NOT DISTINCT FROM OLD.capture_method
  THEN
    RETURN NULL;
  END IF;

  v_trip_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;

  FOR r IN SELECT DISTINCT commodity_id FROM purchase_lines WHERE trip_id = v_trip_id
  LOOP
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      PERFORM enqueue_bucket(r.commodity_id, NEW.market_id,
                             date_trunc('month', NEW.trip_date)::date, NEW.currency);
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      PERFORM enqueue_bucket(r.commodity_id, OLD.market_id,
                             date_trunc('month', OLD.trip_date)::date, OLD.currency);
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
CREATE TRIGGER trg_trips_enqueue
  AFTER INSERT OR UPDATE OR DELETE ON shopping_trips
  FOR EACH ROW EXECUTE FUNCTION trips_enqueue_buckets();

-- 3.3 recompute one bucket from raw lines — a FRESH SNAPSHOT every time (the
-- §7.1 condition under which the >=5-distinct-users floor stays race-safe).
CREATE OR REPLACE FUNCTION recompute_bucket(
  p_commodity_id text, p_market_id uuid, p_period_month date, p_currency text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_users int; v_obs int;
  v_p25 bigint; v_med bigint; v_p75 bigint;
  v_grade boolean;
BEGIN
  -- One observation per (user, day): that user's mean unit price for the day,
  -- in kobo per base unit. Cast to double precision for percentile_cont (it does
  -- not accept numeric as the ordered column); the band is a display artifact,
  -- not the decomposition, so this is within policy (§7 forbids floats only in
  -- the exact-tie path).
  WITH day_obs AS (
    SELECT t.user_id,
           t.trip_date,
           (avg(pl.paid_price_kobo::numeric / pl.qty_in_base_unit))::double precision AS unit_price
    FROM purchase_lines pl
    JOIN shopping_trips t ON t.id = pl.trip_id
    WHERE pl.commodity_id = p_commodity_id
      AND t.market_id     = p_market_id
      AND t.currency      = p_currency
      AND date_trunc('month', t.trip_date)::date = p_period_month
      AND t.status = 'confirmed'
      AND t.capture_method <> 'recall'                       -- recall pollution (§7)
      AND NOT (pl.flagged_outlier AND pl.outlier_confirmed IS NOT TRUE)  -- outliers (US-3.3)
    GROUP BY t.user_id, t.trip_date
  )
  SELECT count(DISTINCT user_id), count(*),
         round(percentile_cont(0.25) WITHIN GROUP (ORDER BY unit_price))::bigint,
         round(percentile_cont(0.50) WITHIN GROUP (ORDER BY unit_price))::bigint,
         round(percentile_cont(0.75) WITHIN GROUP (ORDER BY unit_price))::bigint
    INTO v_users, v_obs, v_p25, v_med, v_p75
  FROM day_obs;

  SELECT grade_sensitive INTO v_grade FROM commodities WHERE id = p_commodity_id;

  IF v_users IS NULL OR v_users < 5 THEN
    -- Below the floor: keep the row for bookkeeping, null the band.
    INSERT INTO price_aggregates AS pa
      (commodity_id, market_id, period_month, currency,
       p25_kobo, median_kobo, p75_kobo, distinct_user_count, observation_count,
       grade_caveat, computed_at)
    VALUES (p_commodity_id, p_market_id, p_period_month, p_currency,
            NULL, NULL, NULL, COALESCE(v_users, 0), COALESCE(v_obs, 0),
            COALESCE(v_grade, false), now())
    ON CONFLICT (commodity_id, market_id, period_month, currency) DO UPDATE
      SET p25_kobo = NULL, median_kobo = NULL, p75_kobo = NULL,
          distinct_user_count = EXCLUDED.distinct_user_count,
          observation_count   = EXCLUDED.observation_count,
          grade_caveat = EXCLUDED.grade_caveat,
          computed_at  = now();
    RETURN;
  END IF;

  INSERT INTO price_aggregates AS pa
    (commodity_id, market_id, period_month, currency,
     p25_kobo, median_kobo, p75_kobo, distinct_user_count, observation_count,
     grade_caveat, computed_at)
  VALUES (p_commodity_id, p_market_id, p_period_month, p_currency,
          v_p25, v_med, v_p75, v_users, v_obs, COALESCE(v_grade, false), now())
  ON CONFLICT (commodity_id, market_id, period_month, currency) DO UPDATE
    SET p25_kobo = EXCLUDED.p25_kobo,
        median_kobo = EXCLUDED.median_kobo,
        p75_kobo = EXCLUDED.p75_kobo,
        distinct_user_count = EXCLUDED.distinct_user_count,
        observation_count   = EXCLUDED.observation_count,
        grade_caveat = EXCLUDED.grade_caveat,
        computed_at  = now();
END;
$$;

-- 3.4 drain the queue. Advisory-locked so a slow drain can't pile up behind
-- itself; SKIP LOCKED so concurrent drains cooperate.
CREATE OR REPLACE FUNCTION drain_aggregate_refresh_queue(p_batch int DEFAULT 500)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_done int := 0;
BEGIN
  IF NOT pg_try_advisory_lock(hashtext('drain_aggregate_refresh_queue')) THEN
    RETURN 0;  -- another drain is running
  END IF;

  FOR r IN
    SELECT id, commodity_id, market_id, period_month, currency
    FROM aggregate_refresh_queue
    WHERE processed_at IS NULL
    ORDER BY enqueued_at
    LIMIT p_batch
    FOR UPDATE SKIP LOCKED
  LOOP
    PERFORM recompute_bucket(r.commodity_id, r.market_id, r.period_month, r.currency);
    UPDATE aggregate_refresh_queue SET processed_at = now() WHERE id = r.id;
    v_done := v_done + 1;
  END LOOP;

  -- Housekeeping: drop processed rows older than a day.
  DELETE FROM aggregate_refresh_queue
   WHERE processed_at IS NOT NULL AND processed_at < now() - interval '1 day';

  PERFORM pg_advisory_unlock(hashtext('drain_aggregate_refresh_queue'));
  RETURN v_done;
END;
$$;

-- 3.5 nightly full rebuild — catches any bucket a missed trigger left stale.
CREATE OR REPLACE FUNCTION rebuild_all_aggregates()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_done int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT pl.commodity_id, t.market_id,
           date_trunc('month', t.trip_date)::date AS period_month, t.currency
    FROM purchase_lines pl JOIN shopping_trips t ON t.id = pl.trip_id
    WHERE t.status = 'confirmed'
  LOOP
    PERFORM recompute_bucket(r.commodity_id, r.market_id, r.period_month, r.currency);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;

REVOKE ALL ON FUNCTION drain_aggregate_refresh_queue(int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION rebuild_all_aggregates()           FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION recompute_bucket(text, uuid, date, text) FROM public, anon, authenticated;

-- =============================================================================
-- 4. ROW LEVEL SECURITY
-- =============================================================================

ALTER TABLE users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopping_trips      ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_budgets        ENABLE ROW LEVEL SECURITY;
ALTER TABLE watchlist           ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodity_aliases   ENABLE ROW LEVEL SECURITY;
ALTER TABLE commodity_units     ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_aggregates    ENABLE ROW LEVEL SECURITY;
ALTER TABLE aggregate_refresh_queue ENABLE ROW LEVEL SECURITY;  -- service role only, no policy

-- Reference data + the privacy-floored aggregates are world-readable (anon key).
CREATE POLICY ref_locations_read      ON locations         FOR SELECT USING (true);
CREATE POLICY ref_commodities_read    ON commodities       FOR SELECT USING (true);
CREATE POLICY ref_aliases_read        ON commodity_aliases FOR SELECT USING (true);
CREATE POLICY ref_units_read          ON commodity_units   FOR SELECT USING (true);
CREATE POLICY aggregates_read         ON price_aggregates  FOR SELECT USING (true);

-- User-owned data: owner-only.
--  * `TO authenticated` — Supabase anonymous sessions carry the `authenticated`
--    Postgres role, so this correctly scopes to "has a session" while
--    `auth.uid()` in USING/WITH CHECK does the real ownership check. `auth.role()`
--    is deliberately NOT used (deprecated; breaks under anonymous sign-in, §2.3).
--  * `(select auth.uid())` — wrapped in a scalar sub-select so the planner
--    caches it as an initplan instead of re-evaluating per row.
--  * every UPDATE-capable policy has BOTH USING and WITH CHECK, so a row's
--    user_id can never be reassigned to someone else.
CREATE POLICY users_self        ON users
  FOR ALL TO authenticated
  USING (id = (select auth.uid())) WITH CHECK (id = (select auth.uid()));

CREATE POLICY trips_owner       ON shopping_trips
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY lines_owner       ON purchase_lines
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM shopping_trips t
                      WHERE t.id = purchase_lines.trip_id
                        AND t.user_id = (select auth.uid())));

CREATE POLICY budgets_owner     ON user_budgets
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

CREATE POLICY watchlist_owner   ON watchlist
  FOR ALL TO authenticated
  USING (user_id = (select auth.uid())) WITH CHECK (user_id = (select auth.uid()));

-- =============================================================================
-- 5. SCHEDULES (pg_cron). Does NOT fire on a paused Supabase project (TR §1) —
-- the anti-pause measure is part of data correctness, not a convenience.
-- Guarded: if pg_cron was not enabled above, this block is a no-op — run it
-- again after enabling the extension.
-- =============================================================================
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('drain-aggregate-queue', '*/5 * * * *',
      'SELECT drain_aggregate_refresh_queue();');
    PERFORM cron.schedule('rebuild-aggregates-nightly', '45 3 * * *',
      'SELECT rebuild_all_aggregates();');
  ELSE
    RAISE NOTICE 'pg_cron absent — aggregate schedules NOT created. Enable pg_cron, then run the two cron.schedule() calls in section 5.';
  END IF;
END
$sched$;

-- =============================================================================
-- DOWN (manual):
--   SELECT cron.unschedule('drain-aggregate-queue');
--   SELECT cron.unschedule('rebuild-aggregates-nightly');
--   DROP TABLE IF EXISTS aggregate_refresh_queue, price_aggregates,
--     watchlist, user_budgets, purchase_lines, shopping_trips, users,
--     commodity_units, commodity_aliases, commodities, locations CASCADE;
--   DROP FUNCTION IF EXISTS drain_aggregate_refresh_queue(int),
--     rebuild_all_aggregates(), recompute_bucket(text,uuid,date,text),
--     enqueue_bucket(text,uuid,date,text), enqueue_line_bucket(text,uuid),
--     lines_enqueue_bucket(), trips_enqueue_buckets(), trips_before_write(),
--     lines_set_user_id(), handle_new_auth_user();
--   DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
--   DROP TYPE IF EXISTS location_level, market_kind, commodity_base_unit,
--     purchase_form, conversion_confidence, trip_status, capture_method,
--     budget_source;
-- =============================================================================

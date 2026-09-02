-- =============================================================================
-- Soft-delete / tombstone convention for the synced user tables.
--
-- The client (src/lib/trips.ts, src/lib/watchlist.ts) no longer hard-deletes a
-- line, a trip or a watch — it stamps `deleted_at` and syncs that like any
-- other change. This migration is the server half:
--
--   1. `deleted_at timestamptz` on shopping_trips, purchase_lines, watchlist.
--   2. A STICKY tombstone: once set, a later upsert cannot clear it. This is
--      what makes "I deleted this" win deterministically over a stale edit
--      from another device (the case the deferred multi-device account flow
--      will eventually create) without any clock comparison.
--   3. Crowd aggregates stop counting a tombstoned line: `recompute_bucket`
--      and `rebuild_all_aggregates` filter `deleted_at IS NULL`, the
--      aggregate-source partial index excludes tombstoned rows, and a
--      tombstone write re-enqueues the affected bucket (line trigger already
--      fires on UPDATE; the trip trigger's early-return is taught about
--      `deleted_at`).
--
-- Additive and reversible — see the DOWN block at the foot.
-- =============================================================================

ALTER TABLE shopping_trips ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE purchase_lines ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE watchlist      ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 1. Sticky tombstone. BEFORE UPDATE: if the row was already tombstoned, keep
--    the original timestamp no matter what the incoming row says. A fresh
--    tombstone (OLD null, NEW non-null) passes through untouched.
CREATE OR REPLACE FUNCTION keep_tombstone_sticky()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL THEN
    NEW.deleted_at := OLD.deleted_at;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_trips_tombstone_sticky
  BEFORE UPDATE ON shopping_trips
  FOR EACH ROW EXECUTE FUNCTION keep_tombstone_sticky();
CREATE TRIGGER trg_lines_tombstone_sticky
  BEFORE UPDATE ON purchase_lines
  FOR EACH ROW EXECUTE FUNCTION keep_tombstone_sticky();
CREATE TRIGGER trg_watchlist_tombstone_sticky
  BEFORE UPDATE ON watchlist
  FOR EACH ROW EXECUTE FUNCTION keep_tombstone_sticky();

-- 2. Live-row partial indexes (the common read path is "rows that still exist").
CREATE INDEX IF NOT EXISTS idx_trips_user_live
  ON shopping_trips (user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lines_trip_live
  ON purchase_lines (trip_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_watchlist_user_live
  ON watchlist (user_id) WHERE deleted_at IS NULL;

-- 3a. Aggregate-source partial index: also skip tombstoned lines.
DROP INDEX IF EXISTS idx_lines_agg_source;
CREATE INDEX idx_lines_agg_source ON purchase_lines (commodity_id)
  WHERE deleted_at IS NULL AND NOT (flagged_outlier AND outlier_confirmed IS NOT TRUE);

-- 3b. recompute_bucket — identical to migration 20260831000001 except the
--     day_obs CTE now also excludes tombstoned lines and tombstoned trips.
CREATE OR REPLACE FUNCTION recompute_bucket(
  p_commodity_id text, p_market_id uuid, p_period_month date, p_currency text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_users int; v_obs int;
  v_p25 bigint; v_med bigint; v_p75 bigint;
  v_grade boolean;
BEGIN
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
      AND t.capture_method <> 'recall'
      AND pl.deleted_at IS NULL                                            -- soft-delete (20260902000001)
      AND t.deleted_at  IS NULL                                            -- soft-delete (20260902000001)
      AND NOT (pl.flagged_outlier AND pl.outlier_confirmed IS NOT TRUE)
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

-- 3c. rebuild_all_aggregates — skip tombstoned lines/trips when enumerating
--     the buckets to recompute (recompute_bucket re-filters anyway; this just
--     avoids touching dead buckets).
CREATE OR REPLACE FUNCTION rebuild_all_aggregates()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v_done int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT pl.commodity_id, t.market_id,
           date_trunc('month', t.trip_date)::date AS period_month, t.currency
    FROM purchase_lines pl JOIN shopping_trips t ON t.id = pl.trip_id
    WHERE t.status = 'confirmed'
      AND pl.deleted_at IS NULL
      AND t.deleted_at  IS NULL
  LOOP
    PERFORM recompute_bucket(r.commodity_id, r.market_id, r.period_month, r.currency);
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;

-- 3d. trips_enqueue_buckets — identical to 20260831000001 except the UPDATE
--     early-return no longer skips a change that only flipped deleted_at.
--     NOTE: `SET search_path = public` is required here, not optional. Migration
--     20260901203138 item 4 pinned it via ALTER FUNCTION; CREATE OR REPLACE
--     rewrites a function's configuration parameters too, so omitting it would
--     silently revert that hardening and re-raise the advisor's
--     function_search_path_mutable finding.
CREATE OR REPLACE FUNCTION trips_enqueue_buckets()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  r record;
  v_trip_id uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.market_id IS NOT DISTINCT FROM OLD.market_id
     AND date_trunc('month', NEW.trip_date) IS NOT DISTINCT FROM date_trunc('month', OLD.trip_date)
     AND NEW.capture_method IS NOT DISTINCT FROM OLD.capture_method
     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at        -- soft-delete (20260902000001)
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

REVOKE ALL ON FUNCTION rebuild_all_aggregates()                 FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION recompute_bucket(text, uuid, date, text) FROM public, anon, authenticated;

-- =============================================================================
-- DOWN (manual):
--   DROP TRIGGER IF EXISTS trg_trips_tombstone_sticky     ON shopping_trips;
--   DROP TRIGGER IF EXISTS trg_lines_tombstone_sticky     ON purchase_lines;
--   DROP TRIGGER IF EXISTS trg_watchlist_tombstone_sticky ON watchlist;
--   DROP FUNCTION IF EXISTS keep_tombstone_sticky();
--   DROP INDEX IF EXISTS idx_trips_user_live, idx_lines_trip_live, idx_watchlist_user_live;
--   DROP INDEX IF EXISTS idx_lines_agg_source;
--   CREATE INDEX idx_lines_agg_source ON purchase_lines (commodity_id)
--     WHERE NOT (flagged_outlier AND outlier_confirmed IS NOT TRUE);
--   -- then re-run the 20260831000001 bodies of recompute_bucket /
--   -- rebuild_all_aggregates / trips_enqueue_buckets to drop the deleted_at filters.
--   ALTER TABLE shopping_trips DROP COLUMN IF EXISTS deleted_at;
--   ALTER TABLE purchase_lines DROP COLUMN IF EXISTS deleted_at;
--   ALTER TABLE watchlist      DROP COLUMN IF EXISTS deleted_at;
-- =============================================================================

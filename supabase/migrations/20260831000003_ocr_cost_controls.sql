-- =============================================================================
-- 20260831000003_ocr_cost_controls.sql
-- Blocking item 3 (Technical Requirements §6.1): the OCR rate limit does not
-- bind, because anonymous sessions are free, silent and unlimited to mint. A
-- per-identity cap converts unbounded spend into unbounded spend with one extra
-- HTTP call.
--
-- Three controls, all required before the OCR path is exposed:
--   (a) GLOBAL spend circuit-breaker  — bounds total cost regardless of how many
--       identities exist. Atomic daily + monthly counter, checked and reserved
--       BEFORE every dispatch. On breach, ALL users degrade to manual entry
--       (US-1.2 already specifies that fallback).
--   (b) ip_hash rate limit            — the ported `pulse` pattern, unchanged,
--       keyed on ip_hash (salted, never raw IP — NDPA). Raises the cost of
--       session-minting abuse.
--   (c) suspicion-gated CAPTCHA        — see function `anon_signin_should_challenge`;
--       the actual challenge is issued by the `anon-signin-gate` Edge Function so
--       the silent first-launch UX is preserved for normal users.
--
-- Plus: anonymous `auth.users` rows are permanent and count toward MAU billing.
-- Nothing in the source docs reaps them. `reap_anonymous_sessions()` +
-- pg_cron schedule below.
--
-- Money representation: costs are integer micro-USD (millionths of a dollar).
-- No floats. Vision-model pricing is quoted per 1K tokens / per image in USD;
-- convert at ingestion, store as integer, present in USD/NGN at display.
-- =============================================================================

-- --- (b) ip_hash rate limit: ported verbatim from pulse/supabase/schema.sql ---
CREATE TABLE IF NOT EXISTS ocr_ip_rate_limits (
  ip_hash      text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ip_hash, requested_at)
);
CREATE INDEX IF NOT EXISTS idx_ocr_ip_rate_limits_ip_hash ON ocr_ip_rate_limits (ip_hash);
CREATE INDEX IF NOT EXISTS idx_ocr_ip_rate_limits_requested_at ON ocr_ip_rate_limits (requested_at);
ALTER TABLE ocr_ip_rate_limits ENABLE ROW LEVEL SECURITY; -- service role only

-- --- per-session cap (kept, but explicitly NOT the load-bearing control) ------
CREATE TABLE IF NOT EXISTS ocr_session_rate_limits (
  session_user_id uuid NOT NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_user_id, requested_at)
);
CREATE INDEX IF NOT EXISTS idx_ocr_session_rate_limits_user ON ocr_session_rate_limits (session_user_id);
ALTER TABLE ocr_session_rate_limits ENABLE ROW LEVEL SECURITY;

-- --- (a) global spend circuit-breaker ----------------------------------------
-- One row per (kind, window_key). kind ∈ {'day','month'}. Caps are configuration,
-- stored on the row so they can be tuned without a deploy.
CREATE TABLE IF NOT EXISTS ocr_budget_windows (
  kind            text NOT NULL CHECK (kind IN ('day', 'month')),
  window_key      text NOT NULL,                    -- 'day:2026-08-31' / 'month:2026-08'
  cap_micro_usd   bigint NOT NULL CHECK (cap_micro_usd >= 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  dispatch_count  integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, window_key)
);
ALTER TABLE ocr_budget_windows ENABLE ROW LEVEL SECURITY;

-- Default caps (micro-USD). Tune in production. Day: $5.00, Month: $80.00.
-- Kept deliberately low for the slow-burn period; alarm at 80% via a monitor.
CREATE TABLE IF NOT EXISTS ocr_budget_config (
  id                    boolean PRIMARY KEY DEFAULT true CHECK (id),
  daily_cap_micro_usd   bigint NOT NULL DEFAULT 5000000,
  monthly_cap_micro_usd bigint NOT NULL DEFAULT 80000000
);
INSERT INTO ocr_budget_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- --- append-only spend ledger (one row per dispatch, reconciled to actual) ----
CREATE TABLE IF NOT EXISTS ocr_spend_ledger (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_user_id       uuid NOT NULL,
  ip_hash               text NOT NULL,
  estimated_micro_usd   bigint NOT NULL CHECK (estimated_micro_usd >= 0),
  actual_micro_usd      bigint CHECK (actual_micro_usd >= 0), -- NULL until reconciled
  model                 text NOT NULL,
  outcome               text NOT NULL DEFAULT 'dispatched'
                          CHECK (outcome IN ('dispatched', 'succeeded', 'failed', 'degraded_before_dispatch')),
  requested_at          timestamptz NOT NULL DEFAULT now(),
  reconciled_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_ocr_spend_ledger_requested_at ON ocr_spend_ledger (requested_at);
ALTER TABLE ocr_spend_ledger ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- reserve_ocr_budget(estimate, model, session, ip_hash)
--
-- The atomic pre-dispatch check. Increments BOTH the day and month windows in a
-- single statement each, refusing the increment if it would breach the cap.
-- Returns the ledger id on success; raises 'ocr_budget_exhausted' on breach so
-- the Edge Function can degrade the caller (and everyone) to manual entry.
--
-- Never read-then-write: the UPDATE ... WHERE spent + est <= cap is the guard.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reserve_ocr_budget(
  p_estimate_micro_usd bigint,
  p_model text,
  p_session_user_id uuid,
  p_ip_hash text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day_key    text := 'day:'   || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_month_key  text := 'month:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
  v_daily_cap  bigint;
  v_month_cap  bigint;
  v_ok         boolean;
  v_ledger_id  uuid;
BEGIN
  IF p_estimate_micro_usd < 0 THEN
    RAISE EXCEPTION 'reserve_ocr_budget: negative estimate';
  END IF;

  SELECT daily_cap_micro_usd, monthly_cap_micro_usd
    INTO v_daily_cap, v_month_cap
  FROM ocr_budget_config WHERE id;

  -- Ensure both windows exist with current caps.
  INSERT INTO ocr_budget_windows (kind, window_key, cap_micro_usd)
  VALUES ('day', v_day_key, v_daily_cap)
  ON CONFLICT (kind, window_key) DO UPDATE SET cap_micro_usd = EXCLUDED.cap_micro_usd;

  INSERT INTO ocr_budget_windows (kind, window_key, cap_micro_usd)
  VALUES ('month', v_month_key, v_month_cap)
  ON CONFLICT (kind, window_key) DO UPDATE SET cap_micro_usd = EXCLUDED.cap_micro_usd;

  -- Reserve against the DAY window.
  UPDATE ocr_budget_windows
     SET spent_micro_usd = spent_micro_usd + p_estimate_micro_usd,
         dispatch_count  = dispatch_count + 1,
         updated_at      = now()
   WHERE kind = 'day' AND window_key = v_day_key
     AND spent_micro_usd + p_estimate_micro_usd <= cap_micro_usd
  RETURNING true INTO v_ok;

  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'ocr_budget_exhausted' USING ERRCODE = 'check_violation';
  END IF;

  -- Reserve against the MONTH window; roll back the day reservation on breach.
  UPDATE ocr_budget_windows
     SET spent_micro_usd = spent_micro_usd + p_estimate_micro_usd,
         dispatch_count  = dispatch_count + 1,
         updated_at      = now()
   WHERE kind = 'month' AND window_key = v_month_key
     AND spent_micro_usd + p_estimate_micro_usd <= cap_micro_usd
  RETURNING true INTO v_ok;

  IF v_ok IS NOT TRUE THEN
    UPDATE ocr_budget_windows
       SET spent_micro_usd = spent_micro_usd - p_estimate_micro_usd,
           dispatch_count  = dispatch_count - 1
     WHERE kind = 'day' AND window_key = v_day_key;
    RAISE EXCEPTION 'ocr_budget_exhausted' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO ocr_spend_ledger (session_user_id, ip_hash, estimated_micro_usd, model)
  VALUES (p_session_user_id, p_ip_hash, p_estimate_micro_usd, p_model)
  RETURNING id INTO v_ledger_id;

  RETURN v_ledger_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- reconcile_ocr_spend(ledger_id, actual, succeeded)
-- Adjust the reserved estimate to the actual cost once the vision call returns.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_ocr_spend(
  p_ledger_id uuid,
  p_actual_micro_usd bigint,
  p_succeeded boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row       ocr_spend_ledger;
  v_delta     bigint;
  v_day_key   text := 'day:'   || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD');
  v_month_key text := 'month:' || to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM');
BEGIN
  SELECT * INTO v_row FROM ocr_spend_ledger WHERE id = p_ledger_id FOR UPDATE;
  IF NOT FOUND OR v_row.reconciled_at IS NOT NULL THEN
    RETURN; -- idempotent
  END IF;

  v_delta := p_actual_micro_usd - v_row.estimated_micro_usd;

  UPDATE ocr_budget_windows
     SET spent_micro_usd = GREATEST(0, spent_micro_usd + v_delta), updated_at = now()
   WHERE (kind = 'day' AND window_key = v_day_key)
      OR (kind = 'month' AND window_key = v_month_key);

  UPDATE ocr_spend_ledger
     SET actual_micro_usd = p_actual_micro_usd,
         outcome = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
         reconciled_at = now()
   WHERE id = p_ledger_id;
END;
$$;

-- -----------------------------------------------------------------------------
-- Rate-limit helpers (append-a-row, count-in-window — the pulse pattern).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_and_check_ocr_ip(p_ip_hash text, p_window interval, p_max int)
RETURNS boolean  -- true = allowed
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  DELETE FROM ocr_ip_rate_limits WHERE requested_at < now() - GREATEST(p_window, interval '1 day');
  INSERT INTO ocr_ip_rate_limits (ip_hash) VALUES (p_ip_hash);
  SELECT count(*) INTO v_count
    FROM ocr_ip_rate_limits
   WHERE ip_hash = p_ip_hash AND requested_at > now() - p_window;
  RETURN v_count <= p_max;
END;
$$;

CREATE OR REPLACE FUNCTION record_and_check_ocr_session(p_user uuid, p_window interval, p_max int)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_count int;
BEGIN
  INSERT INTO ocr_session_rate_limits (session_user_id) VALUES (p_user);
  SELECT count(*) INTO v_count
    FROM ocr_session_rate_limits
   WHERE session_user_id = p_user AND requested_at > now() - p_window;
  RETURN v_count <= p_max;
END;
$$;

-- -----------------------------------------------------------------------------
-- (c) suspicion signal for the CAPTCHA gate.
-- True ⇒ the next anonymous sign-in from this ip_hash must carry a CAPTCHA token.
-- Threshold: > 5 anon sign-ins from one ip_hash in the last hour.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION anon_signin_should_challenge(p_ip_hash text)
RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) > 5
    FROM ocr_ip_rate_limits
   WHERE ip_hash = p_ip_hash AND requested_at > now() - interval '1 hour';
$$;

REVOKE ALL ON FUNCTION reserve_ocr_budget(bigint, text, uuid, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION reconcile_ocr_spend(uuid, bigint, boolean) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION record_and_check_ocr_ip(text, interval, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION record_and_check_ocr_session(uuid, interval, int) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION anon_signin_should_challenge(text) FROM public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Anonymous-session reaper. Permanent auth.users rows for bots / preview-fetchers
-- count toward MAU billing and never get cleaned up otherwise.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reap_anonymous_sessions(p_older_than interval DEFAULT interval '30 days')
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, auth AS $$
DECLARE v_deleted integer;
BEGIN
  WITH doomed AS (
    SELECT u.id
      FROM auth.users u
     WHERE COALESCE((u.raw_app_meta_data ->> 'is_anonymous')::boolean, u.is_anonymous, false) IS TRUE
       AND u.created_at < now() - p_older_than
       AND NOT EXISTS (SELECT 1 FROM shopping_trips t WHERE t.user_id = u.id)
       AND NOT EXISTS (SELECT 1 FROM purchase_lines p WHERE p.user_id = u.id)
  )
  DELETE FROM auth.users WHERE id IN (SELECT id FROM doomed);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;
REVOKE ALL ON FUNCTION reap_anonymous_sessions(interval) FROM public, anon, authenticated;

-- Schedule (pg_cron). NOTE: pg_cron does not fire on a paused Supabase project
-- (TR §1) — the anti-pause measure is part of this control, not a convenience.
-- 03:15 UTC daily reap. Guarded: no-op if pg_cron is not enabled yet.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('reap-anonymous-sessions', '15 3 * * *',
      'SELECT reap_anonymous_sessions();');
  ELSE
    RAISE NOTICE 'pg_cron absent — reap-anonymous-sessions NOT scheduled. Enable pg_cron and run the cron.schedule() call in this section.';
  END IF;
END
$sched$;

-- =============================================================================
-- DOWN (manual):
--   SELECT cron.unschedule('reap-anonymous-sessions');
--   DROP FUNCTION IF EXISTS reap_anonymous_sessions(interval);
--   DROP FUNCTION IF EXISTS anon_signin_should_challenge(text);
--   DROP FUNCTION IF EXISTS record_and_check_ocr_session(uuid, interval, int);
--   DROP FUNCTION IF EXISTS record_and_check_ocr_ip(text, interval, int);
--   DROP FUNCTION IF EXISTS reconcile_ocr_spend(uuid, bigint, boolean);
--   DROP FUNCTION IF EXISTS reserve_ocr_budget(bigint, text, uuid, text);
--   DROP TABLE IF EXISTS ocr_spend_ledger, ocr_budget_config, ocr_budget_windows,
--                        ocr_session_rate_limits, ocr_ip_rate_limits;
-- =============================================================================

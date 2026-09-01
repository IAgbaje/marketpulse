-- =============================================================================
-- watchlist_alerts — Stage 9, screen "My Watchlist" + "threshold enforcement"
-- (TR §6 API surface: "Watchlist + alerts | CRUD + a scheduled job (pg_cron)
-- evaluating thresholds"). §6.2 leaves the DELIVERY mechanism (push/email/
-- in-app) as an open V1 product decision, explicitly not MVP-blocking, and
-- says in-app-only "always works" — that's what this ships: detection +
-- an in-app alert record. Push/email are NOT built; that's a product call,
-- not an engineering gap.
--
-- Threshold semantics (not specified in the source docs — a reasoned
-- default): threshold_kobo is a CEILING. An alert fires when a fresh
-- published crowd median is AT OR BELOW it — "tell me when this gets cheap
-- enough", the natural framing for a price-watch feature. If product wants
-- "alert on rises" later, that's a different column, not a sign flip here.
-- =============================================================================

CREATE TABLE watchlist_alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  watchlist_id     uuid NOT NULL REFERENCES watchlist (id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  commodity_id     text NOT NULL REFERENCES commodities (id),
  market_id        uuid REFERENCES locations (id),
  period_month     date NOT NULL,
  triggered_price_kobo bigint NOT NULL CHECK (triggered_price_kobo >= 0),
  threshold_kobo   bigint NOT NULL CHECK (threshold_kobo >= 0),
  currency         text NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  read_at          timestamptz,
  -- One alert per (watch, bucket) — a threshold that stays crossed for
  -- three drain cycles in the same month must not spam three alerts.
  UNIQUE (watchlist_id, period_month)
);
CREATE INDEX idx_watchlist_alerts_user ON watchlist_alerts (user_id, created_at);

ALTER TABLE watchlist_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY watchlist_alerts_owner_read ON watchlist_alerts
  FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()));
CREATE POLICY watchlist_alerts_owner_mark_read ON watchlist_alerts
  FOR UPDATE TO authenticated
  USING (user_id = (select auth.uid()))
  WITH CHECK (user_id = (select auth.uid()));
-- No INSERT/DELETE policy: alerts are written only by the service-role
-- evaluation job below, never directly by a client.

-- -----------------------------------------------------------------------------
-- evaluate_watchlist_thresholds() — scheduled, service-role only.
-- For every watchlist row with a threshold set, checks the CURRENT month's
-- published price_aggregates bucket(s) matching its (commodity, market —
-- or every market with a band, if market_id is NULL) and inserts an alert
-- when triggered. ON CONFLICT DO NOTHING on the (watchlist_id, period_month)
-- uniqueness handles re-runs safely — idempotent, like every other
-- scheduled job in this schema.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION evaluate_watchlist_thresholds()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_month date := date_trunc('month', now())::date;
  r record;
  v_inserted integer := 0;
BEGIN
  FOR r IN
    SELECT w.id AS watchlist_id, w.user_id, w.commodity_id, w.threshold_kobo, w.currency,
           pa.market_id, pa.median_kobo
    FROM watchlist w
    JOIN price_aggregates pa
      ON pa.commodity_id = w.commodity_id
     AND pa.period_month = v_month
     AND pa.currency = w.currency
     AND (w.market_id IS NULL OR w.market_id = pa.market_id)
    WHERE w.threshold_kobo IS NOT NULL
      AND pa.median_kobo IS NOT NULL
      AND pa.median_kobo <= w.threshold_kobo
  LOOP
    INSERT INTO watchlist_alerts
      (watchlist_id, user_id, commodity_id, market_id, period_month,
       triggered_price_kobo, threshold_kobo, currency)
    VALUES
      (r.watchlist_id, r.user_id, r.commodity_id, r.market_id, v_month,
       r.median_kobo, r.threshold_kobo, r.currency)
    ON CONFLICT (watchlist_id, period_month) DO NOTHING;
    IF FOUND THEN
      v_inserted := v_inserted + 1;
    END IF;
  END LOOP;
  RETURN v_inserted;
END;
$$;
REVOKE ALL ON FUNCTION evaluate_watchlist_thresholds() FROM public, anon, authenticated;

-- Same 5-minute cadence as the aggregate drain it depends on — no point
-- evaluating more often than the data it reads can actually change.
DO $sched$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule('evaluate-watchlist-thresholds', '*/5 * * * *',
      'SELECT evaluate_watchlist_thresholds();');
  ELSE
    RAISE NOTICE 'pg_cron absent — evaluate-watchlist-thresholds NOT scheduled.';
  END IF;
END
$sched$;

-- =============================================================================
-- DOWN (manual):
--   SELECT cron.unschedule('evaluate-watchlist-thresholds');
--   DROP FUNCTION IF EXISTS evaluate_watchlist_thresholds();
--   DROP TABLE IF EXISTS watchlist_alerts;
-- =============================================================================

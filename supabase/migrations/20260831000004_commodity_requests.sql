-- =============================================================================
-- 20260831000004_commodity_requests.sql
-- Screen 16 (`commodity_request_pending`). Gives the request queue the shape the
-- master-list owner needs to work it: a table, a 48h-SLA view, an aging digest,
-- and two RPCs — one for the capture flow to file a request without dead-ending,
-- one for the reviewer to resolve it and re-point any parked lines.
--
-- Spec: marketpulse/data/README.md → "Request queue — process & SLA".
--
-- Why RPCs and not plain inserts: `commodities` is reference data (RLS: SELECT
-- only for anon/authenticated). A capture that needs a not-yet-listed commodity
-- therefore cannot create the provisional row itself — `request_commodity()`
-- does it in one SECURITY DEFINER call with an auth check.
--
-- Depends on: 0001 (commodities, locations, users, purchase_lines, pg_trgm).
-- Reversible: DOWN block at the foot.
-- =============================================================================

-- A provisional commodity is auto-created so the requester's line has somewhere
-- to live immediately. It is promoted (provisional=false) on approval, or the
-- row is retired when the request merges into an existing commodity.
ALTER TABLE commodities
  ADD COLUMN IF NOT EXISTS provisional boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN commodities.provisional IS
  'Auto-created from a commodity_request. Excluded from autocomplete until promoted.';

CREATE TYPE commodity_request_status AS ENUM ('pending', 'approved', 'rejected', 'merged');
CREATE TYPE commodity_reject_reason AS ENUM
  ('not_a_commodity', 'duplicate', 'out_of_scope_non_food', 'insufficient_detail');

CREATE TABLE commodity_requests (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_text                 text NOT NULL,
  normalized_guess         text,
  requester_user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  market_id                uuid REFERENCES locations (id),
  provisional_commodity_id text REFERENCES commodities (id),
  status                   commodity_request_status NOT NULL DEFAULT 'pending',
  resolved_commodity_id    text REFERENCES commodities (id),
  reject_reason            commodity_reject_reason,
  resolved_by              text,               -- reviewer identifier ('email', 'system')
  resolved_at              timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reject_reason_iff_rejected
    CHECK ((status = 'rejected') = (reject_reason IS NOT NULL)),
  CONSTRAINT resolved_at_iff_not_pending
    CHECK ((status = 'pending') = (resolved_at IS NULL))
);
CREATE INDEX idx_commodity_requests_status   ON commodity_requests (status, created_at);
CREATE INDEX idx_commodity_requests_raw_trgm ON commodity_requests USING gin (raw_text gin_trgm_ops);
CREATE INDEX idx_commodity_requests_requester ON commodity_requests (requester_user_id);

ALTER TABLE commodity_requests ENABLE ROW LEVEL SECURITY;

-- Requester: file + read own. No UPDATE/DELETE — resolution is reviewer-only.
CREATE POLICY commodity_requests_insert_own ON commodity_requests
  FOR INSERT TO authenticated
  WITH CHECK ((select auth.uid()) = requester_user_id);
CREATE POLICY commodity_requests_select_own ON commodity_requests
  FOR SELECT TO authenticated
  USING ((select auth.uid()) = requester_user_id);

-- 48h SLA queue. security_invoker so a non-service caller still only sees their
-- own rows; the reviewer reads it via the service role (dashboard).
CREATE VIEW pending_commodity_requests WITH (security_invoker = true) AS
SELECT
  r.*,
  round((extract(epoch FROM (now() - r.created_at)) / 3600)::numeric, 1) AS hours_open,
  CASE
    WHEN now() - r.created_at > interval '48 hours' THEN 'breached'
    WHEN now() - r.created_at > interval '36 hours' THEN 'due_soon'
    ELSE 'ok'
  END AS sla_state
FROM commodity_requests r
WHERE r.status = 'pending'
ORDER BY r.created_at;

-- Aging digest: pending > 7 days (escalates in the weekly digest, per the spec).
CREATE VIEW aging_commodity_requests WITH (security_invoker = true) AS
SELECT * FROM commodity_requests
WHERE status = 'pending' AND created_at < now() - interval '7 days'
ORDER BY created_at;

-- -----------------------------------------------------------------------------
-- request_commodity() — called by the capture flow. Creates the provisional
-- commodity + the request atomically. authenticated-only, with an explicit
-- auth.uid() guard (SECURITY DEFINER in `public` is world-callable otherwise).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION request_commodity(
  p_raw_text text,
  p_normalized_guess text DEFAULT NULL,
  p_market_id uuid DEFAULT NULL,
  p_base_unit commodity_base_unit DEFAULT 'g'
)
RETURNS commodity_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid  uuid := (select auth.uid());
  v_slug text;
  v_req  commodity_requests;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'request_commodity: not authenticated';
  END IF;
  IF length(coalesce(btrim(p_raw_text), '')) < 2 THEN
    RAISE EXCEPTION 'request_commodity: raw_text too short';
  END IF;

  v_slug := 'req_' || replace(gen_random_uuid()::text, '-', '');

  INSERT INTO commodities (id, canonical_name, category, base_unit, provisional)
  VALUES (v_slug, btrim(p_raw_text), 'unknown', p_base_unit, true);

  INSERT INTO commodity_requests
    (raw_text, normalized_guess, requester_user_id, market_id, provisional_commodity_id)
  VALUES (btrim(p_raw_text), p_normalized_guess, v_uid, p_market_id, v_slug)
  RETURNING * INTO v_req;

  RETURN v_req;
END;
$$;
REVOKE ALL ON FUNCTION request_commodity(text, text, uuid, commodity_base_unit) FROM public, anon;
GRANT EXECUTE ON FUNCTION request_commodity(text, text, uuid, commodity_base_unit) TO authenticated;

-- -----------------------------------------------------------------------------
-- resolve_commodity_request() — reviewer action. Service-role only (dashboard).
--   p_action: 'approve_create' | 'merge_alias' | 'reject'
-- Re-pointing purchase_lines fires 0001's trg_lines_enqueue, which dirties both
-- the old (provisional) and the new (target) aggregate buckets automatically.
-- Idempotent: a request already out of 'pending' is returned unchanged.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION resolve_commodity_request(
  p_request_id uuid,
  p_action text,
  p_reviewer text,
  p_target_commodity_id text DEFAULT NULL,           -- required for merge_alias
  p_reject_reason commodity_reject_reason DEFAULT NULL,  -- required for reject
  p_category text DEFAULT NULL,                      -- optional, approve_create
  p_base_unit commodity_base_unit DEFAULT NULL,      -- optional, approve_create
  p_substitute_group text DEFAULT NULL               -- optional, approve_create
)
RETURNS commodity_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_req  commodity_requests;
  v_prov text;
BEGIN
  SELECT * INTO v_req FROM commodity_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'commodity_request % not found', p_request_id;
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN v_req;  -- idempotent
  END IF;
  v_prov := v_req.provisional_commodity_id;

  IF p_action = 'approve_create' THEN
    IF v_prov IS NULL THEN
      RAISE EXCEPTION 'approve_create: no provisional commodity to promote';
    END IF;
    UPDATE commodities
       SET provisional = false,
           category         = COALESCE(p_category, category),
           base_unit        = COALESCE(p_base_unit, base_unit),
           substitute_group = COALESCE(p_substitute_group, substitute_group)
     WHERE id = v_prov;
    INSERT INTO commodity_aliases (commodity_id, alias)
      VALUES (v_prov, lower(v_req.raw_text)) ON CONFLICT DO NOTHING;
    UPDATE commodity_requests
       SET status = 'approved', resolved_commodity_id = v_prov,
           resolved_by = p_reviewer, resolved_at = now()
     WHERE id = p_request_id RETURNING * INTO v_req;

  ELSIF p_action = 'merge_alias' THEN
    IF p_target_commodity_id IS NULL THEN
      RAISE EXCEPTION 'merge_alias: p_target_commodity_id required';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM commodities WHERE id = p_target_commodity_id AND NOT provisional) THEN
      RAISE EXCEPTION 'merge_alias: target % is not a live commodity', p_target_commodity_id;
    END IF;
    INSERT INTO commodity_aliases (commodity_id, alias)
      VALUES (p_target_commodity_id, lower(v_req.raw_text)) ON CONFLICT DO NOTHING;
    IF v_req.normalized_guess IS NOT NULL THEN
      INSERT INTO commodity_aliases (commodity_id, alias)
        VALUES (p_target_commodity_id, lower(v_req.normalized_guess)) ON CONFLICT DO NOTHING;
    END IF;
    IF v_prov IS NOT NULL THEN
      UPDATE purchase_lines SET commodity_id = p_target_commodity_id WHERE commodity_id = v_prov;
      UPDATE commodities SET retired = true, provisional = false WHERE id = v_prov;
    END IF;
    UPDATE commodity_requests
       SET status = 'merged', resolved_commodity_id = p_target_commodity_id,
           resolved_by = p_reviewer, resolved_at = now()
     WHERE id = p_request_id RETURNING * INTO v_req;

  ELSIF p_action = 'reject' THEN
    IF p_reject_reason IS NULL THEN
      RAISE EXCEPTION 'reject: p_reject_reason required';
    END IF;
    IF v_prov IS NOT NULL THEN
      UPDATE commodities SET retired = true WHERE id = v_prov;
    END IF;
    UPDATE commodity_requests
       SET status = 'rejected', reject_reason = p_reject_reason,
           resolved_by = p_reviewer, resolved_at = now()
     WHERE id = p_request_id RETURNING * INTO v_req;

  ELSE
    RAISE EXCEPTION 'resolve_commodity_request: unknown action %', p_action;
  END IF;

  RETURN v_req;
END;
$$;
REVOKE ALL ON FUNCTION resolve_commodity_request(uuid, text, text, text, commodity_reject_reason, text, commodity_base_unit, text)
  FROM public, anon, authenticated;

-- Keep provisional commodities out of the reference-data read path used for
-- autocomplete (clients should filter WHERE NOT provisional AND NOT retired,
-- but make the common case a view too).
CREATE VIEW active_commodities WITH (security_invoker = true) AS
SELECT * FROM commodities WHERE NOT provisional AND NOT retired;

-- =============================================================================
-- DOWN (manual):
--   DROP VIEW IF EXISTS active_commodities, aging_commodity_requests, pending_commodity_requests;
--   DROP FUNCTION IF EXISTS resolve_commodity_request(uuid,text,text,text,commodity_reject_reason,text,commodity_base_unit,text);
--   DROP FUNCTION IF EXISTS request_commodity(text,text,uuid,commodity_base_unit);
--   DROP TABLE IF EXISTS commodity_requests;
--   DROP TYPE IF EXISTS commodity_request_status, commodity_reject_reason;
--   ALTER TABLE commodities DROP COLUMN IF EXISTS provisional;
-- =============================================================================

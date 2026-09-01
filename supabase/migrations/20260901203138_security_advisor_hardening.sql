-- Advisor findings from the post-migration security scan, addressed:

-- 1. ERROR: ocr_budget_config had RLS disabled — a single-row config table with
--    daily/monthly spend caps, exposed via PostgREST with no RLS at all. Lock it
--    down service-role-only, same as its sibling ocr_* tables.
ALTER TABLE ocr_budget_config ENABLE ROW LEVEL SECURITY;

-- 2. Orphaned function from the pre-reset (Aug-24) schema — no trigger uses it
--    in the current design; flagged for mutable search_path with nothing to fix
--    it for. Drop it.
DROP FUNCTION IF EXISTS set_updated_at();

-- 3. handle_new_auth_user is SECURITY DEFINER and was directly callable via
--    /rest/v1/rpc/handle_new_auth_user by anon/authenticated. It should only run
--    as the auth.users trigger, never as a direct RPC.
REVOKE ALL ON FUNCTION handle_new_auth_user() FROM public, anon, authenticated;

-- 4. Pin search_path on the trigger functions the linter flagged (defense in
--    depth — none of these are SECURITY DEFINER, but an unset search_path is
--    still a best-practice gap on functions Postgres resolves objects through).
ALTER FUNCTION trips_before_write() SET search_path = public;
ALTER FUNCTION lines_set_user_id() SET search_path = public;
ALTER FUNCTION enqueue_bucket(text, uuid, date, text) SET search_path = public;
ALTER FUNCTION enqueue_line_bucket(text, uuid) SET search_path = public;
ALTER FUNCTION lines_enqueue_bucket() SET search_path = public;
ALTER FUNCTION trips_enqueue_buckets() SET search_path = public;

-- =============================================================================
-- DOWN (manual):
--   ALTER TABLE ocr_budget_config DISABLE ROW LEVEL SECURITY;
--   GRANT EXECUTE ON FUNCTION handle_new_auth_user() TO public, anon, authenticated;
--   -- set_updated_at() and the search_path pins are not meaningfully reversible
--   -- (the function was dead code; the search_path pins are strictly safer).
-- =============================================================================

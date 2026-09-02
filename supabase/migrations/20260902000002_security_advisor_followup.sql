-- =============================================================================
-- Security-advisor follow-up (TR §8 item 2). Addresses the advisor findings
-- that CAN be fixed from an app migration; the rest are documented here as
-- accepted, with the reason, so the next audit doesn't re-litigate them.
-- =============================================================================

-- FIX — st_estimatedextent (PostGIS, SECURITY DEFINER) is callable by anon and
-- authenticated via /rest/v1/rpc. MarketPulse never calls it from the client;
-- the map choropleth (ADR 0001) reads price_aggregates, not raw geometry
-- estimates. Revoke it from the API roles. IF EXISTS guards each overload in
-- case a PostGIS minor version ships a different signature set.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'st_estimatedextent'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', r.sig);
  END LOOP;
END $$;

-- =============================================================================
-- ACCEPTED, with rationale (no change):
--
--  * `extension_in_public` — pg_trgm and postgis live in `public`. Supabase
--    installs them there by default and explicitly advises against relocating
--    postgis (dependent objects, operator-class resolution, and a live
--    ALTER EXTENSION ... SET SCHEMA that can half-apply). idx_locations_name_trgm
--    depends on gin_trgm_ops. The exposure is low (extension functions, not
--    data) and the move is higher-risk than the finding. Revisit only if a
--    Supabase-supported relocation path lands.
--
--  * `rls_disabled_in_public` on `public.spatial_ref_sys` (ERROR) — owned by
--    the postgis extension; ALTER TABLE on it needs a superuser role this
--    project's connection does not have. Migration 20260901221012 already did
--    the next-best thing (REVOKE from anon/authenticated). The CI advisor gate
--    is --fail-on none for exactly this un-clearable finding.
--
--  * `auth_allow_anonymous_sign_ins` on the user tables — BY DESIGN. The
--    product's durability model is a silent anonymous Supabase session from
--    first launch (TR §2.3, Handover §9.2); every owner-scoped RLS policy
--    checks `auth.uid()`, which is set for an anon session too. This warning
--    is expected for this product and is not a defect.
--
--  * `authenticated_security_definer_function_executable` on
--    `public.request_commodity(...)` — INTENTIONAL. It is the screen-16
--    "request a commodity" RPC (migration 20260831000004), meant to be called
--    by any signed-in user; it inserts only into `commodity_requests` under
--    its own guard and cannot create master-list rows.
--
--  * `auth_leaked_password_protection` disabled — a dashboard Auth setting
--    (Authentication → Providers → Password → "Prevent use of leaked
--    passwords"), not migratable. Turn on before public launch; noted in
--    README "What's not done".
-- =============================================================================

-- DOWN (manual):
--   GRANT EXECUTE ON FUNCTION public.st_estimatedextent(text, text)               TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text)         TO anon, authenticated;
--   GRANT EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean) TO anon, authenticated;

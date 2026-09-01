-- Can't ALTER TABLE spatial_ref_sys (owned by the postgis extension, not
-- this role) to enable RLS directly — a known Supabase/PostGIS limitation;
-- the security advisor's ERROR persists after this (it checks the RLS flag
-- itself, not actual exposure) and that's expected, not something further
-- migrations here can clear without a superuser role. REVOKE doesn't
-- require ownership, so restrict PostgREST exposure instead: it's SRID
-- reference data the app never queries via the API anyway.
REVOKE ALL ON TABLE spatial_ref_sys FROM anon, authenticated;

-- =============================================================================
-- DOWN (manual):
--   GRANT SELECT ON TABLE spatial_ref_sys TO anon, authenticated;
-- =============================================================================

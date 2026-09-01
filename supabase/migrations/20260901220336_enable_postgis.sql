-- Stage 8 (V1: Price Map) prep. Additive, reversible (DROP EXTENSION IF
-- EXISTS postgis), no schema changes yet — locations.centroid_lat/lon
-- already exist (migration 20260831000001) but are unpopulated; actual
-- geometry columns / spatial indexes are deferred until real market
-- coordinates and a map-library choice exist (see ADR in the repo).
CREATE EXTENSION IF NOT EXISTS postgis;

-- =============================================================================
-- DOWN (manual):
--   DROP EXTENSION IF EXISTS postgis;
-- =============================================================================

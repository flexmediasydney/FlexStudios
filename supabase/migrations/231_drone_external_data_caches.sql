-- Migration 231: External-data caches for the drone module
--
-- Adds two cache tables that back the drone-pois and drone-cadastral Edge
-- Functions (Stream H of Wave 2 — drone module orchestration).
--
-- Both tables follow the same pattern: per-project rows with a 30-day TTL,
-- enabling cheap re-renders without hammering Google Places / NSW DCDB.
--
--   drone_pois_cache         Google Places Nearby Search results, scoped to a
--                            (project, property_coord, radius) tuple.
--   drone_cadastral_cache    NSW Spatial REST cadastral polygon (lot/plan,
--                            polygon vertices, area, perimeter) for a property.
--
-- Refresh semantics:
--   - The Edge Functions return cached rows when expires_at > NOW().
--   - Callers can force-refresh via { refresh: true } in the body.
--   - Stale rows are NOT auto-pruned by this migration; pruning happens
--     opportunistically on next miss (UPSERT pattern). A cron sweep can be
--     added later if storage becomes a concern.
--
-- RLS pattern follows migration 225 (drone_module_schemas.sql):
--   - master_admin/admin/manager/employee: full access via get_user_role()
--   - contractor: scoped via my_project_ids() to their assigned projects
--   - Service role bypasses for the Edge Functions themselves.

-- ============================================================================
-- 1. drone_pois_cache (Google Places Nearby Search results)
-- ============================================================================

CREATE TABLE IF NOT EXISTS drone_pois_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  property_lat DECIMAL(10,8) NOT NULL,
  property_lng DECIMAL(11,8) NOT NULL,
  radius_m INT NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('google_places', 'osm_overpass')),
  -- Array of curated POIs:
  --   { place_id, name, type, lat, lng, distance_m, rating?, user_ratings_total? }
  pois JSONB NOT NULL,
  total_count INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Composite index for active-row lookups: planner can use the (project_id,
-- expires_at) prefix to find non-expired rows. We can't use a partial index
-- with WHERE expires_at > NOW() because NOW() is not IMMUTABLE.
CREATE INDEX IF NOT EXISTS idx_drone_pois_cache_project_expires
  ON drone_pois_cache(project_id, expires_at DESC);

-- Lookups by project (history / debugging) hit this:
CREATE INDEX IF NOT EXISTS idx_drone_pois_cache_project_fetched
  ON drone_pois_cache(project_id, fetched_at DESC);

COMMENT ON TABLE drone_pois_cache IS
  'Google Places Nearby Search results, cached per project for 30 days. See IMPLEMENTATION_PLAN_V2 §2.5. Refresh by deleting + re-inserting via the drone-pois Edge Function with refresh=true.';
COMMENT ON COLUMN drone_pois_cache.pois IS
  'Curated POI array post type-quotas. Each entry: { place_id, name, type, lat, lng, distance_m, rating?, user_ratings_total? }.';

ALTER TABLE drone_pois_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_pois_cache_read" ON drone_pois_cache FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_pois_cache_insert" ON drone_pois_cache FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_pois_cache_update" ON drone_pois_cache FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );
CREATE POLICY "drone_pois_cache_delete" ON drone_pois_cache FOR DELETE
  USING (get_user_role() IN ('master_admin','admin'));

-- ============================================================================
-- 2. drone_cadastral_cache (NSW DCDB polygon)
-- ============================================================================
-- Cadastral data CAN change — subdivisions, lot boundary adjustments, plan
-- registrations — so we mirror the 30-day TTL of drone_pois_cache rather
-- than caching forever. A property's lot/plan rarely changes, but when it
-- does we want to pick it up on the next render cycle automatically.

CREATE TABLE IF NOT EXISTS drone_cadastral_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  property_lat DECIMAL(10,8) NOT NULL,
  property_lng DECIMAL(11,8) NOT NULL,
  address_query TEXT NOT NULL,        -- normalised address used for the WFS query
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('nsw_dcdb', 'manual_override')),
  -- Polygon as an ordered array of { lat, lng } vertices (exterior ring).
  polygon JSONB NOT NULL,
  lot_label TEXT,                     -- e.g. "1" (the lot number)
  plan_label TEXT,                    -- e.g. "DP12345"
  area_sqm DECIMAL(12,2),             -- planimetric area
  perimeter_m DECIMAL(10,2),          -- sum of edge lengths
  raw_attributes JSONB,               -- full attribute payload for audit/debug
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_drone_cadastral_cache_project_expires
  ON drone_cadastral_cache(project_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_drone_cadastral_cache_project_fetched
  ON drone_cadastral_cache(project_id, fetched_at DESC);

COMMENT ON TABLE drone_cadastral_cache IS
  'NSW DCDB cadastral polygon for a project, cached per project for 30 days. See IMPLEMENTATION_PLAN_V2 §5.1 (drone-cadastral). Source: NSW Spatial REST API public/NSW_Cadastre/MapServer/9 query endpoint.';
COMMENT ON COLUMN drone_cadastral_cache.polygon IS
  'Ordered array of { lat, lng } vertices of the exterior ring (closed polygon).';
COMMENT ON COLUMN drone_cadastral_cache.raw_attributes IS
  'Full attribute payload from the WFS feature for audit (lotnumber, plannumber, sectionnumber, etc.).';

ALTER TABLE drone_cadastral_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drone_cadastral_cache_read" ON drone_cadastral_cache FOR SELECT
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_cadastral_cache_insert" ON drone_cadastral_cache FOR INSERT
  WITH CHECK (
    get_user_role() IN ('master_admin','admin','manager','employee')
    OR (get_user_role() = 'contractor' AND project_id IN (SELECT my_project_ids()))
  );
CREATE POLICY "drone_cadastral_cache_update" ON drone_cadastral_cache FOR UPDATE
  USING (
    get_user_role() IN ('master_admin','admin','manager','employee')
  );
CREATE POLICY "drone_cadastral_cache_delete" ON drone_cadastral_cache FOR DELETE
  USING (get_user_role() IN ('master_admin','admin'));

-- ============================================================================
-- Notify PostgREST to refresh schema cache
-- ============================================================================
NOTIFY pgrst, 'reload schema';

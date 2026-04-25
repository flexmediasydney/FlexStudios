-- 245_drone_pois_cache_type_quotas_hash
-- ────────────────────────────────────────────────────────────────────────
-- The drone_pois_cache row is currently keyed on (project_id, radius_m).
-- Once theme-driven type_quotas land in drone-pois, two requests with the
-- SAME project + SAME radius but DIFFERENT type selections (e.g. one theme
-- wanting [school, train_station] and another wanting [park, beach]) would
-- otherwise share a cache slot and return the wrong curated set.
--
-- Add a third dimension — a deterministic hash of the normalised type_quotas
-- map — so each distinct theme selection gets its own cache row. The hash is
-- computed by drone-pois (sorted-key JSON → SHA-1 → first 16 hex chars). For
-- the legacy "no type_quotas in body" path (back-compat), the hash is the
-- empty string so existing single-row-per-(project, radius) lookups keep
-- working until the new code path catches them on first refresh.
--
-- Existing rows that pre-date this migration will have hash = '' (the
-- column default). Once a request comes in with a real hash, the lookup
-- misses and a fresh row is inserted; the legacy '' row is left to expire.

ALTER TABLE drone_pois_cache
  ADD COLUMN IF NOT EXISTS type_quotas_hash text NOT NULL DEFAULT '';

-- The pre-existing index in 231 was a non-unique (project_id, expires_at)
-- planner aid, not a uniqueness constraint, so there's no index to drop.
-- Defensive DROP IF EXISTS in case a prior dev branch added one.
DROP INDEX IF EXISTS uniq_drone_pois_cache_proj_radius;

-- Active-row uniqueness: (project_id, radius_m, type_quotas_hash).
-- Note this is NOT a partial index — we keep ALL historical rows but rely
-- on the application's expires_at filter to surface only active ones. The
-- uniqueness here prevents two concurrent inserts from racing in two
-- otherwise-identical rows for the same (project, radius, theme-hash).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drone_pois_cache_proj_radius_quotas
  ON drone_pois_cache (project_id, radius_m, type_quotas_hash);

NOTIFY pgrst, 'reload schema';

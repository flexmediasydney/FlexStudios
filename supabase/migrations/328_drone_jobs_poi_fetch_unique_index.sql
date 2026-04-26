-- ════════════════════════════════════════════════════════════════════════
-- Migration 328 — Wave 14-mini Pick C
-- Partial unique index on drone_jobs(project_id) for kind='poi_fetch' rows
-- in pending|running. Closes the TOCTOU race in dropbox-webhook's
-- enqueueEditedPipelineInit which currently relies on a SELECT pre-check.
-- ════════════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX IF NOT EXISTS idx_drone_jobs_unique_pending_poi_fetch
  ON drone_jobs (project_id)
  WHERE status IN ('pending','running') AND kind = 'poi_fetch';

COMMENT ON INDEX idx_drone_jobs_unique_pending_poi_fetch IS
  'Wave 14-mini: partial unique index for kind=poi_fetch dedup. Insert collisions raise 23505 which dropbox-webhook treats as debounced success.';

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- 289: Broaden the per-shoot render dedupe index to cover BOTH 'render' and
-- 'render_edited' job kinds.
-- ───────────────────────────────────────────────────────────────────────────
-- mig 282 created idx_drone_jobs_unique_pending_render scoped to kind='render'
-- only. S3 (Wave 5 P2) shipped drone-render-edited with ON CONFLICT DO NOTHING
-- semantics, so concurrent cascades don't crash — but they DO double-enqueue
-- render_edited rows because the index doesn't cover them. The dispatcher
-- still processes both rows; one becomes a no-op skip (skipped_already_done)
-- but Modal has already been spun up.
--
-- This migration broadens the unique constraint to cover render_edited too.
-- Safe to apply — no data migration needed; pg_class will rebuild the index
-- in place.
-- ═══════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_drone_jobs_unique_pending_render;

CREATE UNIQUE INDEX idx_drone_jobs_unique_pending_render
  ON drone_jobs (shoot_id, COALESCE(pipeline, 'raw'))
  WHERE status IN ('pending', 'running')
    AND kind IN ('render', 'render_edited');

COMMENT ON INDEX idx_drone_jobs_unique_pending_render IS
  'Per-shoot render dedupe across raw + edited pipelines. Wave 5 mig 289 broadened from kind=render to kind IN (render, render_edited).';

NOTIFY pgrst, 'reload schema';

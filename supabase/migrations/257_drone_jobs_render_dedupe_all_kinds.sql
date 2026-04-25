-- ════════════════════════════════════════════════════════════════════════
-- Migration 257 — drone_jobs render dedupe covers ALL render-like kinds
-- (QC6 #11)
--
-- Migration 240 introduced `idx_drone_jobs_unique_pending_render` partial
-- unique index on `(shoot_id) WHERE status IN ('pending','running') AND
-- kind='render'`. Operators clicking the AI-preview button rapidly enqueue
-- `kind='raw_preview_render'` (and the older `render_preview` alias) which
-- the existing index does NOT cover, so N concurrent preview jobs pile up
-- per shoot — wasting Modal worker slots and producing duplicate previews.
--
-- Drop and recreate covering all three kinds. Same shoot+lane semantics:
-- only one pending/running per shoot-per-render-family.
-- ════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS idx_drone_jobs_unique_pending_render;

CREATE UNIQUE INDEX idx_drone_jobs_unique_pending_render
  ON drone_jobs (shoot_id, kind)
  WHERE status IN ('pending', 'running')
    AND kind IN ('render', 'render_preview', 'raw_preview_render');

NOTIFY pgrst, 'reload schema';

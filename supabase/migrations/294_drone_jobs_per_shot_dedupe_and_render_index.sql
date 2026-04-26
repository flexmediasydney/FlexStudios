-- ═══════════════════════════════════════════════════════════════════════════
-- 294: Wave 6 cascade-fanout fix — per-shot fan-out dedupe + render index
--      sanity, plus drone_jobs.pipeline backfill.
-- ───────────────────────────────────────────────────────────────────────────
-- Three coupled fixes for the cascade chain that has been silently dropping
-- per-shot fan-out rows in production:
--
--  A. mig 289's idx_drone_jobs_unique_pending_render keys on
--     (shoot_id, COALESCE(pipeline,'raw')). When drone-render-edited (or
--     dropbox-webhook) fan-outs N per-shot rows with the SAME shoot_id, all
--     N collapse to one — N-1 silently dropped. Editor delivers 5 files,
--     1 renders. Pin save renders 1 of N shots.
--
--     Fix: include payload->>'shot_id' in the index so per-shot rows for
--     the same shoot can coexist. The cascade-orchestration row (which
--     uses shoot_id=NULL + project_id) still de-dupes via the new
--     boundary-cascade index below.
--
--  B. There is currently NO partial unique on
--     kind='boundary_save_render_cascade' — re-saving the boundary
--     produces multiple project-scoped cascade rows. Dispatcher fans each
--     out, multiplying render load.
--
--     Fix: per-project unique on (project_id) WHERE
--     kind='boundary_save_render_cascade' AND status IN (pending,running).
--
--  C. mig 282 set DEFAULT 'raw' on drone_jobs.pipeline but didn't backfill
--     the pre-mig-282 NULL rows. 19 rows still have pipeline=NULL — they
--     fall through dispatcher routing logic that branches on the field.
--
--     Fix: UPDATE drone_jobs SET pipeline='raw' WHERE pipeline IS NULL.
--     We do NOT add NOT NULL yet — defer to a later mig once any in-flight
--     callers that explicitly pass NULL are confirmed dead.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── A. Per-shot-aware render dedupe index ────────────────────────────────
-- Replace the mig 289 index with a per-shot variant. shot_id key derived
-- from payload->>'shot_id' (nullable for non-fanout rows; the dispatcher
-- and orchestration paths use NULL/empty so they de-dupe at shoot-level).
DROP INDEX IF EXISTS idx_drone_jobs_unique_pending_render;
CREATE UNIQUE INDEX idx_drone_jobs_unique_pending_render
  ON drone_jobs (
    shoot_id,
    COALESCE(pipeline, 'raw'),
    COALESCE(payload->>'shot_id', '')
  )
  WHERE status IN ('pending', 'running')
    AND kind IN ('render', 'render_edited');

COMMENT ON INDEX idx_drone_jobs_unique_pending_render IS
  'Per-shot, per-pipeline render dedupe. Wave 6 mig 294 added payload->>shot_id key so per-shot fan-out rows (same shoot_id) can coexist. Without the shot_id key, mig 289 collapsed N fan-outs to 1.';

-- ── B. Boundary-cascade per-project dedupe ───────────────────────────────
-- Prevents re-saving the same boundary from producing N parallel cascades
-- (each fans out to per-shot rows, each of which then renders — multiplied
-- compute waste). The boundary-save handler relies on this index to
-- short-circuit a re-save with a single 23505 -> debounced log line.
CREATE UNIQUE INDEX IF NOT EXISTS idx_drone_jobs_unique_pending_boundary_cascade
  ON drone_jobs (project_id)
  WHERE status IN ('pending', 'running')
    AND kind = 'boundary_save_render_cascade';

COMMENT ON INDEX idx_drone_jobs_unique_pending_boundary_cascade IS
  'At-most-one pending boundary cascade per project. Prevents re-save N-up-fanout pile-on. Wave 6 mig 294.';

-- ── C. Backfill drone_jobs.pipeline NULLs ────────────────────────────────
-- mig 282 set DEFAULT 'raw' for new inserts but the existing 19 rows kept
-- NULL. Backfill so dispatcher routing branches that read pipeline never
-- see NULL on a finished row.
UPDATE drone_jobs SET pipeline = 'raw' WHERE pipeline IS NULL;

-- ── D. Stale uniq_drone_renders_active_per_variant predicate ────────────
-- Index currently covers WHERE column_state IN ('proposed','adjustments',
-- 'final'). mig 282 changed the vocab to:
--   raw:     pool / accepted / rejected
--   edited:  pool / adjustments / final / rejected
-- The current predicate covers neither raw 'pool' nor 'accepted'. Two
-- duplicate raw renders for (shot_id, kind, variant) would slip through.
--
-- Fix: predicate now covers (pool, accepted, adjustments, final). Still
-- excludes 'rejected' since multiple rejects of the same shot/kind/variant
-- are valid history (operator may reject multiple times).
DROP INDEX IF EXISTS uniq_drone_renders_active_per_variant;
CREATE UNIQUE INDEX uniq_drone_renders_active_per_variant
  ON drone_renders (shot_id, kind, COALESCE(output_variant, 'default'), column_state)
  WHERE column_state IN ('pool', 'accepted', 'adjustments', 'final');

COMMENT ON INDEX uniq_drone_renders_active_per_variant IS
  'Active-per-variant dedupe across all live column_states. Wave 6 mig 294 refreshed predicate after mig 282 vocab change (pool/accepted/adjustments/final). rejected excluded — multiple rejects are valid history.';

NOTIFY pgrst, 'reload schema';

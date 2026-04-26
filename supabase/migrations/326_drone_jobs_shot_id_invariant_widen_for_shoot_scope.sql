-- ════════════════════════════════════════════════════════════════════════
-- Migration 326 — Final QC iter 5 P0-1
-- Widen drone_jobs_shot_id_required_for_per_shot_kinds constraint to
-- accept legitimate shoot-scope rows of kind=render/render_edited.
--
-- Pre-mig state (from mig 312, which had been narrowed at apply time
-- to exclude raw_preview_render): shot_id required for kind in
-- (render, render_edited). 4 enqueuers correctly produce shoot-scope
-- rows of these kinds without shot_id:
--   - drone-render-edited render_continuation (shoot-level loop)
--   - drone-render render_continuation (shoot-level loop)
--   - drone-pins-save pin_edit_cascade_edited (project-wide cascade parent)
--   - dropbox-webhook edited_files_complete (shoot-level render trigger)
--
-- These rows were silently 23514-rejected on insert pre-mig (or, in the
-- case of drone-render-edited / drone-render, awaited without error capture
-- → continuation chain stalled). Widen the constraint to permit them when
-- payload signals shoot-scope intent: cascade=true OR reason marks a
-- known shoot-scope path.
-- ════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_jobs
  DROP CONSTRAINT IF EXISTS drone_jobs_shot_id_required_for_per_shot_kinds;

ALTER TABLE drone_jobs
  ADD CONSTRAINT drone_jobs_shot_id_required_for_per_shot_kinds
  CHECK (
    -- Kinds that have no per-shot semantics: always pass.
    kind <> ALL (ARRAY['render','render_edited'])
    -- Per-shot row with explicit shot reference at column or payload.
    OR shot_id IS NOT NULL
    OR (payload ? 'shot_id'
        AND (payload->>'shot_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    -- Shoot-scope cascade parent (drone-pins-save pin_edit_cascade,
    -- boundary_save_render_cascade, etc.). The dispatcher fans this row
    -- out to per-shot children, which themselves carry shot_id.
    OR (payload ? 'cascade' AND (payload->>'cascade')::boolean = true)
    -- Shoot-scope continuation tokens (drone-render / drone-render-edited
    -- self-paced batching). The continuation loops over remaining shots
    -- in the same shoot — no individual shot is being targeted.
    OR (payload ? 'reason'
        AND (payload->>'reason') IN (
          'render_continuation',
          'edited_files_complete',
          'pin_edit_cascade_edited',
          'boundary_edit_cascade'
        ))
  ) NOT VALID;

ALTER TABLE drone_jobs VALIDATE CONSTRAINT drone_jobs_shot_id_required_for_per_shot_kinds;

COMMENT ON CONSTRAINT drone_jobs_shot_id_required_for_per_shot_kinds ON drone_jobs IS
  'QC iter 5 P0-1: widened from mig 312. Per-shot kinds (render, render_edited) require shot_id at column OR payload, EXCEPT for legitimate shoot-scope rows: cascade parents and self-paced continuation tokens. This catches malformed enqueues while permitting the 4 known shoot-scope paths.';

-- ── P0-2 backfill: orphan top-level shot_id from payload ─────────────
-- Pre-mig 326 rows that had payload.shot_id but missed the top-level
-- column population (W10-S2 pre-parity-fix vintage). Backfill so the
-- W11-S1 hot index idx_drone_jobs_shot_id_recent has correct coverage.
UPDATE drone_jobs
SET shot_id = (payload->>'shot_id')::uuid
WHERE kind IN ('render','render_edited')
  AND shot_id IS NULL
  AND payload ? 'shot_id'
  AND (payload->>'shot_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

NOTIFY pgrst, 'reload schema';

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 263: drone_shoots.status — re-assert the live CHECK enum
-- ───────────────────────────────────────────────────────────────────────────
-- QC6 #17 (schema vs file drift):
--   Migration 225 lines 151-154 enumerated 10 values for drone_shoots.status:
--     ingested, analysing, sfm_running, sfm_complete, sfm_failed,
--     rendering, proposed_ready, adjustments_ready, final_ready, delivered
--   But the LIVE constraint on the database (verified via
--     SELECT pg_get_constraintdef(...) FROM pg_constraint WHERE conrelid =
--     'drone_shoots'::regclass AND contype='c' AND conname LIKE '%status%';
--   ) has 11 values — `render_failed` was added separately, presumably via a
--   hotfix that never made it into a tracked migration file.
--
--   Live shape (2026-04-25):
--     CHECK (status = ANY (ARRAY[
--       'ingested','analysing','sfm_running','sfm_complete','sfm_failed',
--       'rendering','render_failed','proposed_ready','adjustments_ready',
--       'final_ready','delivered'
--     ]))
--
-- Why this file exists despite being a no-op:
--   When the migration files are replayed against a fresh database (e.g. for
--   a staging rebuild), 225's narrower constraint would be the one applied
--   and `render_failed` writes from drone-render would 23514 fail. This file
--   re-asserts the live shape so the schema is reproducible end-to-end.
--
-- Do NOT apply this on top of the live database — orchestrator rule: schema
-- migrations are owned by W2-δ. This file only documents what's already there.
-- The migration is safe to apply (DROP + ADD is idempotent for an enum that
-- already has all the values) but the orchestrator owns the apply step.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE drone_shoots
  DROP CONSTRAINT IF EXISTS drone_shoots_status_check;

ALTER TABLE drone_shoots
  ADD CONSTRAINT drone_shoots_status_check
  CHECK (status = ANY (ARRAY[
    'ingested'::text,
    'analysing'::text,
    'sfm_running'::text,
    'sfm_complete'::text,
    'sfm_failed'::text,
    'rendering'::text,
    'render_failed'::text,
    'proposed_ready'::text,
    'adjustments_ready'::text,
    'final_ready'::text,
    'delivered'::text
  ]));

NOTIFY pgrst, 'reload schema';

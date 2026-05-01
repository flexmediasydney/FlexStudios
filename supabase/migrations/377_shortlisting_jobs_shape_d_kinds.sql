-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 377 — Wave 11.7.1: Shape D job kinds for the dispatcher
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
--       §"Per-shoot orchestration" (callStage4 dispatched as separate edge job)
--
-- Adds two new job kinds to shortlisting_jobs.kind:
--   - 'shape_d_stage1' — Shape D Stage 1 batched per-image enrichment (the
--     orchestrator entrypoint, equivalent to legacy 'pass1' for routing)
--   - 'stage4_synthesis' — Shape D Stage 4 visual master synthesis (separate
--     edge job dispatched after Stage 1 completes; W11.7 keystone §"Failure
--     isolation" mandates Stage 4 runs in its own worker because the iter-5a
--     Saladine run hit the worker wall budget when Stage 1 + Stage 4 chained
--     in the same edge invocation).
--
-- This is additive: existing 'pass0/pass1/pass2/pass3/ingest/extract/render_
-- preview' kinds are preserved unchanged. Two-pass legacy rounds continue to
-- chain through the existing dispatcher logic; Shape D rounds use the new
-- kinds.
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. Why 'shape_d_stage1' as a kind rather than reusing 'pass1':
--    The dispatcher's KIND_TO_FUNCTION map (shortlisting-job-dispatcher
--    /index.ts) routes 'pass1' → shortlisting-pass1. Reusing 'pass1' would
--    mean either:
--      (a) the dispatcher reads engine_settings.engine_mode and routes
--          conditionally — adds runtime branching to the hot path,
--      (b) shortlisting-pass1 itself gates on engine_mode and forks internally
--          — bloats the legacy fn with Shape D coexistence logic.
--    Cleaner: distinct kinds, distinct edge fns, dispatcher routes by kind.
--    Phase D deletion of pass1+pass2 leaves shape_d_stage1+stage4_synthesis
--    behind — at that point we can rename to plain 'stage1'/'stage4' if we
--    want, but Phase A/B/C wants explicit naming.
--
-- 2. The unique-pass-per-round index (mig 326) is extended to include both
--    new kinds so Shape D rounds get the same dispatcher chain race protection
--    that pass0/1/2/3 already have.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Drop and re-add the kind CHECK constraint ────────────────────────────
-- Postgres doesn't support "extend an existing CHECK"; we drop and recreate.
-- The DROP is unconstrained (CHECK constraints are quick); the new constraint
-- adds NOT VALID + VALIDATE so existing rows aren't re-locked during
-- validation.

ALTER TABLE shortlisting_jobs
  DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shortlisting_jobs_kind_check'
       AND conrelid = 'shortlisting_jobs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE shortlisting_jobs
             ADD CONSTRAINT shortlisting_jobs_kind_check
             CHECK (kind IN (
               ''ingest'',
               ''extract'',
               ''pass0'',
               ''pass1'',
               ''pass2'',
               ''pass3'',
               ''render_preview'',
               ''shape_d_stage1'',
               ''stage4_synthesis''
             ))
             NOT VALID';
    EXECUTE 'ALTER TABLE shortlisting_jobs
             VALIDATE CONSTRAINT shortlisting_jobs_kind_check';
  END IF;
END $$;

-- ─── 2. Extend the per-round unique pass index to include Shape D kinds ──────
-- Without this, two concurrent dispatcher ticks could both insert a stage4_
-- synthesis job for the same round — Shape D should get the same race
-- protection as pass0/1/2/3.

DROP INDEX IF EXISTS uniq_shortlisting_jobs_active_pass_per_round;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_jobs_active_pass_per_round
  ON shortlisting_jobs (round_id, kind)
  WHERE kind IN (
    'pass0', 'pass1', 'pass2', 'pass3',
    'shape_d_stage1', 'stage4_synthesis'
  )
    AND status IN ('pending', 'running', 'succeeded');

COMMENT ON INDEX uniq_shortlisting_jobs_active_pass_per_round IS
  'Wave 11.7.1: prevents dispatcher chain race (audit defect #16) for both '
  'legacy two-pass kinds (pass0-3) and Shape D kinds (shape_d_stage1, '
  'stage4_synthesis). Two concurrent ticks enqueueing the same kind for the '
  'same round get a unique-violation that chainNextKind swallows.';

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP INDEX IF EXISTS uniq_shortlisting_jobs_active_pass_per_round;
--
-- ALTER TABLE shortlisting_jobs
--   DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;
--
-- ALTER TABLE shortlisting_jobs
--   ADD CONSTRAINT shortlisting_jobs_kind_check
--   CHECK (kind IN (
--     'ingest','extract','pass0','pass1','pass2','pass3','render_preview'
--   ));
--
-- CREATE UNIQUE INDEX uniq_shortlisting_jobs_active_pass_per_round
--   ON shortlisting_jobs (round_id, kind)
--   WHERE kind IN ('pass0', 'pass1', 'pass2', 'pass3')
--     AND status IN ('pending', 'running', 'succeeded');
--
-- Note: rollback is data-lossy if any Shape D jobs have been written. Pre-
-- rollback dump:
--   CREATE TABLE _rollback_shape_d_jobs AS
--     SELECT * FROM shortlisting_jobs
--      WHERE kind IN ('shape_d_stage1', 'stage4_synthesis');

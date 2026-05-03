-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 456 — W11.8 detect_instances job kind for the dispatcher
-- (mig 455 was claimed by INST-C's space_instance_operator_rpcs after the
--  initial planning. Mine bumped to 456 to keep filename ordering stable.)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds a new kind value `detect_instances` to shortlisting_jobs.kind so the
-- dispatcher can route Phase 1 instance clustering as a separate edge job
-- between Stage 1 and Stage 4.
--
-- Chain (post-W11.8):
--   extract → pass0 → shape_d_stage1 → detect_instances → stage4_synthesis
--
-- ─── DESIGN DECISIONS ───────────────────────────────────────────────────────
-- 1. detect_instances runs in a single Gemini vision call per round (~30-60s
--    typical), so it does NOT need background-mode treatment in the dispatcher.
--    Synchronous 60s timeout is enough.
-- 2. The unique-pass-per-round index gets extended so concurrent dispatcher
--    ticks can't enqueue duplicate detect_instances rows. Same race-protection
--    as pass0/1/2/3 + shape_d_stage1 + stage4_synthesis.
-- 3. The CHECK constraint enumeration mirrors mig 377 — drop and recreate.
--
-- ─── ROLLBACK ───────────────────────────────────────────────────────────────
-- See bottom of file. Rollback is data-lossy if any detect_instances jobs
-- have been written.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Extend the kind CHECK constraint ────────────────────────────────────

ALTER TABLE public.shortlisting_jobs
  DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shortlisting_jobs_kind_check'
       AND conrelid = 'public.shortlisting_jobs'::regclass
  ) THEN
    EXECUTE 'ALTER TABLE public.shortlisting_jobs
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
               ''detect_instances'',
               ''stage4_synthesis'',
               ''canonical_rollup'',
               ''pulse_description_extract'',
               ''floorplan_extract''
             ))
             NOT VALID';
    EXECUTE 'ALTER TABLE public.shortlisting_jobs
             VALIDATE CONSTRAINT shortlisting_jobs_kind_check';
  END IF;
END $$;

-- ─── 2. Extend the unique-pass-per-round index ──────────────────────────────

DROP INDEX IF EXISTS public.uniq_shortlisting_jobs_active_pass_per_round;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_jobs_active_pass_per_round
  ON public.shortlisting_jobs (round_id, kind)
  WHERE kind IN (
    'pass0', 'pass1', 'pass2', 'pass3',
    'shape_d_stage1', 'detect_instances', 'stage4_synthesis'
  )
    AND status IN ('pending', 'running', 'succeeded');

COMMENT ON INDEX public.uniq_shortlisting_jobs_active_pass_per_round IS
  'W11.8 (mig 456): prevents dispatcher chain race for legacy two-pass kinds, '
  'Shape D kinds (shape_d_stage1, stage4_synthesis), and the new instance-'
  'detection kind (detect_instances). Two concurrent ticks enqueueing the '
  'same kind for the same round get a unique-violation that chainNextKind '
  'swallows.';

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP INDEX IF EXISTS public.uniq_shortlisting_jobs_active_pass_per_round;
-- ALTER TABLE public.shortlisting_jobs
--   DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;
-- (Re-add the prior CHECK from mig 377 if needed.)
-- CREATE UNIQUE INDEX uniq_shortlisting_jobs_active_pass_per_round
--   ON public.shortlisting_jobs (round_id, kind)
--   WHERE kind IN ('pass0','pass1','pass2','pass3','shape_d_stage1','stage4_synthesis')
--     AND status IN ('pending','running','succeeded');

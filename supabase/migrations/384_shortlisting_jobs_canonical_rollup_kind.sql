-- 384_shortlisting_jobs_canonical_rollup_kind.sql
--
-- W12 Stage 1.5 hygiene: register `canonical_rollup` as a valid
-- shortlisting_jobs.kind so the dispatcher can chain it after every
-- shape_d_stage1 success. Without this, shortlisting_jobs_kind_check
-- rejects the insert and the canonical object/attribute registry stops
-- growing.
--
-- Two changes:
--   1) Extend the kind CHECK to include 'canonical_rollup'.
--   2) Extend uniq_shortlisting_jobs_active_pass_per_round to also dedupe
--      canonical_rollup so concurrent dispatcher ticks can't double-enqueue
--      a rollup for the same round.
--
-- Companion edge-function changes:
--   - shortlisting-shape-d/index.ts: dispatchCanonicalRollupJob() at the end
--     of runShapeDStage1Background(), enqueues the job after Stage 4 dispatch
--     so the rollup runs alongside Stage 4 (not after) for parallelism.
--   - shortlisting-job-dispatcher/index.ts: KIND_TO_FN entry
--     'canonical_rollup' -> 'canonical-rollup'; treated as terminal (no
--     downstream chain) so the dispatcher exits after invoking it.

ALTER TABLE public.shortlisting_jobs
  DROP CONSTRAINT IF EXISTS shortlisting_jobs_kind_check;

ALTER TABLE public.shortlisting_jobs
  ADD CONSTRAINT shortlisting_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ingest'::text,
    'extract'::text,
    'pass0'::text,
    'pass1'::text,
    'pass2'::text,
    'pass3'::text,
    'render_preview'::text,
    'shape_d_stage1'::text,
    'stage4_synthesis'::text,
    'canonical_rollup'::text
  ]));

DROP INDEX IF EXISTS public.uniq_shortlisting_jobs_active_pass_per_round;

CREATE UNIQUE INDEX uniq_shortlisting_jobs_active_pass_per_round
  ON public.shortlisting_jobs USING btree (round_id, kind)
  WHERE (
    kind = ANY (ARRAY[
      'pass0'::text,
      'pass1'::text,
      'pass2'::text,
      'pass3'::text,
      'shape_d_stage1'::text,
      'stage4_synthesis'::text,
      'canonical_rollup'::text
    ])
    AND status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text])
  );

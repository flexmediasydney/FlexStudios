-- ════════════════════════════════════════════════════════════════════════
-- Migration 327 — QC iter 5 P1-2
-- claim_drone_jobs RETURNS TABLE adds shot_id column.
--
-- Pre-mig: dispatcher's `job.shot_id` was always undefined because the
-- RPC's RETURNING clause omitted it. Commit 7e05d6d added
-- `shot_id: job.shot_id || job.payload?.shot_id` as the dispatch payload —
-- the OR fallback worked but the typed code path was dead. This migration
-- surfaces the column properly so the dispatcher can use the W11-S1 hot
-- index path (now populated by mig 326's backfill).
--
-- DROP + CREATE because PostgreSQL forbids changing the RETURNS TABLE
-- shape via CREATE OR REPLACE.
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.claim_drone_jobs(integer);

CREATE OR REPLACE FUNCTION public.claim_drone_jobs(p_limit integer DEFAULT 10)
RETURNS TABLE(
  id uuid,
  project_id uuid,
  shoot_id uuid,
  shot_id uuid,
  kind text,
  status text,
  payload jsonb,
  attempt_count integer,
  scheduled_for timestamp with time zone
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM drone_jobs j
    WHERE j.status = 'pending'
      AND j.scheduled_for <= NOW()
      AND j.attempt_count < 5
    ORDER BY j.scheduled_for ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE drone_jobs dj
  SET status = 'running',
      started_at = NOW(),
      attempt_count = dj.attempt_count + 1
  FROM claimed
  WHERE dj.id = claimed.id
  RETURNING
    dj.id,
    dj.project_id,
    dj.shoot_id,
    dj.shot_id,
    dj.kind,
    dj.status,
    dj.payload,
    dj.attempt_count,
    dj.scheduled_for;
END
$function$;

COMMENT ON FUNCTION public.claim_drone_jobs(integer) IS
  'QC iter 5 P1-2: returns shot_id alongside other claim fields so dispatcher can use the W11-S1 hot index path. Pre-mig the RETURN TABLE omitted shot_id and dispatcher had to fall back to payload.shot_id.';

NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════
-- Migration 258 — claim_drone_jobs hard-caps attempt_count (QC6 #12)
--
-- The dispatcher (drone-job-dispatcher) has a soft cap of MAX_ATTEMPTS=3 —
-- after 3 failures a job gets transitioned to dead_letter. But that runs in
-- the dispatcher AFTER the job is claimed — if the dispatcher itself dies
-- mid-claim (or the dead-letter write fails), the job's attempt_count keeps
-- climbing each time the cron picks it up because there's no DB-side cap on
-- claim. A poison-pill stuck at attempt_count=99 indefinitely re-claims and
-- burns 1 attempt per dispatcher tick.
--
-- Adding `AND attempt_count < 5` to claim_drone_jobs gives a HARD ceiling
-- (independent of the dispatcher's soft cap of 3). At 5 attempts the row
-- becomes uneligible for re-claim regardless of dispatcher health. The
-- dispatcher's existing dead-letter logic still fires at 3 in normal
-- operation; the DB-side cap is a backstop for runaway loops.
--
-- Other changes to claim_drone_jobs (return signature, attempt_count++) are
-- preserved verbatim from migration 248. Only the WHERE clause grows.
-- ════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS public.claim_drone_jobs(int);

CREATE OR REPLACE FUNCTION public.claim_drone_jobs(p_limit int DEFAULT 10)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  shoot_id uuid,
  kind text,
  status text,
  payload jsonb,
  attempt_count int,
  scheduled_for timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    dj.kind,
    dj.status,
    dj.payload,
    dj.attempt_count,
    dj.scheduled_for;
END
$$;

GRANT EXECUTE ON FUNCTION public.claim_drone_jobs(int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_drone_jobs(int) TO service_role;

NOTIFY pgrst, 'reload schema';

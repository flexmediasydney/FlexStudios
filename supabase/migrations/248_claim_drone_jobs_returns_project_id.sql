-- ════════════════════════════════════════════════════════════════════════
-- Migration 248 — claim_drone_jobs returns project_id
--
-- The dispatcher's chain logic (sfm-success → poi_fetch and poi_fetch-success
-- → raw_preview_render) reads `job.project_id` to seed the chained job's
-- payload. The previous claim_drone_jobs() RPC return signature omitted the
-- `project_id` column, so the dispatcher always saw `undefined`, fell into
-- the "project_id unresolvable" warning branch, and either:
--   - skipped poi_fetch entirely (operator's previews never got POIs drawn), or
--   - re-derived the project_id via a per-shoot lookup, adding a 50-100ms
--     round-trip per chain step.
--
-- Returning project_id directly removes the lookup hop and makes the
-- dispatcher's chain decision deterministic. The SELECT/RETURNING surface is
-- otherwise unchanged (FOR UPDATE SKIP LOCKED, attempt_count++, status flip
-- to 'running'). drone_jobs.project_id has been NULLABLE since 232 and is
-- already populated by every enqueuer in the codebase, so the new column
-- adds no required-data risk.
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

-- ── drone_jobs_decrement_attempts ─────────────────────────────────────────
-- Used by the dispatcher's stale-claim sweeper AND its deferred-result path
-- to refund the attempt_count that claim_drone_jobs() always burns on claim.
-- Without this, an Edge Function timeout (platform-level, not a real per-
-- job error) and a "0/N rendered with all skipped_no_edit" benign result
-- both ratchet the job toward dead_letter as if they'd been real failures.
-- GREATEST(0, ...) clamps so we never write a negative value.
CREATE OR REPLACE FUNCTION public.drone_jobs_decrement_attempts(p_ids uuid[])
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH updated AS (
    UPDATE drone_jobs
    SET attempt_count = GREATEST(0, attempt_count - 1)
    WHERE id = ANY(p_ids)
    RETURNING 1
  )
  SELECT COUNT(*)::int FROM updated;
$$;

GRANT EXECUTE ON FUNCTION public.drone_jobs_decrement_attempts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.drone_jobs_decrement_attempts(uuid[]) TO service_role;

NOTIFY pgrst, 'reload schema';

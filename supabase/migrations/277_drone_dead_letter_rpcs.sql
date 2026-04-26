-- 277_drone_dead_letter_rpcs
-- ────────────────────────────────────────────────────────────────────────
-- Wave 5 P1 / QC2-6 #1 + QC2-8 #1 / QC2-8 #14
--
-- The function get_drone_dead_letter_jobs was claimed in iter-1 mig 249's
-- docstring but was NEVER actually created. Verified live via
-- `SELECT proname FROM pg_proc` — NOT FOUND. As a result, the 3 dead-letter
-- render jobs currently sitting in drone_jobs are unreachable from any UI;
-- operators cannot inspect or revive them.
--
-- This migration:
--   1. Creates the missing read RPC (get_drone_dead_letter_jobs).
--   2. Adds a sibling resurrection RPC (resurrect_drone_dead_letter_job)
--      so an operator can move a dead-letter row back to 'pending' after
--      fixing the upstream cause (was QC2-8 item #14, "no path forward
--      for stuck jobs without manual SQL").
--
-- Both functions are SECURITY DEFINER with explicit search_path so they
-- can be invoked from the dashboard via the authenticated key.
-- Resurrection is gated to master_admin and admin only.

CREATE OR REPLACE FUNCTION get_drone_dead_letter_jobs(p_limit int DEFAULT 50)
RETURNS TABLE (
  id uuid,
  project_id uuid,
  shoot_id uuid,
  kind text,
  attempt_count int,
  error_message text,
  scheduled_for timestamptz,
  finished_at timestamptz,
  payload jsonb
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, project_id, shoot_id, kind, attempt_count, error_message,
         scheduled_for, finished_at, payload
  FROM drone_jobs
  WHERE status = 'dead_letter'
  ORDER BY finished_at DESC NULLS LAST, scheduled_for DESC
  LIMIT p_limit;
$$;

GRANT EXECUTE ON FUNCTION get_drone_dead_letter_jobs(int)
  TO authenticated, service_role;

CREATE OR REPLACE FUNCTION resurrect_drone_dead_letter_job(p_job_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role text := get_user_role();
  v_updated int;
BEGIN
  IF v_role NOT IN ('master_admin','admin') THEN
    RAISE EXCEPTION 'Only master_admin or admin can resurrect dead-letter jobs';
  END IF;

  UPDATE drone_jobs
     SET status         = 'pending',
         attempt_count  = 0,
         error_message  = NULL,
         scheduled_for  = NOW(),
         finished_at    = NULL,
         started_at     = NULL
   WHERE id = p_job_id
     AND status = 'dead_letter';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

GRANT EXECUTE ON FUNCTION resurrect_drone_dead_letter_job(uuid)
  TO authenticated, service_role;

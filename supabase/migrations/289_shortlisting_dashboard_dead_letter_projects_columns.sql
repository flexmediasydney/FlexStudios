-- Wave 6 P1 SHORTLIST: mig 289: dashboard stats + dead-letter RPCs + projects columns
--
-- Three deliverables in one migration:
--
--   1. get_shortlisting_dashboard_stats() RETURNS TABLE
--      Mirrors get_drone_dashboard_stats (mig 249/263). Per-day counts of
--      rounds by status, pending/running/dead-letter job counts, total
--      cost-today, median round duration. Uses Australia/Sydney timezone
--      for date_trunc (matches drone migration 263 pattern).
--
--   2. get_shortlisting_dead_letter_jobs(p_limit INT) RETURNS TABLE
--      Mirrors mig 277. Returns dead-letter jobs ordered by recency for
--      the ops UI dead-letter inspector.
--
--   3. resurrect_shortlisting_dead_letter_job(p_job_id UUID) RETURNS JSONB
--      Mirrors mig 277. Master_admin/admin only (gated via get_user_role
--      check inside SECURITY DEFINER body). Flips status to pending,
--      resets attempt_count to 0, clears error_message and started_at,
--      sets scheduled_for=NOW() so the dispatcher picks it up immediately.
--
--   4. ALTER TABLE projects: add 4 columns for shortlisting state surfacing
--      directly on the project row:
--         shortlist_editor_id           UUID FK auth.users (assigned editor)
--         shortlist_editor_name         TEXT cached display name
--         shortlist_status              TEXT enum-checked
--         current_shortlist_round_id    UUID FK shortlisting_rounds
--      The status enum (per brief): not_started | awaiting_settling |
--      processing | ready_for_review | locked | delivered | reshoot_required.
--
-- All RPCs are SECURITY DEFINER with search_path = public, pg_temp
-- (matches mig 279 hardening). Dashboard RPC is granted to
-- authenticated/service_role; dead-letter read is broader (auth+service);
-- resurrection is admin-gated inside the body.

-- ============================================================================
-- 1. get_shortlisting_dashboard_stats
-- ============================================================================

CREATE OR REPLACE FUNCTION get_shortlisting_dashboard_stats()
RETURNS TABLE (
  rounds_today INT,
  rounds_processing INT,
  rounds_proposed INT,
  rounds_locked INT,
  rounds_delivered_today INT,
  jobs_pending INT,
  jobs_running INT,
  jobs_dead_letter INT,
  jobs_failed_24h INT,
  total_cost_today_usd NUMERIC,
  median_round_duration_seconds NUMERIC
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH
    today_start AS (
      SELECT (date_trunc('day', timezone('Australia/Sydney', now())) AT TIME ZONE 'Australia/Sydney') AS ts
    ),
    rounds_today_counts AS (
      SELECT
        (SELECT COUNT(*) FROM shortlisting_rounds
          WHERE created_at >= (SELECT ts FROM today_start))::INT AS rounds_today,
        (SELECT COUNT(*) FROM shortlisting_rounds WHERE status = 'processing')::INT AS rounds_processing,
        (SELECT COUNT(*) FROM shortlisting_rounds WHERE status = 'proposed')::INT AS rounds_proposed,
        (SELECT COUNT(*) FROM shortlisting_rounds WHERE status = 'locked')::INT AS rounds_locked,
        (SELECT COUNT(*) FROM shortlisting_rounds
          WHERE status = 'delivered'
            AND COALESCE(completed_at, locked_at, created_at) >= (SELECT ts FROM today_start))::INT
          AS rounds_delivered_today
    ),
    job_counts AS (
      SELECT
        (SELECT COUNT(*) FROM shortlisting_jobs WHERE status = 'pending')::INT AS jobs_pending,
        (SELECT COUNT(*) FROM shortlisting_jobs WHERE status = 'running')::INT AS jobs_running,
        (SELECT COUNT(*) FROM shortlisting_jobs WHERE status = 'dead_letter')::INT AS jobs_dead_letter,
        -- "failed_24h" matches drone semantics (mig 249/263): terminal-dead OR
        -- in-recovery (pending with attempt_count > 1).
        (SELECT COUNT(*) FROM shortlisting_jobs
          WHERE (
            status = 'dead_letter'
            OR (status = 'pending' AND attempt_count > 1)
          )
            AND COALESCE(finished_at, created_at) > NOW() - INTERVAL '24 hours')::INT
          AS jobs_failed_24h
    ),
    cost_today AS (
      SELECT COALESCE(SUM(total_cost_usd), 0)::NUMERIC AS total_cost_today_usd
      FROM shortlisting_rounds
      WHERE COALESCE(completed_at, locked_at, started_at, created_at) >= (SELECT ts FROM today_start)
    ),
    duration_window AS (
      -- Median completed-round duration over the last 30 days (matches
      -- drone's 30-day SfM window pattern).
      SELECT percentile_cont(0.5) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at))
      )::NUMERIC AS median_duration_seconds
      FROM shortlisting_rounds
      WHERE completed_at IS NOT NULL
        AND started_at IS NOT NULL
        AND completed_at >= NOW() - INTERVAL '30 days'
    )
  SELECT
    rt.rounds_today,
    rt.rounds_processing,
    rt.rounds_proposed,
    rt.rounds_locked,
    rt.rounds_delivered_today,
    jc.jobs_pending,
    jc.jobs_running,
    jc.jobs_dead_letter,
    jc.jobs_failed_24h,
    ROUND(ct.total_cost_today_usd, 4),
    ROUND(dw.median_duration_seconds, 2)
  FROM rounds_today_counts rt, job_counts jc, cost_today ct, duration_window dw;
$$;

COMMENT ON FUNCTION get_shortlisting_dashboard_stats IS
  'Operator dashboard for the photo shortlisting engine. Returns rounds-by-status today, queue depth (pending/running/dead-letter), cost-today, and 30-day median round duration. Mirrors get_drone_dashboard_stats (mig 249/263) including Australia/Sydney date_trunc and dead_letter+in-recovery counting.';

GRANT EXECUTE ON FUNCTION get_shortlisting_dashboard_stats() TO authenticated, service_role;

-- ============================================================================
-- 2. get_shortlisting_dead_letter_jobs
-- ============================================================================

CREATE OR REPLACE FUNCTION get_shortlisting_dead_letter_jobs(p_limit INT DEFAULT 50)
RETURNS TABLE (
  id UUID,
  project_id UUID,
  round_id UUID,
  group_id UUID,
  kind TEXT,
  attempt_count INT,
  error_message TEXT,
  scheduled_for TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  payload JSONB
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, project_id, round_id, group_id, kind, attempt_count, error_message,
         scheduled_for, finished_at, payload
  FROM shortlisting_jobs
  WHERE status = 'dead_letter'
  ORDER BY finished_at DESC NULLS LAST, scheduled_for DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION get_shortlisting_dead_letter_jobs IS
  'Read RPC for the dead-letter inspector UI. Mirrors get_drone_dead_letter_jobs (mig 277). Returns rows ordered by most-recent-failure-first.';

GRANT EXECUTE ON FUNCTION get_shortlisting_dead_letter_jobs(INT)
  TO authenticated, service_role;

-- ============================================================================
-- 3. resurrect_shortlisting_dead_letter_job
-- ============================================================================

CREATE OR REPLACE FUNCTION resurrect_shortlisting_dead_letter_job(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_role TEXT := get_user_role();
  v_updated INT;
BEGIN
  IF v_role NOT IN ('master_admin','admin') THEN
    RAISE EXCEPTION 'Only master_admin or admin can resurrect dead-letter shortlisting jobs';
  END IF;

  UPDATE shortlisting_jobs
     SET status         = 'pending',
         attempt_count  = 0,
         error_message  = NULL,
         scheduled_for  = NOW(),
         finished_at    = NULL,
         started_at     = NULL,
         updated_at     = NOW()
   WHERE id = p_job_id
     AND status = 'dead_letter';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN jsonb_build_object('updated', v_updated);
END;
$$;

COMMENT ON FUNCTION resurrect_shortlisting_dead_letter_job IS
  'Admin-only resurrection of a dead-letter shortlisting job. Resets attempt_count to 0, clears error_message + finished_at + started_at, sets scheduled_for=NOW() so the dispatcher picks it up next tick. Mirrors resurrect_drone_dead_letter_job (mig 277). Returns {"updated": 0|1}.';

GRANT EXECUTE ON FUNCTION resurrect_shortlisting_dead_letter_job(UUID)
  TO authenticated, service_role;

-- ============================================================================
-- 4. ALTER projects — add 4 shortlisting columns
-- ============================================================================
-- These columns surface shortlisting state directly on the project row so
-- the project listing page can show status without a join. Idempotent
-- (IF NOT EXISTS) so re-running this migration is safe.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS shortlist_editor_id UUID
    REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS shortlist_editor_name TEXT,
  ADD COLUMN IF NOT EXISTS shortlist_status TEXT
    NOT NULL DEFAULT 'not_started',
  ADD COLUMN IF NOT EXISTS current_shortlist_round_id UUID
    REFERENCES shortlisting_rounds(id) ON DELETE SET NULL;

-- Add the CHECK constraint separately (idempotent via DO block — Postgres
-- doesn't have IF NOT EXISTS for constraints prior to PG16).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'projects_shortlist_status_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_shortlist_status_check
      CHECK (shortlist_status IN (
        'not_started','awaiting_settling','processing','ready_for_review',
        'locked','delivered','reshoot_required'
      ));
  END IF;
END$$;

COMMENT ON COLUMN projects.shortlist_status IS
  'Photo shortlisting state machine: not_started | awaiting_settling | processing | ready_for_review | locked | delivered | reshoot_required. Surface column for project listings; canonical state is on shortlisting_rounds.';
COMMENT ON COLUMN projects.current_shortlist_round_id IS
  'Pointer to the latest shortlisting_rounds row for this project (a reshoot creates a new round and bumps this).';

CREATE INDEX IF NOT EXISTS idx_projects_shortlist_status
  ON projects(shortlist_status) WHERE shortlist_status <> 'not_started';
CREATE INDEX IF NOT EXISTS idx_projects_current_shortlist_round
  ON projects(current_shortlist_round_id) WHERE current_shortlist_round_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';

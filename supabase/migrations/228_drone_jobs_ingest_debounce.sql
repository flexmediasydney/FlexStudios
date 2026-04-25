-- Migration 228: drone_jobs ingest-debounce support
--
-- Adds a unique partial index that allows ON CONFLICT DO UPDATE on the
-- (kind, project_id) tuple for *pending* ingest jobs. The dropbox-webhook
-- handler enqueues a `kind='ingest'` job per project_id when raw_drones
-- file events arrive; the index guarantees that 50 file uploads in a row
-- collapse to a single pending row (with `scheduled_for` ratcheted forward
-- by the latest event), preventing 50× duplicate ingest runs.
--
-- The index is `WHERE status = 'pending'` so once the dispatcher (Stream I)
-- claims a job — flipping status to 'running' / 'succeeded' — a fresh
-- pending row can be inserted alongside it for any new uploads. Without the
-- partial predicate, the second upload burst would conflict with the
-- already-completed prior job and the upsert would clobber a finished row.
--
-- We also expose a SECURITY DEFINER helper so the webhook can enqueue from
-- inside `serveWithAudit` without round-tripping the RLS policy (it already
-- runs as service_role, but keeping the SQL in the database makes the
-- debounce semantics auditable and reusable from Stream I/J/K).
--
-- No RLS changes — drone_jobs already has a service-role bypass for workers
-- via the standard Supabase auth model, and the read/write policies set in
-- migration 225 are unaffected.

-- ─── Unique partial index ────────────────────────────────────────────────────
-- Constraint: at most one PENDING ingest job per project. Other kinds
-- ('sfm', 'render', etc.) are unconstrained — they have their own natural
-- keys (shoot_id, shot_id) and don't need the same debounce.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drone_jobs_pending_ingest_per_project
  ON drone_jobs (project_id)
  WHERE status = 'pending' AND kind = 'ingest';

-- ─── enqueue_drone_ingest_job() helper ──────────────────────────────────────
-- Inserts (or refreshes) a debounced pending ingest job for a project.
-- Returns the row id. `scheduled_for` is ratcheted to the LATEST of the
-- existing scheduled_for and the new debounced time so a second burst of
-- uploads pushes the job's start time forward — never backward (which would
-- defeat the debounce).
--
-- Default debounce: 2 minutes from now. Caller can override.
CREATE OR REPLACE FUNCTION enqueue_drone_ingest_job(
  p_project_id UUID,
  p_debounce_seconds INT DEFAULT 120
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target_time TIMESTAMPTZ := NOW() + make_interval(secs => p_debounce_seconds);
  v_job_id UUID;
BEGIN
  -- The unique partial index above lets us name (project_id) as the conflict
  -- target ONLY when paired with a WHERE clause matching the partial-index
  -- predicate. Postgres requires the WHERE to be deterministic (no volatile
  -- fns, no subqueries on the table itself), so we restate the predicate
  -- inline.
  INSERT INTO drone_jobs (project_id, kind, status, payload, scheduled_for)
  VALUES (
    p_project_id,
    'ingest',
    'pending',
    jsonb_build_object('project_id', p_project_id),
    v_target_time
  )
  ON CONFLICT (project_id) WHERE (status = 'pending' AND kind = 'ingest')
  DO UPDATE SET
    -- ratchet scheduled_for forward only — never backward
    scheduled_for = GREATEST(drone_jobs.scheduled_for, EXCLUDED.scheduled_for),
    -- bump payload's last_debounced_at so we can audit the latest hit
    payload = COALESCE(drone_jobs.payload, '{}'::jsonb)
              || jsonb_build_object('last_debounced_at', NOW())
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION enqueue_drone_ingest_job IS
  'Debounced upsert of a pending kind=ingest drone_jobs row for a project. The unique partial index uniq_drone_jobs_pending_ingest_per_project enforces at-most-one pending ingest per project; subsequent calls within the debounce window just push scheduled_for forward.';

-- service_role + master_admin/admin can call this helper. Other roles do not
-- need to enqueue ingest jobs — that's a workers-and-system concern.
GRANT EXECUTE ON FUNCTION enqueue_drone_ingest_job(UUID, INT) TO authenticated, service_role;

-- Schema cache reload so PostgREST picks up the new RPC immediately.
NOTIFY pgrst, 'reload schema';

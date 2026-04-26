-- Wave 6 P1 SHORTLIST: mig 288: enqueue + claim RPCs for shortlisting_jobs
--
-- Two RPCs that mirror the drone module's enqueue + claim helpers:
--
--   enqueue_shortlisting_ingest_job(p_project_id UUID, p_debounce_seconds INT)
--     → returns UUID of the (debounced) ingest job. Mirrors mig 228 but
--       defaults to 7200 seconds (2 hours) instead of 120, because photo
--       shoots need a longer settling window than drone (Q1 user decision).
--
--   claim_shortlisting_jobs(p_limit INT)
--     → returns up to p_limit pending jobs whose scheduled_for is past,
--       atomically flipping status to 'running' and incrementing
--       attempt_count. Mirrors mig 248 + 258. Hard cap on attempt_count < 5
--       (DB-side backstop in case the dispatcher's soft cap of max_attempts
--       fails to fire).
--
-- Both are SECURITY DEFINER with search_path = public, pg_temp (matches
-- mig 279 hardening pattern). Granted to authenticated + service_role:
--   - service_role: dispatcher and webhook handler (the normal path)
--   - authenticated: lets the FlexStudios "Re-run shortlisting" button
--     trigger an enqueue without round-tripping the service-role JWT
--     (RLS-allowed roles can hit the RPC; the SECURITY DEFINER body
--     handles the actual write that the role's RLS policies wouldn't
--     allow because INSERT to shortlisting_jobs is admin-gated).
--
-- The unique partial index uniq_shortlisting_jobs_pending_ingest_per_project
-- (created in mig 284) is the debounce mechanism: subsequent enqueues
-- collapse to a single row via ON CONFLICT, ratcheting scheduled_for
-- forward (never backward).

-- ─── enqueue_shortlisting_ingest_job ─────────────────────────────────────────
-- Inserts (or refreshes) a debounced pending ingest job for a project.
-- Returns the row id. `scheduled_for` is ratcheted to the LATEST of the
-- existing scheduled_for and the new debounced time.
--
-- Default debounce: 7200 seconds (2 hours) per Q1 user decision. Caller can
-- override (manual "Re-run now" button → 60 seconds; reshoot → fresh 7200).
CREATE OR REPLACE FUNCTION enqueue_shortlisting_ingest_job(
  p_project_id UUID,
  p_debounce_seconds INT DEFAULT 7200
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_target_time TIMESTAMPTZ := NOW() + make_interval(secs => p_debounce_seconds);
  v_job_id UUID;
BEGIN
  INSERT INTO shortlisting_jobs (project_id, kind, status, payload, scheduled_for)
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
    scheduled_for = GREATEST(shortlisting_jobs.scheduled_for, EXCLUDED.scheduled_for),
    -- bump payload's last_debounced_at so we can audit the latest hit
    payload = COALESCE(shortlisting_jobs.payload, '{}'::jsonb)
              || jsonb_build_object('last_debounced_at', NOW())
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION enqueue_shortlisting_ingest_job IS
  'Debounced upsert of a pending kind=ingest shortlisting_jobs row for a project. The unique partial index uniq_shortlisting_jobs_pending_ingest_per_project enforces at-most-one pending ingest per project; subsequent calls within the debounce window just push scheduled_for forward. Default 7200s (2 hours) per Q1 user decision; manual button passes 60 to fire immediately.';

GRANT EXECUTE ON FUNCTION enqueue_shortlisting_ingest_job(UUID, INT)
  TO authenticated, service_role;

-- ─── claim_shortlisting_jobs ─────────────────────────────────────────────────
-- Returns up to p_limit pending jobs whose scheduled_for is past, atomically
-- flipping status='running' and incrementing attempt_count. Mirrors mig 248
-- + 258 (drone equivalent), including the hard cap on attempt_count < 5
-- (DB-side backstop for runaway loops).
--
-- Returns project_id directly (mirrors mig 248 fix) so the dispatcher's
-- chain logic doesn't need a per-claim project lookup.
CREATE OR REPLACE FUNCTION claim_shortlisting_jobs(p_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  project_id UUID,
  round_id UUID,
  group_id UUID,
  kind TEXT,
  status TEXT,
  payload JSONB,
  attempt_count INT,
  scheduled_for TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM shortlisting_jobs j
    WHERE j.status = 'pending'
      AND j.scheduled_for <= NOW()
      AND j.attempt_count < 5
    ORDER BY j.scheduled_for ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE shortlisting_jobs sj
  SET status = 'running',
      started_at = NOW(),
      attempt_count = sj.attempt_count + 1,
      updated_at = NOW()
  FROM claimed
  WHERE sj.id = claimed.id
  RETURNING
    sj.id,
    sj.project_id,
    sj.round_id,
    sj.group_id,
    sj.kind,
    sj.status,
    sj.payload,
    sj.attempt_count,
    sj.scheduled_for;
END
$$;

COMMENT ON FUNCTION claim_shortlisting_jobs IS
  'Atomically claim up to p_limit pending shortlisting_jobs whose scheduled_for is past. Flips status to running, increments attempt_count, sets started_at. Hard cap on attempt_count < 5 (DB backstop). Mirrors claim_drone_jobs (mig 248 + 258). Returns project_id for dispatcher chain logic.';

GRANT EXECUTE ON FUNCTION claim_shortlisting_jobs(INT)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

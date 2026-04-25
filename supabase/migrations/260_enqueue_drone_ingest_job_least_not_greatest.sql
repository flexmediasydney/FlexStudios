-- ════════════════════════════════════════════════════════════════════════
-- Migration 260 — enqueue_drone_ingest_job uses LEAST not GREATEST
-- (QC6 #13)
--
-- Original implementation (mig 228) ratchets `scheduled_for` FORWARD via
-- GREATEST(existing, new). Intent was "never let a fresh debounce pull the
-- start time backward". But the side effect: a sustained burst of webhook
-- events (uploader writing 50 files over 90 seconds, each event firing the
-- 120-second debounce) keeps pushing the deadline by 120s on every tick,
-- starving the job indefinitely while the burst lasts.
--
-- Correct semantics: the debounce should fire 120s AFTER THE LATEST upload
-- in the burst, but bounded by some cap. The simplest fix is LEAST — once a
-- pending job exists, additional events RESET the deadline only if the new
-- one is sooner (which won't happen with a fixed debounce window, so the
-- deadline locks at first-event + 120s). Combined with the partial unique
-- index that prevents duplicate pending rows, this gives:
--   - first event in burst arrives → schedules T+120s
--   - subsequent events all upsert the SAME row, deadline pinned at T+120s
--   - dispatcher picks up at T+120s, status flips to running
--   - new events post-claim insert a fresh pending row (next burst starts)
--
-- This trades "potentially missing the very-last upload's 120s grace" (the
-- new row scheduled by the first upload still fires regardless of subsequent
-- uploads) for "never starves indefinitely". Acceptable: the ingest worker
-- scans the project's raw_drones folder at run time anyway, so any files
-- that landed during the debounce window are picked up.
-- ════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.enqueue_drone_ingest_job(
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
    -- LEAST not GREATEST — debounce pins to the FIRST event's deadline
    -- so a sustained event burst can't starve the job indefinitely. See
    -- migration body comment for the full rationale.
    scheduled_for = LEAST(drone_jobs.scheduled_for, EXCLUDED.scheduled_for),
    payload = COALESCE(drone_jobs.payload, '{}'::jsonb)
              || jsonb_build_object('last_debounced_at', NOW())
  RETURNING id INTO v_job_id;

  RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_drone_ingest_job IS
  'Debounced upsert of a pending kind=ingest drone_jobs row for a project. The unique partial index uniq_drone_jobs_pending_ingest_per_project enforces at-most-one pending ingest per project; subsequent calls within the debounce window keep scheduled_for at the EARLIEST proposed deadline (LEAST), preventing starvation under sustained event bursts.';

GRANT EXECUTE ON FUNCTION public.enqueue_drone_ingest_job(UUID, INT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

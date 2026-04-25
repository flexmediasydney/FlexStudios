-- ═══════════════════════════════════════════════════════════════════════════
-- Drone Phase 3 Stream I.C: drone-job-dispatcher (RPC + cron)
-- ───────────────────────────────────────────────────────────────────────────
-- Schedules `drone-job-dispatcher` Edge Function every minute. Picks up
-- pending `drone_jobs` and dispatches them to the appropriate handler:
--
--   kind='ingest' → drone-ingest Edge Function
--   kind='render' → drone-render Edge Function
--   kind='sfm_run' → Modal SfM worker (deferred — not yet HTTP-addressable;
--                    dispatcher marks 'deferred' for now and skips)
--
-- Pattern mirrors `dropbox-reconcile-nightly` cron from migration 224.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. claim_drone_jobs RPC ─────────────────────────────────────────────
-- Atomically claim up to N pending jobs whose scheduled_for <= now().
-- Uses FOR UPDATE SKIP LOCKED for safety against concurrent dispatcher
-- invocations (cron lateness, manual trigger, etc).
--
-- Returns the claimed rows; sets status='running' + started_at + bumps
-- attempt_count.
CREATE OR REPLACE FUNCTION public.claim_drone_jobs(p_limit INT DEFAULT 10)
RETURNS TABLE (
  id UUID,
  kind TEXT,
  status TEXT,
  payload JSONB,
  attempt_count INT,
  scheduled_for TIMESTAMPTZ,
  shoot_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  RETURN QUERY
  WITH claimed AS (
    SELECT j.id
    FROM public.drone_jobs j
    WHERE j.status = 'pending'
      AND j.scheduled_for <= NOW()
    ORDER BY j.scheduled_for ASC, j.created_at ASC
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.drone_jobs j
  SET status = 'running',
      started_at = NOW(),
      attempt_count = COALESCE(j.attempt_count, 0) + 1
  FROM claimed
  WHERE j.id = claimed.id
  RETURNING j.id, j.kind, j.status, j.payload, j.attempt_count, j.scheduled_for, j.shoot_id;
END;
$func$;

GRANT EXECUTE ON FUNCTION public.claim_drone_jobs(INT) TO service_role;

COMMENT ON FUNCTION public.claim_drone_jobs(INT) IS
  'Drone Phase 3 Stream I.C: atomic job claiming for drone-job-dispatcher Edge Function.';


-- ─── 2. Cron schedule (every minute) ─────────────────────────────────────
DO $$
DECLARE
  job_token TEXT;
BEGIN
  -- Use the same vault-stored cron JWT used by other cron jobs.
  SELECT decrypted_secret INTO job_token
  FROM vault.decrypted_secrets
  WHERE name = 'pulse_cron_jwt'
  LIMIT 1;

  IF job_token IS NULL THEN
    RAISE EXCEPTION 'pulse_cron_jwt not found in vault — required for drone-job-dispatcher cron';
  END IF;

  -- Unschedule any prior version (idempotent on re-apply).
  PERFORM cron.unschedule('drone-job-dispatcher')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drone-job-dispatcher');

  -- Run every minute.
  PERFORM cron.schedule(
    'drone-job-dispatcher',
    '* * * * *',
    format($job$
      SELECT net.http_post(
        url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/drone-job-dispatcher',
        headers := jsonb_build_object(
          'Authorization', 'Bearer %s',
          'Content-Type', 'application/json',
          'x-caller-context', 'cron:drone-job-dispatcher'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 145000
      );
    $job$, job_token)
  );
END$$;

COMMENT ON EXTENSION pg_cron IS
  'Drone Phase 3 Stream I.C: drone-job-dispatcher every minute (no-op when queue is empty)';

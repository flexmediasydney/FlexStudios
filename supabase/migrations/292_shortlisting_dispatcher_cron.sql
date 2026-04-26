-- Wave 6 P5 SHORTLIST: mig 292: pg_cron schedule for shortlisting-job-dispatcher (every 1 min)
--
-- Mirrors mig 232 + 251 (drone-job-dispatcher cron). Two pieces:
--
--   1. shortlisting_jobs_decrement_attempts RPC — atomic helper used by the
--      dispatcher's stale-claim sweep to refund attempt_count when a job is
--      reset from 'running' → 'pending' due to an Edge-Function timeout
--      (vs a real per-job error). supabase-js can't express
--      attempt_count = GREATEST(0, attempt_count - 1) in .update(), so we
--      expose a dedicated RPC. Mirrors drone_jobs_decrement_attempts (used by
--      drone-job-dispatcher's STALE_CLAIM_MIN sweep, see drone audit #30).
--
--   2. pg_cron schedule that POSTs to shortlisting-job-dispatcher every
--      minute. JWT is resolved from vault (`pulse_cron_jwt`) inline in the
--      cron command body so the Authorization header re-resolves at each
--      tick (rotation-safe — same fix mig 251 applied to the drone cron).

-- ─── 1. shortlisting_jobs_decrement_attempts RPC ─────────────────────────────
-- Atomically decrement attempt_count for the given job ids, clamped to >= 0.
-- Used only by the dispatcher's stale-claim sweep — production paths (mark
-- failed/succeeded) don't need this.
CREATE OR REPLACE FUNCTION public.shortlisting_jobs_decrement_attempts(p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE shortlisting_jobs
  SET attempt_count = GREATEST(0, attempt_count - 1),
      updated_at    = NOW()
  WHERE id = ANY(p_ids);
END
$$;

COMMENT ON FUNCTION public.shortlisting_jobs_decrement_attempts(UUID[]) IS
  'Stale-claim sweep helper. Decrements attempt_count by 1 (floor 0) for the given job ids. Called by shortlisting-job-dispatcher when an Edge-Function timeout leaves a job in running state past STALE_CLAIM_MIN minutes, so platform timeouts don''t burn the retry budget. Mirrors drone_jobs_decrement_attempts.';

GRANT EXECUTE ON FUNCTION public.shortlisting_jobs_decrement_attempts(UUID[])
  TO service_role;

-- ─── 2. Cron schedule (every minute) ─────────────────────────────────────
DO $$
BEGIN
  -- Sanity check: the cron job needs a valid service-role JWT in the
  -- vault. Refuse to recreate without it (matches mig 251 pattern).
  IF NOT EXISTS (
    SELECT 1 FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt'
  ) THEN
    RAISE EXCEPTION 'pulse_cron_jwt missing from vault — required for shortlisting-job-dispatcher cron';
  END IF;

  -- Idempotent: drop any prior schedule with this name first.
  PERFORM cron.unschedule('shortlisting-job-dispatcher')
    WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'shortlisting-job-dispatcher');

  -- Vault SELECT lives INSIDE the cron command body so the JWT is
  -- re-resolved every minute (rotation-safe — see mig 251).
  PERFORM cron.schedule(
    'shortlisting-job-dispatcher',
    '* * * * *',
    $job$
      SELECT net.http_post(
        url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/shortlisting-job-dispatcher',
        headers := jsonb_build_object(
          'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
          'Content-Type',     'application/json',
          'x-caller-context', 'cron:shortlisting-job-dispatcher'
        ),
        body := '{}'::jsonb,
        timeout_milliseconds := 145000
      );
    $job$
  );
END$$;

NOTIFY pgrst, 'reload schema';

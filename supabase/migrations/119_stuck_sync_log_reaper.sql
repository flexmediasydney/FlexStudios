-- 119_stuck_sync_log_reaper.sql
-- Defensive watchdog: mark any pulse_sync_logs row stuck in status='running'
-- for more than 20 minutes as 'failed' with a clear error_message.
--
-- Root cause of original bug (Apr 2026): pulseDetailEnrich was writing its
-- final UPDATE to non-existent columns (records_processed, message,
-- cost_estimate_usd, apify_run_ids). PostgREST silently dropped the UPDATE
-- and rows accumulated in 'running' forever. 20+ rows piled up before it
-- was noticed — the UI "Recent runs" panel showed them as perpetually
-- in-flight.
--
-- There is already a hourly job `pulse-stale-cleanup` (installed inline by
-- a prior migration) that runs at 30min. That was not enough: the rows were
-- invisible until a human eyeballed the sync_logs table. This reaper runs
-- more aggressively (every 10 min, 20-min threshold) and uses a DISTINCT
-- error message so it is obvious in log search that the watchdog — not the
-- function itself — closed the row out.

BEGIN;

-- Drop any previous registration so this migration is idempotent.
SELECT cron.unschedule('pulse-sync-logs-stuck-reaper')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-sync-logs-stuck-reaper');

SELECT cron.schedule(
  'pulse-sync-logs-stuck-reaper',
  '*/10 * * * *',  -- every 10 minutes
  $$
  UPDATE public.pulse_sync_logs
     SET status = 'failed',
         completed_at = COALESCE(completed_at, NOW()),
         error_message = COALESCE(
           error_message,
           'pulse-sync-logs-stuck-reaper: row was stuck in status=running for >20min — the edge function likely crashed or silently failed its final UPDATE. Investigate the calling function''s logs around started_at.'
         )
   WHERE status = 'running'
     AND started_at < NOW() - INTERVAL '20 minutes';
  $$
);

COMMENT ON EXTENSION pg_cron IS
  'Cron jobs: pulse-sync-logs-stuck-reaper (migration 119) guards against edge-function crashes or schema-mismatched final UPDATEs that would otherwise leave pulse_sync_logs rows perpetually in status=running.';

COMMIT;

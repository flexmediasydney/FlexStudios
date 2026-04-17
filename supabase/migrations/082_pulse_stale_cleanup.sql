-- 082_pulse_stale_cleanup.sql
-- Guard against stale `pulse_sync_logs` rows that can accumulate when
-- `pulseDataSync` is killed mid-run (edge runtime 150s timeout, network
-- error, crash) and never transitions its log row out of `status='running'`.
--
-- These stale rows block new scrapes because `pulseFireScrapes` uses a
-- 30-min "already running" guard keyed on this table.
--
-- This migration installs a pg_cron job that every hour marks any row
-- stuck in `running` for more than 30 minutes as `failed`, sets
-- `completed_at=NOW()`, and records an `error_message` explaining the
-- auto-timeout. It also runs the same cleanup once inline so any rows
-- stale at deploy time are unblocked immediately.
--
-- Schema note: `pulse_sync_logs` uses status values of `running`,
-- `completed`, and `failed` (confirmed via information_schema). We reuse
-- `failed` rather than introducing a new `timed_out` value so the existing
-- UI, the pulseFireScrapes "already running" query, and the pulse_sync_runs
-- view (migration 069) all treat these as terminal without changes.

-- ── One-time cleanup of existing stale rows ─────────────────────────────
UPDATE public.pulse_sync_logs
SET status = 'failed',
    completed_at = NOW(),
    error_message = 'auto-timed-out: exceeded 30min wall-clock (backfill on migration 082)'
WHERE status = 'running'
  AND started_at < NOW() - INTERVAL '30 minutes';

-- ── Hourly pg_cron job: 5 minutes past every hour ───────────────────────
-- Idempotent: unschedule any pre-existing job with the same name first.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'pulse-stale-cleanup') THEN
    PERFORM cron.unschedule('pulse-stale-cleanup');
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-stale-cleanup',
  '5 * * * *',
  $$UPDATE public.pulse_sync_logs SET status = 'failed', completed_at = NOW(), error_message = 'auto-timed-out: exceeded 30min wall-clock' WHERE status = 'running' AND started_at < NOW() - INTERVAL '30 minutes'$$
);

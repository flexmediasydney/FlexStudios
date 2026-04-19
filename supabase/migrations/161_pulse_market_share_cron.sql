-- 161_pulse_market_share_cron.sql
-- Schedule the Market Share missed-opportunity compute worker.
--
-- Runs every 10 minutes, computes up to 500 stale/new quotes per tick.
-- At ~0.3s per quote, 500 fits comfortably in the 10-min window (we
-- measured ~30s for 1000 during retro-fill, so 500 is ~15s — well under).
-- Back-pressure handled naturally: if a sync drops 2000 new listings
-- between ticks, the worker processes them over the next 4 ticks.
--
-- Uses pg_cron directly (no HTTP edge-function round-trip) because the
-- compute function lives in the DB and has no external dependencies.
--
-- Safe to re-run: unschedules existing job with same name first.

BEGIN;

-- Unschedule any existing job with this name
DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-compute-stale-quotes';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

-- Schedule: every 10 minutes
SELECT cron.schedule(
  'pulse-compute-stale-quotes',
  '*/10 * * * *',
  $$ SELECT pulse_compute_stale_quotes(500); $$
);

COMMIT;

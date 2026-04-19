-- 184_legacy_geocode_cron.sql
-- Register the pulse-legacy-geocode cron job.
--
-- Runs every 5 minutes, geocodes up to 100 un-geocoded legacy_projects rows
-- per tick. Google quota is 50 req/s so 100 rows * ~120ms ≈ 12s which fits
-- well within the 5-minute window. Back-pressure: if an import drops 3000
-- rows at once, they'll clear over ~150 minutes of cron ticks.
--
-- Idempotent — unschedules any existing job with this name before registering.

BEGIN;

DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-legacy-geocode';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-legacy-geocode',
  '*/5 * * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/geocodeLegacyProjects',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',  'application/json',
      'x-caller-context', 'cron:pulse-legacy-geocode'
    ),
    body := '{"limit":100}'::jsonb
  );
  $cron$
);

COMMIT;

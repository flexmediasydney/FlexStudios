-- 188_legacy_recompute_cron.sql
-- Schedule a nightly sweep of the Market Share substrate against legacy_projects
-- so any stale rows converge on the new captured_by_legacy truth. The heavy
-- lifting is done by the pulseRecomputeLegacy edge function (passes the
-- wall-clock budget back as `had_more: true` if the job needs to be re-run).
--
-- Runs 03:40 UTC — after pulse-aggregate-reconciler (35) but before most
-- business hours in AEST. Mode 'stale_only' is cheap: it skips rows whose
-- captured_by_legacy column is already true.
--
-- Safe to re-run: unschedules any existing job with the same name first.

BEGIN;

DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-legacy-recompute';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-legacy-recompute',
  '40 3 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseRecomputeLegacy',
    headers := jsonb_build_object(
      'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',     'application/json',
      'x-caller-context', 'cron:pulse-legacy-recompute'
    ),
    body := jsonb_build_object('trigger','cron','mode','stale_only','max_rows',50000)
  );
  $cron$
);

COMMIT;

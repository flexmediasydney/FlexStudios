-- 186_legacy_pkg_map_cron.sql
-- Wire the legacy-package mapping worker to pg_cron so fresh imports
-- land mapped within ~5 minutes. 500 rows per tick covers the typical
-- bulk-import churn (a Pipedrive dump of 5-10k rows back-fills in well
-- under an hour).
--
-- The worker gracefully no-ops when legacy_projects doesn't exist or
-- the unmapped queue is empty — safe to leave running forever.
--
-- Re-runnable: unschedules the existing job with the same name first,
-- so repeat deploys don't stack duplicate cron entries.

BEGIN;

-- Unschedule any existing job with this name
DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-legacy-pkg-map';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

-- Schedule: every 5 minutes
SELECT cron.schedule(
  'pulse-legacy-pkg-map',
  '*/5 * * * *',
  $$ SELECT public.legacy_map_packages_batch(NULL, 500); $$
);

COMMIT;

-- 196_legacy_reconcile_cron.sql
-- Nightly reconciliation pass so that legacy_projects get re-linked when
-- upstream pulse_agents / pulse_agencies gain CRM linkage (Agent A's
-- integrity workers may auto-link agencies overnight). legacy_reconcile_all
-- is idempotent, so re-running it at 04:10 UTC (after the 03:40 UTC
-- pulse-legacy-recompute job) is free for rows already linked and catches
-- any newly-unblocked ones.
--
-- Re-runnable: unschedules any prior job with the same name first.

BEGIN;

DO $$
DECLARE v_jobid int;
BEGIN
  SELECT jobid INTO v_jobid FROM cron.job WHERE jobname = 'pulse-legacy-reconcile';
  IF v_jobid IS NOT NULL THEN
    PERFORM cron.unschedule(v_jobid);
  END IF;
END $$;

SELECT cron.schedule(
  'pulse-legacy-reconcile',
  '10 4 * * *',
  $cron$ SELECT public.legacy_reconcile_all(0.85); $cron$
);

COMMIT;

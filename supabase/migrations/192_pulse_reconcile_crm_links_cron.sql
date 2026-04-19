-- 192_pulse_reconcile_crm_links_cron.sql
-- Nightly cron for the pulseReconcileCrmLinks edge function.
--
-- Fires 02:50 UTC (12:50 AEST) — 10 minutes before `pulse-reconcile-orphans`
-- at 03:00 so the linkage reconciler runs first, any auto-links trigger the
-- substrate invalidation, and the orphan sweeper can observe a consistent
-- graph afterward.
--
-- Uses the same vault secret + http_post pattern as migration 131 (orphan
-- reconcile) and 126 (detail enrich).

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('pulse-reconcile-crm-links');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'pulse-reconcile-crm-links',
  '50 2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/pulseReconcileCrmLinks',
    headers := jsonb_build_object(
      'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',     'application/json',
      'x-caller-context', 'cron:pulse-reconcile-crm-links'
    ),
    body := '{"trigger":"cron"}'::jsonb
  );
  $cron$
);

COMMIT;

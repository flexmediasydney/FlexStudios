-- Migration 224: Nightly pg_cron schedule for dropbox-reconcile
--
-- Fires 02:30 UTC nightly = 12:30 / 13:30 AEST (depends on DST). 30 minutes
-- before the existing pulse-reconcile-crm-links cron (02:50 UTC, migration
-- 192) so the two large reconciles don't pile up.
--
-- Auth uses the same vault `pulse_cron_jwt` pattern as every other cron.
-- The function itself is idempotent: Dropbox cursors advance monotonically
-- so a back-fill after a normally-functioning webhook day emits zero events.

BEGIN;

DO $$
BEGIN
  PERFORM cron.unschedule('dropbox-reconcile-nightly');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule(
  'dropbox-reconcile-nightly',
  '30 2 * * *',
  $cron$
  SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/dropbox-reconcile',
    headers := jsonb_build_object(
      'Authorization',    'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1),
      'Content-Type',     'application/json',
      'x-caller-context', 'cron:dropbox-reconcile'
    ),
    body := '{"trigger":"cron"}'::jsonb,
    timeout_milliseconds := 145000
  );
  $cron$
);

COMMIT;

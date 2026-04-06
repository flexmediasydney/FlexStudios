-- Migration: Add pg_cron job for automatic Google Calendar sync
-- The calendar sync was stalling because no cron trigger existed after the Base44 migration.
-- This runs syncGoogleCalendar every 30 minutes for all active calendar connections.

SELECT cron.schedule(
  'sync-google-calendar',
  '*/30 * * * *',
  $$SELECT net.http_post(
    url := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/syncGoogleCalendar',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  ) AS request_id$$
);

-- 366_notification_cron_trigger_auth_fix.sql
-- Fix: the email cron + push trigger were authenticating with
--   current_setting('app.settings.service_role_key', true)
-- which returns NULL on this project — the setting is not configured at the
-- DB level here. The pattern that works (used by pulseFireWorker,
-- drone-job-dispatcher, shortlisting-job-dispatcher, etc.) reads a
-- service-role JWT from Supabase Vault.
--
-- Before this fix the email cron was 401-ing on every minute since 364 was
-- applied (UNAUTHORIZED_NO_AUTH_HEADER from the gateway). The push trigger
-- happened to "work" only because verify_jwt was disabled on that function;
-- with the fix below it works regardless of the gateway flag.

BEGIN;

-- ── Email cron: re-schedule with vault auth ─────────────────────────────────
SELECT cron.unschedule('send-notification-emails');

SELECT cron.schedule(
  'send-notification-emails',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/sendNotificationEmails',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)
    ),
    body    := '{"source":"pg_cron"}'::jsonb
  );
  $$
);

-- ── Push trigger: redefine with vault auth ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.fire_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.type NOT IN ('note_mention', 'note_reply') THEN RETURN NEW; END IF;
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/sendPushNotifications',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'pulse_cron_jwt' LIMIT 1)
    ),
    body    := jsonb_build_object('notificationId', NEW.id)
  );

  RETURN NEW;
END;
$$;

COMMIT;

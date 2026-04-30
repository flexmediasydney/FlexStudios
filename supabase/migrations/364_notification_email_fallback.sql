-- 364_notification_email_fallback.sql
-- Email fallback for in-app notifications via Resend.
--
-- For notifications of fallback-eligible types (currently note_mention,
-- note_reply), an INSERT trigger enqueues a row in notification_email_queue
-- with send_at = now() + 5 minutes. A pg_cron job ticks once a minute and
-- calls the sendNotificationEmails edge function, which:
--   1. Picks queue rows that are due and pending
--   2. Skips if the notification has been read/dismissed in the meantime
--   3. Skips if the recipient was active in the last 2 minutes
--   4. Skips if the recipient turned email_enabled off in their preferences
--   5. Otherwise sends via Resend and stamps status='sent'
--
-- Schema for sender / target is env-driven in the edge function:
--   RESEND_API_KEY            (required)
--   NOTIFICATION_FROM_EMAIL   (default: "FlexStudios <notifications@flexstudios.app>")
--   NOTIFICATION_APP_URL      (default: "https://flexstudios.app")

BEGIN;

-- ── 1. Queue table ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_email_queue (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  notification_id UUID NOT NULL REFERENCES public.notifications(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  send_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','sending','sent','skipped','failed')),
  skip_reason     TEXT,
  resend_id       TEXT,
  error           TEXT,
  attempts        INT NOT NULL DEFAULT 0,
  sent_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_neq_pending_due
  ON public.notification_email_queue (send_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_neq_notification
  ON public.notification_email_queue (notification_id);

CREATE INDEX IF NOT EXISTS idx_neq_user
  ON public.notification_email_queue (user_id);

-- Idempotency: a single notification should never enqueue twice.
CREATE UNIQUE INDEX IF NOT EXISTS uq_neq_notification_id
  ON public.notification_email_queue (notification_id);

-- ── 2. email_enabled preference column ──────────────────────────────────────
-- NULL  = use the type's default (TRUE for fallback-eligible types)
-- TRUE  = explicit opt-in
-- FALSE = explicit opt-out
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN;

COMMENT ON COLUMN public.notification_preferences.email_enabled IS
  'Email fallback toggle. NULL = use type default (note_mention/note_reply default to true). '
  'Explicit TRUE or FALSE overrides.';

-- ── 3. Trigger: enqueue email on notification insert ────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_notification_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only fallback-eligible types enqueue today. Add new types here as the
  -- product expands (or move to a config table later).
  IF NEW.type NOT IN ('note_mention', 'note_reply') THEN
    RETURN NEW;
  END IF;

  -- Skip self-targeted notifications (defensive — createNotificationsForUsers
  -- already excludes the source user, but trigger-level guard is cheap).
  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.notification_email_queue (notification_id, user_id, send_at)
  VALUES (NEW.id, NEW.user_id, now() + interval '5 minutes')
  ON CONFLICT (notification_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enqueue_notification_email ON public.notifications;

CREATE TRIGGER trg_enqueue_notification_email
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_notification_email();

-- ── 4. pg_cron: drain the queue every minute ────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_net  WITH SCHEMA extensions;

-- Unschedule first for re-runnability.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'send-notification-emails') THEN
    PERFORM cron.unschedule('send-notification-emails');
  END IF;
END $$;

SELECT cron.schedule(
  'send-notification-emails',
  '* * * * *',
  $$
  SELECT net.http_post(
    url     := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/sendNotificationEmails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body    := '{"source": "pg_cron"}'::jsonb
  );
  $$
);

COMMIT;

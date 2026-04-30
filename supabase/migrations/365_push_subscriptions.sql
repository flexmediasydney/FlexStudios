-- 365_push_subscriptions.sql
-- Web Push (RFC 8030) for installed PWAs — third delivery channel alongside
-- in-app bell + Resend email fallback. iOS 16.4+ on home-screen-installed
-- PWAs and all modern Android browsers receive lock-screen banners, vibrate
-- patterns, and OS notification sounds via this path.
--
-- Architecture:
--   1. Client subscribes via swReg.pushManager.subscribe with VAPID public key.
--   2. Subscription { endpoint, p256dh, auth } persisted here, keyed by
--      endpoint (one row per device-browser combo). One user can have many.
--   3. AFTER INSERT trigger on notifications enqueues an HTTP call to the
--      sendPushNotifications edge function with the new notification id.
--   4. Edge function looks up the recipient's subscriptions, signs a VAPID
--      JWT (ES256), encrypts payload with each subscription's p256dh+auth,
--      POSTs to the endpoint URL. Apple's push gateway (or FCM on Android)
--      delivers to the device, the service worker push handler renders it.
--
-- Push is fired immediately (no 5-min defer like email) — the value is
-- realtime alerting, not delayed digest.

BEGIN;

CREATE TABLE IF NOT EXISTS public.push_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL UNIQUE,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  user_agent      TEXT,
  last_used_at    TIMESTAMPTZ,
  failure_count   INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON public.push_subscriptions (user_id);

-- ── RLS: users manage their own subscriptions ───────────────────────────────
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subs_own_read    ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subs_own_insert  ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subs_own_update  ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subs_own_delete  ON public.push_subscriptions;
DROP POLICY IF EXISTS push_subs_admin_full  ON public.push_subscriptions;

CREATE POLICY push_subs_own_read   ON public.push_subscriptions FOR SELECT USING (user_id = auth.uid());
CREATE POLICY push_subs_own_insert ON public.push_subscriptions FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY push_subs_own_update ON public.push_subscriptions FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY push_subs_own_delete ON public.push_subscriptions FOR DELETE USING (user_id = auth.uid());
CREATE POLICY push_subs_admin_full ON public.push_subscriptions FOR ALL  USING (public.get_user_role() = 'master_admin');

-- ── push_enabled preference column ──────────────────────────────────────────
-- NULL = use type default (note_mention/note_reply default to TRUE)
-- TRUE/FALSE = explicit override. Mirrors email_enabled.
ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN;

COMMENT ON COLUMN public.notification_preferences.push_enabled IS
  'Web Push toggle. NULL = use type default (note_mention/note_reply default to TRUE). '
  'Explicit TRUE/FALSE overrides.';

-- ── Trigger: fire push immediately on fallback-eligible notification insert ──
CREATE OR REPLACE FUNCTION public.fire_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Mirrors enqueue_notification_email — same eligible types for now.
  -- Push is intrusive; opting more types in is a deliberate product decision.
  IF NEW.type NOT IN ('note_mention', 'note_reply') THEN
    RETURN NEW;
  END IF;

  IF NEW.user_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fire-and-forget HTTP POST. The edge function does its own preference and
  -- subscription resolution. net.http_post is async — does NOT block the
  -- INSERT. If the function is down, the in-app bell + email still work.
  PERFORM net.http_post(
    url     := 'https://rjzdznwkxnzfekgcdkei.supabase.co/functions/v1/sendPushNotifications',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body    := jsonb_build_object('notificationId', NEW.id)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_fire_push_notification ON public.notifications;

CREATE TRIGGER trg_fire_push_notification
AFTER INSERT ON public.notifications
FOR EACH ROW
EXECUTE FUNCTION public.fire_push_notification();

COMMENT ON FUNCTION public.fire_push_notification() IS
  'AFTER INSERT trigger that fires sendPushNotifications edge function for '
  'fallback-eligible notification types. Async via pg_net — does not block '
  'the INSERT. Bell + email channels are unaffected if push fails.';

COMMIT;

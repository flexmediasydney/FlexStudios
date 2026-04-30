-- 367_notification_push_email_full_coverage.sql
-- Widen push + email fallback to cover every notification type, gated by a
-- per-type default-on policy and the user's explicit preference.
--
-- Before: triggers hard-coded the eligible type set to {note_mention, note_reply}.
-- After: triggers fire whenever the type is in the default-on set OR the user
-- has explicitly toggled push/email ON for it. Both default-on sets must stay
-- in sync with their mirrors:
--   - PUSH_DEFAULT_ON  in supabase/functions/sendPushNotifications/index.ts
--   - EMAIL_DEFAULT_ON in supabase/functions/sendNotificationEmails/index.ts
--   - PUSH_DEFAULT_ON / EMAIL_DEFAULT_ON in
--     flexmedia-src/src/pages/SettingsNotifications.jsx (NOTIFICATION_TYPES_LIST flags)
--
-- Edge functions still re-check the user's per-type and per-category
-- preferences at send time, so an explicit OFF override always wins.

BEGIN;

-- ── Helper sets ──────────────────────────────────────────────────────────────
-- These return the canonical default-on type lists. Inlining them inside the
-- trigger functions keeps the trigger self-contained (no extra config table).

CREATE OR REPLACE FUNCTION public._notif_push_default_on(p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_type = ANY (ARRAY[
    -- Direct work-on-you
    'note_mention','note_reply',
    'task_assigned','task_overdue','task_deadline_approaching','task_dependency_unblocked',
    'project_assigned_to_you','project_owner_assigned',
    'photographer_assigned',
    'timer_running_warning',
    -- Operational urgent
    'booking_arrived_pending_review','booking_urgent_review',
    'booking_cancellation','booking_no_photographer',
    -- Time-sensitive
    'revision_created','revision_urgent','change_request_created',
    -- Day-of-shoot
    'shoot_moved_to_onsite','shoot_overdue','shoot_date_changed','reschedule_advanced_stage',
    'calendar_event_conflict',
    -- Inbound from clients
    'email_requires_reply'
  ]);
$$;

CREATE OR REPLACE FUNCTION public._notif_email_default_on(p_type TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_type = ANY (ARRAY[
    -- Everything in the push default-on set:
    'note_mention','note_reply',
    'task_assigned','task_overdue','task_deadline_approaching','task_dependency_unblocked',
    'project_assigned_to_you','project_owner_assigned',
    'photographer_assigned',
    'timer_running_warning',
    'booking_arrived_pending_review','booking_urgent_review',
    'booking_cancellation','booking_no_photographer',
    'revision_created','revision_urgent','change_request_created',
    'shoot_moved_to_onsite','shoot_overdue','shoot_date_changed','reschedule_advanced_stage',
    'calendar_event_conflict',
    'email_requires_reply',
    -- Plus financial (email is the natural channel)
    'invoice_overdue_7d','invoice_overdue_14d','payment_received','payment_overdue_first',
    -- Plus stale alerts (less urgent, but still want a record)
    'revision_stale_48h',
    'email_received_from_client','email_sync_failed'
  ]);
$$;

-- ── Push trigger: fire for default-on OR explicit user opt-in ────────────────
CREATE OR REPLACE FUNCTION public.fire_push_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  -- Skip when default-OFF AND user has not explicitly turned it ON.
  -- Exclusive type pref wins; otherwise category-level pref; otherwise default.
  IF NOT public._notif_push_default_on(NEW.type) THEN
    IF NOT EXISTS (
      SELECT 1 FROM notification_preferences np
      WHERE np.user_id = NEW.user_id
        AND ((np.notification_type = NEW.type)
          OR ((np.notification_type IS NULL OR np.notification_type = '*') AND np.category = NEW.category))
        AND np.push_enabled IS TRUE
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  -- Default-on or explicit-on. The edge function still re-checks the user's
  -- preference at send time and skips if push_enabled is explicitly FALSE.
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

-- ── Email trigger: same shape, default-on set is wider ──────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_notification_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS NULL THEN RETURN NEW; END IF;

  IF NOT public._notif_email_default_on(NEW.type) THEN
    IF NOT EXISTS (
      SELECT 1 FROM notification_preferences np
      WHERE np.user_id = NEW.user_id
        AND ((np.notification_type = NEW.type)
          OR ((np.notification_type IS NULL OR np.notification_type = '*') AND np.category = NEW.category))
        AND np.email_enabled IS TRUE
    ) THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.notification_email_queue (notification_id, user_id, send_at)
  VALUES (NEW.id, NEW.user_id, now() + interval '5 minutes')
  ON CONFLICT (notification_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- ── Cleanup cron for the email queue (drops rows >7 days old) ────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'notification-email-queue-ttl') THEN
    PERFORM cron.schedule(
      'notification-email-queue-ttl',
      '15 3 * * *',
      $job$
      DELETE FROM public.notification_email_queue
      WHERE created_at < now() - interval '7 days'
        AND status IN ('sent','skipped','failed');
      $job$
    );
  END IF;
END $$;

COMMIT;

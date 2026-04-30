/**
 * sendPushNotifications
 *
 * Triggered by an AFTER INSERT trigger on the notifications table (one POST
 * per fallback-eligible notification with body { notificationId }). For the
 * given notification:
 *   1. Hydrate notification + recipient + recipient's push subscriptions
 *   2. Skip if recipient turned push_enabled off in their preferences
 *   3. For each subscription: sign a VAPID JWT (ES256), encrypt payload via
 *      RFC 8291 (aes128gcm), POST to the endpoint URL
 *   4. On 404/410 from the endpoint: delete the subscription (browser
 *      revoked it) so we don't keep retrying dead endpoints
 *
 * Required env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 * Optional env: NOTIFICATION_APP_URL (default https://flexstudios.app)
 *
 * Push delivery is realtime (no defer), unlike email. Push is a redundant
 * channel — bell is already delivered via Supabase realtime. If push fails,
 * the user still has bell + email fallback.
 */

import { getAdminClient, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import webpush from 'https://esm.sh/web-push@3.6.7';

// Default-on type set. Must stay in sync with public._notif_push_default_on
// in migration 367_notification_push_email_full_coverage.sql and the
// PUSH_DEFAULT_ON set in flexmedia-src/src/pages/SettingsNotifications.jsx.
const PUSH_DEFAULT_ON = new Set([
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
]);
const APP_URL = (Deno.env.get('NOTIFICATION_APP_URL') || 'https://flexstudios.app').replace(/\/+$/, '');

const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  || '';
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') || '';
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')     || 'mailto:notifications@flexstudios.app';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  category: string | null;
  title: string;
  message: string | null;
  cta_url: string | null;
  cta_params: string | null;
}

interface PushSubRow {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number | null;
}

function buildClickUrl(n: NotificationRow): string {
  if (!n.cta_url) return APP_URL;
  let id: string | null = null;
  if (n.cta_params) {
    try { id = JSON.parse(n.cta_params)?.id || null; } catch { /* ignore */ }
  }
  const page = n.cta_url.replace(/^\/+/, '');
  return `${APP_URL}/${page}${id ? `?id=${encodeURIComponent(id)}` : ''}`;
}

function buildPayload(n: NotificationRow) {
  return JSON.stringify({
    title: n.title || 'FlexStudios',
    body:  n.message || '',
    url:   buildClickUrl(n),
    notificationId: n.id,
    // Tag dedupes the OS notification: a follow-up push for the same target
    // replaces the prior banner instead of stacking.
    tag: `notif:${n.id}`,
  });
}

serveWithAudit('sendPushNotifications', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return errorResponse('VAPID keys not configured', 500);
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405);

  let body: { notificationId?: string };
  try { body = await req.json(); } catch { return errorResponse('Invalid JSON body', 400); }
  const notificationId = body?.notificationId;
  if (!notificationId) return errorResponse('notificationId required', 400);

  const admin = getAdminClient();

  // 1. Hydrate the notification.
  const { data: notif, error: nErr } = await admin
    .from('notifications')
    .select('id, user_id, type, category, title, message, cta_url, cta_params')
    .eq('id', notificationId)
    .single();
  if (nErr || !notif) return errorResponse(`notification not found: ${nErr?.message || notificationId}`, 404);

  if (!(notif as NotificationRow).user_id) {
    return jsonResponse({ ok: true, skipped: 'no_user_id' });
  }

  // 2. Resolve effective preference for this user × this type.
  // Trigger has already gated by default-ON ∪ explicit-ON, so we only
  // re-check here to honour an explicit OFF override that landed in the
  // window between trigger and send.
  const n = notif as NotificationRow & { category?: string };
  const { data: prefs = [] } = await admin
    .from('notification_preferences')
    .select('notification_type, category, push_enabled')
    .eq('user_id', n.user_id);

  const typePref = (prefs as any[]).find(p => p.notification_type === n.type);
  const catPref  = (prefs as any[]).find(p => p.category && p.category === (n as any).category && (!p.notification_type || p.notification_type === '*'));
  let allowed: boolean;
  if (typePref?.push_enabled === true || typePref?.push_enabled === false) allowed = typePref.push_enabled;
  else if (catPref?.push_enabled === true || catPref?.push_enabled === false) allowed = catPref.push_enabled;
  else allowed = PUSH_DEFAULT_ON.has(n.type);
  if (!allowed) return jsonResponse({ ok: true, skipped: 'pref_disabled' });

  // 3. Pull the user's subscriptions.
  const { data: subs = [] } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth, failure_count')
    .eq('user_id', (notif as NotificationRow).user_id);

  if (!subs || subs.length === 0) {
    return jsonResponse({ ok: true, sent: 0, reason: 'no_subscriptions' });
  }

  const payload = buildPayload(notif as NotificationRow);

  let sent = 0;
  let removed = 0;
  let failed = 0;

  await Promise.all((subs as PushSubRow[]).map(async (s) => {
    const subscription = {
      endpoint: s.endpoint,
      keys: { p256dh: s.p256dh, auth: s.auth },
    };
    try {
      await webpush.sendNotification(subscription, payload, { TTL: 60 });
      // Stamp last_used_at; reset failure_count on success.
      await admin.from('push_subscriptions').update({
        last_used_at: new Date().toISOString(),
        failure_count: 0,
        last_error: null,
      }).eq('id', s.id);
      sent++;
    } catch (err: any) {
      const status = err?.statusCode || err?.status || 0;
      // 404/410 = the push service has permanently revoked this subscription.
      // Delete the row so we never try again.
      if (status === 404 || status === 410) {
        await admin.from('push_subscriptions').delete().eq('id', s.id);
        removed++;
      } else {
        failed++;
        await admin.from('push_subscriptions').update({
          failure_count: (s.failure_count ?? 0) + 1,
          last_error: (err?.body || err?.message || 'unknown').toString().slice(0, 500),
        }).eq('id', s.id);
      }
    }
  }));

  return jsonResponse({ ok: true, sent, removed, failed, total: subs.length });
});

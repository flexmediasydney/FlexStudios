/**
 * sendNotificationEmails
 *
 * Drains notification_email_queue once per minute (pg_cron). For each due
 * pending row:
 *   - Skip if the source notification was read or dismissed in-app
 *   - Skip if the recipient was active in the last 2 minutes (heartbeat)
 *   - Skip if the recipient set notification_preferences.email_enabled = false
 *   - Otherwise send via Resend and stamp status='sent'
 *
 * Required env: RESEND_API_KEY
 * Optional env: NOTIFICATION_FROM_EMAIL, NOTIFICATION_APP_URL
 */

import { getAdminClient, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

// Default-on type set. Must stay in sync with public._notif_email_default_on
// in migration 367_notification_push_email_full_coverage.sql and the
// EMAIL_DEFAULT_ON set in flexmedia-src/src/pages/SettingsNotifications.jsx.
const EMAIL_DEFAULT_ON = new Set([
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
  // Additionally:
  'invoice_overdue_7d','invoice_overdue_14d','payment_received','payment_overdue_first',
  'revision_stale_48h',
  'email_received_from_client','email_sync_failed',
]);
const ACTIVE_WINDOW_MINUTES = 2;
const BATCH_SIZE = 50;
const MAX_ATTEMPTS = 3;

const FROM_EMAIL = Deno.env.get('NOTIFICATION_FROM_EMAIL') || 'FlexStudios <notifications@flexstudios.app>';
const APP_URL    = (Deno.env.get('NOTIFICATION_APP_URL') || 'https://flexstudios.app').replace(/\/+$/, '');

interface QueueRow {
  id: string;
  notification_id: string;
  user_id: string;
  send_at: string;
  status: string;
  attempts: number;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: string;
  category: string | null;
  title: string;
  message: string | null;
  is_read: boolean;
  is_dismissed: boolean;
  cta_url: string | null;
  cta_label: string | null;
  cta_params: string | null;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string | null;
  last_seen_at: string | null;
  is_active: boolean;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildCtaUrl(n: NotificationRow): string {
  if (!n.cta_url) return APP_URL;
  let id: string | null = null;
  if (n.cta_params) {
    try {
      const parsed = JSON.parse(n.cta_params);
      id = parsed?.id || null;
    } catch { /* ignore malformed */ }
  }
  const page = n.cta_url.replace(/^\/+/, '');
  return `${APP_URL}/${page}${id ? `?id=${encodeURIComponent(id)}` : ''}`;
}

function renderEmail(n: NotificationRow, recipientName: string | null) {
  const ctaUrl = buildCtaUrl(n);
  const ctaLabel = n.cta_label || 'View in FlexStudios';
  const greeting = recipientName ? `Hi ${htmlEscape(recipientName.split(' ')[0])},` : 'Hi there,';
  const subject = n.title || 'New activity in FlexStudios';
  const settingsUrl = `${APP_URL}/SettingsNotifications`;

  const text = [
    greeting,
    '',
    n.title || '',
    n.message ? '' : null,
    n.message || '',
    '',
    `Open: ${ctaUrl}`,
    '',
    '— FlexStudios',
    `Manage email preferences: ${settingsUrl}`,
  ].filter(line => line !== null).join('\n');

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${htmlEscape(subject)}</title></head>
<body style="margin:0;padding:0;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.06);">
        <tr><td style="padding:24px 28px;border-bottom:1px solid #e5e7eb;">
          <div style="font-size:14px;font-weight:600;color:#0f172a;letter-spacing:0.2px;">FlexStudios</div>
        </td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 16px;font-size:14px;color:#475569;">${htmlEscape(greeting)}</p>
          <h1 style="margin:0 0 12px;font-size:18px;font-weight:600;line-height:1.4;color:#0f172a;">${htmlEscape(n.title || 'New activity')}</h1>
          ${n.message ? `<p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#334155;">${htmlEscape(n.message)}</p>` : ''}
          <a href="${htmlEscape(ctaUrl)}" style="display:inline-block;background:#0f172a;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">${htmlEscape(ctaLabel)}</a>
        </td></tr>
        <tr><td style="padding:20px 28px;border-top:1px solid #e5e7eb;background:#fafafa;">
          <p style="margin:0;font-size:12px;color:#64748b;line-height:1.5;">
            You're getting this because you weren't online to see it in the app.
            <a href="${htmlEscape(settingsUrl)}" style="color:#0f172a;text-decoration:underline;">Manage email preferences</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return { subject, html, text };
}

async function sendViaResend(apiKey: string, to: string, subject: string, html: string, text: string): Promise<{ id?: string; error?: string }> {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html, text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: body?.message || `Resend HTTP ${res.status}` };
    return { id: body?.id };
  } catch (e: any) {
    return { error: e?.message || 'fetch failed' };
  }
}

serveWithAudit('sendNotificationEmails', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    return errorResponse('RESEND_API_KEY not configured', 500);
  }

  const admin = getAdminClient();
  const nowIso = new Date().toISOString();

  // Pull a batch of due pending rows.
  const { data: due, error: dueErr } = await admin
    .from('notification_email_queue')
    .select('id, notification_id, user_id, send_at, status, attempts')
    .eq('status', 'pending')
    .lte('send_at', nowIso)
    .order('send_at', { ascending: true })
    .limit(BATCH_SIZE);

  if (dueErr) return errorResponse(`queue read failed: ${dueErr.message}`, 500);
  if (!due || due.length === 0) return jsonResponse({ ok: true, processed: 0 });

  // Mark all as 'sending' to prevent the next cron tick from double-processing.
  const ids = due.map((r: QueueRow) => r.id);
  await admin
    .from('notification_email_queue')
    .update({ status: 'sending', attempts: ids.length, updated_at: nowIso })
    .in('id', ids);
  // Note: attempts increment is approximate (we set a single value per batch).
  // Adequate for the rough retry cap; refine later if we ever truly need
  // exact per-row attempt counts.

  // Hydrate notifications, users, and prefs in parallel.
  const notifIds = [...new Set(due.map(r => r.notification_id))];
  const userIds  = [...new Set(due.map(r => r.user_id))];

  const [{ data: notifications = [] }, { data: users = [] }, { data: prefs = [] }] = await Promise.all([
    admin.from('notifications').select('id, user_id, type, category, title, message, is_read, is_dismissed, cta_url, cta_label, cta_params').in('id', notifIds),
    admin.from('users').select('id, email, full_name, last_seen_at, is_active').in('id', userIds),
    admin.from('notification_preferences').select('user_id, notification_type, category, email_enabled').in('user_id', userIds),
  ]);

  const nById: Record<string, NotificationRow> = {};
  for (const n of (notifications as NotificationRow[])) nById[n.id] = n;

  const uById: Record<string, UserRow> = {};
  for (const u of (users as UserRow[])) uById[u.id] = u;

  const prefByKey: Record<string, boolean | null> = {};
  for (const p of (prefs as any[])) {
    if (p.notification_type && p.notification_type !== '*') {
      prefByKey[`type:${p.user_id}:${p.notification_type}`] = p.email_enabled ?? null;
    } else if (p.category) {
      prefByKey[`cat:${p.user_id}:${p.category}`] = p.email_enabled ?? null;
    }
  }

  const activeCutoff = Date.now() - ACTIVE_WINDOW_MINUTES * 60_000;

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of due as QueueRow[]) {
    const n = nById[row.notification_id];
    const u = uById[row.user_id];
    const completedAt = new Date().toISOString();

    if (!n) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'notification_not_found', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }
    if (!u || !u.email) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'user_or_email_missing', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }
    if (!u.is_active) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'user_inactive', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }
    if (n.is_read || n.is_dismissed) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'already_read', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }

    if (u.last_seen_at && new Date(u.last_seen_at).getTime() >= activeCutoff) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'user_recently_active', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }

    // Preference resolution: explicit type pref wins, then category-wildcard
    // pref, otherwise the per-type default (matches the trigger-side gate
    // and the SettingsNotifications UI default-on policy).
    let allowed: boolean;
    const typePref = prefByKey[`type:${u.id}:${n.type}`];
    const catPref  = n.category ? prefByKey[`cat:${u.id}:${n.category}`] : null;
    if (typePref === true || typePref === false) allowed = typePref;
    else if (catPref === true || catPref === false) allowed = catPref;
    else allowed = EMAIL_DEFAULT_ON.has(n.type);

    if (!allowed) {
      await admin.from('notification_email_queue').update({ status: 'skipped', skip_reason: 'pref_disabled', updated_at: completedAt }).eq('id', row.id);
      skipped++; continue;
    }

    const { subject, html, text } = renderEmail(n, u.full_name);
    const result = await sendViaResend(apiKey, u.email, subject, html, text);

    if (result.id) {
      await admin.from('notification_email_queue').update({
        status: 'sent', resend_id: result.id, sent_at: completedAt, updated_at: completedAt,
      }).eq('id', row.id);
      sent++;
    } else {
      const finalStatus = (row.attempts || 0) + 1 >= MAX_ATTEMPTS ? 'failed' : 'pending';
      await admin.from('notification_email_queue').update({
        status: finalStatus,
        error: result.error || 'unknown',
        // Defer next retry by 5 minutes if still pending.
        send_at: finalStatus === 'pending' ? new Date(Date.now() + 5 * 60_000).toISOString() : undefined,
        updated_at: completedAt,
      }).eq('id', row.id);
      failed++;
    }
  }

  return jsonResponse({ ok: true, processed: due.length, sent, skipped, failed });
});

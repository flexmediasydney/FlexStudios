/**
 * extendEmailHistory
 *
 * Pulls OLDER Gmail messages than currently stored, for a specified account.
 * Safe to re-invoke — it resumes where it left off using the oldest stored
 * received_at as the upper bound (or an explicit `beforeTimestamp`).
 *
 * Rate-aware: respects the 30-day default window per invocation. Each call
 * fetches up to `days` days of history ending just before the oldest stored
 * message. Persists `history_extension_cursor` on the account so repeated
 * calls continue walking backwards until `sync_start_date` is reached.
 *
 * Auth: master_admin or service-role.
 *
 * Body: {
 *   emailAccountId: string (required)
 *   days?: number (default 30, max 90 per call)
 *   beforeTimestamp?: string (ISO date; explicit upper bound)
 * }
 */

import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { AgentLookup } from '../_shared/emailLinking.ts';

const MS_PER_DAY = 86_400_000;
const BATCH_SIZE = 10;
const WALL_BUDGET_MS = 55_000;
const GMAIL_DELAY = 100;
const MAX_MESSAGES_PER_CALL = 500;
const MAX_BODY_SIZE = 10000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${data.error || 'unknown'}`);
  return { access_token: data.access_token, refresh_token: data.refresh_token as string | undefined };
}

function decodeBase64Url(s: string) {
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch { return ''; }
}

function extractBody(payload: any): string {
  const walk = (p: any): { html: string; text: string } => {
    if (!p) return { html: '', text: '' };
    if (p.mimeType === 'text/html' && p.body?.data) return { html: decodeBase64Url(p.body.data), text: '' };
    if (p.mimeType === 'text/plain' && p.body?.data) return { html: '', text: decodeBase64Url(p.body.data) };
    if (p.parts?.length) {
      let html = '', text = '';
      for (const c of p.parts) {
        const r = walk(c);
        if (r.html) html = r.html;
        if (r.text) text = r.text;
      }
      return { html, text };
    }
    return { html: '', text: '' };
  };
  const { html, text } = walk(payload);
  if (html) return html;
  if (text) return `<pre style="white-space:pre-wrap;font-family:inherit;font-size:inherit">${text.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>`;
  return '';
}

function extractAttachments(payload: any) {
  const out: any[] = [];
  const walk = (p: any) => {
    if (!p) return;
    if (p.filename && p.body?.attachmentId) {
      out.push({ filename: p.filename, mime_type: p.mimeType, size: p.size || 0, attachment_id: p.body.attachmentId });
    }
    if (p.parts) for (const c of p.parts) walk(c);
  };
  walk(payload);
  return out;
}

function parseHeaders(headers: any[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers) { if (h?.name) out[h.name] = h.value ?? ''; }
  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(out)) lower.set(k.toLowerCase(), v);
  return new Proxy(out, {
    get(t, p: string) {
      if (typeof p === 'string') return lower.get(p.toLowerCase()) ?? t[p];
      return t[p as any];
    },
  });
}

serveWithAudit('extendEmailHistory', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth: master_admin user or service-role
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
      if (user.role !== 'master_admin') {
        return errorResponse('Forbidden: Master admin access required', 403);
      }
    }

    let body: any = {};
    try { body = await req.json(); } catch { body = {}; }
    const emailAccountId = body.emailAccountId;
    if (!emailAccountId) return errorResponse('emailAccountId required', 400);
    const days = Math.max(1, Math.min(90, Number(body.days) || 30));

    const { data: account } = await admin
      .from('email_accounts')
      .select('*')
      .eq('id', emailAccountId)
      .single();
    if (!account) return errorResponse('Account not found', 404);
    if (!account.refresh_token) return errorResponse('No refresh token — reconnect Gmail', 400);

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) throw new Error('Google OAuth secrets missing');

    // Figure out the upper bound: the oldest email we currently have, or beforeTimestamp param
    let beforeDate: Date;
    if (body.beforeTimestamp) {
      beforeDate = new Date(body.beforeTimestamp);
    } else {
      const { data: oldest } = await admin
        .from('email_messages')
        .select('received_at')
        .eq('email_account_id', emailAccountId)
        .order('received_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      beforeDate = oldest?.received_at ? new Date(oldest.received_at) : new Date();
    }

    // Clamp to sync_start_date lower bound if set
    const syncStartLower = account.sync_start_date ? new Date(account.sync_start_date) : null;
    const windowStart = new Date(beforeDate.getTime() - days * MS_PER_DAY);
    const effectiveStart = syncStartLower && windowStart < syncStartLower ? syncStartLower : windowStart;
    if (syncStartLower && beforeDate <= syncStartLower) {
      return jsonResponse({ success: true, note: 'Already at or past sync_start_date; nothing to extend', synced: 0 });
    }

    const beforeTs = Math.floor(beforeDate.getTime() / 1000);
    const afterTs = Math.floor(effectiveStart.getTime() / 1000);
    const query = `after:${afterTs} before:${beforeTs}`;

    // Refresh token
    const tok = await refreshAccessToken(clientId, clientSecret, account.refresh_token);
    await admin.from('email_accounts').update({
      access_token: tok.access_token,
      ...(tok.refresh_token ? { refresh_token: tok.refresh_token } : {}),
    }).eq('id', emailAccountId);

    // Build lookup
    const { data: allAccts } = await admin.from('email_accounts').select('email_address');
    const own = new Set<string>((allAccts || []).map((a: any) => (a.email_address || '').toLowerCase()).filter(Boolean));
    const lookup = new AgentLookup(admin, own);
    await lookup.preloadAgents();
    await lookup.preloadDomains();

    // List message IDs matching query
    const start = Date.now();
    const ids: any[] = [];
    let pageToken: string | null = null;
    do {
      if (Date.now() - start > WALL_BUDGET_MS - 5000) break;
      const u = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
      u.searchParams.append('q', query);
      u.searchParams.append('maxResults', '100');
      if (pageToken) u.searchParams.append('pageToken', pageToken);
      const r = await fetch(u.toString(), { headers: { Authorization: `Bearer ${tok.access_token}` } });
      if (!r.ok) throw new Error(`Gmail list error: ${r.status}`);
      const d = await r.json();
      (d.messages || []).forEach((m: any) => ids.push(m));
      pageToken = d.nextPageToken || null;
      if (ids.length >= MAX_MESSAGES_PER_CALL) break;
    } while (pageToken);

    // Fetch + save each
    let synced = 0, skipped = 0, failed = 0, matched = 0;
    for (let i = 0; i < ids.length; i++) {
      if (Date.now() - start > WALL_BUDGET_MS) break;
      const m = ids[i];
      // Skip if already stored
      const { data: existing } = await admin
        .from('email_messages')
        .select('id')
        .eq('email_account_id', account.id)
        .eq('gmail_message_id', m.id)
        .limit(1)
        .maybeSingle();
      if (existing) { skipped++; continue; }

      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${tok.access_token}` } },
      );
      if (!msgRes.ok) { failed++; continue; }
      const msg = await msgRes.json();
      const headers = parseHeaders(msg.payload?.headers || []);

      const toList = (headers['To'] || '').split(/,(?![^<]*>)/).filter(Boolean).map((e: string) => e.trim());
      const ccList = (headers['Cc'] || '').split(/,(?![^<]*>)/).filter(Boolean).map((e: string) => e.trim());
      const link = await lookup.resolve({ from: headers['From'], to: toList, cc: ccList });
      if (link.agent_id || link.agency_id) matched++;

      let rawBody = extractBody(msg.payload);
      if (rawBody.length > MAX_BODY_SIZE) {
        rawBody = rawBody.substring(0, MAX_BODY_SIZE) + '\n\n<div style="margin-top:20px;padding:12px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;color:#856404;"><strong>Email Truncated</strong><br/>Historical backfill — view in Gmail for full message.</div>';
      }

      try {
        await entities.EmailMessage.create({
          email_account_id: account.id,
          gmail_message_id: msg.id,
          gmail_thread_id: msg.threadId,
          from: headers['From'] || 'unknown@unknown.com',
          from_name: headers['From']?.split('<')[0].trim() || 'Unknown',
          to: toList,
          cc: ccList,
          subject: headers['Subject'] || '(no subject)',
          body: rawBody,
          is_unread: msg.labelIds?.includes('UNREAD') || false,
          is_starred: msg.labelIds?.includes('STARRED') || false,
          is_draft: msg.labelIds?.includes('DRAFT') || false,
          is_sent: msg.labelIds?.includes('SENT') || false,
          attachments: extractAttachments(msg.payload),
          received_at: (() => {
            const ts = parseInt(msg.internalDate);
            return isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString();
          })(),
          visibility: 'private',
          ...(link.agent_id || link.agency_id ? {
            agent_id: link.agent_id,
            agent_name: link.agent_name,
            agency_id: link.agency_id,
            agency_name: link.agency_name,
          } : {}),
        });
        synced++;
      } catch (err: any) {
        console.error('Insert failed', msg.id, err?.message);
        failed++;
      }
      await sleep(GMAIL_DELAY);
    }

    // Update counters
    await admin.from('email_accounts').update({
      total_synced_count: (account.total_synced_count || 0) + synced,
    }).eq('id', emailAccountId);

    return jsonResponse({
      success: true,
      emailAccountId,
      window: { after: effectiveStart.toISOString(), before: beforeDate.toISOString(), days },
      totalFound: ids.length,
      synced,
      skipped,
      failed,
      matched,
      durationMs: Date.now() - start,
      reachedStartDate: effectiveStart.getTime() === syncStartLower?.getTime(),
    });
  } catch (err: any) {
    console.error('extendEmailHistory error', err);
    return errorResponse(err?.message || 'Extend failed', 500);
  }
});

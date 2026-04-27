/**
 * shortlisting-debug-mint-dropbox-token
 * ──────────────────────────────────────
 * Returns a fresh Dropbox access token via the refresh flow.
 *
 * Used as a manual unblock when Modal's static DROPBOX_ACCESS_TOKEN secret
 * has expired. After getting the value, set it via:
 *   modal secret create dropbox_access_token DROPBOX_ACCESS_TOKEN=<value>
 *
 * Service-role only.
 *
 * Long-term fix: Modal worker should accept access_token as a request-body
 * field, populated by the calling edge function (which auto-refreshes).
 * That eliminates the static-secret expiry problem entirely.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'shortlisting-debug-mint-dropbox-token';
const DROPBOX_OAUTH = 'https://api.dropboxapi.com/oauth2/token';

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const auth = req.headers.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return errorResponse('service-role only (no bearer token)', 401, req);
  try {
    const payload = JSON.parse(atob(m[1].split('.')[1]));
    if (payload?.role !== 'service_role') {
      return errorResponse(`service-role only (role=${payload?.role})`, 401, req);
    }
  } catch (err) {
    return errorResponse(
      `service-role only (decode failed: ${err instanceof Error ? err.message : err})`,
      401,
      req,
    );
  }

  let body: { _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    /* noop */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  const refreshToken = Deno.env.get('DROPBOX_REFRESH_TOKEN');
  const appKey = Deno.env.get('DROPBOX_APP_KEY');
  const appSecret = Deno.env.get('DROPBOX_APP_SECRET');

  if (!refreshToken || !appKey || !appSecret) {
    return errorResponse(
      'Missing one of DROPBOX_REFRESH_TOKEN / DROPBOX_APP_KEY / DROPBOX_APP_SECRET in edge env',
      500,
      req,
    );
  }

  const auth64 = btoa(`${appKey}:${appSecret}`);
  const res = await fetch(DROPBOX_OAUTH, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth64}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${refreshToken}`,
  });
  if (!res.ok) {
    const txt = await res.text();
    return errorResponse(`Dropbox token refresh failed: ${res.status} ${txt}`, 500, req);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };

  return jsonResponse(
    {
      ok: true,
      access_token: data.access_token,
      expires_in_seconds: data.expires_in,
      note: 'Set this on Modal via: modal secret create dropbox_access_token DROPBOX_ACCESS_TOKEN=<value>',
    },
    200,
    req,
  );
});

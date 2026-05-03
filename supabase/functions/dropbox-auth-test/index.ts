/**
 * dropbox-auth-test — one-shot debug endpoint for Modal hang diagnosis.
 *
 * Tests two things and returns both verdicts as JSON:
 *   1. CAN we mint a fresh Dropbox access token via the OAuth refresh
 *      flow? (i.e. getDropboxAccessToken({forceRefresh: true}))
 *   2. CAN we actually call Dropbox API with the minted token?
 *      (calls /users/get_current_account)
 *
 * Auth: any service-role JWT — same as dispatcher invocations.
 *
 * Why this exists: Modal photos-extract has been hanging on Dropbox calls
 * (8 ThreadPoolExecutor workers stuck for 900s), but I can't tell from
 * the outside whether the cause is Supabase-side (refresh failing → empty
 * token sent → Modal falls to dead env-secret) or Modal-side (network /
 * SDK regression). This endpoint isolates the Supabase-side question
 * cleanly so we know which half to fix.
 */
import { getDropboxAccessToken } from '../_shared/dropbox.ts';

/**
 * Probe a single Dropbox API endpoint and return a verdict object.
 * Hits a per-bucket rate limit when applicable — Dropbox tracks /users,
 * /files, /sharing, etc. separately, so a 429 on one doesn't mean the
 * others are unavailable.
 */
async function probeDropbox(
  token: string,
  endpoint: string,
  bodyArg: unknown,
): Promise<Record<string, unknown>> {
  const t = Date.now();
  try {
    const resp = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        ...(bodyArg !== null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: bodyArg !== null ? JSON.stringify(bodyArg) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    const out: Record<string, unknown> = {
      endpoint,
      status: resp.status,
      wall_ms: Date.now() - t,
    };
    if (!resp.ok) {
      out.ok = false;
      out.body = text.slice(0, 300);
      // Dropbox 429 carries `retry_after` in the body
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.retry_after !== undefined) {
          out.retry_after_s = parsed.error.retry_after;
        }
      } catch { /* ignore */ }
    } else {
      out.ok = true;
    }
    return out;
  } catch (err) {
    return {
      endpoint,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      wall_ms: Date.now() - t,
    };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST' && req.method !== 'GET') {
    return new Response(JSON.stringify({ ok: false, error: 'method' }), { status: 405 });
  }

  const t0 = Date.now();
  const result: Record<string, unknown> = {
    ok: false,
    started_at: new Date().toISOString(),
  };

  // Step 1 — refresh flow
  let token = '';
  try {
    token = await getDropboxAccessToken({ forceRefresh: true });
    result.refresh_ok = true;
    result.refresh_token_length = token.length;
    result.refresh_token_first6 = token.slice(0, 6);
    result.refresh_wall_ms = Date.now() - t0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.refresh_ok = false;
    result.refresh_error = msg;
    result.refresh_wall_ms = Date.now() - t0;
    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 2 — probe the /users API bucket (cheap call, identity check)
  result.users = await probeDropbox(token, 'users/get_current_account', null);

  // Step 3 — probe the /files API bucket (this is the bucket that actually
  // matters for shortlisting-ingest, which calls /files/list_folder to
  // enumerate the project's photo folder; files API has its OWN per-app
  // rate limit, separate from users API).
  // We list the root folder with limit:1 — minimal payload, just enough to
  // exercise the rate-limit bucket.
  result.files = await probeDropbox(token, 'files/list_folder', {
    path: '',
    limit: 1,
    recursive: false,
  });

  result.ok = (result.refresh_ok === true)
    && (result as { users?: { ok?: boolean } }).users?.ok === true
    && (result as { files?: { ok?: boolean } }).files?.ok === true;
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

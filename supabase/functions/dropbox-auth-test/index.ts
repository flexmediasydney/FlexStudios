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

  // Step 2 — does the minted token actually work against Dropbox API?
  const t1 = Date.now();
  try {
    const resp = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        // get_current_account takes no arguments. Dropbox is picky:
        // omit Content-Type entirely OR send `null` body — both work.
      },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await resp.text();
    result.api_status = resp.status;
    result.api_wall_ms = Date.now() - t1;
    if (!resp.ok) {
      result.api_ok = false;
      result.api_body = text.slice(0, 400);
    } else {
      try {
        const body = JSON.parse(text);
        result.api_ok = true;
        // Just surface the public-facing identity, not the entire account
        result.api_account_id = body.account_id;
        result.api_email = body.email;
        result.api_name = body.name?.display_name;
      } catch {
        result.api_ok = false;
        result.api_body = text.slice(0, 400);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result.api_ok = false;
    result.api_error = msg;
    result.api_wall_ms = Date.now() - t1;
  }

  result.ok = (result.refresh_ok === true) && (result.api_ok === true);
  return new Response(JSON.stringify(result, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

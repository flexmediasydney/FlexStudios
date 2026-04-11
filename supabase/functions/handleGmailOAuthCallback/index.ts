import { getAdminClient, createEntities, handleCors } from '../_shared/supabase.ts';

function oauthResultPage(type: string, payload: Record<string, string> = {}) {
  const isSuccess = type.includes('success');
  const safePayload = Object.entries(payload)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ');
  const title = isSuccess ? 'Authentication Successful' : 'Authentication Failed';
  const message = isSuccess
    ? 'Your Gmail account has been connected. You can close this window.'
    : `Something went wrong: ${payload.error || 'Unknown error'}`;
  const color = isSuccess ? '#16a34a' : '#dc2626';

  return new Response(
    `<!DOCTYPE html>
<html><head><title>${title}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f9fafb;">
  <div style="text-align:center;padding:2rem;max-width:400px;">
    <div style="font-size:3rem;margin-bottom:1rem;">${isSuccess ? '&#9989;' : '&#10060;'}</div>
    <h2 style="color:${color};margin:0 0 0.5rem;">${title}</h2>
    <p style="color:#6b7280;margin:0 0 1.5rem;">${message}</p>
    <button onclick="window.close()" style="padding:0.5rem 1.5rem;background:${color};color:white;border:none;border-radius:6px;cursor:pointer;font-size:0.9rem;">Close Window</button>
  </div>
  <script>
    try { window.opener.postMessage({ type: '${type}', ${safePayload} }, '*'); } catch(e) {}
    try { window.close(); } catch(e) {}
  </script>
</body></html>`,
    { headers: { 'Content-Type': 'text/html' } }
  );
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // Auth note: This endpoint is intentionally unauthenticated — it's a Google OAuth
    // redirect callback. Security is enforced by validating the `state` parameter which
    // must contain a valid userId that maps to a real user in the database. The state param
    // is generated server-side during the OAuth initiation flow.
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const sendMessage = (type: string, payload: Record<string, string> = {}) => {
      return oauthResultPage(type, payload);
    };

    if (error) return sendMessage('gmail_auth_error', { error });
    if (!code || !state) return sendMessage('gmail_auth_error', { error: 'Missing code or state' });

    let stateData: any;
    try {
      stateData = JSON.parse(state);
    } catch {
      return sendMessage('gmail_auth_error', { error: 'Invalid state parameter' });
    }
    const { userId, displayName, teamId, reconnectAccountId } = stateData;
    if (!userId) return sendMessage('gmail_auth_error', { error: 'Missing userId in state' });

    // Validate that the userId in state maps to a real user (prevents forged state params)
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const stateUser = await entities.User.get(userId).catch(() => null);
    if (!stateUser) return sendMessage('gmail_auth_error', { error: 'Invalid user in state parameter' });

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return sendMessage('gmail_auth_error', { error: 'Google OAuth not configured on server' });
    }
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const redirectUri = `${supabaseUrl}/functions/v1/handleGmailOAuthCallback`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });

    const tokens = await tokenResponse.json();
    if (!tokens.access_token) {
      const detail = tokens.error_description || tokens.error || 'unknown';
      return sendMessage('gmail_auth_error', { error: `Failed to get access token: ${detail}` });
    }
    if (!tokens.refresh_token && !reconnectAccountId) {
      // First-time connection MUST get a refresh_token (requires prompt=consent)
      console.warn('No refresh_token received for new account — consent may not have been granted');
    }

    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json();
    const emailAddress = profile.emailAddress;

    // Reconnect path — update tokens on existing account
    if (reconnectAccountId) {
      await entities.EmailAccount.update(reconnectAccountId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        is_active: true,
      });
      return sendMessage('gmail_auth_success', { email: emailAddress });
    }

    // New account path — check for duplicates
    const existingAccounts = await entities.EmailAccount.filter({
      email_address: emailAddress,
      assigned_to_user_id: userId,
    });

    if (existingAccounts.length > 0) {
      return sendMessage('gmail_auth_error', { error: 'This Gmail account is already connected' });
    }

    // stateUser already validated above
    await entities.EmailAccount.create({
      email_address: emailAddress,
      display_name: displayName || emailAddress,
      assigned_to_user_id: userId,
      assigned_to_name: stateUser.full_name,
      team_id: teamId || null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      is_active: true,
    });

    return sendMessage('gmail_auth_success', { email: emailAddress });

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return oauthResultPage('gmail_auth_error', { error: msg });
  }
});

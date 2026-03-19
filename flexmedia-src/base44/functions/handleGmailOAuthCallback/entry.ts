import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    const sendMessage = (type: string, payload: Record<string, string> = {}) => {
      const attrs = Object.entries(payload)
        .map(([k, v]) => `${k}: '${v.replace(/'/g, "\\'")}'`)
        .join(', ');
      return new Response(
        `<html><body><script>
          window.opener?.postMessage({ type: '${type}', ${attrs} }, '*');
          window.close();
        </script></body></html>`,
        { headers: { 'Content-Type': 'text/html' } }
      );
    };

    if (error) return sendMessage('gmail_auth_error', { error });
    if (!code || !state) return sendMessage('gmail_auth_error', { error: 'Missing code or state' });

    const stateData = JSON.parse(state);
    const { userId, displayName, teamId, reconnectAccountId } = stateData;

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const appUrl = Deno.env.get('BASE44_APP_URL') || 'http://localhost:3000';
    const redirectUri = `${appUrl}/api/functions/handleGmailOAuthCallback`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
    });

    const tokens = await tokenResponse.json();
    if (!tokens.access_token) {
      return sendMessage('gmail_auth_error', { error: 'Failed to get access token' });
    }

    const profileResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` },
    });
    const profile = await profileResponse.json();
    const emailAddress = profile.emailAddress;

    const base44 = createClientFromRequest(req);

    // FIX 16: reconnect path — update tokens on existing account
    if (reconnectAccountId) {
      await base44.asServiceRole.entities.EmailAccount.update(reconnectAccountId, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || undefined,
        is_active: true,
      });
      return sendMessage('gmail_auth_success', { email: emailAddress });
    }

    // New account path — check for duplicates
    const existingAccounts = await base44.asServiceRole.entities.EmailAccount.filter({
      email_address: emailAddress,
      assigned_to_user_id: userId,
    });

    if (existingAccounts.length > 0) {
      return sendMessage('gmail_auth_error', { error: 'This Gmail account is already connected' });
    }

    const user = await base44.asServiceRole.entities.User.get(userId);

    await base44.asServiceRole.entities.EmailAccount.create({
      email_address: emailAddress,
      display_name: displayName || emailAddress,
      assigned_to_user_id: userId,
      assigned_to_name: user.full_name,
      team_id: teamId || null,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      is_active: true,
      last_sync: new Date().toISOString(),
    });

    return sendMessage('gmail_auth_success', { email: emailAddress });

  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      `<html><body><script>
        window.opener?.postMessage({ type: 'gmail_auth_error', error: '${msg.replace(/'/g, "\\'")}' }, '*');
        window.close();
      </script></body></html>`,
      { headers: { 'Content-Type': 'text/html' } }
    );
  }
});
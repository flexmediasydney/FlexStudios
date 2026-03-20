import { getAdminClient, createEntities, handleCors, corsHeaders } from '../_shared/supabase.ts';

function oauthResultPage(type: string, payload: Record<string, string> = {}) {
  const isSuccess = type.includes('success');
  const safePayload = Object.entries(payload)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ');
  const title = isSuccess ? 'Authentication Successful' : 'Authentication Failed';
  const message = isSuccess
    ? 'Your Google Calendar has been connected. You can close this window.'
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
    try { window.opener.postMessage({ type: '${type}', ${safePayload} }, '${Deno.env.get('SITE_URL') || 'https://flexstudios.app'}'); } catch(e) {}
    try { window.close(); } catch(e) {}
  </script>
</body></html>`,
    { headers: { ...corsHeaders, 'Content-Type': 'text/html' } }
  );
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return oauthResultPage('calendar_auth_error', { error });
    }

    if (!code || !state) {
      return oauthResultPage('calendar_auth_error', { error: 'Missing authorization code or state' });
    }

    let stateData: any;
    try {
      stateData = JSON.parse(state);
    } catch {
      return oauthResultPage('calendar_auth_error', { error: 'Invalid state parameter. Please try connecting your calendar again.' });
    }
    const { userId } = stateData;
    if (!userId) {
      return oauthResultPage('calendar_auth_error', { error: 'Missing user ID in state. Please try connecting your calendar again.' });
    }

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const redirectUri = `${supabaseUrl}/functions/v1/handleGoogleCalendarOAuthCallback`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId!,
        client_secret: clientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      return oauthResultPage('calendar_auth_error', { error: 'Failed to get access token' });
    }

    // Get user info
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });

    const userInfo = await userInfoResponse.json();
    const emailAddress = userInfo.email;

    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Fetch user to get email for created_by filter (column stores email, not UUID)
    const stateUser = await entities.User.get(userId).catch(() => null);
    const createdByEmail = stateUser?.email || emailAddress;

    // Check if this calendar is already connected
    const existingConnections = await entities.CalendarConnection.filter({
      account_email: emailAddress,
      created_by: createdByEmail
    });

    if (existingConnections.length > 0) {
      // Update the existing connection with fresh tokens
      await entities.CalendarConnection.update(existingConnections[0].id, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || existingConnections[0].refresh_token,
        is_enabled: true,
        account_name: userInfo.name || emailAddress,
        last_synced: new Date().toISOString(),
      });
    } else {
      const user = await entities.User.get(userId);
      if (!user || !user.email) {
        return oauthResultPage('calendar_auth_error', { error: 'User not found. Please try connecting your calendar again.' });
      }

      // ── CONNECTION LIMIT ENFORCEMENT ─────────────────────────────────────────
      const isAdmin = user.role === 'master_admin' || user.role === 'admin';
      const connectionLimit = isAdmin ? 5 : 2;

      const allUserConnections = await entities.CalendarConnection
        .filter({ created_by: user.email }, null, 10);

      if (allUserConnections.length >= connectionLimit) {
        const limitMsg = `Connection limit reached. ${isAdmin ? 'Admins' : 'Users'} can connect up to ${connectionLimit} calendars. Remove an existing connection first.`;
        return oauthResultPage('calendar_auth_error', { error: limitMsg });
      }

      // Create the calendar connection
      await entities.CalendarConnection.create({
        account_email: emailAddress,
        account_name: userInfo.name || emailAddress,
        is_enabled: true,
        color: '#3b82f6',
        google_calendar_id: 'primary',
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        last_synced: new Date().toISOString(),
        created_by: user.email
      });
    }

    return oauthResultPage('calendar_auth_success', { email: emailAddress });
  } catch (error: any) {
    return oauthResultPage('calendar_auth_error', { error: error.message || 'Unknown error' });
  }
});

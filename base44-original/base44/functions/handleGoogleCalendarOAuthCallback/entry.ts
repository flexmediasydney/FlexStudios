import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      return new Response(`
        <html>
          <body>
            <script>
              window.opener.postMessage({ type: 'calendar_auth_error', error: '${error}' }, '*');
              window.close();
            </script>
          </body>
        </html>
      `, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (!code || !state) {
      return Response.json({ error: 'Missing authorization code or state' }, { status: 400 });
    }

    const stateData = JSON.parse(state);
    const { userId } = stateData;

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const appUrl = Deno.env.get('BASE44_APP_URL') || 'http://localhost:3000';
    const redirectUri = `${appUrl}/api/functions/handleGoogleCalendarOAuthCallback`;

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokens.access_token) {
      return Response.json({ error: 'Failed to get access token' }, { status: 500 });
    }

    // Get user info
    const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { 'Authorization': `Bearer ${tokens.access_token}` }
    });

    const userInfo = await userInfoResponse.json();
    const emailAddress = userInfo.email;

    const base44 = createClientFromRequest(req);
    
    // Check if this calendar is already connected
    const existingConnections = await base44.asServiceRole.entities.CalendarConnection.filter({
      account_email: emailAddress,
      created_by: userId
    });

    if (existingConnections.length > 0) {
      // Update the existing connection with fresh tokens (e.g. scope upgrade or reconnect)
      await base44.asServiceRole.entities.CalendarConnection.update(existingConnections[0].id, {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token || existingConnections[0].refresh_token,
        is_enabled: true,
        account_name: userInfo.name || emailAddress,
        last_synced: new Date().toISOString(),
      });
    } else {

    const user = await base44.asServiceRole.entities.User.get(userId);

    // ── CONNECTION LIMIT ENFORCEMENT ─────────────────────────────────────────
    // Admins (master_admin, admin): max 5 connections
    // All other roles: max 2 connections
    const isAdmin = user?.role === 'master_admin' || user?.role === 'admin';
    const connectionLimit = isAdmin ? 5 : 2;

    const allUserConnections = await base44.asServiceRole.entities.CalendarConnection
      .filter({ created_by: user.email }, null, 10);

    if (allUserConnections.length >= connectionLimit) {
      return new Response(`
        <html><body><script>
          window.opener.postMessage({
            type: 'calendar_auth_error',
            error: 'Connection limit reached. ${isAdmin ? 'Admins' : 'Users'} can connect up to ${connectionLimit} calendars. Remove an existing connection first.'
          }, '*');
          window.close();
        </script></body></html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }

      // Create the calendar connection
      await base44.asServiceRole.entities.CalendarConnection.create({
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

    return new Response(`
      <html>
        <body>
          <script>
            window.opener.postMessage({ type: 'calendar_auth_success', email: '${emailAddress}' }, '*');
            window.close();
          </script>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  } catch (error) {
    return new Response(`
      <html>
        <body>
          <script>
            window.opener.postMessage({ type: 'calendar_auth_error', error: '${error.message}' }, '*');
            window.close();
          </script>
        </body>
      </html>
    `, {
      headers: { 'Content-Type': 'text/html' }
    });
  }
});
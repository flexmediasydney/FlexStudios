import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    const url = new URL(req.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    // Step 1: Initial request - redirect to Google OAuth
    if (!code) {
      const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
      const redirectUri = `${url.origin}/api/functions/initializeGmail`;
      
      const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      authUrl.searchParams.set('client_id', clientId);
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.readonly');
      authUrl.searchParams.set('access_type', 'offline');
      authUrl.searchParams.set('state', JSON.stringify({
        userId: user.id,
        displayName: url.searchParams.get('displayName') || user.full_name,
        teamId: url.searchParams.get('teamId') || null
      }));

      return Response.redirect(authUrl.toString(), 302);
    }

    // Step 2: Handle OAuth callback
    const stateData = JSON.parse(decodeURIComponent(state));
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    const redirectUri = `${url.origin}/api/functions/initializeGmail`;

    // Exchange code for tokens
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri
      })
    });

    if (!tokenResponse.ok) {
      throw new Error('Failed to exchange authorization code');
    }

    const tokens = await tokenResponse.json();
    const accessToken = tokens.access_token;

    // Get Gmail profile
    const profileResponse = await fetch(
      'https://www.googleapis.com/gmail/v1/users/me/profile',
      {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      }
    );

    if (!profileResponse.ok) {
      throw new Error('Failed to get Gmail profile');
    }

    const profile = await profileResponse.json();

    // Check if email account already exists
    const existing = await base44.asServiceRole.entities.EmailAccount.filter({
      email_address: profile.emailAddress,
      assigned_to_user_id: stateData.userId
    });

    if (existing.length > 0) {
      await base44.asServiceRole.entities.EmailAccount.update(existing[0].id, {
        display_name: stateData.displayName,
        access_token: accessToken,
        refresh_token: tokens.refresh_token || existing[0].refresh_token,
        last_sync: new Date().toISOString(),
        is_active: true
      });
    } else {
      await base44.asServiceRole.entities.EmailAccount.create({
        email_address: profile.emailAddress,
        display_name: stateData.displayName,
        assigned_to_user_id: stateData.userId,
        assigned_to_name: user.full_name,
        team_id: stateData.teamId,
        access_token: accessToken,
        refresh_token: tokens.refresh_token,
        last_sync: new Date().toISOString(),
        is_active: true
      });
    }

    // Redirect back to email sync settings
    return Response.redirect('/EmailSyncSettings', 302);
  } catch (error) {
    return Response.redirect(`/EmailSyncSettings?error=${encodeURIComponent(error.message)}`, 302);
  }
});
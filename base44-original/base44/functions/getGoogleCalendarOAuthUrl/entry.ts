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

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    if (!clientId) {
      return Response.json({ error: 'Google OAuth not configured' }, { status: 500 });
    }

    const appUrl = Deno.env.get('BASE44_APP_URL') || 'http://localhost:3000';
    const redirectUri = `${appUrl}/api/functions/handleGoogleCalendarOAuthCallback`;

    const scopes = [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/userinfo.email'
    ];

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', JSON.stringify({ userId: user.id }));

    return Response.json({ authUrl: authUrl.toString() });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
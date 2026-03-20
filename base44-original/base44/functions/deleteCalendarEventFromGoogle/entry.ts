import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${data.error || 'unknown'}`);
  return data.access_token;
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (!['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    const body = await req.json().catch(() => ({}));
    const { calendar_event_id } = body;

    if (!calendar_event_id) {
      return Response.json({ error: 'calendar_event_id is required' }, { status: 400 });
    }

    // Load the full CalendarEvent — we need it for security checks
    const calEvent = await base44.entities.CalendarEvent.get(calendar_event_id);
    if (!calEvent) {
      // Already deleted — nothing to do
      return Response.json({ success: true, skipped: true, reason: 'Event not found — already deleted' });
    }

    // ── SECURITY GATE 1: Source check ────────────────────────────────────────
    // Tonomo events: NEVER delete from Google via FlexMedia — only Tonomo controls these
    if (calEvent.event_source === 'tonomo') {
      return Response.json({
        error: 'Tonomo booking events cannot be deleted from FlexMedia. Cancel in Tonomo.',
        code: 'TONOMO_EVENT_IMMUTABLE'
      }, { status: 403 });
    }
    // Google-synced events: read-only, manage in Google Calendar
    if (calEvent.event_source === 'google') {
      return Response.json({
        error: 'Google Calendar events are read-only in FlexMedia. Delete in Google Calendar.',
        code: 'GOOGLE_EVENT_READONLY'
      }, { status: 403 });
    }

    // ── SECURITY GATE 2: Ownership check ─────────────────────────────────────
    if (calEvent.created_by_user_id && calEvent.created_by_user_id !== user.id) {
      return Response.json({
        error: 'You can only delete your own events from Google Calendar.',
        code: 'NOT_EVENT_OWNER'
      }, { status: 403 });
    }

    // No google_event_id means it was never pushed to Google — nothing to delete
    if (!calEvent.google_event_id) {
      return Response.json({ success: true, skipped: true, reason: 'Event was never synced to Google Calendar' });
    }

    // ── SECURITY GATE 3: Use ONLY the owner's calendar connection ─────────────
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return Response.json({ error: 'Google OAuth not configured' }, { status: 500 });
    }

    const connections = await base44.entities.CalendarConnection.filter({
      created_by: user.email,
      is_enabled: true,
    }, null, 10);

    if (connections.length === 0) {
      return Response.json({ skipped: true, reason: 'No connected Google Calendar for this user' });
    }

    // Use the account the event was synced from if available, else first connection
    const connection = calEvent.calendar_account
      ? (connections.find((c: any) => c.account_email === calEvent.calendar_account) || connections[0])
      : connections[0];

    if (!connection.refresh_token) {
      return Response.json({ skipped: true, reason: 'No refresh token — please reconnect calendar' });
    }

    const accessToken = await refreshAccessToken(clientId, clientSecret, connection.refresh_token);

    const deleteRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${calEvent.google_event_id}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      }
    );

    // 404 = already deleted in Google — treat as success (idempotent)
    if (!deleteRes.ok && deleteRes.status !== 404) {
      const errBody = await deleteRes.text();
      return Response.json({ error: `Google Calendar delete failed: ${errBody}` }, { status: 502 });
    }

    return Response.json({ success: true, google_event_id: calEvent.google_event_id });

  } catch (error: any) {
    console.error('deleteCalendarEventFromGoogle error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { getAdminClient, getUserFromReq, getUserClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

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
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const userClient = getUserClient(req);
    const userEntities = createEntities(userClient);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);
    if (!['master_admin', 'admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const body = await req.json().catch(() => ({}));
    const { calendar_event_id } = body;

    if (!calendar_event_id) {
      return errorResponse('calendar_event_id is required', 400);
    }

    // Load the full CalendarEvent
    const calEvent = await userEntities.CalendarEvent.get(calendar_event_id);
    if (!calEvent) {
      return jsonResponse({ success: true, skipped: true, reason: 'Event not found — already deleted' });
    }

    // ── SECURITY GATE 1: Source check ────────────────────────────────────────
    if (calEvent.event_source === 'tonomo') {
      return jsonResponse({
        error: 'Tonomo booking events cannot be deleted from FlexStudios. Cancel in Tonomo.',
        code: 'TONOMO_EVENT_IMMUTABLE'
      }, 403);
    }
    if (calEvent.event_source === 'google') {
      return jsonResponse({
        error: 'Google Calendar events are read-only in FlexStudios. Delete in Google Calendar.',
        code: 'GOOGLE_EVENT_READONLY'
      }, 403);
    }

    // ── SECURITY GATE 2: Ownership check ─────────────────────────────────────
    // Require either ownership match OR admin role. Never skip if created_by_user_id is null.
    const isAdmin = user.role === 'master_admin' || user.role === 'admin';
    const isOwner = calEvent.created_by_user_id && calEvent.created_by_user_id === user.id;
    if (!isOwner && !isAdmin) {
      return jsonResponse({
        error: 'You can only delete your own events from Google Calendar.',
        code: 'NOT_EVENT_OWNER'
      }, 403);
    }

    // No google_event_id means it was never pushed to Google
    if (!calEvent.google_event_id) {
      return jsonResponse({ success: true, skipped: true, reason: 'Event was never synced to Google Calendar' });
    }

    // ── SECURITY GATE 3: Use ONLY the owner's calendar connection ─────────────
    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return errorResponse('Google OAuth not configured', 500);
    }

    const connections = await userEntities.CalendarConnection.filter({
      created_by: user.email,
      is_enabled: true,
    }, null, 10);

    if (connections.length === 0) {
      return jsonResponse({ skipped: true, reason: 'No connected Google Calendar for this user' });
    }

    // Use ONLY the account the event was synced from — never fall back to a different calendar
    let connection;
    if (calEvent.calendar_account) {
      connection = connections.find((c: any) => c.account_email === calEvent.calendar_account);
      if (!connection) {
        return errorResponse(
          `No matching calendar connection for account "${calEvent.calendar_account}". Cannot delete from a different calendar.`,
          400
        );
      }
    } else {
      connection = connections[0];
    }

    if (!connection.refresh_token) {
      return jsonResponse({ skipped: true, reason: 'No refresh token — please reconnect calendar' });
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
      return errorResponse(`Google Calendar delete failed: ${errBody}`, 502);
    }

    return jsonResponse({ success: true, google_event_id: calEvent.google_event_id });

  } catch (error: any) {
    console.error('deleteCalendarEventFromGoogle error:', error);
    return errorResponse(error.message);
  }
});

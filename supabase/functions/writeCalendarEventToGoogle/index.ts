import { getAdminClient, getUserFromReq, getUserClient, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const APP_TIMEZONE = 'Australia/Sydney';

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

function toGoogleDateTime(isoString: string | null, isAllDay: boolean) {
  if (!isoString) return {};
  if (isAllDay) return { date: isoString.slice(0, 10) };
  return { dateTime: isoString, timeZone: APP_TIMEZONE };
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
    if (!['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    const body = await req.json().catch(() => ({}));
    const { calendar_event_id } = body;
    if (!calendar_event_id) {
      return errorResponse('calendar_event_id is required', 400);
    }

    // Load the CalendarEvent
    const calEvent = await userEntities.CalendarEvent.get(calendar_event_id);
    if (!calEvent) return errorResponse('CalendarEvent not found', 404);

    // ── SECURITY GATE 1: Source check ────────────────────────────────────────
    const eventSource = calEvent.event_source || 'flexmedia';
    if (eventSource === 'tonomo') {
      return jsonResponse({
        error: 'Tonomo booking events cannot be modified from FlexStudios. Edit in Tonomo.',
        code: 'TONOMO_EVENT_IMMUTABLE'
      }, 403);
    }
    if (eventSource === 'google') {
      return jsonResponse({
        error: 'Google Calendar events are read-only in FlexStudios. Edit in Google Calendar.',
        code: 'GOOGLE_EVENT_READONLY'
      }, 403);
    }

    // ── SECURITY GATE 2: Ownership check ─────────────────────────────────────
    if (calEvent.created_by_user_id && calEvent.created_by_user_id !== user.id) {
      return jsonResponse({
        error: 'You can only push your own events to Google Calendar.',
        code: 'NOT_EVENT_OWNER'
      }, 403);
    }

    // ── SECURITY GATE 3: Calendar connection belongs to this user ─────────────
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

    const connection = connections[0];
    if (!connection.refresh_token) {
      return jsonResponse({ skipped: true, reason: 'Calendar connection has no refresh token — please reconnect' });
    }

    // Get a fresh access token
    let accessToken: string;
    try {
      accessToken = await refreshAccessToken(clientId, clientSecret, connection.refresh_token);
      await userEntities.CalendarConnection.update(connection.id, { access_token: accessToken });
    } catch (err: any) {
      return errorResponse(`Token refresh failed: ${err.message}`, 401);
    }

    const isAllDay = calEvent.is_all_day || false;

    // Enrich description with project context if linked
    let enrichedDescription = calEvent.description || '';
    if (calEvent.project_id) {
      try {
        const project = await userEntities.Project.get(calEvent.project_id);
        if (project) {
          const appUrl = Deno.env.get('APP_URL') || 'https://flexstudios.app';
          const projectLink = `${appUrl}/ProjectDetails?id=${project.id}`;
          const contextLines = [
            `Project: ${project.title || project.property_address || 'Untitled'}`,
            project.property_address ? `Address: ${project.property_address}` : null,
            project.shoot_date ? `Shoot: ${project.shoot_date}` : null,
            `View in FlexStudios: ${projectLink}`,
          ].filter(Boolean).join('\n');
          enrichedDescription = enrichedDescription
            ? `${enrichedDescription}\n\n──────────────\n${contextLines}`
            : contextLines;
        }
      } catch { /* non-fatal */ }
    }

    const gEventPayload: Record<string, any> = {
      summary: calEvent.title || 'FlexStudios Activity',
      description: enrichedDescription,
      location: calEvent.location || '',
      start: toGoogleDateTime(calEvent.start_time, isAllDay),
      end: toGoogleDateTime(calEvent.end_time || calEvent.start_time, isAllDay),
    };

    // Attendees
    if (calEvent.attendees) {
      try {
        const attendeeList = JSON.parse(calEvent.attendees);
        if (Array.isArray(attendeeList) && attendeeList.length > 0) {
          gEventPayload.attendees = attendeeList
            .filter((a: any) => a.email)
            .map((a: any) => ({ email: a.email, displayName: a.name || undefined }));
        }
      } catch { /* ignore malformed attendees */ }
    }

    let gEventId = calEvent.google_event_id || '';
    let operation: 'created' | 'updated' = 'created';

    if (gEventId) {
      // UPDATE existing Google event
      const updateRes = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${gEventId}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(gEventPayload),
        }
      );

      if (updateRes.status === 404) {
        gEventId = '';
      } else if (!updateRes.ok) {
        const errBody = await updateRes.text();
        return errorResponse(`Google Calendar update failed: ${errBody}`, 502);
      } else {
        const updated = await updateRes.json();
        gEventId = updated.id;
        operation = 'updated';
      }
    }

    if (!gEventId) {
      // CREATE new Google event
      const createRes = await fetch(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(gEventPayload),
        }
      );

      if (!createRes.ok) {
        const errBody = await createRes.text();
        return errorResponse(`Google Calendar create failed: ${errBody}`, 502);
      }

      const created = await createRes.json();
      gEventId = created.id;
      operation = 'created';
    }

    // Write google_event_id back
    await userEntities.CalendarEvent.update(calendar_event_id, {
      google_event_id: gEventId,
      google_html_link: `https://www.google.com/calendar/event?eid=${gEventId}`,
      is_synced: true,
      calendar_account: connection.account_email,
    });

    return jsonResponse({
      success: true,
      operation,
      google_event_id: gEventId,
      calendar_account: connection.account_email,
    });

  } catch (error: any) {
    console.error('writeCalendarEventToGoogle error:', error);
    // Persist sync failure state
    try {
      const bodyForError = await req.clone().json().catch(() => ({}));
      const eventIdForError = bodyForError?.calendar_event_id;
      if (eventIdForError) {
        const admin = getAdminClient();
        const entities = createEntities(admin);
        await entities.CalendarEvent.update(eventIdForError, {
          is_synced: false,
        });
      }
    } catch { /* ignore */ }
    return errorResponse(error.message);
  }
});

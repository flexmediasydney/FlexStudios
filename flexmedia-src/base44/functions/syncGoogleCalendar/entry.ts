import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

const refreshAccessToken = async (clientId, clientSecret, refreshToken) => {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!data.access_token) throw new Error(`Token refresh failed: ${data.error || 'unknown error'}`);
  return data.access_token;
};

async function writeCalendarAudit(base44, params) {
  try {
    await base44.asServiceRole.entities.TonomoAuditLog.create({
      ...params,
      entity_type: 'CalendarLink',
      processor_version: 'calendar-sync-v1',
      processed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('Calendar audit write failed:', e.message);
  }
}

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const targetUserEmail = body.targetUserEmail || null;
    const syncAll = body.syncAll === true && (user.role === 'master_admin' || user.role === 'admin');
    const incremental = body.incremental === true;

    // ── Check auto-link setting ───────────────────────────────────────────────
    const settingsList = await base44.asServiceRole.entities.TonomoIntegrationSettings.list('-created_date', 1) || [];
    const settings = settingsList[0] || {};
    const autoLinkEnabled = settings.auto_link_calendar_events !== false; // default true
    const masterCalendarEmail = settings.business_calendar_id?.toLowerCase()?.trim() || null;

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return Response.json({ error: 'GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set' }, { status: 500 });
    }

    // ── Fetch connections ─────────────────────────────────────────────────────
    // Admins always sync ALL team connections — one sync covers the whole team.
    // Regular users sync only their own connections.
    const isAdmin = user.role === 'master_admin' || user.role === 'admin';
    let connections;
    if (syncAll || isAdmin) {
      // Sync ALL enabled connections across the whole team
      connections = await base44.asServiceRole.entities.CalendarConnection
        .filter({ is_enabled: true }, null, 1000) || [];
    } else if (targetUserEmail) {
      connections = await base44.asServiceRole.entities.CalendarConnection
        .filter({ created_by: targetUserEmail, is_enabled: true }, null, 1000) || [];
    } else {
      connections = await base44.entities.CalendarConnection
        .filter({ created_by: user.email, is_enabled: true }, null, 1000) || [];
    }

    if (connections.length === 0) {
      return Response.json({ message: 'No active calendar connections found', created: 0, updated: 0, linked: 0 });
    }

    // Only load events within the sync window for dedup — not the entire history
    const allExisting = await base44.asServiceRole.entities.CalendarEvent.filter({
      start_time: { $gte: timeMin.toISOString() }
    }, '-start_time', 2000) || [];
    // Key on google_event_id ONLY — not on calendar_account.
    // The same real-world event appears on multiple calendars (info@, each photographer).
    // We want ONE record per event regardless of which account synced it.
    // First-seen wins: if webhook already created it, we update rather than duplicate.
    const existingByGoogleId = new Map();
    for (const ev of allExisting) {
      if (ev.google_event_id && !existingByGoogleId.has(ev.google_event_id)) {
        existingByGoogleId.set(ev.google_event_id, ev);
      }
    }

    // ── Load ALL projects for auto-linking ────────────────────────────────────
    // Map tonomo_google_event_id → project for exact deterministic matching
    const allProjects = autoLinkEnabled
      ? await base44.asServiceRole.entities.Project.list('-created_date', 2000) || []
      : [];
    const projectByGoogleEventId = new Map();
    if (autoLinkEnabled) {
      for (const proj of allProjects) {
        if (proj.tonomo_google_event_id) {
          projectByGoogleEventId.set(proj.tonomo_google_event_id, proj);
        }
      }
    }

    // ── Load users for attendee → staff matching ──────────────────────────────
    const allUsers = autoLinkEnabled
      ? await base44.asServiceRole.entities.User.list('-created_date', 500) || []
      : [];
    const usersByEmail = new Map();
    if (autoLinkEnabled) {
      for (const u of allUsers) {
        if (u.email) usersByEmail.set(u.email.toLowerCase(), u);
      }
    }

    let totalCreated = 0;
    let totalUpdated = 0;
    let totalLinked = 0;
    const errors = [];
    const accountResults = [];

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 90);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 365);

    for (const connection of connections) {
      const accountResult = {
        account: connection.account_email,
        account_name: connection.account_name || connection.account_email,
        created: 0,
        updated: 0,
        linked: 0,
        errors: [],
        status: 'ok',          // 'ok' | 'skipped' | 'error'
        skip_reason: null,     // human-readable reason if skipped
      };

      try {
        if (!connection.refresh_token) {
          const msg = 'No refresh token — reconnect this calendar account';
          errors.push({ account: connection.account_email, error: msg });
          accountResult.errors.push(msg);
          accountResult.status = 'skipped';
          accountResult.skip_reason = 'no_refresh_token';
          accountResults.push(accountResult);
          continue;
        }

        let accessToken;
        try {
          accessToken = await refreshAccessToken(clientId, clientSecret, connection.refresh_token);
          await base44.asServiceRole.entities.CalendarConnection.update(connection.id, { access_token: accessToken });
        } catch (refreshErr) {
          const msg = `Token refresh failed: ${refreshErr.message}`;
          errors.push({ account: connection.account_email, error: msg });
          accountResult.errors.push(msg);
          accountResult.status = 'error';
          accountResult.skip_reason = 'token_refresh_failed';
          accountResults.push(accountResult);
          continue;
        }

        const eventsUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events`);
        const hasSyncToken = incremental && connection.next_sync_token;

        if (hasSyncToken) {
          // Incremental: fetch only events changed since last sync
          eventsUrl.searchParams.set('syncToken', connection.next_sync_token);
          eventsUrl.searchParams.set('maxResults', '250');
        } else {
          // Full sync
          eventsUrl.searchParams.set('timeMin', timeMin.toISOString());
          eventsUrl.searchParams.set('timeMax', timeMax.toISOString());
          eventsUrl.searchParams.set('singleEvents', 'true');
          eventsUrl.searchParams.set('orderBy', 'startTime');
          eventsUrl.searchParams.set('maxResults', '2500');
        }

        const response = await fetch(eventsUrl.toString(), {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });

        let data;
        if (!response.ok) {
          if (response.status === 410 && hasSyncToken) {
            // Sync token expired — clear it, fall back to full sync
            console.warn(`Sync token expired for ${connection.account_email} — full sync`);
            await base44.asServiceRole.entities.CalendarConnection.update(connection.id, {
              next_sync_token: null,
            });
            const retryUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events`);
            retryUrl.searchParams.set('timeMin', timeMin.toISOString());
            retryUrl.searchParams.set('timeMax', timeMax.toISOString());
            retryUrl.searchParams.set('singleEvents', 'true');
            retryUrl.searchParams.set('orderBy', 'startTime');
            retryUrl.searchParams.set('maxResults', '2500');
            const retryRes = await fetch(retryUrl.toString(), {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            if (!retryRes.ok) {
              const errText = await retryRes.text();
              throw new Error(`Google API error ${retryRes.status}: ${errText.slice(0, 200)}`);
            }
            data = await retryRes.json();
          } else {
            const errText = await response.text();
            throw new Error(`Google API error ${response.status}: ${errText.slice(0, 200)}`);
          }
        } else {
          data = await response.json();
        }
        const googleEvents = data.items || [];

        for (const gEvent of googleEvents) {
          try {
            // Apply visibility policy
            const policy = connection.visibility_policy || 'show_all';

            if (policy === 'skip_private' &&
                (gEvent.visibility === 'private' || gEvent.visibility === 'confidential')) {
              // Skip this event entirely — don't create or update in FlexMedia
              accountResult.skipped_private = (accountResult.skipped_private || 0) + 1;
              continue;
            }

            const existing = existingByGoogleId.get(gEvent.id);

            const startTime = gEvent.start?.dateTime || gEvent.start?.date || null;
            const endTime = gEvent.end?.dateTime || gEvent.end?.date || null;
            const isAllDay = !gEvent.start?.dateTime;

            // Build full attendee list with RSVP status
            const attendeeList = gEvent.attendees
              ? gEvent.attendees.map((a) => ({
                  name: a.displayName || a.email,
                  email: a.email,
                  response: a.responseStatus || 'needsAction', // accepted|declined|tentative|needsAction
                  organizer: a.organizer || false,
                  self: a.self || false,
                }))
              : [];

            const attendees = JSON.stringify(attendeeList);

            // attendee_responses: just the RSVP map for quick lookup
            // { "kelvin@flexmedia.sydney": "accepted", "janet@...": "needsAction" }
            const attendeeResponses = JSON.stringify(
              Object.fromEntries(attendeeList.map(a => [a.email, a.response]))
            );

            // Determine event_source:
            // If this google_event_id matches a Tonomo project's appointment ID
            // → source is 'tonomo' (it's a booking that lives on Google Calendar)
            // Otherwise → source is 'google' (personal/external event)
            // A Tonomo booking if:
            // 1. The google_event_id matches a project's tonomo_google_event_id (primary check)
            // 2. OR the event comes from the master Tonomo calendar account (secondary check —
            //    catches bookings that arrived before the webhook was processed)
            const isTonomoBooking =
              projectByGoogleEventId.has(gEvent.id) ||
              (masterCalendarEmail && connection.account_email?.toLowerCase() === masterCalendarEmail);
            const derivedSource = isTonomoBooking ? 'tonomo' : 'google';

            // Extract Google Meet / conference link if present
            const conferenceLink = gEvent.conferenceData?.entryPoints
              ?.find((ep) => ep.entryPointType === 'video')?.uri || null;

            const eventData = {
              title: gEvent.summary || 'Untitled Event',
              description: gEvent.description || '',
              start_time: startTime,
              end_time: endTime,
              location: gEvent.location || '',
              google_event_id: gEvent.id,
              google_html_link: gEvent.htmlLink || null,
              calendar_account: connection.account_email,
              is_synced: true,
              is_all_day: isAllDay,
              activity_type: isTonomoBooking ? 'shoot' : (() => {
                switch (gEvent.eventType) {
                  case 'outOfOffice': return 'other';
                  case 'focusTime':   return 'other';
                  case 'fromGmail':   return 'meeting';
                  default:            return 'meeting';
                }
              })(),
              google_event_type: gEvent.eventType || 'default',
              google_visibility:    gEvent.visibility    || 'default',
              google_transparency:  gEvent.transparency  || 'opaque',
              connection_visibility_policy: connection.visibility_policy || 'show_all',
              attendees,
              attendee_responses: attendeeResponses,
              conference_link: conferenceLink,
              is_done: gEvent.status === 'cancelled',
              recurrence: gEvent.recurrence ? 'recurring' : 'none',
              recurrence_rule: gEvent.recurrence ? JSON.stringify(gEvent.recurrence) : null,
              recurring_event_id: gEvent.recurringEventId || null,
              event_source: derivedSource,
            };

            // ── Auto-link logic (only if enabled) ────────────────────────────
            let autoProjectId = existing?.project_id || null;
            let autoAgentId = existing?.agent_id || null;
            let autoAgencyId = existing?.agency_id || null;
            let autoOwnerId = existing?.owner_user_id || null;
            let linkSource = existing?.link_source || null;

            if (autoLinkEnabled && !autoProjectId) {
              // Strategy 1 — Exact match via tonomo_google_event_id (deterministic)
              const matchedProject = projectByGoogleEventId.get(gEvent.id);
              if (matchedProject) {
                // Only link to approved/active projects — not pending_review
                const LINKABLE_STAGES = ['to_be_scheduled', 'scheduled', 'onsite', 'uploaded',
                  'submitted', 'in_revision', 'in_production', 'delivered', 'cancelled'];
                if (LINKABLE_STAGES.includes(matchedProject.status)) {
                  autoProjectId = matchedProject.id;
                  autoAgentId = matchedProject.agent_id || null;
                  autoAgencyId = matchedProject.agency_id || null;
                  autoOwnerId = matchedProject.project_owner_id || null;
                  linkSource = 'google_event_id';
                  totalLinked++;
                  accountResult.linked++;

                  await writeCalendarAudit(base44, {
                    action: 'auto_link',
                    entity_id: matchedProject.id,
                    operation: 'linked',
                    tonomo_order_id: matchedProject.tonomo_order_id,
                    notes: `CalendarEvent ${gEvent.id} auto-linked to project "${matchedProject.title}" via google_event_id match. Source: ${connection.account_email}`,
                  });

                  // Update project to flag it as auto-linked
                  if (!matchedProject.calendar_auto_linked) {
                    await base44.asServiceRole.entities.Project.update(matchedProject.id, {
                      calendar_auto_linked: true,
                      calendar_link_source: 'google_event_id',
                    });
                  }
                } else if (matchedProject.status === 'pending_review') {
                  // Project exists but not yet approved — skip linking, log it
                  await writeCalendarAudit(base44, {
                    action: 'auto_link',
                    entity_id: matchedProject.id,
                    operation: 'skipped_pending',
                    tonomo_order_id: matchedProject.tonomo_order_id,
                    notes: `CalendarEvent ${gEvent.id} matches project "${matchedProject.title}" but project is pending_review — link deferred until approved`,
                  });
                }
              } else {
                // Strategy 2 — Attendee email → User → already owner on some project (fallback)
                if (gEvent.attendees?.length > 0) {
                  for (const att of gEvent.attendees) {
                    const matchedUser = usersByEmail.get((att.email || '').toLowerCase());
                    if (matchedUser && !autoOwnerId) {
                      autoOwnerId = matchedUser.id;
                      break;
                    }
                  }
                }
              }
            }

            if (autoProjectId) {
              eventData.project_id = autoProjectId;
              eventData.auto_linked = true;
              eventData.link_source = linkSource || 'google_event_id';
              eventData.link_confidence = 'exact';
            }
            if (autoAgentId) eventData.agent_id = autoAgentId;
            if (autoAgencyId) eventData.agency_id = autoAgencyId;
            if (autoOwnerId) eventData.owner_user_id = autoOwnerId;

            if (!existing) {
              await base44.asServiceRole.entities.CalendarEvent.create({
                ...eventData,
                is_done: gEvent.status === 'cancelled',
              });
              existingByGoogleId.set(gEvent.id, eventData);
              totalCreated++;
              accountResult.created++;
            } else {
              const hasChanged =
                existing.title !== eventData.title ||
                existing.start_time !== startTime ||
                existing.end_time !== endTime ||
                existing.location !== (gEvent.location || '') ||
                existing.description !== (gEvent.description || '') ||
                (!existing.project_id && autoProjectId);

              // Also update if RSVP responses changed (accept/decline happens silently)
              const responsesChanged = existing.attendee_responses !== attendeeResponses;
              if (hasChanged || responsesChanged) {
                // Preserve original event_source — a FlexMedia event pushed to Google
                // is still a FlexMedia event. Only set source on legacy events that
                // pre-date the event_source field (where it's null/undefined).
                const preserveSource = existing.event_source && existing.event_source !== derivedSource;

                await base44.asServiceRole.entities.CalendarEvent.update(existing.id, {
                  title: preserveSource ? existing.title : eventData.title,
                  description: preserveSource ? existing.description : eventData.description,
                  start_time: startTime,
                  end_time: endTime,
                  location: preserveSource ? existing.location : eventData.location,
                  attendees,
                  attendee_responses: attendeeResponses,
                  conference_link: eventData.conference_link,
                  is_all_day: isAllDay,
                  google_html_link: eventData.google_html_link,
                  ...(!existing.event_source ? { event_source: derivedSource } : {}),
                  ...(!existing.project_id && autoProjectId ? {
                    project_id: autoProjectId,
                    auto_linked: true,
                    link_source: linkSource || 'google_event_id',
                    link_confidence: 'exact',
                  } : {}),
                  ...(!existing.agent_id && autoAgentId ? { agent_id: autoAgentId } : {}),
                  ...(!existing.agency_id && autoAgencyId ? { agency_id: autoAgencyId } : {}),
                  ...(!existing.owner_user_id && autoOwnerId ? { owner_user_id: autoOwnerId } : {}),
                });
                totalUpdated++;
                accountResult.updated++;
              }
            }
          } catch (eventErr) {
            accountResult.errors.push(`Event ${gEvent.id}: ${eventErr.message?.slice(0, 100)}`);
          }
        }

        const connectionUpdate: Record<string, any> = {
          last_synced: new Date().toISOString(),
          last_sync_count: googleEvents.length,
        };
        if (data.nextSyncToken) {
          connectionUpdate.next_sync_token = data.nextSyncToken;
        }
        await base44.asServiceRole.entities.CalendarConnection.update(connection.id, connectionUpdate);

      } catch (connErr) {
        errors.push({ account: connection.account_email, error: connErr.message });
        accountResult.errors.push(connErr.message);
        accountResult.status = 'error';
      }

      accountResults.push(accountResult);
    }

    // ── Retroactive reconciliation pass ──────────────────────────────────────
    // Find CalendarEvents with no project_id that have a google_event_id matching
    // a project's tonomo_google_event_id. This catches events that synced BEFORE
    // the Tonomo webhook was processed and project was created.
    let retroLinked = 0;
    if (autoLinkEnabled && projectByGoogleEventId.size > 0) {
      const unlinkedEvents = allExisting.filter(ev =>
        ev.google_event_id && !ev.project_id && !ev.auto_linked
      );
      for (const ev of unlinkedEvents) {
        const matchedProject = projectByGoogleEventId.get(ev.google_event_id);
        if (!matchedProject) continue;
        const LINKABLE_STAGES = ['to_be_scheduled', 'scheduled', 'onsite', 'uploaded',
          'submitted', 'in_revision', 'in_production', 'delivered'];
        if (!LINKABLE_STAGES.includes(matchedProject.status)) continue;

        try {
          await base44.asServiceRole.entities.CalendarEvent.update(ev.id, {
            project_id: matchedProject.id,
            agent_id: matchedProject.agent_id || null,
            agency_id: matchedProject.agency_id || null,
            owner_user_id: matchedProject.project_owner_id || null,
            auto_linked: true,
            link_source: 'google_event_id_retroactive',
            link_confidence: 'exact',
          });
          if (!matchedProject.calendar_auto_linked) {
            await base44.asServiceRole.entities.Project.update(matchedProject.id, {
              calendar_auto_linked: true,
              calendar_link_source: 'google_event_id_retroactive',
            });
          }
          await writeCalendarAudit(base44, {
            action: 'retro_link',
            entity_id: matchedProject.id,
            operation: 'linked',
            tonomo_order_id: matchedProject.tonomo_order_id,
            notes: `Retroactive link: CalendarEvent ${ev.google_event_id} linked to project "${matchedProject.title}" — event was synced before project was created`,
          });
          retroLinked++;
        } catch (retroErr) {
          console.error('Retro link error:', retroErr.message);
        }
      }
    }

    return Response.json({
      success: true,
      created: totalCreated,
      updated: totalUpdated,
      linked: totalLinked + retroLinked,
      retro_linked: retroLinked,
      synced: totalCreated + totalUpdated,
      auto_link_enabled: autoLinkEnabled,
      connections: connections.length,
      accounts: accountResults,
      errors: errors.length > 0 ? errors : undefined,
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
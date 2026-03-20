import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

const refreshAccessToken = async (clientId: string, clientSecret: string, refreshToken: string): Promise<string> => {
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

async function writeCalendarAudit(entities: any, params: any) {
  try {
    await entities.TonomoAuditLog.create({
      ...params,
      entity_type: 'CalendarLink',
      processor_version: 'calendar-sync-v1',
      processed_at: new Date().toISOString(),
    });
  } catch (e: any) {
    console.error('Calendar audit write failed:', e.message);
  }
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const body = await req.json().catch(() => ({}));
    const targetUserEmail = body.targetUserEmail || null;
    const syncAll = body.syncAll === true && (user.role === 'master_admin' || user.role === 'admin');
    const incremental = body.incremental === true;

    // ── Check auto-link setting ───────────────────────────────────────────────
    const settingsList = await entities.TonomoIntegrationSettings.list('-created_date', 1) || [];
    const settings = settingsList[0] || {};
    const autoLinkEnabled = settings.auto_link_calendar_events !== false; // default true
    const masterCalendarEmail = settings.business_calendar_id?.toLowerCase()?.trim() || null;

    const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID');
    const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      return errorResponse('GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must be set', 500);
    }

    // ── Fetch connections ─────────────────────────────────────────────────────
    const isAdmin = user.role === 'master_admin' || user.role === 'admin';
    let connections;
    if (syncAll || isAdmin) {
      connections = await entities.CalendarConnection.filter({ is_enabled: true }, null, 1000) || [];
    } else if (targetUserEmail) {
      connections = await entities.CalendarConnection.filter({ created_by: targetUserEmail, is_enabled: true }, null, 1000) || [];
    } else {
      connections = await entities.CalendarConnection.filter({ created_by: user.email, is_enabled: true }, null, 1000) || [];
    }

    if (connections.length === 0) {
      return jsonResponse({ message: 'No active calendar connections found', created: 0, updated: 0, linked: 0 });
    }

    const timeMin = new Date();
    timeMin.setDate(timeMin.getDate() - 90);
    const timeMax = new Date();
    timeMax.setDate(timeMax.getDate() + 365);

    // Only load events within the sync window for dedup
    // Include events that span the boundary (end_time >= timeMin AND start_time <= timeMax)
    const allExisting = await entities.CalendarEvent.filter({
      end_time: { $gte: timeMin.toISOString() },
      start_time: { $lte: timeMax.toISOString() }
    }, '-start_time', 2000) || [];
    const existingByGoogleId = new Map();
    for (const ev of allExisting) {
      if (ev.google_event_id && !existingByGoogleId.has(ev.google_event_id)) {
        existingByGoogleId.set(ev.google_event_id, ev);
      }
    }

    // ── Load ALL projects for auto-linking ────────────────────────────────────
    const allProjects = autoLinkEnabled
      ? await entities.Project.list('-created_date', 2000) || []
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
      ? await entities.User.list('-created_date', 500) || []
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
    const errors: any[] = [];
    const accountResults: any[] = [];

    for (const connection of connections) {
      const accountResult: any = {
        account: connection.account_email,
        account_name: connection.account_name || connection.account_email,
        created: 0,
        updated: 0,
        linked: 0,
        errors: [],
        status: 'ok',
        skip_reason: null,
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
          await entities.CalendarConnection.update(connection.id, { access_token: accessToken });
        } catch (refreshErr: any) {
          const msg = `Token refresh failed: ${refreshErr.message}`;
          errors.push({ account: connection.account_email, error: msg });
          accountResult.errors.push(msg);
          accountResult.status = 'error';
          accountResult.skip_reason = 'token_refresh_failed';
          accountResults.push(accountResult);
          continue;
        }

        // ── Fetch all pages of events from Google Calendar ───────────────────
        const hasSyncToken = incremental && connection.next_sync_token;
        let useSyncToken = hasSyncToken;
        let syncToken410Retried = false;

        async function fetchAllPages(isSyncTokenMode: boolean): Promise<{ allItems: any[]; nextSyncToken: string | null }> {
          const allItems: any[] = [];
          let pageToken: string | null = null;
          let finalSyncToken: string | null = null;

          do {
            const eventsUrl = new URL(`https://www.googleapis.com/calendar/v3/calendars/primary/events`);

            if (isSyncTokenMode) {
              eventsUrl.searchParams.set('syncToken', connection.next_sync_token);
              eventsUrl.searchParams.set('maxResults', '250');
            } else {
              eventsUrl.searchParams.set('timeMin', timeMin.toISOString());
              eventsUrl.searchParams.set('timeMax', timeMax.toISOString());
              eventsUrl.searchParams.set('singleEvents', 'true');
              eventsUrl.searchParams.set('orderBy', 'startTime');
              eventsUrl.searchParams.set('maxResults', '2500');
            }

            if (pageToken) {
              eventsUrl.searchParams.set('pageToken', pageToken);
            }

            const response = await fetch(eventsUrl.toString(), {
              headers: { 'Authorization': `Bearer ${accessToken}` }
            });

            if (!response.ok) {
              if (response.status === 410 && isSyncTokenMode && !syncToken410Retried) {
                // Sync token expired — clear it BEFORE retrying to prevent infinite loop
                syncToken410Retried = true;
                console.warn(`Sync token expired for ${connection.account_email} — clearing token and doing full sync`);
                await entities.CalendarConnection.update(connection.id, {
                  next_sync_token: null,
                });
                // Return sentinel to signal caller to retry with full sync
                return { allItems: [], nextSyncToken: '__410_RETRY__' };
              }
              const errText = await response.text();
              throw new Error(`Google API error ${response.status}: ${errText.slice(0, 200)}`);
            }

            const data = await response.json();
            allItems.push(...(data.items || []));
            pageToken = data.nextPageToken || null;

            // The final page carries the nextSyncToken
            if (data.nextSyncToken) {
              finalSyncToken = data.nextSyncToken;
            }
          } while (pageToken);

          return { allItems, nextSyncToken: finalSyncToken };
        }

        let fetchResult = await fetchAllPages(!!useSyncToken);

        // Handle 410 retry: do a full sync after clearing the token
        if (fetchResult.nextSyncToken === '__410_RETRY__') {
          fetchResult = await fetchAllPages(false);
        }

        const googleEvents = fetchResult.allItems;
        const freshSyncToken = fetchResult.nextSyncToken;

        for (const gEvent of googleEvents) {
          try {
            const policy = connection.visibility_policy || 'show_all';

            if (policy === 'skip_private' &&
                (gEvent.visibility === 'private' || gEvent.visibility === 'confidential')) {
              accountResult.skipped_private = (accountResult.skipped_private || 0) + 1;
              continue;
            }

            const existing = existingByGoogleId.get(gEvent.id);

            // Handle cancelled events from incremental sync: Google sends minimal
            // payloads (just id + status) with no start/end times. Mark existing
            // events as done and skip creating new records for cancelled events.
            if (gEvent.status === 'cancelled') {
              if (existing) {
                await entities.CalendarEvent.update(existing.id, {
                  is_done: true,
                  done_at: new Date().toISOString(),
                });
                totalUpdated++;
                accountResult.updated++;
              }
              // Don't create new records for cancelled events
              continue;
            }

            const startTime = gEvent.start?.dateTime || gEvent.start?.date || null;
            const endTime = gEvent.end?.dateTime || gEvent.end?.date || null;
            const isAllDay = !gEvent.start?.dateTime;

            const attendeeList = gEvent.attendees
              ? gEvent.attendees.map((a: any) => ({
                  name: a.displayName || a.email,
                  email: a.email,
                  response: a.responseStatus || 'needsAction',
                  organizer: a.organizer || false,
                  self: a.self || false,
                }))
              : [];

            const attendees = JSON.stringify(attendeeList);
            const attendeeResponses = JSON.stringify(
              Object.fromEntries(attendeeList.map((a: any) => [a.email, a.response]))
            );

            const isTonomoBooking =
              projectByGoogleEventId.has(gEvent.id) ||
              (masterCalendarEmail && connection.account_email?.toLowerCase() === masterCalendarEmail);
            const derivedSource = isTonomoBooking ? 'tonomo' : 'google';

            const conferenceLink = gEvent.conferenceData?.entryPoints
              ?.find((ep: any) => ep.entryPointType === 'video')?.uri || null;

            const eventData: Record<string, any> = {
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
              is_done: false,
              recurrence: gEvent.recurrence ? 'recurring' : 'none',
              recurrence_rule: gEvent.recurrence ? JSON.stringify(gEvent.recurrence) : null,
              recurring_event_id: gEvent.recurringEventId || null,
              event_source: derivedSource,
            };

            // ── Auto-link logic ────────────────────────────
            let autoProjectId = existing?.project_id || null;
            let autoAgentId = existing?.agent_id || null;
            let autoAgencyId = existing?.agency_id || null;
            let autoOwnerId = existing?.owner_user_id || null;
            let linkSource = existing?.link_source || null;

            if (autoLinkEnabled && !autoProjectId) {
              const matchedProject = projectByGoogleEventId.get(gEvent.id);
              if (matchedProject) {
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

                  await writeCalendarAudit(entities, {
                    action: 'auto_link',
                    entity_id: matchedProject.id,
                    operation: 'linked',
                    tonomo_order_id: matchedProject.tonomo_order_id,
                    notes: `CalendarEvent ${gEvent.id} auto-linked to project "${matchedProject.title}" via google_event_id match. Source: ${connection.account_email}`,
                  });

                  if (!matchedProject.calendar_auto_linked) {
                    await entities.Project.update(matchedProject.id, {
                      calendar_auto_linked: true,
                      calendar_link_source: 'google_event_id',
                    });
                  }
                } else if (matchedProject.status === 'pending_review') {
                  await writeCalendarAudit(entities, {
                    action: 'auto_link',
                    entity_id: matchedProject.id,
                    operation: 'skipped_pending',
                    tonomo_order_id: matchedProject.tonomo_order_id,
                    notes: `CalendarEvent ${gEvent.id} matches project "${matchedProject.title}" but project is pending_review — link deferred until approved`,
                  });
                }
              } else {
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
              await entities.CalendarEvent.create({
                ...eventData,
                is_done: false,
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

              const responsesChanged = existing.attendee_responses !== attendeeResponses;
              if (hasChanged || responsesChanged) {
                const preserveSource = existing.event_source && existing.event_source !== derivedSource;

                await entities.CalendarEvent.update(existing.id, {
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
          } catch (eventErr: any) {
            accountResult.errors.push(`Event ${gEvent.id}: ${eventErr.message?.slice(0, 100)}`);
          }
        }

        const connectionUpdate: Record<string, any> = {
          last_synced: new Date().toISOString(),
          last_sync_count: googleEvents.length,
        };
        if (freshSyncToken) {
          connectionUpdate.next_sync_token = freshSyncToken;
        }
        await entities.CalendarConnection.update(connection.id, connectionUpdate);

      } catch (connErr: any) {
        errors.push({ account: connection.account_email, error: connErr.message });
        accountResult.errors.push(connErr.message);
        accountResult.status = 'error';
      }

      accountResults.push(accountResult);
    }

    // ── Retroactive reconciliation pass ──────────────────────────────────────
    let retroLinked = 0;
    if (autoLinkEnabled && projectByGoogleEventId.size > 0) {
      const unlinkedEvents = allExisting.filter((ev: any) =>
        ev.google_event_id && !ev.project_id && !ev.auto_linked
      );
      for (const ev of unlinkedEvents) {
        const matchedProject = projectByGoogleEventId.get(ev.google_event_id);
        if (!matchedProject) continue;
        const LINKABLE_STAGES = ['to_be_scheduled', 'scheduled', 'onsite', 'uploaded',
          'submitted', 'in_revision', 'in_production', 'delivered'];
        if (!LINKABLE_STAGES.includes(matchedProject.status)) continue;

        try {
          await entities.CalendarEvent.update(ev.id, {
            project_id: matchedProject.id,
            agent_id: matchedProject.agent_id || null,
            agency_id: matchedProject.agency_id || null,
            owner_user_id: matchedProject.project_owner_id || null,
            auto_linked: true,
            link_source: 'google_event_id_retroactive',
            link_confidence: 'exact',
          });
          if (!matchedProject.calendar_auto_linked) {
            await entities.Project.update(matchedProject.id, {
              calendar_auto_linked: true,
              calendar_link_source: 'google_event_id_retroactive',
            });
          }
          await writeCalendarAudit(entities, {
            action: 'retro_link',
            entity_id: matchedProject.id,
            operation: 'linked',
            tonomo_order_id: matchedProject.tonomo_order_id,
            notes: `Retroactive link: CalendarEvent ${ev.google_event_id} linked to project "${matchedProject.title}" — event was synced before project was created`,
          });
          retroLinked++;
        } catch (retroErr: any) {
          console.error('Retro link error:', retroErr.message);
        }
      }
    }

    return jsonResponse({
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

  } catch (error: any) {
    return errorResponse(error.message);
  }
});

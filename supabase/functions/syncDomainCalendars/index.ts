import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

// JWT generation for service account impersonation
async function generateServiceAccountJWT(serviceAccountEmail: string, privateKey: string, userEmail: string, scopes: string[]): Promise<string> {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: serviceAccountEmail,
    sub: userEmail, // impersonate this user
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };

  // Use Web Crypto API to sign JWT with RSA-SHA256
  const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const encodedClaim = btoa(JSON.stringify(claim)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const unsignedToken = `${encodedHeader}.${encodedClaim}`;

  // Import private key and sign
  const keyData = privateKey.replace(/-----BEGIN PRIVATE KEY-----/g, '').replace(/-----END PRIVATE KEY-----/g, '').replace(/\n/g, '');
  const binaryKey = Uint8Array.from(atob(keyData), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('pkcs8', binaryKey, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(unsignedToken));
  const encodedSig = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  return `${unsignedToken}.${encodedSig}`;
}

async function getAccessTokenForUser(serviceAccountEmail: string, privateKey: string, userEmail: string): Promise<string> {
  const jwt = await generateServiceAccountJWT(serviceAccountEmail, privateKey, userEmail, [
    'https://www.googleapis.com/auth/calendar.readonly'
  ]);

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed for ${userEmail}: ${err}`);
  }

  const data = await resp.json();
  return data.access_token;
}

serveWithAudit('syncDomainCalendars', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'syncDomainCalendars' });
    }

    // Auth: allow service-role (internal/cron calls) or authenticated users
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Load domain delegation config
    const settings = await entities.TonomoIntegrationSettings.list('-created_at', 1).catch(() => []);
    const config = settings?.[0]?.config || {};
    const serviceAccountJson = config.google_service_account_json;

    if (!serviceAccountJson) {
      return jsonResponse({ skipped: true, reason: 'No service account configured' });
    }

    let serviceAccount;
    try { serviceAccount = JSON.parse(serviceAccountJson); } catch {
      return errorResponse('Invalid service account JSON', 400);
    }

    // Get all @flexmedia.sydney users
    const allUsers = await entities.User.filter({ is_active: true });
    const domainUsers = allUsers.filter((u: any) => u.email?.endsWith('@flexmedia.sydney'));

    const results: any[] = [];
    const WALL_CLOCK_BUDGET = 25_000;
    const startTime = Date.now();

    for (const user of domainUsers) {
      if (Date.now() - startTime > WALL_CLOCK_BUDGET) {
        results.push({ email: 'BUDGET_EXCEEDED', remaining: domainUsers.length - results.length });
        break;
      }

      try {
        const accessToken = await getAccessTokenForUser(
          serviceAccount.client_email,
          serviceAccount.private_key,
          user.email
        );

        // Fetch calendar events
        const now = new Date();
        const timeMin = new Date(now.getTime() - 90 * 86400000).toISOString();
        const timeMax = new Date(now.getTime() + 365 * 86400000).toISOString();

        const calResp = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&maxResults=250`,
          { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(10_000) }
        );

        if (!calResp.ok) {
          results.push({ email: user.email, error: `Calendar API ${calResp.status}` });
          continue;
        }

        const calData = await calResp.json();
        const events = calData.items || [];
        let synced = 0;

        for (const gEvent of events) {
          if (gEvent.status === 'cancelled') continue;
          const eventStart = gEvent.start?.dateTime || gEvent.start?.date;
          const eventEnd = gEvent.end?.dateTime || gEvent.end?.date;
          if (!eventStart) continue;

          // Upsert calendar event
          const existing = await admin.from('calendar_events')
            .select('id')
            .eq('google_event_id', gEvent.id)
            .eq('owner_user_id', user.id)
            .maybeSingle();

          const eventData = {
            title: gEvent.summary || '(No title)',
            description: gEvent.description || '',
            start_time: eventStart,
            end_time: eventEnd || eventStart,
            location: gEvent.location || '',
            is_all_day: !!gEvent.start?.date,
            google_event_id: gEvent.id,
            event_source: 'google',
            owner_user_id: user.id,
            calendar_account: user.email,
            is_synced: true,
            attendees: JSON.stringify(gEvent.attendees || []),
          };

          if (existing?.data?.id) {
            await admin.from('calendar_events').update(eventData).eq('id', existing.data.id);
          } else {
            await admin.from('calendar_events').insert(eventData);
          }
          synced++;
        }

        // Ensure calendar_connection exists for this user
        const connExists = await admin.from('calendar_connections')
          .select('id')
          .eq('account_email', user.email)
          .eq('connection_type', 'domain_delegation')
          .maybeSingle();

        if (!connExists?.data?.id) {
          await admin.from('calendar_connections').insert({
            account_email: user.email,
            account_name: user.full_name || user.email,
            is_enabled: true,
            connection_type: 'domain_delegation',
            is_auto_connected: true,
            created_by: 'system',
            last_synced: new Date().toISOString(),
            last_sync_count: synced,
          });
        } else {
          await admin.from('calendar_connections')
            .update({ last_synced: new Date().toISOString(), last_sync_count: synced })
            .eq('id', connExists.data.id);
        }

        results.push({ email: user.email, synced });
      } catch (err: any) {
        results.push({ email: user.email, error: err.message });
      }
    }

    return jsonResponse({ success: true, users_processed: results.length, results });
  } catch (err: any) {
    console.error('syncDomainCalendars error:', err.message);
    return errorResponse(err.message, 500);
  }
});

import { handleCors, jsonResponse, errorResponse, getAdminClient, getUserFromReq } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('POST only', 405, req);

  try {
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401, req);

    // Resolve Google Maps API key (prefer GOOGLE_MAPS_API_KEY, fall back to GOOGLE_PLACES_API_KEY)
    const apiKey = Deno.env.get('GOOGLE_MAPS_API_KEY') || Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      return errorResponse(
        'Google Maps API key not configured. Set GOOGLE_MAPS_API_KEY or GOOGLE_PLACES_API_KEY in Supabase secrets.',
        500,
        req,
      );
    }

    const body = await req.json().catch(() => ({}));
    const agencyIds: string[] | undefined = body.agency_ids;

    const admin = getAdminClient();

    // ── Load agencies ────────────────────────────────────────────────────────
    let query = admin
      .from('agencies')
      .select('id, name, address, lat, lng');

    if (Array.isArray(agencyIds) && agencyIds.length > 0) {
      query = query.in('id', agencyIds);
    } else {
      // Only agencies with an address but missing coordinates
      query = query.not('address', 'is', null).or('lat.is.null,lng.is.null');
    }

    const { data: agencies, error: fetchErr } = await query;
    if (fetchErr) return errorResponse(`Failed to load agencies: ${fetchErr.message}`, 500, req);

    if (!agencies || agencies.length === 0) {
      return jsonResponse({ geocoded: 0, failed: 0, skipped: 0, details: [], message: 'No agencies to geocode' }, 200, req);
    }

    // ── Geocode each agency ──────────────────────────────────────────────────
    let geocoded = 0;
    let failed = 0;
    let skipped = 0;
    const details: Array<{ id: string; name: string; ok: boolean; reason?: string; lat?: number; lng?: number }> = [];

    for (const agency of agencies) {
      // Skip agencies without an address (possible when agency_ids provided explicitly)
      if (!agency.address) {
        skipped++;
        details.push({ id: agency.id, name: agency.name, ok: false, reason: 'no_address' });
        continue;
      }

      // Skip agencies that already have coordinates (possible when agency_ids provided explicitly)
      if (agency.lat != null && agency.lng != null && !Array.isArray(agencyIds)) {
        skipped++;
        details.push({ id: agency.id, name: agency.name, ok: false, reason: 'already_geocoded' });
        continue;
      }

      try {
        const address = encodeURIComponent(agency.address);
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&key=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const data = await res.json();

        if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
          const { lat, lng } = data.results[0].geometry.location;

          const { error: updateErr } = await admin
            .from('agencies')
            .update({ lat, lng })
            .eq('id', agency.id);

          if (updateErr) {
            failed++;
            details.push({ id: agency.id, name: agency.name, ok: false, reason: `db_update: ${updateErr.message}` });
          } else {
            geocoded++;
            details.push({ id: agency.id, name: agency.name, ok: true, lat, lng });
          }
        } else {
          failed++;
          details.push({ id: agency.id, name: agency.name, ok: false, reason: `google_status: ${data.status}` });
          console.warn(`Geocode failed for agency ${agency.id} (${agency.name}): ${data.status}`);
        }

        // Rate limit: 50ms delay between requests (Google allows 50 QPS)
        await new Promise((r) => setTimeout(r, 50));
      } catch (err: any) {
        failed++;
        details.push({ id: agency.id, name: agency.name, ok: false, reason: err.message });
        console.error(`Geocode error for agency ${agency.id} (${agency.name}):`, err.message);
      }
    }

    return jsonResponse({ geocoded, failed, skipped, details }, 200, req);
  } catch (err: any) {
    console.error('geocodeAgencies top-level error:', err.message);
    return errorResponse(err.message, 500, req);
  }
});

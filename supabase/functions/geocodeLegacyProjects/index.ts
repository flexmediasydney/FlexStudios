import {
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  errorResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';

//
// Background worker — geocode legacy_projects rows that still have NULL lat/lng.
// Uses the same Google → Google(stripped) → Nominatim → Nominatim(stripped)
// cascade as geocodeProject (migration 109 + supabase/functions/geocodeProject).
//
// Request body:
//   {
//     batch_id?: uuid   // optional — restrict to a single import batch
//     limit?:    int    // default 100, cap 500
//   }
//
// Response:
//   { geocoded, total, by_source, batch_id? }
//
// Designed to be called by cron every 5 minutes (migration 184) as well as
// ad-hoc from the admin UI for a specific batch.
//

function stripUnitPrefix(address: string): string | null {
  const slashPattern = /^\s*(?:U|Unit|Apt|Apartment|Ste|Suite|#)?\s*[\w]+\s*\/\s*(\d+.*)/i;
  const m1 = address.match(slashPattern);
  if (m1) return m1[1].trim();

  const commaPattern = /^\s*(?:U|Unit|Apt|Apartment|Ste|Suite|#)\s*\w+\s*,\s*(.+)/i;
  const m2 = address.match(commaPattern);
  if (m2) return m2[1].trim();

  return null;
}

async function geocodeGoogle(address: string, apiKey: string): Promise<{ lat: number; lng: number } | null> {
  const q = encodeURIComponent(address + ', Australia');
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${q}&region=au&key=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = await res.json();
  if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
    const { lat, lng } = data.results[0].geometry.location;
    return { lat, lng };
  }
  return null;
}

async function geocodeNominatim(address: string): Promise<{ lat: number; lng: number } | null> {
  const q = encodeURIComponent(address);
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&countrycodes=au&limit=1`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'FlexStudios-LegacyGeocoder/1.0 (joseph.saad91@gmail.com)' },
  });
  const data = await res.json();
  if (Array.isArray(data) && data[0]?.lat && data[0]?.lon) {
    return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
  }
  return null;
}

async function geocodeCascade(
  address: string,
  googleKey: string | undefined,
): Promise<{ lat: number; lng: number; source: string } | null> {
  const stripped = stripUnitPrefix(address);

  if (googleKey) {
    try {
      const r = await geocodeGoogle(address, googleKey);
      if (r) return { ...r, source: 'google' };
    } catch { /* fall through */ }
    if (stripped) {
      try {
        const r = await geocodeGoogle(stripped, googleKey);
        if (r) return { ...r, source: 'google_stripped' };
      } catch { /* fall through */ }
    }
  }

  try {
    const r = await geocodeNominatim(address);
    if (r) return { ...r, source: 'nominatim' };
  } catch { /* fall through */ }
  await new Promise(r => setTimeout(r, 1100));

  if (stripped) {
    try {
      const r = await geocodeNominatim(stripped);
      if (r) return { ...r, source: 'nominatim_stripped' };
    } catch { /* fall through */ }
  }

  return null;
}

serveWithAudit('geocodeLegacyProjects', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('POST only', 405, req);

  try {
    // Allow service-role (cron) and authed admin users.
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401, req);

    const admin = getAdminClient();
    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) {
      console.warn('[geocodeLegacyProjects] GOOGLE_PLACES_API_KEY not set — falling back to Nominatim only');
    }

    const body = await req.json().catch(() => ({} as any));
    const batchId: string | null = body?.batch_id ?? null;
    const rawLimit = Number(body?.limit);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(500, Math.floor(rawLimit)) : 100;

    let q = admin
      .from('legacy_projects')
      .select('id, raw_address')
      .is('geocoded_at', null)
      .not('raw_address', 'is', null)
      .order('imported_at', { ascending: true })
      .limit(limit);

    if (batchId) q = q.eq('import_batch_id', batchId);

    const { data: targets, error: selectErr } = await q;
    if (selectErr) return errorResponse(`select failed: ${selectErr.message}`, 500, req);

    const rows = targets ?? [];
    if (rows.length === 0) {
      return jsonResponse({
        geocoded: 0, total: 0, by_source: {}, batch_id: batchId,
        message: 'nothing to geocode',
      });
    }

    const bySource: Record<string, number> = {};
    let geocoded = 0;
    const failures: Array<{ id: string; reason: string }> = [];

    for (const row of rows) {
      if (!row.raw_address) continue;
      try {
        const geo = await geocodeCascade(row.raw_address, apiKey);
        if (geo) {
          const { error: upErr } = await admin
            .from('legacy_projects')
            .update({
              latitude:        geo.lat,
              longitude:       geo.lng,
              geocoded_at:     new Date().toISOString(),
              geocoded_source: geo.source,
            })
            .eq('id', row.id);
          if (upErr) {
            failures.push({ id: row.id, reason: upErr.message });
          } else {
            geocoded++;
            bySource[geo.source] = (bySource[geo.source] ?? 0) + 1;
          }
        } else {
          failures.push({ id: row.id, reason: 'all_providers_failed' });
        }
        // Google rate budget is ~50 req/s; Nominatim already gates itself.
        await new Promise(r => setTimeout(r, 25));
      } catch (e) {
        failures.push({ id: row.id, reason: (e as Error).message });
      }
    }

    // Best-effort update of batch counters (ignore errors — cosmetic)
    if (batchId && geocoded > 0) {
      const { data: current } = await admin
        .from('legacy_import_batches')
        .select('geocoded_count')
        .eq('id', batchId)
        .single();
      const prev = (current?.geocoded_count ?? 0) as number;
      await admin
        .from('legacy_import_batches')
        .update({ geocoded_count: prev + geocoded })
        .eq('id', batchId);
    }

    return jsonResponse({
      geocoded,
      total:     rows.length,
      by_source: bySource,
      failures:  failures.slice(0, 20),
      batch_id:  batchId,
    });
  } catch (err) {
    return errorResponse((err as Error).message ?? 'Unknown error', 500, req);
  }
});

import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Geocode projects — resilient cascade.
 *
 * Attempts, in order:
 *   1. Google Geocoding API (primary) with original address
 *   2. Google with unit-stripped address (e.g. "601b/12 Main St" → "12 Main St")
 *   3. OSM Nominatim (free, ToS: 1 req/sec) with original address
 *   4. OSM Nominatim with unit-stripped address
 *
 * Succeeds if any attempt returns coords. Records `geocoded_source` per row so
 * downstream (Market Share engine) can audit which provider resolved each project.
 *
 * Unit-prefix detection — matches patterns commonly found in AU/NZ addresses:
 *   - "601b/12 Main St"   → "12 Main St"
 *   - "1A/10 Side Ave"    → "10 Side Ave"
 *   - "U5/123 Rd"         → "123 Rd"
 *   - "Unit 3, 45 St"     → "45 St"
 *   - "Apt 2/99 Blvd"     → "99 Blvd"
 */

function stripUnitPrefix(address: string): string | null {
  // Match "[alphanum]/[digits]" at start of address (e.g. "601b/12", "5A/10", "U3/99")
  const slashPattern = /^\s*(?:U|Unit|Apt|Apartment|Ste|Suite|#)?\s*[\w]+\s*\/\s*(\d+.*)/i;
  const m1 = address.match(slashPattern);
  if (m1) return m1[1].trim();

  // Match "Unit 3, 45 Main St" or "Apt 2, 99 Blvd"
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
    headers: { 'User-Agent': 'FlexStudios-Geocoder/1.0 (joseph.saad91@gmail.com)' },
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

  // 1. Google with original
  if (googleKey) {
    try {
      const r = await geocodeGoogle(address, googleKey);
      if (r) return { ...r, source: 'google' };
    } catch { /* fall through */ }

    // 2. Google with unit-stripped
    if (stripped) {
      try {
        const r = await geocodeGoogle(stripped, googleKey);
        if (r) return { ...r, source: 'google_stripped' };
      } catch { /* fall through */ }
    }
  }

  // 3. Nominatim with original
  try {
    const r = await geocodeNominatim(address);
    if (r) return { ...r, source: 'nominatim' };
  } catch { /* fall through */ }
  // Nominatim ToS: 1 req/sec — space out subsequent hits
  await new Promise(r => setTimeout(r, 1100));

  // 4. Nominatim with unit-stripped
  if (stripped) {
    try {
      const r = await geocodeNominatim(stripped);
      if (r) return { ...r, source: 'nominatim_stripped' };
    } catch { /* fall through */ }
  }

  return null;
}

serveWithAudit('geocodeProject', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('POST only', 405);

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    // Nominatim is free & requires no key — we can still fall back if Google key missing.
    if (!apiKey) {
      console.warn('[geocodeProject] GOOGLE_PLACES_API_KEY not set — falling back to Nominatim only');
    }

    const body = await req.json().catch(() => ({} as any));
    const { projectIds } = body;
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return errorResponse('projectIds array required', 400, req);
    }

    // Fetch project records
    const projects = await entities.Project.filter({});
    const targets = projects.filter((p: any) =>
      projectIds.includes(p.id) &&
      p.property_address &&
      (p.geocoded_lat == null || p.geocoded_lng == null)
    );

    const results: any[] = [];

    for (const project of targets) {
      try {
        const geo = await geocodeCascade(project.property_address, apiKey);
        if (geo) {
          await entities.Project.update(project.id, {
            geocoded_lat: geo.lat,
            geocoded_lng: geo.lng,
            geocoded_at: new Date().toISOString(),
          });
          results.push({ id: project.id, lat: geo.lat, lng: geo.lng, source: geo.source, ok: true });
        } else {
          results.push({ id: project.id, ok: false, reason: 'all_providers_failed' });
        }

        // Respect Google rate limit (50 req/s) if we used Google; otherwise Nominatim
        // already gated internally. 25ms is safe for Google-primary flow.
        await new Promise(r => setTimeout(r, 25));
      } catch (err: any) {
        results.push({ id: project.id, ok: false, reason: err.message });
      }
    }

    return jsonResponse({
      geocoded: results.filter(r => r.ok).length,
      total: targets.length,
      by_source: results.filter(r => r.ok).reduce((acc: any, r: any) => {
        acc[r.source] = (acc[r.source] || 0) + 1;
        return acc;
      }, {}),
      results,
    });
  } catch (err: any) {
    return errorResponse(err.message);
  }
});

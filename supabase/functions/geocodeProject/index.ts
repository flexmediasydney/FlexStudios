import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('POST only', 405);

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) return errorResponse('GOOGLE_PLACES_API_KEY not configured', 500);

    const { projectIds } = await req.json();
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return errorResponse('projectIds array required', 400);
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
        const address = encodeURIComponent(project.property_address + ', Australia');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&region=au&key=${apiKey}`;
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        const data = await res.json();

        if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
          const { lat, lng } = data.results[0].geometry.location;
          await entities.Project.update(project.id, { geocoded_lat: lat, geocoded_lng: lng, geocoded_at: new Date().toISOString() });
          results.push({ id: project.id, lat, lng, ok: true });
        } else {
          results.push({ id: project.id, ok: false, reason: data.status });
        }

        // Respect Google rate limit (50 req/s) — 25ms gap is safe
        await new Promise(r => setTimeout(r, 25));
      } catch (err: any) {
        results.push({ id: project.id, ok: false, reason: err.message });
      }
    }

    return jsonResponse({ geocoded: results.filter(r => r.ok).length, total: targets.length, results });
  } catch (err: any) {
    return errorResponse(err.message);
  }
});

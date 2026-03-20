import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return Response.json({ error: 'POST only' }, { status: 405 });

  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });

    const apiKey = Deno.env.get('GOOGLE_PLACES_API_KEY');
    if (!apiKey) return Response.json({ error: 'GOOGLE_PLACES_API_KEY not configured' }, { status: 500 });

    const { projectIds } = await req.json();
    if (!Array.isArray(projectIds) || projectIds.length === 0) {
      return Response.json({ error: 'projectIds array required' }, { status: 400 });
    }

    // Fetch project records
    const projects = await base44.asServiceRole.entities.Project.filter({});
    const targets = projects.filter((p: any) =>
      projectIds.includes(p.id) &&
      p.property_address &&
      (p.lat == null || p.lng == null)
    );

    const results: any[] = [];

    for (const project of targets) {
      try {
        // Bias to Australia
        const address = encodeURIComponent(project.property_address + ', Australia');
        const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${address}&region=au&key=${apiKey}`;
        const res = await fetch(url);
        const data = await res.json();

        if (data.status === 'OK' && data.results?.[0]?.geometry?.location) {
          const { lat, lng } = data.results[0].geometry.location;
          await base44.asServiceRole.entities.Project.update(project.id, { lat, lng });
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

    return Response.json({ geocoded: results.filter(r => r.ok).length, total: targets.length, results });
  } catch (err: any) {
    return Response.json({ error: err.message }, { status: 500 });
  }
});
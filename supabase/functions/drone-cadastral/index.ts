/**
 * drone-cadastral
 * ───────────────
 * POST { project_id, refresh?: boolean }
 *   → { success, polygon: [{lat,lng}], lot_label, plan_label, area_sqm,
 *       perimeter_m, source, cached, fetched_at }
 *
 * Fetches the cadastral lot polygon for a project's property from the NSW
 * Spatial REST API (DCDB layer). Results are cached in drone_cadastral_cache
 * for 30 days — cadastral CAN change after subdivisions/registrations so we
 * don't cache forever.
 *
 * Source: NSW Spatial Services public API
 *   https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9
 *
 * Architecture:
 *   1. Fetch project + property coord (confirmed_lat/lng OR geocoded_lat/lng).
 *   2. If !refresh and an active cache row exists, return it.
 *   3. Else: query NSW Cadastre layer 9 (Lot) via point-intersect against
 *      the property coord (the layer has no address field — only lot/plan
 *      attributes — so a coord-based query is the canonical path).
 *      If multiple lots match (e.g. stratum/multi-tier), pick the one whose
 *      centroid is closest to property_coord. Compute area + perimeter from
 *      polygon directly. Persist cache row.
 *
 * Auth: same as drone-pois — any authenticated user with project visibility.
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  getUserClient,
  getAdminClient,
  serveWithAudit,
} from '../_shared/supabase.ts';

const GENERATOR = 'drone-cadastral';

// ─── Configuration ────────────────────────────────────────────────────────────

const CACHE_TTL_DAYS = 30;

// NSW DCDB cadastral lot layer (MapServer/9 = "Lot").
// Field names per the layer schema: lotnumber, sectionnumber, plannumber,
// planlabel, lotidstring, etc. We request all attrs; downstream we read what
// we need.
const NSW_CADASTRE_QUERY_URL =
  'https://maps.six.nsw.gov.au/arcgis/rest/services/public/NSW_Cadastre/MapServer/9/query';

// ─── Types ────────────────────────────────────────────────────────────────────

interface LatLng {
  lat: number;
  lng: number;
}

interface GeoJsonFeature {
  type: 'Feature';
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    // GeoJSON ring coords are [lng, lat]
    coordinates: number[][][] | number[][][][];
  };
  properties: Record<string, unknown> | null;
}

interface GeoJsonResponse {
  type?: 'FeatureCollection';
  features?: GeoJsonFeature[];
  error?: { message?: string };
}

interface ParsedFeature {
  polygon: LatLng[];
  centroid: LatLng;
  area_sqm: number;
  perimeter_m: number;
  lot_label: string | null;
  plan_label: string | null;
  raw_attributes: Record<string, unknown>;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Haversine distance in metres. Used for centroid disambiguation. */
function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Compute polygon area in square metres using the equirectangular projection
 * approximation around the polygon's centroid (sufficient for property-scale
 * lots — error is ~0.1% over a few hundred metres).
 */
function polygonAreaSqm(ring: LatLng[]): number {
  if (ring.length < 3) return 0;
  const meanLat = ring.reduce((s, p) => s + p.lat, 0) / ring.length;
  const cosMeanLat = Math.cos((meanLat * Math.PI) / 180);
  // Convert to local metres
  const xy = ring.map((p) => ({
    x: (p.lng * Math.PI) / 180 * 6371000 * cosMeanLat,
    y: (p.lat * Math.PI) / 180 * 6371000,
  }));
  // Shoelace
  let sum = 0;
  for (let i = 0; i < xy.length; i++) {
    const j = (i + 1) % xy.length;
    sum += xy[i].x * xy[j].y - xy[j].x * xy[i].y;
  }
  return Math.abs(sum) / 2;
}

/** Compute polygon perimeter in metres. Closed polygon assumed. */
function polygonPerimeterM(ring: LatLng[]): number {
  if (ring.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < ring.length; i++) {
    const j = (i + 1) % ring.length;
    total += haversineMetres(ring[i].lat, ring[i].lng, ring[j].lat, ring[j].lng);
  }
  return total;
}

/** Centroid (arithmetic mean of vertices — fine for nearly-convex small lots). */
function polygonCentroid(ring: LatLng[]): LatLng {
  const sum = ring.reduce(
    (acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }),
    { lat: 0, lng: 0 },
  );
  return { lat: sum.lat / ring.length, lng: sum.lng / ring.length };
}

/**
 * Normalise a property address for the LIKE filter on NSW DCDB.
 *
 * The NSW Cadastre layer carries free-text addresses. We strip:
 *   - Single quotes (would break the SQL-style WHERE)
 *   - Leading unit prefixes ("3/12 Main St" → "12 Main St")
 *   - Trailing state/postcode (matches AU pattern: NSW 2000 / NSW 2065)
 *   - "Australia" suffix
 *
 * Returns the cleaned street-address portion suitable for a `LIKE '%...%'`
 * match (case-insensitive).
 */
function normaliseAddress(rawAddress: string): string {
  if (!rawAddress) return '';
  let a = String(rawAddress).trim();

  // Strip "Australia" suffix (case-insensitive)
  a = a.replace(/,?\s*australia\s*$/i, '');

  // Strip trailing state + postcode (NSW 2000 / NSW, 2000 / NSW 2065)
  a = a.replace(/,?\s*(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*,?\s*\d{4}\s*$/i, '');

  // Strip unit prefix "3/12" / "U3/12" / "5A/10" / "Unit 3, 12"
  a = a.replace(/^[A-Z]?\d+[A-Z]?\/(?=\d)/i, '');
  a = a.replace(/^unit\s+\d+\s*,\s*/i, '');

  // Drop anything after the first comma (suburb, etc.) — we'll match street only.
  // Cadastre layer's address field varies by region; safest is street + number.
  const firstComma = a.indexOf(',');
  if (firstComma > 0) a = a.slice(0, firstComma);

  // Strip single quotes (SQL safety) and collapse whitespace
  a = a.replace(/'/g, '').replace(/\s+/g, ' ').trim();
  return a;
}

/** Parse a single GeoJSON feature into our ParsedFeature shape. */
function parseFeature(feat: GeoJsonFeature): ParsedFeature | null {
  if (!feat?.geometry) return null;

  // Pick the largest ring of the largest polygon if MultiPolygon (the lot's
  // exterior). Cadastre data is almost always a simple Polygon though.
  let exterior: number[][] | null = null;
  if (feat.geometry.type === 'Polygon') {
    const coords = feat.geometry.coordinates as number[][][];
    exterior = coords?.[0] ?? null;
  } else if (feat.geometry.type === 'MultiPolygon') {
    const coords = feat.geometry.coordinates as number[][][][];
    if (!coords || coords.length === 0) return null;
    let largestRing: number[][] | null = null;
    let largestArea = 0;
    for (const poly of coords) {
      const ring = poly?.[0];
      if (!ring) continue;
      const ll: LatLng[] = ring.map((c) => ({ lat: c[1], lng: c[0] }));
      const a = polygonAreaSqm(ll);
      if (a > largestArea) {
        largestArea = a;
        largestRing = ring;
      }
    }
    exterior = largestRing;
  }

  if (!exterior || exterior.length < 3) return null;

  // [lng, lat] → { lat, lng }; drop closing duplicate vertex if present.
  const polygon: LatLng[] = exterior.map((c) => ({ lat: c[1], lng: c[0] }));
  if (
    polygon.length > 1 &&
    polygon[0].lat === polygon[polygon.length - 1].lat &&
    polygon[0].lng === polygon[polygon.length - 1].lng
  ) {
    polygon.pop();
  }

  const props = feat.properties ?? {};
  const propLower: Record<string, unknown> = {};
  for (const k of Object.keys(props)) propLower[k.toLowerCase()] = (props as Record<string, unknown>)[k];

  // Lot/plan extraction — robust against either case-style.
  const lot_label = (propLower['lotnumber'] ?? propLower['lot'] ?? null) as string | null;
  const planNumber =
    (propLower['plannumber'] ?? propLower['planlabel'] ?? propLower['plan'] ?? null) as
      | string
      | null;
  const planType = (propLower['planlabel'] ?? propLower['plantype'] ?? null) as string | null;
  let plan_label: string | null = null;
  if (planNumber != null) {
    const planStr = String(planNumber).trim();
    // If planlabel already includes the prefix (DP12345), use as-is; else add DP/SP prefix
    if (/^[A-Z]+\d+/i.test(planStr)) {
      plan_label = planStr.toUpperCase();
    } else if (planType && /^[A-Z]+/i.test(String(planType))) {
      plan_label = `${String(planType).toUpperCase().replace(/[^A-Z]/g, '')}${planStr}`;
    } else {
      plan_label = `DP${planStr}`;
    }
  }

  return {
    polygon,
    centroid: polygonCentroid(polygon),
    area_sqm: polygonAreaSqm(polygon),
    perimeter_m: polygonPerimeterM(polygon),
    lot_label: lot_label != null ? String(lot_label) : null,
    plan_label,
    raw_attributes: props as Record<string, unknown>,
  };
}

/**
 * Query NSW Cadastre layer 9 by point-intersect — given the property's
 * lat/lng, return the lot whose polygon contains that point. This is the
 * primary strategy and is what the spike used (post-investigation, the lot
 * layer has NO `address` field — only lotnumber, sectionnumber, plannumber,
 * planlabel, lotidstring; hence we cannot do an `address LIKE` filter
 * directly on layer 9).
 *
 * Layer 9 fields (verified live):
 *   objectid, shape, cadid, createdate, modifieddate, controllingauthorityoid,
 *   planoid, plannumber (int), planlabel (string, e.g. "DP1588"),
 *   itstitlestatus, itslotid, stratumlevel, hasstratum, classsubtype,
 *   lotnumber (string), sectionnumber, planlotarea (double),
 *   planlotareaunits, startdate, enddate, lastupdate, msoid, centroidid,
 *   shapeuuid, changetype, lotidstring (e.g. "14/2/DP1588"), processstate,
 *   urbanity, shape_Length, shape_Area
 */
async function queryCadastreByPoint(
  lat: number,
  lng: number,
): Promise<GeoJsonFeature[]> {
  const url = new URL(NSW_CADASTRE_QUERY_URL);
  url.searchParams.set('geometry', `${lng},${lat}`);
  url.searchParams.set('geometryType', 'esriGeometryPoint');
  url.searchParams.set('inSR', '4326');
  url.searchParams.set('spatialRel', 'esriSpatialRelIntersects');
  url.searchParams.set('outFields', '*');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  url.searchParams.set('returnGeometry', 'true');

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'flexmedia-drone-cadastral/1.0' },
  });
  if (!res.ok) {
    console.warn(`[${GENERATOR}] NSW DCDB HTTP ${res.status}`);
    return [];
  }
  const json = (await res.json().catch(() => null)) as GeoJsonResponse | null;
  if (!json) return [];
  if (json.error) {
    console.warn(`[${GENERATOR}] NSW DCDB error: ${json.error.message ?? 'unknown'}`);
    return [];
  }
  return Array.isArray(json.features) ? json.features : [];
}

/**
 * Fallback: query NSW Cadastre layer 9 by lotidstring LIKE filter, useful
 * when we have a parsed lot/plan label rather than a coord. Not currently
 * wired up but kept here for the future "operator pastes lot/DP" path.
 */
async function queryCadastreByLotIdString(lotIdString: string): Promise<GeoJsonFeature[]> {
  const safe = lotIdString.replace(/'/g, '').toUpperCase();
  const where = `UPPER(lotidstring) LIKE '%${safe}%'`;
  const url = new URL(NSW_CADASTRE_QUERY_URL);
  url.searchParams.set('where', where);
  url.searchParams.set('outFields', '*');
  url.searchParams.set('outSR', '4326');
  url.searchParams.set('f', 'geojson');
  url.searchParams.set('returnGeometry', 'true');
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'flexmedia-drone-cadastral/1.0' },
  });
  if (!res.ok) return [];
  const json = (await res.json().catch(() => null)) as GeoJsonResponse | null;
  if (!json || json.error) return [];
  return Array.isArray(json.features) ? json.features : [];
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  let body: { project_id?: string; refresh?: boolean; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.project_id) return errorResponse('project_id required', 400, req);

  // Authz mirroring drone-pois / getProjectFolderFiles
  const isPrivileged = ['master_admin', 'admin'].includes(user.role || '');
  const isService = user.id === '__service_role__';
  if (!isPrivileged && !isService) {
    const userClient = getUserClient(req);
    const { data: visibleProject, error: rlsErr } = await userClient
      .from('projects')
      .select('id')
      .eq('id', body.project_id)
      .maybeSingle();
    if (rlsErr) {
      console.error(`[${GENERATOR}] RLS check failed:`, rlsErr.message);
      return errorResponse('Project access check failed', 500, req);
    }
    if (!visibleProject) return errorResponse('Forbidden — project not visible', 403, req);
  }

  const admin = getAdminClient();

  // 1. Fetch project + property coord
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, property_address, confirmed_lat, confirmed_lng, geocoded_lat, geocoded_lng')
    .eq('id', body.project_id)
    .maybeSingle();
  if (projErr || !project) {
    return errorResponse(`Project not found: ${projErr?.message ?? 'unknown'}`, 404, req);
  }

  const propertyLat = Number(project.confirmed_lat ?? project.geocoded_lat);
  const propertyLng = Number(project.confirmed_lng ?? project.geocoded_lng);
  if (!Number.isFinite(propertyLat) || !Number.isFinite(propertyLng)) {
    return errorResponse(
      'Project has no property coordinates (confirmed_lat/lng or geocoded_lat/lng required)',
      400,
      req,
    );
  }

  // address_query is preserved for cache attribution / debugging; primary
  // matching is by point-intersect on the property coord.
  const rawAddress = String(project.property_address ?? '').trim();
  const addressQuery = normaliseAddress(rawAddress) || `point:${propertyLat},${propertyLng}`;

  // 2. Cache hit?
  if (!body.refresh) {
    const { data: cached } = await admin
      .from('drone_cadastral_cache')
      .select('*')
      .eq('project_id', body.project_id)
      .gt('expires_at', new Date().toISOString())
      .order('fetched_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (cached) {
      return jsonResponse(
        {
          success: true,
          cached: true,
          polygon: cached.polygon,
          lot_label: cached.lot_label,
          plan_label: cached.plan_label,
          area_sqm: cached.area_sqm,
          perimeter_m: cached.perimeter_m,
          source: cached.source,
          fetched_at: cached.fetched_at,
          expires_at: cached.expires_at,
          address_query: cached.address_query,
        },
        200,
        req,
      );
    }
  }

  // 3. Cache miss — query NSW DCDB.
  // Primary strategy: point-intersect on (propertyLng, propertyLat). Layer 9
  // (Lot) has NO address field — only lotnumber/plannumber/planlabel — so a
  // text LIKE filter on `address` returns nothing. Spatial intersect against
  // the geocoded property coord is the spike-validated path.
  let features: GeoJsonFeature[];
  try {
    features = await queryCadastreByPoint(propertyLat, propertyLng);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] NSW DCDB fetch failed:`, msg);
    return errorResponse(`NSW DCDB query failed: ${msg}`, 502, req);
  }

  if (features.length === 0) {
    return jsonResponse(
      {
        success: false,
        error: 'no_features',
        message: `No NSW cadastral lot found at point ${propertyLat},${propertyLng} (address: "${addressQuery}")`,
        address_query: addressQuery,
      },
      404,
      req,
    );
  }

  // Parse all features; pick the one whose centroid is closest to property.
  const parsed: ParsedFeature[] = [];
  for (const f of features) {
    const p = parseFeature(f);
    if (p) parsed.push(p);
  }
  if (parsed.length === 0) {
    return errorResponse('NSW DCDB returned features without parseable polygons', 502, req);
  }

  parsed.sort(
    (a, b) =>
      haversineMetres(propertyLat, propertyLng, a.centroid.lat, a.centroid.lng) -
      haversineMetres(propertyLat, propertyLng, b.centroid.lat, b.centroid.lng),
  );
  const chosen = parsed[0];

  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

  // 4. Persist cache row
  const { error: insertErr } = await admin.from('drone_cadastral_cache').insert({
    project_id: body.project_id,
    property_lat: propertyLat,
    property_lng: propertyLng,
    address_query: addressQuery,
    fetched_at: fetchedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    source: 'nsw_dcdb',
    polygon: chosen.polygon,
    lot_label: chosen.lot_label,
    plan_label: chosen.plan_label,
    area_sqm: Math.round(chosen.area_sqm * 100) / 100,
    perimeter_m: Math.round(chosen.perimeter_m * 100) / 100,
    raw_attributes: chosen.raw_attributes,
  });
  if (insertErr) {
    console.warn(`[${GENERATOR}] cache insert failed: ${insertErr.message}`);
  }

  return jsonResponse(
    {
      success: true,
      cached: false,
      polygon: chosen.polygon,
      lot_label: chosen.lot_label,
      plan_label: chosen.plan_label,
      area_sqm: Math.round(chosen.area_sqm * 100) / 100,
      perimeter_m: Math.round(chosen.perimeter_m * 100) / 100,
      source: 'nsw_dcdb',
      fetched_at: fetchedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      address_query: addressQuery,
      candidate_count: parsed.length,
    },
    200,
    req,
  );
});

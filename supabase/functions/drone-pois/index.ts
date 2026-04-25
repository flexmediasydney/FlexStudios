/**
 * drone-pois
 * ──────────
 * POST { project_id, refresh?: boolean, radius_m?: number }
 *   → { success, pois: [...], cached: boolean, fetched_at, source, total_count }
 *
 * Fetches Points-of-Interest near a project's property location, using Google
 * Places Nearby Search. Results are cached for 30 days in drone_pois_cache to
 * keep both API cost and latency low (~$0.03 / property uncached, ~0ms cached).
 *
 * Architecture:
 *   1. Fetch project; resolve property_coord = confirmed_lat/lng OR geocoded_lat/lng.
 *   2. If !refresh and an active cache row exists for this project, return it.
 *   3. Else: call Google Places Nearby Search once per type (parallelised),
 *      merge + dedupe by place_id, curate per type quotas, sort by distance
 *      within type, persist new cache row.
 *
 * POI types & quotas come from IMPLEMENTATION_PLAN_V2 §3.3 poi_selection.
 *
 * Auth: any authenticated user (same pattern as getProjectFolderFiles).
 *   - master_admin / admin: any project
 *   - other roles: project must be visible via existing `projects` RLS
 *
 * Deployed verify_jwt=false; we do our own auth via getUserFromReq.
 *
 * Google Places API key: tried via env first (GOOGLE_PLACES_API_KEY), with a
 * fallback to vault.decrypted_secrets if env missing. The key is never echoed
 * to logs or response bodies.
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

const GENERATOR = 'drone-pois';

// ─── Configuration (from IMPLEMENTATION_PLAN_V2 §3.3 + §2.5) ──────────────────

const DEFAULT_RADIUS_M = 3500;
const MIN_RADIUS_M = 250;
const MAX_RADIUS_M = 50000; // Google Places hard limit
const CACHE_TTL_DAYS = 30;

// Google Places types we query (one Nearby Search call per type, parallelised).
const POI_TYPES = [
  'train_station',
  'school',
  'hospital',
  'university',
  'shopping_mall',
  'park',
  'beach',
  'stadium',
  'tourist_attraction',
] as const;
type PoiType = typeof POI_TYPES[number];

// Per-type max counts after de-dup + distance sort. Mirrors Implementation
// Plan §3.3 type_quotas exactly.
const TYPE_QUOTAS: Record<PoiType, number> = {
  train_station: 4,
  hospital: 3,
  university: 3,
  school: 2,
  park: 3,
  beach: 3,
  shopping_mall: 3,
  stadium: 2,
  tourist_attraction: 2,
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface CuratedPoi {
  place_id: string;
  name: string;
  type: PoiType;
  lat: number;
  lng: number;
  distance_m: number;
  rating?: number;
  user_ratings_total?: number;
}

interface GooglePlacesResult {
  place_id: string;
  name: string;
  geometry: { location: { lat: number; lng: number } };
  rating?: number;
  user_ratings_total?: number;
  types?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Haversine distance in metres between two WGS84 coordinates. */
function haversineMetres(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000; // Earth radius in metres
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Resolve the Google Places API key.
 *   1. Env var GOOGLE_PLACES_API_KEY (preferred — set via supabase secrets).
 *   2. Fallback: vault.decrypted_secrets via the admin client.
 *
 * Returns null if neither source has the key. The key is NEVER logged.
 */
async function resolveGooglePlacesKey(): Promise<string | null> {
  const fromEnv = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (fromEnv && fromEnv.length > 10) return fromEnv;

  // Fallback to vault — only used if env wasn't propagated.
  try {
    const admin = getAdminClient();
    const { data, error } = await admin
      .from('vault.decrypted_secrets')
      .select('decrypted_secret')
      .eq('name', 'google_places_api_key')
      .limit(1)
      .single();
    if (error) return null;
    const secret = (data as { decrypted_secret?: string } | null)?.decrypted_secret;
    return secret && secret.length > 10 ? secret : null;
  } catch {
    return null;
  }
}

/**
 * Single Google Places Nearby Search call for one type.
 * Returns raw results; caller dedupes and curates.
 */
async function fetchPoisOfType(
  apiKey: string,
  lat: number,
  lng: number,
  radiusM: number,
  type: PoiType,
): Promise<GooglePlacesResult[]> {
  // We use the legacy Places API (Nearby Search) — it's still recommended for
  // simple geo-radius queries and matches the cost model in the plan. The
  // newer Places API (New) requires a different request shape and IAM dance
  // we don't need here.
  const url = new URL('https://maps.googleapis.com/maps/api/place/nearbysearch/json');
  url.searchParams.set('location', `${lat},${lng}`);
  url.searchParams.set('radius', String(radiusM));
  url.searchParams.set('type', type);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) {
    // Surface non-2xx but don't leak the key from the URL.
    console.warn(`[${GENERATOR}] Places ${type} HTTP ${res.status}`);
    return [];
  }
  const json = await res.json().catch(() => null);
  if (!json) return [];

  // Google reports per-call status — OK / ZERO_RESULTS / INVALID_REQUEST / OVER_QUERY_LIMIT / REQUEST_DENIED / UNKNOWN_ERROR
  const status = json.status as string | undefined;
  if (status === 'ZERO_RESULTS') return [];
  if (status && status !== 'OK') {
    // We log status but never the key. error_message often hints at quota / billing.
    console.warn(
      `[${GENERATOR}] Places ${type} status=${status} message=${json.error_message ?? ''}`,
    );
    return [];
  }

  const results = Array.isArray(json.results) ? (json.results as GooglePlacesResult[]) : [];
  return results;
}

/**
 * Curate POIs:
 *   1. Compute distance to property for each.
 *   2. Group by source type (the type we used to query, NOT result.types).
 *   3. Sort each group by distance ascending.
 *   4. Truncate to TYPE_QUOTAS[type].
 *   5. Return flattened, sorted by distance globally.
 *
 * Dedup is done BEFORE this step (place_id-keyed) so a single place that's
 * both a "shopping_mall" and a "tourist_attraction" only appears once and
 * counts against the first type that surfaced it.
 */
function curate(
  byType: Map<PoiType, GooglePlacesResult[]>,
  propertyLat: number,
  propertyLng: number,
): CuratedPoi[] {
  const out: CuratedPoi[] = [];

  for (const [type, results] of byType) {
    const quota = TYPE_QUOTAS[type];
    const enriched = results.map<CuratedPoi>((r) => ({
      place_id: r.place_id,
      name: r.name,
      type,
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      distance_m: Math.round(
        haversineMetres(propertyLat, propertyLng, r.geometry.location.lat, r.geometry.location.lng),
      ),
      rating: r.rating,
      user_ratings_total: r.user_ratings_total,
    }));
    // Sort within type by distance ascending, then quota
    enriched.sort((a, b) => a.distance_m - b.distance_m);
    out.push(...enriched.slice(0, quota));
  }

  // Final ordering for caller convenience: closest first across all types.
  out.sort((a, b) => a.distance_m - b.distance_m);
  return out;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  if (!user) return errorResponse('Authentication required', 401, req);

  let body: { project_id?: string; refresh?: boolean; radius_m?: number; _health_check?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }

  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  if (!body.project_id) return errorResponse('project_id required', 400, req);

  const radiusM = (() => {
    const r = Number(body.radius_m);
    if (!Number.isFinite(r) || r <= 0) return DEFAULT_RADIUS_M;
    return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, Math.round(r)));
  })();

  // Authz: master_admin/admin always; others must have RLS visibility.
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

  // 2. Cache hit?
  if (!body.refresh) {
    const { data: cached } = await admin
      .from('drone_pois_cache')
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
          pois: cached.pois,
          total_count: cached.total_count,
          fetched_at: cached.fetched_at,
          expires_at: cached.expires_at,
          source: cached.source,
          radius_m: cached.radius_m,
        },
        200,
        req,
      );
    }
  }

  // 3. Cache miss — fetch live.
  const apiKey = await resolveGooglePlacesKey();
  if (!apiKey) {
    return errorResponse(
      'Google Places API key not configured (env GOOGLE_PLACES_API_KEY or vault.google_places_api_key)',
      500,
      req,
    );
  }

  // Parallelise the per-type calls. Failures isolate to that type.
  const settled = await Promise.allSettled(
    POI_TYPES.map((t) => fetchPoisOfType(apiKey, propertyLat, propertyLng, radiusM, t)),
  );

  // De-dup by place_id BEFORE bucketing — first hit wins its type assignment.
  const seenPlaceIds = new Set<string>();
  const byType = new Map<PoiType, GooglePlacesResult[]>();
  for (let i = 0; i < POI_TYPES.length; i++) {
    const type = POI_TYPES[i];
    const settle = settled[i];
    if (settle.status !== 'fulfilled') {
      console.warn(`[${GENERATOR}] Places ${type} rejected:`, (settle.reason as Error)?.message);
      continue;
    }
    const arr = byType.get(type) ?? [];
    for (const r of settle.value) {
      if (!r?.place_id || seenPlaceIds.has(r.place_id)) continue;
      seenPlaceIds.add(r.place_id);
      arr.push(r);
    }
    byType.set(type, arr);
  }

  const curated = curate(byType, propertyLat, propertyLng);

  // 4. Persist cache row (soft-replace — keep history rows but partial index
  //    means lookups only see the active one).
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { error: insertErr } = await admin.from('drone_pois_cache').insert({
    project_id: body.project_id,
    property_lat: propertyLat,
    property_lng: propertyLng,
    radius_m: radiusM,
    fetched_at: fetchedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    source: 'google_places',
    pois: curated,
    total_count: curated.length,
  });
  if (insertErr) {
    // Cache write failure is non-fatal — return live data anyway.
    console.warn(`[${GENERATOR}] cache insert failed: ${insertErr.message}`);
  }

  return jsonResponse(
    {
      success: true,
      cached: false,
      pois: curated,
      total_count: curated.length,
      fetched_at: fetchedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
      source: 'google_places',
      radius_m: radiusM,
    },
    200,
    req,
  );
});

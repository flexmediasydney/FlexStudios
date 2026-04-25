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
 * Google Places API key: read from env GOOGLE_PLACES_API_KEY (set via
 * `supabase secrets set`). The key is never echoed to logs or response bodies.
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

// Google Places types the function understands. The set below is the
// universe — actual per-request POI_TYPES is derived from the body's
// type_quotas (or falls back to POI_TYPES_DEFAULT below). Renamed from
// POI_TYPES → POI_TYPES_DEFAULT so the constant's role as a fallback is
// explicit at the call sites.
const POI_TYPES_DEFAULT = [
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
type PoiType = typeof POI_TYPES_DEFAULT[number];

const POI_TYPES_DEFAULT_SET = new Set<string>(POI_TYPES_DEFAULT);

// Per-type max counts for the legacy / no-type_quotas path. Mirrors the
// historical Implementation Plan §3.3 quotas. Themed requests carry their
// own per-type max via the body — see resolveTypeQuotas below.
const TYPE_QUOTAS_DEFAULT: Record<PoiType, number> = {
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

// Legacy aliases coming in from older theme docs (the seeded JSON used
// 'shopping' / 'train' before migration 246 canonicalised them). Normalise
// on ingest so the ThemeEditor → drone-render → drone-pois path is robust
// to mixed-version themes during the rollout window.
const LEGACY_ALIAS: Record<string, string> = {
  shopping: 'shopping_mall',
  train: 'train_station',
};

type TypeQuotaInput = Record<string, { priority?: number; max?: number }>;

interface ResolvedTypeQuotas {
  /** The actual set of POI types to query Google Places for, in iteration order. */
  types: PoiType[];
  /** Per-type max-after-curation. Applied to the per-type bucket post-distance-sort. */
  quotas: Record<string, number>;
  /** Per-type priority — lower = preferred when budget runs out. Default 99. */
  priorities: Record<string, number>;
  /**
   * Stable hash of the normalised quotas map. Used as the third dimension
   * of the cache key — different theme selections must not share rows.
   * Empty string for the legacy default path (back-compat).
   */
  hash: string;
}

/**
 * Normalise + resolve the type_quotas input from the request body.
 *
 * - Empty/absent input → fall back to the hardcoded defaults.
 * - Non-empty input    → use ONLY the provided types; per-type max defaults
 *                        to 3 if absent; priority defaults to 99 (lowest).
 * - Legacy aliases     → mapped through LEGACY_ALIAS.
 * - Unknown types      → dropped with a console.warn.
 */
function resolveTypeQuotas(input: TypeQuotaInput | undefined): ResolvedTypeQuotas {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
    return {
      types: [...POI_TYPES_DEFAULT],
      quotas: { ...TYPE_QUOTAS_DEFAULT },
      priorities: {},
      hash: '',
    };
  }

  const quotas: Record<string, number> = {};
  const priorities: Record<string, number> = {};
  const types: PoiType[] = [];

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = LEGACY_ALIAS[rawKey] ?? rawKey;
    if (!POI_TYPES_DEFAULT_SET.has(key)) {
      console.warn(`[${GENERATOR}] type_quotas: dropping unrecognised type '${rawKey}' (normalised: '${key}')`);
      continue;
    }
    const max = Number.isFinite(Number(rawValue?.max)) ? Math.max(0, Math.round(Number(rawValue.max))) : 3;
    const priority = Number.isFinite(Number(rawValue?.priority)) ? Math.round(Number(rawValue.priority)) : 99;
    quotas[key] = max;
    priorities[key] = priority;
    types.push(key as PoiType);
  }

  // If filtering left nothing usable, fall back to defaults rather than
  // returning zero POIs (which would silently break renders).
  if (types.length === 0) {
    console.warn(`[${GENERATOR}] type_quotas: all entries dropped, falling back to defaults`);
    return {
      types: [...POI_TYPES_DEFAULT],
      quotas: { ...TYPE_QUOTAS_DEFAULT },
      priorities: {},
      hash: '',
    };
  }

  // Sort types by priority for stable iteration + cache hash.
  types.sort((a, b) => (priorities[a] ?? 99) - (priorities[b] ?? 99));

  // Hash the normalised quotas map. Sort keys so {a,b} and {b,a} collide.
  const sortedNormalised: Record<string, { priority: number; max: number }> = {};
  for (const t of [...types].sort()) {
    sortedNormalised[t] = { priority: priorities[t] ?? 99, max: quotas[t] };
  }
  const hash = quotaHash(JSON.stringify(sortedNormalised));

  return { types, quotas, priorities, hash };
}

/**
 * Short deterministic hash of a string — used as the cache-key suffix.
 *
 * djb2-style: cheap, deterministic, good enough for bucketing within a
 * single project's cache rows (collisions only matter for cache hits, and
 * a 32-bit hash space is plenty for the few-dozen-themes-per-org realistic
 * upper bound). If collision-resistance ever becomes a concern, swap to a
 * Web Crypto SHA-1 (would require making resolveTypeQuotas async).
 */
function quotaHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // Unsigned hex, padded to 8 chars.
  return (h >>> 0).toString(16).padStart(8, '0');
}

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
 * Resolve the Google Places API key from the GOOGLE_PLACES_API_KEY env var
 * (set via `supabase secrets set`).
 *
 * Returns null if not configured. The key is NEVER logged.
 *
 * Historical note (#41 audit fix): this used to fall back to
 * `admin.from('vault.decrypted_secrets')`, but PostgREST cannot resolve
 * schema-qualified table names like that — the vault path was always dead
 * code. The env var is the only supported source; keep the secret synced via
 * `supabase secrets set GOOGLE_PLACES_API_KEY=...`.
 */
async function resolveGooglePlacesKey(): Promise<string | null> {
  const fromEnv = Deno.env.get('GOOGLE_PLACES_API_KEY');
  if (fromEnv && fromEnv.length > 10) return fromEnv;
  return null;
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
 *   4. Truncate to the resolved per-type quota.
 *   5. Return flattened, sorted by distance globally.
 *
 * Dedup is done BEFORE this step (place_id-keyed) so a single place that's
 * both a "shopping_mall" and a "tourist_attraction" only appears once and
 * counts against the first type that surfaced it.
 *
 * Per-type quota lookup falls through:  resolved quotas → default quotas → 3.
 * The 3 fallback only matters if a theme passes a type with no `max` AND the
 * type isn't in TYPE_QUOTAS_DEFAULT (impossible today since we filter to
 * known types in resolveTypeQuotas, but defence-in-depth).
 */
function curate(
  byType: Map<PoiType, GooglePlacesResult[]>,
  propertyLat: number,
  propertyLng: number,
  perTypeQuotas: Record<string, number>,
): CuratedPoi[] {
  const out: CuratedPoi[] = [];

  for (const [type, results] of byType) {
    const quota = perTypeQuotas[type] ?? TYPE_QUOTAS_DEFAULT[type] ?? 3;
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

  let body: {
    project_id?: string;
    refresh?: boolean;
    radius_m?: number;
    /**
     * Optional per-type quotas. When provided AND non-empty, drone-pois uses
     * ONLY these types and caps each per the entry's `max`. When absent,
     * falls back to POI_TYPES_DEFAULT + TYPE_QUOTAS_DEFAULT (back-compat).
     * Legacy aliases ('shopping' → 'shopping_mall', 'train' → 'train_station')
     * are normalised; unknown keys are dropped with a warn.
     */
    type_quotas?: TypeQuotaInput;
    _health_check?: boolean;
  } = {};
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

  // Resolve type-quotas → list of types to query, per-type quotas, cache hash.
  const resolvedQuotas = resolveTypeQuotas(body.type_quotas);

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

  // Resolve raw values for diagnostics (#40 audit: distinguish "missing" from
  // "present but unparseable" — strings like "NaN", "" sneak in via dirty data
  // and the previous error message wrongly said the field was empty).
  const rawLat = project.confirmed_lat ?? project.geocoded_lat;
  const rawLng = project.confirmed_lng ?? project.geocoded_lng;
  const propertyLat = Number(rawLat);
  const propertyLng = Number(rawLng);
  if (!Number.isFinite(propertyLat) || !Number.isFinite(propertyLng)) {
    const hasRawValue = (rawLat !== null && rawLat !== undefined && String(rawLat) !== '')
      || (rawLng !== null && rawLng !== undefined && String(rawLng) !== '');
    const message = hasRawValue
      ? `Project coordinates are unparseable (got lat='${String(rawLat)}', lng='${String(rawLng)}') — please re-confirm in the Location editor`
      : 'Project has no property coordinates (confirmed_lat/lng or geocoded_lat/lng required)';
    return errorResponse(message, 400, req);
  }

  // 2. Cache hit? Cache lookup must include (radius_m, type_quotas_hash) so
  // different theme selections + radius combos don't share a slot. The
  // type_quotas_hash column was added in migration 245 with default '' for
  // pre-existing rows. Legacy callers (no body.type_quotas) get hash='', so
  // legacy cache rows still hit. New callers with theme-driven type_quotas
  // get a fresh row (cold cache miss) on first request — this is the
  // intended cache-busting strategy. (#39 audit fix extended)
  if (!body.refresh) {
    const { data: cached } = await admin
      .from('drone_pois_cache')
      .select('*')
      .eq('project_id', body.project_id)
      .eq('radius_m', radiusM)
      .eq('type_quotas_hash', resolvedQuotas.hash)
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
      'Google Places API key not configured (set env GOOGLE_PLACES_API_KEY via `supabase secrets set`)',
      500,
      req,
    );
  }

  // Parallelise the per-type calls. Failures isolate to that type. Iterate
  // the resolved per-request type list (theme-driven or default fallback).
  const typesToQuery = resolvedQuotas.types;
  const settled = await Promise.allSettled(
    typesToQuery.map((t) => fetchPoisOfType(apiKey, propertyLat, propertyLng, radiusM, t)),
  );

  // De-dup by place_id BEFORE bucketing — first hit wins its type assignment.
  const seenPlaceIds = new Set<string>();
  const byType = new Map<PoiType, GooglePlacesResult[]>();
  for (let i = 0; i < typesToQuery.length; i++) {
    const type = typesToQuery[i];
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

  const curated = curate(byType, propertyLat, propertyLng, resolvedQuotas.quotas);

  // 4. Persist cache row. The (project_id, radius_m, type_quotas_hash)
  // unique index from migration 245 collides on concurrent identical
  // requests; we use upsert-on-conflict to swallow the duplicate (the
  // first writer wins, the second silently re-uses the row).
  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);

  const { error: insertErr } = await admin
    .from('drone_pois_cache')
    .upsert(
      {
        project_id: body.project_id,
        property_lat: propertyLat,
        property_lng: propertyLng,
        radius_m: radiusM,
        type_quotas_hash: resolvedQuotas.hash,
        fetched_at: fetchedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        source: 'google_places',
        pois: curated,
        total_count: curated.length,
      },
      { onConflict: 'project_id,radius_m,type_quotas_hash' },
    );
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

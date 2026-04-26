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
  //
  // Mig 268 (W3-PINS): the cache table is now a RAW AUDIT LOG of Google
  // Places responses (cost tracking + replay). The authoritative POI store
  // for renders + Pin Editor is drone_custom_pins (source='ai'). We keep
  // writing the cache row for back-compat while readers migrate; the
  // materialise step below is what actually drives renders going forward.
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

  // ── 4b. Materialise into drone_custom_pins (W3-PINS unified model) ─────
  // Each curated POI becomes a row in drone_custom_pins with source='ai'.
  // Smart-merge contract:
  //   - (project_id, external_ref) UNIQUE for source='ai' rows (mig 268).
  //   - If row exists AND updated_by IS NULL  → overwrite world coords +
  //     content from fresh AI data (operator never touched it).
  //   - If row exists AND updated_by IS NOT NULL → preserve operator's
  //     world coords + content; only refresh latest_ai_snapshot so the
  //     "Reset to AI" affordance recovers the original.
  //   - If row missing → INSERT fresh.
  // Pre-existing AI rows whose external_ref is no longer in this fetch
  // are marked lifecycle='superseded' (preserve for audit/recovery).
  const materialisedSummary = await materialiseAiPins(
    admin,
    body.project_id,
    curated,
  );

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
      materialised: materialisedSummary,
    },
    200,
    req,
  );
});

// ─── Materialise AI pins into drone_custom_pins ──────────────────────────
//
// Smart-merge entry point — see contract in handler comments above.
// Returns a summary { inserted, updated_ai_only, preserved_operator_edits,
// superseded } so callers (orchestrator / UI) can show what changed.

async function materialiseAiPins(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
  curated: CuratedPoi[],
): Promise<{
  inserted: number;
  refreshed_ai: number;
  preserved_operator_edits: number;
  superseded: number;
  errors: number;
}> {
  const summary = {
    inserted: 0,
    refreshed_ai: 0,
    preserved_operator_edits: 0,
    superseded: 0,
    errors: 0,
  };

  // ── Wave 5 P1 (QC2-8 #9 + QC2-1 #14): serialise concurrent runs ────────
  // Two parallel webhooks for the same project both used to walk
  // existingByRef → branch into "new POI" insert path → run supersede
  // sweep. Window: invocation A reads, invocation B inserts, A's supersede
  // (working from its stale snapshot) then flipped B's freshly-inserted
  // row to lifecycle='superseded'. Result: a refresh that should yield 25
  // active pins yielded ~12 active + 13 superseded.
  //
  // The lock key is hashtext('drone-pois:' || project_id) which buckets
  // per-project but never cross-contaminates with other modules. Lock is
  // session-scoped (advisory_lock not advisory_xact_lock) because a
  // PostgREST RPC call is its own transaction — we acquire + release
  // around the whole materialise block.
  let lockAcquired = false;
  try {
    const { error: lockErr } = await admin.rpc(
      'drone_pois_acquire_lock',
      { p_project_id: projectId },
    );
    if (lockErr) {
      console.warn(`[${GENERATOR}] materialise: advisory lock acquire failed (continuing without lock): ${lockErr.message}`);
    } else {
      lockAcquired = true;
    }

    // Load existing AI pins for this project so we can: (a) detect operator
    // edits via updated_by, and (b) supersede anything no longer in the
    // fresh fetch.
    //
    // Wave 5 P1 (QC2-1 #14): filter to lifecycle IN ('active','superseded')
    // — soft-deleted ('deleted') and 'suppressed' rows must NOT poison the
    // existingByRef map. Without this filter, refresh routes every
    // existing-key match through the operator-edit branch even when the
    // row was suppressed by the operator (correct for suppressed: re-bring
    // it back if the data is fresh) or soft-deleted (incorrect: a deleted
    // pin should be re-created). 'deleted' is excluded so the new INSERT
    // path runs and the unique index 23505-rebuilds the row cleanly.
    const { data: existingRaw, error: exErr } = await admin
      .from('drone_custom_pins')
      .select('id, external_ref, updated_by, lifecycle, world_lat, world_lng')
      .eq('project_id', projectId)
      .eq('source', 'ai')
      .in('lifecycle', ['active', 'superseded']);
    if (exErr) {
      console.warn(`[${GENERATOR}] materialise: existing-row lookup failed: ${exErr.message}`);
      summary.errors += 1;
      return summary;
    }
    const existingByRef = new Map<string, {
      id: string;
      external_ref: string | null;
      updated_by: string | null;
      lifecycle: string;
    }>();
    for (const r of existingRaw || []) {
      if (r.external_ref) existingByRef.set(r.external_ref, r as never);
    }

    const freshRefs = new Set<string>();
    for (const poi of curated) {
      if (!poi.place_id) continue;
      freshRefs.add(poi.place_id);

      const existing = existingByRef.get(poi.place_id);
      const snapshot = {
        place_id: poi.place_id,
        name: poi.name,
        type: poi.type,
        lat: poi.lat,
        lng: poi.lng,
        distance_m: poi.distance_m,
        rating: poi.rating,
        user_ratings_total: poi.user_ratings_total,
        fetched_at: new Date().toISOString(),
      };
      const content = {
        label: poi.name,
        type: poi.type,
        distance_m: poi.distance_m,
        rating: poi.rating,
        user_ratings_total: poi.user_ratings_total,
        place_id: poi.place_id,
      };

      if (!existing) {
        // INSERT fresh
        const { error } = await admin.from('drone_custom_pins').insert({
          project_id: projectId,
          shoot_id: null,
          pin_type: 'poi_manual',
          source: 'ai',
          subsource: 'google_places',
          external_ref: poi.place_id,
          lifecycle: 'active',
          priority: 10,
          world_lat: poi.lat,
          world_lng: poi.lng,
          content,
          latest_ai_snapshot: snapshot,
          // updated_by is null on insert — flags "never operator-edited"
        });
        if (error) {
          // Race with a concurrent drone-pois invocation: the unique index
          // catches dupes; treat 23505 as a benign no-op.
          if ((error as { code?: string }).code === '23505') {
            // Re-load + treat as refresh
            summary.refreshed_ai += 1;
          } else {
            console.warn(`[${GENERATOR}] materialise insert ${poi.place_id} failed: ${error.message}`);
            summary.errors += 1;
          }
        } else {
          summary.inserted += 1;
        }
        continue;
      }

      // Existing row — choose path based on operator-edit flag
      const wasOperatorEdited = existing.updated_by !== null;
      if (wasOperatorEdited) {
        // Preserve world coords + content; refresh snapshot only so
        // "Reset to AI" works against the latest data.
        const { error } = await admin
          .from('drone_custom_pins')
          .update({
            latest_ai_snapshot: snapshot,
            // Re-activate if previously superseded — fresh data brings it back.
            lifecycle: existing.lifecycle === 'superseded' ? 'active' : existing.lifecycle,
          })
          .eq('id', existing.id);
        if (error) {
          console.warn(`[${GENERATOR}] materialise refresh-snapshot ${poi.place_id} failed: ${error.message}`);
          summary.errors += 1;
        } else {
          summary.preserved_operator_edits += 1;
        }
      } else {
        // Overwrite from fresh AI data
        const { error } = await admin
          .from('drone_custom_pins')
          .update({
            world_lat: poi.lat,
            world_lng: poi.lng,
            content,
            latest_ai_snapshot: snapshot,
            lifecycle: 'active',
          })
          .eq('id', existing.id);
        if (error) {
          console.warn(`[${GENERATOR}] materialise refresh ${poi.place_id} failed: ${error.message}`);
          summary.errors += 1;
        } else {
          summary.refreshed_ai += 1;
        }
      }
    }

    // ── Wave 5 P1 (QC2-8 #9): atomic supersede via single SQL ──────────
    // Replaces the JS-side stale-list build + bulk update. The RPC runs:
    //   UPDATE drone_custom_pins
    //      SET lifecycle='superseded', updated_at=NOW()
    //    WHERE project_id=$1
    //      AND source='ai'
    //      AND lifecycle='active'
    //      AND external_ref IS NOT NULL
    //      AND external_ref NOT IN (unnest($2::text[]))
    //      AND updated_by IS NULL              ← QC2-4 F49 preserve
    //
    // The QC2-4 F49 operator-preservation clause: if a human touched the
    // pin (updated_by NOT NULL), DON'T supersede on a refresh that
    // doesn't return its place_id — the pin stays active. The smart-merge
    // refresh-snapshot branch above will keep its snapshot fresh too.
    //
    // The advisory lock above PLUS the WHERE-clause atomicity mean a
    // concurrent invocation B that just inserted a fresh row cannot have
    // its row clobbered by invocation A's supersede — A sees B's row in
    // the existingByRef snapshot it just took (post-lock acquire) and
    // its freshRefs set will include B's place_id (because both ran the
    // same Google fetch pointing at the same property), so the NOT IN
    // clause excludes it.
    const freshRefArr = Array.from(freshRefs);
    const { data: supRow, error: supErr } = await admin.rpc(
      'drone_pois_supersede_stale',
      { p_project_id: projectId, p_fresh_refs: freshRefArr },
    );
    if (supErr) {
      console.warn(`[${GENERATOR}] materialise supersede RPC failed: ${supErr.message}`);
      summary.errors += 1;
    } else if (typeof supRow === 'number') {
      summary.superseded = supRow;
    }
  } finally {
    if (lockAcquired) {
      try {
        await admin.rpc('drone_pois_release_lock', { p_project_id: projectId });
      } catch (e) {
        console.warn(`[${GENERATOR}] materialise: advisory lock release failed (will expire on session close): ${(e as Error)?.message}`);
      }
    }
  }

  return summary;
}

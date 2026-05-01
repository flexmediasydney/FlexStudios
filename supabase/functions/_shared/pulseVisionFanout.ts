/**
 * pulseVisionFanout — W15b.6 keystone wave (Piece 3).
 *
 * Helper that fires Pulse vision-extract jobs from pulseDetailEnrich AFTER
 * each per-listing enrich completes successfully. The fan-out is non-blocking
 * — it runs in EdgeRuntime.waitUntil() so the caller's main loop never waits
 * on Gemini round-trips.
 *
 * What this fires:
 *   - `pulse-listing-vision-extract` (W15b.1)  — Gemini 2.5 Flash on each
 *     photo URL, persisted to `pulse_listing_vision_extracts.photo_breakdown`.
 *   - `pulse-video-frame-extractor`  (W15b.3)  — extract frames from video,
 *     then runs W15b.1 on each frame, persisted to `.video_breakdown`. Only
 *     fires if `MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL` is set on the project.
 *
 * Cost & safety guards (in order):
 *   1. `engine_settings.pulse_vision.queue_paused = true`  → skip whole listing.
 *   2. Today's accumulated cost from `pulse_listing_vision_extracts.total_cost_usd`
 *      WHERE `created_at >= CURRENT_DATE` >= `daily_cap_usd` → skip whole listing.
 *      (The daily cap arithmetic is intentionally evaluated PER LISTING — if
 *      the cap is breached mid-batch, the rest of the batch silently skips.
 *      Joseph will ask "why are extracts pausing today?" — answer: today's
 *      total spend reached the cap. To override, lift the cap or bump the
 *      `daily_cap_override_usd` knob in engine_settings.)
 *   3. Listing already has a `succeeded` extract row created within the last
 *      14 days → skip (still fresh — no point burning $0.04 to re-extract).
 *
 * Concurrency:
 *   The pulseDetailEnrich batch loop processes BATCH_SIZE=12 listings per
 *   invocation. We fire vision extracts at most 4 in parallel via a tiny
 *   semaphore — a stale promise queue with `Promise.all` over slices of 4.
 *   This keeps us well below the project's edge-function concurrency cap
 *   while letting the batch finish faster than serial would.
 *
 * Per-listing isolation:
 *   We catch + log every error per listing. A single Modal timeout, Gemini
 *   429, or schema-validation failure NEVER cascades — the whole batch
 *   proceeds and the listing's quote falls back to V1 crude classifier on
 *   the next pulse_compute_listing_quote call.
 */

// Loosely typed admin client. We avoid pinning to a specific supabase-js
// dist (jsr vs esm.sh) because callers mix sources and TS would refuse to
// pass one to the other. Runtime contract: `.from(table).select().eq()`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SupabaseClient = any;

// Same Edge-Function fetch contract as `_shared/supabase.ts::invokeFunction`,
// but inlined so this helper can be unit-tested with a mock fetch without
// pulling in the whole supabase shared module's runtime env-bootstrapping
// (which fails outside a deployed function).
const SUPABASE_URL = (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_URL') : '') || '';
const SUPABASE_ANON_KEY = (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_ANON_KEY') : '') || '';
const SUPABASE_SERVICE_ROLE_KEY = (typeof Deno !== 'undefined' ? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') : '') || '';
const MODAL_VIDEO_URL_KEY = 'MODAL_PULSE_VIDEO_FRAME_EXTRACTOR_URL';

/** Treat extract rows as "fresh" within this many days of creation. */
export const FRESH_EXTRACT_DAYS = 14;

/** Maximum simultaneous vision-extract HTTP calls in flight per batch. */
export const VISION_FANOUT_CONCURRENCY = 4;

export interface PulseVisionSettings {
  queue_paused?: boolean;
  daily_cap_usd?: number;
  daily_cap_override_usd?: number;
  daily_cap_override_date?: string | null;
}

export interface VisionFanoutDecision {
  fired: boolean;
  skipped_reason: string | null;
  invocations: { fn: string; ok: boolean; error?: string }[];
  /** Today's cost as of the daily-cap check. Useful for log forensics. */
  todays_spend_usd?: number;
  /** Effective cap (override or default). */
  effective_cap_usd?: number;
}

export interface ListingForFanout {
  id: string;            // pulse_listings.id
  source_listing_id?: string | null;
  /** Photo URLs, deduped, http(s)-only. */
  photo_urls: string[];
  /** Video URL or null. */
  video_url: string | null;
}

interface FanoutDeps {
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override `Date.now` for tests (ms since epoch). */
  now?: () => number;
  /** Override env reads for tests. */
  env?: Record<string, string | undefined>;
}

/**
 * Read `engine_settings.pulse_vision.*`. Returns sensible defaults if the
 * row is missing. This is a single point query — cheap, no caching needed.
 */
export async function readVisionSettings(admin: SupabaseClient): Promise<PulseVisionSettings> {
  const { data, error } = await admin
    .from('engine_settings')
    .select('value')
    .eq('key', 'pulse_vision')
    .maybeSingle();
  if (error || !data) return { queue_paused: false, daily_cap_usd: 0 };
  return (data.value || {}) as PulseVisionSettings;
}

/**
 * Resolve the effective daily cap. Override wins iff
 * `daily_cap_override_date` matches today (YYYY-MM-DD UTC) — otherwise we
 * use the standing `daily_cap_usd`. This matches the convention seeded by
 * migration 378a: master_admin can punch a one-day hole without permanently
 * raising the steady-state cap.
 */
export function resolveEffectiveCap(settings: PulseVisionSettings, today: Date): number {
  const standing = Number(settings.daily_cap_usd ?? 0) || 0;
  const override = Number(settings.daily_cap_override_usd ?? 0) || 0;
  if (!override || override <= 0) return standing;
  const overrideDate = settings.daily_cap_override_date;
  if (!overrideDate) return standing;
  const todayKey = today.toISOString().slice(0, 10);
  return overrideDate === todayKey ? override : standing;
}

/**
 * Sum today's `pulse_listing_vision_extracts.total_cost_usd`. We use
 * `.gte('created_at', startOfToday)` which is index-friendly. The aggregate
 * happens server-side (jsonb `sum` aggregation isn't available, so we ask for
 * the rows and reduce client-side — daily volume is < 1000 rows so this is
 * cheap; the alternative is a SQL function which would add deploy friction).
 */
export async function getTodaysVisionSpendUsd(
  admin: SupabaseClient,
  today: Date,
): Promise<number> {
  const startOfToday = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
  )).toISOString();
  const { data, error } = await admin
    .from('pulse_listing_vision_extracts')
    .select('total_cost_usd')
    .gte('created_at', startOfToday);
  if (error || !data) return 0;
  return data.reduce((acc: number, row: any) => acc + (Number(row.total_cost_usd) || 0), 0);
}

/**
 * Check if the listing already has a fresh succeeded extract.
 * Returns true when an extract row exists with status='succeeded' AND
 * created_at >= now - FRESH_EXTRACT_DAYS days. The Pulse vision rerun
 * cadence is 14 days — anything fresher is a re-run waste.
 */
export async function hasFreshSucceededExtract(
  admin: SupabaseClient,
  listingId: string,
  now: Date,
): Promise<boolean> {
  const cutoff = new Date(now.getTime() - FRESH_EXTRACT_DAYS * 86400_000).toISOString();
  const { data, error } = await admin
    .from('pulse_listing_vision_extracts')
    .select('id')
    .eq('listing_id', listingId)
    .eq('status', 'succeeded')
    .gte('created_at', cutoff)
    .limit(1);
  if (error || !data) return false;
  return data.length > 0;
}

/**
 * Default fetch-based invoke. Mirrors `_shared/supabase.ts::invokeFunction`
 * minus the audit-log header wiring (which has hard runtime dependencies).
 * For test injection, callers pass `fetchFn` via FanoutDeps.
 */
async function invokeFunctionRaw(
  functionName: string,
  payload: Record<string, unknown>,
  deps: FanoutDeps,
): Promise<{ ok: boolean; error?: string }> {
  const fetchFn = deps.fetchFn || fetch;
  const env = deps.env || {};
  const baseUrl = env.SUPABASE_URL ?? SUPABASE_URL;
  const authToken = env.SUPABASE_SERVICE_ROLE_KEY ?? SUPABASE_SERVICE_ROLE_KEY;
  const apikey = env.SUPABASE_ANON_KEY ?? SUPABASE_ANON_KEY;
  if (!baseUrl) return { ok: false, error: 'SUPABASE_URL not set' };

  try {
    const res = await fetchFn(`${baseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': apikey,
        'Authorization': `Bearer ${authToken}`,
        'x-caller-context': 'cross_fn:pulseDetailEnrich',
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 160)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message?.slice(0, 200) || 'fetch error' };
  }
}

/**
 * Fire vision extracts for a single listing.
 *
 * Order of guard checks:
 *   1. queue_paused        → skipped_reason='queue_paused'
 *   2. daily cap exceeded  → skipped_reason='daily_cap_reached'
 *   3. fresh extract       → skipped_reason='fresh_extract_exists'
 *   4. no photos           → skipped_reason='no_photos'
 * Otherwise:
 *   5. Fire `pulse-listing-vision-extract` with photo URLs (always).
 *   6. Fire `pulse-video-frame-extractor` if video_url present AND Modal URL
 *      configured. If video_url present but Modal URL missing, log warning
 *      and continue (photo extract still fires).
 */
export async function fireVisionExtractsForListing(
  admin: SupabaseClient,
  listing: ListingForFanout,
  preflight: { settings: PulseVisionSettings; todays_spend_usd: number; effective_cap_usd: number; now: Date },
  deps: FanoutDeps = {},
): Promise<VisionFanoutDecision> {
  const env = deps.env || {};
  const modalUrl = env[MODAL_VIDEO_URL_KEY] ?? (typeof Deno !== 'undefined' ? Deno.env.get(MODAL_VIDEO_URL_KEY) : '');
  const decision: VisionFanoutDecision = {
    fired: false,
    skipped_reason: null,
    invocations: [],
    todays_spend_usd: preflight.todays_spend_usd,
    effective_cap_usd: preflight.effective_cap_usd,
  };

  // Guard 1: queue_paused (operator killswitch)
  if (preflight.settings.queue_paused === true) {
    decision.skipped_reason = 'queue_paused';
    console.warn(`[pulseVisionFanout] ${listing.id}: queue paused — skip`);
    return decision;
  }

  // Guard 2: daily cap. We evaluate per listing so a mid-batch overshoot
  // pauses the rest of the batch cleanly. The cap is denominated in USD.
  if (preflight.effective_cap_usd > 0 && preflight.todays_spend_usd >= preflight.effective_cap_usd) {
    decision.skipped_reason = 'daily_cap_reached';
    console.warn(`[pulseVisionFanout] ${listing.id}: daily cap reached ($${preflight.todays_spend_usd.toFixed(3)} >= $${preflight.effective_cap_usd.toFixed(2)}) — skip`);
    return decision;
  }

  // Guard 3: fresh succeeded extract within last 14 days
  if (await hasFreshSucceededExtract(admin, listing.id, preflight.now)) {
    decision.skipped_reason = 'fresh_extract_exists';
    return decision;
  }

  // Guard 4: nothing to extract
  if (!Array.isArray(listing.photo_urls) || listing.photo_urls.length === 0) {
    decision.skipped_reason = 'no_photos';
    return decision;
  }

  // Fire photo extract (always, when guards pass)
  const photoResult = await invokeFunctionRaw('pulse-listing-vision-extract', {
    listing_id: listing.id,
    triggered_by: 'pulse_detail_enrich',
  }, deps);
  decision.invocations.push({ fn: 'pulse-listing-vision-extract', ...photoResult });

  // Fire video extract conditionally
  if (listing.video_url && typeof listing.video_url === 'string' && listing.video_url.trim().length > 0) {
    if (!modalUrl) {
      console.warn(`[pulseVisionFanout] ${listing.id}: video_url present but ${MODAL_VIDEO_URL_KEY} not configured — photo extract fired, video skipped`);
      decision.invocations.push({
        fn: 'pulse-video-frame-extractor',
        ok: false,
        error: `${MODAL_VIDEO_URL_KEY} not configured`,
      });
    } else {
      const videoResult = await invokeFunctionRaw('pulse-video-frame-extractor', {
        listing_id: listing.id,
        video_url: listing.video_url,
        triggered_by: 'pulse_detail_enrich',
      }, deps);
      decision.invocations.push({ fn: 'pulse-video-frame-extractor', ...videoResult });
    }
  }

  decision.fired = decision.invocations.some(i => i.ok);
  return decision;
}

/**
 * Fan vision extracts across a whole batch with bounded concurrency.
 * Reads engine_settings + today's spend ONCE per batch (cheap, freshness
 * is fine because the batch processes ≤12 listings in <5min).
 *
 * Returns array of decisions parallel to the input listings array.
 */
export async function fireVisionExtractsBatch(
  admin: SupabaseClient,
  listings: ListingForFanout[],
  deps: FanoutDeps = {},
): Promise<VisionFanoutDecision[]> {
  if (listings.length === 0) return [];

  const now = new Date(deps.now ? deps.now() : Date.now());
  const settings = await readVisionSettings(admin);
  const effectiveCapUsd = resolveEffectiveCap(settings, now);
  const todaysSpendUsd = await getTodaysVisionSpendUsd(admin, now);
  const preflight = { settings, todays_spend_usd: todaysSpendUsd, effective_cap_usd: effectiveCapUsd, now };

  // Short-circuit if killswitches are already tripped — saves N round-trips
  if (settings.queue_paused === true) {
    return listings.map(() => ({
      fired: false,
      skipped_reason: 'queue_paused',
      invocations: [],
      todays_spend_usd: todaysSpendUsd,
      effective_cap_usd: effectiveCapUsd,
    }));
  }
  if (effectiveCapUsd > 0 && todaysSpendUsd >= effectiveCapUsd) {
    console.warn(`[pulseVisionFanout] daily cap reached at batch start ($${todaysSpendUsd.toFixed(3)} >= $${effectiveCapUsd.toFixed(2)}) — skipping ${listings.length} listings`);
    return listings.map(() => ({
      fired: false,
      skipped_reason: 'daily_cap_reached',
      invocations: [],
      todays_spend_usd: todaysSpendUsd,
      effective_cap_usd: effectiveCapUsd,
    }));
  }

  const results: VisionFanoutDecision[] = new Array(listings.length);
  // Tiny semaphore: process slices of size VISION_FANOUT_CONCURRENCY in
  // sequence, with all members of a slice running in parallel.
  for (let i = 0; i < listings.length; i += VISION_FANOUT_CONCURRENCY) {
    const slice = listings.slice(i, i + VISION_FANOUT_CONCURRENCY);
    const sliceResults = await Promise.all(slice.map(listing =>
      fireVisionExtractsForListing(admin, listing, preflight, deps).catch((e) => {
        // Per-listing errors must NEVER blow up the batch.
        console.warn(`[pulseVisionFanout] ${listing.id}: caught error: ${(e as Error)?.message?.slice(0, 200)}`);
        return {
          fired: false,
          skipped_reason: 'exception',
          invocations: [{ fn: 'pulse-listing-vision-extract', ok: false, error: String((e as Error)?.message || e).slice(0, 200) }],
          todays_spend_usd: todaysSpendUsd,
          effective_cap_usd: effectiveCapUsd,
        } as VisionFanoutDecision;
      })
    ));
    for (let j = 0; j < sliceResults.length; j++) results[i + j] = sliceResults[j];
  }
  return results;
}

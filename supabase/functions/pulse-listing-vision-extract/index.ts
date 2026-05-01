/**
 * pulse-listing-vision-extract
 * ────────────────────────────
 * Wave 15b.1 — per-image Gemini 2.5 Flash extractor over external REA listing
 * photos. Persists per-image rows into composition_classifications with
 * source_type='external_listing' and rolls aggregates into the W15b.2
 * pulse_listing_vision_extracts substrate.
 *
 * Spec: docs/design-specs/W15b-external-listing-vision-pipeline.md (W15b.1).
 *
 * Invocation modes (master_admin or service-role only):
 *   - { listing_id }                — single listing.
 *   - { listing_ids: [uuid, ...] }  — small batch (≤50).
 *   - { _health_check: true }       — version stamp.
 *
 * Optional fields:
 *   - { triggered_by }              — defaults to 'operator_manual'; the
 *                                     pulse_detail_enrich path passes
 *                                     'pulse_detail_enrich' explicitly.
 *   - { schema_version }            — defaults to PULSE_EXTERNAL_LISTING_SCHEMA_VERSION.
 *   - { model }                     — defaults to 'gemini-2.5-flash'.
 *
 * Cost gate: per-call check against `engine_settings.pulse_vision.daily_cap_usd`
 * (default $30). When the daily aggregate (sum of total_cost_usd over
 * pulse_listing_vision_extracts in the last 24h) exceeds the cap, the function
 * returns 429 and stamps the new extract row 'failed'.
 *
 * Background-mode contract (matches pulse-description-extractor):
 *   - Synchronous pre-flight (auth + cost gate).
 *   - Background work in EdgeRuntime.waitUntil().
 *   - Returns 200 with `mode: 'background'`. Failed gating returns 429
 *     synchronously.
 *
 * Idempotency: createPulseVisionExtract is idempotent at (listing,
 * schema_version) via the unique index. A re-fire on the same listing at the
 * same schema_version updates the existing row's status back to 'running'
 * rather than creating a duplicate.
 *
 * Cost cap behaviour (per-call):
 *   - Daily 24h aggregate vs engine_settings.pulse_vision.daily_cap_usd.
 *   - When exceeded → 429 + extract row marked 'failed' with
 *     `failed_reason='daily cost cap exceeded'`.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
} from '../_shared/supabase.ts';
import {
  callVisionAdapter,
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
  type VisionResponse,
} from '../_shared/visionAdapter/index.ts';
import {
  pulseExternalListingSchema,
  PULSE_EXTERNAL_LISTING_SCHEMA_VERSION,
} from '../_shared/visionPrompts/blocks/pulseExternalListingSchema.ts';
import {
  createPulseVisionExtract,
  markPulseVisionExtractRunning,
  markPulseVisionExtractSucceeded,
  markPulseVisionExtractFailed,
  aggregatePerImageResults,
  aggregateCompetitorBranding,
  type PulseVisionTriggeredBy,
  type VisionResponseV2,
} from '../_shared/pulseVisionPersist.ts';

const GENERATOR = 'pulse-listing-vision-extract';
const VERSION = 'v1.0';

// ─── Constants ───────────────────────────────────────────────────────────────

const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-flash';
const DEFAULT_THINKING_BUDGET = 0; // Flash tolerates 0; we want the cheap path.
const DEFAULT_MAX_OUTPUT_TOKENS = 1500;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_DAILY_CAP_USD = 30;
const MAX_LISTINGS_PER_BATCH = 50;
const PER_IMAGE_CONCURRENCY = 4;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface RequestBody {
  listing_id?: string;
  listing_ids?: string[];
  triggered_by?: PulseVisionTriggeredBy;
  schema_version?: string;
  model?: string;
  _health_check?: boolean;
}

interface PulseListingRow {
  id: string;
  images: unknown;
  hero_image: string | null;
}

interface PerImageResult {
  source_image_url: string;
  ok: boolean;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  classification?: ScopedClassification;
  error?: string;
}

interface ScopedClassification {
  image_type: string;
  is_day: boolean;
  is_dusk: boolean;
  is_drone: boolean;
  is_floorplan: boolean;
  is_video_thumbnail: boolean;
  watermark_visible: boolean;
  photographer_credit: string | null;
  agency_logo_text: string | null;
  delivery_quality_score: number;
  observed_objects: unknown[];
  observed_attributes: unknown[];
  style_archetype: string | null;
  era_hint: string | null;
  material_palette: string[];
  analysis: string;
}

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert real-estate vision analyst.

You see one image from a public real-estate listing. You return a single JSON object describing:
  1. The image's dominant type (day exterior/interior, dusk, drone, floorplan, agent headshot, detail shot, video thumbnail, or other).
  2. Independent product-mix booleans (is_day / is_dusk / is_drone / is_floorplan / is_video_thumbnail) — these are NOT mutually exclusive (a dusk-with-drone shot is both is_dusk=TRUE and is_drone=TRUE).
  3. Whether any photographer / agency watermark or branding is visible.
  4. A 0-10 delivery_quality_score that reflects the technical and aesthetic quality of the photo (anchored: 0=heavy distortion or hand-held phone shot, 5=competent professional, 10=top editorial standard).
  5. Observed canonical-eligible objects + attributes (for the W12 registry feed) — return free-form raw_label and let downstream resolve canonical IDs.
  6. High-level architectural archetype + era hint + material palette (helps W15c competitor analysis).
  7. ~50 words of brief analysis explaining your classifications.

Be precise and conservative. Do NOT invent details that are not visible. Where a field is not classifiable from a single image, return null (or an empty array). Output strict JSON matching the responseSchema. No prose outside the JSON.`;

function buildUserText(): string {
  return 'Classify this real-estate listing image per the schema. Return JSON only.';
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract image URLs from pulse_listings.images (JSONB). Defensive: the column
 * has historically been an array of strings OR an array of objects with a
 * `url` field, depending on the source. Skip the hero_image dup if present in
 * the array.
 *
 * Pure function, exported for tests.
 */
export function extractImageUrls(
  images: unknown,
  hero: string | null,
): string[] {
  const urls: string[] = [];
  if (Array.isArray(images)) {
    for (const it of images) {
      if (typeof it === 'string') urls.push(it);
      else if (it && typeof it === 'object') {
        const url = (it as { url?: unknown; href?: unknown }).url
          ?? (it as { href?: unknown }).href;
        if (typeof url === 'string') urls.push(url);
      }
    }
  }
  if (hero && !urls.includes(hero)) urls.unshift(hero);
  // De-dupe + filter empty.
  return Array.from(new Set(urls.filter((u) => typeof u === 'string' && u.length > 0)));
}

/**
 * Coerce the model's free-form output into the typed ScopedClassification.
 * Defensive against length blow-outs and missing fields. Pure function,
 * exported for tests.
 */
export function normaliseClassification(raw: unknown): ScopedClassification {
  const obj = (typeof raw === 'object' && raw !== null) ? (raw as Record<string, unknown>) : {};
  const str = (k: string, fallback: string | null = null): string | null => {
    const v = obj[k];
    if (typeof v === 'string') return v;
    return fallback;
  };
  const bool = (k: string): boolean => obj[k] === true;
  const num = (k: string, fallback: number): number => {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return fallback;
  };
  const arr = (k: string): unknown[] => {
    const v = obj[k];
    return Array.isArray(v) ? v : [];
  };
  const strArr = (k: string, max = 12): string[] => {
    const v = obj[k];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, max);
  };

  const image_type = str('image_type', 'is_other') ?? 'is_other';

  return {
    image_type,
    is_day: bool('is_day'),
    is_dusk: bool('is_dusk'),
    is_drone: bool('is_drone'),
    is_floorplan: bool('is_floorplan'),
    is_video_thumbnail: bool('is_video_thumbnail'),
    watermark_visible: bool('watermark_visible'),
    photographer_credit: str('photographer_credit'),
    agency_logo_text: str('agency_logo_text'),
    delivery_quality_score: Math.max(0, Math.min(10, num('delivery_quality_score', 0))),
    observed_objects: arr('observed_objects'),
    observed_attributes: arr('observed_attributes'),
    style_archetype: str('style_archetype'),
    era_hint: str('era_hint'),
    material_palette: strArr('material_palette', 12),
    analysis: (str('analysis', '') ?? '').slice(0, 1000),
  };
}

/**
 * Read engine_settings.pulse_vision (a JSONB object) and return the daily-cap
 * USD value. Defaults to DEFAULT_DAILY_CAP_USD when the row is missing or the
 * shape is unexpected. Pure plumbing — DB call only.
 */
export async function getDailyCapUsd(
  admin: ReturnType<typeof getAdminClient>,
  fallback: number = DEFAULT_DAILY_CAP_USD,
): Promise<number> {
  const { data, error } = await admin
    .from('engine_settings')
    .select('value')
    .eq('key', 'pulse_vision')
    .maybeSingle();
  if (error || !data) return fallback;
  const value = data.value;
  if (value && typeof value === 'object') {
    const cap = (value as { daily_cap_usd?: unknown }).daily_cap_usd;
    if (typeof cap === 'number' && Number.isFinite(cap)) return cap;
    if (typeof cap === 'string') {
      const n = Number(cap);
      if (Number.isFinite(n)) return n;
    }
  }
  return fallback;
}

/**
 * Sum total_cost_usd over pulse_listing_vision_extracts in the last 24h.
 * Returns 0 when the substrate is empty. Used by the cost gate.
 */
export async function getDailySpendUsd(
  admin: ReturnType<typeof getAdminClient>,
): Promise<number> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from('pulse_listing_vision_extracts')
    .select('total_cost_usd')
    .gte('created_at', since);
  if (error || !data) return 0;
  let total = 0;
  for (const row of data as Array<{ total_cost_usd: number | string | null }>) {
    const v = row.total_cost_usd;
    if (typeof v === 'number') total += v;
    else if (typeof v === 'string') total += Number(v) || 0;
  }
  return total;
}

/**
 * Convert a per-image scoped classification into the persistence shape consumed
 * by the W15b.2 helper's VisionResponseV2 + composition_classifications insert.
 * The persist helper only needs image_type + observed_attributes for its
 * aggregations; we attach source_image_url so the dashboard can link back.
 *
 * Exported for tests.
 */
export function toVisionResponseV2(
  c: ScopedClassification,
  source_image_url: string,
): VisionResponseV2 {
  // The helper's competitor aggregator inspects observed_attributes raw_label
  // for "watermark" / "agency_logo" / "photographer credit". Augment the
  // observed_attributes with synthetic entries for our scoped flags so the
  // existing aggregator picks them up without duplicate logic.
  const augmented: unknown[] = Array.isArray(c.observed_attributes)
    ? [...c.observed_attributes]
    : [];
  if (c.watermark_visible) {
    augmented.push({ raw_label: 'watermark', confidence: 1 });
  }
  if (c.agency_logo_text) {
    augmented.push({
      raw_label: 'agency_brand',
      canonical_value_id: c.agency_logo_text,
      confidence: 1,
    });
    augmented.push({ raw_label: 'agency_logo', confidence: 1 });
  }
  if (c.photographer_credit) {
    augmented.push({
      raw_label: 'photographer credit',
      canonical_value_id: c.photographer_credit,
      confidence: 1,
    });
  }
  return {
    image_type: c.image_type,
    observed_attributes: augmented as VisionResponseV2['observed_attributes'],
    source_image_url,
  };
}

/**
 * Re-cost a Flash response inline using Gemini 2.5 Flash rates ($0.30 input
 * / $2.50 output per 1M tokens). The visionAdapter's pricing table currently
 * lists 2.0-flash but not 2.5-flash, so unknown-model fallback to Sonnet rates
 * over-counts substantially. We re-derive cost here so the daily cap + audit
 * numbers reflect actual 2.5-flash pricing.
 *
 * Pure function, exported for tests.
 */
export function estimateGemini25FlashCost(
  input_tokens: number,
  output_tokens: number,
): number {
  const inputUsd = (input_tokens / 1_000_000) * 0.30;
  const outputUsd = (output_tokens / 1_000_000) * 2.50;
  const cost = inputUsd + outputUsd;
  return Math.round(cost * 1_000_000) / 1_000_000;
}

// ─── Per-image extraction ────────────────────────────────────────────────────

async function extractOneImage(
  source_image_url: string,
  model: string,
): Promise<PerImageResult> {
  const startMs = Date.now();
  const visionReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model,
    tool_name: 'classify_external_listing_image',
    tool_input_schema: pulseExternalListingSchema,
    system: SYSTEM_PROMPT,
    user_text: buildUserText(),
    images: [
      // Public REA URLs are fetchable by Anthropic, but the Google adapter
      // requires base64. Fetch + inline.
      { source_type: 'url', media_type: 'image/jpeg', url: source_image_url },
    ],
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: 0,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    thinking_budget: DEFAULT_THINKING_BUDGET,
  };

  // Google adapter doesn't support url-mode → fetch as base64 first.
  if (visionReq.vendor === 'google') {
    try {
      const fetched = await fetchAsBase64(source_image_url);
      visionReq.images = [
        { source_type: 'base64', media_type: fetched.media_type, data: fetched.data },
      ];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        source_image_url,
        ok: false,
        cost_usd: 0,
        duration_ms: Date.now() - startMs,
        input_tokens: 0,
        output_tokens: 0,
        error: `image fetch failed: ${msg}`,
      };
    }
  }

  let response: VisionResponse;
  try {
    response = await callVisionAdapter(visionReq);
  } catch (err) {
    const isMissingCred = err instanceof MissingVendorCredential;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      source_image_url,
      ok: false,
      cost_usd: 0,
      duration_ms: Date.now() - startMs,
      input_tokens: 0,
      output_tokens: 0,
      error: isMissingCred
        ? `MissingVendorCredential: ${msg}`
        : (err instanceof VendorCallError ? `VendorCallError: ${msg}` : msg),
    };
  }

  const classification = normaliseClassification(response.output);
  const inputTokens = response.usage?.input_tokens ?? 0;
  const outputTokens = response.usage?.output_tokens ?? 0;
  // Re-cost using actual 2.5-flash rates when the response was 2.5-flash; the
  // visionAdapter pricing table doesn't list 2.5-flash and falls back to
  // Sonnet rates, which over-counts substantially.
  const realCost = /gemini-2\.5-flash/i.test(model)
    ? estimateGemini25FlashCost(inputTokens, outputTokens)
    : (response.usage?.estimated_cost_usd ?? 0);
  return {
    source_image_url,
    ok: true,
    cost_usd: realCost,
    duration_ms: Date.now() - startMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    classification,
  };
}

/**
 * Fetch an external image URL and return a base64 + mime-type pair suitable
 * for the Google adapter's inline_data part. Defensive against non-image
 * responses and oversized payloads.
 */
export async function fetchAsBase64(
  url: string,
): Promise<{ media_type: string; data: string }> {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const ct = res.headers.get('content-type') || 'image/jpeg';
  const media_type = ct.split(';')[0].trim() || 'image/jpeg';
  const buf = new Uint8Array(await res.arrayBuffer());
  // Encode to base64. Deno globalThis.btoa works on binary strings.
  let binary = '';
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
  const data = btoa(binary);
  return { media_type, data };
}

// ─── Persist per-image classification ────────────────────────────────────────

async function persistPerImage(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    extract_id: string;
    listing_id: string;
    schema_version: string;
    source_image_url: string;
    classification: ScopedClassification;
  },
): Promise<void> {
  const { classification: c, source_image_url } = args;
  const insertRow: Record<string, unknown> = {
    source_type: 'external_listing',
    pulse_listing_id: args.listing_id,
    pulse_vision_extract_id: args.extract_id,
    source_image_url,
    schema_version: args.schema_version,
    image_type: c.image_type,
    analysis: c.analysis,
    is_drone: c.is_drone,
    is_detail_shot: c.image_type === 'is_detail_shot',
    is_exterior: c.is_drone,
    time_of_day: c.is_dusk ? 'dusk' : (c.is_day ? 'day' : null),
    observed_objects: c.observed_objects,
    observed_attributes: c.observed_attributes,
    external_specific: {
      is_floorplan: c.is_floorplan,
      is_video_thumbnail: c.is_video_thumbnail,
      watermark_visible: c.watermark_visible,
      photographer_credit: c.photographer_credit,
      agency_logo_text: c.agency_logo_text,
      delivery_quality_score: c.delivery_quality_score,
      style_archetype: c.style_archetype,
      era_hint: c.era_hint,
      material_palette: c.material_palette,
    },
  };
  const { error } = await admin.from('composition_classifications').insert(insertRow);
  if (error) {
    console.warn(
      `[${GENERATOR}] composition_classifications insert failed: ${error.message}`,
    );
  }
}

// ─── Per-listing extraction ──────────────────────────────────────────────────

async function extractListing(
  admin: ReturnType<typeof getAdminClient>,
  args: {
    listing: PulseListingRow;
    extract_id: string;
    model: string;
    schema_version: string;
  },
): Promise<{
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  per_image_v2: VisionResponseV2[];
  success_count: number;
  failure_count: number;
}> {
  const urls = extractImageUrls(args.listing.images, args.listing.hero_image);
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let successCount = 0;
  let failureCount = 0;
  const perImageV2: VisionResponseV2[] = [];

  // Worker-pool for per-image vision calls.
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= urls.length) return;
      const url = urls[idx];
      const result = await extractOneImage(url, args.model);
      totalCost += result.cost_usd;
      totalInputTokens += result.input_tokens;
      totalOutputTokens += result.output_tokens;
      if (result.ok && result.classification) {
        successCount++;
        await persistPerImage(admin, {
          extract_id: args.extract_id,
          listing_id: args.listing.id,
          schema_version: args.schema_version,
          source_image_url: result.source_image_url,
          classification: result.classification,
        });
        perImageV2.push(toVisionResponseV2(result.classification, url));
      } else {
        failureCount++;
        console.warn(
          `[${GENERATOR}] image extract failed ${url}: ${result.error}`,
        );
      }
    }
  };
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < Math.min(PER_IMAGE_CONCURRENCY, urls.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return {
    total_cost_usd: totalCost,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    per_image_v2: perImageV2,
    success_count: successCount,
    failure_count: failureCount,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden — master_admin only', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse(
      {
        _version: VERSION,
        _fn: GENERATOR,
        model: PRIMARY_MODEL,
        schema_version: PULSE_EXTERNAL_LISTING_SCHEMA_VERSION,
      },
      200,
      req,
    );
  }

  // ── Inputs ─────────────────────────────────────────────────────────────────
  const listingIds: string[] = Array.isArray(body.listing_ids)
    ? body.listing_ids.filter((x): x is string => typeof x === 'string')
    : [];
  if (typeof body.listing_id === 'string') listingIds.unshift(body.listing_id);
  const dedupedIds = Array.from(new Set(listingIds));
  if (dedupedIds.length === 0) {
    return errorResponse('listing_id or listing_ids required', 400, req);
  }
  if (dedupedIds.length > MAX_LISTINGS_PER_BATCH) {
    return errorResponse(
      `batch size ${dedupedIds.length} exceeds cap ${MAX_LISTINGS_PER_BATCH}`,
      400,
      req,
    );
  }

  const triggeredBy: PulseVisionTriggeredBy = body.triggered_by ?? 'operator_manual';
  const schemaVersion = body.schema_version ?? PULSE_EXTERNAL_LISTING_SCHEMA_VERSION;
  const model = body.model ?? PRIMARY_MODEL;

  const admin = getAdminClient();

  // ── Cost gate ─────────────────────────────────────────────────────────────
  const dailyCapUsd = await getDailyCapUsd(admin);
  const dailySpendUsd = await getDailySpendUsd(admin);
  if (dailySpendUsd >= dailyCapUsd) {
    // Stamp the would-be extract row failed so the dashboard surfaces the
    // refusal. Use the FIRST listing in the batch as the canonical row;
    // batch members beyond the first don't get a row in the gated path.
    try {
      const { extract_id } = await createPulseVisionExtract(admin, {
        listing_id: dedupedIds[0],
        triggered_by: triggeredBy,
        triggered_by_user: isService ? null : (user?.id ?? null),
        schema_version: schemaVersion,
      });
      await markPulseVisionExtractFailed(
        admin,
        extract_id,
        `daily cost cap exceeded: $${dailySpendUsd.toFixed(4)} >= $${dailyCapUsd.toFixed(4)}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] cost-cap row stamp failed: ${msg}`);
    }
    return jsonResponse(
      {
        ok: false,
        reason: 'daily_cost_cap_exceeded',
        daily_spend_usd: dailySpendUsd,
        daily_cap_usd: dailyCapUsd,
      },
      429,
      req,
    );
  }

  // ── Hydrate listings ──────────────────────────────────────────────────────
  const { data: listings, error: lErr } = await admin
    .from('pulse_listings')
    .select('id, images, hero_image')
    .in('id', dedupedIds);
  if (lErr) {
    return errorResponse(
      `pulse_listings fetch failed: ${lErr.message}`,
      500,
      req,
    );
  }
  const rows = (listings || []) as PulseListingRow[];
  if (rows.length === 0) {
    return errorResponse('no matching pulse_listings rows', 404, req);
  }

  // ── Background dispatch ───────────────────────────────────────────────────
  const startedIso = new Date().toISOString();
  const bgWork = runExtractsBackground({
    admin,
    rows,
    triggeredBy,
    triggeredByUser: isService ? null : (user?.id ?? null),
    schemaVersion,
    model,
  }).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background work failed: ${msg}`);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: 'background',
      listing_count: rows.length,
      schema_version: schemaVersion,
      model,
      daily_spend_usd: dailySpendUsd,
      daily_cap_usd: dailyCapUsd,
      started_at: startedIso,
    },
    200,
    req,
  );
});

// ─── Background worker ───────────────────────────────────────────────────────

interface BackgroundArgs {
  admin: ReturnType<typeof getAdminClient>;
  rows: PulseListingRow[];
  triggeredBy: PulseVisionTriggeredBy;
  triggeredByUser: string | null;
  schemaVersion: string;
  model: string;
}

async function runExtractsBackground(args: BackgroundArgs): Promise<void> {
  for (const listing of args.rows) {
    let extract_id: string | null = null;
    try {
      const { extract_id: id } = await createPulseVisionExtract(args.admin, {
        listing_id: listing.id,
        triggered_by: args.triggeredBy,
        triggered_by_user: args.triggeredByUser,
        schema_version: args.schemaVersion,
      });
      extract_id = id;
      await markPulseVisionExtractRunning(args.admin, extract_id);

      const result = await extractListing(args.admin, {
        listing,
        extract_id,
        model: args.model,
        schema_version: args.schemaVersion,
      });

      await aggregatePerImageResults(args.admin, extract_id, result.per_image_v2);
      await aggregateCompetitorBranding(args.admin, extract_id, result.per_image_v2);

      const status: 'succeeded' | 'partial' | 'failed' =
        result.success_count === 0
          ? 'failed'
          : (result.failure_count > 0 ? 'partial' : 'succeeded');

      if (status === 'failed') {
        await markPulseVisionExtractFailed(
          args.admin,
          extract_id,
          `all ${result.failure_count} image(s) failed extraction`,
        );
      } else {
        // The helper's `markPulseVisionExtractSucceeded` always stamps
        // status='succeeded'. For 'partial' we want a different terminal label,
        // so do a direct update for that case to preserve the substrate's
        // status-state-machine semantics.
        if (status === 'partial') {
          await args.admin
            .from('pulse_listing_vision_extracts')
            .update({
              status: 'partial',
              extracted_at: new Date().toISOString(),
              total_cost_usd: result.total_cost_usd,
              total_input_tokens: result.total_input_tokens,
              total_output_tokens: result.total_output_tokens,
              vendor: PRIMARY_VENDOR,
              model_version: args.model,
              prompt_block_versions: {
                pulseExternalListingSchema: PULSE_EXTERNAL_LISTING_SCHEMA_VERSION,
              },
              failed_reason: `partial: ${result.failure_count}/${result.success_count + result.failure_count} image(s) failed`,
            })
            .eq('id', extract_id);
        } else {
          await markPulseVisionExtractSucceeded(args.admin, extract_id, {
            total_cost_usd: result.total_cost_usd,
            total_input_tokens: result.total_input_tokens,
            total_output_tokens: result.total_output_tokens,
            vendor: PRIMARY_VENDOR,
            model_version: args.model,
            prompt_block_versions: {
              pulseExternalListingSchema: PULSE_EXTERNAL_LISTING_SCHEMA_VERSION,
            },
          });
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] listing ${listing.id} failed: ${msg}`);
      if (extract_id) {
        try {
          await markPulseVisionExtractFailed(
            args.admin,
            extract_id,
            msg.slice(0, 1000),
          );
        } catch {
          /* noop — already logged */
        }
      }
    }
  }
}

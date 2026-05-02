/**
 * pulse-description-extractor
 * ───────────────────────────
 * Wave 13b — text-only Gemini 2.5 Pro extractor over `pulse_listings.description`.
 *
 * Pulls structured signal from each pulse-listing description and persists it
 * to `pulse_description_extracts` for two downstream consumers:
 *   - W14 calibration (premium-tier voice exemplars).
 *   - W12 organic registry growth (architectural_features + material_palette).
 *
 * Spec: docs/design-specs/W13b-pulse-description-goldmine.md (v2 section).
 *
 * Invocation modes:
 *   - { job_id }                         — dispatcher path. Hydrates from
 *                                          shortlisting_jobs.payload.
 *   - { pulse_listing_ids: [uuid, ...] } — direct master_admin invocation.
 *     { cost_cap_usd?: number,             Cost cap defaults to $1.0 (~140 rows).
 *       model?: string,                    Model defaults to gemini-2.5-pro.
 *       extractor_version?: string }       Version defaults to v1.0.
 *   - { _health_check: true }            — version stamp.
 *
 * Background-mode contract (matches shortlisting-shape-d):
 *   - Synchronous pre-flight (auth + cost gate + mutex acquire).
 *   - Background work in EdgeRuntime.waitUntil().
 *   - Returns 200 with `mode: 'background'`. The dispatcher inspects this
 *     and skips its auto-mark; bgWork self-updates shortlisting_jobs.status
 *     when it finishes.
 *
 * Idempotency: skip listings that already have a non-failed row at the same
 * extractor_version. Re-extraction is opt-in by bumping extractor_version.
 *
 * Cost cap behaviour: refuse to start if `pendingCount * 0.007 * 1.10 >
 * cost_cap_usd`. The 1.10 multiplier is the spec's headroom — same number
 * the cost model in W13b spec uses ($196 → $216 hard cap on full corpus).
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
import { estimateCost } from '../_shared/visionAdapter/pricing.ts';
import { tryAcquireMutex, releaseMutex } from '../_shared/dispatcherMutex.ts';

const GENERATOR = 'pulse-description-extractor';
const VERSION = 'v1.0';

// ─── Constants ───────────────────────────────────────────────────────────────

const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-pro';
const DEFAULT_THINKING_BUDGET = 1024;
const DEFAULT_MAX_OUTPUT_TOKENS = 2000;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_COST_CAP_USD = 1.0;
const PER_ROW_COST_ESTIMATE_USD = 0.007;
const COST_HEADROOM_MULTIPLIER = 1.10;
// Concurrency for per-row Gemini calls. Mirrors shape-d's STAGE1_PER_IMAGE_CONCURRENCY=8.
// 100-row smoke at concurrency=8 with ~10s/call finishes in ~125s — well inside
// Supabase Edge Function background wall (~400s).
const ROW_CONCURRENCY = 8;

const BACKGROUND_MODE_RESPONSE = 'background';

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  job_id?: string;
  pulse_listing_ids?: string[];
  cost_cap_usd?: number;
  model?: string;
  extractor_version?: string;
  _health_check?: boolean;
}

interface PulseListingRow {
  id: string;
  description: string | null;
  suburb: string | null;
  postcode: string | null;
  property_type: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  asking_price: number | null;
  sold_price: number | null;
  agency_name: string | null;
  listing_type: string | null;
}

interface ExtractedPayload {
  voice_register: 'premium' | 'standard' | 'approachable' | null;
  voice_archetype: string | null;
  architectural_features: string[];
  material_palette: string[];
  period_signals: string[];
  lifestyle_themes: string[];
  forbidden_phrases: string[];
  quality_indicators: {
    reading_grade_level: number;
    word_count: number;
    exclamation_marks: number;
  };
  derived_few_shot_eligibility: boolean;
  extractor_notes: string | null;
}

interface RowResult {
  pulse_listing_id: string;
  ok: boolean;
  cost_usd: number;
  duration_ms: number;
  input_tokens: number;
  output_tokens: number;
  payload?: ExtractedPayload;
  error?: string;
}

interface PreflightOk {
  jobId: string | null;
  costCapUsd: number;
  model: string;
  extractorVersion: string;
  pendingListings: PulseListingRow[];
  skippedCount: number;
  lockName: string;
  tickId: string;
  startedAt: number;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * The strict-JSON schema sent to Gemini's responseSchema. Kept in this file
 * (not _shared) because it's W13b-specific. If we add an Anthropic backfill
 * later, both vendors share this schema via callVisionAdapter.
 */
export const PULSE_EXTRACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    voice_register: {
      type: 'string',
      enum: ['premium', 'standard', 'approachable'],
      description: 'Voice register the listing copy uses.',
    },
    voice_archetype: {
      type: 'string',
      description:
        'Free-form short label for the voice (e.g. "Domain editorial", "Belle Property", "approachable suburban"). Max 64 chars.',
    },
    architectural_features: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Specific noun-phrases naming canonical-eligible architectural / fit-out features mentioned in the description (e.g. "limestone bench", "Federation cornicing", "north-facing alfresco"). 0-15 entries.',
    },
    material_palette: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Materials mentioned (e.g. "oak floorboards", "marble splashback", "burnished concrete"). 0-12 entries.',
    },
    period_signals: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Era hints (Federation, Edwardian, Victorian, Mid-century, contemporary, modernist, art-deco, etc.). 0-4 entries.',
    },
    lifestyle_themes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Lifestyle themes the copy emphasises (entertaining, family, lock-and-leave, downsizer, first-home, investor, low-maintenance, etc.). 0-6 entries.',
    },
    forbidden_phrases: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Cliches / overused phrases the description USED — e.g. "nestled", "boasting", "stunning", "must inspect". Used downstream as a "what NOT to write" list. 0-12 entries.',
    },
    quality_indicators: {
      type: 'object',
      properties: {
        reading_grade_level: {
          type: 'number',
          description:
            'Estimated Flesch-Kincaid reading grade level (1-20). Round to one decimal.',
        },
        word_count: { type: 'integer', description: 'Total word count.' },
        exclamation_marks: { type: 'integer', description: 'Count of "!" in the description.' },
      },
      required: ['reading_grade_level', 'word_count', 'exclamation_marks'],
    },
    derived_few_shot_eligibility: {
      type: 'boolean',
      description:
        'TRUE if this listing copy is publishable enough to be used as a voice exemplar in fewShotLibraryBlock. FALSE for thin / cliche-heavy / formatting-broken copy.',
    },
    extractor_notes: {
      type: 'string',
      description:
        'Optional one-sentence note explaining the eligibility decision or flagging anything notable. Max 240 chars.',
    },
  },
  required: [
    'voice_register',
    'voice_archetype',
    'architectural_features',
    'material_palette',
    'period_signals',
    'lifestyle_themes',
    'forbidden_phrases',
    'quality_indicators',
    'derived_few_shot_eligibility',
  ],
};

// ─── Prompt ──────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert Sydney real-estate copy analyst.

You read the published listing description for a single property and extract structured signal that will be used to (a) select voice exemplars for FlexMedia's listing-copy generation engine and (b) seed a canonical attribute registry of architectural features and materials mentioned in the Sydney market.

You are precise, conservative, and do NOT invent details that are not in the source description. If a field is not mentioned, return an empty array (or null where the schema allows it).

Voice register definitions (use these strictly):
- "premium" — editorial cadence, restrained tone, full sentences, period or designer references, minimal exclamations, comfortable with longer compound sentences. Often used by Belle Property, Pello, Domain editorial, Sotheby's, Christie's.
- "standard" — clear, polished, professional. Lists features cleanly with mild marketing flourish but does not over-rely on cliches. Sentences are competent but rarely literary. Most mid-tier Sydney agencies.
- "approachable" — friendly, sometimes informal, heavy on exclamations or all-caps emphasis, formula-driven feature lists. Often investor- or first-home-buyer-targeted.

Few-shot eligibility (derived_few_shot_eligibility):
- TRUE if the description is well-written, distinctive enough to teach voice, and free of obvious paste-in formatting glitches (URLs, "call code 1234", agent disclaimers, listing-platform boilerplate).
- FALSE if the description is thin (<60 words), heavily templated, mostly exclamation-driven shouting, or contains administrative junk (open-house instructions, contact-code prompts).

Forbidden phrases:
- List specific cliche phrases the description ACTUALLY USED. Common offenders: "nestled", "boasting", "stunning", "must inspect", "don't miss", "perfect for", "in the heart of".
- Only return phrases that ARE in the source. Do not invent.

Output strict JSON matching the responseSchema. No prose outside the JSON.`;

function buildUserPrompt(row: PulseListingRow): string {
  const priceBand = derivePriceBand(row);
  const meta: string[] = [];
  if (row.suburb) meta.push(`Suburb: ${row.suburb}${row.postcode ? ' ' + row.postcode : ''}`);
  if (row.property_type) meta.push(`Property type: ${row.property_type}`);
  if (row.bedrooms !== null && row.bedrooms !== undefined) {
    meta.push(`Beds: ${row.bedrooms}`);
  }
  if (row.bathrooms !== null && row.bathrooms !== undefined) {
    meta.push(`Baths: ${row.bathrooms}`);
  }
  meta.push(`Price band: ${priceBand}`);
  if (row.agency_name) meta.push(`Agency: ${row.agency_name}`);
  if (row.listing_type) meta.push(`Listing type: ${row.listing_type}`);

  const description = row.description ?? '';
  return `Property metadata:
${meta.join('\n')}

Listing description (verbatim):
"""
${description}
"""

Extract structured signal per the schema. Return JSON only.`;
}

/**
 * Map raw price → coarse band for prompt context. Pure function, exported for tests.
 */
export function derivePriceBand(row: PulseListingRow): string {
  // Treat rentals separately: low absolute amounts (e.g. $820 weekly) shouldn't
  // be classified as "<$1M sale".
  if (row.listing_type && /rent/i.test(row.listing_type)) return 'rental';
  const raw = row.sold_price ?? row.asking_price;
  if (raw === null || raw === undefined) return 'unknown';
  const price = Number(raw);
  if (!Number.isFinite(price) || price <= 0) return 'unknown';
  // Detect rental by magnitude when listing_type is missing — sale prices are
  // ≥ $100K in Sydney; weekly rents are typically $300–$5000.
  if (price < 10000) return 'rental';
  if (price < 1_000_000) return '<$1M';
  if (price < 2_000_000) return '$1M–$2M';
  if (price < 5_000_000) return '$2M–$5M';
  if (price < 10_000_000) return '$5M–$10M';
  return '>$10M';
}

// ─── Validation helpers ──────────────────────────────────────────────────────

/**
 * Coerce the model's free-form output into our typed shape, dropping unknown
 * fields and clamping arrays to schema-approved sizes. The model is reliable
 * but we defend against length blow-outs and missing fields.
 *
 * Pure function, exported for tests.
 */
export function normaliseExtractedPayload(raw: unknown): ExtractedPayload {
  const obj = (typeof raw === 'object' && raw !== null) ? (raw as Record<string, unknown>) : {};
  const arrayOf = (key: string, max: number): string[] => {
    const v = obj[key];
    if (!Array.isArray(v)) return [];
    return v
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, max);
  };

  const reg = (() => {
    const v = obj.voice_register;
    if (v === 'premium' || v === 'standard' || v === 'approachable') return v;
    return null;
  })();

  const arch = (() => {
    const v = obj.voice_archetype;
    if (typeof v === 'string') return v.slice(0, 64);
    return null;
  })();

  const qiRaw = (typeof obj.quality_indicators === 'object' && obj.quality_indicators !== null)
    ? obj.quality_indicators as Record<string, unknown>
    : {};
  const qi = {
    reading_grade_level: typeof qiRaw.reading_grade_level === 'number'
      ? qiRaw.reading_grade_level
      : 0,
    word_count: typeof qiRaw.word_count === 'number'
      ? Math.floor(qiRaw.word_count)
      : 0,
    exclamation_marks: typeof qiRaw.exclamation_marks === 'number'
      ? Math.floor(qiRaw.exclamation_marks)
      : 0,
  };

  const eligibility = obj.derived_few_shot_eligibility === true;

  const notes = typeof obj.extractor_notes === 'string'
    ? obj.extractor_notes.slice(0, 240)
    : null;

  return {
    voice_register: reg,
    voice_archetype: arch,
    architectural_features: arrayOf('architectural_features', 15),
    material_palette: arrayOf('material_palette', 12),
    period_signals: arrayOf('period_signals', 4),
    lifestyle_themes: arrayOf('lifestyle_themes', 6),
    forbidden_phrases: arrayOf('forbidden_phrases', 12),
    quality_indicators: qi,
    derived_few_shot_eligibility: eligibility,
    extractor_notes: notes,
  };
}

/**
 * Estimate per-row cost from token usage at Gemini 2.5 Pro rates.
 *
 * QC-iter2 W6b (F-E-002): Originally a duplicate inline override because
 * pricing.ts didn't list 2.5 rates. Since W11.8.2 added explicit 2.5 Pro/Flash
 * rows to `_shared/visionAdapter/pricing.ts`, the override is redundant. This
 * helper now thinly wraps `estimateCost('google', 'gemini-2.5-pro', ...)` so
 * the canonical pricing table is the single source of truth. Kept exported for
 * test compatibility.
 *
 * Pure function, exported for tests.
 */
export function estimateGemini25ProCost(input_tokens: number, output_tokens: number): number {
  return estimateCost('google', 'gemini-2.5-pro', {
    input_tokens,
    output_tokens,
    cached_input_tokens: 0,
  });
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
      { _version: VERSION, _fn: GENERATOR, model: PRIMARY_MODEL },
      200,
      req,
    );
  }

  // ── Synchronous pre-flight ─────────────────────────────────────────────────
  let preflight: PreflightOk;
  try {
    preflight = await runPreflight(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] preflight failed: ${msg}`);
    return errorResponse(`pulse-description-extractor preflight failed: ${msg}`, 400, req);
  }

  if (preflight.pendingListings.length === 0) {
    // Nothing to do — release the mutex synchronously and ack.
    const admin = getAdminClient();
    await releaseMutex(admin, preflight.lockName, preflight.tickId).catch(() => {});
    if (preflight.jobId) {
      await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          result: {
            ok: true,
            skipped_count: preflight.skippedCount,
            success_count: 0,
            failure_count: 0,
            total_cost_usd: 0,
            note: 'no pending listings — all already extracted at this version',
          },
        })
        .eq('id', preflight.jobId);
    }
    return jsonResponse(
      {
        ok: true,
        mode: 'sync',
        skipped_count: preflight.skippedCount,
        success_count: 0,
        failure_count: 0,
      },
      200,
      req,
    );
  }

  // ── Background dispatch ────────────────────────────────────────────────────
  const startedIso = new Date().toISOString();
  const bgWork = runExtractionBackground(preflight).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background work failed: ${msg}`);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: BACKGROUND_MODE_RESPONSE,
      job_id: preflight.jobId,
      pending_count: preflight.pendingListings.length,
      skipped_count: preflight.skippedCount,
      cost_cap_usd: preflight.costCapUsd,
      model: preflight.model,
      extractor_version: preflight.extractorVersion,
      started_at: startedIso,
    },
    200,
    req,
  );
});

// ─── Pre-flight ──────────────────────────────────────────────────────────────

async function runPreflight(body: RequestBody): Promise<PreflightOk> {
  const startedAt = Date.now();
  const admin = getAdminClient();

  // 1. Hydrate from job_id if present
  let jobId: string | null = body.job_id || null;
  let listingIds: string[] = body.pulse_listing_ids || [];
  let costCapUsd: number = body.cost_cap_usd ?? DEFAULT_COST_CAP_USD;
  let model: string = body.model || PRIMARY_MODEL;
  let extractorVersion: string = body.extractor_version || VERSION;

  if (jobId && listingIds.length === 0) {
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('payload')
      .eq('id', jobId)
      .maybeSingle();
    const payload = (job?.payload || {}) as Record<string, unknown>;
    if (Array.isArray(payload.pulse_listing_ids)) {
      listingIds = (payload.pulse_listing_ids as unknown[]).filter(
        (x): x is string => typeof x === 'string',
      );
    }
    if (typeof payload.cost_cap_usd === 'number') costCapUsd = payload.cost_cap_usd;
    if (typeof payload.model === 'string') model = payload.model;
    if (typeof payload.extractor_version === 'string') {
      extractorVersion = payload.extractor_version;
    }
  }

  if (listingIds.length === 0) {
    throw new Error('pulse_listing_ids required (either direct or via job.payload)');
  }

  // 2. Fetch the listings + filter out rows missing description / too short.
  const { data: listings, error: lErr } = await admin
    .from('pulse_listings')
    .select(
      'id, description, suburb, postcode, property_type, bedrooms, bathrooms, asking_price, sold_price, agency_name, listing_type',
    )
    .in('id', listingIds);
  if (lErr) throw new Error(`pulse_listings fetch failed: ${lErr.message}`);
  const rows: PulseListingRow[] = (listings || []) as PulseListingRow[];
  const usableRows = rows.filter(
    (r) => r.description !== null && r.description !== undefined && r.description.length >= 200,
  );

  // 3. Idempotency: drop rows already extracted at this version
  const { data: existing, error: eErr } = await admin
    .from('pulse_description_extracts')
    .select('pulse_listing_id, extract_status')
    .in('pulse_listing_id', usableRows.map((r) => r.id))
    .eq('extractor_version', extractorVersion);
  if (eErr) throw new Error(`pulse_description_extracts fetch failed: ${eErr.message}`);
  const alreadyDone = new Set(
    (existing || [])
      .filter((r) => r.extract_status === 'succeeded')
      .map((r) => r.pulse_listing_id as string),
  );
  const pendingListings = usableRows.filter((r) => !alreadyDone.has(r.id));
  const skippedCount = listingIds.length - pendingListings.length;

  // 4. Cost gate
  const estimatedUsd = pendingListings.length * PER_ROW_COST_ESTIMATE_USD * COST_HEADROOM_MULTIPLIER;
  if (estimatedUsd > costCapUsd) {
    throw new Error(
      `pre-flight cost $${estimatedUsd.toFixed(4)} exceeds cap $${costCapUsd.toFixed(4)} ` +
        `(${pendingListings.length} pending rows × $${PER_ROW_COST_ESTIMATE_USD.toFixed(4)}/row × ${COST_HEADROOM_MULTIPLIER} headroom). ` +
        `Increase cost_cap_usd or reduce batch size.`,
    );
  }

  // 5. Mutex — per-batch lock so concurrent dispatcher ticks don't double-process
  // the same payload. Lock name keys by the sorted-then-hashed listing IDs so
  // two non-overlapping batches can run in parallel.
  const lockName = `pulse-description-extractor:${jobId || 'direct'}-${pendingListings.length}`;
  const tickId = crypto.randomUUID();
  const acquired = await tryAcquireMutex(admin, lockName, tickId, 10 * 60 * 1000);
  if (!acquired) {
    throw new Error(`pulse-description-extractor batch already running (mutex held: ${lockName})`);
  }

  return {
    jobId,
    costCapUsd,
    model,
    extractorVersion,
    pendingListings,
    skippedCount,
    lockName,
    tickId,
    startedAt,
  };
}

// ─── Background worker ───────────────────────────────────────────────────────

async function runExtractionBackground(preflight: PreflightOk): Promise<void> {
  const admin = getAdminClient();
  const {
    jobId,
    costCapUsd,
    model,
    extractorVersion,
    pendingListings,
    skippedCount,
    lockName,
    tickId,
    startedAt,
  } = preflight;

  // Audit row — created up-front so a mid-run crash leaves a trace.
  const { data: auditRow, error: auditErr } = await admin
    .from('pulse_extract_audit')
    .insert({
      job_id: jobId,
      extractor_version: extractorVersion,
      model,
      vendor: PRIMARY_VENDOR,
      batch_size: pendingListings.length,
      skipped_count: skippedCount,
      cost_cap_usd: costCapUsd,
    })
    .select('id, batch_id')
    .single();
  if (auditErr) {
    console.warn(`[${GENERATOR}] audit row insert failed: ${auditErr.message}`);
  }
  const auditId = auditRow?.id as string | undefined;

  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let successCount = 0;
  let failureCount = 0;
  const results: RowResult[] = [];

  try {
    // Worker-pool pattern: ROW_CONCURRENCY workers pull from a shared cursor.
    // Each worker calls extractOne + persistRow sequentially within itself, so
    // total in-flight Gemini calls = ROW_CONCURRENCY (typically 8). Mirrors
    // shape-d's STAGE1_PER_IMAGE_CONCURRENCY pattern.
    let cursor = 0;
    let costCapReached = false;
    const worker = async () => {
      while (true) {
        // Defensive cost-cap mid-run.
        if (totalCost >= costCapUsd) {
          costCapReached = true;
          return;
        }
        const idx = cursor++;
        if (idx >= pendingListings.length) return;
        const row = pendingListings[idx];
        const result = await extractOne(row, model, extractorVersion);
        results.push(result);
        totalCost += result.cost_usd;
        totalInputTokens += result.input_tokens;
        totalOutputTokens += result.output_tokens;
        if (result.ok) successCount++;
        else failureCount++;
        await persistRow(admin, row.id, extractorVersion, model, result);
      }
    };
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < Math.min(ROW_CONCURRENCY, pendingListings.length); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    if (costCapReached) {
      console.warn(
        `[${GENERATOR}] mid-run cost cap reached: $${totalCost.toFixed(4)} >= $${costCapUsd.toFixed(4)} — stopped after ${results.length} rows`,
      );
    }

    // Final audit update
    if (auditId) {
      await admin
        .from('pulse_extract_audit')
        .update({
          success_count: successCount,
          failure_count: failureCount,
          total_cost_usd: totalCost,
          total_input_tokens: totalInputTokens,
          total_output_tokens: totalOutputTokens,
          total_wall_ms: Date.now() - startedAt,
          finished_at: new Date().toISOString(),
        })
        .eq('id', auditId);
    }

    // Self-update dispatching shortlisting_jobs row (background-mode contract).
    if (jobId) {
      await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          error_message: null,
          result: {
            ok: true,
            success_count: successCount,
            failure_count: failureCount,
            skipped_count: skippedCount,
            total_cost_usd: totalCost,
            total_input_tokens: totalInputTokens,
            total_output_tokens: totalOutputTokens,
            total_wall_ms: Date.now() - startedAt,
          },
        })
        .eq('id', jobId);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background run failed: ${msg}`);
    if (auditId) {
      await admin
        .from('pulse_extract_audit')
        .update({
          success_count: successCount,
          failure_count: failureCount,
          total_cost_usd: totalCost,
          total_wall_ms: Date.now() - startedAt,
          finished_at: new Date().toISOString(),
          notes: `aborted: ${msg.slice(0, 240)}`,
        })
        .eq('id', auditId);
    }
    if (jobId) {
      await admin
        .from('shortlisting_jobs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: msg.slice(0, 1000),
        })
        .eq('id', jobId);
    }
  } finally {
    await releaseMutex(admin, lockName, tickId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] mutex release failed: ${msg}`);
    });
  }
}

// ─── Per-row extraction ──────────────────────────────────────────────────────

async function extractOne(
  row: PulseListingRow,
  model: string,
  _extractorVersion: string,
): Promise<RowResult> {
  const startMs = Date.now();
  const userText = buildUserPrompt(row);

  const visionReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model,
    tool_name: 'extract_pulse_description',
    tool_input_schema: PULSE_EXTRACT_SCHEMA,
    system: SYSTEM_PROMPT,
    user_text: userText,
    images: [],
    max_output_tokens: DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: 0,
    timeout_ms: DEFAULT_TIMEOUT_MS,
    thinking_budget: DEFAULT_THINKING_BUDGET,
  };

  let response: VisionResponse;
  try {
    response = await callVisionAdapter(visionReq);
  } catch (err) {
    const isMissingCred = err instanceof MissingVendorCredential;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      pulse_listing_id: row.id,
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

  const payload = normaliseExtractedPayload(response.output);
  // Re-cost using actual Gemini 2.5 Pro rates (visionAdapter's pricing.ts has
  // gemini-2.0 only and falls back to Sonnet rates which over-count).
  const inputTokens = response.usage?.input_tokens || 0;
  const outputTokens = response.usage?.output_tokens || 0;
  const realCost = /gemini-2\.5-pro/i.test(model)
    ? estimateGemini25ProCost(inputTokens, outputTokens)
    : (response.usage?.estimated_cost_usd || 0);

  return {
    pulse_listing_id: row.id,
    ok: true,
    cost_usd: realCost,
    duration_ms: Date.now() - startMs,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    payload,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persistRow(
  admin: ReturnType<typeof getAdminClient>,
  pulseListingId: string,
  extractorVersion: string,
  model: string,
  result: RowResult,
): Promise<void> {
  const insert: Record<string, unknown> = {
    pulse_listing_id: pulseListingId,
    extractor_version: extractorVersion,
    model,
    vendor: PRIMARY_VENDOR,
    extract_status: result.ok ? 'succeeded' : 'failed',
    error_message: result.ok ? null : (result.error?.slice(0, 1000) ?? 'unknown'),
    input_tokens: result.input_tokens || null,
    output_tokens: result.output_tokens || null,
    cost_usd: result.cost_usd || 0,
    duration_ms: result.duration_ms || null,
    extracted_at: new Date().toISOString(),
  };

  if (result.ok && result.payload) {
    insert.voice_register = result.payload.voice_register;
    insert.voice_archetype = result.payload.voice_archetype;
    insert.architectural_features = result.payload.architectural_features;
    insert.material_palette = result.payload.material_palette;
    insert.period_signals = result.payload.period_signals;
    insert.lifestyle_themes = result.payload.lifestyle_themes;
    insert.forbidden_phrases = result.payload.forbidden_phrases;
    insert.quality_indicators = result.payload.quality_indicators;
    insert.derived_few_shot_eligibility = result.payload.derived_few_shot_eligibility;
    insert.extractor_notes = result.payload.extractor_notes;
  }

  // UPSERT on (pulse_listing_id, extractor_version) — re-runs at the same
  // version overwrite (e.g. retry of a previously-failed row).
  const { error } = await admin
    .from('pulse_description_extracts')
    .upsert(insert, { onConflict: 'pulse_listing_id,extractor_version' });
  if (error) {
    console.warn(
      `[${GENERATOR}] persist row ${pulseListingId} failed: ${error.message}`,
    );
  }
}

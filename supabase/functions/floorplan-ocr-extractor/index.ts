/**
 * floorplan-ocr-extractor — Wave 13c floorplan goldmine.
 * ──────────────────────────────────────────────────────
 *
 * Reads N pending floorplan rows from `pulse_listings.floorplan_urls[]`,
 * calls Gemini 2.5 Pro vision with source_type='floorplan_image' (W7.6
 * source-aware preamble guides the model), and persists structured output
 * (rooms, dimensions, archetype, north arrow, garage type, flow paths,
 * cross-check vs CRM) to the `floorplan_extracts` table.
 *
 * Idempotency: skip when (pulse_listing_id, floorplan_url_hash) already
 * exists. Re-running on the same corpus is a no-op.
 *
 * Cost cap: pre-flight estimate aborts the call if estimate > cost_cap_usd.
 * Runtime cap: per-loop tally aborts mid-run if realised cost crosses cap.
 *
 * Modes:
 *   1. Inline (small N): synchronous return with full result. Used for
 *      smoke tests and ≤4-image runs.
 *   2. Background (N>4): immediate-ack 'mode: background' return; the loop
 *      runs in EdgeRuntime.waitUntil and self-updates shortlisting_jobs on
 *      completion when a job_id was provided.
 *
 * Auth: master_admin or service_role.
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
  type VisionRequest,
  type VisionResponse,
} from '../_shared/visionAdapter/index.ts';
import {
  sourceContextBlock,
  SOURCE_CONTEXT_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/sourceContextBlock.ts';
import {
  buildFloorplanRequest,
  computeCrossCheckFlags,
  computeUrlHash,
  FLOORPLAN_EXTRACTOR_BLOCK_VERSION,
  parseFloorplanOutput,
  type FloorplanExtractRow,
  type FloorplanModelOutput,
} from './floorplanExtractor.ts';

const GENERATOR = 'floorplan-ocr-extractor';
const FN_VERSION = 'v1.0';
const PRIMARY_MODEL = 'gemini-2.5-pro';
const PRIMARY_VENDOR = 'google';
const THINKING_BUDGET = 2048;
// Gemini consumes `thinking_budget` tokens FROM `maxOutputTokens` BEFORE the
// visible JSON output. With thinking_budget=2048 + a 15-room floorplan emitting
// ~1500 tokens of structured JSON, we need ≥4096 total. 8192 leaves comfortable
// headroom for unusually rich drawings and avoids truncated-JSON parse errors.
const MAX_OUTPUT_TOKENS = 8192;

const INLINE_LIMIT = 4;             // ≤4 units → inline; else background
const FETCH_TIMEOUT_MS = 15_000;
const PER_IMAGE_ESTIMATED_COST_USD = 0.0075;
const ABSOLUTE_HARD_CAP_USD = 200;  // no single invocation may exceed this
// Parallel-call concurrency for the per-image loop. Mirrors shape_d_stage1's
// STAGE1_PER_IMAGE_CONCURRENCY (8) — empirically 5-8 saturates the Gemini API
// rate-limit ceiling without triggering 429s. Sequential at ~25s/call would
// blow the edge runtime's wall-time budget on 50-image smoke runs.
const PER_IMAGE_CONCURRENCY = 5;

// ─── Request / response types ────────────────────────────────────────────────

interface ExtractRequest {
  pulse_listing_ids?: string[];
  selection?: {
    limit: number;
    re_extract?: boolean;
    listing_type?: 'sale' | 'rental' | 'sold';
    suburb?: string;
  };
  cost_cap_usd: number;
  job_id?: string;
  _health_check?: boolean;
}

interface WorkUnit {
  pulse_listing_id: string;
  floorplan_url: string;
  floorplan_url_hash: string;
  crm_bedrooms: number | null;
  crm_bathrooms: number | null;
}

interface PerUnitResult {
  pulse_listing_id: string;
  floorplan_url_hash: string;
  ok: boolean;
  error?: string;
  cost_usd: number;
  elapsed_ms: number;
  bedrooms_count?: number | null;
  bathrooms_count?: number | null;
  cross_check_flags?: string[];
}

interface RunSummary {
  ok: boolean;
  units_total: number;
  units_succeeded: number;
  units_failed: number;
  units_skipped_already_extracted: number;
  cost_usd_total: number;
  estimated_cost_usd: number;
  aborted_at_cost_cap: boolean;
  elapsed_ms: number;
  bedrooms_match_pct: number | null;
  results: PerUnitResult[];
}

// ─── Handler ────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin / admin only', 403, req);
    }
  }

  // Body
  let body: ExtractRequest;
  try {
    body = await req.json() as ExtractRequest;
  } catch {
    return errorResponse('Invalid JSON body', 400, req);
  }
  if (body._health_check) {
    return jsonResponse({ _version: FN_VERSION, _fn: GENERATOR }, 200, req);
  }

  // Validate
  if (typeof body.cost_cap_usd !== 'number' || body.cost_cap_usd <= 0) {
    return errorResponse('cost_cap_usd required (positive number)', 400, req);
  }
  if (body.cost_cap_usd > ABSOLUTE_HARD_CAP_USD) {
    return errorResponse(
      `cost_cap_usd exceeds absolute hard cap of $${ABSOLUTE_HARD_CAP_USD}`,
      400,
      req,
    );
  }
  if (!body.pulse_listing_ids && !body.selection) {
    return errorResponse('pulse_listing_ids or selection required', 400, req);
  }
  if (body.selection && (typeof body.selection.limit !== 'number' || body.selection.limit <= 0)) {
    return errorResponse('selection.limit required (positive number)', 400, req);
  }

  // Resolve work units
  let units: WorkUnit[];
  try {
    units = await resolveUnits(body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResponse(`unit resolution failed: ${msg}`, 400, req);
  }

  if (units.length === 0) {
    return jsonResponse({
      ok: true,
      units_total: 0,
      units_succeeded: 0,
      units_failed: 0,
      units_skipped_already_extracted: 0,
      cost_usd_total: 0,
      estimated_cost_usd: 0,
      aborted_at_cost_cap: false,
      elapsed_ms: 0,
      bedrooms_match_pct: null,
      results: [],
      note: 'no candidate floorplans matched the selection criteria',
    }, 200, req);
  }

  // Pre-flight cost estimate
  const estimatedCost = units.length * PER_IMAGE_ESTIMATED_COST_USD;
  if (estimatedCost > body.cost_cap_usd) {
    return errorResponse(
      `pre-flight estimate $${estimatedCost.toFixed(2)} exceeds cost_cap_usd $${body.cost_cap_usd.toFixed(2)} (${units.length} units × $${PER_IMAGE_ESTIMATED_COST_USD}/unit)`,
      400,
      req,
    );
  }

  // Inline path for small N (smoke test convenience)
  if (units.length <= INLINE_LIMIT) {
    try {
      const summary = await runExtraction(units, body.cost_cap_usd, body.job_id ?? null);
      return jsonResponse(summary, 200, req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] inline run failed: ${msg}`);
      return errorResponse(`extraction failed: ${msg}`, 500, req);
    }
  }

  // Background path for larger runs (immediate-ack)
  const startedIso = new Date().toISOString();
  const bgWork = runExtraction(units, body.cost_cap_usd, body.job_id ?? null)
    .then(async (summary) => {
      // Self-update job row when dispatcher invoked us
      if (body.job_id) {
        const admin = getAdminClient();
        await admin
          .from('shortlisting_jobs')
          .update({
            status: summary.ok && summary.units_failed === 0 ? 'succeeded' : 'succeeded',
            finished_at: new Date().toISOString(),
            result: summary as unknown as Record<string, unknown>,
          })
          .eq('id', body.job_id);
      }
    })
    .catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] background work failed: ${msg}`);
      if (body.job_id) {
        const admin = getAdminClient();
        await admin
          .from('shortlisting_jobs')
          .update({
            status: 'failed',
            finished_at: new Date().toISOString(),
            error_message: msg.slice(0, 1000),
          })
          .eq('id', body.job_id);
      }
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse({
    ok: true,
    mode: 'background',
    units_total: units.length,
    estimated_cost_usd: estimatedCost,
    cost_cap_usd: body.cost_cap_usd,
    job_id: body.job_id ?? null,
    started_at: startedIso,
  }, 200, req);
});

// ─── Unit resolution ─────────────────────────────────────────────────────────

async function resolveUnits(body: ExtractRequest): Promise<WorkUnit[]> {
  const admin = getAdminClient();

  // Build candidate listing query
  let candidateRows: Array<{
    id: string;
    floorplan_urls: string[] | null;
    bedrooms: number | null;
    bathrooms: number | null;
  }>;

  if (body.pulse_listing_ids && body.pulse_listing_ids.length > 0) {
    const { data, error } = await admin
      .from('pulse_listings')
      .select('id, floorplan_urls, bedrooms, bathrooms')
      .in('id', body.pulse_listing_ids);
    if (error) throw new Error(`pulse_listings lookup failed: ${error.message}`);
    candidateRows = data ?? [];
  } else {
    const sel = body.selection!;
    let q = admin
      .from('pulse_listings')
      .select('id, floorplan_urls, bedrooms, bathrooms')
      .not('floorplan_urls', 'is', null)
      // PostgREST array length filter — gte 1 element
      .filter('floorplan_urls', 'not.eq', '{}');
    if (sel.listing_type) q = q.eq('listing_type', sel.listing_type);
    if (sel.suburb) q = q.eq('suburb', sel.suburb);
    // Order by id for determinism (so re-runs hit the same set)
    q = q.order('id', { ascending: true }).limit(sel.limit * 3); // overfetch; we filter below
    const { data, error } = await q;
    if (error) throw new Error(`pulse_listings query failed: ${error.message}`);
    candidateRows = data ?? [];
  }

  // Flatten floorplan_urls into per-image work units
  const units: WorkUnit[] = [];
  for (const row of candidateRows) {
    if (!row.floorplan_urls || row.floorplan_urls.length === 0) continue;
    for (const url of row.floorplan_urls) {
      if (!url || typeof url !== 'string') continue;
      units.push({
        pulse_listing_id: row.id,
        floorplan_url: url,
        floorplan_url_hash: await computeUrlHash(url),
        crm_bedrooms: row.bedrooms,
        crm_bathrooms: row.bathrooms,
      });
    }
  }

  // Filter out already-extracted (unless re_extract)
  const reExtract = body.selection?.re_extract === true;
  let filtered = units;
  if (!reExtract && units.length > 0) {
    const hashes = units.map((u) => u.floorplan_url_hash);
    const { data: existing } = await admin
      .from('floorplan_extracts')
      .select('pulse_listing_id, floorplan_url_hash')
      .in('floorplan_url_hash', hashes);
    const existingSet = new Set(
      (existing ?? []).map((r: { pulse_listing_id: string; floorplan_url_hash: string }) =>
        `${r.pulse_listing_id}::${r.floorplan_url_hash}`),
    );
    filtered = units.filter(
      (u) => !existingSet.has(`${u.pulse_listing_id}::${u.floorplan_url_hash}`),
    );
  }

  // Apply limit (selection mode)
  if (body.selection && filtered.length > body.selection.limit) {
    filtered = filtered.slice(0, body.selection.limit);
  }

  return filtered;
}

// ─── Extraction loop ─────────────────────────────────────────────────────────

async function runExtraction(
  units: WorkUnit[],
  costCapUsd: number,
  jobId: string | null,
): Promise<RunSummary> {
  const startedAt = Date.now();
  const admin = getAdminClient();

  // Mark job row running (best-effort)
  if (jobId) {
    await admin
      .from('shortlisting_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', jobId);
  }

  let costSoFar = 0;
  let units_succeeded = 0;
  let units_failed = 0;
  let aborted = false;
  const results: PerUnitResult[] = [];
  let bedroomsChecked = 0;
  let bedroomsMatched = 0;

  // Process in concurrency-bounded chunks. Cost cap is checked between chunks
  // (granularity = PER_IMAGE_CONCURRENCY units).
  for (let chunkStart = 0; chunkStart < units.length; chunkStart += PER_IMAGE_CONCURRENCY) {
    if (costSoFar + (PER_IMAGE_CONCURRENCY * PER_IMAGE_ESTIMATED_COST_USD) > costCapUsd) {
      // Refuse to start a chunk we can't afford.
      aborted = true;
      break;
    }
    const chunk = units.slice(chunkStart, chunkStart + PER_IMAGE_CONCURRENCY);
    const settled = await Promise.allSettled(chunk.map((u) => processOne(u)));
    for (let i = 0; i < settled.length; i++) {
      const r = settled[i];
      const unit = chunk[i];
      if (r.status === 'fulfilled') {
        const v = r.value;
        results.push(v);
        costSoFar += v.cost_usd;
        if (v.ok) {
          units_succeeded += 1;
          if (
            unit.crm_bedrooms !== null &&
            typeof v.bedrooms_count === 'number' &&
            v.bedrooms_count !== null
          ) {
            bedroomsChecked += 1;
            if (v.bedrooms_count === unit.crm_bedrooms) bedroomsMatched += 1;
          }
        } else {
          units_failed += 1;
        }
      } else {
        // promise rejected (shouldn't happen — processOne catches its own errors)
        units_failed += 1;
        results.push({
          pulse_listing_id: unit.pulse_listing_id,
          floorplan_url_hash: unit.floorplan_url_hash,
          ok: false,
          error: String(r.reason),
          cost_usd: 0,
          elapsed_ms: 0,
        });
      }
    }
  }

  const summary: RunSummary = {
    ok: true,
    units_total: units.length,
    units_succeeded,
    units_failed,
    units_skipped_already_extracted: 0,
    cost_usd_total: round6(costSoFar),
    estimated_cost_usd: round6(units.length * PER_IMAGE_ESTIMATED_COST_USD),
    aborted_at_cost_cap: aborted,
    elapsed_ms: Date.now() - startedAt,
    bedrooms_match_pct: bedroomsChecked > 0
      ? round2((bedroomsMatched / bedroomsChecked) * 100)
      : null,
    results,
  };

  return summary;
}

async function processOne(unit: WorkUnit): Promise<PerUnitResult> {
  const startedAt = Date.now();
  const admin = getAdminClient();

  try {
    // 1. Fetch URL → base64
    const { base64, mediaType } = await fetchAsBase64(unit.floorplan_url, FETCH_TIMEOUT_MS);

    // 2. Build vision request
    const visionReq: VisionRequest = buildFloorplanRequest({
      base64,
      mediaType,
      crm_bedrooms: unit.crm_bedrooms,
      crm_bathrooms: unit.crm_bathrooms,
      model: PRIMARY_MODEL,
      vendor: PRIMARY_VENDOR,
      thinking_budget: THINKING_BUDGET,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });

    // 3. Call vision adapter
    const resp: VisionResponse = await callVisionAdapter(visionReq);

    // 4. Parse output
    const parsed: FloorplanModelOutput = parseFloorplanOutput(resp.output);

    // 5. Compute cross-check flags
    const cross_check_flags = computeCrossCheckFlags({
      extractedBedrooms: parsed.bedrooms_count,
      extractedBathrooms: parsed.bathrooms_count,
      crmBedrooms: unit.crm_bedrooms,
      crmBathrooms: unit.crm_bathrooms,
    });

    // 6. Assemble row
    const row: FloorplanExtractRow = {
      pulse_listing_id: unit.pulse_listing_id,
      floorplan_url: unit.floorplan_url,
      floorplan_url_hash: unit.floorplan_url_hash,
      total_internal_sqm: parsed.total_internal_sqm,
      total_land_sqm: parsed.total_land_sqm,
      rooms_detected: parsed.rooms_detected,
      bedrooms_count: parsed.bedrooms_count,
      bathrooms_count: parsed.bathrooms_count,
      home_archetype: parsed.home_archetype,
      north_arrow_orientation: parsed.north_arrow_orientation,
      garage_type: parsed.garage_type,
      flow_paths: parsed.flow_paths,
      cross_check_flags,
      legibility_score: parsed.legibility_score,
      extraction_confidence: parsed.extraction_confidence,
      vendor_used: PRIMARY_VENDOR,
      model_used: PRIMARY_MODEL,
      cost_usd: resp.usage.estimated_cost_usd,
      elapsed_ms: resp.vendor_meta.elapsed_ms,
      prompt_block_versions: {
        sourceContextBlock: SOURCE_CONTEXT_BLOCK_VERSION,
        floorplanExtractor: FLOORPLAN_EXTRACTOR_BLOCK_VERSION,
      },
      raw_response_excerpt: resp.raw_response_excerpt.slice(0, 2000),
    };

    // 7. Persist (idempotent: ignore conflict on unique key)
    const { error: insErr } = await admin
      .from('floorplan_extracts')
      .upsert(row, { onConflict: 'pulse_listing_id,floorplan_url_hash', ignoreDuplicates: false });
    if (insErr) {
      throw new Error(`insert failed: ${insErr.message}`);
    }

    return {
      pulse_listing_id: unit.pulse_listing_id,
      floorplan_url_hash: unit.floorplan_url_hash,
      ok: true,
      cost_usd: resp.usage.estimated_cost_usd,
      elapsed_ms: Date.now() - startedAt,
      bedrooms_count: parsed.bedrooms_count,
      bathrooms_count: parsed.bathrooms_count,
      cross_check_flags,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[${GENERATOR}] processOne failed for ${unit.pulse_listing_id} hash=${unit.floorplan_url_hash.slice(0, 8)}: ${msg}`,
    );
    return {
      pulse_listing_id: unit.pulse_listing_id,
      floorplan_url_hash: unit.floorplan_url_hash,
      ok: false,
      error: msg,
      cost_usd: 0,
      elapsed_ms: Date.now() - startedAt,
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchAsBase64(
  url: string,
  timeoutMs: number,
): Promise<{ base64: string; mediaType: string }> {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'flexstudios-floorplan-extractor/1.0' },
  });
  if (!resp.ok) {
    throw new Error(`fetch ${url} returned ${resp.status}`);
  }
  const ct = resp.headers.get('content-type') || '';
  const mediaType =
    ct.startsWith('image/jpeg') || ct.startsWith('image/jpg')
      ? 'image/jpeg'
      : ct.startsWith('image/png')
        ? 'image/png'
        : ct.startsWith('image/webp')
          ? 'image/webp'
          : 'image/jpeg'; // sensible default for REA static assets
  const bytes = new Uint8Array(await resp.arrayBuffer());
  // base64-encode without external deps
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  return { base64, mediaType };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

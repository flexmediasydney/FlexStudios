/**
 * vendor-retroactive-compare
 * ──────────────────────────
 * Wave 11.8 retroactive vendor A/B harness.
 *
 * One-shot edge function that re-runs an existing shortlisting round through
 * multiple (vendor, model) configurations using the same prompt + image set,
 * persists the responses to `vendor_shadow_runs`, computes pairwise
 * comparison metrics, and writes a row to `vendor_comparison_results` plus
 * a markdown report to Dropbox at `Photos/_AUDIT/vendor_comparison_<round_id>.md`.
 *
 * Drives the Saladine A/B test (round 3ed54b53-9184-402f-9907-d168ed1968a4,
 * 42 composition_groups) per W11-8 spec Section 5.
 *
 * Auth: master_admin only (service-role bypass also allowed).
 *
 * Body (RetroactiveCompareRequest):
 *   {
 *     "round_id": "<uuid>",
 *     "vendors_to_compare": [
 *       { "vendor": "anthropic", "model": "claude-opus-4-7", "label": "anthropic-opus-baseline" },
 *       { "vendor": "google",    "model": "gemini-2.0-pro",   "label": "google-pro-test" }
 *     ],
 *     "pass_kinds": ["unified"],          // v1 only supports 'unified' (Pass 1 schema as the comparison)
 *     "cost_cap_usd": 5.00,
 *     "dry_run": false
 *   }
 *
 * Returns a summary JSON of cost actuals, latency, and the comparison_results
 * row id(s) written.
 *
 * Per-vendor flow (per spec Section 5):
 *   1. Load round's composition_groups with their best_bracket_stem
 *   2. Resolve preview Dropbox URLs at <root>/Photos/Raws/Shortlist Proposed/Previews/<stem>.jpg
 *   3. Build the unified prompt using existing W7.6 prompt blocks
 *   4. Fetch preview JPEGs as base64 (Dropbox getDropboxAccessToken + content endpoint)
 *   5. Call vendor via callVisionAdapter
 *   6. Persist raw response in vendor_shadow_runs
 *
 * After all vendors complete:
 *   7. Compute pairwise comparison metrics (vendorComparisonMetrics)
 *   8. Generate markdown report
 *   9. Write to vendor_comparison_results + upload to Dropbox _AUDIT
 *
 * Cost gate: pre-flight estimate (per spec, conservative fixed-token estimate)
 * × N vendors must fit cost_cap_usd or 400 with detail.
 *
 * For v1, the comparison schema is today's Pass 1 output (W11.7 unified is not
 * yet shipped); the harness validates COMPARATIVE quality between vendors
 * against the same prompt + schema.
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
  estimateCost,
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
  type VisionResponse,
  type VisionVendor,
} from '../_shared/visionAdapter/index.ts';
import { getDropboxAccessToken, uploadFile, createFolder } from '../_shared/dropbox.ts';
import { buildPass1Prompt } from '../_shared/pass1Prompt.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import {
  computeAgreementMatrix,
  computeScoreDelta,
  computeObjectOverlap,
  computeRoomTypeAgreement,
  generateMarkdownReport,
  type VendorRunSummary,
} from '../_shared/vendorComparisonMetrics.ts';

const GENERATOR = 'vendor-retroactive-compare';

// ─── Types ───────────────────────────────────────────────────────────────────

interface VendorConfig {
  vendor: VisionVendor;
  model: string;
  label: string;
}

interface RetroactiveCompareRequest {
  round_id: string;
  vendors_to_compare: VendorConfig[];
  pass_kinds: ('unified' | 'description_backfill')[];
  cost_cap_usd: number;
  dry_run?: boolean;
  /**
   * Limit how many composition_groups to call. Useful for dev / partial
   * tests. Defaults to all groups in the round.
   */
  max_groups?: number;
}

interface CompositionRow {
  group_id: string;
  group_index: number;
  stem: string;
  delivery_reference_stem: string | null;
  best_bracket_stem: string | null;
}

// ─── Cost pre-flight ─────────────────────────────────────────────────────────

/**
 * Conservative per-call token estimates. The unified Pass 1 prompt averages
 * ~2.5K input tokens (system+user blocks) + ~1500 input tokens per image
 * (Anthropic compresses to ~1.5K; Gemini varies; we bill at the ceiling).
 * Output is ~1500 tokens hard-cap by request.
 *
 * For dry_run / pre-flight we estimate per-composition cost at one call,
 * multiply by N compositions × N vendors. The actual usage is recorded on
 * the response and persisted.
 */
const PRE_FLIGHT_INPUT_TOKENS_PER_COMPOSITION = 4_000;
const PRE_FLIGHT_OUTPUT_TOKENS_PER_COMPOSITION = 1_500;

function preflightCost(vendor: VisionVendor, model: string, n_compositions: number): number {
  const per = estimateCost(vendor, model, {
    input_tokens: PRE_FLIGHT_INPUT_TOKENS_PER_COMPOSITION,
    output_tokens: PRE_FLIGHT_OUTPUT_TOKENS_PER_COMPOSITION,
    cached_input_tokens: 0,
  });
  return per * n_compositions;
}

// ─── Body validation ─────────────────────────────────────────────────────────

function validateBody(body: unknown): { ok: true; req: RetroactiveCompareRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.round_id !== 'string' || !b.round_id) return { ok: false, error: 'round_id required' };
  if (!Array.isArray(b.vendors_to_compare) || b.vendors_to_compare.length < 1) {
    return { ok: false, error: 'vendors_to_compare must be a non-empty array' };
  }
  for (const v of b.vendors_to_compare as unknown[]) {
    if (!v || typeof v !== 'object') return { ok: false, error: 'vendor entry malformed' };
    const vc = v as Record<string, unknown>;
    if (vc.vendor !== 'anthropic' && vc.vendor !== 'google') {
      return { ok: false, error: `vendor must be 'anthropic' or 'google' (got '${vc.vendor}')` };
    }
    if (typeof vc.model !== 'string' || !vc.model) return { ok: false, error: 'vendor.model required' };
    if (typeof vc.label !== 'string' || !vc.label) return { ok: false, error: 'vendor.label required' };
  }
  if (!Array.isArray(b.pass_kinds) || b.pass_kinds.length === 0) {
    return { ok: false, error: 'pass_kinds must be a non-empty array' };
  }
  for (const pk of b.pass_kinds as unknown[]) {
    if (pk !== 'unified' && pk !== 'description_backfill') {
      return { ok: false, error: `pass_kind must be 'unified' or 'description_backfill' (got '${pk}')` };
    }
  }
  if (typeof b.cost_cap_usd !== 'number' || b.cost_cap_usd <= 0) {
    return { ok: false, error: 'cost_cap_usd must be a positive number' };
  }
  if (b.dry_run !== undefined && typeof b.dry_run !== 'boolean') {
    return { ok: false, error: 'dry_run must be boolean when present' };
  }
  if (b.max_groups !== undefined && (typeof b.max_groups !== 'number' || b.max_groups <= 0)) {
    return { ok: false, error: 'max_groups must be a positive number when present' };
  }
  return { ok: true, req: b as unknown as RetroactiveCompareRequest };
}

// ─── Round load ──────────────────────────────────────────────────────────────

async function loadRoundContext(roundId: string): Promise<{
  round: { project_id: string };
  project: { dropbox_root_path: string | null };
  compositions: CompositionRow[];
}> {
  const admin = getAdminClient();
  const { data: round, error: rErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id')
    .eq('id', roundId)
    .single();
  if (rErr || !round) throw new Error(`round ${roundId} not found: ${rErr?.message || 'no row'}`);

  const { data: proj, error: pErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path')
    .eq('id', round.project_id)
    .single();
  if (pErr || !proj) throw new Error(`project ${round.project_id} not found: ${pErr?.message || 'no row'}`);

  const { data: groups, error: gErr } = await admin
    .from('composition_groups')
    .select('id, group_index, delivery_reference_stem, best_bracket_stem')
    .eq('round_id', roundId)
    .order('group_index');
  if (gErr) throw new Error(`composition_groups load failed: ${gErr.message}`);

  const compositions: CompositionRow[] = (groups || []).map((g: Record<string, unknown>) => {
    const delivery = (g.delivery_reference_stem as string | null) || null;
    const best = (g.best_bracket_stem as string | null) || null;
    return {
      group_id: g.id as string,
      group_index: g.group_index as number,
      stem: delivery || best || `group_${g.group_index}`,
      delivery_reference_stem: delivery,
      best_bracket_stem: best,
    };
  });

  return {
    round: { project_id: round.project_id as string },
    project: { dropbox_root_path: (proj.dropbox_root_path as string | null) ?? null },
    compositions,
  };
}

// ─── Preview fetch ───────────────────────────────────────────────────────────

/**
 * Fetch a Dropbox preview JPEG and return it as base64.
 *
 * Uses the Dropbox content endpoint /files/download via getDropboxAccessToken
 * (matches the dropbox.ts fetch pattern). Throws on failure — the harness
 * catches and skips the composition (logs an error_message in the shadow_run
 * row so the operator can see which images failed).
 */
async function fetchPreviewBase64(
  dropboxPath: string,
): Promise<{ data: string; media_type: string }> {
  const token = await getDropboxAccessToken();
  // Team-folder namespace header — without this, paths like
  // "/Flex Media Team Folder/..." resolve in the user's PERSONAL namespace
  // and 404. Mirrors `_shared/dropbox.ts:pathRootHeader()`.
  const ns = Deno.env.get('DROPBOX_TEAM_NAMESPACE_ID');
  const pathRootHeader: Record<string, string> = ns
    ? { 'Dropbox-API-Path-Root': JSON.stringify({ '.tag': 'root', root: ns }) }
    : {};
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dropboxPath }),
      ...pathRootHeader,
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`dropbox download ${res.status}: ${txt.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  // Base64-encode in fixed-size chunks so we don't blow the call stack on
  // 1MB+ JPEGs (String.fromCharCode(...veryLargeArray) crashes V8).
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  const data = btoa(bin);
  return { data, media_type: 'image/jpeg' };
}

// ─── Schema for the comparison call ──────────────────────────────────────────

/**
 * For v1, we use today's Pass 1 schema as the comparison shape — the
 * "unified" call is conceptually a Pass 1+2 merged classification, but
 * W11.7 hasn't shipped, so we score the comparison on the per-image Pass 1
 * fields. This reuses the existing prompt blocks and produces directly-
 * comparable outputs across vendors.
 *
 * The schema has to be Gemini-responseSchema-compatible (no $ref, no
 * patternProperties, no additionalProperties: keep it flat).
 */
const COMPARISON_TOOL_NAME = 'classify_image';
const COMPARISON_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    analysis: { type: 'string' },
    room_type: { type: 'string' },
    room_type_confidence: { type: 'number' },
    composition_type: { type: 'string' },
    vantage_point: { type: 'string' },
    time_of_day: { type: 'string' },
    is_drone: { type: 'boolean' },
    is_exterior: { type: 'boolean' },
    is_detail_shot: { type: 'boolean' },
    zones_visible: { type: 'array', items: { type: 'string' } },
    key_elements: { type: 'array', items: { type: 'string' } },
    is_styled: { type: 'boolean' },
    indoor_outdoor_visible: { type: 'boolean' },
    clutter_severity: { type: 'string' },
    clutter_detail: { type: 'string' },
    flag_for_retouching: { type: 'boolean' },
    technical_score: { type: 'number' },
    lighting_score: { type: 'number' },
    composition_score: { type: 'number' },
    aesthetic_score: { type: 'number' },
  },
  required: [
    'analysis',
    'room_type',
    'composition_type',
    'technical_score',
    'lighting_score',
    'composition_score',
    'aesthetic_score',
    'key_elements',
  ],
};

// ─── Per-vendor sweep ────────────────────────────────────────────────────────

/**
 * Concurrency for the composition sweep. Each composition fans out one call
 * per vendor in parallel; we then run BATCH_SIZE compositions in parallel.
 *
 * For 42 compositions × 2 vendors @ ~15s/call:
 *   - sequential (old): 1260s = 21 min (way past the 400s edge worker cap)
 *   - parallel vendors only: 630s = 10.5 min
 *   - batches of 4 compositions × parallel vendors: ~165s = 2.75 min
 *
 * Both Anthropic (tier-1: 50 RPM) and Gemini 2.5 Pro pay-as-you-go (60 RPM)
 * tolerate this comfortably. Per-call AbortSignal.timeout(90s) inside the
 * adapter ensures one slow call can't stall the whole batch.
 */
const BATCH_SIZE = 4;

interface ShadowRunRecord {
  group_id: string;
  vendor: VisionVendor;
  model: string;
  label: string;
  output: Record<string, unknown> | null;
  cost_usd: number;
  elapsed_ms: number;
  error_message: string | null;
}

async function runVendorOnComposition(
  cfg: VendorConfig,
  comp: CompositionRow,
  preview: { data: string; media_type: string },
  promptSystem: string,
  promptUser: string,
): Promise<{ resp: VisionResponse | null; error?: string }> {
  const req: VisionRequest = {
    vendor: cfg.vendor,
    model: cfg.model,
    tool_name: COMPARISON_TOOL_NAME,
    tool_input_schema: COMPARISON_TOOL_SCHEMA,
    system: promptSystem,
    user_text: promptUser,
    images: [{ source_type: 'base64', media_type: preview.media_type, data: preview.data }],
    max_output_tokens: 4000,
    temperature: 0,
  };
  try {
    const resp = await callVisionAdapter(req);
    return { resp };
  } catch (err) {
    if (err instanceof MissingVendorCredential) {
      return { resp: null, error: err.message };
    }
    if (err instanceof VendorCallError) {
      return { resp: null, error: `${err.vendor}/${err.model} ${err.status ?? ''}: ${err.message}` };
    }
    return { resp: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function persistShadowRun(
  round_id: string,
  cfg: VendorConfig,
  comp: CompositionRow,
  resp: VisionResponse | null,
  error: string | undefined,
  pass_kind: 'unified' | 'description_backfill',
  request_payload: VisionRequest,
): Promise<void> {
  const admin = getAdminClient();
  // We strip the base64 image data from the persisted request_payload — those
  // are tens of MB and Dropbox path is more useful for replay. Replace
  // images with their length+media_type.
  const safe_request: Record<string, unknown> = {
    ...request_payload,
    images: request_payload.images.map((i) => ({
      source_type: i.source_type,
      media_type: i.media_type,
      data_length: i.data?.length ?? 0,
    })),
  };
  const row: Record<string, unknown> = {
    round_id,
    pass_kind,
    vendor: cfg.vendor,
    model: cfg.model,
    label: cfg.label,
    group_id: comp.group_id,
    request_payload: safe_request,
    response_output: resp?.output ?? null,
    response_usage: resp?.usage ?? null,
    vendor_meta: resp?.vendor_meta ?? null,
    error_message: error ?? null,
  };
  const { error: insErr } = await admin.from('vendor_shadow_runs').insert(row);
  if (insErr) {
    console.warn(`[${GENERATOR}] vendor_shadow_runs insert failed: ${insErr.message}`);
  }
}

// ─── Markdown upload ─────────────────────────────────────────────────────────

async function uploadComparisonReport(
  dropboxRoot: string | null,
  round_id: string,
  markdown: string,
): Promise<string | null> {
  if (!dropboxRoot) return null;
  const path = `${dropboxRoot.replace(/\/+$/, '')}/Photos/_AUDIT/vendor_comparison_${round_id}.md`;
  try {
    await uploadFile(path, markdown, 'overwrite');
    return path;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Same recovery pattern as shortlist-lock: if Photos/_AUDIT/ doesn't
    // exist, create it and retry once.
    if (msg.includes('path/not_found') || msg.includes('not_found')) {
      try {
        const auditDir = `${dropboxRoot.replace(/\/+$/, '')}/Photos/_AUDIT`;
        await createFolder(auditDir);
        await uploadFile(path, markdown, 'overwrite');
        return path;
      } catch (retryErr) {
        const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[${GENERATOR}] markdown report upload retry failed: ${m}`);
        return null;
      }
    }
    console.warn(`[${GENERATOR}] markdown report upload failed: ${msg}`);
    return null;
  }
}

// ─── Background processing ───────────────────────────────────────────────────

interface ProcessComparisonArgs {
  round_id: string;
  ctx: Awaited<ReturnType<typeof loadRoundContext>>;
  compositionsToRun: CompositionRow[];
  vendors_to_compare: VendorConfig[];
  pass_kinds: ('unified' | 'description_backfill')[];
  prompt: { system: string; userPrefix: string };
}

interface PrimedRun {
  group_id: string;
  label: string;
  output: Record<string, unknown>;
  cost_usd: number;
  elapsed_ms: number;
}

/**
 * Load existing successful shadow_runs for this (round, vendor-set) so we
 * don't re-pay for compositions we've already classified. Per-vendor cache:
 * if a (group_id, label) already has response_output != null, we reuse it
 * and skip the API call.
 *
 * This is crucial for iterative debugging — when a vendor (e.g. Gemini)
 * fails 95% of compositions and the adapter is fixed, re-running the
 * harness should ONLY retry the failed combos, not re-pay $6 for the
 * already-good Anthropic side.
 */
async function loadPrimedRuns(
  round_id: string,
  labels: string[],
): Promise<Map<string, PrimedRun>> {
  const primed = new Map<string, PrimedRun>();
  if (labels.length === 0) return primed;
  const admin = getAdminClient();
  const { data, error } = await admin
    .from('vendor_shadow_runs')
    .select('group_id, label, response_output, response_usage, vendor_meta')
    .eq('round_id', round_id)
    .in('label', labels)
    .not('response_output', 'is', null);
  if (error) {
    console.warn(`[${GENERATOR}] loadPrimedRuns failed (will treat all as fresh): ${error.message}`);
    return primed;
  }
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const group_id = row.group_id as string;
    const label = row.label as string;
    const output = row.response_output as Record<string, unknown> | null;
    if (!output) continue;
    const usage = (row.response_usage as Record<string, unknown> | null) || {};
    const vendor_meta = (row.vendor_meta as Record<string, unknown> | null) || {};
    const cost_usd = typeof usage.estimated_cost_usd === 'number' ? usage.estimated_cost_usd : 0;
    const elapsed_ms = typeof vendor_meta.elapsed_ms === 'number' ? vendor_meta.elapsed_ms : 0;
    primed.set(`${group_id}::${label}`, { group_id, label, output, cost_usd, elapsed_ms });
  }
  return primed;
}

/**
 * Process one composition: fetch preview once, fan out one call per vendor
 * in parallel, persist shadow runs, return the per-vendor summaries.
 *
 * Each call has the adapter's own AbortSignal.timeout(90s) — the slowest
 * vendor caps the composition's wall time.
 */
async function processOneComposition(
  comp: CompositionRow,
  vendors_to_compare: VendorConfig[],
  prompt: { system: string; userPrefix: string },
  pass_kinds: ('unified' | 'description_backfill')[],
  round_id: string,
  dropboxRoot: string,
  primed: Map<string, PrimedRun>,
): Promise<Array<{
  cfg: VendorConfig;
  group_id: string;
  stem: string;
  resp: VisionResponse | null;
  elapsed_ms: number;
  cost_usd: number;
  err?: string;
  primed?: boolean;
}>> {
  // Determine which vendors actually need a fresh API call. If a vendor
  // already has a successful shadow_run for this (round, group, label) we
  // reuse it via the primed map and skip the call.
  const vendorsToCall: VendorConfig[] = [];
  const primedResults: Array<{
    cfg: VendorConfig;
    group_id: string;
    stem: string;
    resp: VisionResponse | null;
    elapsed_ms: number;
    cost_usd: number;
    err?: string;
    primed?: boolean;
  }> = [];
  for (const cfg of vendors_to_compare) {
    const key = `${comp.group_id}::${cfg.label}`;
    const p = primed.get(key);
    if (p) {
      // Reconstruct a minimal VisionResponse-shaped record so downstream
      // metrics see the cached output. resp is intentionally null since
      // there's no fresh adapter response — we hand-pack the fields the
      // summary loop reads.
      primedResults.push({
        cfg,
        group_id: comp.group_id,
        stem: comp.stem,
        resp: {
          output: p.output,
          usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, estimated_cost_usd: p.cost_usd },
          vendor_meta: { vendor: cfg.vendor, model: cfg.model, request_id: '', finish_reason: 'stop', elapsed_ms: p.elapsed_ms },
          raw_response_excerpt: '',
        } as VisionResponse,
        elapsed_ms: p.elapsed_ms,
        cost_usd: p.cost_usd,
        primed: true,
      });
    } else {
      vendorsToCall.push(cfg);
    }
  }
  // Skip preview fetch entirely if every vendor is already primed.
  if (vendorsToCall.length === 0) return primedResults;

  const previewPath = `${dropboxRoot.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews/${comp.stem}.jpg`;
  let preview: { data: string; media_type: string } | null = null;
  let previewErr: string | null = null;
  try {
    preview = await fetchPreviewBase64(previewPath);
  } catch (err) {
    previewErr = err instanceof Error ? err.message : String(err);
  }

  const passKind: 'unified' | 'description_backfill' = pass_kinds.includes('unified')
    ? 'unified'
    : pass_kinds[0];

  // Fan out vendors in parallel for this composition (those not already primed).
  const vendorResults = await Promise.all(vendorsToCall.map(async (cfg) => {
    const startSpan = Date.now();
    let resp: VisionResponse | null = null;
    let err: string | undefined;
    let request_payload: VisionRequest;

    if (preview) {
      request_payload = {
        vendor: cfg.vendor,
        model: cfg.model,
        tool_name: COMPARISON_TOOL_NAME,
        tool_input_schema: COMPARISON_TOOL_SCHEMA,
        system: prompt.system,
        user_text: prompt.userPrefix,
        images: [{ source_type: 'base64', media_type: preview.media_type, data: preview.data }],
        max_output_tokens: 4000,
        temperature: 0,
      };
      const r = await runVendorOnComposition(cfg, comp, preview, prompt.system, prompt.userPrefix);
      resp = r.resp;
      err = r.error;
    } else {
      err = previewErr || 'preview unavailable';
      request_payload = {
        vendor: cfg.vendor,
        model: cfg.model,
        tool_name: COMPARISON_TOOL_NAME,
        tool_input_schema: COMPARISON_TOOL_SCHEMA,
        system: prompt.system,
        user_text: prompt.userPrefix,
        images: [],
        max_output_tokens: 4000,
        temperature: 0,
      };
    }

    try {
      await persistShadowRun(round_id, cfg, comp, resp, err, passKind, request_payload);
    } catch (persistErr) {
      console.warn(`[${GENERATOR}] persist shadow run failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
    }

    const elapsed_ms = resp?.vendor_meta.elapsed_ms ?? (Date.now() - startSpan);
    const cost_usd = resp?.usage.estimated_cost_usd ?? 0;
    return { cfg, group_id: comp.group_id, stem: comp.stem, resp, elapsed_ms, cost_usd, err };
  }));

  // Merge primed (cached) results with fresh API results. Order doesn't
  // matter for the summary aggregation downstream.
  return [...primedResults, ...vendorResults];
}

/**
 * Run the full composition sweep + metrics + persistence asynchronously.
 *
 * Invoked via `EdgeRuntime.waitUntil(...)` from the handler so the request
 * returns immediately and the worker keeps running until this resolves.
 *
 * Progress is observable in real time via:
 *   SELECT count(*) FROM vendor_shadow_runs WHERE round_id = '<id>'
 * which increments after each vendor call persists.
 *
 * The final markdown report appears at:
 *   <dropbox_root>/Photos/_AUDIT/vendor_comparison_<round_id>.md
 *
 * On completion, vendor_comparison_results gets one row per (primary, shadow)
 * pair.
 */
async function processComparison(args: ProcessComparisonArgs): Promise<void> {
  const { round_id, ctx, compositionsToRun, vendors_to_compare, pass_kinds, prompt } = args;
  const startedAt = Date.now();

  const runs: Map<string, VendorRunSummary> = new Map();
  for (const cfg of vendors_to_compare) {
    runs.set(cfg.label, {
      label: cfg.label,
      vendor: cfg.vendor,
      model: cfg.model,
      total_cost_usd: 0,
      total_elapsed_ms: 0,
      composition_count: 0,
      failure_count: 0,
      results: [],
    });
  }

  const dropboxRoot = ctx.project.dropbox_root_path;
  if (!dropboxRoot) {
    console.warn(`[${GENERATOR}] project has no dropbox_root_path; nothing to fetch — abort`);
    return;
  }

  // Prime from existing successful shadow_runs so we don't re-pay for
  // already-classified (composition, vendor) combos. Hugely useful for
  // iterative debugging when one vendor's adapter fails most calls and
  // gets fixed — second run reuses the good vendor's data.
  const primed = await loadPrimedRuns(round_id, vendors_to_compare.map((v) => v.label));
  if (primed.size > 0) {
    console.log(`[${GENERATOR}] primed ${primed.size} cached results from prior shadow_runs (skipping those API calls)`);
  }

  // Process compositions in batches, fanning out vendors per composition.
  for (let i = 0; i < compositionsToRun.length; i += BATCH_SIZE) {
    const batch = compositionsToRun.slice(i, i + BATCH_SIZE);
    console.log(`[${GENERATOR}] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(compositionsToRun.length / BATCH_SIZE)} (compositions ${i + 1}..${Math.min(i + BATCH_SIZE, compositionsToRun.length)})`);
    const batchResults = await Promise.all(batch.map((comp) =>
      processOneComposition(comp, vendors_to_compare, prompt, pass_kinds, round_id, dropboxRoot, primed)
        .catch((err) => {
          console.error(`[${GENERATOR}] composition ${comp.stem} failed: ${err instanceof Error ? err.message : String(err)}`);
          return [] as Array<{
            cfg: VendorConfig;
            group_id: string;
            stem: string;
            resp: VisionResponse | null;
            elapsed_ms: number;
            cost_usd: number;
            err?: string;
            primed?: boolean;
          }>;
        })
    ));
    for (const compResults of batchResults) {
      for (const r of compResults) {
        const summary = runs.get(r.cfg.label)!;
        summary.composition_count += 1;
        summary.total_cost_usd += r.cost_usd;
        summary.total_elapsed_ms += r.elapsed_ms;
        if (r.resp) {
          summary.results.push({ group_id: r.group_id, stem: r.stem, output: r.resp.output });
        } else {
          summary.failure_count += 1;
        }
      }
    }
  }

  // Comparison metrics — pairwise (every vendor against the first).
  const labels = vendors_to_compare.map((v) => v.label);
  if (labels.length < 2) {
    console.log(`[${GENERATOR}] single-vendor mode — no pairwise comparison`);
    return;
  }

  const primary = runs.get(labels[0])!;
  const allComparisons = labels.slice(1).map((shadowLabel) => {
    const shadow = runs.get(shadowLabel)!;
    const agreement = computeAgreementMatrix(primary.results, shadow.results);
    const score = computeScoreDelta(primary.results, shadow.results);
    const obj = computeObjectOverlap(primary.results, shadow.results);
    const room = computeRoomTypeAgreement(primary.results, shadow.results);
    return { primary, shadow, agreement, score, obj, room };
  });

  const markdown = generateMarkdownReport(round_id, allComparisons);
  const dropbox_report_path = await uploadComparisonReport(dropboxRoot, round_id, markdown);

  const admin = getAdminClient();
  for (const c of allComparisons) {
    const summary_truncated = markdown.slice(0, 2000);
    const { error: insErr } = await admin.from('vendor_comparison_results').insert({
      round_id,
      primary_vendor: c.primary.vendor,
      primary_model: c.primary.model,
      primary_label: c.primary.label,
      shadow_vendor: c.shadow.vendor,
      shadow_model: c.shadow.model,
      shadow_label: c.shadow.label,
      slot_decision_agreement_rate: null,
      near_duplicate_agreement_rate: null,
      classification_agreement_rate: c.room.agreement_rate,
      combined_score_mean_abs_delta: c.score.mean_abs_delta,
      combined_score_correlation: c.score.correlation,
      observed_objects_overlap_rate: c.obj.jaccard,
      primary_cost_usd: Number(c.primary.total_cost_usd.toFixed(6)),
      shadow_cost_usd: Number(c.shadow.total_cost_usd.toFixed(6)),
      primary_elapsed_ms: c.primary.total_elapsed_ms,
      shadow_elapsed_ms: c.shadow.total_elapsed_ms,
      disagreement_summary: summary_truncated,
      dropbox_report_path,
    }).select('id').single();
    if (insErr) {
      console.warn(`[${GENERATOR}] vendor_comparison_results insert failed: ${insErr.message}`);
    }
  }

  const elapsed_total_s = Math.round((Date.now() - startedAt) / 1000);
  console.log(`[${GENERATOR}] background sweep complete in ${elapsed_total_s}s — ${compositionsToRun.length} compositions × ${vendors_to_compare.length} vendors → ${dropbox_report_path ?? '(no report)'}`);
}

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handler(req: Request): Promise<Response> {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('method not allowed', 405);

  // Auth: master_admin only (or service-role).
  const user = await getUserFromReq(req);
  if (!user) return errorResponse('unauthorized', 401);
  if (user.role !== 'master_admin') return errorResponse('forbidden — master_admin only', 403);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorResponse('invalid JSON body', 400);
  }
  const v = validateBody(body);
  if (!v.ok) return errorResponse(v.error, 400);
  const { round_id, vendors_to_compare, pass_kinds, cost_cap_usd, dry_run, max_groups } = v.req;

  // Load round + project + composition_groups.
  let ctx: Awaited<ReturnType<typeof loadRoundContext>>;
  try {
    ctx = await loadRoundContext(round_id);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 404);
  }

  const total_compositions = max_groups
    ? Math.min(ctx.compositions.length, max_groups)
    : ctx.compositions.length;
  if (total_compositions === 0) {
    return errorResponse('round has no composition_groups', 400);
  }

  // Cost pre-flight.
  const preflight: Array<{ label: string; estimated_usd: number }> = [];
  let total_estimated = 0;
  for (const cfg of vendors_to_compare) {
    const usd = preflightCost(cfg.vendor, cfg.model, total_compositions);
    preflight.push({ label: cfg.label, estimated_usd: Number(usd.toFixed(4)) });
    total_estimated += usd;
  }
  total_estimated = Number(total_estimated.toFixed(4));

  if (total_estimated > cost_cap_usd) {
    const detail = JSON.stringify({
      total_estimated_usd: total_estimated,
      cost_cap_usd,
      preflight,
    });
    return errorResponse(
      `pre-flight cost $${total_estimated.toFixed(4)} exceeds cap $${cost_cap_usd.toFixed(4)} | detail: ${detail}`,
      400,
    );
  }

  if (dry_run) {
    return jsonResponse({
      ok: true,
      mode: 'dry_run',
      round_id,
      total_compositions,
      preflight,
      total_estimated_usd: total_estimated,
      cost_cap_usd,
    });
  }

  // Build the prompt once. It's identical across vendors — only the call
  // changes. Pass 1 prompt has all the room/composition/vantage/clutter
  // taxonomy + scoring anchors per spec Section 5 step 3.
  const anchors = await getActiveStreamBAnchors();
  const prompt = buildPass1Prompt(anchors);
  const compositionsToRun = ctx.compositions.slice(0, total_compositions);

  // Kick off the heavy work in the background. The request returns
  // immediately with a "started" ack so the gateway doesn't time out.
  // Progress is observable via vendor_shadow_runs row count for round_id.
  const bgWork = processComparison({
    round_id,
    ctx,
    compositionsToRun,
    vendors_to_compare,
    pass_kinds,
    prompt: { system: prompt.system, userPrefix: prompt.userPrefix },
  }).catch((err) => {
    console.error(`[${GENERATOR}] background sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse({
    ok: true,
    mode: 'background',
    round_id,
    total_compositions,
    vendors: vendors_to_compare.map((cfg) => ({ label: cfg.label, vendor: cfg.vendor, model: cfg.model })),
    preflight,
    total_estimated_usd: total_estimated,
    cost_cap_usd,
    progress_query: `SELECT vendor, label, count(*) FROM vendor_shadow_runs WHERE round_id = '${round_id}' GROUP BY vendor, label`,
    note: `Sweep running in background. Expect ~${Math.ceil(total_compositions / BATCH_SIZE) * 30}s wall time at ${BATCH_SIZE}-composition batches × parallel vendors. Report will appear at Photos/_AUDIT/vendor_comparison_${round_id}.md`,
  });
}

serveWithAudit(GENERATOR, handler);

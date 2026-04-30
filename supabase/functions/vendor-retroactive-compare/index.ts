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
    max_output_tokens: 1500,
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
    // errorResponse only takes (message, status, req?: Request). Embed the
    // pre-flight detail in the message so the operator sees it in the body.
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

  // Per-vendor sweep. We iterate compositions outermost so a vendor partial
  // failure leaves prior compositions persisted (resumable).
  const compositionsToRun = ctx.compositions.slice(0, total_compositions);
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

  for (const comp of compositionsToRun) {
    if (!ctx.project.dropbox_root_path) continue; // Skip when project has no Dropbox root.
    const previewPath = `${ctx.project.dropbox_root_path.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews/${comp.stem}.jpg`;
    let preview: { data: string; media_type: string } | null = null;
    let previewErr: string | null = null;
    try {
      preview = await fetchPreviewBase64(previewPath);
    } catch (err) {
      previewErr = err instanceof Error ? err.message : String(err);
    }

    for (const cfg of vendors_to_compare) {
      const summary = runs.get(cfg.label)!;
      const startSpan = Date.now();
      let resp: VisionResponse | null = null;
      let err: string | undefined;
      let request_payload: VisionRequest | null = null;

      if (preview) {
        request_payload = {
          vendor: cfg.vendor,
          model: cfg.model,
          tool_name: COMPARISON_TOOL_NAME,
          tool_input_schema: COMPARISON_TOOL_SCHEMA,
          system: prompt.system,
          user_text: prompt.userPrefix,
          images: [{ source_type: 'base64', media_type: preview.media_type, data: preview.data }],
          max_output_tokens: 1500,
          temperature: 0,
        };
        const r = await runVendorOnComposition(cfg, comp, preview, prompt.system, prompt.userPrefix);
        resp = r.resp;
        err = r.error;
      } else {
        err = previewErr || 'preview unavailable';
        // Persist a failure row so the operator sees which images couldn't be fetched.
        request_payload = {
          vendor: cfg.vendor,
          model: cfg.model,
          tool_name: COMPARISON_TOOL_NAME,
          tool_input_schema: COMPARISON_TOOL_SCHEMA,
          system: prompt.system,
          user_text: prompt.userPrefix,
          images: [],
          max_output_tokens: 1500,
          temperature: 0,
        };
      }

      const passKind: 'unified' | 'description_backfill' = pass_kinds.includes('unified')
        ? 'unified'
        : pass_kinds[0];
      try {
        await persistShadowRun(round_id, cfg, comp, resp, err, passKind, request_payload);
      } catch (persistErr) {
        console.warn(`[${GENERATOR}] persist shadow run failed: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
      }

      summary.composition_count += 1;
      if (resp) {
        summary.total_cost_usd += resp.usage.estimated_cost_usd;
        summary.total_elapsed_ms += resp.vendor_meta.elapsed_ms;
        summary.results.push({
          group_id: comp.group_id,
          stem: comp.stem,
          output: resp.output,
        });
      } else {
        summary.failure_count += 1;
        summary.total_elapsed_ms += Date.now() - startSpan;
      }
    }
  }

  // Comparison metrics — pairwise (every vendor against the first).
  const labels = vendors_to_compare.map((v) => v.label);
  if (labels.length < 2) {
    return jsonResponse({
      ok: true,
      mode: 'single_vendor',
      round_id,
      summaries: Array.from(runs.values()),
      note: 'only one vendor specified — no pairwise comparison computed',
    });
  }

  const primary = runs.get(labels[0])!;
  const writeRows: Array<{ id: string }> = [];
  let dropbox_report_path: string | null = null;

  // Generate a single markdown report covering all comparisons (primary vs each shadow).
  const allComparisons = labels.slice(1).map((shadowLabel) => {
    const shadow = runs.get(shadowLabel)!;
    const agreement = computeAgreementMatrix(primary.results, shadow.results);
    const score = computeScoreDelta(primary.results, shadow.results);
    const obj = computeObjectOverlap(primary.results, shadow.results);
    const room = computeRoomTypeAgreement(primary.results, shadow.results);
    return { primary, shadow, agreement, score, obj, room };
  });

  const markdown = generateMarkdownReport(round_id, allComparisons);
  dropbox_report_path = await uploadComparisonReport(ctx.project.dropbox_root_path, round_id, markdown);

  for (const c of allComparisons) {
    const admin = getAdminClient();
    const summary_truncated = markdown.slice(0, 2000);
    const { data, error: insErr } = await admin.from('vendor_comparison_results').insert({
      round_id,
      primary_vendor: c.primary.vendor,
      primary_model: c.primary.model,
      primary_label: c.primary.label,
      shadow_vendor: c.shadow.vendor,
      shadow_model: c.shadow.model,
      shadow_label: c.shadow.label,
      slot_decision_agreement_rate: null, // v1 unified-only; no slot decisions
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
    } else if (data) {
      writeRows.push({ id: (data as { id: string }).id });
    }
  }

  return jsonResponse({
    ok: true,
    round_id,
    mode: 'live',
    total_compositions,
    summaries: Array.from(runs.values()).map((s) => ({
      label: s.label,
      vendor: s.vendor,
      model: s.model,
      composition_count: s.composition_count,
      failure_count: s.failure_count,
      total_cost_usd: Number(s.total_cost_usd.toFixed(6)),
      total_elapsed_ms: s.total_elapsed_ms,
    })),
    comparison_results_inserted: writeRows.length,
    dropbox_report_path,
  });
}

serveWithAudit(GENERATOR, handler);

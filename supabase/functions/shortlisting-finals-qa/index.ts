/**
 * shortlisting-finals-qa
 * ──────────────────────
 * Wave 15a — Internal Finals Scoring (smoke wave).
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §8 +
 *       docs/WAVE_PLAN.md Wave 15.
 *
 * The first downstream consumer of the W11.7.17 universal vision schema v2.
 * Feeds FlexMedia's already-delivered final JPEGs through Stage 1 with
 * `source_type='internal_finals'` and surfaces a Finals QA dashboard that
 * flags blowout / sky-replacement halos / digital-furniture artefacts /
 * vertical line convergence the editor missed.
 *
 * ─── INPUT MODES ──────────────────────────────────────────────────────────
 *
 *   { project_id, finals_paths: ['/path/to/IMG_1.jpg', ...] }
 *     — process the explicit list (smoke / spot-check)
 *
 *   { project_id, all_finals: true }
 *     — list Photos/Finals/ recursively, process every JPEG
 *     (master_admin only)
 *
 * ─── ARCHITECTURE ─────────────────────────────────────────────────────────
 *
 *  - Mirrors `shortlisting-shape-d`'s per-image Stage 1 pattern: 1 Gemini
 *    2.5 Pro call per image, parallel batches of N for concurrency control.
 *  - Persists per-image results to `composition_classifications` with
 *    `source_type='internal_finals'`, `schema_version='v2.0'`, and the
 *    `finals_specific` JSONB block populated by the model.
 *  - There's no `composition_groups` row for finals (no bracket merging
 *    upstream of delivered JPEGs). We mint a synthetic `group_id =
 *    crypto.randomUUID()` per finals image so the unique-on-group_id
 *    constraint on composition_classifications stays satisfied.
 *  - Round_id stays NULL on the persisted row (round_id is a RAW-pipeline
 *    concept; finals QA is invocation-grained, tracked via
 *    `finals_qa_runs.id` in a separate column we DO NOT add to
 *    composition_classifications — finals are filtered by source_type).
 *  - Reuses the already-deployed v2 prompt assembly: `signalMeasurementBlock(
 *    'internal_finals')` + `sourceContextBlock('internal_finals')` are the
 *    two W11.7.17 dimorphism levers. Stage 1's existing prompt logic does
 *    the rest — we DO NOT modify Stage 1 / Stage 4 / shortlisting-shape-d.
 *
 * ─── EDGE-RUNTIME WALL-TIME ──────────────────────────────────────────────
 *
 * Same pattern as Stage 1: synchronous validate + insert finals_qa_runs row,
 * kick the per-image work into `EdgeRuntime.waitUntil`, return HTTP 200
 * immediately with the `finals_qa_runs.id`. The background worker
 * self-updates the row's status / counts on completion.
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
} from '../_shared/visionAdapter/index.ts';
import {
  getDropboxAccessToken,
  listFolder,
  type DropboxFileMetadata,
} from '../_shared/dropbox.ts';
import {
  sourceContextBlock,
  SOURCE_CONTEXT_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/sourceContextBlock.ts';
import {
  signalMeasurementBlock,
  SIGNAL_MEASUREMENT_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/signalMeasurementBlock.ts';
import {
  UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION,
  UNIVERSAL_VISION_RESPONSE_TOOL_NAME,
  universalSchemaForSource,
} from '../_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts';
import { buildPass1Prompt } from '../_shared/pass1Prompt.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import { normaliseSignalScores } from '../_shared/visionPrompts/blocks/normaliseSignalScores.ts';
import { computeAggregateScores } from '../_shared/dimensionRollup.ts';

const GENERATOR = 'shortlisting-finals-qa';

// ─── Constants ──────────────────────────────────────────────────────────────

const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-pro';
const FINALS_DEFAULT_THINKING_BUDGET = 2048;
const FINALS_DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const FINALS_DEFAULT_TIMEOUT_MS = 90_000;
const FINALS_PER_IMAGE_CONCURRENCY = 5;
const DEFAULT_COST_CAP_USD = 25; // higher than Stage 1 (delivery folders can be big)

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  project_id?: string;
  finals_paths?: string[];
  all_finals?: boolean;
  _health_check?: boolean;
}

interface FinalsQaCtx {
  project_id: string;
  dropbox_root_path: string;
  finals_folder_path: string;
  property_address: string | null;
  finals_paths: string[];
  run_kind: 'sample' | 'all';
  triggered_by: string | null;
}

interface FinalsResult {
  group_id: string;
  finals_path: string;
  filename: string;
  output: Record<string, unknown> | null;
  error: string | null;
  cost_usd: number;
  wall_ms: number;
  input_tokens: number;
  output_tokens: number;
  // W11.8.1: vendor narrowed to 'google' (Anthropic vision adapter stripped).
  // failover_triggered/Reason kept on the shape so persistence + audit row
  // population stays unchanged. Both are always false/null now.
  vendor_used: 'google';
  model_used: string;
  failover_triggered: false;
  failover_reason: null;
}

// ─── Handler ────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth: master_admin only (or service-role bypass).
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
    return jsonResponse({ _version: 'v1.0-finals-qa', _fn: GENERATOR }, 200, req);
  }

  if (!body.project_id) {
    return errorResponse('project_id is required', 400, req);
  }
  const hasPaths = Array.isArray(body.finals_paths) && body.finals_paths.length > 0;
  const hasAllFlag = body.all_finals === true;
  if (!hasPaths && !hasAllFlag) {
    return errorResponse(
      'must supply either finals_paths[] or all_finals=true',
      400,
      req,
    );
  }

  // Synchronous pre-flight: resolve project + finals folder + path list.
  let preflight: FinalsQaCtx;
  try {
    preflight = await preflightFinalsQa({
      projectId: body.project_id,
      finalsPaths: body.finals_paths ?? null,
      allFinals: hasAllFlag,
      triggeredBy: isService ? null : (user?.id ?? null),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] preflight failed: ${msg}`);
    return errorResponse(`finals-qa preflight failed: ${msg}`, 400, req);
  }

  // Pre-flight cost cap — same envelope as Stage 1 ($0.014/image at
  // gemini-2.5-pro with thinkingBudget=2048 + max_output=6000).
  const estimatedCost = estimateFinalsCost(preflight.finals_paths.length);
  if (estimatedCost > DEFAULT_COST_CAP_USD) {
    return errorResponse(
      `finals-qa pre-flight cost $${estimatedCost.toFixed(2)} exceeds cap ` +
      `$${DEFAULT_COST_CAP_USD.toFixed(2)} (${preflight.finals_paths.length} images). ` +
      `Reduce the input list or contact infra to lift the cap.`,
      400,
      req,
    );
  }

  // Insert finals_qa_runs row synchronously so the dashboard can poll for
  // status as soon as the HTTP 200 ack lands.
  const admin = getAdminClient();
  const { data: insertedRun, error: insErr } = await admin
    .from('finals_qa_runs')
    .insert({
      project_id: preflight.project_id,
      run_kind: preflight.run_kind,
      status: 'running',
      finals_count: preflight.finals_paths.length,
      finals_paths: preflight.finals_paths,
      triggered_by: preflight.triggered_by,
    })
    .select('id, started_at')
    .single();
  if (insErr || !insertedRun) {
    console.error(`[${GENERATOR}] finals_qa_runs insert failed: ${insErr?.message}`);
    return errorResponse(
      `finals_qa_runs insert failed: ${insErr?.message ?? 'unknown'}`,
      500,
      req,
    );
  }
  const runId = insertedRun.id as string;

  // Background dispatch — same EdgeRuntime.waitUntil pattern as
  // shortlisting-shape-d.
  const bgWork = runFinalsQaBackground({ runId, ctx: preflight })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] background run ${runId} failed: ${msg}`);
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: 'background',
      run_id: runId,
      project_id: preflight.project_id,
      finals_count: preflight.finals_paths.length,
      run_kind: preflight.run_kind,
      started_at: insertedRun.started_at,
      estimated_cost_usd: Math.round(estimatedCost * 1_000_000) / 1_000_000,
    },
    200,
    req,
  );
});

// ─── Pre-flight ──────────────────────────────────────────────────────────────

interface PreflightArgs {
  projectId: string;
  finalsPaths: string[] | null;
  allFinals: boolean;
  triggeredBy: string | null;
}

async function preflightFinalsQa(args: PreflightArgs): Promise<FinalsQaCtx> {
  const admin = getAdminClient();

  // Resolve project + dropbox_root_path.
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('id, dropbox_root_path, property_address, status')
    .eq('id', args.projectId)
    .maybeSingle();
  if (projErr) throw new Error(`project lookup failed: ${projErr.message}`);
  if (!project) throw new Error(`project ${args.projectId} not found`);
  const dropboxRoot = (project.dropbox_root_path as string | null) ?? null;
  if (!dropboxRoot) {
    throw new Error(`project ${args.projectId} has no dropbox_root_path`);
  }
  const finalsFolderPath = `${dropboxRoot.replace(/\/+$/, '')}/Photos/Finals`;

  let resolvedPaths: string[];
  let runKind: 'sample' | 'all';

  if (args.allFinals) {
    runKind = 'all';
    // List the finals folder recursively and filter to JPEGs.
    const listing = await listFolder(finalsFolderPath, {
      recursive: true,
      maxEntries: 5000,
    }).catch((err) => {
      throw new Error(`Photos/Finals listing failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    resolvedPaths = listing.entries
      .filter((entry: DropboxFileMetadata) => isFinalJpeg(entry))
      .map((entry: DropboxFileMetadata) => entry.path_display ?? entry.path_lower ?? '')
      .filter((p): p is string => p.length > 0);
    if (resolvedPaths.length === 0) {
      throw new Error(
        `Photos/Finals at ${finalsFolderPath} contained no JPEGs to process`,
      );
    }
  } else {
    runKind = 'sample';
    if (!args.finalsPaths || args.finalsPaths.length === 0) {
      throw new Error('finals_paths must be a non-empty array when all_finals=false');
    }
    // Path validation: every path must live under the project's Dropbox root.
    // The CANONICAL location is Photos/Finals/, but we accept any path under
    // dropboxRoot to support smoke / spot-check against still-in-progress
    // deliveries where finals haven't been moved into Photos/Finals yet
    // (W15a smoke wave reality: no project has populated Photos/Finals at
    // launch, so we accept paths from Photos/Raws/Shortlist Proposed/Previews
    // as a pragmatic proxy for "real delivered JPEGs from this property").
    // The model still scores them under source_type='internal_finals' rules
    // because the source_type is caller-controlled, not derived from the path.
    for (const p of args.finalsPaths) {
      if (!p.startsWith(dropboxRoot.replace(/\/+$/, ''))) {
        throw new Error(
          `finals_path ${p} is not under the project's Dropbox root ${dropboxRoot}`,
        );
      }
    }
    resolvedPaths = [...args.finalsPaths];
  }

  return {
    project_id: project.id as string,
    dropbox_root_path: dropboxRoot,
    finals_folder_path: finalsFolderPath,
    property_address: (project.property_address as string | null) ?? null,
    finals_paths: resolvedPaths,
    run_kind: runKind,
    triggered_by: args.triggeredBy,
  };
}

function isFinalJpeg(entry: DropboxFileMetadata): boolean {
  // Dropbox listFolder returns folders + files; we need files with a JPEG
  // extension and skip Dropbox's internal markers.
  const name = (entry.name ?? '').toLowerCase();
  if (!name.endsWith('.jpg') && !name.endsWith('.jpeg')) return false;
  if (name.startsWith('.')) return false;
  return true;
}

function estimateFinalsCost(imageCount: number): number {
  // ~$0.014/image — slightly higher than Stage 1's $0.012 because finals
  // emissions tend to be more verbose (signal_scores + finals_specific block).
  const inputTokensPerImage = 6_500;
  const outputTokensPerImage = 4_000;
  const perImage = estimateCost('google', PRIMARY_MODEL, {
    input_tokens: inputTokensPerImage,
    output_tokens: outputTokensPerImage,
    cached_input_tokens: 0,
  });
  return perImage * imageCount;
}

// ─── Background runner ──────────────────────────────────────────────────────

interface BackgroundArgs {
  runId: string;
  ctx: FinalsQaCtx;
}

async function runFinalsQaBackground(args: BackgroundArgs): Promise<void> {
  const admin = getAdminClient();
  const { runId, ctx } = args;
  const warnings: string[] = [];

  try {
    // Build the prompt ONCE, mirroring shortlisting-shape-d's assembly. The
    // critical W11.7.17 levers are sourceContextBlock('internal_finals') +
    // signalMeasurementBlock('internal_finals'). Pass1's room taxonomy is
    // still useful (finals are still real estate), so we keep the system
    // prompt scaffolding from buildPass1Prompt — we just don't pull in the
    // few-shot library / project memory blocks (those are RAW-only context
    // signals tied to a round_id we don't have).
    const anchors = await getActiveStreamBAnchors();
    const basePrompt = buildPass1Prompt(anchors);

    const systemText = [
      basePrompt.system,
      '',
      '── SIGNAL MEASUREMENT INSTRUCTIONS (W11.7.17 v2 — internal_finals) ──',
      signalMeasurementBlock('internal_finals'),
    ].join('\n');

    const userPrefix = [
      sourceContextBlock('internal_finals'),
      '',
      basePrompt.userPrefix,
    ].join('\n');

    // Run per-image calls in parallel batches.
    const allResults: FinalsResult[] = [];
    const paths = ctx.finals_paths;

    for (let i = 0; i < paths.length; i += FINALS_PER_IMAGE_CONCURRENCY) {
      const batch = paths.slice(i, i + FINALS_PER_IMAGE_CONCURRENCY);
      const batchResults = await Promise.all(batch.map((path) =>
        runFinalsPerImage({ path, systemText, userText: userPrefix })
          .catch((err): FinalsResult => {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              group_id: crypto.randomUUID(),
              finals_path: path,
              filename: pathBasename(path),
              output: null,
              error: `wholesale_failed: ${msg}`,
              cost_usd: 0,
              wall_ms: 0,
              input_tokens: 0,
              output_tokens: 0,
              vendor_used: PRIMARY_VENDOR,
              model_used: PRIMARY_MODEL,
              failover_triggered: false,
              failover_reason: null,
            };
          })
      ));

      // Persist successes immediately (no batch barrier).
      for (const r of batchResults) {
        if (r.output) {
          await persistFinalsClassification({
            admin,
            projectId: ctx.project_id,
            result: r,
            warnings,
            // QC iter 3 P0 F-3C-002: pass the assembled prompt's blockVersions
            // through so the persisted prompt_block_versions JSONB carries
            // every block actually loaded (not just the 3 hardcoded v2 keys).
            promptBlockVersions: basePrompt.blockVersions,
          });
        } else if (r.error) {
          // Surface per-image failure messages into warnings so the operator
          // dashboard can see why a final didn't land. Without this, failed
          // runs return ("status":"failed", "failures":N) with no diagnostic.
          warnings.push(`[${r.filename}] ${r.error}`);
          console.error(`[${GENERATOR}] image ${r.filename} failed: ${r.error}`);
        }
      }
      allResults.push(...batchResults);
      console.log(
        `[${GENERATOR}] run=${runId} batch ${Math.floor(i / FINALS_PER_IMAGE_CONCURRENCY) + 1}/` +
        `${Math.ceil(paths.length / FINALS_PER_IMAGE_CONCURRENCY)} — ` +
        `${batchResults.filter((r) => r.output).length}/${batch.length} succeeded`,
      );
    }

    const successes = allResults.filter((r) => r.output).length;
    const failures = allResults.filter((r) => !r.output).length;
    const totalCostUsd = allResults.reduce((sum, r) => sum + r.cost_usd, 0);
    const status = failures === 0 ? 'succeeded' : (successes === 0 ? 'failed' : 'partial');

    const { error: updErr } = await admin
      .from('finals_qa_runs')
      .update({
        status,
        finished_at: new Date().toISOString(),
        successes,
        failures,
        total_cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
        warnings: warnings.length > 0 ? warnings : null,
      })
      .eq('id', runId);
    if (updErr) {
      console.warn(`[${GENERATOR}] run ${runId} self-update failed: ${updErr.message}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] run ${runId} fatal: ${msg}`);
    await admin
      .from('finals_qa_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: msg.slice(0, 1000),
      })
      .eq('id', runId);
  }
}

// ─── Per-image runner ────────────────────────────────────────────────────────

interface RunFinalsPerImageOpts {
  path: string;
  systemText: string;
  userText: string;
}

async function runFinalsPerImage(opts: RunFinalsPerImageOpts): Promise<FinalsResult> {
  const start = Date.now();
  const groupId = crypto.randomUUID();
  const filename = pathBasename(opts.path);

  // Fetch the JPEG from Dropbox.
  let preview: { data: string; media_type: string };
  try {
    preview = await fetchFinalBase64(opts.path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      group_id: groupId,
      finals_path: opts.path,
      filename,
      output: null,
      error: `dropbox_download_failed: ${msg}`,
      cost_usd: 0,
      wall_ms: Date.now() - start,
      input_tokens: 0,
      output_tokens: 0,
      vendor_used: PRIMARY_VENDOR,
      model_used: PRIMARY_MODEL,
      failover_triggered: false,
      failover_reason: null,
    };
  }

  // W11.7.17 hotfix-4: finals-qa always classifies finished delivery images,
  // so source_type is fixed at 'internal_finals'. Pick the matching per-source
  // schema variant (only finals_specific block is declared) to stay under
  // Gemini's responseSchema FSM state-count limit.
  const baseReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model: PRIMARY_MODEL,
    tool_name: UNIVERSAL_VISION_RESPONSE_TOOL_NAME,
    tool_input_schema: universalSchemaForSource('internal_finals'),
    system: opts.systemText,
    user_text: opts.userText,
    images: [{
      source_type: 'base64',
      media_type: preview.media_type,
      data: preview.data,
    }],
    max_output_tokens: FINALS_DEFAULT_MAX_OUTPUT_TOKENS,
    temperature: 0,
    thinking_budget: FINALS_DEFAULT_THINKING_BUDGET,
    timeout_ms: FINALS_DEFAULT_TIMEOUT_MS,
  };

  // W11.8.1: Anthropic failover stripped. Gemini errors propagate as-is —
  // the per-image error captured here flows into engine_run_audit /
  // finals_qa_classifications rows, and an all-failure round flips to
  // status='failed'. Previously the v2 universal schema's array-form types
  // (type: ['string','null']) routed 100% of Stage 1 traffic through the
  // Anthropic failover (~12× cost spike). Hotfix-3/4 made Gemini accept the
  // schema natively, so the failover became dead code. W11.8.1 deletes it.
  let resp: VisionResponse | null = null;
  let err: string | undefined;

  try {
    resp = await callVisionAdapter(baseReq);
  } catch (e) {
    if (e instanceof MissingVendorCredential) err = e.message;
    else if (e instanceof VendorCallError) err = `${e.vendor}/${e.model} ${e.status ?? ''}: ${e.message}`;
    else err = e instanceof Error ? e.message : String(e);
  }

  if (!resp) {
    return {
      group_id: groupId,
      finals_path: opts.path,
      filename,
      output: null,
      error: err ?? 'no_response',
      cost_usd: 0,
      wall_ms: Date.now() - start,
      input_tokens: 0,
      output_tokens: 0,
      vendor_used: PRIMARY_VENDOR,
      model_used: PRIMARY_MODEL,
      failover_triggered: false,
      failover_reason: null,
    };
  }

  const inT = typeof resp.usage.input_tokens === 'number' ? resp.usage.input_tokens : 0;
  const outT = typeof resp.usage.output_tokens === 'number' ? resp.usage.output_tokens : 0;
  return {
    group_id: groupId,
    finals_path: opts.path,
    filename,
    output: resp.output as Record<string, unknown>,
    error: null,
    cost_usd: resp.usage.estimated_cost_usd,
    wall_ms: resp.vendor_meta.elapsed_ms,
    input_tokens: inT,
    output_tokens: outT,
    vendor_used: PRIMARY_VENDOR,
    model_used: PRIMARY_MODEL,
    failover_triggered: false,
    failover_reason: null,
  };
}

// ─── Persistence ─────────────────────────────────────────────────────────────

interface PersistArgs {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  result: FinalsResult;
  warnings: string[];
  /**
   * QC iter 3 P0 F-3C-002 (2026-05-02): full prompt-block version map from
   * the assembled basePrompt — merged into the row's prompt_block_versions
   * JSONB so audit/replay captures every block actually loaded for the
   * inference call. Pre-fix the row stamped only 3 keys
   * (universal_vision_response_schema + signal_measurement + source_context),
   * dropping ~10 dynamically-versioned blocks (header, stepOrdering,
   * roomTypeTaxonomy, etc.).
   */
  promptBlockVersions?: Record<string, string>;
}

/**
 * Persist a single finals classification to composition_classifications. The
 * row mirrors persistOneClassification() in shortlisting-shape-d but with
 * source_type='internal_finals' and a synthetic group_id (no upstream
 * composition_groups row). round_id is null — finals QA is invocation-grained,
 * tracked separately via finals_qa_runs.id.
 *
 * Defensive coercion mirrors shape-d's persist helpers: strings → null when
 * empty, numbers via Number(), booleans via lowercase compare. Anything that
 * fails coercion falls back to null so a bad emission still lands cleanly
 * (the dashboard surfaces "missing finals_specific block" as a real signal).
 */
export async function persistFinalsClassification(args: PersistArgs): Promise<void> {
  const out = args.result.output;
  if (!out) return;

  const num = (v: unknown): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  };
  const bool = (v: unknown): boolean => {
    if (v === true) return true;
    if (v === false || v == null) return false;
    if (typeof v === 'string') {
      const t = v.toLowerCase();
      return t === 'true' || t === 'yes' || t === '1';
    }
    return false;
  };
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === 'string') return v.length === 0 ? null : v;
    return String(v);
  };
  const int = (v: unknown): number | null => {
    const n = num(v);
    return n == null ? null : Math.trunc(n);
  };
  const boolNullable = (v: unknown): boolean | null => {
    if (v === true) return true;
    if (v === false) return false;
    if (v == null) return null;
    if (typeof v === 'string') {
      const t = v.toLowerCase();
      if (t === 'true' || t === 'yes' || t === '1') return true;
      if (t === 'false' || t === 'no' || t === '0') return false;
    }
    return null;
  };

  // v2 nested quality_flags read (matches shape-d).
  const qualityFlagsRaw = (out.quality_flags && typeof out.quality_flags === 'object')
    ? out.quality_flags as Record<string, unknown>
    : {};
  const flagForRetouchingRaw = qualityFlagsRaw.flag_for_retouching ?? out.flag_for_retouching;
  const clutterSeverityRaw = qualityFlagsRaw.clutter_severity ?? out.clutter_severity;
  const clutterDetailRaw = qualityFlagsRaw.clutter_detail ?? out.clutter_detail;

  const clutterRawStr = str(clutterSeverityRaw);
  const clutter = clutterRawStr && ['none', 'minor_photoshoppable', 'moderate_retouch', 'major_reject']
    .includes(clutterRawStr)
    ? clutterRawStr
    : null;
  // Finals: flag_for_retouching is the spec's interpretation lever — when the
  // model flags retouch, the editor's delivery is being called out as
  // having a remaining flaw the human review pass should resolve.
  const flagForRetouching = flagForRetouchingRaw == null
    ? (clutter === 'minor_photoshoppable' || clutter === 'moderate_retouch')
    : bool(flagForRetouchingRaw);

  // ─── W11.7.17 hotfix-5 (2026-05-02): room_type v2-nested read ──────────────
  // Mirrors the shape-d fix. Finals QA emits v2-shaped rows with
  // out.room_classification.{room_type, composition_type, vantage_point,
  // is_styled, indoor_outdoor_visible} — pre-fix this function read top-level
  // v1 keys and landed NULL on the 5 finals rows in the W11.7.17 cutover
  // window.
  const roomClassRaw = (out.room_classification && typeof out.room_classification === 'object')
    ? out.room_classification as Record<string, unknown>
    : null;
  const roomType = str(roomClassRaw?.room_type ?? out.room_type);
  const vantage = str(roomClassRaw?.vantage_point ?? out.vantage_point);
  const eligibleExtRear = roomType === 'alfresco' && vantage === 'exterior_looking_in';
  const vantageColumn = vantage && ['interior_looking_out', 'exterior_looking_in', 'neutral']
    .includes(vantage)
    ? vantage
    : null;

  // ─── QC iter 3 P0 F-3C-001 (2026-05-02): image_classification v2-nested read ──
  // Mirrors the shape-d F-D-002 fix (W2 mig 418, hotfix-5) which never landed
  // here. v2 universal schema places `time_of_day_*`, exterior/detail subject
  // and is_drone under `out.image_classification.{is_dusk, is_day,
  // is_golden_hour, is_night, subject, is_drone}`. Pre-fix the finals-qa
  // persist read top-level v1 keys (`out.time_of_day`, `out.is_exterior`,
  // `out.is_detail_shot`, `out.is_drone`) which v2 NEVER emits — so 5 prod
  // v2 finals rows landed NULL on these columns.
  //
  // Now: derive `time_of_day` enum from the 4 nested booleans (priority:
  // night > dusk > golden_hour > day, mirroring the visual progression).
  // Derive `is_exterior` from `image_classification.subject === 'exterior'`,
  // `is_detail_shot` from `subject === 'detail'` OR `image_type === 'is_detail_shot'`
  // (the 11-option enum that flags detail shots even when subject is
  // technically interior/exterior). Derive `is_drone` from
  // `image_classification.is_drone` OR `image_type === 'is_drone'`.
  // Backwards-compat fallback: when `image_classification` is null/undefined
  // (defensive — shouldn't happen post-cutover), fall through to legacy
  // top-level reads so any straggling v1.x traffic still lands cleanly.
  const imgClass = (out.image_classification && typeof out.image_classification === 'object')
    ? out.image_classification as Record<string, unknown>
    : null;
  const imageTypeRaw = str(out.image_type);
  const timeOfDay: string | null = imgClass
    ? (bool(imgClass.is_night) ? 'night'
      : bool(imgClass.is_dusk) ? 'dusk_twilight'
      : bool(imgClass.is_golden_hour) ? 'golden_hour'
      : bool(imgClass.is_day) ? 'day'
      : null)
    : str(out.time_of_day);
  const subjectRaw = imgClass ? str(imgClass.subject) : null;
  const isExterior = imgClass
    ? (subjectRaw === 'exterior')
    : bool(out.is_exterior);
  const isDetailShot = imgClass
    ? (subjectRaw === 'detail' || imageTypeRaw === 'is_detail_shot')
    : bool(out.is_detail_shot);
  const isDrone = imgClass
    ? (bool(imgClass.is_drone) || imageTypeRaw === 'is_drone')
    : bool(out.is_drone);

  // signal_scores normalisation
  const sigNormResult = normaliseSignalScores(out.signal_scores, {
    groupId: args.result.group_id,
    stem: args.result.filename,
  });
  const signalScores = sigNormResult.signalScores;
  if (sigNormResult.warning) args.warnings.push(sigNormResult.warning);

  // Aggregates from rollup (uniform mean of present signals on finals — no
  // tier_config involved).
  const aggregates = computeAggregateScores(signalScores ?? {}, null, null);
  const techScore = aggregates.technical ?? num(out.technical_score);
  const lightScore = aggregates.lighting ?? num(out.lighting_score);
  const compScore = aggregates.composition ?? num(out.composition_score);
  const aesScore = aggregates.aesthetic ?? num(out.aesthetic_score);
  const combined = aggregates.combined ?? null;

  const row: Record<string, unknown> = {
    group_id: args.result.group_id,
    round_id: null,
    project_id: args.projectId,
    analysis: str(out.analysis),
    // W11.7.17 hotfix-5: room_type / room_type_confidence / composition_type /
    // is_styled / indoor_outdoor_visible all live under
    // out.room_classification.* in v2. Read nested first, fall back to
    // top-level for backwards compat.
    room_type: roomType,
    room_type_confidence: num(roomClassRaw?.room_type_confidence ?? out.room_type_confidence),
    space_type: str(out.space_type),
    zone_focus: str(out.zone_focus),
    space_zone_count: typeof out.space_zone_count === 'number'
      ? Math.trunc(out.space_zone_count)
      : null,
    composition_type: str(roomClassRaw?.composition_type ?? out.composition_type),
    vantage_point: vantageColumn,
    time_of_day: timeOfDay,
    is_drone: isDrone,
    is_exterior: isExterior,
    is_detail_shot: isDetailShot,
    zones_visible: arr(out.zones_visible),
    key_elements: arr(out.key_elements),
    is_styled: bool(roomClassRaw?.is_styled ?? out.is_styled),
    indoor_outdoor_visible: bool(roomClassRaw?.indoor_outdoor_visible ?? out.indoor_outdoor_visible),
    clutter_severity: clutter,
    clutter_detail: str(clutterDetailRaw),
    flag_for_retouching: flagForRetouching,
    technical_score: techScore,
    lighting_score: lightScore,
    composition_score: compScore,
    aesthetic_score: aesScore,
    combined_score: combined,
    signal_scores: signalScores,
    eligible_for_exterior_rear: eligibleExtRear,
    is_near_duplicate_candidate: false,
    model_version: args.result.model_used,
    prompt_block_versions: {
      // QC iter 3 P0 F-3C-002: merge the full block-version map from the
      // assembled basePrompt FIRST, then layer the v2 schema/signal/source
      // versions on top so the v2 keys win on collision. Pre-fix only 3 keys
      // landed — now ~13 keys land per row, mirroring shape-d's coverage.
      ...(args.promptBlockVersions ?? {}),
      universal_vision_response_schema: UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION,
      signal_measurement: SIGNAL_MEASUREMENT_BLOCK_VERSION,
      source_context: SOURCE_CONTEXT_BLOCK_VERSION,
    },
    style_archetype: str(out.style_archetype),
    era_hint: str(out.era_hint),
    material_palette_summary: arr(out.material_palette_summary),
    embedding_anchor_text: str(out.embedding_anchor_text),
    searchable_keywords: arr(out.searchable_keywords),
    shot_intent: str(out.shot_intent),
    appeal_signals: arr(out.appeal_signals),
    concern_signals: arr(out.concern_signals),
    buyer_persona_hints: arr(out.buyer_persona_hints),
    retouch_priority: str(out.retouch_priority),
    retouch_estimate_minutes: int(out.retouch_estimate_minutes),
    gallery_position_hint: str(out.gallery_position_hint),
    social_first_friendly: boolNullable(out.social_first_friendly),
    requires_human_review: boolNullable(out.requires_human_review),
    confidence_per_field: (out.confidence_per_field && typeof out.confidence_per_field === 'object')
      ? out.confidence_per_field as Record<string, unknown>
      : null,
    listing_copy_headline: (() => {
      const lc = (out.listing_copy && typeof out.listing_copy === 'object')
        ? out.listing_copy as Record<string, unknown>
        : {};
      return str(lc.headline) ?? str(out.listing_copy_headline);
    })(),
    listing_copy_paragraphs: (() => {
      const lc = (out.listing_copy && typeof out.listing_copy === 'object')
        ? out.listing_copy as Record<string, unknown>
        : {};
      return str(lc.paragraphs) ?? str(out.listing_copy_paragraphs);
    })(),
    // ─── W11.7.17 v2 universal schema columns ────────────────────────────
    schema_version: 'v2.0',
    source_type: 'internal_finals',
    image_type: str(out.image_type),
    observed_objects: extractObservedObjects(out.observed_objects),
    observed_attributes: extractObservedAttributes(out.observed_attributes),
    raw_specific: null,
    finals_specific: extractObjectOrNull(out.finals_specific),
    external_specific: null,
    floorplan_specific: null,
  };

  const { error: insErr } = await args.admin
    .from('composition_classifications')
    .upsert(row, { onConflict: 'group_id' });
  if (insErr) {
    args.warnings.push(`finals classification upsert failed for ${args.result.group_id}: ${insErr.message}`);
  }
}

function extractObjectOrNull(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function extractObservedObjects(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

function extractObservedAttributes(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v.filter((entry): entry is Record<string, unknown> =>
    entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  );
}

// ─── Dropbox helpers ─────────────────────────────────────────────────────────

async function fetchFinalBase64(
  dropboxPath: string,
): Promise<{ data: string; media_type: string }> {
  const token = await getDropboxAccessToken();
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
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  const data = btoa(bin);
  return { data, media_type: 'image/jpeg' };
}

function pathBasename(p: string): string {
  const ix = p.lastIndexOf('/');
  return ix === -1 ? p : p.slice(ix + 1);
}

/**
 * shortlisting-shape-d
 * ────────────────────
 * Wave 11.7.1 — production Shape D shortlisting orchestrator.
 *
 * Replaces (Phase A coexistence) `shortlisting-pass1` + `shortlisting-pass2`
 * for rounds where `engine_settings.engine_mode = 'shape_d'` (or per-round
 * override `shortlisting_rounds.engine_mode = 'shape_d_*'`).
 *
 * Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
 *
 * ─── ARCHITECTURE (post-W11.7.1 fix) ─────────────────────────────────────────
 *
 * PER-IMAGE Stage 1 + 1 cross-image Stage 4 = N+1 calls per shoot:
 *   - Stage 1: ONE Gemini 2.5 Pro call per image (1 call = 1 image, no stem
 *              echo needed). Emits the full per-image enrichment object
 *              directly: analysis, scores, classification, key_elements,
 *              listing_copy, appeal_signals, concern_signals,
 *              retouch_priority, etc. thinkingBudget=2048,
 *              max_output_tokens=6000. Calls are processed in parallel batches
 *              of N (concurrency control, NOT batched API calls) — matching
 *              the validated `vendor-retroactive-compare` harness pattern.
 *   - Stage 4: 1 visual master synthesis call (sees all images + Stage 1 JSON)
 *              dispatched as a SEPARATE edge job (production lesson from
 *              iter-5a wall-time issue: combined Stage 1 + Stage 4 chain hit
 *              the worker wall budget).
 *
 * Why per-image and not batched: Gemini's stem-echo isn't reliable. The prior
 * batched-mode `per_image[]` schema with stem keys failed 42/42 on the
 * Saladine smoke test ("stem missing from per_image response"). The harness's
 * 1-image-per-call pattern ran 42/42 perfect across iter-1 through iter-5b.
 * Per-image is also cheaper (smaller individual calls, no batched-output
 * token bloat) and has implicit identity (1 call = 1 image).
 *
 * THIS edge fn is the Stage 1 orchestrator. Stage 4 lives in its own edge fn
 * (`shortlisting-shape-d-stage4`), dispatched via `shortlisting_jobs` of kind
 * `stage4_synthesis` after Stage 1 completes.
 *
 * ─── RESPONSIBILITIES ─────────────────────────────────────────────────────────
 *
 *  1. Auth + RLS: master_admin/admin/manager + service-role (matches pass1).
 *  2. Engine-mode gate: 400 if engine_mode='two_pass' (caller must use pass1).
 *  3. Round bootstrap: load shortlisting_rounds + projects + composition_groups.
 *  4. Property tier resolution: round.property_tier (default 'standard').
 *  5. Source type: defaults to 'internal_raw' for the production RAW workflow.
 *  6. Stage 1 per-image execution: parallel batches of N single-image calls.
 *  7. Stage 4 dispatch: insert shortlisting_jobs row of kind 'stage4_synthesis'.
 *  8. Audit JSON to Dropbox at Photos/_AUDIT/round_<id>_stage1_<ts>.json.
 *  9. engine_run_audit upsert: stages_completed=['pass0','stage1'], cost, wall.
 * 10. Stamp shortlisting_rounds.engine_mode = 'shape_d_full' | 'shape_d_partial'.
 * 11. Mutex via dispatcher_locks (W7.5 pattern) per round.
 * 12. Idempotent retry: skip compositions that already have a classification row.
 * 13. Cost cap from engine_settings.cost_cap_per_round_usd (default $10).
 *
 * ─── INPUT MODES ──────────────────────────────────────────────────────────────
 *
 *   { round_id }   — direct invocation (master_admin manual or cron-style)
 *   { job_id }     — dispatcher path (look up round_id from shortlisting_jobs)
 *   { _health_check: true } → 200 with version stamp
 *
 * ─── EDGE-RUNTIME WALL-TIME ───────────────────────────────────────────────────
 *
 * Stage 1 only. Even with per-image calls processed in parallel batches of 8,
 * the orchestrator returns within ~70s ack and the background worker finishes
 * the round in ~3-4 min for 42 images. Stage 4 is dispatched as a follow-up
 * job so its 60-90s thinking + 240s timeout doesn't stack.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  callerHasProjectAccess,
} from '../_shared/supabase.ts';
import {
  callVisionAdapter,
  estimateCost,
  MissingVendorCredential,
  VendorCallError,
  type VisionRequest,
  type VisionResponse,
} from '../_shared/visionAdapter/index.ts';
import { getDropboxAccessToken, uploadFile, createFolder } from '../_shared/dropbox.ts';
import { tryAcquireMutex, releaseMutex } from '../_shared/dispatcherMutex.ts';
import {
  sourceContextBlock,
  SOURCE_CONTEXT_BLOCK_VERSION,
  type SourceType,
} from '../_shared/visionPrompts/blocks/sourceContextBlock.ts';
import {
  photographerTechniquesBlock,
  PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/photographerTechniquesBlock.ts';
import {
  exifContextBlock,
  EXIF_CONTEXT_BLOCK_VERSION,
  type ExifContextOpts,
} from '../_shared/visionPrompts/blocks/exifContextBlock.ts';
import {
  voiceAnchorBlock,
  VOICE_ANCHOR_BLOCK_VERSION,
  SYDNEY_PRIMER_BLOCK,
  SYDNEY_PRIMER_BLOCK_VERSION,
  SELF_CRITIQUE_BLOCK,
  SELF_CRITIQUE_BLOCK_VERSION,
  type PropertyTier,
  type VoiceAnchorOpts,
} from '../_shared/visionPrompts/blocks/voiceAnchorBlock.ts';
// W11.7.17 — Stage 1 prompt assembly swaps the legacy stage1ResponseSchema for
// universalVisionResponseSchemaV2. The legacy file is left in place as
// historical record (per W11.7.17 ticket — DO NOT DELETE). Stage 4's
// STAGE4_TOOL_SCHEMA stays on its current schema (W11.7.17 spec is per-image
// only; cross-image master_listing moved to a future W11.7 spec).
import {
  UNIVERSAL_SIGNAL_KEYS,
  UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION,
  UNIVERSAL_VISION_RESPONSE_TOOL_NAME,
  universalSchemaForSource,
} from '../_shared/visionPrompts/blocks/universalVisionResponseSchemaV2.ts';
import {
  signalMeasurementBlock,
  SIGNAL_MEASUREMENT_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/signalMeasurementBlock.ts';
import { normaliseSignalScores } from '../_shared/visionPrompts/blocks/normaliseSignalScores.ts';
import { getActiveTierConfig, type TierConfigRow } from '../_shared/tierConfig.ts';
import { selectCombinedScore } from '../_shared/scoreRollup.ts';
import { computeAggregateScores } from '../_shared/dimensionRollup.ts';
import {
  projectMemoryBlock,
  PROJECT_MEMORY_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/projectMemoryBlock.ts';
import {
  fewShotLibraryBlock,
  FEW_SHOT_LIBRARY_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/fewShotLibraryBlock.ts';
import {
  canonicalRegistryBlock,
  CANONICAL_REGISTRY_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/canonicalRegistryBlock.ts';
import { buildPass1Prompt } from '../_shared/pass1Prompt.ts';
import { deriveLensClass } from '../_shared/lensClass.ts';
import { roomTypeTaxonomyBlock } from '../_shared/visionPrompts/blocks/roomTypeTaxonomy.ts';
import {
  roomTypesFromDb,
  ROOM_TYPES_FROM_DB_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/roomTypesFromDb.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';

const GENERATOR = 'shortlisting-shape-d';

// ─── Constants ──────────────────────────────────────────────────────────────

const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-pro';
const STAGE1_DEFAULT_THINKING_BUDGET = 2048;
const STAGE1_DEFAULT_MAX_OUTPUT_TOKENS = 6000;
const STAGE1_DEFAULT_TIMEOUT_MS = 90_000; // 90s per image — matches harness adapter timeout
// Concurrency control for per-image calls. The harness uses BATCH_SIZE=4 for
// composition-batches × per-vendor fan-out; we go a bit wider here because
// we have one vendor (Gemini) and Gemini Pro pay-as-you-go tolerates 60 RPM.
// With 8 in flight at ~10-15s each, 42 images finishes in ~3-4 min.
const STAGE1_PER_IMAGE_CONCURRENCY = 8;
const DEFAULT_COST_CAP_USD = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  _health_check?: boolean;
}

// Wave 11.7.1 immediate-ack contract:
// The dispatcher's invokeFunction has a 120s AbortSignal timeout. Stage 1
// per-image with 42 images at concurrency=8 takes ~3-4 min wall, so a
// synchronous return blows the gateway. We adopt the same `EdgeRuntime.waitUntil`
// pattern as `shortlist-lock` and `vendor-retroactive-compare`: validate +
// mutex + cost cap synchronously, kick the heavy work into a background
// promise, return HTTP 200 immediately with `mode: 'background'`. The
// background work then self-updates `shortlisting_jobs.status='succeeded'|'failed'`
// when it finishes — the dispatcher MUST NOT auto-mark on the HTTP 200 ack
// (it honors the `mode === 'background'` flag in the response body, see
// shortlisting-job-dispatcher::callEdgeFunction).
const BACKGROUND_MODE_RESPONSE = 'background';

interface CompositionRow {
  group_id: string;
  group_index: number;
  best_bracket_stem: string | null;
  delivery_reference_stem: string | null;
  stem: string;
  is_secondary_camera: boolean;
  /** Wave 11.6.7 P1-4: per-stem ExifSignals JSONB pulled from
   *  composition_groups.exif_metadata. Keyed by file stem. Used by
   *  persistOneClassification to derive lens_class. */
  exif_metadata: Record<string, unknown> | null;
}

interface RoundContext {
  round_id: string;
  project_id: string;
  status: string;
  engine_tier_id: string | null;
  property_tier: PropertyTier;
  property_voice_anchor_override: string | null;
  dropbox_root_path: string;
  property_address: string | null;
  property_suburb: string | null;
  pricing_tier: string | null;
  property_type: string | null;
}

interface EngineSettings {
  engine_mode: 'two_pass' | 'shape_d';
  // W11.8.1: production_vendor is hardcoded to 'google'. Anthropic failover
  // stripped — failover_vendor field removed from this interface entirely.
  // Future Gemini regressions fail LOUD via VendorCallError instead of
  // silently 12×-ing the bill.
  production_vendor: 'google';
  stage1_thinking_budget: number;
  stage1_max_output_tokens: number;
  cost_cap_per_round_usd: number;
}

/**
 * Per-image call result: either a successful classified output, or an error
 * captured per-image (the round still completes; failed images get audit rows).
 *
 * `input_tokens` / `output_tokens` come from the vision adapter's `usage`
 * field. They are 0 for failed calls (no usage to attribute) and accumulate
 * to engine_run_audit.stage1_total_input_tokens / stage1_total_output_tokens
 * (W11.5/11.7 closed-loop wave: token attribution was previously hard-coded
 * to 0; now sums correctly across parallel batches).
 */
interface PerImageResult {
  group_id: string;
  stem: string;
  output: Record<string, unknown> | null;
  error: string | null;
  cost_usd: number;
  wall_ms: number;
  input_tokens: number;
  output_tokens: number;
  // W11.8.1: vendor narrowed to 'google' (Anthropic stripped). Kept as a
  // literal type rather than removed so call-site code that reads .vendor_used
  // for audit-row assembly stays type-safe.
  vendor_used: 'google';
  model_used: string;
  // W11.8.1: failover_triggered + failover_reason are always false/null now.
  // Kept on the result shape so engine_run_audit + shortlisting_events column
  // population stays unchanged — admin dashboards (cost-per-round, vendor mix)
  // read these columns and must continue to find them.
  failover_triggered: false;
  failover_reason: null;
}

// ─── Handler ────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth: service-role bypass + master_admin/admin/manager allowed (matches
  // pass1). The dispatcher passes a service-role JWT.
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body OK */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.1-per-image', _fn: GENERATOR }, 200, req);
  }

  // Resolve round_id from job_id if dispatcher invoked us. We capture the
  // job_id explicitly so the background worker can self-update the row on
  // completion (the dispatcher relies on this when mode='background').
  let roundId = body.round_id || null;
  const jobId = body.job_id || null;
  if (!roundId && jobId) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id')
      .eq('id', jobId)
      .maybeSingle();
    if (job?.round_id) roundId = job.round_id;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

  // Project-access guard for non-service callers (matches pass1 audit defect #42).
  if (!isService) {
    const adminLookup = getAdminClient();
    const { data: rowForAcl } = await adminLookup
      .from('shortlisting_rounds')
      .select('project_id')
      .eq('id', roundId)
      .maybeSingle();
    const pid = rowForAcl?.project_id ? String(rowForAcl.project_id) : '';
    if (!pid) return errorResponse('round not found', 404, req);
    const allowed = await callerHasProjectAccess(user, pid);
    if (!allowed) {
      return errorResponse('Forbidden — caller has no access to this project', 403, req);
    }
  }

  // ── Synchronous pre-flight ────────────────────────────────────────────────
  // We do everything that can fail fast (auth, mode gate, cost cap, mutex
  // acquisition) BEFORE returning the immediate-ack so the dispatcher can
  // surface those failures via the standard HTTP error path. Only after these
  // succeed do we kick the long-running Stage 1 work into the background.
  let preflight: PreflightOk;
  try {
    preflight = await preflightShapeDStage1(roundId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] preflight failed for round ${roundId}: ${msg}`);
    return errorResponse(`shortlisting-shape-d preflight failed: ${msg}`, 400, req);
  }

  // ── Background dispatch ───────────────────────────────────────────────────
  const startedIso = new Date().toISOString();
  const bgWork = runShapeDStage1Background({ roundId, jobId, preflight })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] background work failed for round ${roundId}: ${msg}`);
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  // The dispatcher inspects `mode === 'background'` and skips auto-marking
  // the job row as succeeded — bgWork persists status='succeeded' or
  // 'failed' on completion.
  return jsonResponse(
    {
      ok: true,
      mode: BACKGROUND_MODE_RESPONSE,
      round_id: roundId,
      job_id: jobId,
      started_at: startedIso,
    },
    200,
    req,
  );
});

// ─── Core orchestration ──────────────────────────────────────────────────────

interface RoundResult {
  total_compositions: number;
  successes: number;
  failures: number;
  per_image_calls_run: number;
  stage1_cost_usd: number;
  stage1_wall_ms: number;
  engine_mode: string;
  // W11.8.1: Anthropic stripped; vendor is always 'google'. failover_triggered
  // is always false but kept for downstream audit-shape compatibility.
  vendor_used: 'google';
  model_used: string;
  failover_triggered: false;
  stage4_dispatched: boolean;
  stage4_job_id: string | null;
  canonical_rollup_dispatched: boolean;
  canonical_rollup_job_id: string | null;
  audit_dropbox_path: string | null;
  warnings: string[];
}

// PreflightOk carries everything the synchronous pre-flight resolved so
// bgWork doesn't redo the work. Notably, the mutex is already acquired —
// bgWork's finally MUST release it.
interface PreflightOk {
  ctx: RoundContext;
  settings: EngineSettings;
  compositions: CompositionRow[];
  groupsToRun: CompositionRow[];
  primedGroupIds: Set<string>;
  voice: VoiceAnchorOpts;
  sourceType: SourceType;
  preflightWarnings: string[];
  lockName: string;
  tickId: string;
  startedAt: number;
}

/**
 * Synchronous pre-flight: run everything that can fail fast (engine settings,
 * round context, mode gate, cost cap, mutex acquisition) BEFORE returning
 * the immediate-ack. Throws on any failure; the handler converts that to a
 * 400 so the dispatcher gets a fast unambiguous failure rather than a
 * timeout. On success, the mutex IS HELD — the caller is responsible for
 * releasing it via bgWork's finally block.
 */
async function preflightShapeDStage1(roundId: string): Promise<PreflightOk> {
  const startedAt = Date.now();
  const admin = getAdminClient();
  const preflightWarnings: string[] = [];

  // 1. Engine settings
  const settings = await loadEngineSettings(admin);

  // 2. Round bootstrap
  const ctx = await loadRoundContext(admin, roundId);
  if (ctx.status !== 'processing') {
    throw new Error(
      `round ${roundId} status='${ctx.status}' — Shape D Stage 1 requires status='processing'`,
    );
  }

  // 3. Engine-mode gate
  const roundEngineMode = await loadRoundEngineMode(admin, roundId);
  const wantsShapeD = roundEngineMode?.startsWith('shape_d')
    || (settings.engine_mode === 'shape_d' && (!roundEngineMode || roundEngineMode === 'two_pass'));
  if (!wantsShapeD) {
    throw new Error(
      `round ${roundId} engine_mode is two_pass — use shortlisting-pass1. ` +
      `Set engine_settings.engine_mode='shape_d' or shortlisting_rounds.engine_mode='shape_d_full' ` +
      `to opt this round into Shape D.`,
    );
  }

  // 4. Composition groups
  const compositions = await loadCompositionGroups(admin, roundId);
  if (compositions.length === 0) {
    throw new Error(`round ${roundId} has no composition_groups — Pass 0 must run first`);
  }

  // 5. Idempotency: prime from existing classifications
  const primedGroupIds = await loadPrimedGroupIds(admin, roundId);
  const groupsToRun = compositions.filter((c) => !primedGroupIds.has(c.group_id));
  if (groupsToRun.length === 0) {
    preflightWarnings.push(
      `all ${compositions.length} compositions already classified — re-dispatching Stage 4 only`,
    );
  } else if (primedGroupIds.size > 0) {
    preflightWarnings.push(
      `${primedGroupIds.size} compositions already classified (primed); re-classifying ${groupsToRun.length}`,
    );
  }

  // 6. Cost cap pre-flight (BEFORE we acquire the mutex — no need to hold
  // the lock if we're going to bail). Per-image envelope: ~$0.012/call on
  // Gemini 2.5 Pro at thinkingBudget=2048 + max_output=6000. 42 images = ~$0.50.
  const preflightUsd = estimateStage1Cost(groupsToRun.length);
  if (preflightUsd > settings.cost_cap_per_round_usd) {
    throw new Error(
      `Stage 1 pre-flight cost $${preflightUsd.toFixed(4)} exceeds cap ` +
      `$${settings.cost_cap_per_round_usd.toFixed(4)} (${groupsToRun.length} per-image calls). ` +
      `Increase engine_settings.cost_cap_per_round_usd to override.`,
    );
  }

  // 7. Voice + source type
  const voice: VoiceAnchorOpts = {
    tier: ctx.property_tier,
    override: ctx.property_voice_anchor_override,
  };
  const sourceType: SourceType = 'internal_raw';

  // 8. Acquire mutex synchronously — this MUST happen before we return the
  // immediate-ack so a concurrent re-trigger by the dispatcher (or a manual
  // retry) gets a clean rejection rather than double-firing Stage 1.
  // bgWork's finally is responsible for the release.
  const lockName = `shape-d-stage1:${roundId}`;
  const tickId = crypto.randomUUID();
  const acquired = await tryAcquireMutex(admin, lockName, tickId);
  if (!acquired) {
    throw new Error(`round ${roundId} Shape D Stage 1 already running (mutex held)`);
  }

  return {
    ctx,
    settings,
    compositions,
    groupsToRun,
    primedGroupIds,
    voice,
    sourceType,
    preflightWarnings,
    lockName,
    tickId,
    startedAt,
  };
}

interface BackgroundArgs {
  roundId: string;
  jobId: string | null;
  preflight: PreflightOk;
}

/**
 * Background worker: runs Stage 1 per-image calls, persists results, dispatches
 * Stage 4 chain row, and self-updates the dispatching shortlisting_jobs row
 * (when invoked via dispatcher). Always releases the mutex in its finally.
 *
 * Idempotency: the success path inserts a stage4_synthesis chain row guarded
 * by an existence check + a unique partial index (mig 377). Re-running this
 * fn after a partial completion will re-classify only the missing groups
 * (loadPrimedGroupIds filters them out) and skip the chain insert.
 */
async function runShapeDStage1Background(args: BackgroundArgs): Promise<void> {
  const admin = getAdminClient();
  const { roundId, jobId, preflight } = args;
  const { lockName, tickId } = preflight;

  try {
    const result = await runShapeDStage1Core(roundId, preflight);
    // Self-update the dispatching job row. The dispatcher saw mode='background'
    // and skipped its auto-mark; we own the row state from here.
    if (jobId) {
      const { error: updErr } = await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          error_message: null,
          result: { ok: true, round_id: roundId, ...result },
        })
        .eq('id', jobId);
      if (updErr) {
        console.warn(`[${GENERATOR}] job self-update succeeded write failed: ${updErr.message}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background Stage 1 failed for round ${roundId}: ${msg}`);
    if (jobId) {
      const { error: updErr } = await admin
        .from('shortlisting_jobs')
        .update({
          status: 'failed',
          finished_at: new Date().toISOString(),
          error_message: msg.slice(0, 1000),
        })
        .eq('id', jobId);
      if (updErr) {
        console.warn(`[${GENERATOR}] job self-update failed write failed: ${updErr.message}`);
      }
    }
  } finally {
    await releaseMutex(admin, lockName, tickId).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] mutex release failed: ${msg}`);
    });
  }
}

/**
 * Core Stage 1 work. Receives the resolved preflight context so it doesn't
 * redo round / settings / group lookups. Returns the result payload that is
 * either echoed in the dispatcher response (legacy-direct invocation) or
 * persisted into shortlisting_jobs.result (dispatcher path).
 */
async function runShapeDStage1Core(
  roundId: string,
  preflight: PreflightOk,
): Promise<RoundResult> {
  const admin = getAdminClient();
  const { ctx, settings, compositions, groupsToRun, primedGroupIds, voice, sourceType, startedAt } = preflight;
  const warnings: string[] = [...preflight.preflightWarnings];

  // Build the prompt ONCE — identical across all per-image calls. Same
  // composition pattern as the harness's `userPrefix`: pass1 system + Sydney
  // primer in system; source-context + voice anchor + self-critique +
  // per-image task instructions in user_text.
  // W11.6.7 P1-3: room_type taxonomy is DB-driven via shortlisting_room_types
  // (admin-editable, 60s in-memory cache, falls back to the static block on
  // DB error). Fetch in parallel with Stream B anchors, then string-substitute
  // the static block in the assembled prompt's userPrefix with the dynamic
  // version. We keep `buildPass1Prompt` as a pure synchronous builder rather
  // than threading async DB calls through it.
  const [anchors, dynamicRoomTypes] = await Promise.all([
    getActiveStreamBAnchors(),
    roomTypesFromDb(),
  ]);
  const basePrompt = buildPass1Prompt(anchors);
  const staticRoomTypeText = roomTypeTaxonomyBlock();
  if (basePrompt.userPrefix.includes(staticRoomTypeText)) {
    basePrompt.userPrefix = basePrompt.userPrefix.replace(
      staticRoomTypeText,
      dynamicRoomTypes.text,
    );
    basePrompt.blockVersions['roomTypeTaxonomy'] = dynamicRoomTypes.version;
  } else {
    warnings.push(
      `roomTypesFromDb: static block sentinel not found in pass1 userPrefix — ` +
        `dynamic block NOT applied (using static fallback)`,
    );
  }
  console.log(
    `[${GENERATOR}] roomTypesFromDb version=${basePrompt.blockVersions['roomTypeTaxonomy']} ` +
      `(dynamic=${
        basePrompt.blockVersions['roomTypeTaxonomy'] === ROOM_TYPES_FROM_DB_BLOCK_VERSION ? 'yes' : 'no'
      })`,
  );

  // ── Closed-loop learning: project_memory + few_shot blocks (W11.5/11.7) ──
  // Both are async (DB lookups) — fetch in parallel. Either may return ''
  // when there's nothing to render; the join with '\n' below collapses
  // empty blocks cleanly without polluting the prompt with empty headers.
  //
  // projectMemoryBlock: per-project authoritative prior corrections from
  //   composition_classification_overrides. Injected at the END of system
  //   prompt so it sits in the highest-precedence context — when the model
  //   weighs evidence, prior operator corrections are treated as ground
  //   truth for THIS property.
  // fewShotLibraryBlock: master_admin-curated cross-project patterns from
  //   engine_fewshot_examples. Injected at the END of user prompt — last
  //   thing the model reads before emitting JSON, so the empirical
  //   correction patterns are top-of-mind on tricky judgements.
  // canonicalRegistryBlock: Wave 12 cross-project canonical feature registry.
  //   Renders the top-N most-frequent canonical objects from object_registry
  //   so the model prefers canonical_ids when emitting observed_objects.
  //   Returns '' when the registry is empty — safe to wire unconditionally.
  const [projectMemoryText, fewShotText, canonicalRegistryText] = await Promise.all([
    // W11.6.19: pass voice.tier so the block applies tier-aware caps
    // (premium=50, standard=30, approachable=20) to bound prompt growth as
    // operator corrections accumulate per project.
    projectMemoryBlock({ project_id: ctx.project_id, current_round_id: roundId, tier: voice.tier }),
    fewShotLibraryBlock({ property_tier: voice.tier }),
    canonicalRegistryBlock(),
  ]);

  // System prompt: pass1 system blocks (header + stepOrdering) + W11.7.17
  // signalMeasurementBlock (source-aware 26-signal measurement prompts;
  // injected right after `header` per W11.7.17 spec §11) + Sydney primer
  // (anchor style_archetype + era_hint to Sydney typology) + project_memory
  // at the END so it's the last authoritative directive before user content.
  // canonical registry is appended at the very END as the authoritative
  // cross-project feature vocabulary (W12 spec §"Canonical registry").
  const systemBlocks = [
    basePrompt.system,
    '',
    '── SIGNAL MEASUREMENT INSTRUCTIONS (W11.7.17 v2) ──',
    signalMeasurementBlock(sourceType),
    '',
    SYDNEY_PRIMER_BLOCK,
  ];
  if (projectMemoryText.length > 0) {
    systemBlocks.push('', '── PROJECT MEMORY (W11.5) ──', projectMemoryText);
  }
  if (canonicalRegistryText.length > 0) {
    systemBlocks.push('', '── CANONICAL FEATURE REGISTRY (W12) ──', canonicalRegistryText);
  }
  const systemText = systemBlocks.join('\n');

  // User prompt: source-context preamble TOP, then photographer-techniques
  // preamble (recognise deliberate craft moves like fingers-over-sun so we
  // don't penalise them), then pass1 user blocks (room taxonomy, scoring
  // anchors, vantage, clutter), then voice anchor rubric, then self-critique,
  // then few_shot library at the END. The model sees ONE image — no stem
  // matching needed.
  // W11.6.14 wiring: split the user prompt into a `userTextPrefix`
  // (everything BEFORE the per-image EXIF block) and `userTextSuffix`
  // (SELF_CRITIQUE + few_shot library) so runStage1PerImage can splice
  // the per-image exifContextBlock between them. The EXIF block is fresh
  // context for the model just before the scoring discipline reminder.
  const userPrefixBlocks = [
    sourceContextBlock(sourceType),
    '',
    photographerTechniquesBlock(),
    '',
    basePrompt.userPrefix,
    '',
    '── VOICE ANCHOR (drives per-image listing_copy register) ──',
    voiceAnchorBlock(voice),
  ];
  const userSuffixBlocks: string[] = [
    '── SELF-CRITIQUE ──',
    SELF_CRITIQUE_BLOCK,
  ];
  if (fewShotText.length > 0) {
    userSuffixBlocks.push('', '── EMPIRICAL FEW-SHOT LIBRARY (W11.5/11.7/W14) ──', fewShotText);
  }
  const userTextPrefix = userPrefixBlocks.join('\n');
  const userTextSuffix = userSuffixBlocks.join('\n');

  // W11.6.18 — resolve the active tier_config once per round so persist can
  // pick the W11 per-signal weighted rollup when signal_weights is configured.
  // Falls back to null (legacy hardcoded 4-axis blend) when engine_tier_id is
  // missing or no active config exists. Mirrors the shortlisting-pass1 path
  // and emits a shortlisting_events warning so admin notices.
  const tierConfig: TierConfigRow | null = ctx.engine_tier_id
    ? await getActiveTierConfig(ctx.engine_tier_id)
    : null;
  if (!tierConfig) {
    const reason = !ctx.engine_tier_id
      ? 'engine_tier_id is null (legacy round)'
      : 'no active tier_config row for engine_tier_id';
    warnings.push(
      `shape-d tier_config fallback: ${reason} — combined_score uses legacy hardcoded weights`,
    );
    const { error: warnEvtErr } = await admin
      .from('shortlisting_events')
      .insert({
        project_id: ctx.project_id,
        round_id: roundId,
        event_type: 'shape_d_tier_config_fallback',
        actor_type: 'system',
        payload: {
          engine_tier_id: ctx.engine_tier_id,
          reason,
        },
      });
    if (warnEvtErr) {
      warnings.push(`tier_config fallback warning event insert failed: ${warnEvtErr.message}`);
    }
  }

  // Run per-image calls in parallel batches of STAGE1_PER_IMAGE_CONCURRENCY.
  // Persist each successful classification to composition_classifications
  // immediately as it completes (don't wait for batch closure).
  const previewsBase = `${ctx.dropbox_root_path.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews`;
  const allResults: PerImageResult[] = [];

  if (groupsToRun.length > 0) {
    const sortedGroups = [...groupsToRun].sort((a, b) => {
      const sec = (a.is_secondary_camera ? 1 : 0) - (b.is_secondary_camera ? 1 : 0);
      if (sec !== 0) return sec;
      return a.group_index - b.group_index;
    });

    for (let i = 0; i < sortedGroups.length; i += STAGE1_PER_IMAGE_CONCURRENCY) {
      const batch = sortedGroups.slice(i, i + STAGE1_PER_IMAGE_CONCURRENCY);
      const batchResults = await Promise.all(batch.map((c) =>
        runStage1PerImage({
          composition: c,
          ctx,
          systemText,
          userTextPrefix,
          userTextSuffix,
          settings,
          previewsBase,
          sourceType,
        }).catch((err): PerImageResult => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[${GENERATOR}] per-image ${c.stem} failed wholesale: ${msg}`);
          return {
            group_id: c.group_id,
            stem: c.stem,
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

      // Persist successes in this slice immediately (matches per-image
      // harness pattern — no batch-end barrier).
      // W11.6.13 (rebase fix): build a quick lookup of group_id → composition
      // row from the current batch slice so persistOneClassification can
      // resolve the originating composition without an out-of-scope `c`.
      const batchById = new Map(batch.map((c) => [c.group_id, c]));
      for (const r of batchResults) {
        if (r.output) {
          const comp = batchById.get(r.group_id);
          if (!comp) {
            warnings.push(`persistOneClassification: composition row missing for group_id=${r.group_id}`);
            continue;
          }
          await persistOneClassification({
            admin,
            roundId,
            projectId: ctx.project_id,
            result: r,
            promptBlockVersions: stage1PromptBlockVersions(),
            modelVersion: r.model_used,
            // W11.6.7 P1-4: composition row carries exif_metadata for lens_class derivation.
            composition: comp,
            // W11.6.18: per-round tier_config drives the W11 per-signal
            // weighted rollup when signal_weights is non-empty.
            tierConfig,
            // W11.7.17 (v2): thread source_type so persist tags every row
            // with the right discriminator + writes the matching *_specific
            // JSONB block.
            sourceType,
            warnings,
          });
        }
      }

      allResults.push(...batchResults);
      console.log(
        `[${GENERATOR}] batch ${Math.floor(i / STAGE1_PER_IMAGE_CONCURRENCY) + 1}/` +
        `${Math.ceil(sortedGroups.length / STAGE1_PER_IMAGE_CONCURRENCY)} ` +
        `(${batchResults.filter((r) => r.output).length}/${batch.length} succeeded)`,
      );
    }
  }

  // ── Aggregate cost + wall + tokens ───────────────────────────────────────
  //
  // Tokens accumulate via reduce() over `allResults`. `allResults` is built by
  // pushing batch slices sequentially in the outer for-loop, so even though
  // each batch slice runs in parallel via Promise.all, the slice merge into
  // `allResults` happens on the main fiber — no race conditions on the
  // accumulator. Each PerImageResult carries its own input_tokens /
  // output_tokens straight from the vision adapter's usage envelope.
  const allSuccesses = allResults.filter((r) => r.output);
  const allFailures = allResults.filter((r) => !r.output);
  const totalCostUsd = allResults.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalInputTokens = allResults.reduce((sum, r) => sum + (r.input_tokens || 0), 0);
  const totalOutputTokens = allResults.reduce((sum, r) => sum + (r.output_tokens || 0), 0);
  // Wall time for per-image is harder than batched: we ran in parallel, so
  // the actual wall is roughly (ceil(N/concurrency) × max_per_image_wall).
  // We use sum of all per-image walls as the API-time aggregate (useful for
  // cost/perf rollup); operator-visible wall is in shortlisting_events.
  const totalApiWallMs = allResults.reduce((sum, r) => sum + r.wall_ms, 0);
  const operatorWallMs = Date.now() - startedAt;
  // W11.8.1: failover stripped — these are constants now. Kept named so the
  // audit + events writes below don't need to be threaded through new
  // signatures, and so the engine_run_audit columns continue to be written.
  const failoverTriggered = false;
  const failoverReason: string | null = null;

  // ── Determine round engine_mode result ───────────────────────────────────
  const totalGroupsTouched = groupsToRun.length;
  const partial = allFailures.length > 0 && allSuccesses.length > 0;
  const allFailed = totalGroupsTouched > 0 && allSuccesses.length === 0;
  const finalEngineMode = allFailed
    ? 'two_pass' /* leave it for retry */
    : (partial ? 'shape_d_partial' : 'shape_d_full');

  if (allFailed) {
    throw new Error(
      `Stage 1 failed for all ${totalGroupsTouched} compositions. Sample errors: ` +
      allFailures.slice(0, 3).map((f) => `${f.stem}: ${f.error}`).join(' | '),
    );
  }

  // ── Stamp engine_mode + cost on shortlisting_rounds ──────────────────────
  {
    // Accumulate cost across retries (matches pass1 audit defect #5 pattern).
    const { data: priorRound } = await admin
      .from('shortlisting_rounds')
      .select('stage_1_total_cost_usd')
      .eq('id', roundId)
      .maybeSingle();
    const priorCost = typeof priorRound?.stage_1_total_cost_usd === 'number'
      ? priorRound.stage_1_total_cost_usd
      : 0;
    const accumulated = priorCost + totalCostUsd;
    const rounded = Math.round(accumulated * 1_000_000) / 1_000_000;
    const { error: updErr } = await admin
      .from('shortlisting_rounds')
      .update({
        engine_mode: finalEngineMode,
        stage_1_total_cost_usd: rounded,
      })
      .eq('id', roundId);
    if (updErr) warnings.push(`round update failed: ${updErr.message}`);
  }

  // ── engine_run_audit upsert (Stage 1 stage_complete) ─────────────────────
  // Token attribution: previously hard-coded to 0 — this commit threads
  // input_tokens / output_tokens through PerImageResult and accumulates
  // across all parallel batches. Persisted to engine_run_audit's
  // stage1_total_input_tokens + stage1_total_output_tokens columns
  // (mig 376). Cost-per-token rollups + W11.6 dashboard now have real
  // token counts to query.
  await upsertEngineRunAudit({
    admin,
    roundId,
    engineMode: finalEngineMode,
    // W11.8.1: vendor + model are always Gemini now (Anthropic failover gone).
    vendorUsed: PRIMARY_VENDOR,
    modelUsed: PRIMARY_MODEL,
    failoverTriggered,
    failoverReason,
    stage1CallCount: allResults.length,
    stage1TotalCostUsd: totalCostUsd,
    stage1TotalWallMs: operatorWallMs,
    stage1TotalInputTokens: totalInputTokens,
    stage1TotalOutputTokens: totalOutputTokens,
    stages_completed: ['stage1'],
    stages_failed: partial ? ['stage1_partial'] : [],
    retry_count: 0,
    warnings,
  });

  // ── Audit JSON to Dropbox ────────────────────────────────────────────────
  const auditPath = await uploadStage1AuditJson({
    ctx,
    roundId,
    finalEngineMode,
    perImageResults: allResults,
    compositions,
    groupsToRun,
    persisted: allSuccesses.length,
    voice,
    sourceType,
    settings,
    startedAt,
    warnings,
  });

  // ── Dispatch Stage 4 as a separate edge job ──────────────────────────────
  // Important production lesson from iter-5a: Stage 4 must NOT chain in this
  // same worker. Stage 1 (per-image parallel, ~3-4 min) + Stage 4 (60-90s +
  // 16k thinking) hit the edge-runtime wall budget. Insert a
  // `stage4_synthesis` job; the dispatcher (mig 377 extends the kind enum)
  // routes it to shortlisting-shape-d-stage4 next tick.
  const stage4JobId = await dispatchStage4Job({
    admin,
    projectId: ctx.project_id,
    roundId,
    warnings,
  });

  // ── Dispatch canonical-rollup as a separate edge job ─────────────────────
  // Wave 12 hygiene: Stage 1.5 normalisation runs as its own dispatcher-routed
  // job (kind='canonical_rollup') alongside stage4_synthesis. It walks the
  // round's composition_classifications, embeds each key_element via Gemini,
  // and writes raw_attribute_observations + bumps object_registry frequency
  // (or queues object_registry_candidates for ambiguous matches).
  //
  // It runs AFTER Stage 1 because it reads composition_classifications.key_elements
  // (Stage 1's output). It can run IN PARALLEL with Stage 4 because the two
  // touch disjoint tables — Stage 4 writes shortlisting_overrides + master_listings,
  // canonical-rollup writes raw_attribute_observations + object_registry.
  // No mutex contention, no ordering requirement.
  //
  // The canonical-rollup fn is idempotent: the unique index on
  // (round_id, group_id, raw_label) for raw_attribute_observations means
  // re-running for the same round skips already-processed labels. So a
  // dispatcher retry on transient failure won't double-count market_frequency.
  const canonicalRollupJobId = await dispatchCanonicalRollupJob({
    admin,
    projectId: ctx.project_id,
    roundId,
    warnings,
  });

  // ── Append shortlisting_events ───────────────────────────────────────────
  await admin.from('shortlisting_events').insert({
    project_id: ctx.project_id,
    round_id: roundId,
    event_type: 'shape_d_stage1_complete',
    actor_type: 'system',
    payload: {
      engine_mode: finalEngineMode,
      per_image_calls_run: allResults.length,
      successes: allSuccesses.length,
      failures: allFailures.length,
      compositions_total: compositions.length,
      compositions_primed: primedGroupIds.size,
      cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      wall_ms: operatorWallMs,
      api_wall_ms_sum: totalApiWallMs,
      // W11.8.1: vendor always 'google' post-failover-strip.
      vendor_used: PRIMARY_VENDOR,
      failover_triggered: failoverTriggered,
      stage4_job_id: stage4JobId,
      canonical_rollup_job_id: canonicalRollupJobId,
      audit_dropbox_path: auditPath,
    },
  });

  return {
    total_compositions: compositions.length,
    successes: allSuccesses.length,
    failures: allFailures.length,
    per_image_calls_run: allResults.length,
    stage1_cost_usd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
    stage1_wall_ms: operatorWallMs,
    engine_mode: finalEngineMode,
    // W11.8.1: vendor + model always Gemini Pro post-failover-strip.
    vendor_used: PRIMARY_VENDOR,
    model_used: PRIMARY_MODEL,
    failover_triggered: failoverTriggered,
    stage4_dispatched: !!stage4JobId,
    stage4_job_id: stage4JobId,
    canonical_rollup_dispatched: !!canonicalRollupJobId,
    canonical_rollup_job_id: canonicalRollupJobId,
    audit_dropbox_path: auditPath,
    warnings,
  };
}

// ─── Engine settings loader ──────────────────────────────────────────────────

async function loadEngineSettings(
  admin: ReturnType<typeof getAdminClient>,
): Promise<EngineSettings> {
  // W11.8.1: production_vendor + failover_vendor stripped from required keys.
  // production_vendor is hardcoded to 'google' since Anthropic vision is gone.
  // The DB rows for those keys may still exist — they're harmless and ignored.
  const keys = [
    'engine_mode',
    'stage1_thinking_budget',
    'stage1_max_output_tokens',
    'cost_cap_per_round_usd',
  ];
  const { data, error } = await admin
    .from('engine_settings')
    .select('key, value')
    .in('key', keys);
  if (error) {
    console.warn(`[${GENERATOR}] engine_settings load failed: ${error.message} — using defaults`);
  }
  const map = new Map<string, unknown>();
  for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
    map.set(row.key, row.value);
  }

  // Helpers — engine_settings.value is JSONB so a string value comes back as
  // a JS string already; a numeric value as a number.
  const str = (k: string, def: string): string => {
    const v = map.get(k);
    if (typeof v === 'string') return v;
    return def;
  };
  const num = (k: string, def: number): number => {
    const v = map.get(k);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isNaN(n) ? def : n;
    }
    return def;
  };

  const engine_mode = (str('engine_mode', 'two_pass') as 'two_pass' | 'shape_d');

  return {
    engine_mode,
    production_vendor: 'google',
    stage1_thinking_budget: num('stage1_thinking_budget', STAGE1_DEFAULT_THINKING_BUDGET),
    stage1_max_output_tokens: num('stage1_max_output_tokens', STAGE1_DEFAULT_MAX_OUTPUT_TOKENS),
    cost_cap_per_round_usd: num('cost_cap_per_round_usd', DEFAULT_COST_CAP_USD),
  };
}

// ─── Round + composition group loaders ──────────────────────────────────────

async function loadRoundEngineMode(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<string | null> {
  const { data } = await admin
    .from('shortlisting_rounds')
    .select('engine_mode')
    .eq('id', roundId)
    .maybeSingle();
  return (data?.engine_mode as string | null) || null;
}

async function loadRoundContext(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<RoundContext> {
  const { data: round, error: rErr } = await admin
    .from('shortlisting_rounds')
    .select(
      'id, project_id, status, engine_tier_id, property_tier, property_voice_anchor_override',
    )
    .eq('id', roundId)
    .maybeSingle();
  if (rErr) throw new Error(`round lookup failed: ${rErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);

  const { data: proj, error: pErr } = await admin
    .from('projects')
    .select(
      'id, dropbox_root_path, property_address, property_suburb, pricing_tier, property_type',
    )
    .eq('id', round.project_id)
    .maybeSingle();
  if (pErr) throw new Error(`project lookup failed: ${pErr.message}`);
  if (!proj) throw new Error(`project ${round.project_id} not found`);

  const dropboxRoot = (proj.dropbox_root_path as string | null) || null;
  if (!dropboxRoot) {
    throw new Error(
      `project ${round.project_id} has no dropbox_root_path — folders not provisioned`,
    );
  }

  // property_tier may be null on legacy rounds; default 'standard' (matches
  // mig 372 trigger). The trigger normally fills this on round insert, but
  // we fall back defensively for any pre-trigger rows.
  const propertyTier = ((round.property_tier as string | null) || 'standard') as PropertyTier;
  if (!['premium', 'standard', 'approachable'].includes(propertyTier)) {
    throw new Error(
      `round ${roundId} has invalid property_tier='${propertyTier}' — must be premium|standard|approachable`,
    );
  }

  return {
    round_id: roundId,
    project_id: round.project_id as string,
    status: round.status as string,
    engine_tier_id: (round.engine_tier_id as string | null) ?? null,
    property_tier: propertyTier,
    property_voice_anchor_override: (round.property_voice_anchor_override as string | null) ?? null,
    dropbox_root_path: dropboxRoot,
    property_address: (proj.property_address as string | null) ?? null,
    property_suburb: (proj.property_suburb as string | null) ?? null,
    pricing_tier: (proj.pricing_tier as string | null) ?? null,
    property_type: (proj.property_type as string | null) ?? null,
  };
}

async function loadCompositionGroups(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<CompositionRow[]> {
  const { data, error } = await admin
    .from('composition_groups')
    .select('id, group_index, best_bracket_stem, delivery_reference_stem, is_secondary_camera, exif_metadata')
    .eq('round_id', roundId)
    .order('group_index');
  if (error) throw new Error(`composition_groups load failed: ${error.message}`);
  return (data || []).map((g: Record<string, unknown>) => {
    const delivery = (g.delivery_reference_stem as string | null) || null;
    const best = (g.best_bracket_stem as string | null) || null;
    return {
      group_id: g.id as string,
      group_index: g.group_index as number,
      best_bracket_stem: best,
      delivery_reference_stem: delivery,
      stem: delivery || best || `group_${g.group_index}`,
      is_secondary_camera: (g.is_secondary_camera as boolean) ?? false,
      // W11.6.7 P1-4: surface exif_metadata so persistOneClassification can
      // derive lens_class. Pass 0 keys it by stem.
      exif_metadata: (g.exif_metadata as Record<string, unknown> | null) ?? null,
    };
  });
}

async function loadPrimedGroupIds(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<Set<string>> {
  const { data, error } = await admin
    .from('composition_classifications')
    .select('group_id')
    .eq('round_id', roundId);
  if (error) {
    console.warn(`[${GENERATOR}] primed lookup failed: ${error.message} — treating all as fresh`);
    return new Set();
  }
  return new Set((data || []).map((r) => r.group_id as string));
}

// ─── Cost preflight ──────────────────────────────────────────────────────────

function estimateStage1Cost(imageCount: number): number {
  // Per-image envelope on Gemini 2.5 Pro at thinkingBudget=2048 +
  // max_output_tokens=6000:
  //   - prompt: ~3K input tokens (system + user, including voice anchor +
  //     source-context preamble)
  //   - image: ~1.5K input tokens (typical 1MP preview after Gemini downsize)
  //   - thinking: ~2K (counted as input on Gemini Pro accounting)
  //   - output: ~2-4K (verbose enrichment)
  // Round to ~$0.012/call observed in iter-5b harness traces.
  const inputTokensPerImage = 6_500;
  const outputTokensPerImage = 3_500;
  const perImage = estimateCost('google', PRIMARY_MODEL, {
    input_tokens: inputTokensPerImage,
    output_tokens: outputTokensPerImage,
    cached_input_tokens: 0,
  });
  return perImage * imageCount;
}

// ─── Stage 1 per-image runner ────────────────────────────────────────────────

interface RunStage1PerImageOpts {
  composition: CompositionRow;
  ctx: RoundContext;
  systemText: string;
  // W11.6.14: per-image user_text composed in the runner. Prefix is the
  // shared user blocks (source/techniques/pass1/voice anchor); suffix is
  // SELF_CRITIQUE + few_shot library. Per-image exifContextBlock is spliced
  // between them so the model reads fresh metadata just before the scoring
  // discipline reminder.
  userTextPrefix: string;
  userTextSuffix: string;
  settings: EngineSettings;
  previewsBase: string;
  // W11.7.17 hotfix-4: source_type drives the per-source Gemini responseSchema
  // variant. Stage 1 production is always 'internal_raw' but we thread the
  // value explicitly so future sources (W15a finals, W15b external) reuse the
  // same runner with the matching variant.
  sourceType: SourceType;
}

/**
 * Run ONE Gemini 2.5 Pro call against ONE image. Identity is implicit (1 call
 * = 1 image, no stem matching). Returns either a successful classified output
 * or a per-image error captured for the audit JSON. Failover to Anthropic
 * Opus 4.7 if configured + primary fails (vendor-side error, not a credential
 * issue).
 *
 * This matches `vendor-retroactive-compare.runVendorOnComposition` verbatim
 * — that pattern has shipped 42/42 perfect Saladine results across iter-1
 * through iter-5b.
 */
async function runStage1PerImage(opts: RunStage1PerImageOpts): Promise<PerImageResult> {
  const start = Date.now();
  const { composition, settings, previewsBase } = opts;

  // Fetch the single preview.
  const path = `${previewsBase}/${composition.stem}.jpg`;
  let preview: { data: string; media_type: string };
  try {
    preview = await fetchPreviewBase64(path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      group_id: composition.group_id,
      stem: composition.stem,
      output: null,
      error: `preview_fetch_failed: ${msg}`,
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

  // W11.6.14: derive per-image EXIF context from the composition row's
  // exif_metadata JSONB (populated at Pass 0, surfaced via W11.6.7 P1-4).
  // Pass 0 keys the JSONB by stem; the value is the full ExifSignals
  // object. Map the load-bearing fields onto ExifContextOpts; missing
  // fields render as graceful "unknown" fallbacks so the prompt is never
  // broken by absent metadata.
  const exifRaw = composition.exif_metadata && typeof composition.exif_metadata === 'object'
    ? (composition.exif_metadata[composition.stem] as Record<string, unknown> | undefined) ?? null
    : null;
  const exifOpts: ExifContextOpts = exifRaw
    ? {
        cameraModel: typeof exifRaw.cameraModel === 'string' ? exifRaw.cameraModel : null,
        focalLengthMm: typeof exifRaw.focalLength === 'number' ? exifRaw.focalLength : null,
        aperture: typeof exifRaw.aperture === 'number' ? exifRaw.aperture : null,
        shutterSpeed: typeof exifRaw.shutterSpeed === 'string' ? exifRaw.shutterSpeed : null,
        iso: typeof exifRaw.iso === 'number' ? exifRaw.iso : null,
        aebBracketValue: typeof exifRaw.aebBracketValue === 'number' ? exifRaw.aebBracketValue : null,
        motionBlurRisk: exifRaw.motionBlurRisk === true,
        highIsoRisk: exifRaw.highIsoRisk === true,
      }
    : {};
  const exifText = exifContextBlock(exifOpts);
  const userText = [
    opts.userTextPrefix,
    '',
    exifText,
    '',
    opts.userTextSuffix,
  ].join('\n');

  // Single-image vision call. Schema returns the per-image object directly.
  // W11.7.17: swapped legacy STAGE1_RESPONSE_SCHEMA for v2 universal schema.
  // W11.7.17 hotfix-4: pick the per-source schema variant matching this
  // round's source_type. The single-schema universal contract had all 4
  // *_specific blocks declared at once, which blew Gemini's responseSchema
  // FSM state-count limit ("too many states for serving"). Per-source
  // variants ship only the relevant *_specific block, keeping the FSM
  // state count well under the serving ceiling.
  const baseReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model: PRIMARY_MODEL,
    tool_name: UNIVERSAL_VISION_RESPONSE_TOOL_NAME,
    tool_input_schema: universalSchemaForSource(opts.sourceType),
    system: opts.systemText,
    user_text: userText,
    images: [{
      source_type: 'base64',
      media_type: preview.media_type,
      data: preview.data,
    }],
    max_output_tokens: settings.stage1_max_output_tokens,
    temperature: 0,
    thinking_budget: settings.stage1_thinking_budget,
    timeout_ms: STAGE1_DEFAULT_TIMEOUT_MS,
  };

  // W11.8.1: Anthropic failover removed. Gemini errors fail LOUD — the
  // per-image error string is captured + propagated to engine_run_audit and
  // the audit JSON. If all images fail, runShapeDStage1Core throws and the
  // round status flips to 'failed' (engine_run_audit.error_summary populated).
  // Future Gemini regressions surface as a real failure instead of a silent
  // 12× cost spike on Anthropic Opus 4.7 (W15a smoke prior to hotfix-3/4).
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
      group_id: composition.group_id,
      stem: composition.stem,
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

  // resp.output IS the per-image classification — no per_image[] unwrap.
  // Token attribution: pull straight from the adapter's usage envelope.
  // Defensive coercion in case the adapter omits the fields.
  const inT = typeof resp.usage.input_tokens === 'number' ? resp.usage.input_tokens : 0;
  const outT = typeof resp.usage.output_tokens === 'number' ? resp.usage.output_tokens : 0;
  return {
    group_id: composition.group_id,
    stem: composition.stem,
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

interface PersistOneArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  projectId: string;
  result: PerImageResult;
  promptBlockVersions: Record<string, string>;
  modelVersion: string;
  /** Wave 11.6.7 P1-4: composition row (carries exif_metadata for lens_class). */
  composition: CompositionRow;
  /** Wave 11.6.18: active tier_config row (signal_weights drives the W11
   *  per-signal weighted rollup). Null when no active config is resolvable;
   *  persist falls back to the legacy 4-axis hardcoded blend. */
  tierConfig: TierConfigRow | null;
  /** Wave 11.7.17 (v2): the source_type of THIS round (drives prompt
   *  dimorphism and which *_specific JSONB block we expect populated).
   *  Persisted to composition_classifications.source_type for downstream
   *  routing (W15a/b/c dashboards, finals QA, competitor analysis). */
  sourceType: SourceType;
  warnings: string[];
}

/**
 * Persist ONE successful per-image classification immediately on completion.
 * No batch barrier — successes land in the DB as soon as they arrive. This
 * matches the harness pattern and means a partial round still surfaces real
 * data to the swimlane UI.
 */
export async function persistOneClassification(args: PersistOneArgs): Promise<void> {
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
  // Wave 11.6.16: int = num truncated. retouch_estimate_minutes is INTEGER.
  const int = (v: unknown): number | null => {
    const n = num(v);
    return n == null ? null : Math.trunc(n);
  };
  // Wave 11.6.16: boolNullable preserves null/undefined as null instead of
  // forcing to false — used for iter-5 fields where the model may genuinely
  // omit a value, and forcing false would write a misleading "not flagged
  // for review" row.
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

  // ─── W11.7.17 hotfix: quality_flags v2-nested read ─────────────────────────
  // v2 universal schema (W11.7.17) nests quality fields under
  // `out.quality_flags.{flag_for_retouching, clutter_severity, clutter_detail,
  // is_near_duplicate_candidate}`. The pre-cutover persist read these from the
  // top level (v1 shape). Read from the v2 nested object first, fall back to
  // top-level for backwards compatibility with any pre-v2 traffic still in
  // flight (legacy engine_modes, replay tests, etc.).
  const qualityFlagsRaw = (out.quality_flags && typeof out.quality_flags === 'object')
    ? out.quality_flags as Record<string, unknown>
    : {};
  const flagForRetouchingRaw = qualityFlagsRaw.flag_for_retouching ?? out.flag_for_retouching;
  const clutterSeverityRaw = qualityFlagsRaw.clutter_severity ?? out.clutter_severity;
  const clutterDetailRaw = qualityFlagsRaw.clutter_detail ?? out.clutter_detail;

  const roomType = str(out.room_type);
  const vantage = str(out.vantage_point);
  const eligibleExtRear = roomType === 'alfresco' && vantage === 'exterior_looking_in';

  // clutter_severity must be one of the 4 enum values; coerce defensively.
  const clutterRawStr = str(clutterSeverityRaw);
  const clutter = clutterRawStr && ['none', 'minor_photoshoppable', 'moderate_retouch', 'major_reject']
    .includes(clutterRawStr)
    ? clutterRawStr
    : null;
  // flag_for_retouching: prefer the explicit boolean from the model; fall back
  // to the clutter-severity heuristic when the model didn't emit a flag (defensive
  // null → false coercion via bool()).
  const flagForRetouching = flagForRetouchingRaw == null
    ? (clutter === 'minor_photoshoppable' || clutter === 'moderate_retouch')
    : bool(flagForRetouchingRaw);

  // vantage_point CHECK constraint accepts only 3 values; coerce others to null.
  const vantageColumn = vantage && ['interior_looking_out', 'exterior_looking_in', 'neutral']
    .includes(vantage)
    ? vantage
    : null;

  // W11.6.7 P1-4: derive lens_class from EXIF + Pass 1's is_drone flag.
  // exif_metadata is keyed by stem; pull the best_bracket_stem (or the first
  // available if best is missing).
  const exifMap = (args.composition.exif_metadata || {}) as Record<string, unknown>;
  const bestStem = args.composition.best_bracket_stem
    || args.composition.delivery_reference_stem
    || Object.keys(exifMap)[0]
    || null;
  const exifEntry = bestStem ? (exifMap[bestStem] as Record<string, unknown> | undefined) : undefined;
  const focalRaw = exifEntry?.focalLength;
  const lensModelRaw = exifEntry?.lensModel;
  const cameraModelRaw = exifEntry?.cameraModel;
  const cameraMakeRaw = exifEntry?.cameraMake;
  const lensClass = deriveLensClass(
    {
      focalLength: typeof focalRaw === 'number' ? focalRaw : null,
      lensModel: typeof lensModelRaw === 'string' ? lensModelRaw : null,
      cameraModel: typeof cameraModelRaw === 'string' ? cameraModelRaw : null,
      cameraMake: typeof cameraMakeRaw === 'string' ? cameraMakeRaw : null,
    },
    { isDrone: bool(out.is_drone) },
  );

  // W11.6.13 — orthogonal SPACE/ZONE separation. Both are emitted by
  // Stage 1 alongside the legacy room_type compatibility alias. The
  // space_zone_count is optional but persisted when the model emits it.
  const spaceType = str(out.space_type);
  const zoneFocus = str(out.zone_focus);
  const spaceZoneCountRaw = out.space_zone_count;
  const spaceZoneCount = typeof spaceZoneCountRaw === 'number' && Number.isFinite(spaceZoneCountRaw)
    ? Math.trunc(spaceZoneCountRaw)
    : (typeof spaceZoneCountRaw === 'string' && /^-?\d+$/.test(spaceZoneCountRaw)
        ? parseInt(spaceZoneCountRaw, 10)
        : null);

  // W11.2 — per-signal 0-10 scores. The 22 canonical keys live in
  // STAGE1_SIGNAL_KEYS (stage1ResponseSchema.ts); the schema requires the
  // model emits all 22, but persistence is graceful — missing/malformed
  // signal_scores land as null and the W8 tier-config formula falls back to
  // the aggregate axis score. Old engine_modes pre-W11.2 didn't emit it,
  // so the persist must NOT fail on legacy traffic.
  const sigNormResult = normaliseSignalScores(out.signal_scores, {
    groupId: args.result.group_id,
    stem: args.result.stem,
  });
  const signalScores = sigNormResult.signalScores;
  if (sigNormResult.warning) {
    args.warnings.push(sigNormResult.warning);
  }

  // ─── W11.7.17 hotfix: 4-axis aggregates + combined_score from rollup ───────
  // Per W11.7.17 spec §6 (dimensionRollup.ts header): the 4 backwards-compat
  // dimension scores AND combined_score are now COMPUTED VIEWS over the 26
  // signal scores, NOT authoritative model output. Pre-cutover persist used
  // the model's top-level technical_score etc. directly + selectCombinedScore;
  // that path produced combined_score=0 for Rainbow Cres because the active
  // tier_config.signal_weights had legacy 4-key dimension-name aliases
  // (vantage_point, clutter_severity, living_zone_count,
  // indoor_outdoor_connection_quality) that don't exist in the v2 26-signal
  // map — selectCombinedScore's `?? 0` fallback for missing scores summed to 0.
  //
  // Fix: compute aggregates from signal_scores via computeAggregateScores.
  // Pass tier_config.signal_weights ONLY when at least one weight key
  // overlaps the canonical v2 26-signal set; otherwise pass null and the
  // helper produces a uniform mean of present signals (the W11.7.17 default).
  // dimension_weights are passed through as-is (the standard 0.25/0.30/0.25/0.20
  // blend from mig 344 → DEFAULT_DIMENSION_WEIGHTS fallback in scoreRollup.ts).
  const sigW = args.tierConfig?.signal_weights ?? null;
  const v2Keys = new Set<string>(UNIVERSAL_SIGNAL_KEYS);
  const sigWHasV2Overlap = sigW && typeof sigW === 'object'
    && Object.keys(sigW).some((k) => v2Keys.has(k));
  const usableSigWeights = sigWHasV2Overlap ? sigW : null;
  const dimWeights = (args.tierConfig?.dimension_weights
    && typeof args.tierConfig.dimension_weights === 'object')
    ? args.tierConfig.dimension_weights as Record<string, number>
    : null;

  const aggregates = computeAggregateScores(
    signalScores ?? {},
    usableSigWeights,
    dimWeights,
  );

  // Prefer rollup-computed aggregates; fall back to model-emitted top-level
  // dim scores when the rollup yields null for that dimension (no signals
  // present — e.g. floorplan composition_*, RAW exposure_balance edge case).
  const techScore = aggregates.technical ?? num(out.technical_score);
  const lightScore = aggregates.lighting ?? num(out.lighting_score);
  const compScore = aggregates.composition ?? num(out.composition_score);
  const aesScore = aggregates.aesthetic ?? num(out.aesthetic_score);

  // combined_score: prefer rollup output; fall back to legacy 4-axis blend
  // via selectCombinedScore when rollup is null (all signals missing).
  const combined = aggregates.combined ?? selectCombinedScore({
    dimensionScores: {
      technical: techScore,
      lighting: lightScore,
      composition: compScore,
      aesthetic: aesScore,
    },
    signalScores,
    tierConfig: args.tierConfig,
  });

  const row: Record<string, unknown> = {
    group_id: args.result.group_id,
    round_id: args.roundId,
    project_id: args.projectId,
    analysis: str(out.analysis),
    room_type: roomType,
    room_type_confidence: num(out.room_type_confidence),
    // W11.6.13 — new orthogonal fields. Always written, even when
    // null, so downstream readers get an explicit "absent" signal
    // rather than a missing column.
    space_type: spaceType,
    zone_focus: zoneFocus,
    space_zone_count: spaceZoneCount,
    composition_type: str(out.composition_type),
    vantage_point: vantageColumn,
    time_of_day: str(out.time_of_day),
    is_drone: bool(out.is_drone),
    is_exterior: bool(out.is_exterior),
    is_detail_shot: bool(out.is_detail_shot),
    zones_visible: arr(out.zones_visible),
    key_elements: arr(out.key_elements),
    is_styled: bool(out.is_styled),
    indoor_outdoor_visible: bool(out.indoor_outdoor_visible),
    clutter_severity: clutter,
    clutter_detail: str(clutterDetailRaw),
    flag_for_retouching: flagForRetouching,
    technical_score: techScore,
    lighting_score: lightScore,
    composition_score: compScore,
    aesthetic_score: aesScore,
    combined_score: combined,
    // W11.2 — 22-key per-signal granularity. The 4 aggregate axis scores
    // above remain authoritative; signal_scores is additional granularity
    // for the W8 tier-config tuning UI + W11.6 dashboard.
    signal_scores: signalScores,
    eligible_for_exterior_rear: eligibleExtRear,
    is_near_duplicate_candidate: false,
    lens_class: lensClass, // W11.6.7 P1-4
    model_version: args.modelVersion,
    prompt_block_versions: args.promptBlockVersions,
    // ─── Wave 11.6.16: iter-5 enrichment persistence ─────────────────────
    // Stage 1 has been emitting these 17 fields since iter-5 shipped but the
    // persist layer was silently discarding them. Mig 396 added the columns;
    // this block writes them. listing_copy is a nested {headline, paragraphs}
    // object — flattened defensively (fall back to top-level if Gemini ever
    // drops the nesting). confidence_per_field is JSONB — accept the object
    // as-is when emitted, else null.
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
    // schema_version + source_type tag every row with the v2 discriminator.
    // image_type captures the 11-option taxonomy (Q1 binding).
    // observed_objects[] / observed_attributes[] feed W12 registries; each
    // observed_object has bounding_box populated by default (Q3 binding).
    // The 4 *_specific JSONB blocks are nullable — only ONE is populated
    // per row, gated by the round's source_type. The persist filters
    // defensively so a model that emits the wrong *_specific block for a
    // given source still lands clean (we accept what the model emits).
    schema_version: 'v2.0',
    source_type: args.sourceType,
    image_type: str(out.image_type),
    observed_objects: extractObservedObjects(out.observed_objects),
    observed_attributes: extractObservedAttributes(out.observed_attributes),
    raw_specific: extractObjectOrNull(out.raw_specific),
    finals_specific: extractObjectOrNull(out.finals_specific),
    external_specific: extractObjectOrNull(out.external_specific),
    floorplan_specific: extractObjectOrNull(out.floorplan_specific),
  };

  // Use upsert on the unique (group_id) constraint so retries replace rather
  // than fail.
  const { error: insErr } = await args.admin
    .from('composition_classifications')
    .upsert(row, { onConflict: 'group_id' });
  if (insErr) {
    args.warnings.push(`classification upsert failed for ${args.result.group_id}: ${insErr.message}`);
  }
}

// ─── Wave 11.7.17 v2 schema persist helpers ────────────────────────────────

/**
 * Defensively extract a JSONB-ready object or null from a model emission.
 * The v2 *_specific blocks (raw_specific, finals_specific, external_specific,
 * floorplan_specific) are nullable per source — the model is instructed to
 * leave 3 of them as null and populate only the one matching its source_type.
 *
 * Returns the object as-is when truthy + plain object; returns null otherwise
 * (covers undefined, null, primitive, array, or wrong type). The DB column
 * is JSONB nullable, so `null` lands cleanly.
 */
function extractObjectOrNull(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

/**
 * Extract observed_objects[] from a model emission. Each entry is required
 * to have bounding_box populated (Q3 binding default ON), but persist is
 * graceful — entries without bounding_box still land (we don't drop them),
 * and entries that aren't plain objects are filtered out.
 *
 * The schema requires bounding_box; the model's responseSchema enforces it.
 * If a future model regression drops bounding_box on some entries, we
 * persist the entry as-is so downstream UIs can still render the raw_label
 * without the overlay rectangle.
 */
function extractObservedObjects(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
}

/**
 * Extract observed_attributes[] from a model emission. Each entry is a
 * { raw_label, canonical_attribute_id?, canonical_value_id?, confidence,
 * object_anchor? } object. Filters non-object entries.
 */
function extractObservedAttributes(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  return v
    .filter((entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
}

// ─── engine_run_audit upsert ─────────────────────────────────────────────────

export interface UpsertEngineRunAuditArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  engineMode: string;
  // W11.8.1: vendor narrowed to 'google'. failoverTriggered + failoverReason
  // remain on the args shape so engine_run_audit columns continue to be
  // written (admin dashboards read them). Both are always false/null now.
  vendorUsed: 'google';
  modelUsed: string;
  failoverTriggered: boolean;
  failoverReason: string | null;
  stage1CallCount: number;
  stage1TotalCostUsd: number;
  stage1TotalWallMs: number;
  stage1TotalInputTokens: number;
  stage1TotalOutputTokens: number;
  stages_completed: string[];
  stages_failed: string[];
  retry_count: number;
  warnings: string[];
}

export async function upsertEngineRunAudit(args: UpsertEngineRunAuditArgs): Promise<void> {
  // W11.7.17 hotfix-2 (Fix B): also pull stage4_* + total_input/output_tokens
  // so a Stage 1 retry doesn't blow away an already-landed Stage 4 contribution
  // to total_cost_usd / total_wall_ms / total_*_tokens (Rainbow Cres c55374b1
  // showed total_cost_usd=35.8169 == stage1 only despite stage4_total=1.4372
  // because Stage 1 retried after Stage 4 landed and overwrote total_cost_usd
  // with stage1-only). The cost-per-stage dashboard reads total_cost_usd —
  // sparse / under-counted dashboards trace back to this overwrite.
  //
  // NOTE: keep this select as a SINGLE string literal — Postgrest's TS type
  // inference parses the literal at compile time; splitting across `+`
  // concatenated strings collapses the inferred type to GenericStringError
  // and breaks strict TS check on the field accessors below.
  const { data: existing } = await args.admin
    .from('engine_run_audit')
    .select('stage1_total_cost_usd, stage1_total_wall_ms, stage1_call_count, stage1_total_input_tokens, stage1_total_output_tokens, stage4_total_cost_usd, stage4_total_wall_ms, stage4_total_input_tokens, stage4_total_output_tokens, stages_completed, stages_failed, retry_count, failover_triggered')
    .eq('round_id', args.roundId)
    .maybeSingle();

  const priorCost = (existing?.stage1_total_cost_usd as number | null) ?? 0;
  const priorWall = (existing?.stage1_total_wall_ms as number | null) ?? 0;
  const priorCalls = (existing?.stage1_call_count as number | null) ?? 0;
  const priorInputTokens = (existing?.stage1_total_input_tokens as number | null) ?? 0;
  const priorOutputTokens = (existing?.stage1_total_output_tokens as number | null) ?? 0;
  const priorStage4Cost = (existing?.stage4_total_cost_usd as number | null) ?? 0;
  const priorStage4Wall = (existing?.stage4_total_wall_ms as number | null) ?? 0;
  const priorStage4InputTokens = (existing?.stage4_total_input_tokens as number | null) ?? 0;
  const priorStage4OutputTokens = (existing?.stage4_total_output_tokens as number | null) ?? 0;
  const priorStagesCompleted = (existing?.stages_completed as string[] | null) ?? [];
  const priorRetry = (existing?.retry_count as number | null) ?? 0;

  const accumulatedCost = priorCost + args.stage1TotalCostUsd;
  const accumulatedRounded = Math.round(accumulatedCost * 1_000_000) / 1_000_000;
  const accumulatedWall = Math.max(priorWall, args.stage1TotalWallMs);
  // Tokens accumulate the same way as cost — retries add to the row's
  // running total. The W11.6 cost-per-stage dashboard reads this as the
  // canonical Stage 1 token count.
  const accumulatedInputTokens = priorInputTokens + args.stage1TotalInputTokens;
  const accumulatedOutputTokens = priorOutputTokens + args.stage1TotalOutputTokens;
  const merged = Array.from(new Set([...priorStagesCompleted, ...args.stages_completed]));

  // total_* must include any Stage 4 contribution that already landed —
  // otherwise a Stage 1 retry that runs after Stage 4 silently zeros out
  // stage4 in the dashboard's total_cost_usd column.
  const totalCost = accumulatedCost + priorStage4Cost;
  const totalCostRounded = Math.round(totalCost * 1_000_000) / 1_000_000;
  const totalWall = accumulatedWall + priorStage4Wall;
  const totalInputTokens = accumulatedInputTokens + priorStage4InputTokens;
  const totalOutputTokens = accumulatedOutputTokens + priorStage4OutputTokens;

  const row: Record<string, unknown> = {
    round_id: args.roundId,
    engine_mode: args.engineMode,
    vendor_used: args.vendorUsed,
    model_used: args.modelUsed,
    failover_triggered: args.failoverTriggered || (existing?.failover_triggered === true),
    failover_reason: args.failoverReason ?? null,
    stages_completed: merged,
    stages_failed: args.stages_failed,
    stage1_call_count: Math.max(priorCalls, args.stage1CallCount),
    stage1_total_cost_usd: accumulatedRounded,
    stage1_total_wall_ms: accumulatedWall,
    stage1_total_input_tokens: accumulatedInputTokens,
    stage1_total_output_tokens: accumulatedOutputTokens,
    total_cost_usd: totalCostRounded,
    total_wall_ms: totalWall,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    retry_count: priorRetry + (args.retry_count || 0),
  };

  // engine_run_audit PK is round_id; upsert on conflict by PK.
  const { error } = await args.admin
    .from('engine_run_audit')
    .upsert(row, { onConflict: 'round_id' });
  if (error) {
    // W11.7.17 hotfix-2 (Fix B): also emit to stdout so the failure shows up
    // in `supabase functions logs` — previously the warning only landed in
    // the Dropbox audit JSON, masking sparse audit-table failures from QC.
    const msg = `engine_run_audit upsert failed: ${error.message}`;
    args.warnings.push(msg);
    console.warn(`[${GENERATOR}] ${msg} (round=${args.roundId})`);
    return;
  }
  console.log(
    `[${GENERATOR}] engine_run_audit upsert ok round=${args.roundId} ` +
    `stage1_cost=${accumulatedRounded} total_cost=${totalCostRounded} ` +
    `stages_completed=[${merged.join(',')}]`,
  );
}

// ─── Audit JSON → Dropbox ────────────────────────────────────────────────────

interface AuditJsonArgs {
  ctx: RoundContext;
  roundId: string;
  finalEngineMode: string;
  perImageResults: PerImageResult[];
  compositions: CompositionRow[];
  groupsToRun: CompositionRow[];
  persisted: number;
  voice: VoiceAnchorOpts;
  sourceType: SourceType;
  settings: EngineSettings;
  startedAt: number;
  warnings: string[];
}

async function uploadStage1AuditJson(args: AuditJsonArgs): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').replace('Z', '');
  const path = `${args.ctx.dropbox_root_path.replace(/\/+$/, '')}/Photos/_AUDIT/round_${args.roundId}_stage1_${ts}.json`;
  const successes = args.perImageResults.filter((r) => r.output);
  const failures = args.perImageResults.filter((r) => !r.output);
  const audit = {
    version: 'v1.1-per-image',
    generator: GENERATOR,
    round_id: args.roundId,
    project_id: args.ctx.project_id,
    started_at: new Date(args.startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    engine_mode: args.finalEngineMode,
    property_tier: args.voice.tier,
    property_voice_anchor_override: args.voice.override,
    source_type: args.sourceType,
    settings: {
      stage1_thinking_budget: args.settings.stage1_thinking_budget,
      stage1_max_output_tokens: args.settings.stage1_max_output_tokens,
      production_vendor: args.settings.production_vendor,
      // W11.8.1: failover_vendor stripped — emitted as null for backward-compat
      // with any audit-JSON consumer that grepped for the field.
      failover_vendor: null,
    },
    prompt_block_versions: stage1PromptBlockVersions(),
    compositions_total: args.compositions.length,
    compositions_persisted: args.persisted,
    compositions_run_this_invocation: args.groupsToRun.length,
    per_image_calls_run: args.perImageResults.length,
    success_count: successes.length,
    failure_count: failures.length,
    failover_triggered: args.perImageResults.some((r) => r.failover_triggered),
    total_cost_usd: Number(
      args.perImageResults.reduce((sum, r) => sum + r.cost_usd, 0).toFixed(6),
    ),
    total_api_wall_ms: args.perImageResults.reduce((sum, r) => sum + r.wall_ms, 0),
    operator_wall_ms: Date.now() - args.startedAt,
    // W11.5/11.7 closed-loop: per-stage token attribution. Sum across all
    // per-image calls in this invocation. Matches engine_run_audit.
    total_input_tokens: args.perImageResults.reduce((sum, r) => sum + (r.input_tokens || 0), 0),
    total_output_tokens: args.perImageResults.reduce((sum, r) => sum + (r.output_tokens || 0), 0),
    failures: failures.map((f) => ({
      stem: f.stem,
      group_id: f.group_id,
      error: f.error,
      vendor_used: f.vendor_used,
      model_used: f.model_used,
    })),
    warnings: args.warnings,
  };
  const json = JSON.stringify(audit, null, 2);
  try {
    await uploadFile(path, json, 'overwrite');
    return path;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('path/not_found') || msg.includes('not_found')) {
      try {
        const auditDir = `${args.ctx.dropbox_root_path.replace(/\/+$/, '')}/Photos/_AUDIT`;
        await createFolder(auditDir);
        await uploadFile(path, json, 'overwrite');
        return path;
      } catch (retryErr) {
        const m = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[${GENERATOR}] audit JSON upload retry failed: ${m}`);
        return null;
      }
    }
    console.warn(`[${GENERATOR}] audit JSON upload failed: ${msg}`);
    return null;
  }
}

// ─── Stage 4 dispatch ────────────────────────────────────────────────────────

interface DispatchStage4JobArgs {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  warnings: string[];
}

async function dispatchStage4Job(args: DispatchStage4JobArgs): Promise<string | null> {
  // Idempotency: skip if a non-terminal stage4_synthesis job already exists
  // for this round. The unique partial index (mig 377) also enforces this at
  // the DB layer; the explicit check just avoids the noisy unique-violation
  // log.
  const { count: existing } = await args.admin
    .from('shortlisting_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('round_id', args.roundId)
    .eq('kind', 'stage4_synthesis')
    .in('status', ['pending', 'running', 'succeeded']);
  if ((existing ?? 0) > 0) {
    console.log(
      `[${GENERATOR}] stage4_synthesis job already exists for round ${args.roundId} — skipping insert`,
    );
    return null;
  }

  const { data, error } = await args.admin
    .from('shortlisting_jobs')
    .insert({
      project_id: args.projectId,
      round_id: args.roundId,
      group_id: null,
      kind: 'stage4_synthesis',
      status: 'pending',
      payload: {
        project_id: args.projectId,
        round_id: args.roundId,
        chained_from: 'shortlisting-shape-d',
      },
      scheduled_for: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();
  if (error) {
    args.warnings.push(`stage4_synthesis dispatch failed: ${error.message}`);
    return null;
  }
  console.log(`[${GENERATOR}] dispatched stage4_synthesis job ${data?.id} for round ${args.roundId}`);
  return (data?.id as string) || null;
}

// ─── canonical-rollup dispatch (Wave 12) ─────────────────────────────────────

async function dispatchCanonicalRollupJob(
  args: DispatchStage4JobArgs,
): Promise<string | null> {
  // Idempotency mirror of dispatchStage4Job: skip if a non-terminal (or already
  // succeeded) canonical_rollup row exists for this round. The mig 380 unique
  // partial index uniq_shortlisting_jobs_active_pass_per_round (extended with
  // 'canonical_rollup') enforces this at the DB layer too — the explicit check
  // just avoids the unique-violation log noise on retry / replay paths.
  const { count: existing } = await args.admin
    .from('shortlisting_jobs')
    .select('id', { count: 'exact', head: true })
    .eq('round_id', args.roundId)
    .eq('kind', 'canonical_rollup')
    .in('status', ['pending', 'running', 'succeeded']);
  if ((existing ?? 0) > 0) {
    console.log(
      `[${GENERATOR}] canonical_rollup job already exists for round ${args.roundId} — skipping insert`,
    );
    return null;
  }

  const { data, error } = await args.admin
    .from('shortlisting_jobs')
    .insert({
      project_id: args.projectId,
      round_id: args.roundId,
      group_id: null,
      kind: 'canonical_rollup',
      status: 'pending',
      payload: {
        project_id: args.projectId,
        round_id: args.roundId,
        chained_from: 'shortlisting-shape-d',
      },
      scheduled_for: new Date().toISOString(),
    })
    .select('id')
    .maybeSingle();
  if (error) {
    // Don't fail Stage 1 if rollup dispatch fails — rollup is a hygiene/
    // observability sidecar, not part of the user-visible shortlisting pipeline.
    // Surface in warnings so the operator dashboard sees it.
    args.warnings.push(`canonical_rollup dispatch failed: ${error.message}`);
    return null;
  }
  console.log(
    `[${GENERATOR}] dispatched canonical_rollup job ${data?.id} for round ${args.roundId}`,
  );
  return (data?.id as string) || null;
}

// ─── Dropbox preview helper ─────────────────────────────────────────────────

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
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + CHUNK)));
  }
  const data = btoa(bin);
  return { data, media_type: 'image/jpeg' };
}

// ─── Prompt-block version map (persisted with each classification) ──────────

function stage1PromptBlockVersions(): Record<string, string> {
  return {
    // W11.7.17 — replaces stage1_response_schema with the v2 universal
    // schema + adds signal_measurement (source-aware 26-signal prompts).
    universal_vision_response_schema: UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION,
    signal_measurement: SIGNAL_MEASUREMENT_BLOCK_VERSION,
    source_context: SOURCE_CONTEXT_BLOCK_VERSION,
    photographer_techniques: PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION,
    exif_context: EXIF_CONTEXT_BLOCK_VERSION,
    voice_anchor: VOICE_ANCHOR_BLOCK_VERSION,
    sydney_primer: SYDNEY_PRIMER_BLOCK_VERSION,
    self_critique: SELF_CRITIQUE_BLOCK_VERSION,
    // Wave 11.5/11.7 closed-loop blocks. These versions are persisted to
    // composition_classifications.prompt_block_versions on every successful
    // Stage 1 row, and SHOULD also flow to engine_run_audit.prompt_block_versions
    // — Agent 1 hasn't plumbed that column yet (mig 376 covers the table; the
    // column itself is a future extension). When that column lands, populate
    // it from this same map at the engine_run_audit upsert site.
    // TODO(closed-loop): wire this map into engine_run_audit.prompt_block_versions
    // once Agent 1 ships the column on engine_run_audit.
    project_memory: PROJECT_MEMORY_BLOCK_VERSION,
    few_shot_library: FEW_SHOT_LIBRARY_BLOCK_VERSION,
    canonical_registry: CANONICAL_REGISTRY_BLOCK_VERSION,
  };
}

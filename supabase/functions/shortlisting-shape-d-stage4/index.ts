/**
 * shortlisting-shape-d-stage4
 * ───────────────────────────
 * Wave 11.7.1 — production Shape D Stage 4 visual master synthesis worker.
 *
 * Triggered by the dispatcher consuming `shortlisting_jobs` rows of kind
 * `stage4_synthesis`. Single Gemini 2.5 Pro visual call seeing ALL images +
 * Stage 1 JSON as text context. thinkingBudget=16384, max_output_tokens=16000,
 * timeout=240s.
 *
 * Spec: docs/design-specs/W11-7-unified-shortlisting-architecture.md
 *       docs/design-specs/W11-7-7-master-listing-copy.md
 *
 * ─── INPUT MODES ──────────────────────────────────────────────────────────────
 *
 *   { round_id }   — direct invocation
 *   { job_id }     — dispatcher path
 *   { _health_check: true } → 200 with version stamp
 *
 * ─── PERSISTENCE ──────────────────────────────────────────────────────────────
 *
 *   - shortlisting_master_listings: full master_listing JSON + property_tier
 *     + voice_anchor_used + word_count + reading_grade + vendor + model.
 *   - shortlisting_rounds: gallery_sequence, dedup_groups,
 *     missing_shot_recommendations, narrative_arc_score,
 *     property_archetype_consensus, overall_property_score,
 *     stage_4_completed_at, stage_4_cost_usd.
 *   - composition_classification_overrides: stage_4_overrides[] entries with
 *     override_source='stage4_visual_override'.
 *   - shortlisting_stage4_overrides: same data dual-written for the Stage 4
 *     audit table (W11.7 mig 371).
 *   - engine_run_audit: stages_completed += ['stage4'], total_cost_usd,
 *     completed_at, stage4_total_*.
 *   - Photos/_AUDIT/round_<id>_stage4_<ts>.json (full Stage 4 output dump).
 *
 * ─── ROUND STATUS ─────────────────────────────────────────────────────────────
 *
 * On Stage 4 success, the round transitions away from 'processing'. The pass2
 * legacy fn moves rounds to status='proposed' (its terminal state before
 * human review). Shape D matches: Stage 4 success → status='proposed' so the
 * downstream UI (swimlane, lock review) sees rounds the same way.
 *
 * ─── FAILURE MODE (W11.8.1) ───────────────────────────────────────────────────
 *
 * Gemini Stage 4 fails after 3 retries → throw VendorCallError. The Anthropic
 * Opus 4.7 failover code path was stripped in W11.8.1 (Joseph: "i don't want
 * any automatic switches to anthropic at all"). A regression here surfaces as
 * status='failed' on the round and a populated engine_run_audit.error_summary
 * — no silent ~12× cost shift to Anthropic. Re-trigger the round once Gemini
 * health is verified.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
  getUserFromReq,
  serveWithAudit,
  getAdminClient,
  callerHasProjectAccess,
  fireNotif,
} from '../_shared/supabase.ts';
import { validateSlotConstraints, type SlotDefinitionConstraints, type ClassificationContext } from '../_shared/slotConstraintValidator.ts';
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
  exifContextTable,
  EXIF_CONTEXT_BLOCK_VERSION,
  type ExifTableRow,
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
import {
  STAGE4_TOOL_NAME,
  STAGE4_TOOL_SCHEMA,
  STAGE4_PROMPT_VERSION,
  buildStage4SystemPrompt,
  buildStage4UserPrompt,
  type PropertyFacts,
  type Stage1MergedEntry,
  type SpaceInstanceSummary,
} from './stage4Prompt.ts';
import {
  canonicalRegistryBlock,
  CANONICAL_REGISTRY_BLOCK_VERSION,
} from '../_shared/visionPrompts/blocks/canonicalRegistryBlock.ts';
import {
  normaliseSlotId,
  SLOT_ENUMERATION_BLOCK_VERSION,
  // QC-iter2-W3 F-D-007: actually USE the block (was imported for the audit
  // version map only; the rendered text was never injected into Stage 4's
  // prompt — model was picking slots blind beyond the enum constraint).
  slotEnumerationBlock,
} from '../_shared/visionPrompts/blocks/slotEnumeration.ts';
import {
  resolveProjectEngineRoles as resolveProjectEngineRolesPure,
} from '../_shared/projectEngineRoles.ts';
import type { ProductRow } from '../_shared/slotEligibility.ts';
import type { Pass2SlotDefinition } from '../_shared/pass2Prompt.ts';
import {
  resolveGalleryPositions,
  renderGalleryPositionsBlock,
  type ResolvedGalleryPosition,
} from '../_shared/resolveGalleryPositions.ts';
import {
  deriveRoundScope,
  HARDCODED_STANDARD_PRICE_TIER_ID,
} from '../_shared/deriveRoundScope.ts';

const GENERATOR = 'shortlisting-shape-d-stage4';

const PRIMARY_VENDOR = 'google' as const;
const PRIMARY_MODEL = 'gemini-2.5-pro';
const STAGE4_DEFAULT_THINKING_BUDGET = 16_384;
const STAGE4_DEFAULT_MAX_OUTPUT_TOKENS = 16_000;
const STAGE4_TIMEOUT_MS = 240_000; // 4 min — Stage 4 is ~60-90s + thinking
const STAGE4_RETRY_COUNT = 3;

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  _health_check?: boolean;
}

// W11.7.7 master_listing regenerate context: parsed from
// shortlisting_jobs.payload when payload.regenerate === true. Carries the
// voice tier/anchor overrides (Operator may rewrite copy with a different
// voice without re-running Stage 1) and the master_listing_id of the row to
// UPDATE in place (the regenerate-master-listing edge fn already archived
// the prior version + bumped regeneration_count synchronously; Stage 4 just
// needs to overwrite the master_listing JSONB on the same row).
interface RegenerateContext {
  /** master_listings row to UPDATE in place (preserves FK target for history). */
  masterListingIdToOverwrite: string | null;
  /** History row already inserted by regenerate-master-listing fn. We don't
   *  re-archive — defensive double-archive is OK but redundant. */
  archivedHistoryId: string | null;
  /** Optional tier override — replaces ctx.property_tier for THIS regen only. */
  voiceTierOverride: PropertyTier | null;
  /** Optional free-text voice anchor — replaces tier preset for THIS regen only. */
  voiceAnchorOverride: string | null;
  /** auth.users.id of the operator who requested the regen (optional). */
  regeneratedBy: string | null;
  /** Operator-provided context for the audit trail. */
  reason: string | null;
}

const ALLOWED_TIERS = new Set<PropertyTier>(['premium', 'standard', 'approachable']);

// Wave 11.7.1 immediate-ack contract (mirrors shortlisting-shape-d Stage 1):
// Stage 4 is typically ~70s but worst case (3 primary retries × 240s timeout)
// can exceed the 120s gateway. We adopt the same EdgeRuntime.waitUntil
// pattern: validate + mutex + cost cap synchronously, return HTTP 200 ack
// with `mode: 'background'`, and self-update the dispatching shortlisting_jobs
// row when the work completes. W11.8.1: Anthropic failover removed — primary
// exhaustion now throws and the round flips to 'failed' instead of silently
// shifting ~12× cost to Anthropic.
const BACKGROUND_MODE_RESPONSE = 'background';

interface RoundContext {
  round_id: string;
  project_id: string;
  status: string;
  property_tier: PropertyTier;
  property_voice_anchor_override: string | null;
  dropbox_root_path: string;
  property_facts: PropertyFacts;
  // QC-iter2-W3 F-D-007: round-level package info needed to render the
  // slotEnumerationBlock preamble (which the Stage 4 user prompt is now
  // wired to include). package_ceiling falls back to expected_count_target
  // when the legacy column is null.
  package_type: string;
  package_ceiling: number;
  // mig 444 fix: engine_grade_id from shortlisting_rounds — passes through
  // to deriveRoundScope() so the gallery_positions resolver can match
  // package_grade scopes. NULL for legacy rounds without an engine grade.
  engine_grade_id: string | null;
  property_address: string | null;
  // W11.6.25 — frozen slot recipe snapshot from ingest. NULL for legacy
  // rounds; Stage 4 falls back to live slot definitions in that case.
  resolved_slot_recipe: {
    entries: Array<{
      slot_id: string;
      classification: 'mandatory' | 'conditional' | 'free_recommendation';
      allocated_count: number;
      max_count: number;
      priority_rank: number;
      notes: string | null;
    }>;
    totals?: {
      mandatory: number;
      conditional: number;
      free_recommendation: number;
      total_min: number;
      total_max: number;
    };
  } | null;
}

interface EngineSettings {
  stage4_thinking_budget: number;
  stage4_max_output_tokens: number;
  // W11.8.1: failover_vendor stripped — Anthropic failover code path removed.
  cost_cap_per_round_usd: number;
}

// ─── Handler ────────────────────────────────────────────────────────────────

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

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
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  let roundId = body.round_id || null;
  const jobId = body.job_id || null;
  // Read job payload up-front so we can extract round_id AND the regenerate
  // context in one DB hit. The dispatcher invokes us with `{ job_id }` so
  // the payload (regenerate flag, voice overrides) lives in
  // shortlisting_jobs.payload — the regenerate-master-listing edge fn writes
  // it there when an operator triggers a master_listing rewrite.
  let jobPayload: Record<string, unknown> | null = null;
  if (jobId) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id, payload')
      .eq('id', jobId)
      .maybeSingle();
    if (job?.round_id && !roundId) roundId = job.round_id as string;
    jobPayload = (job?.payload as Record<string, unknown> | null) || null;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

  // Parse regenerate context from job payload. When payload.regenerate is
  // truthy, the regenerate-master-listing fn has already (a) archived the
  // prior master_listing to history and (b) bumped regeneration_count on the
  // master_listings row. Stage 4 here just needs to UPDATE that row in place
  // with the new master_listing JSON, optionally honouring tier/anchor
  // overrides. If voice_tier_override is set but not a recognised tier, we
  // warn + fall back to the round's default tier (defensive — the regen edge
  // fn already validates, but service-role callers can bypass that).
  const regenWarnings: string[] = [];
  const regenCtx: RegenerateContext | null = (jobPayload && jobPayload.regenerate === true)
    ? parseRegenerateContext(jobPayload, regenWarnings)
    : null;

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

  // Synchronous pre-flight (engine_mode gate, cost cap, mutex). Anything that
  // can fail fast surfaces as a 400 to the dispatcher BEFORE we kick the
  // bgWork — this preserves the dispatcher's retry/backoff for legitimate
  // failures like "round not in shape_d state" or "cost cap exceeded".
  let preflight: Stage4PreflightOk;
  try {
    preflight = await preflightStage4(roundId, regenCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] preflight failed for round ${roundId}: ${msg}`);
    return errorResponse(`shortlisting-shape-d-stage4 preflight failed: ${msg}`, 400, req);
  }
  // Bubble parser warnings into preflight so they reach the audit trail.
  for (const w of regenWarnings) preflight.preflightWarnings.push(w);

  const startedIso = new Date().toISOString();
  const bgWork = runStage4Background({ roundId, jobId, preflight })
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${GENERATOR}] background work failed for round ${roundId}: ${msg}`);
    });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(bgWork);

  return jsonResponse(
    {
      ok: true,
      mode: BACKGROUND_MODE_RESPONSE,
      round_id: roundId,
      job_id: jobId,
      regenerate: regenCtx !== null,
      started_at: startedIso,
    },
    200,
    req,
  );
});

/**
 * Parse + validate the regenerate context from a stage4_synthesis job's
 * payload. Returns null if `payload.regenerate` is not strictly true. Warnings
 * for invalid overrides are appended to `warnings` (non-fatal — we degrade to
 * the round's default tier).
 */
function parseRegenerateContext(
  payload: Record<string, unknown>,
  warnings: string[],
): RegenerateContext {
  const tierRaw = payload.voice_tier_override;
  let voiceTierOverride: PropertyTier | null = null;
  if (typeof tierRaw === 'string' && tierRaw.length > 0) {
    if (ALLOWED_TIERS.has(tierRaw as PropertyTier)) {
      voiceTierOverride = tierRaw as PropertyTier;
    } else {
      warnings.push(
        `regenerate: voice_tier_override='${tierRaw}' is not in {premium, standard, approachable} — ignoring, using round's default tier`,
      );
    }
  }

  const anchorRaw = payload.voice_anchor_override;
  const voiceAnchorOverride = (typeof anchorRaw === 'string' && anchorRaw.length > 0)
    ? anchorRaw
    : null;

  return {
    masterListingIdToOverwrite:
      typeof payload.master_listing_id_to_overwrite === 'string'
        ? payload.master_listing_id_to_overwrite
        : null,
    archivedHistoryId:
      typeof payload.archived_history_id === 'string'
        ? payload.archived_history_id
        : null,
    voiceTierOverride,
    voiceAnchorOverride,
    regeneratedBy:
      typeof payload.regenerated_by === 'string' ? payload.regenerated_by : null,
    reason: typeof payload.reason === 'string' ? payload.reason : null,
  };
}

// ─── Core ───────────────────────────────────────────────────────────────────

interface Stage4RunResult {
  ok: boolean;
  // W11.8.1: vendor narrowed to 'google'. failover_triggered always false
  // (kept on the shape so engine_run_audit columns continue to be written).
  vendor_used: 'google';
  model_used: string;
  cost_usd: number;
  wall_ms: number;
  failover_triggered: false;
  master_listing_id: string | null;
  stage_4_overrides_count: number;
  audit_dropbox_path: string | null;
  warnings: string[];
}

interface Stage4PreflightOk {
  ctx: RoundContext;
  settings: EngineSettings;
  voice: VoiceAnchorOpts;
  sourceType: SourceType;
  preflightWarnings: string[];
  lockName: string;
  tickId: string;
  startedAt: number;
  /** Set when this Stage 4 invocation is a master_listing regen (payload.regenerate=true). */
  regenCtx: RegenerateContext | null;
}

interface Stage4BackgroundArgs {
  roundId: string;
  jobId: string | null;
  preflight: Stage4PreflightOk;
}

/**
 * Synchronous Stage 4 pre-flight: engine-mode gate, mutex acquisition, and
 * voice/source resolution. Stage 1 merged JSON load + cost cap deferred to
 * bgWork because they only matter once we're committed (the row counts and
 * preview fetch are part of Stage 4's wall budget anyway).
 *
 * On success, the per-round mutex IS HELD — bgWork's finally must release it.
 */
async function preflightStage4(
  roundId: string,
  regenCtx: RegenerateContext | null,
): Promise<Stage4PreflightOk> {
  const startedAt = Date.now();
  const admin = getAdminClient();
  const preflightWarnings: string[] = [];

  const settings = await loadEngineSettings(admin);
  const ctx = await loadRoundContext(admin, roundId);

  const { data: roundCheck } = await admin
    .from('shortlisting_rounds')
    .select('engine_mode, status, stage_4_completed_at')
    .eq('id', roundId)
    .maybeSingle();
  const engineMode = (roundCheck?.engine_mode as string | null) || '';
  // W11.8.1: 'unified_anthropic_failover' kept as a valid pass-through here
  // for backward-compat with rounds whose engine_mode was set to that string
  // before the failover code path was removed. They still need Stage 4 to be
  // able to run on retry. New rounds will only ever land on 'shape_d_*'.
  if (!engineMode.startsWith('shape_d') && engineMode !== 'unified_anthropic_failover') {
    throw new Error(
      `round ${roundId} engine_mode='${engineMode}' — Stage 4 requires a shape_d round`,
    );
  }
  if (roundCheck?.stage_4_completed_at) {
    preflightWarnings.push(
      `round ${roundId} stage_4_completed_at=${roundCheck.stage_4_completed_at} — re-running Stage 4 (will overwrite)`,
    );
  }

  // Voice resolution. Default path: tier from round context. Regen path: if
  // payload.voice_tier_override is set + valid, it replaces the round's tier
  // for THIS Stage 4 run only (we do NOT mutate the round's property_tier;
  // operator-initiated tier changes are a separate flow). Same for
  // voice_anchor_override — replaces the tier preset block. The
  // ctx.property_voice_anchor_override remains the project default; the regen
  // override takes precedence when present.
  const effectiveTier: PropertyTier = regenCtx?.voiceTierOverride ?? ctx.property_tier;
  const effectiveAnchor: string | null =
    regenCtx?.voiceAnchorOverride ?? ctx.property_voice_anchor_override;
  const voice: VoiceAnchorOpts = {
    tier: effectiveTier,
    override: effectiveAnchor,
  };
  if (regenCtx) {
    preflightWarnings.push(
      `regenerate=true tier=${effectiveTier}${regenCtx.voiceTierOverride ? ' (override)' : ''}` +
      `${regenCtx.voiceAnchorOverride ? ' anchor_override=set' : ''}` +
      `${regenCtx.reason ? ` reason="${regenCtx.reason.slice(0, 60)}"` : ''}`,
    );
  }
  const sourceType: SourceType = 'internal_raw';

  const lockName = `shape-d-stage4:${roundId}`;
  const tickId = crypto.randomUUID();
  const acquired = await tryAcquireMutex(admin, lockName, tickId);
  if (!acquired) {
    throw new Error(`round ${roundId} Stage 4 already running (mutex held)`);
  }

  return { ctx, settings, voice, sourceType, preflightWarnings, lockName, tickId, startedAt, regenCtx };
}

/**
 * Background worker: heavy Stage 4 vision call + persistence. Self-updates
 * the dispatching shortlisting_jobs row on completion (the dispatcher saw
 * mode='background' and skipped its auto-mark). Always releases the mutex.
 */
async function runStage4Background(args: Stage4BackgroundArgs): Promise<void> {
  const admin = getAdminClient();
  const { roundId, jobId, preflight } = args;
  const { lockName, tickId } = preflight;

  try {
    const result = await runStage4Core(roundId, preflight);
    if (jobId) {
      const { error: updErr } = await admin
        .from('shortlisting_jobs')
        .update({
          status: 'succeeded',
          finished_at: new Date().toISOString(),
          error_message: null,
          result: { round_id: roundId, ...result },
        })
        .eq('id', jobId);
      if (updErr) {
        console.warn(`[${GENERATOR}] job self-update succeeded write failed: ${updErr.message}`);
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] background Stage 4 failed for round ${roundId}: ${msg}`);
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

async function runStage4Core(
  roundId: string,
  preflight: Stage4PreflightOk,
): Promise<Stage4RunResult> {
  const admin = getAdminClient();
  const { ctx, settings, voice, sourceType, startedAt, regenCtx } = preflight;
  const warnings: string[] = [...preflight.preflightWarnings];

  {
    // Load Stage 1 merged JSON from composition_classifications + groups.
    const { entries: stage1Merged, exifRows: stage1ExifRows } = await loadStage1Merged(admin, roundId);
    if (stage1Merged.length === 0) {
      throw new Error(
        `round ${roundId} has no composition_classifications — Stage 1 must succeed first`,
      );
    }

    // Cost cap pre-flight. Stage 4 envelope: ~$1.20 on Gemini. Always under
    // the default $10 cap. (W11.8.1: Anthropic failover stripped — the prior
    // ~$14.40 worst-case envelope no longer applies.)
    const preflightUsd = estimateCost('google', PRIMARY_MODEL, {
      input_tokens: 60_000 + stage1Merged.length * 1_500,
      output_tokens: settings.stage4_max_output_tokens,
      cached_input_tokens: 0,
    });
    if (preflightUsd > settings.cost_cap_per_round_usd) {
      // W11.6.8 W7.10 P1-9: fire cost_cap_exceeded BEFORE throwing so ops
      // gets the alert even though Stage 4 aborts. Routes to master_admin
      // + #engine-alerts per mig 390 seed. Fire-and-forget; the throw
      // below is the source-of-truth for the round status flip.
      try {
        await fireNotif({
          type: 'cost_cap_exceeded',
          category: 'system',
          severity: 'critical',
          title: `Stage 4 cost cap exceeded`,
          message:
            `Stage 4 pre-flight cost $${preflightUsd.toFixed(4)} exceeds cap ` +
            `$${settings.cost_cap_per_round_usd.toFixed(4)} on round ${roundId}.`,
          projectId: ctx.project_id,
          ctaLabel: 'Review engine settings',
          source: GENERATOR,
          idempotencyKey: `cost-cap-exceeded-${roundId}`,
        });
      } catch (notifErr) {
        const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
        console.warn(`[${GENERATOR}] cost_cap_exceeded notification fire failed: ${msg}`);
      }
      throw new Error(
        `Stage 4 pre-flight cost $${preflightUsd.toFixed(4)} exceeds cap ` +
        `$${settings.cost_cap_per_round_usd.toFixed(4)}`,
      );
    }

    // Fetch all preview images for the round.
    const previewsBase = `${ctx.dropbox_root_path.replace(/\/+$/, '')}/Photos/Raws/Shortlist Proposed/Previews`;
    const previews = await fetchAllPreviews(stage1Merged.map((e) => e.stem), previewsBase);
    if (previews.length === 0) {
      throw new Error(`round ${roundId} fetched zero previews from Dropbox`);
    }
    if (previews.length < stage1Merged.length) {
      warnings.push(
        `Stage 4 only fetched ${previews.length}/${stage1Merged.length} previews — proceeding with partial set`,
      );
    }

    // Build the prompt. canonicalRegistryBlock is fetched in parallel — empty
    // string when registry has no rows yet (W12 spec §"Canonical registry":
    // "safe to wire unconditionally").
    const canonicalRegistryText = await canonicalRegistryBlock();

    // QC-iter2-W3 F-D-007: load slot definitions for this round and render
    // the slotEnumerationBlock preamble (PHASE 1 / 2 / 3 + per-position
    // curated rows + package ceiling). Stage 4 was previously emitting
    // slot_decisions[] without seeing the slot lattice — only the schema's
    // closed enum constrained it, so it was picking heroes blind from the
    // taxonomy. With the block wired in, the model sees the same context
    // the benchmark-runner gives Pass 2.
    let slotEnumerationText = '';
    try {
      const { slots, engineRoles } = await loadSlotDefinitionsForRound(
        admin,
        ctx.project_id,
      );
      // W11.6.25 — apply the frozen recipe (if present) onto the live slot
      // list. The recipe sets per-slot allocated_count + max_count which
      // override slot.min_images / slot.max_images for THIS round only;
      // mid-round edits to allocations don't change in-flight rounds. When
      // the recipe is NULL (legacy rounds), the live slot definitions are
      // used as-is.
      const slotsForPrompt = applyRecipeToSlots(slots, ctx.resolved_slot_recipe);
      slotEnumerationText = slotEnumerationBlock({
        propertyAddress: ctx.property_address,
        packageType: ctx.package_type,
        packageDisplayName: ctx.package_type,
        packageCeiling: ctx.package_ceiling,
        pricingTier: ctx.property_tier,
        engineRoles,
        totalCompositions: stage1Merged.length,
        slotDefinitions: slotsForPrompt,
      });
    } catch (slotErr) {
      const msg = slotErr instanceof Error ? slotErr.message : String(slotErr);
      // Non-fatal — Stage 4 still has the canonical-enum constraint on
      // slot_id. Surface the failure as a warning so ops can see it.
      warnings.push(`slotEnumerationBlock load failed: ${msg}`);
    }

    // Mig 444: resolve gallery_positions for the round. Tolerates R1's mig
    // 443 not being applied yet — falls back to empty list with a warning so
    // legacy slot resolution remains the primary path. When R1 lands and
    // operators have authored positions, the rendered block is injected into
    // the user prompt and Stage 4 emits position_decisions[] alongside
    // legacy slot_decisions[].
    //
    // mig 444 fix: derive scope IDs from the round's metadata (was previously
    // all NULL → resolver short-circuited with "no scope filters could be
    // derived"). The deriveRoundScope helper:
    //   - looks up package_id from packages.name = round.package_type
    //   - looks up project_type_id from projects.id = round.project_id
    //   - passes engine_grade_id straight through as grade_id
    //   - hardcodes price_tier_id to Standard (see TODO below)
    //   - leaves product_id NULL (round-level product not yet defined)
    //
    // TODO(price_tier_on_rounds): shortlisting_rounds doesn't yet carry a
    // price_tier_id. Hardcoding Standard for all rounds until Tonomo/booking
    // data populates this. Per-package recipes that vary by price tier
    // (Silver Standard vs Silver Premium) will all resolve to Silver Standard
    // scope until this is fixed. See follow-up mig.
    let galleryPositions: ResolvedGalleryPosition[] = [];
    let galleryPositionsBlockText = '';
    try {
      const scope = await deriveRoundScope({
        admin,
        round: {
          id: roundId,
          project_id: ctx.project_id,
          package_type: ctx.package_type,
          engine_grade_id: ctx.engine_grade_id,
        },
      });
      for (const w of scope.warnings) warnings.push(w);

      const resolved = await resolveGalleryPositions({
        admin,
        project_type_id: scope.project_type_id,
        package_id: scope.package_id,
        product_id: scope.product_id,
        price_tier_id: scope.price_tier_id,
        grade_id: scope.grade_id,
      });
      for (const w of resolved.warnings) warnings.push(`resolveGalleryPositions: ${w}`);
      galleryPositions = resolved.positions;
      galleryPositionsBlockText = renderGalleryPositionsBlock(resolved.positions);

      // Observability: when ANY of (package_id, project_type_id, grade_id) is
      // NULL, fire a `resolve_scope_partial` event. We don't gate on whether
      // gallery_positions HAS rows that could have matched (cheap to emit;
      // gives ops visibility on the gap regardless). Wrapped in try/catch —
      // event-write failures must never roll back Stage 4.
      const missing: string[] = [];
      if (!scope.package_id) missing.push('package_id');
      if (!scope.project_type_id) missing.push('project_type_id');
      if (!scope.grade_id) missing.push('grade_id');
      if (missing.length > 0) {
        try {
          await admin.from('shortlisting_events').insert({
            project_id: ctx.project_id,
            round_id: roundId,
            event_type: 'resolve_scope_partial',
            actor_type: 'engine',
            payload: {
              stage: 'stage4',
              round_package_type: ctx.package_type,
              missing_scope_ids: missing,
              derived_scope: {
                package_id: scope.package_id,
                project_type_id: scope.project_type_id,
                grade_id: scope.grade_id,
                price_tier_id: scope.price_tier_id,
                price_tier_id_is_hardcoded: scope.price_tier_id === HARDCODED_STANDARD_PRICE_TIER_ID,
                product_id: scope.product_id,
              },
              resolved_position_count: resolved.positions.length,
              warnings: scope.warnings,
            },
          });
        } catch (evErr) {
          const m = evErr instanceof Error ? evErr.message : String(evErr);
          warnings.push(`resolve_scope_partial event emit failed: ${m}`);
        }
      }
    } catch (posErr) {
      const m = posErr instanceof Error ? posErr.message : String(posErr);
      warnings.push(`resolveGalleryPositions failed: ${m}`);
    }

    const systemText = [
      buildStage4SystemPrompt(),
      '',
      SYDNEY_PRIMER_BLOCK,
    ].join('\n');
    // W11.6.14: filter exif rows to those whose stem actually arrived
    // as a preview, then render the compact table. Empty when no rows
    // (the table itself renders a graceful fallback in that case).
    const previewStemSet = new Set(previews.map((p) => p.stem));
    const exifRowsForPreviews = stage1ExifRows.filter((r) => previewStemSet.has(r.stem));
    const exifContextTableText = exifContextTable(exifRowsForPreviews);

    // W11.8 — load round-level space_instances so the prompt can teach the
    // model which physically-distinct rooms exist per space_type. Empty when
    // detect_instances has not run for this round (legacy rounds, partial
    // replays).
    const spaceInstances = await loadSpaceInstancesSummary(admin, roundId, warnings);

    const userPromptCore = buildStage4UserPrompt({
      sourceContextBlockText: sourceContextBlock(sourceType),
      photographerTechniquesBlockText: photographerTechniquesBlock(),
      exifContextTableText,
      galleryPositionsBlockText,
      voiceBlockText: voiceAnchorBlock(voice),
      selfCritiqueBlockText: SELF_CRITIQUE_BLOCK,
      propertyFacts: ctx.property_facts,
      stage1Merged,
      imageStemsInOrder: previews.map((p) => p.stem),
      totalImages: previews.length,
      spaceInstances,
    });
    // QC-iter2-W3 F-D-007: prepend the slotEnumerationBlock preamble before
    // the rest of the user prompt. Sits BEFORE property facts + Stage 1
    // enrichment so the model reads "here's the slot lattice + ceiling"
    // before reasoning about which images fill which slots. Append canonical
    // registry block at the END (unchanged).
    const userPromptWithSlots = slotEnumerationText.length > 0
      ? [slotEnumerationText, '', userPromptCore].join('\n')
      : userPromptCore;
    const userText = canonicalRegistryText.length > 0
      ? [
          userPromptWithSlots,
          '',
          '── CANONICAL FEATURE REGISTRY (W12) ──',
          canonicalRegistryText,
        ].join('\n')
      : userPromptWithSlots;

    // Call Gemini vision adapter with retries. W11.8.1: Anthropic failover
    // stripped — exhausted retries throw and the round flips to 'failed'.
    const stage4Call = await callStage4Gemini({
      systemText,
      userText,
      previews,
      settings,
    });
    const { resp, vendorUsed, modelUsed, costUsd, wallMs, inputTokens, outputTokens, thinkingTokens, failoverTriggered, failoverReason, error } = stage4Call;

    if (!resp) {
      // ─── Mig 437: engine_vendor_failure observability event ────────────
      // Fire BEFORE the throw so even though the round flips to 'failed' we
      // get the structured alert path firing the notification + email queue
      // immediately. Wrapped in try/catch so an event-write failure can never
      // mask the original vendor error in the log/throw chain.
      try {
        const msg = stage4Call.vendorErrorMessage || '';
        const codeMatch = /"code"\s*:\s*"([A-Z_]+)"/.exec(msg)
          || /"code"\s*:\s*(\d+)/.exec(msg);
        const geminiErrorCode = codeMatch ? codeMatch[1] : null;
        await admin.from('shortlisting_events').insert({
          project_id: ctx.project_id,
          round_id: roundId,
          group_id: null,
          event_type: 'engine_vendor_failure',
          actor_type: 'engine',
          actor_id: null,
          payload: {
            stage: 'stage4',
            vendor: PRIMARY_VENDOR,
            model: PRIMARY_MODEL,
            status_code: stage4Call.vendorErrorStatus,
            gemini_error_code: geminiErrorCode,
            gemini_error_message_excerpt: msg.slice(0, 600),
            attempt_count: stage4Call.attemptCount,
            request_size_bytes_approx: stage4Call.requestSizeBytesApprox,
          },
        });
      } catch (evtErr) {
        const m = evtErr instanceof Error ? evtErr.message : String(evtErr);
        console.warn(`[${GENERATOR}] engine_vendor_failure event insert failed: ${m}`);
      }
      throw new Error(`Stage 4 vision call failed: ${error ?? 'unknown'}`);
    }

    // Parse output
    const output = resp.output as Record<string, unknown>;
    const masterListing = output.master_listing as Record<string, unknown> | undefined;
    const stage4Overrides = (output.stage_4_overrides as Array<Record<string, unknown>> | undefined) || [];
    // Slot decisions: each entry is {slot_id, phase, winner:{stem,rationale},
    // alternatives:[], rejected_near_duplicates:[]}. These ARE the AI's
    // proposed shortlist — they MUST be persisted to shortlisting_overrides
    // for the swimlane (which keys off ai_proposed_group_id) to render.
    // (Bug fix 2026-05-01: Stage 4 was dropping slot_decisions on the floor.)
    const slotDecisions = (output.slot_decisions as Array<Record<string, unknown>> | undefined) || [];
    // W11.6.6: proposed_slots[] are Stage 4's suggestions for new slot
    // taxonomy entries that don't yet exist in the canonical slotEnumeration
    // enum. We persist each to shortlisting_events with event_type=
    // 'pass2_slot_suggestion' (legacy event-type name, kept for W12 discovery
    // queue compatibility). Empty/missing -> no-op. Spec: W11-7 §"proposed_slots".
    const proposedSlots = (output.proposed_slots as Array<Record<string, unknown>> | undefined) || [];
    // Mig 444 — position_decisions[] (one entry per resolved gallery_position)
    // + proposed_position_templates[] (recurring constraint patterns Stage 4
    // wants to elevate to saved templates). Both are best-effort: the round
    // can succeed without either when the resolver returned zero positions.
    const positionDecisions = (output.position_decisions as Array<Record<string, unknown>> | undefined) || [];
    const proposedPositionTemplates = (output.proposed_position_templates as Array<Record<string, unknown>> | undefined) || [];
    const gallerySeq = (output.gallery_sequence as string[] | undefined) || null;
    const dedupGroups = (output.dedup_groups as Array<Record<string, unknown>> | undefined) || null;
    const missingShots = (output.missing_shot_recommendations as string[] | undefined) || null;
    const narrativeArcScore = typeof output.narrative_arc_score === 'number'
      ? output.narrative_arc_score
      : null;
    const archetype = typeof output.property_archetype_consensus === 'string'
      ? output.property_archetype_consensus
      : null;
    const overallScore = typeof output.overall_property_score === 'number'
      ? output.overall_property_score
      : null;

    if (!masterListing) {
      throw new Error('Stage 4 output missing master_listing object');
    }

    // Persist master_listing. Use the EFFECTIVE tier (voice.tier) which
    // honours regenerate's voice_tier_override, not the round's default
    // ctx.property_tier — so when an operator regenerates a 'standard' round
    // with tier_override='premium', the persisted property_tier reflects the
    // tier that produced the copy on disk. When this is a regenerate run
    // (regenCtx.masterListingIdToOverwrite set), persistMasterListing uses
    // UPDATE-in-place on that row id (preserving the FK target for
    // shortlisting_master_listings_history archive rows). On regen success
    // we ALSO stamp regenerated_at + regenerated_by; the regenerate-master-
    // listing edge fn pre-incremented regeneration_count synchronously, so
    // we DO NOT touch that field here (avoids double-bump under concurrent
    // regen + Stage 4 race conditions).
    const voiceAnchorUsed: 'tier_preset' | 'override' | 'master_class_enhanced' =
      voice.override ? 'override' : 'tier_preset';
    const masterListingId = await persistMasterListing({
      admin,
      roundId,
      masterListing,
      propertyTier: voice.tier,
      voiceAnchorUsed,
      vendor: vendorUsed,
      modelVersion: modelUsed,
      regenCtx,
      warnings,
    });

    // Persist Stage 4 cross-image fields on shortlisting_rounds
    await persistStage4RoundFields({
      admin,
      roundId,
      gallerySequence: gallerySeq,
      dedupGroups: dedupGroups,
      missingShotRecommendations: missingShots,
      narrativeArcScore,
      propertyArchetypeConsensus: archetype,
      overallPropertyScore: overallScore,
      stage4CostUsd: costUsd,
      // W11.8.1: failover stripped — engine_mode is always 'shape_d_full' on
      // successful Stage 4. Legacy rounds with engine_mode='unified_anthropic_failover'
      // can still pass the preflight gate; this stamp overrides them on success.
      finalEngineMode: 'shape_d_full',
      warnings,
    });

    // Persist Stage 4 overrides — both audit table AND
    // composition_classification_overrides with override_source='stage4_visual_override'.
    const overridesPersisted = await persistStage4Overrides({
      admin,
      roundId,
      stage4Overrides,
      warnings,
    });

    // Persist slot_decisions to shortlisting_overrides — the swimlane's
    // primary data source. One row per (slot, winner-or-alternative).
    const slotDecisionsPersisted = await persistSlotDecisions({
      admin,
      roundId,
      projectId: ctx.project_id,
      propertyTier: ctx.property_tier,
      slotDecisions,
      warnings,
    });

    // W11.6.6: persist proposed_slots[] to shortlisting_events for W12's
    // discovery queue. Mirrors persistSlotDecisions' delete-then-insert
    // idempotency so a regenerate doesn't double-stack suggestions.
    await persistProposedSlots({
      admin,
      projectId: ctx.project_id,
      roundId,
      proposedSlots,
    });

    // Mig 444 — persist position_decisions[] to shortlisting_position_decisions
    // and proposed_position_templates[] to shortlisting_position_template_suggestions.
    // Both are tolerant of mig 444 not being applied yet (the helpers warn
    // and return early when their tables are missing).
    try {
      await persistPositionDecisions({
        admin,
        projectId: ctx.project_id,
        roundId,
        positionDecisions,
        resolvedPositions: galleryPositions,
        warnings,
      });
    } catch (perr) {
      const m = perr instanceof Error ? perr.message : String(perr);
      warnings.push(`persistPositionDecisions failed: ${m}`);
    }
    try {
      await persistProposedPositionTemplates({
        admin,
        roundId,
        proposedPositionTemplates,
        warnings,
      });
    } catch (perr) {
      const m = perr instanceof Error ? perr.message : String(perr);
      warnings.push(`persistProposedPositionTemplates failed: ${m}`);
    }

    // W11.6.22b — emit curated-position coverage gap events (required-but-
    // missing OR ai_backfill-filled). Joined position prefs are loaded once
    // per round so the helper is a pure transform over slot_decisions[]. We
    // skip entirely when no slot is in curated_positions mode for this round
    // — the IN() query short-circuits to no rows so the cost stays zero.
    try {
      const curatedPrefsBySlot = await loadCuratedPositionPrefsBySlot(
        admin,
        roundId,
      );
      if (curatedPrefsBySlot.size > 0) {
        await emitCuratedCoverageEvents({
          admin,
          projectId: ctx.project_id,
          roundId,
          slotDecisions,
          curatedPrefsBySlot,
        });
      }
    } catch (err) {
      // Advisory analytics — never block Stage 4 completion on a bad load.
      warnings.push(
        `emitCuratedCoverageEvents skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // W11.6.25 — emit coverage_gap_mandatory_recipe when a recipe-mandatory
    // slot received fewer winners than allocated_count. Advisory only — the
    // round still moves toward 'proposed'; this lets the swimlane surface
    // "Joseph's recipe demanded 2 kitchen heroes but Stage 4 only proposed 1"
    // as a hard signal to ops.
    if (ctx.resolved_slot_recipe && Array.isArray(ctx.resolved_slot_recipe.entries)) {
      try {
        const decisionsBySlot = new Map<string, number>();
        for (const d of slotDecisions) {
          const sid = typeof d.slot_id === 'string' ? d.slot_id : null;
          if (!sid) continue;
          decisionsBySlot.set(sid, (decisionsBySlot.get(sid) ?? 0) + 1);
        }
        const gaps: Array<{ slot_id: string; allocated: number; actual: number }> = [];
        for (const e of ctx.resolved_slot_recipe.entries) {
          if (e.classification !== 'mandatory') continue;
          const actual = decisionsBySlot.get(e.slot_id) ?? 0;
          if (actual < e.allocated_count) {
            gaps.push({ slot_id: e.slot_id, allocated: e.allocated_count, actual });
          }
        }
        if (gaps.length > 0) {
          await admin.from('shortlisting_events').insert(
            gaps.map((g) => ({
              project_id: ctx.project_id,
              round_id: roundId,
              event_type: 'coverage_gap_mandatory_recipe',
              actor_type: 'system',
              actor_id: null,
              payload: {
                slot_id: g.slot_id,
                allocated_count: g.allocated,
                actual_count: g.actual,
                shortfall: g.allocated - g.actual,
                source: 'W11.6.25_slot_recipes',
              },
            })),
          );
        }
      } catch (err) {
        warnings.push(
          `coverage_gap_mandatory_recipe emit skipped: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Update engine_run_audit (incl. token attribution + prompt block versions)
    await updateEngineRunAudit({
      admin,
      roundId,
      vendorUsed,
      modelUsed,
      failoverTriggered,
      failoverReason,
      stage4CostUsd: costUsd,
      stage4WallMs: wallMs,
      stage4InputTokens: inputTokens,
      stage4OutputTokens: outputTokens,
      stage4ThinkingTokens: thinkingTokens,
      promptBlockVersions: stage4PromptBlockVersions(),
      warnings,
    });

    // Audit JSON
    const auditPath = await uploadStage4AuditJson({
      ctx,
      roundId,
      output,
      vendorUsed,
      modelUsed,
      costUsd,
      wallMs,
      failoverTriggered,
      failoverReason,
      voice,
      sourceType,
      settings,
      startedAt,
      stage1MergedCount: stage1Merged.length,
      previewsCount: previews.length,
      overridesPersisted,
      warnings,
    });

    // Log shortlisting_events
    await admin.from('shortlisting_events').insert({
      project_id: ctx.project_id,
      round_id: roundId,
      event_type: 'shape_d_stage4_complete',
      actor_type: 'system',
      payload: {
        vendor_used: vendorUsed,
        model_used: modelUsed,
        failover_triggered: failoverTriggered,
        cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
        wall_ms: wallMs,
        master_listing_id: masterListingId,
        stage_4_overrides_count: overridesPersisted,
        narrative_arc_score: narrativeArcScore,
        overall_property_score: overallScore,
        audit_dropbox_path: auditPath,
      },
    });

    // W11.6.8 W7.10 P1-9: ops-facing notifications. All non-fatal — Stage
    // 4 already succeeded by here, so a notif glitch must NOT roll back
    // state. master_listing_regenerated → admin + #listing-review (mig 390).
    //
    // W11.8.1: vendor_failover_triggered notification removed. The Anthropic
    // failover code path is gone — a Gemini regression now surfaces as a
    // failed round (engine_run_audit.error_summary populated) instead of a
    // silent 12× cost shift to Anthropic Opus.
    try {
      if (regenCtx !== null) {
        await fireNotif({
          type: 'master_listing_regenerated',
          category: 'system',
          severity: 'info',
          title: `Master listing regenerated`,
          message:
            `Round ${roundId} master listing rewrite complete. ` +
            `Tier=${voice.tier}${regenCtx.voiceTierOverride ? ' (override)' : ''}` +
            `${regenCtx.voiceAnchorOverride ? ', anchor=override' : ''}` +
            `${regenCtx.reason ? `. Reason: ${regenCtx.reason.slice(0, 120)}` : ''}.`,
          projectId: ctx.project_id,
          ctaLabel: 'Review listing',
          source: GENERATOR,
          idempotencyKey: `master-listing-regen-${masterListingId ?? roundId}`,
        });
      }
    } catch (notifErr) {
      const msg = notifErr instanceof Error ? notifErr.message : String(notifErr);
      console.warn(`[${GENERATOR}] ops notifications fire threw: ${msg}`);
      warnings.push(`ops notifications fire threw: ${msg}`);
    }

    return {
      ok: true,
      vendor_used: vendorUsed,
      model_used: modelUsed,
      cost_usd: Math.round(costUsd * 1_000_000) / 1_000_000,
      wall_ms: wallMs,
      failover_triggered: failoverTriggered,
      master_listing_id: masterListingId,
      stage_4_overrides_count: overridesPersisted,
      audit_dropbox_path: auditPath,
      warnings,
    };
  }
}

// ─── Engine settings ─────────────────────────────────────────────────────────

async function loadEngineSettings(
  admin: ReturnType<typeof getAdminClient>,
): Promise<EngineSettings> {
  // W11.8.1: failover_vendor stripped from required keys. The DB row may
  // still exist — it's harmless and ignored.
  const keys = [
    'stage4_thinking_budget',
    'stage4_max_output_tokens',
    'cost_cap_per_round_usd',
  ];
  const { data } = await admin
    .from('engine_settings')
    .select('key, value')
    .in('key', keys);
  const map = new Map<string, unknown>();
  for (const row of (data || []) as Array<{ key: string; value: unknown }>) {
    map.set(row.key, row.value);
  }
  const num = (k: string, def: number): number => {
    const v = map.get(k);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const n = Number(v); return Number.isNaN(n) ? def : n; }
    return def;
  };
  return {
    stage4_thinking_budget: num('stage4_thinking_budget', STAGE4_DEFAULT_THINKING_BUDGET),
    stage4_max_output_tokens: num('stage4_max_output_tokens', STAGE4_DEFAULT_MAX_OUTPUT_TOKENS),
    cost_cap_per_round_usd: num('cost_cap_per_round_usd', 10),
  };
}

// ─── Round context loader ───────────────────────────────────────────────────

async function loadRoundContext(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<RoundContext> {
  const { data: round, error: rErr } = await admin
    .from('shortlisting_rounds')
    .select(
      // QC-iter2-W3 F-D-007: pull package_type / package_ceiling /
      // expected_count_target so the Stage 4 prompt can render the
      // slotEnumerationBlock preamble (PHASE 1/2/3 + ceiling).
      // W11.6.25: also pull resolved_slot_recipe (NULL for legacy rounds —
      // Stage 4 falls back to live slot definitions when missing).
      // mig 444 fix: engine_grade_id is needed to drive deriveRoundScope so
      // the gallery_positions resolver can match package_grade scopes.
      'id, project_id, status, property_tier, property_voice_anchor_override, package_type, package_ceiling, expected_count_target, resolved_slot_recipe, engine_grade_id',
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
    throw new Error(`project ${round.project_id} has no dropbox_root_path`);
  }

  const propertyTier = ((round.property_tier as string | null) || 'standard') as PropertyTier;
  const propertyAddress = (proj.property_address as string | null) ?? null;
  const property_facts: PropertyFacts = {
    address_line: propertyAddress,
    suburb: (proj.property_suburb as string | null) ?? null,
    state: 'NSW', // single-state CRM today
    bedrooms: null,
    bathrooms: null,
    car_spaces: null,
    land_size_sqm: null,
    internal_size_sqm: null,
    price_guide_band: null,
    auction_or_private_treaty: null,
  };

  // QC-iter2-W3 F-D-007: derive package metadata. expected_count_target is
  // the modern field (W7.7); fall back to package_ceiling when null. We
  // never block Stage 4 if both are missing — slotEnumerationBlock requires
  // a positive ceiling so default to 1 last (renders a "1 image maximum"
  // line which is at worst informational, never crashes the render).
  const expectedCount = typeof round.expected_count_target === 'number'
    ? round.expected_count_target
    : null;
  const legacyCeiling = typeof round.package_ceiling === 'number'
    ? round.package_ceiling
    : null;
  const packageCeiling = (expectedCount && expectedCount > 0)
    ? expectedCount
    : (legacyCeiling && legacyCeiling > 0 ? legacyCeiling : 1);
  const packageType = typeof round.package_type === 'string' && round.package_type.length > 0
    ? round.package_type
    : 'unspecified';

  // W11.6.25 — surface the frozen recipe snapshot. Type-narrow defensively
  // since it's a JSONB column and Postgres returns it as `unknown`.
  let resolvedRecipe: RoundContext['resolved_slot_recipe'] = null;
  const rawRecipe = (round as { resolved_slot_recipe?: unknown }).resolved_slot_recipe;
  if (rawRecipe && typeof rawRecipe === 'object') {
    const obj = rawRecipe as { entries?: unknown };
    if (Array.isArray(obj.entries)) {
      resolvedRecipe = rawRecipe as RoundContext['resolved_slot_recipe'];
    }
  }

  return {
    round_id: roundId,
    project_id: round.project_id as string,
    status: round.status as string,
    property_tier: propertyTier,
    property_voice_anchor_override: (round.property_voice_anchor_override as string | null) ?? null,
    dropbox_root_path: dropboxRoot,
    property_facts,
    package_type: packageType,
    package_ceiling: packageCeiling,
    engine_grade_id: (round.engine_grade_id as string | null) ?? null,
    property_address: propertyAddress,
    resolved_slot_recipe: resolvedRecipe,
  };
}

// QC-iter2-W3 F-D-007: Stage-4-local helper to fetch slot definitions for
// the round's project. Mirrors `fetchSlotDefinitions` in
// shortlisting-benchmark-runner — engine-role filtered + curated_positions
// joined — so slotEnumerationBlock can render the per-position rows
// introduced by W11.6.22b. Kept local to Stage 4 (vs lifted to _shared) to
// minimise blast radius for this hot fix; can be consolidated later.
export async function loadSlotDefinitionsForRound(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
): Promise<{ slots: Pass2SlotDefinition[]; engineRoles: string[] }> {
  // 1. Resolve project engine_roles
  const { data: project } = await admin
    .from('projects')
    .select('packages, products')
    .eq('id', projectId)
    .maybeSingle();
  const productIds = new Set<string>();
  // deno-lint-ignore no-explicit-any
  for (const pkg of (Array.isArray((project as any)?.packages) ? (project as any).packages : [])) {
    // deno-lint-ignore no-explicit-any
    for (const ent of (Array.isArray(pkg?.products) ? (pkg as any).products : [])) {
      if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
    }
  }
  // deno-lint-ignore no-explicit-any
  for (const ent of (Array.isArray((project as any)?.products) ? (project as any).products : [])) {
    if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
  }
  let productsList: ProductRow[] = [];
  if (productIds.size > 0) {
    const { data: prodRows } = await admin
      .from('products')
      .select('id, engine_role, is_active')
      .in('id', Array.from(productIds));
    productsList = ((prodRows ?? []) as ProductRow[]).map((p) => ({
      id: String(p.id),
      engine_role: p.engine_role ?? null,
      is_active: p.is_active === true,
    }));
  }
  // deno-lint-ignore no-explicit-any
  const engineRoles = resolveProjectEngineRolesPure(project as any, productsList) as string[];
  const roleSet = new Set<string>(engineRoles);

  // 2. Fetch active slot definitions, filter by engine_role, take latest version
  const { data, error } = await admin
    .from('shortlisting_slot_definitions')
    .select(
      'slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, max_images, min_images, notes, version, is_active, selection_mode',
    )
    .eq('is_active', true);
  if (error) throw new Error(`loadSlotDefinitionsForRound failed: ${error.message}`);
  if (!data) return { slots: [], engineRoles };

  // deno-lint-ignore no-explicit-any
  const filtered = (data as any[]).filter((row) => {
    const roles: string[] = Array.isArray(row.eligible_when_engine_roles)
      ? row.eligible_when_engine_roles
      : [];
    if (roles.length === 0) return false;
    return roles.some((r) => roleSet.has(r));
  });

  const byId = new Map<string, Pass2SlotDefinition & { version: number }>();
  for (const row of filtered) {
    const cand = {
      slot_id: row.slot_id,
      display_name: row.display_name,
      phase: row.phase,
      eligible_room_types: row.eligible_room_types || [],
      max_images: row.max_images,
      min_images: row.min_images,
      notes: row.notes,
      version: row.version || 1,
      selection_mode: row.selection_mode === 'curated_positions'
        ? 'curated_positions' as const
        : 'ai_decides' as const,
    } as Pass2SlotDefinition & { version: number };
    const existing = byId.get(cand.slot_id);
    if (!existing || cand.version > existing.version) byId.set(cand.slot_id, cand);
  }

  // 3. Hydrate curated_positions for slots in curated_positions mode
  const curatedSlotIds = Array.from(byId.values())
    .filter((s) => s.selection_mode === 'curated_positions')
    .map((s) => s.slot_id);
  if (curatedSlotIds.length > 0) {
    const { data: prefRows, error: prefErr } = await admin
      .from('shortlisting_slot_position_preferences')
      .select(
        'slot_id, position_index, display_label, preferred_composition_type, preferred_zone_focus, preferred_space_type, preferred_lighting_state, preferred_image_type, preferred_signal_emphasis, is_required, ai_backfill_on_gap',
      )
      .in('slot_id', curatedSlotIds);
    if (prefErr) {
      console.warn(`loadSlotDefinitionsForRound: position prefs load failed: ${prefErr.message}`);
    } else if (Array.isArray(prefRows)) {
      const bySlot = new Map<string, Array<Record<string, unknown>>>();
      for (const r of prefRows as Array<Record<string, unknown>>) {
        const sid = String(r.slot_id);
        if (!bySlot.has(sid)) bySlot.set(sid, []);
        bySlot.get(sid)!.push(r);
      }
      for (const slot of byId.values()) {
        if (slot.selection_mode !== 'curated_positions') continue;
        const rows = (bySlot.get(slot.slot_id) ?? []).slice();
        rows.sort((a, b) => Number(a.position_index ?? 0) - Number(b.position_index ?? 0));
        slot.curated_positions = rows.map((r) => ({
          position_index: Number(r.position_index ?? 0),
          display_label: typeof r.display_label === 'string' ? r.display_label : '',
          preferred_composition_type: (r.preferred_composition_type as string | null) ?? null,
          preferred_zone_focus: (r.preferred_zone_focus as string | null) ?? null,
          preferred_space_type: (r.preferred_space_type as string | null) ?? null,
          preferred_lighting_state: (r.preferred_lighting_state as string | null) ?? null,
          preferred_image_type: (r.preferred_image_type as string | null) ?? null,
          preferred_signal_emphasis: Array.isArray(r.preferred_signal_emphasis)
            ? r.preferred_signal_emphasis as string[]
            : [],
          is_required: r.is_required === true,
          ai_backfill_on_gap: r.ai_backfill_on_gap !== false,
        }));
      }
    }
  }

  const slots = Array.from(byId.values())
    .map(({ version: _v, ...rest }) => rest)
    .sort((a, b) => (a.phase - b.phase) || a.slot_id.localeCompare(b.slot_id));
  return { slots, engineRoles };
}

// ─── W11.6.25 — apply resolved recipe to slot definitions ────────────────────

/**
 * Override per-slot min_images / max_images on the live slot definitions
 * with the values from the round's frozen recipe snapshot.
 *
 * The slot lattice (room_type / engine_role gates, curated positions, etc.)
 * comes from the live shortlisting_slot_definitions table — only the COUNT
 * targets are recipe-driven. Slots not present in the recipe are left
 * unchanged (legacy phase-3 free-recommendation behaviour). When the recipe
 * is NULL, the input slots are returned untouched.
 *
 * Exported for unit testing.
 */
export function applyRecipeToSlots(
  slots: Pass2SlotDefinition[],
  recipe: RoundContext['resolved_slot_recipe'],
): Pass2SlotDefinition[] {
  if (!recipe || !Array.isArray(recipe.entries) || recipe.entries.length === 0) {
    return slots;
  }
  const byId = new Map<string, { allocated_count: number; max_count: number }>();
  for (const e of recipe.entries) {
    byId.set(e.slot_id, {
      allocated_count: e.allocated_count,
      max_count: e.max_count,
    });
  }
  return slots.map((s) => {
    const r = byId.get(s.slot_id);
    if (!r) return s;
    return {
      ...s,
      min_images: r.allocated_count,
      max_images: r.max_count,
    };
  });
}

// ─── Stage 1 merged JSON loader ──────────────────────────────────────────────

async function loadStage1Merged(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<{ entries: Stage1MergedEntry[]; exifRows: ExifTableRow[] }> {
  const { data, error } = await admin
    .from('composition_classifications')
    .select(`
      group_id,
      analysis,
      room_type,
      space_type,
      zone_focus,
      space_zone_count,
      composition_type,
      vantage_position,
      composition_geometry,
      vantage_point,
      technical_score,
      lighting_score,
      composition_score,
      aesthetic_score,
      is_styled,
      indoor_outdoor_visible,
      clutter_severity,
      flag_for_retouching,
      key_elements,
      zones_visible,
      composition_groups!composition_classifications_group_id_fkey(
        group_index,
        delivery_reference_stem,
        best_bracket_stem,
        exif_metadata,
        space_instance_id
      )
    `)
    .eq('round_id', roundId)
    .order('group_id');
  if (error) throw new Error(`composition_classifications load failed: ${error.message}`);

  const out: Stage1MergedEntry[] = [];
  // W11.6.14: gather per-image EXIF rows alongside the Stage 1 merged
  // entries so Stage 4 can render the compact PER-IMAGE METADATA table.
  // Each row is keyed by the same stem that appears in stage1Merged.
  const exifRows: ExifTableRow[] = [];
  for (const row of (data || []) as Array<Record<string, unknown>>) {
    const grp = (row.composition_groups as Record<string, unknown> | null) || null;
    const stem = (grp?.delivery_reference_stem as string | null)
      || (grp?.best_bracket_stem as string | null)
      || `group_${grp?.group_index ?? '?'}`;
    out.push({
      stem,
      group_id: row.group_id as string,
      group_index: (grp?.group_index as number) ?? 0,
      room_type: (row.room_type as string | null) ?? null,
      // W11.6.13 — orthogonal SPACE/ZONE pair surfaced to Stage 4.
      space_type: (row.space_type as string | null) ?? null,
      zone_focus: (row.zone_focus as string | null) ?? null,
      space_zone_count: (row.space_zone_count as number | null) ?? null,
      composition_type: (row.composition_type as string | null) ?? null,
      vantage_position: (row.vantage_position as string | null) ?? null,         // mig 451
      composition_geometry: (row.composition_geometry as string | null) ?? null, // mig 451
      vantage_point: (row.vantage_point as string | null) ?? null,
      technical_score: (row.technical_score as number | null) ?? null,
      lighting_score: (row.lighting_score as number | null) ?? null,
      composition_score: (row.composition_score as number | null) ?? null,
      aesthetic_score: (row.aesthetic_score as number | null) ?? null,
      is_styled: (row.is_styled as boolean | null) ?? null,
      indoor_outdoor_visible: (row.indoor_outdoor_visible as boolean | null) ?? null,
      clutter_severity: (row.clutter_severity as string | null) ?? null,
      flag_for_retouching: (row.flag_for_retouching as boolean | null) ?? null,
      key_elements: (row.key_elements as string[] | null) ?? null,
      zones_visible: (row.zones_visible as string[] | null) ?? null,
      // W11.8 — per-group instance id from detect_instances. NULL when
      // detect_instances has not yet run (legacy rounds).
      space_instance_id: (grp?.space_instance_id as string | null) ?? null,
    });

    // W11.6.14: pull per-image EXIF for THIS stem from the linked
    // composition_groups.exif_metadata JSONB (keyed by stem). Defensive
    // null handling — exifContextTable renders "?" for missing fields.
    const exifMap = (grp?.exif_metadata as Record<string, unknown> | null) ?? null;
    const perImage = exifMap && typeof exifMap === 'object'
      ? (exifMap[stem] as Record<string, unknown> | undefined) ?? null
      : null;
    exifRows.push({
      stem,
      cameraModel: perImage && typeof perImage.cameraModel === 'string' ? perImage.cameraModel : null,
      focalLengthMm: perImage && typeof perImage.focalLength === 'number' ? perImage.focalLength : null,
      aperture: perImage && typeof perImage.aperture === 'number' ? perImage.aperture : null,
      shutterSpeed: perImage && typeof perImage.shutterSpeed === 'string' ? perImage.shutterSpeed : null,
      iso: perImage && typeof perImage.iso === 'number' ? perImage.iso : null,
      aebBracketValue: perImage && typeof perImage.aebBracketValue === 'number'
        ? perImage.aebBracketValue
        : null,
      motionBlurRisk: !!(perImage && perImage.motionBlurRisk === true),
      highIsoRisk: !!(perImage && perImage.highIsoRisk === true),
    });
  }
  // Sort by group_index for stable Stage 4 ordering.
  out.sort((a, b) => a.group_index - b.group_index);
  // Mirror the sort on exifRows so they line up with the entries above.
  const orderedStems = out.map((e) => e.stem);
  const exifByStem = new Map<string, ExifTableRow>();
  for (const r of exifRows) exifByStem.set(r.stem, r);
  const sortedExifRows: ExifTableRow[] = [];
  for (const stem of orderedStems) {
    const r = exifByStem.get(stem);
    if (r) sortedExifRows.push(r);
  }
  return { entries: out, exifRows: sortedExifRows };
}

// ─── W11.8: load space_instances summary for the round ─────────────────────

async function loadSpaceInstancesSummary(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
  warnings: string[],
): Promise<SpaceInstanceSummary[]> {
  const { data, error } = await admin
    .from('shortlisting_space_instances')
    .select(
      'id, space_type, instance_index, display_label, member_group_count, ' +
      'cluster_confidence, distinctive_features',
    )
    .eq('round_id', roundId)
    .order('space_type', { ascending: true })
    .order('instance_index', { ascending: true });
  if (error) {
    const msg = String(error.message ?? error);
    // detect_instances may not have run; fall back to empty list.
    if (msg.includes('does not exist') || msg.includes('PGRST205')) {
      warnings.push(
        'shortlisting_space_instances table missing (mig 453 not applied yet) — Stage 4 will not surface instance summary',
      );
      return [];
    }
    warnings.push(`shortlisting_space_instances load failed: ${msg}`);
    return [];
  }
  if (!data || data.length === 0) return [];
  const out: SpaceInstanceSummary[] = [];
  for (const row of data as unknown as Array<Record<string, unknown>>) {
    out.push({
      id: row.id as string,
      space_type: row.space_type as string,
      instance_index: row.instance_index as number,
      display_label: (row.display_label as string | null) ?? (row.space_type as string),
      member_group_count: (row.member_group_count as number) ?? 0,
      cluster_confidence: (row.cluster_confidence as number) ?? 0,
      distinctive_features: (row.distinctive_features as string[] | null) ?? [],
    });
  }
  return out;
}

// ─── Preview fetcher ────────────────────────────────────────────────────────

async function fetchAllPreviews(
  stems: string[],
  previewsBase: string,
): Promise<Array<{ stem: string; data: string; media_type: string }>> {
  const PREVIEW_CONCURRENCY = 8;
  const out: Array<{ stem: string; data: string; media_type: string } | null> = [];
  for (let i = 0; i < stems.length; i += PREVIEW_CONCURRENCY) {
    const slice = stems.slice(i, i + PREVIEW_CONCURRENCY);
    const fetched = await Promise.all(slice.map(async (stem) => {
      const path = `${previewsBase}/${stem}.jpg`;
      try {
        const p = await fetchPreviewBase64(path);
        return { stem, data: p.data, media_type: p.media_type };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${GENERATOR}] preview ${stem} fetch failed: ${msg}`);
        return null;
      }
    }));
    out.push(...fetched);
  }
  return out.filter((p): p is { stem: string; data: string; media_type: string } => p !== null);
}

async function fetchPreviewBase64(
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

// ─── Vision call (Gemini-only, W11.8.1) ─────────────────────────────────────

interface CallStage4Args {
  systemText: string;
  userText: string;
  previews: Array<{ stem: string; data: string; media_type: string }>;
  settings: EngineSettings;
}

interface CallStage4Result {
  resp: VisionResponse | null;
  // W11.8.1: vendor narrowed to 'google'. failoverTriggered always false on
  // success; remains in the shape so engine_run_audit columns are preserved.
  vendorUsed: 'google';
  modelUsed: string;
  costUsd: number;
  wallMs: number;
  /** Vendor-reported input tokens for this call (0 if call failed). */
  inputTokens: number;
  /** Vendor-reported output tokens for this call (0 if call failed). */
  outputTokens: number;
  /**
   * W11.8.2: Gemini-reported reasoning tokens (`thoughtsTokenCount`). Stage 4
   * uses thinking_budget=16384, so expect ~0–16384 here per call. Persisted
   * to engine_run_audit.stage4_total_thinking_tokens for cost observability.
   * 0 if the call failed or vendor didn't report it.
   */
  thinkingTokens: number;
  failoverTriggered: false;
  failoverReason: null;
  error: string | null;
  /**
   * Mig 437: structured vendor failure metadata for the engine_vendor_failure
   * shortlisting_events emission. Populated when the call exhausted retries
   * with a VendorCallError; null on success or on missing-credential bail-out
   * (which has its own non-retry error path).
   */
  vendorErrorStatus: number | null;
  vendorErrorMessage: string | null;
  attemptCount: number;
  requestSizeBytesApprox: number;
}

/**
 * Stage 4 vision call. Gemini-only post-W11.8.1: 3 retries with 2s/4s/8s
 * backoff on retryable failures, then return error. The caller throws on
 * `resp === null`, which flips the round to status='failed'.
 *
 * Previous behaviour fell back to Anthropic Opus 4.7 on primary exhaustion —
 * that path was stripped to enforce Joseph's "no automatic switches to
 * Anthropic" rule. A Gemini regression now fails LOUD instead of silently
 * shifting ~12× cost to Anthropic.
 */
async function callStage4Gemini(args: CallStage4Args): Promise<CallStage4Result> {
  const start = Date.now();
  const baseReq: VisionRequest = {
    vendor: PRIMARY_VENDOR,
    model: PRIMARY_MODEL,
    tool_name: STAGE4_TOOL_NAME,
    tool_input_schema: STAGE4_TOOL_SCHEMA,
    system: args.systemText,
    user_text: args.userText,
    images: args.previews.map((p) => ({
      source_type: 'base64',
      media_type: p.media_type,
      data: p.data,
    })),
    max_output_tokens: args.settings.stage4_max_output_tokens,
    temperature: 0,
    thinking_budget: args.settings.stage4_thinking_budget,
    timeout_ms: STAGE4_TIMEOUT_MS,
  };

  let lastErr: string | null = null;
  // Mig 437: capture structured fields for the engine_vendor_failure
  // observability event so the caller can emit a row pointing at the
  // exact vendor failure mode (status code + message excerpt + attempt).
  let lastVendorStatus: number | null = null;
  let lastVendorMessage: string | null = null;
  let attemptsRun = 0;
  const requestSizeBytesApprox = JSON.stringify(baseReq).length;
  for (let attempt = 1; attempt <= STAGE4_RETRY_COUNT; attempt++) {
    attemptsRun = attempt;
    try {
      const resp = await callVisionAdapter(baseReq);
      return {
        resp,
        vendorUsed: PRIMARY_VENDOR,
        modelUsed: PRIMARY_MODEL,
        costUsd: resp.usage.estimated_cost_usd,
        wallMs: resp.vendor_meta.elapsed_ms || (Date.now() - start),
        inputTokens: resp.usage.input_tokens || 0,
        outputTokens: resp.usage.output_tokens || 0,
        thinkingTokens: resp.usage.thinking_tokens || 0,
        failoverTriggered: false,
        failoverReason: null,
        error: null,
        vendorErrorStatus: null,
        vendorErrorMessage: null,
        attemptCount: attempt,
        requestSizeBytesApprox,
      };
    } catch (e) {
      if (e instanceof MissingVendorCredential) {
        // No point retrying — credentials are missing.
        return {
          resp: null, vendorUsed: PRIMARY_VENDOR, modelUsed: PRIMARY_MODEL,
          costUsd: 0, wallMs: Date.now() - start,
          inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
          failoverTriggered: false, failoverReason: null,
          error: e.message,
          vendorErrorStatus: null,
          vendorErrorMessage: e.message,
          attemptCount: attempt,
          requestSizeBytesApprox,
        };
      }
      if (e instanceof VendorCallError) {
        lastErr = `${e.vendor}/${e.model} ${e.status ?? ''}: ${e.message}`;
        lastVendorStatus = typeof e.status === 'number' ? e.status : null;
        lastVendorMessage = e.message;
      } else {
        lastErr = e instanceof Error ? e.message : String(e);
        lastVendorMessage = lastErr;
      }
      console.warn(`[${GENERATOR}] Stage 4 attempt ${attempt}/${STAGE4_RETRY_COUNT} failed: ${lastErr}`);
      // Exponential back-off between retries (2s, 4s, 8s).
      if (attempt < STAGE4_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 2_000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // W11.8.1: primary exhausted — return error so the caller throws. No
  // failover. The round flips to status='failed' with the Gemini error
  // surfaced in engine_run_audit.error_summary.
  return {
    resp: null,
    vendorUsed: PRIMARY_VENDOR,
    modelUsed: PRIMARY_MODEL,
    costUsd: 0,
    wallMs: Date.now() - start,
    inputTokens: 0, outputTokens: 0, thinkingTokens: 0,
    failoverTriggered: false,
    failoverReason: null,
    error: lastErr,
    vendorErrorStatus: lastVendorStatus,
    vendorErrorMessage: lastVendorMessage,
    attemptCount: attemptsRun,
    requestSizeBytesApprox,
  };
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

interface PersistMasterListingArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  masterListing: Record<string, unknown>;
  propertyTier: PropertyTier;
  voiceAnchorUsed: 'tier_preset' | 'override' | 'master_class_enhanced';
  // W11.8.1: vendor narrowed to 'google'. shortlisting_master_listings.vendor
  // column accepts text — narrowing here just prevents drift in the type.
  vendor: 'google';
  modelVersion: string;
  /** Set when this Stage 4 run is a master_listing regeneration. Routes to
   *  UPDATE-in-place on the existing row (preserving the FK target for
   *  history rows) instead of upsert/insert. */
  regenCtx: RegenerateContext | null;
  warnings: string[];
}

async function persistMasterListing(args: PersistMasterListingArgs): Promise<string | null> {
  const wordCount = typeof args.masterListing.word_count === 'number'
    ? args.masterListing.word_count
    : null;
  const readingGrade = typeof args.masterListing.reading_grade_level === 'number'
    ? args.masterListing.reading_grade_level
    : null;
  const nowIso = new Date().toISOString();

  // ── Regenerate path ─────────────────────────────────────────────────────
  // The regenerate-master-listing edge fn already (a) archived the prior
  // master_listing JSONB to shortlisting_master_listings_history and (b)
  // pre-incremented regeneration_count synchronously. Stage 4's job here is
  // to UPDATE the master_listing JSONB on the SAME row (preserves the FK
  // target for history rows) plus stamp regenerated_at. We use a monotonic
  // UPDATE-with-RETURNING for regeneration_count so multiple back-to-back
  // regens increment cleanly even under concurrent writes — never blind ++.
  if (args.regenCtx) {
    const targetId = args.regenCtx.masterListingIdToOverwrite;
    if (targetId) {
      // Verify the target row still exists + belongs to this round (defensive
      // guard against stale job payloads). If it's gone (manual deletion),
      // fall through to the fresh-INSERT branch below.
      const { data: existing, error: existingErr } = await args.admin
        .from('shortlisting_master_listings')
        .select('id, regeneration_count')
        .eq('id', targetId)
        .eq('round_id', args.roundId)
        .is('deleted_at', null)
        .maybeSingle();
      if (existingErr) {
        args.warnings.push(`regenerate: target master_listing lookup failed: ${existingErr.message}`);
      }
      if (existing) {
        // UPDATE-in-place. We do NOT touch regeneration_count here — the
        // edge fn already bumped it synchronously. We only stamp
        // regenerated_at to mark Stage 4 completion of the regen + persist
        // the new master_listing JSONB and the (possibly overridden) tier.
        const { error: updErr } = await args.admin
          .from('shortlisting_master_listings')
          .update({
            master_listing: args.masterListing,
            property_tier: args.propertyTier,
            voice_anchor_used: args.voiceAnchorUsed,
            word_count: wordCount,
            reading_grade_level: readingGrade,
            vendor: args.vendor,
            model_version: args.modelVersion,
            regenerated_at: nowIso,
            regenerated_by: args.regenCtx.regeneratedBy,
            regeneration_reason: args.regenCtx.reason ?? null,
            updated_at: nowIso,
          })
          .eq('id', existing.id);
        if (updErr) {
          args.warnings.push(`master_listing regenerate update failed: ${updErr.message}`);
          return null;
        }
        return existing.id as string;
      }
      args.warnings.push(
        `regenerate: target master_listing ${targetId} not found for round ${args.roundId} — falling back to fresh INSERT`,
      );
    } else {
      args.warnings.push(
        'regenerate: payload had regenerate=true but no master_listing_id_to_overwrite — falling back to fresh INSERT',
      );
    }
    // Fallthrough: regen called on a round that never had Stage 4 fire.
    // Behave like a fresh run via the upsert branch below.
  }

  // ── Fresh / re-run path ─────────────────────────────────────────────────
  // Idempotency: unique(round_id) on shortlisting_master_listings means re-run
  // must archive prior to history then upsert. We use upsert via onConflict.
  // First, copy the existing row to history if it exists (re-run case).
  const { data: existing } = await args.admin
    .from('shortlisting_master_listings')
    .select('id, master_listing, property_tier, voice_anchor_used, regeneration_count')
    .eq('round_id', args.roundId)
    .maybeSingle();
  let regenerationCount = 0;
  if (existing) {
    regenerationCount = (existing.regeneration_count as number) + 1;
    const { error: histErr } = await args.admin
      .from('shortlisting_master_listings_history')
      .insert({
        master_listing_id: existing.id,
        round_id: args.roundId,
        master_listing: existing.master_listing,
        property_tier: existing.property_tier,
        voice_anchor_used: existing.voice_anchor_used,
        regeneration_count: existing.regeneration_count,
        archive_reason: 'stage4_rerun',
      });
    if (histErr) {
      args.warnings.push(`master_listing history archive failed: ${histErr.message}`);
    }
  }

  const row: Record<string, unknown> = {
    round_id: args.roundId,
    master_listing: args.masterListing,
    property_tier: args.propertyTier,
    voice_anchor_used: args.voiceAnchorUsed,
    word_count: wordCount,
    reading_grade_level: readingGrade,
    vendor: args.vendor,
    model_version: args.modelVersion,
    regeneration_count: regenerationCount,
  };
  const { data, error } = await args.admin
    .from('shortlisting_master_listings')
    .upsert(row, { onConflict: 'round_id' })
    .select('id')
    .maybeSingle();
  if (error) {
    args.warnings.push(`master_listing upsert failed: ${error.message}`);
    return null;
  }
  return (data?.id as string) || null;
}

interface PersistStage4RoundFieldsArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  gallerySequence: string[] | null;
  dedupGroups: Array<Record<string, unknown>> | null;
  missingShotRecommendations: string[] | null;
  narrativeArcScore: number | null;
  propertyArchetypeConsensus: string | null;
  overallPropertyScore: number | null;
  stage4CostUsd: number;
  finalEngineMode: string;
  warnings: string[];
}

async function persistStage4RoundFields(args: PersistStage4RoundFieldsArgs): Promise<void> {
  // Accumulate stage_4_cost_usd across re-runs (same pattern as stage_1 cost).
  const { data: prior } = await args.admin
    .from('shortlisting_rounds')
    .select('stage_4_cost_usd')
    .eq('id', args.roundId)
    .maybeSingle();
  const priorCost = (prior?.stage_4_cost_usd as number | null) ?? 0;
  const accumulated = Math.round((priorCost + args.stage4CostUsd) * 1_000_000) / 1_000_000;

  const update: Record<string, unknown> = {
    gallery_sequence: args.gallerySequence,
    dedup_groups: args.dedupGroups,
    missing_shot_recommendations: args.missingShotRecommendations,
    narrative_arc_score: args.narrativeArcScore,
    property_archetype_consensus: args.propertyArchetypeConsensus,
    overall_property_score: args.overallPropertyScore,
    stage_4_completed_at: new Date().toISOString(),
    stage_4_cost_usd: accumulated,
    engine_mode: args.finalEngineMode,
    // Transition status to 'proposed' (matches what pass2 does at terminal).
    // Operators see the round in their swimlane immediately.
    status: 'proposed',
  };
  const { error } = await args.admin
    .from('shortlisting_rounds')
    .update(update)
    .eq('id', args.roundId);
  if (error) {
    args.warnings.push(`shortlisting_rounds Stage 4 fields update failed: ${error.message}`);
  }
}

interface PersistStage4OverridesArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  stage4Overrides: Array<Record<string, unknown>>;
  warnings: string[];
}

export async function persistStage4Overrides(args: PersistStage4OverridesArgs): Promise<number> {
  if (args.stage4Overrides.length === 0) return 0;

  // Resolve stem → group_id from composition_groups for FK in
  // shortlisting_stage4_overrides + composition_classification_overrides.
  const stems = Array.from(new Set(args.stage4Overrides.map((o) => String(o.stem))));
  const { data: groupRows } = await args.admin
    .from('composition_groups')
    .select('id, delivery_reference_stem, best_bracket_stem')
    .eq('round_id', args.roundId);
  const stemToGroup = new Map<string, string>();
  for (const g of (groupRows || []) as Array<Record<string, unknown>>) {
    const delivery = (g.delivery_reference_stem as string | null) || null;
    const best = (g.best_bracket_stem as string | null) || null;
    if (delivery) stemToGroup.set(delivery, g.id as string);
    if (best && !stemToGroup.has(best)) stemToGroup.set(best, g.id as string);
  }

  // W11.7.17 hotfix-2 (Fix A): delete-then-insert idempotency. Mig 383
  // hard-enforces uniq(round_id, stem, field) on shortlisting_stage4_overrides
  // — a regenerate that re-runs Stage 4 on the same round was failing the
  // raw INSERT with a duplicate-key violation (Rainbow Cres c55374b1 emitted
  // `shortlisting_stage4_overrides insert failed: duplicate key value violates
  // unique constraint "uniq_stage4_overrides_round_stem_field"`). Mirror
  // persistSlotDecisions' / persistProposedSlots' delete-then-insert pattern:
  // clear the round's prior audit rows first, then insert the fresh batch.
  // Idempotent — re-running on the same round produces the same final state.
  // Failure to delete is logged but doesn't abort: the INSERT will surface
  // any residual duplicate-key issue loudly.
  const { error: delErr } = await args.admin
    .from('shortlisting_stage4_overrides')
    .delete()
    .eq('round_id', args.roundId);
  if (delErr) {
    args.warnings.push(`shortlisting_stage4_overrides delete-prior failed: ${delErr.message}`);
  }

  // Insert into shortlisting_stage4_overrides (audit table).
  const auditRows = args.stage4Overrides.map((o) => ({
    round_id: args.roundId,
    group_id: stemToGroup.get(String(o.stem)) ?? null,
    stem: String(o.stem),
    field: String(o.field),
    stage_1_value: o.stage_1_value != null ? String(o.stage_1_value) : null,
    stage_4_value: o.stage_4_value != null ? String(o.stage_4_value) : null,
    reason: String(o.reason ?? ''),
  }));
  if (auditRows.length > 0) {
    const { error: auditErr } = await args.admin
      .from('shortlisting_stage4_overrides')
      .insert(auditRows);
    if (auditErr) {
      args.warnings.push(`shortlisting_stage4_overrides insert failed: ${auditErr.message}`);
    }
  }

  // Mirror to composition_classification_overrides with override_source=
  // 'stage4_visual_override' so the project_memory loader picks them up on
  // next-round prompts. Skip rows where group_id couldn't resolve (rare).
  // Skip rows where the field isn't one we know how to translate to the
  // overrides table; for v1, room_type / composition_type / vantage_point /
  // combined_score map cleanly.
  //
  // Author attribution: Stage 4 is a SYSTEM actor (the W11.7 visual master
  // synthesis engine), not a human. Per W11.7 cleanup mig 379_2, this table
  // now allows actor_user_id = NULL for override_source='stage4_visual_
  // override' rows. Previously, the code looked up the first master_admin
  // from public.users to satisfy the NOT NULL constraint — but that user's
  // id may not exist in auth.users (FK target), and the upsert would fail
  // silently with a swallowed warning, leaving 0 mirror rows even when
  // shortlisting_stage4_overrides had successful audit entries (Saladine
  // round 3ed54b53 — 1 audit row, 0 mirror rows). The fix: write NULL and
  // let the CHECK constraint that's keyed on override_source allow it.
  const supportedFields = new Set(['room_type', 'composition_type', 'vantage_point', 'combined_score']);
  let mirroredCount = 0;
  for (const o of args.stage4Overrides) {
    const groupId = stemToGroup.get(String(o.stem));
    if (!groupId) continue;
    const field = String(o.field);
    if (!supportedFields.has(field)) continue;

    // Build the per-field row. Only the corrected field is set; others null.
    // actor_user_id is intentionally NULL — engine-authored rows have no
    // human attribution. Authoritative audit lives in
    // shortlisting_stage4_overrides (which doesn't require actor_user_id).
    const overrideRow: Record<string, unknown> = {
      group_id: groupId,
      round_id: args.roundId,
      override_source: 'stage4_visual_override',
      override_reason: String(o.reason ?? ''),
      actor_user_id: null,
    };

    if (field === 'room_type') {
      overrideRow.ai_room_type = o.stage_1_value;
      overrideRow.human_room_type = o.stage_4_value;
    } else if (field === 'composition_type') {
      overrideRow.ai_composition_type = o.stage_1_value;
      overrideRow.human_composition_type = o.stage_4_value;
    } else if (field === 'vantage_point') {
      overrideRow.ai_vantage_point = o.stage_1_value;
      overrideRow.human_vantage_point = o.stage_4_value;
    } else if (field === 'combined_score') {
      const aiScore = Number(o.stage_1_value);
      const humanScore = Number(o.stage_4_value);
      if (!Number.isNaN(aiScore)) overrideRow.ai_combined_score = aiScore;
      if (!Number.isNaN(humanScore)) overrideRow.human_combined_score = humanScore;
    }

    const { error: mirrErr } = await args.admin
      .from('composition_classification_overrides')
      .upsert(overrideRow, { onConflict: 'group_id,round_id,override_source' });
    if (mirrErr) {
      args.warnings.push(
        `composition_classification_overrides mirror failed for ${o.stem}/${field}: ${mirrErr.message}`,
      );
      continue;
    }
    mirroredCount++;
  }

  // Observability — surface the mirror coverage so a regression (e.g. Saladine
  // smoke at 1/1 audit but 0/1 mirror) is visible in logs without grepping
  // for warnings.
  console.log(
    `[${GENERATOR}] persistStage4Overrides round=${args.roundId} ` +
    `audit=${auditRows.length} mirror=${mirroredCount}`,
  );

  return auditRows.length;
}

// ──────────────────────────────────────────────────────────────────────────
// Slot decisions → shortlisting_overrides (the swimlane's primary data source)
// ──────────────────────────────────────────────────────────────────────────

interface PersistSlotDecisionsArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  projectId: string;
  propertyTier: 'standard' | 'premium' | 'approachable' | null;
  slotDecisions: Array<Record<string, unknown>>;
  warnings: string[];
}

/**
 * Persist Stage 4's slot_decisions[] to shortlisting_overrides — the table
 * the AI Proposed swimlane keys off via ai_proposed_group_id. Without this,
 * Stage 4 succeeds but the swimlane renders empty.
 *
 * Schema:
 *   - One row per (slot_id, winner) — human_action='ai_proposed' so the
 *     swimlane reads it as "AI's pick" and renders it in the PROPOSED column,
 *     NOT the APPROVED column. The operator's own approve/swap/remove drag
 *     transitions human_action to one of the existing legacy values
 *     (approved_as_proposed | swapped | removed | added_from_rejects).
 *   - REGRESSION FIX 2026-05-01: previous default was 'approved_as_proposed',
 *     which the swimlane interprets as "human approved this proposal" and
 *     auto-moved every AI pick to the APPROVED column without the operator
 *     touching anything. Joseph caught this on Rainbow Cres — 8 cards in
 *     HUMAN APPROVED before he'd interacted with the project.
 *   - Alternatives are NOT persisted as overrides today (the legacy pass2
 *     pattern keeps alternatives in audit JSON only). When the operator
 *     "swap"s in the swimlane, the frontend reads alternatives from the
 *     master_listing JSONB or audit JSON and inserts the swap row.
 *   - rejected_near_duplicates are also audit-only.
 *
 * project_tier maps shape_d's three tiers to the legacy two:
 *   premium → 'premium'
 *   standard / approachable → 'standard'
 * (project_tier is nullable so we could leave it NULL too, but the legacy
 * swimlane filters on it; populating preserves filter behaviour.)
 */
export async function persistSlotDecisions(args: PersistSlotDecisionsArgs): Promise<number> {
  if (args.slotDecisions.length === 0) return 0;

  // Resolve stem → group_id from composition_groups.
  const { data: groupRows } = await args.admin
    .from('composition_groups')
    .select('id, delivery_reference_stem, best_bracket_stem')
    .eq('round_id', args.roundId);
  const stemToGroup = new Map<string, string>();
  for (const g of (groupRows || []) as Array<Record<string, unknown>>) {
    const delivery = (g.delivery_reference_stem as string | null) || null;
    const best = (g.best_bracket_stem as string | null) || null;
    if (delivery) stemToGroup.set(delivery, g.id as string);
    if (best && !stemToGroup.has(best)) stemToGroup.set(best, g.id as string);
  }

  // Pull combined_score per group_id from composition_classifications so we
  // can populate ai_proposed_score. W11.6.7 P1-4 + P1-5: also pull lens_class,
  // composition_type, room_type for the slot-constraint validator.
  const { data: classRows } = await args.admin
    .from('composition_classifications')
    .select('group_id, combined_score, lens_class, composition_type, room_type')
    .eq('round_id', args.roundId);
  const groupToScore = new Map<string, number | null>();
  const classByGroup = new Map<string, ClassificationContext>();
  for (const c of (classRows || []) as Array<Record<string, unknown>>) {
    const gid = c.group_id as string;
    const score = c.combined_score === null || c.combined_score === undefined
      ? null
      : Number(c.combined_score);
    groupToScore.set(gid, score);
    classByGroup.set(gid, {
      group_id: gid,
      lens_class: (c.lens_class as string | null) ?? null,
      composition_type: (c.composition_type as string | null) ?? null,
      room_type: (c.room_type as string | null) ?? null,
    });
  }

  // W11.6.7 P1-4 + P1-5: load active slot_definitions with the new constraint
  // columns. We pull all rows the round might use; the validator only acts
  // on the slot_ids actually present in slotDecisions[].
  const { data: slotRows } = await args.admin
    .from('shortlisting_slot_definitions')
    .select('id, slot_id, lens_class_constraint, eligible_composition_types, same_room_as_slot, is_active')
    .eq('is_active', true);
  const slotsBySlotId = new Map<string, SlotDefinitionConstraints>();
  for (const s of (slotRows || []) as Array<Record<string, unknown>>) {
    slotsBySlotId.set(s.slot_id as string, {
      id: s.id as string,
      slot_id: s.slot_id as string,
      lens_class_constraint: (s.lens_class_constraint as string | null) ?? null,
      eligible_composition_types: (s.eligible_composition_types as string[] | null) ?? null,
      same_room_as_slot: (s.same_room_as_slot as string | null) ?? null,
    });
  }

  const projectTier: 'standard' | 'premium' = args.propertyTier === 'premium' ? 'premium' : 'standard';

  // W11.6.7 P1-4 + P1-5: pre-resolve winner stems → group_ids so the
  // validator can apply lens_class / composition_type / same_room_as_slot
  // checks before we build the persistence rows.
  const validatorInputs = args.slotDecisions
    .filter((d) => typeof d.slot_id === 'string')
    .map((d) => {
      const winner = (d.winner as Record<string, unknown> | undefined);
      const stem = winner && typeof winner.stem === 'string' ? winner.stem : null;
      const gid = stem ? (stemToGroup.get(stem) ?? null) : null;
      return {
        slot_id: d.slot_id as string,
        winner_group_id: gid,
        winner_stem: stem,
        raw: d,
      };
    });
  const validation = validateSlotConstraints({
    decisions: validatorInputs,
    slotsBySlotId,
    classificationsByGroupId: classByGroup,
  });
  // Append rejection rows to the stage_4_overrides[] audit + log + warn for
  // operator visibility.
  if (validation.rejections.length > 0) {
    console.warn(
      `[${GENERATOR}] persistSlotDecisions slot-constraint rejections: ` +
        `${validation.rejections.length} (round=${args.roundId})`,
    );
    for (const rej of validation.rejections) {
      args.warnings.push(`slot_constraint_reject ${rej.stem}: ${rej.reason}`);
    }
    // Persist as audit rows in shortlisting_stage4_overrides + mirror to
    // composition_classification_overrides via the existing path. We do this
    // inline (rather than batch with the model's stage_4_overrides[]) because
    // these are deterministic engine-side rejections, not model proposals.
    const auditRows = validation.rejections.map((r) => ({
      round_id: args.roundId,
      group_id: stemToGroup.get(r.stem) ?? null,
      stem: r.stem,
      field: r.field,
      stage_1_value: r.stage_1_value,
      stage_4_value: r.stage_4_value,
      reason: r.reason,
    }));
    if (auditRows.length > 0) {
      const { error: auditErr } = await args.admin
        .from('shortlisting_stage4_overrides')
        .insert(auditRows);
      if (auditErr) {
        args.warnings.push(`shortlisting_stage4_overrides slot-constraint insert failed: ${auditErr.message}`);
      }
    }
  }
  // Reduce slotDecisions to only those that passed the validator. The original
  // raw decisions are stashed on `validatorInputs[i].raw`; iterate accepted.
  const acceptedRawDecisions = validation.acceptedDecisions.map((d) => d.raw as Record<string, unknown>);

  const rowsToInsert: Array<Record<string, unknown>> = [];
  let droppedUnrecognised = 0;
  for (const decision of acceptedRawDecisions) {
    // W11.7.1 hygiene: normalise slot_id through the alias map, then validate
    // against the canonical enum. STRICT: drop the row when neither the raw
    // value nor the aliased form is canonical — better to surface drift loudly
    // than silently fragment the swimlane across slot_id variants.
    const rawSlotId = typeof decision.slot_id === 'string' ? decision.slot_id : null;
    const slotId = normaliseSlotId(rawSlotId);
    if (!rawSlotId) continue;
    if (!slotId) {
      droppedUnrecognised++;
      args.warnings.push(
        `persistSlotDecisions: dropped unrecognised slot_id="${rawSlotId}" ` +
        `(not in canonical enum, not in alias map)`,
      );
      continue;
    }
    const winner = decision.winner as Record<string, unknown> | undefined;
    if (!winner) continue;
    const winnerStem = typeof winner.stem === 'string' ? winner.stem : null;
    if (!winnerStem) continue;
    const winnerGroupId = stemToGroup.get(winnerStem);
    if (!winnerGroupId) {
      args.warnings.push(`slot_decision ${slotId}: winner stem ${winnerStem} not found in composition_groups`);
      continue;
    }
    const rationale = typeof winner.rationale === 'string' ? winner.rationale : null;
    const score = groupToScore.get(winnerGroupId) ?? null;

    // W11.6.15: Stage 4's self-reported slot-fit score (0-10). Distinct
    // from per-image quality scores — surfaces the slot-vs-quality
    // trade-off so operators can see WHEN slot-fit reasoning overrode raw
    // quality and disagree if it's bogus. Tolerated as null when an older
    // Stage 4 model run omits the field (back-compat for in-flight rounds);
    // post-W11.6.15 prompt declares it required so production always emits.
    const rawSlotFit = winner.slot_fit_score;
    const slotFitScore = typeof rawSlotFit === 'number' && Number.isFinite(rawSlotFit)
      ? rawSlotFit
      : null;

    // W11.6.22 — curated_positions support. Both fields are OPTIONAL on the
    // Stage 4 response: legacy ai_decides slot_decisions leave them null.
    const rawPositionIndex = decision.position_index;
    const positionIndex =
      typeof rawPositionIndex === 'number' && Number.isFinite(rawPositionIndex) && rawPositionIndex >= 1
        ? Math.floor(rawPositionIndex)
        : null;
    const rawFilledVia = decision.position_filled_via;
    const positionFilledVia =
      rawFilledVia === 'curated_match' || rawFilledVia === 'ai_backfill'
        ? rawFilledVia
        : null;

    rowsToInsert.push({
      project_id: args.projectId,
      round_id: args.roundId,
      ai_proposed_group_id: winnerGroupId,
      ai_proposed_slot_id: slotId, // canonical form
      ai_proposed_score: score,
      ai_proposed_analysis: rationale,
      // W11.6.15: separate dimension; null when Stage 4 didn't emit it.
      slot_fit_score: slotFitScore,
      // W11.6.22 — curated position metadata. Null on legacy ai_decides
      // slots so existing swimlane reads stay byte-stable.
      position_index: positionIndex,
      position_filled_via: positionFilledVia,
      // REGRESSION FIX 2026-05-01: was 'approved_as_proposed' which the
      // swimlane interprets as "human approved" and auto-moved cards to the
      // APPROVED column without operator interaction. 'ai_proposed' is the
      // correct semantic — the AI chose this, the human has not yet decided.
      // Swimlane handles 'ai_proposed' as a no-op (card stays in PROPOSED).
      human_action: 'ai_proposed',
      slot_group_id: slotId, // legacy field — same as slot_id under shape_d
      project_tier: projectTier,
    });
  }
  if (droppedUnrecognised > 0) {
    console.warn(
      `[${GENERATOR}] persistSlotDecisions round=${args.roundId} ` +
      `dropped_unrecognised=${droppedUnrecognised} (slot_id outside canonical enum)`,
    );
  }

  if (rowsToInsert.length === 0) {
    args.warnings.push('persistSlotDecisions: no resolvable slot decisions to persist');
    return 0;
  }

  // Idempotent: delete any existing AI-proposed rows for this round (only
  // those with no operator interaction yet — human_action='ai_proposed')
  // so a regenerate doesn't double-stack. Operator-edited rows
  // (approved_as_proposed / swapped / removed / added_from_rejects) are
  // preserved.
  const { error: delErr } = await args.admin
    .from('shortlisting_overrides')
    .delete()
    .eq('round_id', args.roundId)
    .eq('human_action', 'ai_proposed');
  if (delErr) {
    args.warnings.push(`shortlisting_overrides delete-prior failed: ${delErr.message}`);
    // continue anyway — INSERT may succeed if there were no prior rows
  }

  const { error: insErr } = await args.admin
    .from('shortlisting_overrides')
    .insert(rowsToInsert);
  if (insErr) {
    args.warnings.push(`shortlisting_overrides insert failed: ${insErr.message}`);
    return 0;
  }

  console.log(
    `[${GENERATOR}] persistSlotDecisions round=${args.roundId} ` +
    `slot_decisions=${args.slotDecisions.length} persisted=${rowsToInsert.length}`,
  );
  return rowsToInsert.length;
}

// ──────────────────────────────────────────────────────────────────────────
// W11.6.6: proposed_slots → shortlisting_events (W12 discovery queue)
// ──────────────────────────────────────────────────────────────────────────

interface PersistProposedSlotsArgs {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  proposedSlots: Array<Record<string, unknown>>;
}

/**
 * Persist Stage 4's proposed_slots[] (suggestions for new slot taxonomy
 * entries the AI noticed but couldn't place into the existing canonical
 * enum) as one shortlisting_events row each. Event_type is the LEGACY name
 * 'pass2_slot_suggestion' — the W12 discovery queue (which mines these
 * across rounds to grow the canonical registry) still keys off that string.
 *
 * Idempotent: deletes any prior pass2_slot_suggestion events for this round
 * before inserting, so a regenerate doesn't double-stack. Mirrors
 * persistSlotDecisions' delete-then-insert pattern.
 *
 * Returns the count of events inserted (0 when proposedSlots is empty/missing).
 */
export async function persistProposedSlots(args: PersistProposedSlotsArgs): Promise<number> {
  const proposedSlots = Array.isArray(args.proposedSlots) ? args.proposedSlots : [];

  // Always delete prior, even when the new run produced zero — a regenerate
  // that previously emitted suggestions but doesn't on the second pass should
  // clear the stale rows so W12's queue sees the latest state.
  const { error: delErr } = await args.admin
    .from('shortlisting_events')
    .delete()
    .eq('round_id', args.roundId)
    .eq('event_type', 'pass2_slot_suggestion');
  if (delErr) {
    console.warn(
      `[${GENERATOR}] persistProposedSlots delete-prior failed: ${delErr.message}`,
    );
    // continue — INSERT may succeed if there were no prior rows
  }

  if (proposedSlots.length === 0) {
    console.log(
      `[${GENERATOR}] persistProposedSlots round=${args.roundId} emitted=0`,
    );
    return 0;
  }

  const nowIso = new Date().toISOString();
  const rows = proposedSlots.map((entry) => ({
    project_id: args.projectId,
    round_id: args.roundId,
    event_type: 'pass2_slot_suggestion',
    actor_type: 'system',
    payload: {
      proposed_slot_id: typeof entry.proposed_slot_id === 'string'
        ? entry.proposed_slot_id
        : null,
      candidate_stems: Array.isArray(entry.candidate_stems)
        ? entry.candidate_stems
        : [],
      reasoning: typeof entry.reasoning === 'string' ? entry.reasoning : null,
      emitted_by: 'shape_d_stage4',
    },
    created_at: nowIso,
  }));

  const { error: insErr } = await args.admin
    .from('shortlisting_events')
    .insert(rows);
  if (insErr) {
    console.warn(
      `[${GENERATOR}] persistProposedSlots insert failed: ${insErr.message}`,
    );
    return 0;
  }

  console.log(
    `[${GENERATOR}] persistProposedSlots round=${args.roundId} emitted=${rows.length}`,
  );
  return rows.length;
}

// ──────────────────────────────────────────────────────────────────────────
// Mig 444 — position_decisions persistence
// ──────────────────────────────────────────────────────────────────────────

export interface PersistPositionDecisionsArgs {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  /** Raw position_decisions[] from Gemini (may be empty/missing). */
  positionDecisions: Array<Record<string, unknown>>;
  /**
   * The resolver-output that fed Stage 4 — used to map (a) winner stem ->
   * composition_groups.id and (b) sanity-check that emitted position_index
   * values exist in the round's resolved set.
   */
  resolvedPositions: ResolvedGalleryPosition[];
  warnings: string[];
}

/**
 * Persist Stage 4's position_decisions[] to shortlisting_position_decisions.
 *
 * Idempotent (delete-then-insert by round_id) so a regenerate doesn't
 * double-stack. Tolerant of mig 444 not being applied yet — surfaces a
 * warning + returns 0.
 *
 * Maps winner.stem -> composition_groups.id by reading the round's groups
 * table. When a stem doesn't resolve to a known group, we still persist the
 * decision (winner_stem present, winner_group_id NULL) so an audit trail
 * exists for the discrepancy.
 */
export async function persistPositionDecisions(
  args: PersistPositionDecisionsArgs,
): Promise<number> {
  const decisions = Array.isArray(args.positionDecisions) ? args.positionDecisions : [];

  // Idempotency: always delete prior rows for this round, even when the new
  // run produced zero — clears stale decisions on regen.
  const { error: delErr } = await args.admin
    .from('shortlisting_position_decisions')
    .delete()
    .eq('round_id', args.roundId);
  if (delErr) {
    const msg = String(delErr.message ?? delErr);
    if (msg.includes('does not exist') || msg.includes('PGRST205')) {
      args.warnings.push(
        'persistPositionDecisions: shortlisting_position_decisions table missing (mig 444 not applied yet) — skipping',
      );
      return 0;
    }
    console.warn(`[${GENERATOR}] persistPositionDecisions delete-prior failed: ${msg}`);
  }

  if (decisions.length === 0) {
    console.log(
      `[${GENERATOR}] persistPositionDecisions round=${args.roundId} emitted=0`,
    );
    return 0;
  }

  // Build a stem -> group_id map from composition_groups for FK resolution.
  // BUG-FIX 2026-05-03: previously selected `key_image_path` which doesn't
  // exist on composition_groups (silently returned no rows, leaving every
  // winner_group_id NULL). The actual columns are best_bracket_stem +
  // delivery_reference_stem (+ files_in_group[] array). Stage 4 emits
  // `winner.stem` as the delivery_reference_stem (the chosen visual out of
  // the 5-bracket group), so we register every known stem of every group
  // against the same group_id so look-ups by delivery / best / any bracket
  // member all resolve.
  const stemToGroupId = new Map<string, string>();
  try {
    const { data: groupRows } = await args.admin
      .from('composition_groups')
      .select('id, best_bracket_stem, delivery_reference_stem, files_in_group')
      .eq('round_id', args.roundId);
    for (const r of (groupRows || []) as Array<Record<string, unknown>>) {
      const gid = String(r.id);
      const delivery = typeof r.delivery_reference_stem === 'string' ? r.delivery_reference_stem : '';
      const best = typeof r.best_bracket_stem === 'string' ? r.best_bracket_stem : '';
      if (delivery) stemToGroupId.set(delivery, gid);
      if (best) stemToGroupId.set(best, gid);
      if (Array.isArray(r.files_in_group)) {
        for (const f of r.files_in_group) {
          if (typeof f === 'string' && f) stemToGroupId.set(f, gid);
        }
      }
    }
  } catch (gerr) {
    const m = gerr instanceof Error ? gerr.message : String(gerr);
    args.warnings.push(`persistPositionDecisions: composition_groups lookup failed: ${m} (winner_group_id will be null)`);
  }

  // Build a position_index -> ResolvedGalleryPosition map for template_slot_id
  // backfill. When Gemini emits a position_index that wasn't in the resolver
  // output, we still persist it but flag a warning.
  const byIndex = new Map<number, ResolvedGalleryPosition>();
  for (const p of args.resolvedPositions) byIndex.set(p.position_index, p);

  const ALLOWED_PHASES = new Set(['mandatory', 'conditional', 'optional']);
  const nowIso = new Date().toISOString();
  const rows: Array<Record<string, unknown>> = [];

  for (const d of decisions) {
    const positionIndex = Number(d.position_index ?? -1);
    if (!Number.isFinite(positionIndex) || positionIndex < 0) {
      args.warnings.push(
        `persistPositionDecisions: skipped decision with invalid position_index=${d.position_index}`,
      );
      continue;
    }
    const phaseRaw = typeof d.phase === 'string' ? d.phase : '';
    const phase = ALLOWED_PHASES.has(phaseRaw) ? phaseRaw : null;
    if (!phase) {
      args.warnings.push(
        `persistPositionDecisions: skipped position_index=${positionIndex} with invalid phase='${phaseRaw}'`,
      );
      continue;
    }
    const winner = (d.winner ?? {}) as Record<string, unknown>;
    const winnerStem = typeof winner.stem === 'string' ? winner.stem : null;
    const winnerGroupId = winnerStem ? stemToGroupId.get(winnerStem) ?? null : null;
    // W11.8 — capture the space_instance_id Stage 4 emits on the winner. The
    // model is taught to echo the id from the candidate group's Stage 1
    // entry; we accept null silently for legacy rounds + skip-disambiguation
    // space_types.
    const winnerSpaceInstanceId = typeof winner.space_instance_id === 'string'
      && winner.space_instance_id.length > 0
        ? winner.space_instance_id
        : null;
    const resolvedPos = byIndex.get(positionIndex);
    if (!resolvedPos) {
      args.warnings.push(
        `persistPositionDecisions: position_index=${positionIndex} not in round's resolved positions (model emitted unknown index) — persisting anyway`,
      );
    }
    // Mig 451 (2026-05-02): the position_constraints JSONB no longer includes
    // room_type or composition_type — both retired. Add vantage_position +
    // composition_geometry. Filter the model's emission to the canonical
    // axis set so downstream UIs see consistent shape regardless of any
    // stale legacy fields the model carried over from older prompt versions.
    const ALLOWED_CONSTRAINT_AXES = new Set([
      'space_type',
      'zone_focus',
      'shot_scale',
      'perspective_compression',
      'orientation',
      'vantage_position',
      'composition_geometry',
      'lens_class',
      'image_type',
    ]);
    const rawConstraints = (d.position_constraints && typeof d.position_constraints === 'object'
      ? d.position_constraints
      : null) as Record<string, unknown> | null;
    const filteredConstraints = rawConstraints
      ? Object.fromEntries(
          Object.entries(rawConstraints).filter(([k]) => ALLOWED_CONSTRAINT_AXES.has(k)),
        )
      : null;
    rows.push({
      round_id: args.roundId,
      project_id: args.projectId,
      position_index: positionIndex,
      phase,
      position_constraints: filteredConstraints,
      winner_group_id: winnerGroupId,
      winner_stem: winnerStem,
      winner_rationale: typeof winner.rationale === 'string' ? winner.rationale : null,
      constraint_match_score: typeof winner.constraint_match_score === 'number'
        ? winner.constraint_match_score
        : null,
      slot_fit_score: typeof winner.slot_fit_score === 'number' ? winner.slot_fit_score : null,
      alternatives: Array.isArray(d.alternatives) ? d.alternatives : [],
      rejected_near_duplicates: Array.isArray(d.rejected_near_duplicates)
        ? d.rejected_near_duplicates
        : [],
      template_slot_id: resolvedPos?.template_slot_id ?? null,
      // W11.8: instance attribution for the position decision. Mig 453 added
      // this column; it is nullable so older clients (legacy rounds, skip-
      // disambiguation space_types) still write rows without conflict.
      space_instance_id: winnerSpaceInstanceId,
      created_at: nowIso,
    });
  }

  if (rows.length === 0) {
    console.log(
      `[${GENERATOR}] persistPositionDecisions round=${args.roundId} emitted=0 (after validation)`,
    );
    return 0;
  }

  const { error: insErr } = await args.admin
    .from('shortlisting_position_decisions')
    .insert(rows);
  if (insErr) {
    const msg = String(insErr.message ?? insErr);
    if (msg.includes('does not exist') || msg.includes('PGRST205')) {
      args.warnings.push(
        'persistPositionDecisions: shortlisting_position_decisions table missing on insert — skipping',
      );
      return 0;
    }
    console.warn(`[${GENERATOR}] persistPositionDecisions insert failed: ${msg}`);
    args.warnings.push(`persistPositionDecisions insert failed: ${msg}`);
    return 0;
  }

  console.log(
    `[${GENERATOR}] persistPositionDecisions round=${args.roundId} emitted=${rows.length}`,
  );
  return rows.length;
}

// ──────────────────────────────────────────────────────────────────────────
// Mig 444 — proposed_position_templates persistence (auto-promotion source)
// ──────────────────────────────────────────────────────────────────────────

export interface PersistProposedPositionTemplatesArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  proposedPositionTemplates: Array<Record<string, unknown>>;
  warnings: string[];
}

/**
 * Persist Stage 4's proposed_position_templates[] into
 * shortlisting_position_template_suggestions. The auto-promotion fn
 * (shortlisting_promote_position_template_suggestions) reads this table
 * weekly and promotes patterns with sufficient evidence into
 * shortlisting_slot_definitions (initially is_active=false).
 *
 * Each template proposal is identified by a deterministic key derived from
 * the constraint_pattern + label so repeated observation across rounds
 * accumulates evidence on the SAME row (rather than fanning out into N
 * near-identical rows). On conflict we coalesce: increment evidence counts,
 * append round_id to sample_round_ids, refresh last_observed_at.
 *
 * Tolerant of mig 444 not being applied yet — surfaces a warning + returns 0.
 */
export async function persistProposedPositionTemplates(
  args: PersistProposedPositionTemplatesArgs,
): Promise<number> {
  const templates = Array.isArray(args.proposedPositionTemplates)
    ? args.proposedPositionTemplates
    : [];
  if (templates.length === 0) {
    console.log(
      `[${GENERATOR}] persistProposedPositionTemplates round=${args.roundId} emitted=0`,
    );
    return 0;
  }

  // We want one row per (label, constraint_pattern) signature ACROSS rounds.
  // Use the upsert RPC (provided by mig 444) which locks the row and applies
  // the coalesce arithmetic atomically. Falling back to a plain insert when
  // the RPC is missing (mig 444 not applied yet) — that path warns and skips.
  let inserted = 0;
  for (const t of templates) {
    const label = typeof t.proposed_template_label === 'string' ? t.proposed_template_label : null;
    if (!label) {
      args.warnings.push(
        'persistProposedPositionTemplates: skipped entry with missing proposed_template_label',
      );
      continue;
    }
    const pattern = (t.constraint_pattern ?? null) as Record<string, unknown> | null;
    const candidateStems = Array.isArray(t.candidate_stems) ? t.candidate_stems : [];
    const reasoning = typeof t.reasoning === 'string' ? t.reasoning : null;

    const { error } = await args.admin.rpc('shortlisting_record_position_template_suggestion', {
      p_round_id: args.roundId,
      p_label: label,
      p_constraint_pattern: pattern,
      p_candidate_stems: candidateStems,
      p_reasoning: reasoning,
    });
    if (error) {
      const msg = String(error.message ?? error);
      if (msg.includes('does not exist') || msg.includes('function') && msg.includes('not exist')) {
        args.warnings.push(
          'persistProposedPositionTemplates: RPC missing (mig 444 not applied yet) — skipping remaining templates',
        );
        return inserted;
      }
      args.warnings.push(`persistProposedPositionTemplates rpc failed: ${msg}`);
      continue;
    }
    inserted += 1;
  }
  console.log(
    `[${GENERATOR}] persistProposedPositionTemplates round=${args.roundId} emitted=${inserted}`,
  );
  return inserted;
}

// ──────────────────────────────────────────────────────────────────────────
// W11.6.22b — curated-position prefs loader (used by coverage event emitter)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Loads curated position prefs grouped by slot_id for any active slots in
 * curated_positions mode. Joins shortlisting_slot_definitions →
 * shortlisting_slot_position_preferences. Returns an empty map when no slot
 * is curated (the common path) — caller short-circuits in that case.
 *
 * NOTE: this helper does NOT scope by round_id because curated prefs are
 * global per slot_id (not per-round). Round eligibility is enforced upstream
 * by the slot resolver / engine roles; we simply enumerate the rows the
 * round's persisted slot_decisions[] could have filled.
 */
export async function loadCuratedPositionPrefsBySlot(
  admin: ReturnType<typeof getAdminClient>,
  _roundId: string,
): Promise<Map<string, Array<{
  position_index: number;
  display_label: string;
  is_required: boolean;
  ai_backfill_on_gap: boolean;
}>>> {
  const map = new Map<string, Array<{
    position_index: number;
    display_label: string;
    is_required: boolean;
    ai_backfill_on_gap: boolean;
  }>>();

  // First, find slot_ids that are active AND in curated_positions mode.
  const { data: slotRows, error: slotErr } = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, selection_mode, is_active')
    .eq('is_active', true)
    .eq('selection_mode', 'curated_positions');
  if (slotErr) {
    throw new Error(
      `loadCuratedPositionPrefsBySlot: slot lookup failed: ${slotErr.message}`,
    );
  }
  const curatedSlotIds = Array.from(
    new Set((slotRows || []).map((r) => String((r as Record<string, unknown>).slot_id))),
  ).filter(Boolean);
  if (curatedSlotIds.length === 0) return map;

  const { data: prefRows, error: prefErr } = await admin
    .from('shortlisting_slot_position_preferences')
    .select('slot_id, position_index, display_label, is_required, ai_backfill_on_gap')
    .in('slot_id', curatedSlotIds);
  if (prefErr) {
    throw new Error(
      `loadCuratedPositionPrefsBySlot: prefs lookup failed: ${prefErr.message}`,
    );
  }
  for (const r of (prefRows || []) as Array<Record<string, unknown>>) {
    const slotId = String(r.slot_id);
    const arr = map.get(slotId) ?? [];
    arr.push({
      position_index: Number(r.position_index ?? 0),
      display_label: typeof r.display_label === 'string' ? r.display_label : '',
      is_required: r.is_required === true,
      ai_backfill_on_gap: r.ai_backfill_on_gap !== false,
    });
    map.set(slotId, arr);
  }
  // Sort by position_index for deterministic event order.
  for (const arr of map.values()) {
    arr.sort((a, b) => a.position_index - b.position_index);
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────────────
// W11.6.22b — curated-position coverage gap events
// ──────────────────────────────────────────────────────────────────────────

/**
 * W11.6.22b — surface curated-position coverage outcomes as
 * shortlisting_events rows so the W11.6 RejectionReasonsDashboard's Stage 4
 * self-correction panel + admin filters can reason about them.
 *
 * Two event types emitted:
 *   - coverage_gap_required_position — a curated position with is_required=TRUE
 *     has no matching slot_decisions[] entry (winner missing). Loud signal:
 *     either the prompt failed to honour the contract OR the candidate set
 *     genuinely had no match AND ai_backfill_on_gap was disabled.
 *   - coverage_gap_ai_backfilled — a curated position was filled via
 *     position_filled_via='ai_backfill' (Stage 4 fell back to its best AI pick
 *     when no candidate matched the curated criteria). Soft signal: useful for
 *     the admin to spot positions where curation isn't being respected.
 *
 * Idempotency mirrors persistProposedSlots: delete prior rows for the round +
 * these two event_types before inserting, so a regenerate doesn't double-stack.
 *
 * Returns total events emitted. Failure paths warn + return early — these are
 * advisory analytics, not critical-path persistence.
 */
export interface CuratedCoverageEventArgs {
  admin: ReturnType<typeof getAdminClient>;
  projectId: string;
  roundId: string;
  /**
   * Stage 4's emitted slot_decisions[] (raw model output before persistence).
   * We re-derive position coverage from these rather than re-querying
   * shortlisting_overrides so the events accurately reflect the model's
   * intended emission, even if persistSlotDecisions later drops some rows
   * for unrelated reasons (slot-constraint validator, unrecognised slot_id).
   */
  slotDecisions: Array<Record<string, unknown>>;
  /**
   * Curated position prefs joined for slots in this round, keyed by slot_id.
   * One slot may have N positions. Caller supplies — keeps this helper a pure
   * I/O shim with no DB lookups beyond the events insert.
   */
  curatedPrefsBySlot: Map<string, Array<{
    position_index: number;
    display_label: string;
    is_required: boolean;
    ai_backfill_on_gap: boolean;
  }>>;
}

export async function emitCuratedCoverageEvents(
  args: CuratedCoverageEventArgs,
): Promise<number> {
  const { admin, projectId, roundId, slotDecisions, curatedPrefsBySlot } = args;
  if (curatedPrefsBySlot.size === 0) return 0;

  // Index slot_decisions by (slot_id, position_index) so we can ask "did this
  // curated position get filled?".
  const filledByKey = new Map<string, { stem: string | null; via: string | null }>();
  for (const d of slotDecisions) {
    const slotId = typeof d.slot_id === 'string' ? d.slot_id : null;
    if (!slotId) continue;
    const idx = d.position_index;
    if (typeof idx !== 'number' || !Number.isFinite(idx)) continue;
    const winner = d.winner as Record<string, unknown> | undefined;
    const stem = winner && typeof winner.stem === 'string' ? winner.stem : null;
    const via = typeof d.position_filled_via === 'string' ? d.position_filled_via : null;
    filledByKey.set(`${slotId}::${idx}`, { stem, via });
  }

  type EventRow = {
    project_id: string;
    round_id: string;
    event_type: string;
    actor_type: string;
    payload: Record<string, unknown>;
    created_at: string;
  };
  const nowIso = new Date().toISOString();
  const rows: EventRow[] = [];

  for (const [slotId, prefs] of curatedPrefsBySlot.entries()) {
    for (const pref of prefs) {
      const key = `${slotId}::${pref.position_index}`;
      const filled = filledByKey.get(key);
      if (pref.is_required && !filled) {
        rows.push({
          project_id: projectId,
          round_id: roundId,
          event_type: 'coverage_gap_required_position',
          actor_type: 'system',
          payload: {
            slot_id: slotId,
            position_index: pref.position_index,
            display_label: pref.display_label,
            ai_backfill_on_gap: pref.ai_backfill_on_gap,
            emitted_by: 'shape_d_stage4',
          },
          created_at: nowIso,
        });
      }
      if (filled && filled.via === 'ai_backfill') {
        rows.push({
          project_id: projectId,
          round_id: roundId,
          event_type: 'coverage_gap_ai_backfilled',
          actor_type: 'system',
          payload: {
            slot_id: slotId,
            position_index: pref.position_index,
            display_label: pref.display_label,
            winner_stem: filled.stem,
            is_required: pref.is_required,
            emitted_by: 'shape_d_stage4',
          },
          created_at: nowIso,
        });
      }
    }
  }

  // Idempotent delete-prior of these two event types for this round.
  const { error: delErr } = await admin
    .from('shortlisting_events')
    .delete()
    .eq('round_id', roundId)
    .in('event_type', [
      'coverage_gap_required_position',
      'coverage_gap_ai_backfilled',
    ]);
  if (delErr) {
    console.warn(
      `[${GENERATOR}] emitCuratedCoverageEvents delete-prior failed: ${delErr.message}`,
    );
  }

  if (rows.length === 0) {
    console.log(
      `[${GENERATOR}] emitCuratedCoverageEvents round=${roundId} emitted=0 (all curated positions covered)`,
    );
    return 0;
  }

  const { error: insErr } = await admin
    .from('shortlisting_events')
    .insert(rows);
  if (insErr) {
    console.warn(
      `[${GENERATOR}] emitCuratedCoverageEvents insert failed: ${insErr.message}`,
    );
    return 0;
  }

  console.log(
    `[${GENERATOR}] emitCuratedCoverageEvents round=${roundId} emitted=${rows.length}`,
  );
  return rows.length;
}

export interface UpdateEngineRunAuditArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  // W11.8.1: vendor narrowed to 'google'. failoverTriggered + failoverReason
  // remain so engine_run_audit columns continue to be written. Both are
  // always false/null now.
  vendorUsed: 'google';
  modelUsed: string;
  failoverTriggered: boolean;
  failoverReason: string | null;
  stage4CostUsd: number;
  stage4WallMs: number;
  stage4InputTokens: number;
  stage4OutputTokens: number;
  /**
   * W11.8.2: vendor-reported reasoning tokens (Gemini thoughtsTokenCount).
   * Persisted to engine_run_audit.stage4_total_thinking_tokens.
   */
  stage4ThinkingTokens: number;
  promptBlockVersions: Record<string, string>;
  warnings: string[];
}

export async function updateEngineRunAudit(args: UpdateEngineRunAuditArgs): Promise<void> {
  // W11.8.2 audit-fix Fix C: also pull stage4_total_thinking_tokens so the
  // accumulator includes vendor-reported reasoning tokens across re-runs.
  // The column was added in mig 376 but never written until this commit.
  const { data: existingRaw } = await args.admin
    .from('engine_run_audit')
    .select(
      'engine_mode, vendor_used, stage1_total_cost_usd, stage1_total_wall_ms, ' +
      'stage1_total_input_tokens, stage1_total_output_tokens, ' +
      'stage4_total_cost_usd, stage4_total_wall_ms, stage4_call_count, ' +
      'stage4_total_input_tokens, stage4_total_output_tokens, ' +
      'stage4_total_thinking_tokens, ' +
      'stages_completed, total_cost_usd, total_wall_ms, ' +
      'total_input_tokens, total_output_tokens, prompt_block_versions',
    )
    .eq('round_id', args.roundId)
    .maybeSingle();
  // supabase-js v2 maybeSingle() infers a union including a generic error
  // shape; cast explicitly so field reads are type-safe.
  const existing = existingRaw as Record<string, unknown> | null;

  const stage1Cost = (existing?.stage1_total_cost_usd as number | null) ?? 0;
  const stage1Wall = (existing?.stage1_total_wall_ms as number | null) ?? 0;
  const stage1InputTokens = (existing?.stage1_total_input_tokens as number | null) ?? 0;
  const stage1OutputTokens = (existing?.stage1_total_output_tokens as number | null) ?? 0;
  const priorStage4Cost = (existing?.stage4_total_cost_usd as number | null) ?? 0;
  const priorStage4Wall = (existing?.stage4_total_wall_ms as number | null) ?? 0;
  const priorStage4Calls = (existing?.stage4_call_count as number | null) ?? 0;
  const priorStage4InputTokens = (existing?.stage4_total_input_tokens as number | null) ?? 0;
  const priorStage4OutputTokens = (existing?.stage4_total_output_tokens as number | null) ?? 0;
  const priorStage4ThinkingTokens = (existing?.stage4_total_thinking_tokens as number | null) ?? 0;
  const priorStagesCompleted = (existing?.stages_completed as string[] | null) ?? [];
  // W11.8.1: failover stripped — default mode for fresh-row case is
  // 'shape_d_full'. Legacy rows with 'unified_anthropic_failover' pass through.
  const priorEngineMode = (existing?.engine_mode as string | null) ?? 'shape_d_full';
  const priorPromptBlockVersions =
    (existing?.prompt_block_versions as Record<string, string> | null) ?? {};

  // W11.8.2 audit-fix Fix D (accumulator-everywhere): every Stage 4 numeric
  // column accumulates `prior + args` — wall_ms is the only Math.max here,
  // because parallel Stage 4 retries' wall times overlap on the timeline.
  // Stage 4 already used accumulator behaviour for cost / call_count /
  // input_tokens / output_tokens before W11.8.2; this commit adds
  // stage4_total_thinking_tokens to the accumulator set so it follows the
  // same shape.
  const newStage4Cost = priorStage4Cost + args.stage4CostUsd;
  const newStage4Wall = Math.max(priorStage4Wall, args.stage4WallMs);
  const newStage4CostRounded = Math.round(newStage4Cost * 1_000_000) / 1_000_000;
  const newStage4InputTokens = priorStage4InputTokens + args.stage4InputTokens;
  const newStage4OutputTokens = priorStage4OutputTokens + args.stage4OutputTokens;
  const newStage4ThinkingTokens = priorStage4ThinkingTokens + args.stage4ThinkingTokens;
  const totalCost = stage1Cost + newStage4Cost;
  const totalCostRounded = Math.round(totalCost * 1_000_000) / 1_000_000;
  const totalWall = stage1Wall + newStage4Wall;
  const totalInputTokens = stage1InputTokens + newStage4InputTokens;
  const totalOutputTokens = stage1OutputTokens + newStage4OutputTokens;

  const merged = Array.from(new Set([...priorStagesCompleted, 'stage4', 'persistence']));
  // W11.8.1: failover stripped — finalEngineMode is always the prior round
  // engine_mode (typically 'shape_d_full'). Legacy rounds whose prior mode
  // was 'unified_anthropic_failover' keep that value through Stage 4 retries.
  const finalEngineMode = priorEngineMode;

  // Merge Stage 4 prompt block versions onto whatever Stage 1 wrote (Stage 1
  // only knows its own block versions; we tack stage4_prompt + Stage 4-side
  // refresh of shared blocks on top, with Stage 4's value winning on conflict).
  const mergedPromptBlockVersions: Record<string, string> = {
    ...priorPromptBlockVersions,
    ...args.promptBlockVersions,
  };

  const row: Record<string, unknown> = {
    round_id: args.roundId,
    engine_mode: finalEngineMode,
    // W11.8.1: vendor is always 'google' on success. We still preserve any
    // existing vendor_used value (could be 'anthropic' on a legacy row from
    // before the strip) — overwrite only if no prior value exists.
    vendor_used: (existing?.vendor_used as string | null) ?? args.vendorUsed,
    model_used: args.modelUsed,
    failover_triggered: args.failoverTriggered,
    failover_reason: args.failoverReason,
    stages_completed: merged,
    stages_failed: [],
    stage4_call_count: priorStage4Calls + 1,
    stage4_total_cost_usd: newStage4CostRounded,
    stage4_total_wall_ms: newStage4Wall,
    stage4_total_input_tokens: newStage4InputTokens,
    stage4_total_output_tokens: newStage4OutputTokens,
    stage4_total_thinking_tokens: newStage4ThinkingTokens,
    total_cost_usd: totalCostRounded,
    total_wall_ms: totalWall,
    total_input_tokens: totalInputTokens,
    total_output_tokens: totalOutputTokens,
    prompt_block_versions: mergedPromptBlockVersions,
    completed_at: new Date().toISOString(),
  };
  const { error } = await args.admin
    .from('engine_run_audit')
    .upsert(row, { onConflict: 'round_id' });
  if (error) {
    // W11.7.17 hotfix-2 (Fix B): also emit to stdout so failures show up in
    // `supabase functions logs` instead of only landing in Dropbox audit
    // JSON. Sparse engine_run_audit was masked by warnings sitting in the
    // Dropbox audit blob nobody greps.
    const msg = `engine_run_audit Stage 4 update failed: ${error.message}`;
    args.warnings.push(msg);
    console.warn(`[${GENERATOR}] ${msg} (round=${args.roundId})`);
    return;
  }
  console.log(
    `[${GENERATOR}] engine_run_audit Stage 4 upsert ok round=${args.roundId} ` +
    `stage4_cost=${newStage4CostRounded} total_cost=${totalCostRounded} ` +
    `stages_completed=[${merged.join(',')}]`,
  );
}

// ─── Audit JSON ──────────────────────────────────────────────────────────────

interface UploadStage4AuditArgs {
  ctx: RoundContext;
  roundId: string;
  output: Record<string, unknown>;
  // W11.8.1: vendor narrowed to 'google'. failoverTriggered/Reason kept on the
  // shape so audit-JSON consumers (Operator UI, debugging tooling) still see
  // those fields populated as `false` / `null`.
  vendorUsed: 'google';
  modelUsed: string;
  costUsd: number;
  wallMs: number;
  failoverTriggered: boolean;
  failoverReason: string | null;
  voice: VoiceAnchorOpts;
  sourceType: SourceType;
  settings: EngineSettings;
  startedAt: number;
  stage1MergedCount: number;
  previewsCount: number;
  overridesPersisted: number;
  warnings: string[];
}

async function uploadStage4AuditJson(args: UploadStage4AuditArgs): Promise<string | null> {
  const ts = new Date().toISOString().replace(/[:.]/g, '').replace('T', '_').replace('Z', '');
  const path = `${args.ctx.dropbox_root_path.replace(/\/+$/, '')}/Photos/_AUDIT/round_${args.roundId}_stage4_${ts}.json`;
  const audit = {
    version: 'v1.0',
    generator: GENERATOR,
    round_id: args.roundId,
    project_id: args.ctx.project_id,
    started_at: new Date(args.startedAt).toISOString(),
    finished_at: new Date().toISOString(),
    property_tier: args.voice.tier,
    property_voice_anchor_override: args.voice.override,
    source_type: args.sourceType,
    settings: {
      stage4_thinking_budget: args.settings.stage4_thinking_budget,
      stage4_max_output_tokens: args.settings.stage4_max_output_tokens,
      // W11.8.1: failover_vendor stripped — emitted as null for backward-compat
      // with any audit-JSON consumer that grepped for the field.
      failover_vendor: null,
    },
    prompt_block_versions: stage4PromptBlockVersions(),
    vendor_used: args.vendorUsed,
    model_used: args.modelUsed,
    cost_usd: Number(args.costUsd.toFixed(6)),
    wall_ms: args.wallMs,
    failover_triggered: args.failoverTriggered,
    failover_reason: args.failoverReason,
    stage1_merged_count: args.stage1MergedCount,
    previews_count: args.previewsCount,
    overrides_persisted: args.overridesPersisted,
    output: args.output,
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

// ─── Prompt-block version map ───────────────────────────────────────────────

function stage4PromptBlockVersions(): Record<string, string> {
  return {
    stage4_prompt: STAGE4_PROMPT_VERSION,
    source_context: SOURCE_CONTEXT_BLOCK_VERSION,
    photographer_techniques: PHOTOGRAPHER_TECHNIQUES_BLOCK_VERSION,
    exif_context: EXIF_CONTEXT_BLOCK_VERSION,
    voice_anchor: VOICE_ANCHOR_BLOCK_VERSION,
    sydney_primer: SYDNEY_PRIMER_BLOCK_VERSION,
    self_critique: SELF_CRITIQUE_BLOCK_VERSION,
    canonical_registry: CANONICAL_REGISTRY_BLOCK_VERSION,
    slot_enumeration: SLOT_ENUMERATION_BLOCK_VERSION,
  };
}

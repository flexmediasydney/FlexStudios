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
 * ─── FAILOVER ─────────────────────────────────────────────────────────────────
 *
 * Gemini Stage 4 fails after 3 retries → fall back to Anthropic Opus 4.7 via
 * the W11.8 adapter when engine_settings.failover_vendor='anthropic'. Cost
 * spikes ~12× but the round completes.
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
} from './stage4Prompt.ts';

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

// Wave 11.7.1 immediate-ack contract (mirrors shortlisting-shape-d Stage 1):
// Stage 4 is typically ~70s but worst case (3 primary retries × 240s timeout
// + 14s backoff before Anthropic failover) can exceed the 120s gateway.
// We adopt the same EdgeRuntime.waitUntil pattern: validate + mutex + cost
// cap synchronously, return HTTP 200 ack with `mode: 'background'`, and
// self-update the dispatching shortlisting_jobs row when the work completes.
const BACKGROUND_MODE_RESPONSE = 'background';

interface RoundContext {
  round_id: string;
  project_id: string;
  status: string;
  property_tier: PropertyTier;
  property_voice_anchor_override: string | null;
  dropbox_root_path: string;
  property_facts: PropertyFacts;
}

interface EngineSettings {
  stage4_thinking_budget: number;
  stage4_max_output_tokens: number;
  failover_vendor: 'anthropic' | null;
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
    preflight = await preflightStage4(roundId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] preflight failed for round ${roundId}: ${msg}`);
    return errorResponse(`shortlisting-shape-d-stage4 preflight failed: ${msg}`, 400, req);
  }

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
      started_at: startedIso,
    },
    200,
    req,
  );
});

// ─── Core ───────────────────────────────────────────────────────────────────

interface Stage4RunResult {
  ok: boolean;
  vendor_used: 'google' | 'anthropic';
  model_used: string;
  cost_usd: number;
  wall_ms: number;
  failover_triggered: boolean;
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
async function preflightStage4(roundId: string): Promise<Stage4PreflightOk> {
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

  const voice: VoiceAnchorOpts = {
    tier: ctx.property_tier,
    override: ctx.property_voice_anchor_override,
  };
  const sourceType: SourceType = 'internal_raw';

  const lockName = `shape-d-stage4:${roundId}`;
  const tickId = crypto.randomUUID();
  const acquired = await tryAcquireMutex(admin, lockName, tickId);
  if (!acquired) {
    throw new Error(`round ${roundId} Stage 4 already running (mutex held)`);
  }

  return { ctx, settings, voice, sourceType, preflightWarnings, lockName, tickId, startedAt };
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
  const { ctx, settings, voice, sourceType, startedAt } = preflight;
  const warnings: string[] = [...preflight.preflightWarnings];

  {
    // Load Stage 1 merged JSON from composition_classifications + groups.
    const stage1Merged = await loadStage1Merged(admin, roundId);
    if (stage1Merged.length === 0) {
      throw new Error(
        `round ${roundId} has no composition_classifications — Stage 1 must succeed first`,
      );
    }

    // Cost cap pre-flight. Stage 4 envelope: ~$1.20 on Gemini, ~$14.40 on
    // Anthropic failover. Always under the default $10 cap on Gemini.
    const preflightUsd = estimateCost('google', PRIMARY_MODEL, {
      input_tokens: 60_000 + stage1Merged.length * 1_500,
      output_tokens: settings.stage4_max_output_tokens,
      cached_input_tokens: 0,
    });
    if (preflightUsd > settings.cost_cap_per_round_usd) {
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

    // Build the prompt.
    const systemText = [
      buildStage4SystemPrompt(),
      '',
      SYDNEY_PRIMER_BLOCK,
    ].join('\n');
    const userText = buildStage4UserPrompt({
      sourceContextBlockText: sourceContextBlock(sourceType),
      voiceBlockText: voiceAnchorBlock(voice),
      selfCritiqueBlockText: SELF_CRITIQUE_BLOCK,
      propertyFacts: ctx.property_facts,
      stage1Merged,
      imageStemsInOrder: previews.map((p) => p.stem),
      totalImages: previews.length,
    });

    // Call vision adapter with retries + Anthropic failover.
    const { resp, vendorUsed, modelUsed, costUsd, wallMs, inputTokens, outputTokens, failoverTriggered, failoverReason, error } =
      await callStage4WithFailover({
        systemText,
        userText,
        previews,
        settings,
      });

    if (!resp) {
      throw new Error(`Stage 4 vision call failed: ${error ?? 'unknown'}`);
    }

    // Parse output
    const output = resp.output as Record<string, unknown>;
    const masterListing = output.master_listing as Record<string, unknown> | undefined;
    const stage4Overrides = (output.stage_4_overrides as Array<Record<string, unknown>> | undefined) || [];
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

    // Persist master_listing
    const masterListingId = await persistMasterListing({
      admin,
      roundId,
      masterListing,
      propertyTier: ctx.property_tier,
      voiceAnchorUsed: ctx.property_voice_anchor_override ? 'override' : 'tier_preset',
      vendor: vendorUsed,
      modelVersion: modelUsed,
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
      finalEngineMode: failoverTriggered ? 'unified_anthropic_failover' : 'shape_d_full',
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
  const keys = [
    'stage4_thinking_budget',
    'stage4_max_output_tokens',
    'failover_vendor',
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
  const failoverRaw = map.get('failover_vendor');
  return {
    stage4_thinking_budget: num('stage4_thinking_budget', STAGE4_DEFAULT_THINKING_BUDGET),
    stage4_max_output_tokens: num('stage4_max_output_tokens', STAGE4_DEFAULT_MAX_OUTPUT_TOKENS),
    failover_vendor: failoverRaw === 'anthropic' ? 'anthropic' : null,
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
    .select('id, project_id, status, property_tier, property_voice_anchor_override')
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
  const property_facts: PropertyFacts = {
    address_line: (proj.property_address as string | null) ?? null,
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

  return {
    round_id: roundId,
    project_id: round.project_id as string,
    status: round.status as string,
    property_tier: propertyTier,
    property_voice_anchor_override: (round.property_voice_anchor_override as string | null) ?? null,
    dropbox_root_path: dropboxRoot,
    property_facts,
  };
}

// ─── Stage 1 merged JSON loader ──────────────────────────────────────────────

async function loadStage1Merged(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<Stage1MergedEntry[]> {
  const { data, error } = await admin
    .from('composition_classifications')
    .select(`
      group_id,
      analysis,
      room_type,
      composition_type,
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
        best_bracket_stem
      )
    `)
    .eq('round_id', roundId)
    .order('group_id');
  if (error) throw new Error(`composition_classifications load failed: ${error.message}`);

  const out: Stage1MergedEntry[] = [];
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
      composition_type: (row.composition_type as string | null) ?? null,
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
    });
  }
  // Sort by group_index for stable Stage 4 ordering.
  out.sort((a, b) => a.group_index - b.group_index);
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

// ─── Vision call with failover ──────────────────────────────────────────────

interface CallStage4Args {
  systemText: string;
  userText: string;
  previews: Array<{ stem: string; data: string; media_type: string }>;
  settings: EngineSettings;
}

interface CallStage4Result {
  resp: VisionResponse | null;
  vendorUsed: 'google' | 'anthropic';
  modelUsed: string;
  costUsd: number;
  wallMs: number;
  /** Vendor-reported input tokens for this call (0 if call failed). */
  inputTokens: number;
  /** Vendor-reported output tokens for this call (0 if call failed). */
  outputTokens: number;
  failoverTriggered: boolean;
  failoverReason: string | null;
  error: string | null;
}

async function callStage4WithFailover(args: CallStage4Args): Promise<CallStage4Result> {
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
  for (let attempt = 1; attempt <= STAGE4_RETRY_COUNT; attempt++) {
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
        failoverTriggered: false,
        failoverReason: null,
        error: null,
      };
    } catch (e) {
      if (e instanceof MissingVendorCredential) {
        // No point retrying — credentials are missing.
        return {
          resp: null, vendorUsed: PRIMARY_VENDOR, modelUsed: PRIMARY_MODEL,
          costUsd: 0, wallMs: Date.now() - start,
          inputTokens: 0, outputTokens: 0,
          failoverTriggered: false, failoverReason: null,
          error: e.message,
        };
      }
      if (e instanceof VendorCallError) {
        lastErr = `${e.vendor}/${e.model} ${e.status ?? ''}: ${e.message}`;
      } else {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      console.warn(`[${GENERATOR}] Stage 4 attempt ${attempt}/${STAGE4_RETRY_COUNT} failed: ${lastErr}`);
      // Exponential back-off between primary retries (2s, 4s, 8s).
      if (attempt < STAGE4_RETRY_COUNT) {
        await new Promise((r) => setTimeout(r, 2_000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  // Primary exhausted → failover to Anthropic if configured.
  if (args.settings.failover_vendor === 'anthropic') {
    console.warn(`[${GENERATOR}] Stage 4 failover to Anthropic Opus 4.7 after ${STAGE4_RETRY_COUNT} primary attempts`);
    try {
      const failReq: VisionRequest = { ...baseReq, vendor: 'anthropic', model: 'claude-opus-4-7' };
      const resp = await callVisionAdapter(failReq);
      return {
        resp,
        vendorUsed: 'anthropic',
        modelUsed: 'claude-opus-4-7',
        costUsd: resp.usage.estimated_cost_usd,
        wallMs: resp.vendor_meta.elapsed_ms || (Date.now() - start),
        inputTokens: resp.usage.input_tokens || 0,
        outputTokens: resp.usage.output_tokens || 0,
        failoverTriggered: true,
        failoverReason: lastErr,
        error: null,
      };
    } catch (failErr) {
      const fmsg = failErr instanceof Error ? failErr.message : String(failErr);
      return {
        resp: null,
        vendorUsed: 'anthropic',
        modelUsed: 'claude-opus-4-7',
        costUsd: 0,
        wallMs: Date.now() - start,
        inputTokens: 0, outputTokens: 0,
        failoverTriggered: true,
        failoverReason: lastErr,
        error: `primary_then_failover: primary=${lastErr} | failover=${fmsg}`,
      };
    }
  }

  return {
    resp: null,
    vendorUsed: PRIMARY_VENDOR,
    modelUsed: PRIMARY_MODEL,
    costUsd: 0,
    wallMs: Date.now() - start,
    inputTokens: 0, outputTokens: 0,
    failoverTriggered: false,
    failoverReason: null,
    error: lastErr,
  };
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

interface PersistMasterListingArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  masterListing: Record<string, unknown>;
  propertyTier: PropertyTier;
  voiceAnchorUsed: 'tier_preset' | 'override' | 'master_class_enhanced';
  vendor: 'google' | 'anthropic';
  modelVersion: string;
  warnings: string[];
}

async function persistMasterListing(args: PersistMasterListingArgs): Promise<string | null> {
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

  const wordCount = typeof args.masterListing.word_count === 'number'
    ? args.masterListing.word_count
    : null;
  const readingGrade = typeof args.masterListing.reading_grade_level === 'number'
    ? args.masterListing.reading_grade_level
    : null;

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

async function persistStage4Overrides(args: PersistStage4OverridesArgs): Promise<number> {
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

interface UpdateEngineRunAuditArgs {
  admin: ReturnType<typeof getAdminClient>;
  roundId: string;
  vendorUsed: 'google' | 'anthropic';
  modelUsed: string;
  failoverTriggered: boolean;
  failoverReason: string | null;
  stage4CostUsd: number;
  stage4WallMs: number;
  stage4InputTokens: number;
  stage4OutputTokens: number;
  promptBlockVersions: Record<string, string>;
  warnings: string[];
}

async function updateEngineRunAudit(args: UpdateEngineRunAuditArgs): Promise<void> {
  const { data: existingRaw } = await args.admin
    .from('engine_run_audit')
    .select(
      'engine_mode, vendor_used, stage1_total_cost_usd, stage1_total_wall_ms, ' +
      'stage1_total_input_tokens, stage1_total_output_tokens, ' +
      'stage4_total_cost_usd, stage4_total_wall_ms, stage4_call_count, ' +
      'stage4_total_input_tokens, stage4_total_output_tokens, ' +
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
  const priorStagesCompleted = (existing?.stages_completed as string[] | null) ?? [];
  const priorEngineMode = (existing?.engine_mode as string | null)
    ?? (args.failoverTriggered ? 'unified_anthropic_failover' : 'shape_d_full');
  const priorPromptBlockVersions =
    (existing?.prompt_block_versions as Record<string, string> | null) ?? {};

  const newStage4Cost = priorStage4Cost + args.stage4CostUsd;
  const newStage4Wall = Math.max(priorStage4Wall, args.stage4WallMs);
  const newStage4CostRounded = Math.round(newStage4Cost * 1_000_000) / 1_000_000;
  // Token attribution: accumulate across re-runs (W11.7 cleanup defect #4 fix).
  // Previously stage4_total_input_tokens / stage4_total_output_tokens were
  // never written here; callers saw NULL on the audit row even though the
  // vendor adapter returned the usage breakdown. Now we plumb resp.usage.*
  // through and accumulate. Stage 1 token totals come from the prior row
  // (Agent 2 owns shortlisting-shape-d Stage 1 token plumbing follow-up).
  const newStage4InputTokens = priorStage4InputTokens + args.stage4InputTokens;
  const newStage4OutputTokens = priorStage4OutputTokens + args.stage4OutputTokens;
  const totalCost = stage1Cost + newStage4Cost;
  const totalCostRounded = Math.round(totalCost * 1_000_000) / 1_000_000;
  const totalWall = stage1Wall + newStage4Wall;
  const totalInputTokens = stage1InputTokens + newStage4InputTokens;
  const totalOutputTokens = stage1OutputTokens + newStage4OutputTokens;

  const merged = Array.from(new Set([...priorStagesCompleted, 'stage4', 'persistence']));
  const finalEngineMode = args.failoverTriggered ? 'unified_anthropic_failover' : priorEngineMode;

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
    vendor_used: args.failoverTriggered
      ? 'anthropic'
      : ((existing?.vendor_used as string | null) ?? args.vendorUsed),
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
    args.warnings.push(`engine_run_audit Stage 4 update failed: ${error.message}`);
  }
}

// ─── Audit JSON ──────────────────────────────────────────────────────────────

interface UploadStage4AuditArgs {
  ctx: RoundContext;
  roundId: string;
  output: Record<string, unknown>;
  vendorUsed: 'google' | 'anthropic';
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
      failover_vendor: args.settings.failover_vendor,
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
    voice_anchor: VOICE_ANCHOR_BLOCK_VERSION,
    sydney_primer: SYDNEY_PRIMER_BLOCK_VERSION,
    self_critique: SELF_CRITIQUE_BLOCK_VERSION,
  };
}

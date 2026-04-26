/**
 * shortlisting-pass2
 * ───────────────────
 * Pass 2 orchestrator for the shortlisting engine.
 *
 * Runs AFTER `shortlisting-pass1` has classified every composition. Pass 2
 * makes the SHORTLIST DECISIONS in a single Sonnet call with full universe
 * context — every Pass 1 classification is packed into one prompt and the
 * model emits the proposed shortlist for the entire shoot in one response.
 *
 * Critical v2 architecture (do not deviate):
 *
 *   1. SINGLE SONNET CALL WITH FULL UNIVERSE (spec L4): Pass 2 is NOT
 *      concurrent. The model needs every classification visible to make
 *      relative selection decisions. Without the full universe, every image
 *      gets shortlisted because there's no competitive context.
 *
 *   2. THREE-PHASE OUTPUT (spec L5, §6): Phase 1 mandatory + Phase 2
 *      conditional + Phase 3 free recommendations bounded by package ceiling.
 *      Phase 1 and 2 slots come from shortlisting_slot_definitions.
 *
 *   3. TOP-3 PER SLOT (spec L13): every slot has a winner + 2 alternatives.
 *      Stored as separate shortlisting_events rows with rank=1/2/3.
 *
 *   4. STREAM B INJECTION (spec L8): same anchors as Pass 1 — score scale
 *      reference is consistent across passes.
 *
 *   5. MUTUAL EXCLUSIVITY ENFORCEMENT (spec L12): validator auto-fixes
 *      shortlist ∩ rejected_near_duplicates overlap before persistence.
 *
 *   6. PACKAGE CEILING ENFORCEMENT (spec L16): hard cap on shortlist size.
 *      Validator marks valid=false if exceeded; round stays in 'processing'
 *      so ops can retry.
 *
 * Body modes:
 *   { round_id: string }   — orchestrate the round (normal path)
 *   { job_id:   string }   — read round_id off a job row first (dispatcher)
 *
 * Auth: service_role OR master_admin / admin / manager.
 *
 * Persistence (no shortlist_proposals table — we store assignments as events):
 *   - composition_classifications.is_near_duplicate_candidate set TRUE for
 *     stems in rejected_near_duplicates
 *   - shortlisting_events row per slot assignment + per alternative, with
 *     payload={ slot_id, group_id, stem, rank (1/2/3), phase (1/2/3),
 *     justification (phase 3 only), source: 'pass2_slot_assigned' }
 *   - shortlisting_events row for phase3 recommendations (event_type=
 *     'pass2_phase3_recommendation')
 *   - shortlisting_rounds: phase1_filled_count, phase2_filled_count,
 *     phase3_added_count, pass2_cost_usd, coverage_notes
 *   - shortlisting_events row for the run summary (event_type='pass2_complete')
 *
 * Round status remains 'processing' on success — Pass 3 transitions to
 * 'proposed'.
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
  callClaudeVision,
  type VisionMessage,
} from '../_shared/anthropicVision.ts';
import { getActiveStreamBAnchors } from '../_shared/streamBInjector.ts';
import {
  buildPass2Prompt,
  type Pass2ClassificationRow,
  type Pass2SlotDefinition,
} from '../_shared/pass2Prompt.ts';
import {
  validatePass2Output,
  type Pass2Output,
} from '../_shared/pass2Validator.ts';
import { getActivePrompt } from '../_shared/promptLoader.ts';

const GENERATOR = 'shortlisting-pass2';

// ─── Constants ───────────────────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6';
// Audit defect #9: Premium (38-image) and Day-to-Dusk (31-image) packages can
// produce JSON responses approaching 4000 tokens (winners + 2x alternatives +
// rejected_near_duplicates + coverage_notes + slot_assignments). The previous
// 4000 cap could truncate Sonnet mid-JSON, causing parse failure and a Pass 2
// throw. 8192 gives 2x headroom; Sonnet 4-6 supports up to 8192 output tokens.
const SONNET_MAX_TOKENS = 8192;

// Default package ceilings per spec §12. Used as fallback when round.package_ceiling
// is null. Looked up by package_type case-insensitively.
const PACKAGE_CEILING_DEFAULTS: Record<string, number> = {
  'gold': 24,
  'day to dusk': 31,
  'premium': 38,
};

// ─── Types ───────────────────────────────────────────────────────────────────

interface RequestBody {
  round_id?: string;
  job_id?: string;
  _health_check?: boolean;
}

interface RoundContext {
  round_id: string;
  project_id: string;
  package_type: string;
  package_ceiling: number;
  property_address: string | null;
  tier: string;
}

interface Pass2RoundResult {
  total_classifications: number;
  shortlist_count: number;
  phase1_filled_count: number;
  phase2_filled_count: number;
  phase3_added_count: number;
  unfilled_slots: string[];
  rejected_near_duplicates_count: number;
  cost_usd: number;
  duration_ms: number;
  anchors_version: number;
  coverage_notes: string;
  warnings: string[];
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
    if (!['master_admin', 'admin', 'manager'].includes(user.role || '')) {
      return errorResponse('Forbidden', 403, req);
    }
  }

  let body: RequestBody = {};
  try {
    body = await req.json();
  } catch {
    /* empty body */
  }
  if (body._health_check) {
    return jsonResponse({ _version: 'v1.0', _fn: GENERATOR }, 200, req);
  }

  let roundId = body.round_id || null;
  if (!roundId && body.job_id) {
    const admin = getAdminClient();
    const { data: job } = await admin
      .from('shortlisting_jobs')
      .select('round_id')
      .eq('id', body.job_id)
      .maybeSingle();
    if (job?.round_id) roundId = job.round_id;
  }
  if (!roundId) return errorResponse('round_id (or job_id) required', 400, req);

  // Audit defect #42: project-access guard. master_admin/admin/service_role
  // pass through; manager/employee/contractor must own the project.
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

  try {
    const result = await runPass2(roundId);
    return jsonResponse({ ok: true, round_id: roundId, ...result }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for round ${roundId}: ${msg}`);
    return errorResponse(`pass2 failed: ${msg}`, 500, req);
  }
});

// ─── Core ────────────────────────────────────────────────────────────────────

async function runPass2(roundId: string): Promise<Pass2RoundResult> {
  const started = Date.now();
  const admin = getAdminClient();
  const warnings: string[] = [];

  // 1. Round + project lookup, status guard.
  const { data: round, error: roundErr } = await admin
    .from('shortlisting_rounds')
    .select('id, project_id, status, package_type, package_ceiling')
    .eq('id', roundId)
    .maybeSingle();
  if (roundErr) throw new Error(`round lookup failed: ${roundErr.message}`);
  if (!round) throw new Error(`round ${roundId} not found`);
  if (round.status !== 'processing') {
    throw new Error(
      `round ${roundId} status='${round.status}' — Pass 2 requires status='processing'`,
    );
  }

  // 1b. Idempotency cleanup — clear all state from any prior Pass 2 invocation
  // for this round so re-runs produce clean output. Without this:
  //   - pass2_slot_assigned events accumulate (multiple winners per slot)
  //   - pass2_phase3_recommendation events accumulate
  //   - is_near_duplicate_candidate flags stay TRUE on classifications that
  //     the new run no longer rejects
  //   - downstream Pass 3 + lock + swimlane double-count
  // The status guard above protects against accidental clears on a round in
  // 'proposed' or 'locked' state. Audit refs: defects #3, #4, #8, #33.
  const { error: evtCleanupErr } = await admin
    .from('shortlisting_events')
    .delete()
    .eq('round_id', roundId)
    .in('event_type', [
      'pass2_slot_assigned',
      'pass2_phase3_recommendation',
      'pass2_complete',
    ]);
  if (evtCleanupErr) {
    warnings.push(`pass2 idempotency event-cleanup failed: ${evtCleanupErr.message}`);
  }
  const { error: dupCleanupErr } = await admin
    .from('composition_classifications')
    .update({ is_near_duplicate_candidate: false })
    .eq('round_id', roundId)
    .eq('is_near_duplicate_candidate', true);
  if (dupCleanupErr) {
    warnings.push(`pass2 idempotency near-dup cleanup failed: ${dupCleanupErr.message}`);
  }

  // 2. Resolve package + project metadata for prompt context.
  const { data: project } = await admin
    .from('projects')
    .select('id, property_address, pricing_tier')
    .eq('id', round.project_id)
    .maybeSingle();

  const packageType = round.package_type || 'Gold';
  const packageCeiling =
    round.package_ceiling || PACKAGE_CEILING_DEFAULTS[packageType.toLowerCase()] || 24;
  const tier = (project?.pricing_tier || 'standard').toLowerCase();
  const ctx: RoundContext = {
    round_id: roundId,
    project_id: round.project_id,
    package_type: packageType,
    package_ceiling: packageCeiling,
    property_address: project?.property_address ?? null,
    tier,
  };

  // 3. Fetch all Pass 1 classifications + their composition_groups (stems).
  const classifications = await fetchClassifications(admin, roundId);
  if (classifications.length === 0) {
    throw new Error(
      `no composition_classifications for round ${roundId} — Pass 1 must complete before Pass 2`,
    );
  }

  // 4. Fetch active slot definitions for this package_type.
  const slotDefinitions = await fetchSlotDefinitions(admin, packageType);
  if (slotDefinitions.length === 0) {
    warnings.push(
      `no active slot_definitions for package='${packageType}' — Pass 2 will run with empty slot list (model can only do phase 3)`,
    );
  }

  // 5. Stream B anchors (consistent with Pass 1).
  const anchors = await getActiveStreamBAnchors();

  // 6. Build prompt. P8 follow-up: master_admin can override the system
  // message via SettingsShortlistingPrompts (mig 296 / promptLoader.ts).
  const builtPrompt = buildPass2Prompt({
    propertyAddress: ctx.property_address,
    packageType: ctx.package_type,
    packageCeiling: ctx.package_ceiling,
    tier: ctx.tier,
    slotDefinitions,
    streamBAnchors: anchors,
    classifications,
  });
  const dbSystem = await getActivePrompt('pass2_system');
  const prompt = dbSystem
    ? { ...builtPrompt, system: dbSystem.text }
    : builtPrompt;

  // 7. Single Sonnet call — text-only, no image part.
  const messages: VisionMessage[] = [
    {
      role: 'user',
      content: [{ type: 'text', text: prompt.userPrefix }],
    },
  ];

  let visionContent = '';
  let visionCostUsd = 0;
  try {
    const visionRes = await callClaudeVision({
      model: SONNET_MODEL,
      messages,
      system: prompt.system,
      max_tokens: SONNET_MAX_TOKENS,
      temperature: 0,
    });
    visionContent = visionRes.content;
    visionCostUsd = visionRes.costUsd;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logEvent(admin, ctx, 'pass2_call_failed', {
      error: msg,
      model: SONNET_MODEL,
    });
    throw new Error(`Sonnet call failed: ${msg}`);
  }

  // 8. Parse JSON.
  const parseResult = parsePass2Json(visionContent);
  if (!parseResult.ok) {
    await logEvent(admin, ctx, 'pass2_parse_failed', {
      error: parseResult.error,
      first_200: visionContent.slice(0, 200),
      model: SONNET_MODEL,
      cost_usd: visionCostUsd,
    });
    throw new Error(`pass2 JSON parse failed: ${parseResult.error}`);
  }

  // 9. Validate + auto-fix.
  const allFileStems = classifications.map((c) => c.stem);
  const mandatorySlotIds = slotDefinitions.filter((s) => s.phase === 1).map((s) => s.slot_id);
  const validation = validatePass2Output(parseResult.value, {
    packageCeiling: ctx.package_ceiling,
    mandatorySlotIds,
    allFileStems,
  });
  warnings.push(...validation.warnings);

  if (!validation.valid) {
    await logEvent(admin, ctx, 'pass2_validation_failed', {
      errors: validation.errors,
      warnings: validation.warnings,
      shortlist_count: validation.fixed.shortlist.length,
      ceiling: ctx.package_ceiling,
      cost_usd: visionCostUsd,
    });
    throw new Error(
      `pass2 validation failed: ${validation.errors.join('; ')} (round left in 'processing' for retry)`,
    );
  }

  const output = validation.fixed;

  // 10. Build stem → group_id map (so we can persist group_id alongside stem).
  const stemToGroupId = new Map<string, string>();
  const stemToClass = new Map<string, Pass2ClassificationRow>();
  for (const c of classifications) {
    stemToGroupId.set(c.stem, c.group_id);
    stemToClass.set(c.stem, c);
  }

  // 11. Persist near-duplicate flags.
  const nearDupGroupIds = output.rejected_near_duplicates
    .map((stem) => stemToGroupId.get(stem))
    .filter((id): id is string => Boolean(id));
  if (nearDupGroupIds.length > 0) {
    const { error: dupErr } = await admin
      .from('composition_classifications')
      .update({ is_near_duplicate_candidate: true })
      .in('group_id', nearDupGroupIds);
    if (dupErr) {
      warnings.push(`near-duplicate flag update failed: ${dupErr.message}`);
    }
  }

  // 12. Persist slot assignments + alternatives + phase3 recommendations as
  //     shortlisting_events rows. We don't have a shortlist_proposals table;
  //     events serve as the proposal record (Phase 6 swimlane reads them).
  const slotEvents: Array<Record<string, unknown>> = [];

  // Build a phase lookup table: slot_id → phase
  const slotPhaseById = new Map<string, number>();
  for (const s of slotDefinitions) slotPhaseById.set(s.slot_id, s.phase);

  // Phase 1 + 2 slot winners
  let phase1Filled = 0;
  let phase2Filled = 0;
  for (const [slotId, val] of Object.entries(output.slot_assignments)) {
    const stems = Array.isArray(val) ? val : [val];
    const phase = slotPhaseById.get(slotId) ?? 0;
    if (phase === 1) phase1Filled++;
    else if (phase === 2) phase2Filled++;

    for (const stem of stems) {
      const gid = stemToGroupId.get(stem);
      if (!gid) {
        warnings.push(`could not resolve group_id for slot_assignments.${slotId} stem=${stem}`);
        continue;
      }
      slotEvents.push(buildSlotEventRow(ctx, {
        slot_id: slotId,
        group_id: gid,
        stem,
        rank: 1,
        phase,
        kind: 'winner',
      }));
    }
  }

  // Slot alternatives (rank 2 + 3)
  for (const [slotId, alts] of Object.entries(output.slot_alternatives)) {
    const phase = slotPhaseById.get(slotId) ?? 0;
    for (let i = 0; i < alts.length; i++) {
      const stem = alts[i];
      const gid = stemToGroupId.get(stem);
      if (!gid) {
        warnings.push(`could not resolve group_id for slot_alternatives.${slotId} stem=${stem}`);
        continue;
      }
      slotEvents.push(buildSlotEventRow(ctx, {
        slot_id: slotId,
        group_id: gid,
        stem,
        rank: i + 2, // i=0 → rank 2, i=1 → rank 3
        phase,
        kind: 'alternative',
      }));
    }
  }

  // Phase 3 recommendations — separate event type because they have no slot_id
  let phase3Count = 0;
  for (const rec of output.phase3_recommendations) {
    const gid = stemToGroupId.get(rec.file);
    if (!gid) {
      warnings.push(`could not resolve group_id for phase3 stem=${rec.file}`);
      continue;
    }
    phase3Count++;
    slotEvents.push({
      project_id: ctx.project_id,
      round_id: ctx.round_id,
      group_id: gid,
      event_type: 'pass2_phase3_recommendation',
      actor_type: 'system',
      payload: {
        stem: rec.file,
        rank: rec.rank,
        justification: rec.justification,
        phase: 3,
      },
    });
  }

  if (slotEvents.length > 0) {
    // Insert in a single batch — shortlisting_events is append-only.
    const { error: evtErr } = await admin
      .from('shortlisting_events')
      .insert(slotEvents);
    if (evtErr) {
      warnings.push(`slot/phase3 events batch insert failed: ${evtErr.message}`);
    }
  }

  // 13. Update round counters + cost + coverage_notes (status stays 'processing').
  // Audit defect #5: pass2_cost_usd was OVERWRITTEN on retry, losing the prior
  // run's cost. Sum across retries so totals reflect the true Sonnet spend.
  const { data: priorRound } = await admin
    .from('shortlisting_rounds')
    .select('pass2_cost_usd')
    .eq('id', ctx.round_id)
    .maybeSingle();
  const priorPass2Cost = typeof priorRound?.pass2_cost_usd === 'number' ? priorRound.pass2_cost_usd : 0;
  const accumulatedCost = priorPass2Cost + visionCostUsd;
  const roundedCost = Math.round(accumulatedCost * 1_000_000) / 1_000_000;
  const { error: roundUpdErr } = await admin
    .from('shortlisting_rounds')
    .update({
      pass2_cost_usd: roundedCost,
      phase1_filled_count: phase1Filled,
      phase2_filled_count: phase2Filled,
      phase3_added_count: phase3Count,
      coverage_notes: output.coverage_notes,
    })
    .eq('id', ctx.round_id);
  if (roundUpdErr) warnings.push(`round update failed: ${roundUpdErr.message}`);

  // 14. pass2_complete summary event.
  await logEvent(admin, ctx, 'pass2_complete', {
    shortlist_count: output.shortlist.length,
    phase1_filled: phase1Filled,
    phase2_filled: phase2Filled,
    phase3_added: phase3Count,
    unfilled_slots: output.unfilled_slots,
    rejected_near_duplicates_count: output.rejected_near_duplicates.length,
    cost_usd: roundedCost,
    model_version: SONNET_MODEL,
    anchors_version: anchors.version,
    package_ceiling: ctx.package_ceiling,
    package_type: ctx.package_type,
    coverage_notes_length: output.coverage_notes.length,
    warnings_count: warnings.length,
    warnings_sample: warnings.slice(0, 5),
  });

  return {
    total_classifications: classifications.length,
    shortlist_count: output.shortlist.length,
    phase1_filled_count: phase1Filled,
    phase2_filled_count: phase2Filled,
    phase3_added_count: phase3Count,
    unfilled_slots: output.unfilled_slots,
    rejected_near_duplicates_count: output.rejected_near_duplicates.length,
    cost_usd: roundedCost,
    duration_ms: Date.now() - started,
    anchors_version: anchors.version,
    coverage_notes: output.coverage_notes,
    warnings,
  };
}

// ─── DB fetch helpers ────────────────────────────────────────────────────────

async function fetchClassifications(
  admin: ReturnType<typeof getAdminClient>,
  roundId: string,
): Promise<Pass2ClassificationRow[]> {
  // Join composition_classifications with composition_groups to get the stem
  // (we use delivery_reference_stem since that's the editor's canonical name,
  // falling back to best_bracket_stem if delivery_ref isn't set).
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
      combined_score,
      is_styled,
      indoor_outdoor_visible,
      is_drone,
      is_exterior,
      eligible_for_exterior_rear,
      clutter_severity,
      flag_for_retouching,
      composition_groups!composition_classifications_group_id_fkey(
        group_index,
        delivery_reference_stem,
        best_bracket_stem
      )
    `)
    .eq('round_id', roundId);

  if (error) {
    throw new Error(`fetchClassifications failed: ${error.message}`);
  }
  if (!data) return [];

  // deno-lint-ignore no-explicit-any
  return data.map((r: any) => {
    const grp = Array.isArray(r.composition_groups) ? r.composition_groups[0] : r.composition_groups;
    const stem = grp?.delivery_reference_stem || grp?.best_bracket_stem || `group_${grp?.group_index ?? '?'}`;
    return {
      stem,
      group_id: r.group_id,
      group_index: grp?.group_index ?? 0,
      room_type: r.room_type,
      composition_type: r.composition_type,
      vantage_point: r.vantage_point,
      technical_score: r.technical_score,
      lighting_score: r.lighting_score,
      composition_score: r.composition_score,
      aesthetic_score: r.aesthetic_score,
      combined_score: r.combined_score,
      is_styled: r.is_styled,
      indoor_outdoor_visible: r.indoor_outdoor_visible,
      is_drone: r.is_drone,
      is_exterior: r.is_exterior,
      eligible_for_exterior_rear: r.eligible_for_exterior_rear,
      clutter_severity: r.clutter_severity,
      flag_for_retouching: r.flag_for_retouching,
      analysis: r.analysis,
    } as Pass2ClassificationRow;
  });
}

async function fetchSlotDefinitions(
  admin: ReturnType<typeof getAdminClient>,
  packageType: string,
): Promise<Pass2SlotDefinition[]> {
  // Filter by is_active AND package_types either empty (= all) or contains
  // the round's package_type. We do the filter in JS rather than the
  // PostgREST `.contains()` call so empty-arrays-mean-all is honoured.
  const { data, error } = await admin
    .from('shortlisting_slot_definitions')
    .select('slot_id, display_name, phase, package_types, eligible_room_types, max_images, min_images, notes, version')
    .eq('is_active', true);
  if (error) {
    throw new Error(`fetchSlotDefinitions failed: ${error.message}`);
  }
  if (!data) return [];

  const matchPkg = packageType.toLowerCase();
  // deno-lint-ignore no-explicit-any
  const filtered = (data as any[]).filter((row) => {
    const pkgs: string[] = Array.isArray(row.package_types) ? row.package_types : [];
    if (pkgs.length === 0) return true; // empty = all packages
    return pkgs.some((p) => String(p).toLowerCase() === matchPkg);
  });

  // Take latest version per slot_id (defensive — multiple versions may be active).
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
    } as Pass2SlotDefinition & { version: number };
    const existing = byId.get(cand.slot_id);
    if (!existing || cand.version > existing.version) byId.set(cand.slot_id, cand);
  }

  // Stable order: phase asc, then slot_id alpha.
  return Array.from(byId.values())
    .map(({ version: _v, ...rest }) => rest)
    .sort((a, b) => (a.phase - b.phase) || a.slot_id.localeCompare(b.slot_id));
}

// ─── Persistence helpers ─────────────────────────────────────────────────────

interface SlotEventInput {
  slot_id: string;
  group_id: string;
  stem: string;
  rank: number;
  phase: number;
  kind: 'winner' | 'alternative';
}

function buildSlotEventRow(ctx: RoundContext, e: SlotEventInput): Record<string, unknown> {
  return {
    project_id: ctx.project_id,
    round_id: ctx.round_id,
    group_id: e.group_id,
    event_type: 'pass2_slot_assigned',
    actor_type: 'system',
    payload: {
      slot_id: e.slot_id,
      stem: e.stem,
      rank: e.rank,
      phase: e.phase,
      kind: e.kind,
    },
  };
}

async function logEvent(
  admin: ReturnType<typeof getAdminClient>,
  ctx: { project_id: string; round_id: string },
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin
    .from('shortlisting_events')
    .insert({
      project_id: ctx.project_id,
      round_id: ctx.round_id,
      event_type: eventType,
      actor_type: 'system',
      payload,
    });
  if (error) {
    console.warn(`[${GENERATOR}] event '${eventType}' insert failed: ${error.message}`);
  }
}

// ─── JSON parsing ────────────────────────────────────────────────────────────

interface ParseSuccess { ok: true; value: Pass2Output }
interface ParseFailure { ok: false; error: string }
type ParseResult = ParseSuccess | ParseFailure;

/**
 * Lenient JSON extractor — strips ``` fences and surrounding chatter that
 * Sonnet occasionally emits despite "ONLY valid JSON" instructions. The
 * structural validation (mutual exclusivity, ceiling, etc.) happens in
 * pass2Validator; here we just need a parseable object with the right
 * shape.
 */
function parsePass2Json(text: string): ParseResult {
  if (!text) return { ok: false, error: 'empty response' };
  let body = text.trim();

  const fenceMatch = body.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) body = fenceMatch[1].trim();

  const braceStart = body.indexOf('{');
  const braceEnd = body.lastIndexOf('}');
  if (braceStart === -1 || braceEnd === -1 || braceEnd <= braceStart) {
    return { ok: false, error: 'no JSON object found' };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body.slice(braceStart, braceEnd + 1));
  } catch (err) {
    return { ok: false, error: `JSON.parse: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'parsed value is not an object' };
  }

  // We accept whatever shape the model emits — the validator will defensively
  // coerce arrays/objects/strings. Required surface check: at minimum,
  // shortlist must be present (even if empty array). If shortlist isn't there
  // at all, the response is unusable.
  if (!('shortlist' in parsed)) {
    return { ok: false, error: 'missing required field: shortlist' };
  }

  return { ok: true, value: parsed as unknown as Pass2Output };
}

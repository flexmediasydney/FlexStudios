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
import {
  filterSlotsForRound,
  resolvePackageEngineRoles,
  type ProductRow,
  type SlotDefinitionRow,
  type EngineRole,
} from '../_shared/slotEligibility.ts';

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

  // 4. Fetch active slot definitions for this round.
  //    W7.8: prefer the product-driven engine_role path (resolve project →
  //    package → products → engine_roles → slots whose
  //    eligible_when_engine_roles overlap). Fall back to the legacy
  //    package_types substring match for slot rows that haven't been
  //    backfilled yet (defensive coding during the W7.8 transition).
  const slotFetch = await fetchSlotDefinitions(admin, {
    projectId: round.project_id,
    packageType,
  });
  const slotDefinitions = slotFetch.slots;
  if (slotFetch.projectEngineRoles.length > 0) {
    warnings.push(
      `pass2 slot eligibility: project_engine_roles=[${slotFetch.projectEngineRoles.join(',')}] (W7.8 product-driven path)`,
    );
  } else if (slotFetch.engineRolePathFallback) {
    warnings.push(
      `pass2 slot eligibility: engine-role lookup yielded zero roles (no products with engine_role on this package's product list) — falling back to legacy package_types match for package='${packageType}'`,
    );
  }
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

interface FetchSlotDefinitionsOpts {
  projectId: string;
  packageType: string;
}

interface FetchSlotDefinitionsResult {
  slots: Pass2SlotDefinition[];
  projectEngineRoles: EngineRole[];
  /** True when the engine-role lookup produced zero roles AND we therefore
   *  rely entirely on the legacy package_types substring fallback for this
   *  round. Used by the caller to surface a warning. */
  engineRolePathFallback: boolean;
}

async function fetchSlotDefinitions(
  admin: ReturnType<typeof getAdminClient>,
  opts: FetchSlotDefinitionsOpts,
): Promise<FetchSlotDefinitionsResult> {
  const { projectId, packageType } = opts;

  // ─── Step 1: resolve project → package → products → engine_roles ─────────
  //
  // We use `projects.packages` JSONB which carries [{package_id, quantity,
  // products[]}] (see migration 001 line 362). Each entry has a `products`
  // array that mirrors `packages.products`; either source works, but the
  // project-embedded copy is what was committed at booking time and is more
  // reliable than re-deriving from the live packages table (which marketing
  // may have edited since).
  //
  // If `projects.packages` is empty (legacy projects before the JSONB
  // copy-down was wired up), fall back to looking up the live package by
  // name from `packages` table using packageType as the key.
  const projectEngineRoles = await resolveProjectEngineRoles(
    admin,
    projectId,
    packageType,
  );

  // ─── Step 2: fetch active slot definitions ───────────────────────────────
  const { data, error } = await admin
    .from('shortlisting_slot_definitions')
    .select(
      'slot_id, display_name, phase, package_types, eligible_when_engine_roles, eligible_room_types, max_images, min_images, notes, version',
    )
    .eq('is_active', true);
  if (error) {
    throw new Error(`fetchSlotDefinitions failed: ${error.message}`);
  }
  if (!data) {
    return { slots: [], projectEngineRoles, engineRolePathFallback: false };
  }

  // ─── Step 3: filter by engine_role overlap (with package_types fallback) ─
  // Pure resolver — see _shared/slotEligibility.ts for the rule.
  // deno-lint-ignore no-explicit-any
  const slotRows = (data as any[]) as SlotDefinitionRow[];
  const filteredRows = filterSlotsForRound({
    slots: slotRows,
    projectEngineRoles,
    roundPackageName: packageType,
  });

  // ─── Step 4: dedupe by latest version per slot_id ────────────────────────
  const byId = new Map<string, Pass2SlotDefinition & { version: number }>();
  for (const row of filteredRows) {
    const cand = {
      slot_id: String(row.slot_id),
      display_name: String(row.display_name ?? ''),
      phase: Number(row.phase ?? 2) as 1 | 2 | 3,
      eligible_room_types: Array.isArray(row.eligible_room_types)
        ? (row.eligible_room_types as string[])
        : [],
      max_images: Number(row.max_images ?? 1),
      min_images: Number(row.min_images ?? 0),
      notes: row.notes != null ? String(row.notes) : null,
      version: Number(row.version ?? 1),
    } as Pass2SlotDefinition & { version: number };
    const existing = byId.get(cand.slot_id);
    if (!existing || cand.version > existing.version) byId.set(cand.slot_id, cand);
  }

  const slots = Array.from(byId.values())
    .map(({ version: _v, ...rest }) => rest)
    .sort((a, b) => (a.phase - b.phase) || a.slot_id.localeCompare(b.slot_id));

  // engineRolePathFallback: true when projectEngineRoles is empty AND there
  // are slots that depended on the package_types fallback to be included.
  // We compute this by checking if any of the included rows had non-empty
  // eligible_when_engine_roles — if NONE did, every match came via fallback.
  const anyEngineRoleMatch = filteredRows.some((r) =>
    Array.isArray(r.eligible_when_engine_roles) && r.eligible_when_engine_roles.length > 0
  );
  const engineRolePathFallback =
    projectEngineRoles.length === 0 || !anyEngineRoleMatch;

  return { slots, projectEngineRoles, engineRolePathFallback };
}

/**
 * Resolve a project's engine-role union via:
 *   projects.packages JSONB → product_ids → products.engine_role
 *
 * Falls back to the live `packages` table (matched by name = packageType)
 * if the project carries no embedded packages JSONB. Returns [] if both
 * paths yield nothing — caller is expected to fall back to package_types.
 */
async function resolveProjectEngineRoles(
  admin: ReturnType<typeof getAdminClient>,
  projectId: string,
  packageType: string | null,
): Promise<EngineRole[]> {
  // ─── Path 1: projects.packages JSONB ─────────────────────────────────────
  const { data: project, error: projErr } = await admin
    .from('projects')
    .select('packages')
    .eq('id', projectId)
    .maybeSingle();
  if (projErr) {
    // Don't blow up the round on a transient project lookup failure — Pass 2
    // can still run via the legacy fallback. Log so the warning surfaces.
    console.warn(`[${GENERATOR}] project fetch for engine_role resolution failed: ${projErr.message}`);
    return [];
  }

  const productIds = new Set<string>();
  // deno-lint-ignore no-explicit-any
  const projectPackages: any[] = Array.isArray((project as any)?.packages)
    // deno-lint-ignore no-explicit-any
    ? ((project as any).packages as any[])
    : [];
  for (const pkg of projectPackages) {
    if (!pkg) continue;
    const embedded = Array.isArray(pkg.products) ? pkg.products : [];
    for (const ent of embedded) {
      if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
    }
  }

  // ─── Path 2: fallback to live packages table by name = packageType ───────
  // Triggered when projects.packages JSONB is empty (legacy bookings) or
  // when the embedded products list has no product_ids.
  if (productIds.size === 0 && packageType) {
    const { data: pkgRows, error: pkgErr } = await admin
      .from('packages')
      .select('id, name, products')
      .eq('is_active', true);
    if (pkgErr) {
      console.warn(`[${GENERATOR}] packages fetch for engine_role resolution failed: ${pkgErr.message}`);
    } else if (pkgRows) {
      // Substring match (defect #53 parity).
      const target = String(packageType).toLowerCase().trim();
      // deno-lint-ignore no-explicit-any
      for (const row of pkgRows as any[]) {
        const name = String(row.name || '').toLowerCase().trim();
        if (!name) continue;
        const isMatch = name === target || name.includes(target) || target.includes(name);
        if (!isMatch) continue;
        const embedded = Array.isArray(row.products) ? row.products : [];
        for (const ent of embedded) {
          if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
        }
      }
    }
  }

  if (productIds.size === 0) return [];

  // ─── Path 3: products lookup → engine_role union ─────────────────────────
  const { data: prodRows, error: prodErr } = await admin
    .from('products')
    .select('id, engine_role, is_active')
    .in('id', Array.from(productIds));
  if (prodErr) {
    console.warn(`[${GENERATOR}] products fetch for engine_role resolution failed: ${prodErr.message}`);
    return [];
  }
  if (!prodRows) return [];

  const productsList: ProductRow[] = (prodRows as ProductRow[]).map((p) => ({
    id: String(p.id),
    engine_role: p.engine_role ?? null,
    is_active: p.is_active === true,
  }));

  // Reuse the pure resolver to keep semantics in lockstep with the unit tests.
  return resolvePackageEngineRoles(
    Array.from(productIds).map((id) => ({ product_id: id })),
    productsList,
  );
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

  // Burst 7 M5: same multi-fence resolution as Pass 1 (L2). Sonnet sometimes
  // wraps coverage_notes prose in one fence and the JSON in another; pick the
  // fence containing `{` rather than the first fence.
  const fenceMatches = Array.from(body.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi));
  if (fenceMatches.length > 0) {
    const jsonFence = fenceMatches.find((m) => m[1].includes('{'));
    body = (jsonFence ?? fenceMatches[0])[1].trim();
  }

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

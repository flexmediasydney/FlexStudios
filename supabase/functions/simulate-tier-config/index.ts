/**
 * simulate-tier-config
 * ────────────────────
 * Wave 8 (W8.3) — re-simulation safeguard for proposed tier_config drafts.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §5.
 *
 * Re-runs the slot-assignment math against the last 30 LOCKED rounds for the
 * draft's tier, using the draft's dimension_weights + signal_weights +
 * hard_reject_thresholds. Returns a per-round diff (which slot winners
 * change, score deltas, file_stems) so the admin can preview the impact
 * before activating the draft.
 *
 * Cost: zero LLM calls. The slot-assignment is a pure function over the
 * persisted Pass 1 dimension scores. Edge-fn compute time only — capped by
 * the 30-round limit (sub-5s on warm DB per spec §5).
 *
 * POST { draft_tier_config_id: string, tier_id?: string }
 *   - draft_tier_config_id: the row id of the draft (is_active=FALSE row).
 *   - tier_id (optional): the engine tier id; if omitted, derived from the
 *     draft's tier_id column.
 *
 * Auth: master_admin OR admin (admins can simulate; only master_admin can
 * actually activate via update-tier-config).
 *
 * Response:
 *   {
 *     ok: true,
 *     draft_tier_config_id: string,
 *     tier_id: string,
 *     rounds_replayed: number,
 *     total_slots: number,
 *     unchanged_count: number,
 *     changed_count: number,
 *     rounds: SimulationRoundDiff[],
 *   }
 *
 * Implementation:
 *   1. Load the draft tier_config row.
 *   2. SELECT last 30 rounds with status='locked' AND
 *      engine_tier_id=draft.tier_id AND tier_config_version IS NOT NULL,
 *      ORDER BY locked_at DESC.
 *   3. For each round:
 *      a. Load classifications + composition_groups (file_stems + group_index).
 *      b. Recompute combined_score per row using the draft's dimension_weights.
 *      c. Load active slot definitions (filtered by the round's engine roles).
 *      d. Run pure slotAssignment.assignSlots with the recomputed scores +
 *         draft.hard_reject_thresholds.
 *      e. Compare against the round's actual locked winners
 *         (pass2_slot_assigned events with rank=1).
 *   4. Aggregate diffs and return.
 *
 * No DB writes — pure read-only operation.
 */

import {
  errorResponse,
  getAdminClient,
  getUserFromReq,
  handleCors,
  jsonResponse,
  serveWithAudit,
} from '../_shared/supabase.ts';
import {
  computeWeightedScore,
  DEFAULT_DIMENSION_WEIGHTS,
  type DimensionWeights,
} from '../_shared/scoreRollup.ts';
import {
  assignSlots,
  diffSlotAssignments,
  type SlotCandidate,
  type SlotForAssignment,
} from '../_shared/slotAssignment.ts';
import {
  filterSlotsForRound,
  resolvePackageEngineRoles,
  type EngineRole,
  type ProductRow,
  type SlotDefinitionRow,
} from '../_shared/slotEligibility.ts';

const GENERATOR = 'simulate-tier-config';
const REPLAY_ROUND_LIMIT = 30;

interface RequestBody {
  draft_tier_config_id?: string;
  tier_id?: string;
  _health_check?: boolean;
}

interface DraftTierConfigRow {
  id: string;
  tier_id: string;
  version: number;
  dimension_weights: Record<string, number>;
  signal_weights: Record<string, number>;
  hard_reject_thresholds: Record<string, number> | null;
  is_active: boolean;
  notes: string | null;
}

interface SimulationRoundDiff {
  round_id: string;
  round_number: number | null;
  project_id: string;
  project_address: string | null;
  locked_at: string | null;
  tier_config_version_at_lock: number | null;
  unchanged_count: number;
  changed_count: number;
  diffs: Array<{
    slot_id: string;
    winner_old_group_id: string | null;
    winner_new_group_id: string | null;
    winner_old_stem: string | null;
    winner_new_stem: string | null;
    winner_old_combined_score: number | null;
    winner_new_combined_score: number | null;
    changed: boolean;
  }>;
}

serveWithAudit(GENERATOR, async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== 'POST') return errorResponse('Method not allowed', 405, req);

  // Auth — master_admin or admin only.
  const user = await getUserFromReq(req).catch(() => null);
  const isService = user?.id === '__service_role__';
  if (!isService) {
    if (!user) return errorResponse('Authentication required', 401, req);
    if (!['master_admin', 'admin'].includes(user.role || '')) {
      return errorResponse('Forbidden — master_admin or admin only', 403, req);
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

  const draftId = body.draft_tier_config_id;
  if (!draftId || typeof draftId !== 'string') {
    return errorResponse('draft_tier_config_id required', 400, req);
  }

  try {
    const result = await runSimulation(draftId);
    return jsonResponse({ ok: true, ...result }, 200, req);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[${GENERATOR}] failed for draft ${draftId}: ${msg}`);
    return errorResponse(`simulate-tier-config failed: ${msg}`, 500, req);
  }
});

interface SimulationResult {
  draft_tier_config_id: string;
  draft_version: number;
  tier_id: string;
  tier_code: string | null;
  rounds_replayed: number;
  total_slots: number;
  unchanged_count: number;
  changed_count: number;
  hard_rejected_total: number;
  rounds: SimulationRoundDiff[];
}

async function runSimulation(draftId: string): Promise<SimulationResult> {
  const admin = getAdminClient();

  // ── 1. Load draft tier_config ────────────────────────────────────────────
  const { data: draftRow, error: draftErr } = await admin
    .from('shortlisting_tier_configs')
    .select(
      'id, tier_id, version, dimension_weights, signal_weights, hard_reject_thresholds, is_active, notes',
    )
    .eq('id', draftId)
    .maybeSingle();
  if (draftErr) throw new Error(`draft tier_config lookup failed: ${draftErr.message}`);
  if (!draftRow) throw new Error(`draft tier_config not found: ${draftId}`);
  const draft = draftRow as DraftTierConfigRow;

  // Pull tier_code for the response (UI displays it).
  const { data: tierRow } = await admin
    .from('shortlisting_tiers')
    .select('id, tier_code')
    .eq('id', draft.tier_id)
    .maybeSingle();
  const tierCode: string | null = tierRow?.tier_code ?? null;

  // ── 2. Load last 30 locked rounds for this tier ──────────────────────────
  // Filter on tier_config_version IS NOT NULL: pre-W8 rounds can't be
  // replayed because we don't have the old weight set to compare against.
  const { data: roundRows, error: roundsErr } = await admin
    .from('shortlisting_rounds')
    .select(
      'id, round_number, project_id, locked_at, engine_tier_id, tier_config_version, package_type',
    )
    .eq('status', 'locked')
    .eq('engine_tier_id', draft.tier_id)
    .not('tier_config_version', 'is', null)
    .order('locked_at', { ascending: false })
    .limit(REPLAY_ROUND_LIMIT);
  if (roundsErr) throw new Error(`rounds lookup failed: ${roundsErr.message}`);
  const rounds = (roundRows || []) as Array<{
    id: string;
    round_number: number | null;
    project_id: string;
    locked_at: string | null;
    engine_tier_id: string | null;
    tier_config_version: number | null;
    package_type: string | null;
  }>;

  // Build dimension_weights record from draft (defensive defaults for any
  // missing keys).
  const draftWeights: DimensionWeights = {
    technical: numericOrDefault(draft.dimension_weights?.technical, DEFAULT_DIMENSION_WEIGHTS.technical),
    lighting: numericOrDefault(draft.dimension_weights?.lighting, DEFAULT_DIMENSION_WEIGHTS.lighting),
    composition: numericOrDefault(draft.dimension_weights?.composition, DEFAULT_DIMENSION_WEIGHTS.composition),
    aesthetic: numericOrDefault(draft.dimension_weights?.aesthetic, DEFAULT_DIMENSION_WEIGHTS.aesthetic),
  };

  // ── 3. Pre-load global resources ─────────────────────────────────────────
  // Slot definitions are global (filtered per-round by engine_role overlap);
  // load once.
  const { data: allSlots, error: slotsErr } = await admin
    .from('shortlisting_slot_definitions')
    .select(
      'slot_id, display_name, phase, eligible_when_engine_roles, eligible_room_types, max_images, min_images, notes, version, is_active',
    )
    .eq('is_active', true);
  if (slotsErr) throw new Error(`slot_definitions lookup failed: ${slotsErr.message}`);
  const slotRows = (allSlots || []) as SlotDefinitionRow[];

  // Products catalog for engine_role resolution (also global).
  const { data: products } = await admin
    .from('products')
    .select('id, engine_role, is_active');
  const productsList: ProductRow[] = (products || []).map((p: Record<string, unknown>) => ({
    id: String(p.id),
    engine_role: (p.engine_role as string | null) ?? null,
    is_active: p.is_active === true,
  }));

  // ── 4. Per-round replay ──────────────────────────────────────────────────
  const roundDiffs: SimulationRoundDiff[] = [];
  let totalSlots = 0;
  let totalUnchanged = 0;
  let totalChanged = 0;
  let totalHardRejected = 0;

  for (const round of rounds) {
    try {
      const diff = await replayRound(admin, round, draftWeights, draft.hard_reject_thresholds, slotRows, productsList);
      roundDiffs.push(diff);
      totalSlots += diff.diffs.length;
      totalUnchanged += diff.unchanged_count;
      totalChanged += diff.changed_count;
    } catch (err) {
      // A single round failing shouldn't abort the simulation — emit a
      // round entry with empty diffs and a note.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${GENERATOR}] round replay failed for ${round.id}: ${msg}`);
      roundDiffs.push({
        round_id: round.id,
        round_number: round.round_number,
        project_id: round.project_id,
        project_address: null,
        locked_at: round.locked_at,
        tier_config_version_at_lock: round.tier_config_version,
        unchanged_count: 0,
        changed_count: 0,
        diffs: [],
      });
    }
  }

  return {
    draft_tier_config_id: draft.id,
    draft_version: draft.version,
    tier_id: draft.tier_id,
    tier_code: tierCode,
    rounds_replayed: roundDiffs.length,
    total_slots: totalSlots,
    unchanged_count: totalUnchanged,
    changed_count: totalChanged,
    hard_rejected_total: totalHardRejected,
    rounds: roundDiffs,
  };
}

async function replayRound(
  admin: ReturnType<typeof getAdminClient>,
  round: {
    id: string;
    round_number: number | null;
    project_id: string;
    locked_at: string | null;
    engine_tier_id: string | null;
    tier_config_version: number | null;
    package_type: string | null;
  },
  draftWeights: DimensionWeights,
  hardRejectThresholds: Record<string, number> | null,
  allSlotRows: SlotDefinitionRow[],
  productsList: ProductRow[],
): Promise<SimulationRoundDiff> {
  // Project address (for the diff UI display).
  const { data: project } = await admin
    .from('projects')
    .select('id, property_address, packages, products')
    .eq('id', round.project_id)
    .maybeSingle();
  const propertyAddress = project?.property_address ?? null;

  // Resolve project engine_roles (same logic Pass 2 uses).
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
  // deno-lint-ignore no-explicit-any
  const projectProducts: any[] = Array.isArray((project as any)?.products)
    // deno-lint-ignore no-explicit-any
    ? ((project as any).products as any[])
    : [];
  for (const ent of projectProducts) {
    if (ent && typeof ent.product_id === 'string') productIds.add(ent.product_id);
  }
  const projectEngineRoles: EngineRole[] = resolvePackageEngineRoles(
    Array.from(productIds).map((id) => ({ product_id: id })),
    productsList,
  );

  // Filter slots by engine_role overlap.
  const filteredSlotRows = filterSlotsForRound({
    slots: allSlotRows,
    projectEngineRoles,
    roundPackageName: null,
  });
  const slots: SlotForAssignment[] = filteredSlotRows.map((s) => ({
    slot_id: String(s.slot_id),
    display_name: s.display_name != null ? String(s.display_name) : null,
    phase: Number(s.phase ?? 2) as 1 | 2 | 3,
    eligible_room_types: Array.isArray(s.eligible_room_types) ? s.eligible_room_types as string[] : [],
    max_images: Number(s.max_images ?? 1),
    min_images: Number(s.min_images ?? 0),
    notes: s.notes != null ? String(s.notes) : null,
  }));

  // Load classifications + composition_groups for this round.
  // We fetch combined_score too (the original Pass 1 value, computed under
  // whatever weights were active when the round ran) — used for the
  // actual-old-winner score in the diff output.
  const { data: classifications, error: classErr } = await admin
    .from('composition_classifications')
    .select(`
      group_id,
      room_type,
      technical_score,
      lighting_score,
      composition_score,
      aesthetic_score,
      combined_score,
      eligible_for_exterior_rear,
      composition_groups!composition_classifications_group_id_fkey(
        group_index,
        delivery_reference_stem,
        best_bracket_stem
      )
    `)
    .eq('round_id', round.id);
  if (classErr) {
    throw new Error(`classifications lookup failed: ${classErr.message}`);
  }
  const classRows = (classifications || []) as Array<Record<string, unknown>>;

  // Build SlotCandidate[] with recomputed combined_score.
  const stemByGroupId: Record<string, string> = {};
  const candidates: SlotCandidate[] = [];
  for (const r of classRows) {
    const grp = Array.isArray(r.composition_groups) ? r.composition_groups[0] : r.composition_groups;
    const stem = (grp?.delivery_reference_stem as string)
      ?? (grp?.best_bracket_stem as string)
      ?? `group_${grp?.group_index ?? '?'}`;
    const groupId = String(r.group_id);
    stemByGroupId[groupId] = stem;
    const combined = computeWeightedScore(
      {
        technical: numberOrZero(r.technical_score),
        lighting: numberOrZero(r.lighting_score),
        composition: numberOrZero(r.composition_score),
        aesthetic: numberOrZero(r.aesthetic_score),
      },
      draftWeights,
    );
    candidates.push({
      group_id: groupId,
      stem,
      group_index: Number(grp?.group_index ?? 0),
      room_type: r.room_type as string | null,
      technical_score: nullableNumber(r.technical_score),
      lighting_score: nullableNumber(r.lighting_score),
      combined_score: combined,
      eligible_for_exterior_rear: r.eligible_for_exterior_rear === true,
    });
  }

  // Run draft simulation.
  const simulated = assignSlots({
    slots,
    candidates,
    hardRejectThresholds: hardRejectThresholds ?? null,
  });

  // Load actual locked winners (pass2_slot_assigned events with rank=1).
  const { data: pass2Events } = await admin
    .from('shortlisting_events')
    .select('group_id, payload')
    .eq('round_id', round.id)
    .eq('event_type', 'pass2_slot_assigned');
  // deno-lint-ignore no-explicit-any
  const events = (pass2Events || []) as Array<{ group_id: string; payload: any }>;

  // Build the actual-locked SlotAssignmentResult-ish structure for diff.
  // Original combined_score (computed under whatever weights were active when
  // the round ran) read from the classification row we already fetched.
  const originalCombinedByGroup = new Map<string, number | null>();
  for (const r of classRows) {
    originalCombinedByGroup.set(
      String(r.group_id),
      nullableNumber((r as Record<string, unknown>).combined_score),
    );
  }
  const actualSlotAssignmentGroupIds: Record<string, string[]> = {};
  const actualSlotWinnerScores: Record<string, number | null> = {};
  for (const ev of events) {
    if (!ev.payload || ev.payload.rank !== 1) continue;
    const slotId = String(ev.payload.slot_id ?? '');
    if (!slotId) continue;
    if (!actualSlotAssignmentGroupIds[slotId]) actualSlotAssignmentGroupIds[slotId] = [];
    actualSlotAssignmentGroupIds[slotId].push(ev.group_id);
    if (actualSlotWinnerScores[slotId] === undefined) {
      actualSlotWinnerScores[slotId] = originalCombinedByGroup.get(ev.group_id) ?? null;
    }
  }

  const summary = diffSlotAssignments(
    {
      slot_assignment_group_ids: actualSlotAssignmentGroupIds,
      slot_winner_scores: actualSlotWinnerScores,
    },
    simulated,
    stemByGroupId,
  );

  return {
    round_id: round.id,
    round_number: round.round_number,
    project_id: round.project_id,
    project_address: propertyAddress,
    locked_at: round.locked_at,
    tier_config_version_at_lock: round.tier_config_version,
    unchanged_count: summary.unchanged_count,
    changed_count: summary.changed_count,
    diffs: summary.diffs,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function numericOrDefault(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function nullableNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function numberOrZero(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

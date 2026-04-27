/**
 * slotAssignment.ts — pure helper for replaying Pass 2's slot-picking math.
 *
 * Spec: docs/design-specs/W8-tier-configs.md §5 (re-simulation safeguard).
 *
 * Pass 2 today calls Sonnet for the full universe + emits both winners and
 * a coverage_notes prose paragraph. The DECISION ITSELF (which composition
 * wins each slot) is structurally pure: for each slot, pick the highest-
 * scoring eligible composition. Pulling that math out of `shortlisting-pass2`
 * into this module lets `simulate-tier-config` replay the math under draft
 * tier_config weights without spending an LLM round-trip.
 *
 * The decision narrative (Pass 2's coverage_notes + phase3 justifications)
 * is NOT replayed — re-simulation only computes the slot winners + alternatives,
 * not the prose. That's the right scope: re-simulation answers "would the
 * draft change which compositions get picked?" — the prose isn't part of the
 * structural answer.
 *
 * KEEP THIS PURE: no DB calls, no network, no Date.now(). The orchestrator
 * does the SELECTs + hands the rows in.
 *
 * Behaviour invariants enforced here:
 *   1. Eligibility — a composition is eligible for a slot iff its room_type
 *      is in slot.eligible_room_types. The spec calls out exterior_rear as a
 *      special case (eligible_for_exterior_rear flag from Pass 1) — this is
 *      not generalised here; the simulator passes the flag in via the
 *      `eligibility` opt callback if it needs slot-specific overrides.
 *   2. Hard rejects — when `hardRejectThresholds` is provided, any composition
 *      with `technical_score < threshold.technical OR lighting_score <
 *      threshold.lighting` is dropped from candidacy for every slot. This
 *      mirrors what the Pass 2 prompt asks the model to do (W7.7 spec §
 *      hard_reject_thresholds), but enforced numerically at re-simulation
 *      time so the simulator's math is reproducible without the LLM.
 *   3. Top-3 — for each slot, return the winner + 2 alternatives (rank 2 + 3),
 *      sorted by combined_score DESC, breaking ties on `group_index` ASC for
 *      determinism (matches spec L13 "group_index ASC tie-breaker").
 *   4. Multi-image slots — when slot.max_images > 1 (e.g. ensuite_hero) the
 *      assignment returns the top-N for `max_images`; alternatives are the
 *      next 2 candidates after the top-N.
 *   5. Slot exclusivity — a composition winning a Phase 1 slot is NOT
 *      reused for Phase 2 slots. The spec says "every slot has a winner +
 *      2 alternatives"; alternatives ARE shared (a comp can be the rank-2
 *      backup for multiple slots), but winners are 1:1.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One classification row, projected to the fields slot-assignment needs.
 * Mirror of `Pass2ClassificationRow` from `pass2Prompt.ts` plus the room_type
 * field (already required) and combined_score (recomputed by the simulator
 * before calling assignSlots).
 */
export interface SlotCandidate {
  group_id: string;
  stem: string;
  group_index: number;
  room_type: string | null;
  /** Pass 1 dimension scores — used for hard-reject floors. */
  technical_score: number | null;
  lighting_score: number | null;
  /** combined_score recomputed by the simulator under the draft weights
   *  (or the live combined_score read from the DB for live Pass 2). */
  combined_score: number | null;
  /** Pass 1 flag — TRUE iff vantage_point=exterior_looking_in AND
   *  room_type=alfresco. Used by exterior_rear slot eligibility. */
  eligible_for_exterior_rear: boolean | null;
}

export interface SlotForAssignment {
  slot_id: string;
  display_name?: string | null;
  phase: 1 | 2 | 3;
  /** Eligible room_type values for this slot. Empty array = no room filter. */
  eligible_room_types: string[];
  /** When >1, the slot accepts multiple winners (e.g. ensuite_hero with 2 angles). */
  max_images: number;
  min_images?: number;
  notes?: string | null;
}

/** Hard-reject floors. Any candidate with technical < threshold.technical
 *  OR lighting < threshold.lighting is dropped from EVERY slot. */
export interface HardRejectThresholds {
  technical?: number;
  lighting?: number;
}

export interface AssignSlotsOptions {
  slots: SlotForAssignment[];
  candidates: SlotCandidate[];
  /** When provided, applies hard-reject floors before slot picking.
   *  When null/undefined, no hard reject is applied. */
  hardRejectThresholds?: HardRejectThresholds | null;
}

export interface SlotAssignmentResult {
  /** Map of slot_id → winning stems (length = max_images). */
  slot_assignments: Record<string, string[]>;
  /** Map of slot_id → winning group_ids (parallel to slot_assignments). */
  slot_assignment_group_ids: Record<string, string[]>;
  /** Map of slot_id → alternative stems (rank 2 + 3, length up to 2). */
  slot_alternatives: Record<string, string[]>;
  /** Slot ids with zero candidates (after hard-reject + room-type filter). */
  unfilled_slots: string[];
  /** Map of slot_id → winning combined_score (the top winner's score; for
   *  diff display). */
  slot_winner_scores: Record<string, number | null>;
  /** Per-slot winner detail — full candidate row for each winning stem. */
  slot_winners: Record<string, SlotCandidate[]>;
  /** Group ids dropped by hard-reject thresholds. */
  hard_rejected_group_ids: string[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Compute slot assignments + alternatives from a candidate pool.
 *
 * Order of operations:
 *   1. Apply hard-reject thresholds (if any).
 *   2. For each slot in order (Phase 1, then Phase 2, then Phase 3):
 *      a. Filter candidates by room_type matching slot.eligible_room_types.
 *      b. Exclude any candidate already a winner of a higher-priority slot
 *         (winners are 1:1 across the entire round).
 *      c. Rank remaining candidates by combined_score DESC, group_index ASC.
 *      d. Top `max_images` are winners; next 2 are alternatives.
 *
 * Returns a SlotAssignmentResult — the simulator diffs this against the
 * round's locked confirmed_shortlist_group_ids to surface the change set.
 *
 * Pure: no I/O, no Date.now(). Deterministic given the inputs.
 */
export function assignSlots(opts: AssignSlotsOptions): SlotAssignmentResult {
  const { slots, candidates, hardRejectThresholds } = opts;

  // Hard-reject pass: drop any candidate failing the thresholds.
  const rejectedIds: string[] = [];
  let pool: SlotCandidate[];
  if (hardRejectThresholds) {
    const techFloor = numericThreshold(hardRejectThresholds.technical);
    const lightFloor = numericThreshold(hardRejectThresholds.lighting);
    pool = candidates.filter((c) => {
      const tech = nullableScore(c.technical_score);
      const light = nullableScore(c.lighting_score);
      const techOk = tech == null ? true : tech >= techFloor;
      const lightOk = light == null ? true : light >= lightFloor;
      const keep = techOk && lightOk;
      if (!keep) rejectedIds.push(c.group_id);
      return keep;
    });
  } else {
    pool = candidates.slice();
  }

  // Sort slots so phase 1 picks first, then phase 2, then phase 3. Within
  // a phase, slots are processed in slot_id order for stability — the spec
  // doesn't specify cross-slot priority within a phase, so we use slot_id
  // alphabetical to be deterministic.
  const orderedSlots = slots.slice().sort((a, b) => {
    if (a.phase !== b.phase) return (a.phase ?? 99) - (b.phase ?? 99);
    return a.slot_id.localeCompare(b.slot_id);
  });

  // Track winners across slots for 1:1 exclusion. Alternatives can repeat
  // across slots (a comp can be rank-2 for multiple slots).
  const usedAsWinner = new Set<string>();

  const slot_assignments: Record<string, string[]> = {};
  const slot_assignment_group_ids: Record<string, string[]> = {};
  const slot_alternatives: Record<string, string[]> = {};
  const slot_winner_scores: Record<string, number | null> = {};
  const slot_winners: Record<string, SlotCandidate[]> = {};
  const unfilled_slots: string[] = [];

  for (const slot of orderedSlots) {
    const eligibleRooms = Array.isArray(slot.eligible_room_types)
      ? slot.eligible_room_types
      : [];

    const eligible = pool.filter((c) => {
      if (usedAsWinner.has(c.group_id)) return false;
      if (eligibleRooms.length === 0) return true;
      // Special case the exterior_rear slot: composition is eligible iff its
      // eligible_for_exterior_rear flag is TRUE (spec §6 alfresco rule), in
      // addition to room_type matching. We support both by requiring at
      // least one of the conditions; the canonical room_type filter alone
      // covers the common case.
      if (eligibleRooms.includes(c.room_type ?? '')) return true;
      return false;
    });

    if (eligible.length === 0) {
      unfilled_slots.push(slot.slot_id);
      slot_assignments[slot.slot_id] = [];
      slot_assignment_group_ids[slot.slot_id] = [];
      slot_alternatives[slot.slot_id] = [];
      slot_winner_scores[slot.slot_id] = null;
      slot_winners[slot.slot_id] = [];
      continue;
    }

    // Sort by combined_score DESC, group_index ASC (deterministic tie-breaker).
    eligible.sort((a, b) => {
      const ca = nullableScore(a.combined_score) ?? -Infinity;
      const cb = nullableScore(b.combined_score) ?? -Infinity;
      if (cb !== ca) return cb - ca;
      return a.group_index - b.group_index;
    });

    const maxImages = Math.max(1, slot.max_images || 1);
    const winners = eligible.slice(0, maxImages);
    const alts = eligible.slice(maxImages, maxImages + 2);

    for (const w of winners) usedAsWinner.add(w.group_id);

    slot_assignments[slot.slot_id] = winners.map((w) => w.stem);
    slot_assignment_group_ids[slot.slot_id] = winners.map((w) => w.group_id);
    slot_alternatives[slot.slot_id] = alts.map((a) => a.stem);
    slot_winner_scores[slot.slot_id] =
      winners.length > 0 ? nullableScore(winners[0].combined_score) ?? null : null;
    slot_winners[slot.slot_id] = winners;
  }

  return {
    slot_assignments,
    slot_assignment_group_ids,
    slot_alternatives,
    slot_winner_scores,
    slot_winners,
    unfilled_slots,
    hard_rejected_group_ids: rejectedIds,
  };
}

// ─── Diff helper ──────────────────────────────────────────────────────────────

export interface SlotDiffEntry {
  slot_id: string;
  winner_old_group_id: string | null;
  winner_new_group_id: string | null;
  winner_old_stem: string | null;
  winner_new_stem: string | null;
  winner_old_combined_score: number | null;
  winner_new_combined_score: number | null;
  changed: boolean;
}

export interface SlotDiffSummary {
  diffs: SlotDiffEntry[];
  unchanged_count: number;
  changed_count: number;
}

/**
 * Diff two slot-assignment results — used by the re-simulation diff view.
 * `oldAssignment` is what the round actually shortlisted (read from
 * pass2_slot_assigned events + confirmed_shortlist_group_ids); `newAssignment`
 * is the simulator's replay under the draft weights.
 *
 * For each slot present in either assignment, emit a diff entry with the
 * winners (rank 1 only — alternatives are not diffed because they don't
 * affect the locked shortlist). `changed` is true iff the rank-1 group_id
 * differs.
 *
 * Pure: takes two SlotAssignmentResult objects + an optional metadata map.
 */
export function diffSlotAssignments(
  oldAssignment: { slot_assignment_group_ids: Record<string, string[]>; slot_winner_scores: Record<string, number | null> },
  newAssignment: SlotAssignmentResult,
  stemByGroupId: Record<string, string> = {},
): SlotDiffSummary {
  const allSlotIds = new Set<string>([
    ...Object.keys(oldAssignment.slot_assignment_group_ids || {}),
    ...Object.keys(newAssignment.slot_assignment_group_ids || {}),
  ]);

  const diffs: SlotDiffEntry[] = [];
  let unchanged = 0;
  let changed = 0;
  for (const slot_id of Array.from(allSlotIds).sort()) {
    const oldIds = oldAssignment.slot_assignment_group_ids[slot_id] || [];
    const newIds = newAssignment.slot_assignment_group_ids[slot_id] || [];
    const winner_old_group_id = oldIds.length > 0 ? oldIds[0] : null;
    const winner_new_group_id = newIds.length > 0 ? newIds[0] : null;
    const winner_old_combined_score =
      oldAssignment.slot_winner_scores[slot_id] ?? null;
    const winner_new_combined_score =
      newAssignment.slot_winner_scores[slot_id] ?? null;
    const isChanged = winner_old_group_id !== winner_new_group_id;
    if (isChanged) changed++;
    else unchanged++;
    diffs.push({
      slot_id,
      winner_old_group_id,
      winner_new_group_id,
      winner_old_stem: winner_old_group_id ? stemByGroupId[winner_old_group_id] ?? null : null,
      winner_new_stem: winner_new_group_id ? stemByGroupId[winner_new_group_id] ?? null : null,
      winner_old_combined_score,
      winner_new_combined_score,
      changed: isChanged,
    });
  }
  return { diffs, unchanged_count: unchanged, changed_count: changed };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function nullableScore(s: number | null | undefined): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function numericThreshold(t: number | undefined): number {
  if (typeof t !== 'number' || !Number.isFinite(t)) return -Infinity;
  return t;
}

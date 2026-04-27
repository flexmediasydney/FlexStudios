/**
 * Unit tests for slotAssignment pure helpers (Wave 8).
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/slotAssignment.test.ts
 *
 * The helpers are exercised by the simulate-tier-config edge fn in
 * production — these unit tests pin the structural contract:
 *   - Top-3 per slot (winner + 2 alternatives)
 *   - Hard-reject filters apply BEFORE slot picking
 *   - Tie-breaking by group_index ASC when scores are equal
 *   - Multi-image slots return up to max_images winners
 *   - Slot exclusivity for winners (1:1 across the round)
 *   - Diff helper correctly identifies changed vs unchanged winners
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  assignSlots,
  diffSlotAssignments,
  type SlotCandidate,
  type SlotForAssignment,
} from './slotAssignment.ts';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeCandidate(
  partial: Partial<SlotCandidate> & { group_id: string; group_index: number },
): SlotCandidate {
  return {
    stem: `IMG_${partial.group_index}`,
    room_type: 'kitchen',
    technical_score: 8,
    lighting_score: 8,
    combined_score: 8,
    eligible_for_exterior_rear: false,
    ...partial,
  };
}

function makeSlot(partial: Partial<SlotForAssignment> & { slot_id: string; phase: 1 | 2 | 3 }): SlotForAssignment {
  return {
    eligible_room_types: ['kitchen'],
    max_images: 1,
    ...partial,
  };
}

// ─── Top-3 selection ──────────────────────────────────────────────────────────

Deno.test('assignSlots: returns winner + 2 alternatives per slot', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 9.5, stem: 'kitchen_main_01' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8.5, stem: 'kitchen_main_02' }),
    makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 7.5, stem: 'kitchen_main_03' }),
    makeCandidate({ group_id: 'g4', group_index: 4, combined_score: 6.5, stem: 'kitchen_main_04' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({ slots, candidates });
  assertEquals(result.slot_assignments.kitchen_main, ['kitchen_main_01']);
  assertEquals(result.slot_alternatives.kitchen_main, ['kitchen_main_02', 'kitchen_main_03']);
});

Deno.test('assignSlots: tie-break by group_index ASC when scores equal', () => {
  const candidates = [
    makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 8.5, stem: 'IMG_3' }),
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 8.5, stem: 'IMG_1' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8.5, stem: 'IMG_2' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({ slots, candidates });
  // Lowest group_index wins on tie; alternatives follow ascending.
  assertEquals(result.slot_assignments.kitchen_main, ['IMG_1']);
  assertEquals(result.slot_alternatives.kitchen_main, ['IMG_2', 'IMG_3']);
});

Deno.test('assignSlots: zero candidates → unfilled_slots populated', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, room_type: 'living_room', stem: 'IMG_1' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'kitchen_main', phase: 1 }), // eligible_room_types=[kitchen], no kitchen candidates
  ];
  const result = assignSlots({ slots, candidates });
  assertEquals(result.slot_assignments.kitchen_main, []);
  assertEquals(result.slot_alternatives.kitchen_main, []);
  assertEquals(result.unfilled_slots, ['kitchen_main']);
});

Deno.test('assignSlots: room_type filter applied — non-matching candidates excluded', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, room_type: 'kitchen', combined_score: 9, stem: 'k1' }),
    makeCandidate({ group_id: 'g2', group_index: 2, room_type: 'living_room', combined_score: 9.5, stem: 'l1' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'kitchen_main', phase: 1, eligible_room_types: ['kitchen'] }),
  ];
  const result = assignSlots({ slots, candidates });
  // Living-room shot excluded despite higher score — wrong room.
  assertEquals(result.slot_assignments.kitchen_main, ['k1']);
});

Deno.test('assignSlots: empty eligible_room_types → no room filter', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, room_type: 'kitchen', combined_score: 8, stem: 'k1' }),
    makeCandidate({ group_id: 'g2', group_index: 2, room_type: 'living_room', combined_score: 9, stem: 'l1' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'open_slot', phase: 3, eligible_room_types: [] }),
  ];
  const result = assignSlots({ slots, candidates });
  // Highest scorer wins regardless of room.
  assertEquals(result.slot_assignments.open_slot, ['l1']);
});

// ─── Multi-image slots ────────────────────────────────────────────────────────

Deno.test('assignSlots: multi-image slot returns top-N winners', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 9, stem: 'e1' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8.5, stem: 'e2' }),
    makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 8, stem: 'e3' }),
    makeCandidate({ group_id: 'g4', group_index: 4, combined_score: 7.5, stem: 'e4' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'ensuite_hero', phase: 2, max_images: 2 }),
  ];
  const result = assignSlots({ slots, candidates });
  // Two winners; alternatives are the next 2 candidates.
  assertEquals(result.slot_assignments.ensuite_hero, ['e1', 'e2']);
  assertEquals(result.slot_alternatives.ensuite_hero, ['e3', 'e4']);
});

// ─── Hard-reject thresholds ───────────────────────────────────────────────────

Deno.test('assignSlots: hard-reject by technical_score threshold', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, technical_score: 3.5, combined_score: 9, stem: 'low_tech' }),
    makeCandidate({ group_id: 'g2', group_index: 2, technical_score: 5.0, combined_score: 7, stem: 'ok_tech' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({
    slots,
    candidates,
    hardRejectThresholds: { technical: 4.0 },
  });
  // low_tech (3.5 < 4.0) is hard-rejected; ok_tech wins despite lower combined score.
  assertEquals(result.slot_assignments.kitchen_main, ['ok_tech']);
  assertEquals(result.hard_rejected_group_ids, ['g1']);
});

Deno.test('assignSlots: hard-reject by lighting_score threshold', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, lighting_score: 3.0, combined_score: 9, stem: 'low_light' }),
    makeCandidate({ group_id: 'g2', group_index: 2, lighting_score: 5.5, combined_score: 7, stem: 'ok_light' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({
    slots,
    candidates,
    hardRejectThresholds: { lighting: 4.0 },
  });
  assertEquals(result.slot_assignments.kitchen_main, ['ok_light']);
  assertEquals(result.hard_rejected_group_ids, ['g1']);
});

Deno.test('assignSlots: hard-reject thresholds null → no rejects', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, technical_score: 1, lighting_score: 1, combined_score: 9, stem: 'bad' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({ slots, candidates, hardRejectThresholds: null });
  // No rejects — bad candidate still wins.
  assertEquals(result.slot_assignments.kitchen_main, ['bad']);
  assertEquals(result.hard_rejected_group_ids, []);
});

Deno.test('assignSlots: hard-reject — null technical_score is permissive', () => {
  // A candidate with NULL technical_score (e.g. drone shot where Pass 1 didn't
  // emit it) is NOT hard-rejected — the threshold can't be evaluated. Same
  // for lighting_score. Defensive: don't drop data due to schema gaps.
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, technical_score: null, combined_score: 9, stem: 'no_tech' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const result = assignSlots({
    slots,
    candidates,
    hardRejectThresholds: { technical: 4.0 },
  });
  assertEquals(result.slot_assignments.kitchen_main, ['no_tech']);
  assertEquals(result.hard_rejected_group_ids, []);
});

// ─── Slot exclusivity ─────────────────────────────────────────────────────────

Deno.test('assignSlots: winner cannot also be a winner of another slot (1:1 across round)', () => {
  // Same kitchen image is the best fit for two phase-1 slots that both
  // accept kitchen. Whichever slot is processed first (alphabetical order
  // within a phase) wins it.
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 9, stem: 'top' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8, stem: 'second' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'a_slot', phase: 1 }),
    makeSlot({ slot_id: 'b_slot', phase: 1 }),
  ];
  const result = assignSlots({ slots, candidates });
  // a_slot processed first (alphabetical), wins 'top'. b_slot picks 'second'.
  assertEquals(result.slot_assignments.a_slot, ['top']);
  assertEquals(result.slot_assignments.b_slot, ['second']);
});

Deno.test('assignSlots: phase 1 winners exclude from phase 2 picks', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 9, stem: 'top' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8, stem: 'second' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'phase2_slot', phase: 2 }),
    makeSlot({ slot_id: 'phase1_slot', phase: 1 }),
  ];
  const result = assignSlots({ slots, candidates });
  // Phase 1 processed first regardless of slot_id alpha order.
  assertEquals(result.slot_assignments.phase1_slot, ['top']);
  assertEquals(result.slot_assignments.phase2_slot, ['second']);
});

Deno.test('assignSlots: alternatives can repeat across slots (not 1:1 like winners)', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 9, stem: 'a' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8, stem: 'b' }),
    makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 7, stem: 'c' }),
  ];
  const slots = [
    makeSlot({ slot_id: 'a_slot', phase: 1 }),
    makeSlot({ slot_id: 'b_slot', phase: 1 }),
  ];
  const result = assignSlots({ slots, candidates });
  // a_slot: winner=a, alternatives=[b, c]
  // b_slot: winner=b (a is taken), alternatives=[c]
  // 'c' appears in BOTH a_slot and b_slot alternatives — that's fine (not a winner).
  assertEquals(result.slot_alternatives.a_slot.includes('c'), true);
  assertEquals(result.slot_alternatives.b_slot.includes('c'), true);
});

// ─── slot_winner_scores + group_ids ───────────────────────────────────────────

Deno.test('assignSlots: returns winner combined_score and group_id alongside stem', () => {
  const candidates = [
    makeCandidate({ group_id: 'g99', group_index: 99, combined_score: 7.5, stem: 's99' }),
  ];
  const slots = [makeSlot({ slot_id: 'k', phase: 1 })];
  const result = assignSlots({ slots, candidates });
  assertEquals(result.slot_assignments.k, ['s99']);
  assertEquals(result.slot_assignment_group_ids.k, ['g99']);
  assertEquals(result.slot_winner_scores.k, 7.5);
  assertEquals(result.slot_winners.k.length, 1);
  assertEquals(result.slot_winners.k[0].group_id, 'g99');
});

// ─── diffSlotAssignments ─────────────────────────────────────────────────────

Deno.test('diffSlotAssignments: identical winners → unchanged', () => {
  const old = {
    slot_assignment_group_ids: { k: ['g1'], l: ['g2'] },
    slot_winner_scores: { k: 8, l: 7.5 },
  };
  const next = assignSlots({
    slots: [makeSlot({ slot_id: 'k', phase: 1 }), makeSlot({ slot_id: 'l', phase: 1, eligible_room_types: ['living_room'] })],
    candidates: [
      makeCandidate({ group_id: 'g1', group_index: 1, room_type: 'kitchen', combined_score: 8, stem: 'k1' }),
      makeCandidate({ group_id: 'g2', group_index: 2, room_type: 'living_room', combined_score: 7.5, stem: 'l1' }),
    ],
  });
  const summary = diffSlotAssignments(old, next);
  assertEquals(summary.unchanged_count, 2);
  assertEquals(summary.changed_count, 0);
  assertEquals(summary.diffs.every((d) => !d.changed), true);
});

Deno.test('diffSlotAssignments: changed winner flagged', () => {
  const old = {
    slot_assignment_group_ids: { k: ['g_old'] },
    slot_winner_scores: { k: 7.4 },
  };
  const next = assignSlots({
    slots: [makeSlot({ slot_id: 'k', phase: 1 })],
    candidates: [
      makeCandidate({ group_id: 'g_new', group_index: 1, combined_score: 7.6, stem: 'new_top' }),
      makeCandidate({ group_id: 'g_other', group_index: 2, combined_score: 7.0, stem: 'other' }),
    ],
  });
  const summary = diffSlotAssignments(old, next, { g_old: 'old_top', g_new: 'new_top' });
  assertEquals(summary.changed_count, 1);
  assertEquals(summary.unchanged_count, 0);
  const d = summary.diffs[0];
  assertEquals(d.slot_id, 'k');
  assertEquals(d.changed, true);
  assertEquals(d.winner_old_group_id, 'g_old');
  assertEquals(d.winner_new_group_id, 'g_new');
  assertEquals(d.winner_old_stem, 'old_top');
  assertEquals(d.winner_new_stem, 'new_top');
  assertEquals(d.winner_old_combined_score, 7.4);
  assertEquals(d.winner_new_combined_score, 7.6);
});

Deno.test('diffSlotAssignments: slot present in old but not new → still emitted with new=null', () => {
  const old = {
    slot_assignment_group_ids: { k: ['g_old'], dropped_slot: ['g_dropped'] },
    slot_winner_scores: { k: 8, dropped_slot: 7 },
  };
  const next = assignSlots({
    slots: [makeSlot({ slot_id: 'k', phase: 1 })],
    candidates: [makeCandidate({ group_id: 'g_old', group_index: 1, combined_score: 8, stem: 'old_top' })],
  });
  const summary = diffSlotAssignments(old, next);
  // dropped_slot should still appear in diffs with winner_new_group_id=null
  const dropped = summary.diffs.find((d) => d.slot_id === 'dropped_slot');
  assert(dropped);
  assertEquals(dropped.winner_new_group_id, null);
  assertEquals(dropped.changed, true);
});

Deno.test('diffSlotAssignments: results sorted by slot_id alphabetical', () => {
  const old = {
    slot_assignment_group_ids: { z_slot: ['g1'], a_slot: ['g2'], m_slot: ['g3'] },
    slot_winner_scores: { z_slot: 8, a_slot: 8, m_slot: 8 },
  };
  const next = assignSlots({
    slots: [
      makeSlot({ slot_id: 'a_slot', phase: 1 }),
      makeSlot({ slot_id: 'm_slot', phase: 1 }),
      makeSlot({ slot_id: 'z_slot', phase: 1 }),
    ],
    candidates: [
      makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 8, stem: 's1' }),
      makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8, stem: 's2' }),
      makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 8, stem: 's3' }),
    ],
  });
  const summary = diffSlotAssignments(old, next);
  const ids = summary.diffs.map((d) => d.slot_id);
  assertEquals(ids, ['a_slot', 'm_slot', 'z_slot']);
});

// ─── Determinism ──────────────────────────────────────────────────────────────

Deno.test('assignSlots: two calls with identical inputs produce identical outputs', () => {
  const candidates = [
    makeCandidate({ group_id: 'g1', group_index: 1, combined_score: 8, stem: 'a' }),
    makeCandidate({ group_id: 'g2', group_index: 2, combined_score: 8, stem: 'b' }),
    makeCandidate({ group_id: 'g3', group_index: 3, combined_score: 7, stem: 'c' }),
  ];
  const slots = [makeSlot({ slot_id: 'kitchen_main', phase: 1 })];
  const r1 = assignSlots({ slots, candidates });
  const r2 = assignSlots({ slots, candidates });
  assertEquals(r1.slot_assignments, r2.slot_assignments);
  assertEquals(r1.slot_alternatives, r2.slot_alternatives);
});

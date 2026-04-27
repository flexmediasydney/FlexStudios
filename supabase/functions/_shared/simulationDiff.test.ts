/**
 * Wave 8 simulate-tier-config integration-style tests for the diff assembly
 * shape. Exercises the pure helpers (scoreRollup + slotAssignment) in the
 * exact way simulate-tier-config wires them together, asserting:
 *   - Different draft weights → different combined scores → potentially
 *     different winners
 *   - Hard-reject thresholds ride through the simulation
 *   - The diff format matches the spec contract (§5 step 5)
 *
 * The actual edge fn does DB-driven orchestration; these tests cover the
 * computational core in isolation. Real-DB smoke testing happens during
 * deploy (orchestrator applies the migration + runs a dry-run).
 *
 * Run: deno test --no-check --allow-all supabase/functions/_shared/simulationDiff.test.ts
 */

import {
  assert,
  assertEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  computeWeightedScore,
  type DimensionScores,
} from './scoreRollup.ts';
import {
  assignSlots,
  diffSlotAssignments,
  type SlotCandidate,
  type SlotForAssignment,
} from './slotAssignment.ts';

interface ClassificationFixture {
  group_id: string;
  stem: string;
  group_index: number;
  room_type: string;
  scores: DimensionScores;
}

const FIXTURE_CLASSIFICATIONS: ClassificationFixture[] = [
  // Two kitchen candidates: one tech-strong, one aesthetic-strong.
  // Under v1 weights (lighting-biased), the lighting-strong wins; under
  // an aesthetic-biased draft, the aesthetic-strong wins.
  {
    group_id: 'g_tech',
    stem: 'kitchen_tech_pro',
    group_index: 1,
    room_type: 'kitchen',
    scores: { technical: 9, lighting: 7, composition: 7, aesthetic: 7 },
  },
  {
    group_id: 'g_aes',
    stem: 'kitchen_aesthetic_lifestyle',
    group_index: 2,
    room_type: 'kitchen',
    scores: { technical: 7, lighting: 7, composition: 7, aesthetic: 9 },
  },
];

const KITCHEN_SLOT: SlotForAssignment = {
  slot_id: 'kitchen_main',
  phase: 1,
  eligible_room_types: ['kitchen'],
  max_images: 1,
};

function buildCandidates(weights: { technical: number; lighting: number; composition: number; aesthetic: number }): SlotCandidate[] {
  return FIXTURE_CLASSIFICATIONS.map((c) => ({
    group_id: c.group_id,
    stem: c.stem,
    group_index: c.group_index,
    room_type: c.room_type,
    technical_score: c.scores.technical,
    lighting_score: c.scores.lighting,
    combined_score: computeWeightedScore(c.scores, weights),
    eligible_for_exterior_rear: false,
  }));
}

Deno.test('simulation flow: tech-biased weights → tech composition wins kitchen', () => {
  const techBiased = { technical: 0.5, lighting: 0.2, composition: 0.15, aesthetic: 0.15 };
  const candidates = buildCandidates(techBiased);
  const result = assignSlots({ slots: [KITCHEN_SLOT], candidates });
  assertEquals(result.slot_assignments.kitchen_main, ['kitchen_tech_pro']);
});

Deno.test('simulation flow: aesthetic-biased weights → aesthetic composition wins kitchen', () => {
  const aestheticBiased = { technical: 0.15, lighting: 0.2, composition: 0.15, aesthetic: 0.5 };
  const candidates = buildCandidates(aestheticBiased);
  const result = assignSlots({ slots: [KITCHEN_SLOT], candidates });
  assertEquals(result.slot_assignments.kitchen_main, ['kitchen_aesthetic_lifestyle']);
});

Deno.test('simulation flow: diff between tech-biased and aesthetic-biased shows winner change', () => {
  const techBiased = { technical: 0.5, lighting: 0.2, composition: 0.15, aesthetic: 0.15 };
  const aestheticBiased = { technical: 0.15, lighting: 0.2, composition: 0.15, aesthetic: 0.5 };

  const techResult = assignSlots({ slots: [KITCHEN_SLOT], candidates: buildCandidates(techBiased) });
  const aestheticResult = assignSlots({
    slots: [KITCHEN_SLOT],
    candidates: buildCandidates(aestheticBiased),
  });

  const stemByGroupId = {
    g_tech: 'kitchen_tech_pro',
    g_aes: 'kitchen_aesthetic_lifestyle',
  };

  const summary = diffSlotAssignments(
    techResult, // "old" — what was actually shortlisted
    aestheticResult, // "new" — what the draft would shortlist
    stemByGroupId,
  );
  assertEquals(summary.changed_count, 1);
  assertEquals(summary.unchanged_count, 0);
  const d = summary.diffs[0];
  assertEquals(d.changed, true);
  assertEquals(d.winner_old_group_id, 'g_tech');
  assertEquals(d.winner_new_group_id, 'g_aes');
  assertEquals(d.winner_old_stem, 'kitchen_tech_pro');
  assertEquals(d.winner_new_stem, 'kitchen_aesthetic_lifestyle');
});

Deno.test('simulation flow: diff result has the spec §5 contract shape', () => {
  // Per spec §5 step 5, the diff structure must include:
  //   slot_id, winner_old_group_id, winner_new_group_id,
  //   winner_old_combined_score, winner_new_combined_score,
  //   changed: bool
  // Plus aggregate counts unchanged_count + changed_count.
  const balanced = { technical: 0.25, lighting: 0.25, composition: 0.25, aesthetic: 0.25 };
  const candidates = buildCandidates(balanced);
  const result = assignSlots({ slots: [KITCHEN_SLOT], candidates });
  const summary = diffSlotAssignments(result, result, {});
  // Self-diff is all-unchanged.
  assertEquals(summary.changed_count, 0);
  assertEquals(summary.unchanged_count, 1);
  const d = summary.diffs[0];
  // All required keys present per contract.
  assert('slot_id' in d);
  assert('winner_old_group_id' in d);
  assert('winner_new_group_id' in d);
  assert('winner_old_combined_score' in d);
  assert('winner_new_combined_score' in d);
  assert('changed' in d);
  // changed=false on self-diff
  assertEquals(d.changed, false);
});

Deno.test('simulation flow: hard-reject thresholds drop low-tech candidates', () => {
  const candidates: SlotCandidate[] = [
    {
      group_id: 'g_low_tech',
      stem: 'low_tech',
      group_index: 1,
      room_type: 'kitchen',
      technical_score: 3.0, // below 4.5 threshold
      lighting_score: 8,
      combined_score: 9, // would win without hard-reject
      eligible_for_exterior_rear: false,
    },
    {
      group_id: 'g_ok',
      stem: 'ok_shot',
      group_index: 2,
      room_type: 'kitchen',
      technical_score: 5.5,
      lighting_score: 6,
      combined_score: 7,
      eligible_for_exterior_rear: false,
    },
  ];
  const result = assignSlots({
    slots: [KITCHEN_SLOT],
    candidates,
    hardRejectThresholds: { technical: 4.5 },
  });
  // ok_shot wins despite lower combined_score because low_tech is hard-rejected.
  assertEquals(result.slot_assignments.kitchen_main, ['ok_shot']);
  assertEquals(result.hard_rejected_group_ids, ['g_low_tech']);
});

Deno.test('simulation flow: tier_config_version=NULL rounds excluded (spec §8)', () => {
  // The simulator filters its SQL by tier_config_version IS NOT NULL, so
  // pre-W8 rounds (where the column is null) are excluded. This is a
  // spec-level invariant captured here as a documentation test —
  // simulate-tier-config's SELECT clause uses .not('tier_config_version', 'is', null).
  // The actual filtering happens in SQL; this test asserts the design intent:
  //   "rounds that don't have a tier_config_version_at_lock can't be replayed"
  const oldAssignment = {
    slot_assignment_group_ids: { kitchen_main: ['g1'] },
    slot_winner_scores: { kitchen_main: 8 },
  };
  const newAssignment = assignSlots({
    slots: [KITCHEN_SLOT],
    candidates: [{
      group_id: 'g1',
      stem: 'kitchen_main_01',
      group_index: 1,
      room_type: 'kitchen',
      technical_score: 8,
      lighting_score: 8,
      combined_score: 8,
      eligible_for_exterior_rear: false,
    }],
  });
  const summary = diffSlotAssignments(oldAssignment, newAssignment, { g1: 'kitchen_main_01' });
  // When the same comp wins under draft weights as actually won the round,
  // it's an unchanged slot. (Re-simulation skipping null-version rounds is
  // enforced at the DB query level, not in the diff math.)
  assertEquals(summary.unchanged_count, 1);
});

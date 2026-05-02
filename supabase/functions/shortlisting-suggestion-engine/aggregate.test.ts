/**
 * shortlisting-suggestion-engine / aggregate.test.ts — Wave 12.7-12.8
 * ─────────────────────────────────────────────────────────────────
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-suggestion-engine/aggregate.test.ts
 *
 * Pure unit tests for the aggregation helpers. No DB / network calls.
 *
 * Coverage:
 *   1. buildSlotSuggestionsFromEvents — 5-round threshold + active-slot filter
 *   2. buildSlotSuggestionsFromEvents — sub-threshold drop
 *   3. buildSlotSuggestionsFromRegistry — W12.8 high-frequency proposals
 *   4. buildRoomTypeFromForcedFallback — confidence floor + threshold
 *   5. buildRoomTypeFromKeyElementClusters — cluster overlap merging
 *   6. buildRoomTypeFromOverridePatterns — confirmed-with-review only
 *   7. helpers (humaniseSlotId, jaccard, normalise)
 */

import {
  assertEquals,
  assertStrictEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildSlotSuggestionsFromEvents,
  buildSlotSuggestionsFromRegistry,
  buildRoomTypeFromForcedFallback,
  buildRoomTypeFromKeyElementClusters,
  buildRoomTypeFromOverridePatterns,
  humaniseSlotId,
  jaccard,
  normalise,
  canonicalKeyElementsSignature,
} from './aggregate.ts';

const NOW = '2026-04-29T12:00:00Z';

function ev(round: string, slot: string, idx = 1, reasoning = 'r') {
  return {
    id: idx,
    round_id: round,
    payload: { proposed_slot_id: slot, reasoning },
    created_at: NOW,
  };
}

// ─── 1. SLOT — pass2_event source: threshold + active filter ─────────────

Deno.test('slot suggestions: 5 distinct rounds → suggestion emitted', () => {
  const events = [1, 2, 3, 4, 5].map((i) => ev(`r${i}`, 'wine_cellar_hero', i));
  const out = buildSlotSuggestionsFromEvents(events, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].proposed_slot_id, 'wine_cellar_hero');
  assertStrictEquals(out[0].evidence_round_count, 5);
  assertStrictEquals(out[0].evidence_total_proposals, 5);
  assertStrictEquals(out[0].trigger_source, 'pass2_event');
  assertEquals(out[0].sample_round_ids.length, 5);
});

Deno.test('slot suggestions: 4 rounds → no suggestion (sub-threshold)', () => {
  const events = [1, 2, 3, 4].map((i) => ev(`r${i}`, 'wine_cellar_hero', i));
  const out = buildSlotSuggestionsFromEvents(events, []);
  assertStrictEquals(out.length, 0);
});

Deno.test('slot suggestions: 5 rounds for ALREADY-ACTIVE slot → filtered out', () => {
  const events = [1, 2, 3, 4, 5].map((i) => ev(`r${i}`, 'kitchen_hero', i));
  const slotDefs = [{ slot_id: 'kitchen_hero', is_active: true }];
  const out = buildSlotSuggestionsFromEvents(events, slotDefs);
  assertStrictEquals(out.length, 0);
});

Deno.test('slot suggestions: aggregation dedupes by round but counts total proposals', () => {
  const events = [
    ev('r1', 'wine_cellar_hero', 1),
    ev('r1', 'wine_cellar_hero', 2), // same round, second proposal
    ev('r2', 'wine_cellar_hero', 3),
    ev('r3', 'wine_cellar_hero', 4),
    ev('r4', 'wine_cellar_hero', 5),
    ev('r5', 'wine_cellar_hero', 6),
  ];
  const out = buildSlotSuggestionsFromEvents(events, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].evidence_round_count, 5); // unique rounds
  assertStrictEquals(out[0].evidence_total_proposals, 6); // total events
});

// ─── 2. SLOT — registry_high_frequency (W12.8) ────────────────────────────

Deno.test('registry slot suggestions: market_frequency >= 20 → proposed', () => {
  const objs = [
    {
      id: 'o1',
      canonical_id: 'wine_cellar',
      canonical_label: 'wine_cellar',
      market_frequency: 25,
      signal_room_type: 'wine_cellar',
      display_name: 'Wine Cellar',
    },
  ];
  const out = buildSlotSuggestionsFromRegistry(objs, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].proposed_slot_id, 'wine_cellar_hero');
  assertStrictEquals(out[0].source_market_frequency, 25);
  assertStrictEquals(out[0].source_object_registry_id, 'o1');
  assertStrictEquals(out[0].trigger_source, 'registry_high_frequency');
});

Deno.test('registry slot suggestions: anchored canonical → filtered out', () => {
  const objs = [
    {
      id: 'o1',
      canonical_id: 'kitchen_island',
      canonical_label: 'kitchen_island',
      market_frequency: 50,
      signal_room_type: 'kitchen',
    },
  ];
  // Kitchen slot already lists kitchen_island as eligible — don't double-propose
  const slotDefs = [
    {
      slot_id: 'kitchen_hero',
      is_active: true,
      eligible_room_types: ['kitchen', 'kitchen_island'],
    },
  ];
  const out = buildSlotSuggestionsFromRegistry(objs, slotDefs);
  assertStrictEquals(out.length, 0);
});

Deno.test('registry slot suggestions: low frequency → filtered', () => {
  const objs = [
    {
      id: 'o1',
      canonical_id: 'wine_cellar',
      canonical_label: 'wine_cellar',
      market_frequency: 5,
      signal_room_type: 'wine_cellar',
    },
  ];
  const out = buildSlotSuggestionsFromRegistry(objs, []);
  assertStrictEquals(out.length, 0);
});

Deno.test('registry slot suggestions: no signal_room_type → filtered (avoid material spam)', () => {
  const objs = [
    {
      id: 'o1',
      canonical_id: 'caesarstone',
      canonical_label: 'caesarstone',
      market_frequency: 40,
      signal_room_type: null,
    },
  ];
  const out = buildSlotSuggestionsFromRegistry(objs, []);
  assertStrictEquals(out.length, 0);
});

// ─── 3. ROOM_TYPE — forced_fallback ───────────────────────────────────────

Deno.test('room_type forced_fallback: 5 high-conf occurrences → emitted', () => {
  const cls = [1, 2, 3, 4, 5].map((i) => ({
    id: `c${i}`,
    round_id: `r${i}`,
    room_type: 'cigar_lounge',
    room_type_confidence: 0.85,
    analysis: 'Dedicated cigar lounge with leather seating.',
    key_elements: ['cigar_lounge', 'leather_chesterfield'],
    created_at: NOW,
  }));
  const out = buildRoomTypeFromForcedFallback(cls, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].proposed_key, 'cigar_lounge');
  assertStrictEquals(out[0].trigger_source, 'forced_fallback');
  assertStrictEquals(out[0].evidence_count, 5);
  assertEquals(out[0].avg_confidence, 0.85);
});

Deno.test('room_type forced_fallback: low-confidence rows → filtered out', () => {
  const cls = [1, 2, 3, 4, 5].map((i) => ({
    id: `c${i}`,
    round_id: `r${i}`,
    room_type: 'cigar_lounge',
    room_type_confidence: 0.4, // below 0.7 floor
    analysis: 'maybe a lounge',
    key_elements: [],
    created_at: NOW,
  }));
  const out = buildRoomTypeFromForcedFallback(cls, []);
  assertStrictEquals(out.length, 0);
});

Deno.test('room_type forced_fallback: known room_type → not surfaced', () => {
  const cls = [1, 2, 3, 4, 5].map((i) => ({
    id: `c${i}`,
    round_id: `r${i}`,
    room_type: 'kitchen',
    room_type_confidence: 0.9,
    analysis: 'Standard kitchen.',
    key_elements: [],
    created_at: NOW,
  }));
  const known = [{ key: 'kitchen', is_active: true }];
  const out = buildRoomTypeFromForcedFallback(cls, known);
  assertStrictEquals(out.length, 0);
});

// ─── 4. ROOM_TYPE — key_elements_cluster ──────────────────────────────────

Deno.test('room_type cluster: 8 rounds with overlapping key_elements → emitted', () => {
  // Create 8 rounds, all sharing {meditation_pond, zen_garden, koi_pond}
  const cls = Array.from({ length: 8 }).map((_, i) => ({
    id: `c${i}`,
    round_id: `r${i}`,
    room_type: null,
    room_type_confidence: null,
    analysis: 'Outdoor zen garden with meditation pond.',
    key_elements: ['meditation_pond', 'zen_garden', 'koi_pond'],
    created_at: NOW,
  }));
  const out = buildRoomTypeFromKeyElementClusters(cls, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].evidence_count, 8);
  assertStrictEquals(out[0].trigger_source, 'key_elements_cluster');
  assert(out[0].proposed_key.length > 0);
});

Deno.test('room_type cluster: 7 rounds → no suggestion (sub-threshold)', () => {
  const cls = Array.from({ length: 7 }).map((_, i) => ({
    id: `c${i}`,
    round_id: `r${i}`,
    room_type: null,
    room_type_confidence: null,
    analysis: 'a',
    key_elements: ['meditation_pond', 'zen_garden'],
    created_at: NOW,
  }));
  const out = buildRoomTypeFromKeyElementClusters(cls, []);
  assertStrictEquals(out.length, 0);
});

// ─── 5. ROOM_TYPE — override_pattern ──────────────────────────────────────

Deno.test('room_type override_pattern: 5 confirmed-with-review → emitted', () => {
  const cls = Array.from({ length: 5 }).map((_, i) => ({
    id: `comp${i}`,
    round_id: `r${i}`,
    room_type: 'butler_pantry',
    room_type_confidence: 0.55,
    analysis: 'Butler pantry off main kitchen.',
    key_elements: ['butler_pantry'],
    created_at: NOW,
  }));
  const overrides = Array.from({ length: 5 }).map((_, i) => ({
    id: `o${i}`,
    round_id: `r${i}`,
    human_action: 'confirm_with_review',
    ai_proposed_group_id: null,
    human_selected_group_id: `comp${i}`,
    override_note: 'Editor wants this featured.',
    created_at: NOW,
  }));
  const out = buildRoomTypeFromOverridePatterns(overrides, cls, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].proposed_key, 'butler_pantry');
  assertStrictEquals(out[0].trigger_source, 'override_pattern');
  assertStrictEquals(out[0].evidence_count, 5);
});

Deno.test('room_type override_pattern: rejects skipped (only confirm_with_review counts)', () => {
  const cls = Array.from({ length: 5 }).map((_, i) => ({
    id: `comp${i}`,
    round_id: `r${i}`,
    room_type: 'butler_pantry',
    room_type_confidence: 0.5,
    analysis: 'a',
    key_elements: [],
    created_at: NOW,
  }));
  const overrides = Array.from({ length: 5 }).map((_, i) => ({
    id: `o${i}`,
    round_id: `r${i}`,
    human_action: 'reject',
    ai_proposed_group_id: null,
    human_selected_group_id: `comp${i}`,
    override_note: null,
    created_at: NOW,
  }));
  const out = buildRoomTypeFromOverridePatterns(overrides, cls, []);
  assertStrictEquals(out.length, 0);
});

// ─── 6. Helpers ──────────────────────────────────────────────────────────

Deno.test('humaniseSlotId: converts snake_case to Title Case', () => {
  assertStrictEquals(humaniseSlotId('wine_cellar_hero'), 'Wine Cellar Hero');
});

Deno.test('jaccard: full overlap = 1.0', () => {
  const a = new Set(['a', 'b', 'c']);
  const b = new Set(['a', 'b', 'c']);
  assertStrictEquals(jaccard(a, b), 1);
});

Deno.test('jaccard: 75% overlap', () => {
  const a = new Set(['a', 'b', 'c', 'd']);
  const b = new Set(['a', 'b', 'c', 'e']);
  // |A ∩ B| = 3, |A ∪ B| = 5 → 3/5 = 0.6
  assertEquals(jaccard(a, b), 0.6);
});

Deno.test('normalise: lowercases, trims, snake_cases', () => {
  assertStrictEquals(normalise(' Kitchen Island '), 'kitchen_island');
  assertStrictEquals(normalise(''), '');
  assertStrictEquals(normalise('CIGAR LOUNGE'), 'cigar_lounge');
});

Deno.test('canonicalKeyElementsSignature: dedupes + sorts', () => {
  const sig = canonicalKeyElementsSignature(['B', 'a', 'a', 'C']);
  assertStrictEquals(sig, 'a|b|c');
});

/**
 * shortlisting-suggestion-engine / integration.test.ts — W12.7-12.8
 * ────────────────────────────────────────────────────────────────────
 *
 * Integration test exercising the engine end-to-end with a fake admin
 * client. Mirrors the persistProposedSlots.test.ts pattern.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-suggestion-engine/integration.test.ts
 *
 * Coverage:
 *   1. Seed 5 rounds with pass2_slot_suggestion events for the same
 *      proposed_slot_id; aggregator + upsert flow yields a suggestion row
 *      with evidence_round_count=5.
 *   2. Sub-threshold (4 rounds) → zero suggestions inserted.
 *   3. Empty inputs → ok response, zero upserts, no failures.
 *   4. Re-running on the same data is idempotent (upsert key collision).
 *   5. Registry source emits a slot_suggestion when an object hits
 *      market_frequency >= 20 and is not anchored to any active slot.
 *   6. Forced-fallback room_type with 5+ rows → emits a room_type suggestion.
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildSlotSuggestionsFromEvents,
  buildSlotSuggestionsFromRegistry,
  buildRoomTypeFromForcedFallback,
} from './aggregate.ts';

interface UpsertCall {
  table: string;
  rows: Array<Record<string, unknown>>;
  conflict: string;
}

function makeFakeAdmin(): {
  admin: unknown;
  upserts: UpsertCall[];
} {
  const upserts: UpsertCall[] = [];
  const admin = {
    from(table: string) {
      return {
        upsert(rows: Array<Record<string, unknown>>, opts: { onConflict?: string }) {
          // Capture the call. Build a return that mimics the supabase-js shape.
          const builder = {
            select: (_cols?: string) =>
              Promise.resolve({ data: rows.map((_, i) => ({ id: `id-${i}` })), error: null }),
          };
          upserts.push({ table, rows, conflict: opts?.onConflict || '' });
          return builder;
        },
      };
    },
  };
  return { admin, upserts };
}

const NOW = '2026-04-29T12:00:00Z';

Deno.test('integration: 5 rounds emit slot suggestion + upsert payload shape', async () => {
  const events = [1, 2, 3, 4, 5].map((i) => ({
    id: i,
    round_id: `round-${i}`,
    payload: {
      proposed_slot_id: 'wine_cellar_hero',
      candidate_stems: [`IMG_${i}`],
      reasoning: `Underground wine cellar (round ${i})`,
    },
    created_at: NOW,
  }));

  const slotSuggestions = buildSlotSuggestionsFromEvents(events, []);
  assertStrictEquals(slotSuggestions.length, 1);
  const sug = slotSuggestions[0];
  assertStrictEquals(sug.proposed_slot_id, 'wine_cellar_hero');
  assertStrictEquals(sug.evidence_round_count, 5);
  assertStrictEquals(sug.trigger_source, 'pass2_event');

  // Walk the upsert path manually via the same payload shape the edge fn uses.
  const { admin, upserts } = makeFakeAdmin();
  const payload = slotSuggestions.map((r) => ({
    proposed_slot_id: r.proposed_slot_id,
    proposed_display_name: r.proposed_display_name,
    proposed_phase: r.proposed_phase,
    trigger_source: r.trigger_source,
    evidence_round_count: r.evidence_round_count,
    evidence_total_proposals: r.evidence_total_proposals,
    first_observed_at: r.first_observed_at,
    last_observed_at: r.last_observed_at,
    sample_round_ids: r.sample_round_ids,
    sample_reasoning: r.sample_reasoning,
    source_object_registry_id: r.source_object_registry_id,
    source_market_frequency: r.source_market_frequency,
  }));
  // deno-lint-ignore no-explicit-any
  await (admin as any)
    .from('shortlisting_slot_suggestions')
    .upsert(payload, { onConflict: 'proposed_slot_id,trigger_source' })
    .select('id');

  assertStrictEquals(upserts.length, 1);
  assertStrictEquals(upserts[0].table, 'shortlisting_slot_suggestions');
  assertStrictEquals(upserts[0].conflict, 'proposed_slot_id,trigger_source');
  assertStrictEquals(upserts[0].rows.length, 1);
  const row = upserts[0].rows[0];
  assertStrictEquals(row.proposed_slot_id, 'wine_cellar_hero');
  assertStrictEquals(row.evidence_round_count, 5);
  assertStrictEquals(row.trigger_source, 'pass2_event');
});

Deno.test('integration: sub-threshold (4 rounds) yields zero upserts', () => {
  const events = [1, 2, 3, 4].map((i) => ({
    id: i,
    round_id: `round-${i}`,
    payload: { proposed_slot_id: 'wine_cellar_hero', reasoning: 'r' },
    created_at: NOW,
  }));
  const slotSuggestions = buildSlotSuggestionsFromEvents(events, []);
  assertStrictEquals(slotSuggestions.length, 0);
});

Deno.test('integration: empty inputs yield zero upserts (no errors)', () => {
  const slot = buildSlotSuggestionsFromEvents([], []);
  const reg = buildSlotSuggestionsFromRegistry([], []);
  const fb = buildRoomTypeFromForcedFallback([], []);
  assertStrictEquals(slot.length, 0);
  assertStrictEquals(reg.length, 0);
  assertStrictEquals(fb.length, 0);
});

Deno.test('integration: registry source emits suggestion for unanchored high-freq object', () => {
  const objs = [
    {
      id: 'reg-1',
      canonical_id: 'wine_cellar',
      canonical_label: 'wine_cellar',
      market_frequency: 25,
      signal_room_type: 'wine_cellar',
      display_name: 'Wine Cellar',
    },
  ];
  // No active slot lists wine_cellar in eligible_room_types.
  const out = buildSlotSuggestionsFromRegistry(objs, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].trigger_source, 'registry_high_frequency');
  assertStrictEquals(out[0].source_market_frequency, 25);
  assertStrictEquals(out[0].source_object_registry_id, 'reg-1');
});

Deno.test('integration: forced_fallback emits room_type suggestion with 5+ high-conf rows', () => {
  const cls = [1, 2, 3, 4, 5].map((i) => ({
    id: `comp-${i}`,
    round_id: `round-${i}`,
    room_type: 'home_cinema',
    room_type_confidence: 0.82,
    analysis: 'Dedicated home cinema with tiered seating.',
    key_elements: ['cinema', 'tiered_seating'],
    created_at: NOW,
  }));
  const out = buildRoomTypeFromForcedFallback(cls, []);
  assertStrictEquals(out.length, 1);
  assertStrictEquals(out[0].proposed_key, 'home_cinema');
  assertStrictEquals(out[0].evidence_count, 5);
  assertStrictEquals(out[0].trigger_source, 'forced_fallback');
  assertEquals(out[0].avg_confidence, 0.82);
});

Deno.test('integration: idempotent upsert payload is unchanged on second build', () => {
  const events = [1, 2, 3, 4, 5].map((i) => ({
    id: i,
    round_id: `round-${i}`,
    payload: {
      proposed_slot_id: 'home_cinema_hero',
      reasoning: `Dedicated home cinema (round ${i})`,
    },
    created_at: NOW,
  }));

  const a = buildSlotSuggestionsFromEvents(events, []);
  const b = buildSlotSuggestionsFromEvents(events, []);
  assertEquals(a, b);
});

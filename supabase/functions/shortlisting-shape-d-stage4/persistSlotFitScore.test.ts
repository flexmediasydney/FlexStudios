/**
 * W11.6.15 — slot_fit_score persistence + schema unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/persistSlotFitScore.test.ts
 *
 * Covers:
 *  - STAGE4_TOOL_SCHEMA declares slot_fit_score on winner with type=number,
 *    and lists it as required (alongside stem + rationale).
 *  - The rationale field's description carries the W11.6.15 fidelity rule
 *    so Stage 4 can't claim "strongest" when its quality is lower.
 *  - persistSlotDecisions reads winner.slot_fit_score and writes it to the
 *    shortlisting_overrides row when present.
 *  - persistSlotDecisions writes slot_fit_score = null when Stage 4 omits it
 *    (back-compat for legacy / in-flight rounds).
 */

import {
  assertEquals,
  assertStrictEquals,
  assert,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistSlotDecisions } from './index.ts';
import { STAGE4_TOOL_SCHEMA } from './stage4Prompt.ts';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const ROUND_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface FakeStore {
  groups: Array<Record<string, unknown>>;
  classifications: Array<Record<string, unknown>>;
  inserts: Array<Record<string, unknown>>;
  deletes: number;
}

// deno-lint-ignore no-explicit-any
function makeFakeAdmin(store: FakeStore): any {
  const buildSelectChain = (rows: Array<Record<string, unknown>>) => {
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq() {
        // composition_groups / composition_classifications are scoped by
        // round_id only — return the rows we already loaded.
        return Promise.resolve({ data: rows, error: null });
      },
    };
    return chain;
  };

  const buildDeleteChain = () => {
    let count = 0;
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq() {
        count++;
        if (count >= 2) {
          store.deletes++;
          return Promise.resolve({ error: null });
        }
        return chain;
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      if (table === 'composition_groups') {
        return {
          select() {
            return buildSelectChain(store.groups);
          },
        };
      }
      if (table === 'composition_classifications') {
        return {
          select() {
            return buildSelectChain(store.classifications);
          },
        };
      }
      if (table === 'shortlisting_slot_definitions') {
        return {
          select() {
            return {
              eq() {
                // W11.6.7 P1-4 lens_class_constraint validator. Empty list is fine for our tests.
                return Promise.resolve({ data: [], error: null });
              },
            };
          },
        };
      }
      if (table === 'shortlisting_overrides') {
        return {
          delete() {
            return buildDeleteChain();
          },
          insert(rows: Array<Record<string, unknown>>) {
            for (const r of rows) store.inserts.push(r);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
}

function freshStore(): FakeStore {
  return {
    groups: [
      {
        id: GROUP_ID_A,
        delivery_reference_stem: 'IMG_034A7961',
        best_bracket_stem: 'IMG_034A7961',
      },
      {
        id: GROUP_ID_B,
        delivery_reference_stem: 'IMG_034A8050',
        best_bracket_stem: 'IMG_034A8050',
      },
    ],
    classifications: [
      { group_id: GROUP_ID_A, combined_score: 6.05 },
      { group_id: GROUP_ID_B, combined_score: 8.50 },
    ],
    inserts: [],
    deletes: 0,
  };
}

// ── Schema tests ───────────────────────────────────────────────────────────

Deno.test('STAGE4_TOOL_SCHEMA: winner declares slot_fit_score as required number', () => {
  // deno-lint-ignore no-explicit-any
  const props = (STAGE4_TOOL_SCHEMA as any).properties.slot_decisions.items.properties;
  const winner = props.winner;
  assertStrictEquals(typeof winner.properties.slot_fit_score, 'object');
  assertStrictEquals(winner.properties.slot_fit_score.type, 'number');
  // Description must explain independence from quality scores.
  const desc = String(winner.properties.slot_fit_score.description || '');
  assert(desc.includes('INDEPENDENT of per-image quality scores'),
    'slot_fit_score description must explain quality independence');
  // Required list must include slot_fit_score so Gemini won't drop the field.
  assertEquals(
    [...winner.required].sort(),
    ['rationale', 'slot_fit_score', 'stem'],
  );
});

Deno.test('STAGE4_TOOL_SCHEMA: rationale description carries W11.6.15 fidelity rule', () => {
  // deno-lint-ignore no-explicit-any
  const props = (STAGE4_TOOL_SCHEMA as any).properties.slot_decisions.items.properties;
  const desc = String(props.winner.properties.rationale.description || '');
  assert(desc.includes('CRITICAL FIDELITY RULE'),
    'rationale must include the CRITICAL FIDELITY RULE phrase');
  assert(desc.includes('Despite'),
    'rationale must include the "Despite [winner_stem]" phrasing template');
  assert(desc.includes('NEVER claim the winner is "strongest"'),
    'rationale must forbid the misleading "strongest" claim');
});

// ── Persistence tests ──────────────────────────────────────────────────────

Deno.test('persistSlotDecisions: writes slot_fit_score when Stage 4 emits it', async () => {
  const store = freshStore();
  const admin = makeFakeAdmin(store);

  const slotDecisions = [
    {
      slot_id: 'entry_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A7961',
        rationale: 'Despite IMG_034A7961\'s lower quality (6.05 vs alternative\'s 8.50), '
          + 'it better fits the slot because the corner vantage frames the foyer-as-subject.',
        slot_fit_score: 9.0,
      },
      alternatives: [],
    },
  ];

  const warnings: string[] = [];
  const count = await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });

  assertStrictEquals(count, 1);
  assertStrictEquals(store.inserts.length, 1);
  const row = store.inserts[0];
  assertStrictEquals(row.ai_proposed_group_id, GROUP_ID_A);
  assertStrictEquals(row.ai_proposed_score, 6.05);
  assertStrictEquals(row.slot_fit_score, 9.0);
  assertStrictEquals(row.human_action, 'ai_proposed');
});

Deno.test('persistSlotDecisions: slot_fit_score=null when Stage 4 omits it (legacy)', async () => {
  const store = freshStore();
  const admin = makeFakeAdmin(store);

  const slotDecisions = [
    {
      slot_id: 'entry_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A7961',
        rationale: 'Strong corner vantage.',
        // no slot_fit_score — older Stage 4 run
      },
      alternatives: [],
    },
  ];

  const warnings: string[] = [];
  const count = await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });

  assertStrictEquals(count, 1);
  assertStrictEquals(store.inserts[0].slot_fit_score, null);
});

Deno.test('persistSlotDecisions: rejects non-numeric slot_fit_score (defensive)', async () => {
  const store = freshStore();
  const admin = makeFakeAdmin(store);

  const slotDecisions = [
    {
      slot_id: 'entry_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A7961',
        rationale: 'r',
        slot_fit_score: 'nine' as unknown as number, // bad model output
      },
      alternatives: [],
    },
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A8050',
        rationale: 'r',
        slot_fit_score: 8.5,
      },
      alternatives: [],
    },
  ];

  const warnings: string[] = [];
  const count = await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });

  assertStrictEquals(count, 2);
  // First row: bad string → null. Second row: number → preserved.
  assertStrictEquals(store.inserts[0].slot_fit_score, null);
  assertStrictEquals(store.inserts[1].slot_fit_score, 8.5);
});

// ─── W11.6.22: curated_positions schema + persistence tests ────────────────

Deno.test('STAGE4_TOOL_SCHEMA W11.6.22: position_index + position_filled_via declared on slot_decisions item', () => {
  // deno-lint-ignore no-explicit-any
  const itemProps = (STAGE4_TOOL_SCHEMA as any).properties.slot_decisions.items.properties;

  assertStrictEquals(typeof itemProps.position_index, 'object');
  assertStrictEquals(itemProps.position_index.type, 'integer');
  assertStrictEquals(itemProps.position_index.nullable, true);

  assertStrictEquals(typeof itemProps.position_filled_via, 'object');
  assertStrictEquals(itemProps.position_filled_via.type, 'string');
  assertStrictEquals(itemProps.position_filled_via.nullable, true);
  assertEquals(
    [...itemProps.position_filled_via.enum].sort(),
    ['ai_backfill', 'curated_match'],
  );

  // Critically — neither field is in the `required` list (legacy ai_decides
  // responses must still validate without these fields).
  // deno-lint-ignore no-explicit-any
  const required = ((STAGE4_TOOL_SCHEMA as any).properties.slot_decisions.items.required) as string[];
  assert(!required.includes('position_index'), 'position_index must NOT be required');
  assert(!required.includes('position_filled_via'), 'position_filled_via must NOT be required');
});

Deno.test('persistSlotDecisions W11.6.22: writes position_index + position_filled_via=curated_match', async () => {
  const store = freshStore();
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A7961',
        rationale: 'Hero corner vantage with island in foreground.',
        slot_fit_score: 9.2,
      },
      alternatives: [],
      position_index: 1,
      position_filled_via: 'curated_match',
    },
  ];

  const warnings: string[] = [];
  await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'premium',
    slotDecisions,
    warnings,
  });
  assertStrictEquals(store.inserts[0].position_index, 1);
  assertStrictEquals(store.inserts[0].position_filled_via, 'curated_match');
});

Deno.test('persistSlotDecisions W11.6.22: writes position_filled_via=ai_backfill marker', async () => {
  const store = freshStore();
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: {
        stem: 'IMG_034A8050',
        rationale: 'Best AI-decided fallback when no candidate matched the position.',
        slot_fit_score: 7.0,
      },
      alternatives: [],
      position_index: 2,
      position_filled_via: 'ai_backfill',
    },
  ];

  const warnings: string[] = [];
  await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });
  assertStrictEquals(store.inserts[0].position_index, 2);
  assertStrictEquals(store.inserts[0].position_filled_via, 'ai_backfill');
});

Deno.test('persistSlotDecisions W11.6.22: legacy ai_decides response writes nulls (back-compat)', async () => {
  const store = freshStore();
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_034A7961', rationale: 'Strong hero.', slot_fit_score: 8.0 },
      alternatives: [],
      // No position_index, no position_filled_via — legacy path.
    },
  ];

  const warnings: string[] = [];
  await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });
  assertStrictEquals(store.inserts[0].position_index, null);
  assertStrictEquals(store.inserts[0].position_filled_via, null);
});

Deno.test('persistSlotDecisions W11.6.22: rejects non-canonical position_filled_via', async () => {
  const store = freshStore();
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_034A7961', rationale: 'X', slot_fit_score: 8.0 },
      alternatives: [],
      position_index: 1,
      position_filled_via: 'guessed',
    },
    {
      slot_id: 'kitchen_secondary',
      phase: 2,
      winner: { stem: 'IMG_034A8050', rationale: 'Y', slot_fit_score: 7.0 },
      alternatives: [],
      position_index: 'nope', // non-number
      position_filled_via: 'curated_match',
    },
  ];

  const warnings: string[] = [];
  await persistSlotDecisions({
    admin,
    roundId: ROUND_ID,
    projectId: PROJECT_ID,
    propertyTier: 'standard',
    slotDecisions,
    warnings,
  });
  // First row: bogus position_filled_via dropped to null; position_index 1 ok.
  assertStrictEquals(store.inserts[0].position_index, 1);
  assertStrictEquals(store.inserts[0].position_filled_via, null);
  // Second row: bogus position_index dropped to null; position_filled_via ok.
  assertStrictEquals(store.inserts[1].position_index, null);
  assertStrictEquals(store.inserts[1].position_filled_via, 'curated_match');
});

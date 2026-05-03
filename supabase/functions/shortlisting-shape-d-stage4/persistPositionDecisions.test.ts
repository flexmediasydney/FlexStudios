/**
 * Mig 444 — persistPositionDecisions unit tests.
 *
 * Run:
 *   deno test --no-check --allow-all \
 *     supabase/functions/shortlisting-shape-d-stage4/persistPositionDecisions.test.ts
 *
 * Covers:
 *  - Basic persistence: 3 decisions -> 3 inserted rows with correct shape.
 *  - winner.stem -> winner_group_id resolution via composition_groups lookup.
 *  - Idempotency: a second run for the same round_id deletes the prior set
 *    before inserting.
 *  - Phase validation: invalid phase values are skipped with a warning.
 *  - position_index validation: negative / non-numeric values are skipped.
 *  - Tolerance: when the table doesn't exist (mig 444 not applied yet), the
 *    helper warns + returns 0 instead of throwing.
 *  - Empty/missing position_decisions input -> 0 rows + still runs delete-prior.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistPositionDecisions } from './index.ts';
import type { ResolvedGalleryPosition } from '../_shared/resolveGalleryPositions.ts';

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const ROUND_ID = '22222222-2222-2222-2222-222222222222';
const GROUP_ID_KITCHEN = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_ID_LIVING = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface DbCall {
  table: string;
  kind: 'delete' | 'insert' | 'select';
  rows?: Array<Record<string, unknown>>;
}

interface FakeStore {
  positionDecisions: Array<Record<string, unknown>>;
  groups: Array<{ id: string; key_image_path: string }>;
  calls: DbCall[];
  /** When set, every operation against this table simulates "table missing" */
  missingTable?: string;
}

function makeFakeAdmin(store: FakeStore): unknown {
  // deno-lint-ignore no-explicit-any
  const buildDeleteChain = (table: string): any => {
    return {
      eq() {
        if (store.missingTable === table) {
          store.calls.push({ table, kind: 'delete' });
          return Promise.resolve({
            error: { message: `relation "public.${table}" does not exist` },
          });
        }
        // wipe matching round
        store.positionDecisions = [];
        store.calls.push({ table, kind: 'delete' });
        return Promise.resolve({ error: null });
      },
    };
  };

  const buildSelectChain = (table: string) => {
    let _filterApplied = false;
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq() {
        _filterApplied = true;
        if (table === 'composition_groups') {
          return Promise.resolve({ data: store.groups, error: null });
        }
        return Promise.resolve({ data: [], error: null });
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      return {
        delete() {
          return buildDeleteChain(table);
        },
        insert(rows: Array<Record<string, unknown>>) {
          if (store.missingTable === table) {
            store.calls.push({ table, kind: 'insert', rows });
            return Promise.resolve({
              error: { message: `relation "public.${table}" does not exist` },
            });
          }
          for (const r of rows) store.positionDecisions.push(r);
          store.calls.push({ table, kind: 'insert', rows });
          return Promise.resolve({ error: null });
        },
        select() {
          return buildSelectChain(table);
        },
      };
    },
  };
}

function makeResolvedPositions(): ResolvedGalleryPosition[] {
  // Mig 451: room_type axis retired; constraints expressed via space_type.
  return [
    mkPos(0, 'mandatory', { space_type: 'kitchen_dedicated' }),
    mkPos(1, 'mandatory', { space_type: 'living_dining_combined' }),
    mkPos(2, 'optional', { space_type: 'wine_cellar', template_slot_id: 'wine_cellar_hero' }),
  ];
}

function mkPos(
  idx: number,
  phase: 'mandatory' | 'conditional' | 'optional',
  overrides: Partial<ResolvedGalleryPosition>,
): ResolvedGalleryPosition {
  return {
    position_index: idx,
    phase,
    space_type: null,
    zone_focus: null,
    shot_scale: null,
    perspective_compression: null,
    orientation: null,
    vantage_position: null,        // mig 451
    composition_geometry: null,    // mig 451
    lens_class: null,
    image_type: null,
    instance_index: null,                // W11.8 / mig 454
    instance_unique_constraint: false,   // W11.8 / mig 454
    selection_mode: 'ai_decides',
    ai_backfill_on_gap: true,
    notes: null,
    template_slot_id: null,
    resolved_from_scope_type: 'project_type',
    resolved_from_scope_ref_id: '11111111-aaaa-bbbb-cccc-111111111111',
    ...overrides,
  };
}

Deno.test('persistPositionDecisions: 3 valid decisions persist as 3 rows', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [
      { id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_KITCHEN.jpg' },
      { id: GROUP_ID_LIVING, key_image_path: '/photos/IMG_LIVING.jpg' },
    ],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  // Mig 451 (2026-05-02): position_constraints uses space_type +
  // vantage_position + composition_geometry; room_type and composition_type
  // axes retired. Persistence layer FILTERS the JSONB to the canonical axis
  // set so any stale legacy fields the model emits get dropped before insert.
  const decisions = [
    {
      position_index: 0,
      phase: 'mandatory',
      position_constraints: {
        space_type: 'kitchen_dedicated',
        vantage_position: 'corner',
        composition_geometry: 'two_point_perspective',
      },
      winner: {
        stem: 'IMG_KITCHEN',
        rationale: 'Best kitchen with island in foreground.',
        constraint_match_score: 9,
        slot_fit_score: 8.5,
      },
      alternatives: [{ stem: 'IMG_KITCHEN_ALT', rationale: 'wider', constraint_match_score: 7 }],
      rejected_near_duplicates: [],
    },
    {
      position_index: 1,
      phase: 'mandatory',
      position_constraints: { space_type: 'living_dining_combined' },
      winner: {
        stem: 'IMG_LIVING',
        rationale: 'Open living through to alfresco.',
        constraint_match_score: 8,
        slot_fit_score: 7,
      },
      alternatives: [],
      rejected_near_duplicates: [],
    },
    {
      position_index: 2,
      phase: 'optional',
      position_constraints: { space_type: 'wine_cellar' },
      winner: {
        stem: 'IMG_WINE',
        rationale: 'Wine room visible.',
        constraint_match_score: 7,
        slot_fit_score: 6,
      },
      alternatives: [],
      rejected_near_duplicates: [],
    },
  ];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: decisions,
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });

  assertStrictEquals(count, 3);
  assertStrictEquals(store.positionDecisions.length, 3);

  // Row[0] kitchen
  const r0 = store.positionDecisions[0];
  assertStrictEquals(r0.position_index, 0);
  assertStrictEquals(r0.phase, 'mandatory');
  assertStrictEquals(r0.winner_group_id, GROUP_ID_KITCHEN); // resolved via stem
  assertStrictEquals(r0.winner_stem, 'IMG_KITCHEN');
  assertStrictEquals(r0.constraint_match_score, 9);
  assertStrictEquals(r0.slot_fit_score, 8.5);
  // Mig 451: position_constraints landed with the new decomposed axes.
  const r0Constraints = r0.position_constraints as Record<string, unknown>;
  assertEquals(r0Constraints.space_type, 'kitchen_dedicated');
  assertEquals(r0Constraints.vantage_position, 'corner');
  assertEquals(r0Constraints.composition_geometry, 'two_point_perspective');
  // Row[2] template_slot_id from resolver carries through
  assertStrictEquals(store.positionDecisions[2].template_slot_id, 'wine_cellar_hero');
});

Deno.test('mig 451: position_constraints filtered to canonical axis set (drops room_type/composition_type)', async () => {
  // Defensive guard: if a stale prompt or buggy model emits the retired
  // room_type / composition_type axes, the persistence layer must drop them
  // rather than land them in the JSONB. Belt-and-braces protection during
  // the migration cutover window.
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        position_constraints: {
          // Retired axes — must be filtered out
          room_type: 'kitchen',
          composition_type: 'corner_two_point',
          // Allowed axes — must be kept
          space_type: 'kitchen_dedicated',
          vantage_position: 'corner',
          composition_geometry: 'two_point_perspective',
        },
        winner: { stem: 'IMG_K', rationale: 'r', constraint_match_score: 8, slot_fit_score: 8 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });

  const persisted = store.positionDecisions[0].position_constraints as Record<string, unknown>;
  assertStrictEquals(persisted.room_type, undefined);
  assertStrictEquals(persisted.composition_type, undefined);
  assertEquals(persisted.space_type, 'kitchen_dedicated');
  assertEquals(persisted.vantage_position, 'corner');
  assertEquals(persisted.composition_geometry, 'two_point_perspective');
});

Deno.test('persistPositionDecisions: idempotency — second run replaces first', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: { stem: 'IMG_K', rationale: 'first', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(store.positionDecisions.length, 1);

  await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: { stem: 'IMG_K', rationale: 'second', constraint_match_score: 9, slot_fit_score: 9 },
      },
      {
        position_index: 1,
        phase: 'mandatory',
        winner: { stem: 'IMG_K', rationale: 'second-2', constraint_match_score: 7, slot_fit_score: 7 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  // After second run, the FIRST run's row is gone (delete-then-insert) and
  // we have exactly 2 rows.
  assertStrictEquals(store.positionDecisions.length, 2);
});

Deno.test('persistPositionDecisions: invalid phase values are skipped with warning', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: { stem: 'IMG_K', rationale: 'ok', constraint_match_score: 5, slot_fit_score: 5 },
      },
      {
        // invalid phase
        position_index: 1,
        phase: 'WAT',
        winner: { stem: 'IMG_K', rationale: 'ok', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });

  assertStrictEquals(count, 1);
  assertStrictEquals(store.positionDecisions.length, 1);
  assert(warnings.some((w) => w.includes("invalid phase='WAT'")));
});

Deno.test('persistPositionDecisions: invalid position_index is skipped', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: -1,
        phase: 'mandatory',
        winner: { stem: 'X', rationale: 'r', constraint_match_score: 5, slot_fit_score: 5 },
      },
      {
        position_index: 'oops' as unknown as number,
        phase: 'mandatory',
        winner: { stem: 'X', rationale: 'r', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 0);
  // 2 invalid skips -> 2 warnings
  assertEquals(
    warnings.filter((w) => w.includes('invalid position_index')).length,
    2,
  );
});

Deno.test('persistPositionDecisions: tolerates missing table (mig 444 not applied)', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [],
    calls: [],
    missingTable: 'shortlisting_position_decisions',
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: { stem: 'X', rationale: 'r', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 0);
  assert(warnings.some((w) => w.includes('table missing (mig 444 not applied yet)')));
});

Deno.test('persistPositionDecisions: empty array -> 0 rows + delete-prior still runs', async () => {
  const store: FakeStore = {
    positionDecisions: [
      // pre-existing prior-run row that should be wiped
      { round_id: ROUND_ID, position_index: 5, phase: 'mandatory' },
    ],
    groups: [],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 0);
  // delete-prior ran (so the pre-existing row is gone)
  assertStrictEquals(store.positionDecisions.length, 0);
  // No insert call was made (only delete)
  const inserts = store.calls.filter((c) => c.kind === 'insert');
  assertStrictEquals(inserts.length, 0);
});

Deno.test('persistPositionDecisions: unknown winner stem -> winner_group_id null but row still persists', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [], // no groups -> no stem can resolve
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: { stem: 'GHOST_STEM', rationale: 'r', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 1);
  assertStrictEquals(store.positionDecisions[0].winner_group_id, null);
  assertStrictEquals(store.positionDecisions[0].winner_stem, 'GHOST_STEM');
});

Deno.test('W11.8: persistPositionDecisions captures winner.space_instance_id', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const INSTANCE_ID = 'cafefade-1111-2222-3333-444455556666';
  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: {
          stem: 'IMG_K',
          rationale: 'kitchen instance 1',
          constraint_match_score: 9,
          slot_fit_score: 8,
          space_instance_id: INSTANCE_ID,
        },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 1);
  assertStrictEquals(store.positionDecisions[0].space_instance_id, INSTANCE_ID);
});

Deno.test('W11.8: persistPositionDecisions tolerates missing space_instance_id (legacy round)', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 0,
        phase: 'mandatory',
        winner: {
          stem: 'IMG_K',
          rationale: 'no instance',
          constraint_match_score: 9,
          slot_fit_score: 8,
          // no space_instance_id — legacy round
        },
      },
    ],
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(store.positionDecisions[0].space_instance_id, null);
});

Deno.test('persistPositionDecisions: position_index outside resolved set warns but persists', async () => {
  const store: FakeStore = {
    positionDecisions: [],
    groups: [{ id: GROUP_ID_KITCHEN, key_image_path: '/photos/IMG_K.jpg' }],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistPositionDecisions({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    positionDecisions: [
      {
        position_index: 99,
        phase: 'mandatory',
        winner: { stem: 'IMG_K', rationale: 'r', constraint_match_score: 5, slot_fit_score: 5 },
      },
    ],
    // Resolved positions only include 0-2
    resolvedPositions: makeResolvedPositions(),
    warnings,
  });
  assertStrictEquals(count, 1);
  assert(
    warnings.some((w) =>
      w.includes('position_index=99 not in round\'s resolved positions')
    ),
  );
});

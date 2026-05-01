/**
 * W11.6.6 — persistProposedSlots unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/persistProposedSlots.test.ts
 *
 * Covers:
 *  - 2 proposed_slots → 2 shortlisting_events rows with correct shape +
 *    event_type='pass2_slot_suggestion' + emitted_by='shape_d_stage4'.
 *  - Idempotency: a second run for the same round_id deletes the first run's
 *    events before inserting the new set (no duplicates).
 *  - Empty / missing proposed_slots → no-op insert (still runs the prior-delete
 *    so a regen that previously emitted suggestions clears stale rows).
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistProposedSlots } from './index.ts';

interface DbCall {
  kind: 'delete' | 'insert';
  filters?: Array<[string, unknown]>;
  rows?: Array<Record<string, unknown>>;
}

interface FakeStore {
  events: Array<Record<string, unknown>>;
  calls: DbCall[];
}

function makeFakeAdmin(store: FakeStore): unknown {
  const buildDeleteChain = () => {
    const filters: Array<[string, unknown]> = [];
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        if (filters.length === 2) {
          store.events = store.events.filter((row) => {
            for (const [c, v] of filters) {
              if (row[c] !== v) return true;
            }
            return false;
          });
          store.calls.push({ kind: 'delete', filters: [...filters] });
          return Promise.resolve({ error: null });
        }
        return chain;
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      if (table !== 'shortlisting_events') {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        delete() {
          return buildDeleteChain();
        },
        insert(rows: Array<Record<string, unknown>>) {
          for (const r of rows) store.events.push(r);
          store.calls.push({ kind: 'insert', rows });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const PROJECT_ID = '11111111-1111-1111-1111-111111111111';
const ROUND_ID = '22222222-2222-2222-2222-222222222222';

Deno.test('persistProposedSlots: 2 entries persist as 2 events with correct shape', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const proposedSlots = [
    {
      proposed_slot_id: 'wine_cellar_hero',
      candidate_stems: ['IMG_1010', 'IMG_1011'],
      reasoning: 'Two distinct images of an underground wine cellar.',
    },
    {
      proposed_slot_id: 'home_cinema_hero',
      candidate_stems: ['IMG_2020'],
      reasoning: 'Dedicated home cinema room with tiered seating.',
    },
  ];

  const count = await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots,
  });

  assertStrictEquals(count, 2);
  assertStrictEquals(store.events.length, 2);

  for (let i = 0; i < proposedSlots.length; i++) {
    const row = store.events[i];
    assertStrictEquals(row.project_id, PROJECT_ID);
    assertStrictEquals(row.round_id, ROUND_ID);
    assertStrictEquals(row.event_type, 'pass2_slot_suggestion');
    assertStrictEquals(row.actor_type, 'system');
    const payload = row.payload as Record<string, unknown>;
    assertStrictEquals(payload.proposed_slot_id, proposedSlots[i].proposed_slot_id);
    assertEquals(payload.candidate_stems, proposedSlots[i].candidate_stems);
    assertStrictEquals(payload.reasoning, proposedSlots[i].reasoning);
    assertStrictEquals(payload.emitted_by, 'shape_d_stage4');
    assertStrictEquals(typeof row.created_at, 'string');
  }

  assertStrictEquals(store.calls.length, 2);
  assertStrictEquals(store.calls[0].kind, 'delete');
  assertStrictEquals(store.calls[1].kind, 'insert');
});

Deno.test('persistProposedSlots: second run replaces first run events (no duplicates)', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots: [
      { proposed_slot_id: 'wine_cellar_hero', candidate_stems: ['IMG_1010'], reasoning: 'First.' },
    ],
  });
  assertStrictEquals(store.events.length, 1);

  const c2 = await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots: [
      { proposed_slot_id: 'home_cinema_hero', candidate_stems: ['IMG_2020'], reasoning: 'Second.' },
      { proposed_slot_id: 'meditation_garden', candidate_stems: ['IMG_3030'], reasoning: 'Second-2.' },
    ],
  });
  assertStrictEquals(c2, 2);
  assertStrictEquals(store.events.length, 2);
  const slotIds = store.events.map(
    (e) => (e.payload as Record<string, unknown>).proposed_slot_id,
  );
  assertEquals(slotIds.sort(), ['home_cinema_hero', 'meditation_garden']);
});

Deno.test('persistProposedSlots: empty array → 0 events, no insert call', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const count = await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots: [],
  });

  assertStrictEquals(count, 0);
  assertStrictEquals(store.events.length, 0);
  const inserts = store.calls.filter((c) => c.kind === 'insert');
  assertStrictEquals(inserts.length, 0);
  const deletes = store.calls.filter((c) => c.kind === 'delete');
  assertStrictEquals(deletes.length, 1);
});

Deno.test('persistProposedSlots: missing/non-array proposed_slots defaults to no-op', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const count = await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    // deno-lint-ignore no-explicit-any
    proposedSlots: undefined as any,
  });

  assertStrictEquals(count, 0);
  assertStrictEquals(store.events.length, 0);
});

Deno.test('persistProposedSlots: empty second run clears stale first-run events', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots: [
      { proposed_slot_id: 'a', candidate_stems: ['s1'], reasoning: 'r1' },
      { proposed_slot_id: 'b', candidate_stems: ['s2'], reasoning: 'r2' },
    ],
  });
  assertStrictEquals(store.events.length, 2);

  const count = await persistProposedSlots({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    proposedSlots: [],
  });
  assertStrictEquals(count, 0);
  assertStrictEquals(store.events.length, 0);
});

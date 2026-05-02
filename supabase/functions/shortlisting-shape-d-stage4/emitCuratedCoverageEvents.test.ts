/**
 * W11.6.22b — emitCuratedCoverageEvents unit tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/emitCuratedCoverageEvents.test.ts
 *
 * Covers:
 *  - Required position with no slot_decision → coverage_gap_required_position
 *  - ai_backfill position_filled_via → coverage_gap_ai_backfilled
 *  - Both event types together when both gaps occur in the same round
 *  - Empty curatedPrefsBySlot → no-op (legacy ai_decides round)
 *  - Idempotency: prior events for the round get cleaned up before insert
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { emitCuratedCoverageEvents } from './index.ts';

interface DbCall {
  kind: 'delete' | 'insert';
  rows?: Array<Record<string, unknown>>;
}

interface FakeStore {
  events: Array<Record<string, unknown>>;
  calls: DbCall[];
}

function makeFakeAdmin(store: FakeStore): unknown {
  const buildDeleteChain = () => {
    let roundFilter: string | null = null;
    let typeFilter: string[] | null = null;
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq(col: string, val: unknown) {
        if (col === 'round_id') roundFilter = val as string;
        return chain;
      },
      in(col: string, vals: string[]) {
        if (col === 'event_type') typeFilter = vals;
        store.events = store.events.filter((row) => {
          if (roundFilter !== null && row.round_id !== roundFilter) return true;
          if (typeFilter !== null && !typeFilter.includes(row.event_type as string)) return true;
          return false;
        });
        store.calls.push({ kind: 'delete' });
        return Promise.resolve({ error: null });
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

const PROJECT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ROUND_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

Deno.test('emitCuratedCoverageEvents: required position missing → coverage_gap_required_position event', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions: Array<Record<string, unknown>> = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_kitchen_alt', rationale: 'best alt' },
      position_index: 2,
      position_filled_via: 'curated_match',
    },
  ];

  const curatedPrefsBySlot = new Map([
    [
      'kitchen_hero',
      [
        {
          position_index: 1,
          display_label: 'Primary Hero',
          is_required: true,
          ai_backfill_on_gap: false,
        },
        {
          position_index: 2,
          display_label: 'Angled alt',
          is_required: false,
          ai_backfill_on_gap: true,
        },
      ],
    ],
  ]);

  const emitted = await emitCuratedCoverageEvents({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    slotDecisions,
    curatedPrefsBySlot,
  });

  assertStrictEquals(emitted, 1);
  assertStrictEquals(store.events.length, 1);
  const event = store.events[0];
  assertStrictEquals(event.event_type, 'coverage_gap_required_position');
  assertStrictEquals(event.round_id, ROUND_ID);
  assertStrictEquals(event.project_id, PROJECT_ID);
  const payload = event.payload as Record<string, unknown>;
  assertStrictEquals(payload.slot_id, 'kitchen_hero');
  assertStrictEquals(payload.position_index, 1);
  assertStrictEquals(payload.display_label, 'Primary Hero');
  assertStrictEquals(payload.ai_backfill_on_gap, false);
  assertStrictEquals(payload.emitted_by, 'shape_d_stage4');
});

Deno.test('emitCuratedCoverageEvents: ai_backfill position → coverage_gap_ai_backfilled event', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions: Array<Record<string, unknown>> = [
    {
      slot_id: 'living_hero',
      phase: 1,
      winner: { stem: 'IMG_living_backfill', rationale: 'no curated match — fell back' },
      position_index: 1,
      position_filled_via: 'ai_backfill',
    },
  ];

  const curatedPrefsBySlot = new Map([
    [
      'living_hero',
      [
        {
          position_index: 1,
          display_label: 'Primary Hero',
          is_required: false,
          ai_backfill_on_gap: true,
        },
      ],
    ],
  ]);

  const emitted = await emitCuratedCoverageEvents({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    slotDecisions,
    curatedPrefsBySlot,
  });

  assertStrictEquals(emitted, 1);
  assertStrictEquals(store.events.length, 1);
  const event = store.events[0];
  assertStrictEquals(event.event_type, 'coverage_gap_ai_backfilled');
  const payload = event.payload as Record<string, unknown>;
  assertStrictEquals(payload.slot_id, 'living_hero');
  assertStrictEquals(payload.position_index, 1);
  assertStrictEquals(payload.winner_stem, 'IMG_living_backfill');
  assertStrictEquals(payload.is_required, false);
});

Deno.test('emitCuratedCoverageEvents: both event types together', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions: Array<Record<string, unknown>> = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_kitchen_main', rationale: 'curated match' },
      position_index: 1,
      position_filled_via: 'curated_match',
    },
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_kitchen_backfill', rationale: 'no match — backfilled' },
      position_index: 2,
      position_filled_via: 'ai_backfill',
    },
  ];

  const curatedPrefsBySlot = new Map([
    [
      'kitchen_hero',
      [
        {
          position_index: 1,
          display_label: 'Hero',
          is_required: true,
          ai_backfill_on_gap: false,
        },
        {
          position_index: 2,
          display_label: 'Angle',
          is_required: false,
          ai_backfill_on_gap: true,
        },
        {
          position_index: 3,
          display_label: 'Detail',
          is_required: true,
          ai_backfill_on_gap: false,
        },
      ],
    ],
  ]);

  const emitted = await emitCuratedCoverageEvents({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    slotDecisions,
    curatedPrefsBySlot,
  });

  assertStrictEquals(emitted, 2);
  const types = store.events.map((e) => e.event_type).sort();
  assertEquals(types, ['coverage_gap_ai_backfilled', 'coverage_gap_required_position']);
});

Deno.test('emitCuratedCoverageEvents: empty curatedPrefsBySlot → no-op (legacy ai_decides path)', async () => {
  const store: FakeStore = { events: [], calls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const emitted = await emitCuratedCoverageEvents({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    slotDecisions: [
      {
        slot_id: 'kitchen_hero',
        phase: 1,
        winner: { stem: 'IMG_legacy', rationale: 'legacy ai_decides' },
      },
    ],
    curatedPrefsBySlot: new Map(),
  });

  assertStrictEquals(emitted, 0);
  assertStrictEquals(store.events.length, 0);
  assertStrictEquals(store.calls.length, 0);
});

Deno.test('emitCuratedCoverageEvents: idempotent — prior coverage events get cleaned up before insert', async () => {
  const store: FakeStore = {
    events: [
      {
        round_id: ROUND_ID,
        project_id: PROJECT_ID,
        event_type: 'coverage_gap_required_position',
        actor_type: 'system',
        payload: { slot_id: 'kitchen_hero', position_index: 1, stale: true },
        created_at: '2024-01-01T00:00:00Z',
      },
      {
        round_id: ROUND_ID,
        project_id: PROJECT_ID,
        event_type: 'shape_d_stage4_complete',
        actor_type: 'system',
        payload: { keep: true },
        created_at: '2024-01-01T00:00:00Z',
      },
    ],
    calls: [],
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;

  const slotDecisions: Array<Record<string, unknown>> = [
    {
      slot_id: 'kitchen_hero',
      phase: 1,
      winner: { stem: 'IMG_now', rationale: 'curated match' },
      position_index: 1,
      position_filled_via: 'curated_match',
    },
  ];

  const curatedPrefsBySlot = new Map([
    [
      'kitchen_hero',
      [
        {
          position_index: 1,
          display_label: 'Primary Hero',
          is_required: true,
          ai_backfill_on_gap: false,
        },
      ],
    ],
  ]);

  await emitCuratedCoverageEvents({
    admin,
    projectId: PROJECT_ID,
    roundId: ROUND_ID,
    slotDecisions,
    curatedPrefsBySlot,
  });

  const remaining = store.events.filter((e) => e.event_type === 'shape_d_stage4_complete');
  assertStrictEquals(remaining.length, 1);
  const coverageRows = store.events.filter((e) =>
    e.event_type === 'coverage_gap_required_position' || e.event_type === 'coverage_gap_ai_backfilled',
  );
  assertStrictEquals(coverageRows.length, 0);
});

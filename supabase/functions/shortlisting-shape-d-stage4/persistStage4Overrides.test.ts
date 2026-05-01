/**
 * W11.7.17 hotfix-2 — persistStage4Overrides delete-then-insert tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/persistStage4Overrides.test.ts
 *
 * Covers:
 *  - First run: 2 overrides → 2 rows in shortlisting_stage4_overrides + the
 *    matching mirror writes to composition_classification_overrides.
 *  - Second run on same round: prior rows are deleted before new INSERT, so
 *    re-running with a different shape produces only the latest set (no
 *    duplicate-key violation against uniq_stage4_overrides_round_stem_field).
 *  - Delete-prior error: warning is pushed but the INSERT proceeds anyway
 *    (matching persistSlotDecisions' soft-fail pattern). The unique index
 *    will surface any actual collision in the subsequent INSERT.
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistStage4Overrides } from './index.ts';

interface DbCall {
  table: string;
  kind: 'select' | 'delete' | 'insert' | 'upsert';
  filters?: Array<[string, unknown]>;
  rows?: Array<Record<string, unknown>>;
}

interface FakeStore {
  groups: Array<Record<string, unknown>>;
  audit: Array<Record<string, unknown>>;
  mirror: Array<Record<string, unknown>>;
  calls: DbCall[];
  // When true, the next delete on shortlisting_stage4_overrides errors.
  failNextDelete?: boolean;
}

function makeFakeAdmin(store: FakeStore): unknown {
  // deno-lint-ignore no-explicit-any
  const buildSelectChain = (table: string, _columns: string): any => ({
    eq(_col: string, val: unknown) {
      let data: Array<Record<string, unknown>> = [];
      if (table === 'composition_groups') {
        data = store.groups.filter((r) => r.round_id === val);
      }
      store.calls.push({ table, kind: 'select', filters: [['eq', val]] });
      return Promise.resolve({ data, error: null });
    },
  });

  // deno-lint-ignore no-explicit-any
  const buildDeleteChain = (table: string): any => {
    const filters: Array<[string, unknown]> = [];
    // deno-lint-ignore no-explicit-any
    const chain: any = {
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        // First call resolves on .eq() (single-filter delete)
        if (table === 'shortlisting_stage4_overrides' && store.failNextDelete) {
          store.failNextDelete = false;
          store.calls.push({ table, kind: 'delete', filters: [...filters] });
          return Promise.resolve({ error: { message: 'simulated delete failure' } });
        }
        // Apply the delete to the right store.
        if (table === 'shortlisting_stage4_overrides') {
          store.audit = store.audit.filter((row) => {
            for (const [c, v] of filters) {
              if (row[c] !== v) return true;
            }
            return false;
          });
        }
        store.calls.push({ table, kind: 'delete', filters: [...filters] });
        return Promise.resolve({ error: null });
      },
    };
    return chain;
  };

  return {
    from(table: string) {
      return {
        select(columns: string) {
          return buildSelectChain(table, columns);
        },
        delete() {
          return buildDeleteChain(table);
        },
        insert(rows: Array<Record<string, unknown>>) {
          if (table === 'shortlisting_stage4_overrides') {
            // Enforce uniq(round_id, stem, field) — mirrors mig 383's index.
            for (const r of rows) {
              const dup = store.audit.find(
                (a) =>
                  a.round_id === r.round_id &&
                  a.stem === r.stem &&
                  a.field === r.field,
              );
              if (dup) {
                store.calls.push({ table, kind: 'insert', rows });
                return Promise.resolve({
                  error: {
                    message:
                      'duplicate key value violates unique constraint ' +
                      '"uniq_stage4_overrides_round_stem_field"',
                  },
                });
              }
            }
            for (const r of rows) store.audit.push(r);
          }
          store.calls.push({ table, kind: 'insert', rows });
          return Promise.resolve({ error: null });
        },
        // deno-lint-ignore no-explicit-any
        upsert(row: Record<string, unknown>, _opts: any) {
          if (table === 'composition_classification_overrides') {
            const existingIdx = store.mirror.findIndex(
              (m) =>
                m.group_id === row.group_id &&
                m.round_id === row.round_id &&
                m.override_source === row.override_source,
            );
            if (existingIdx >= 0) {
              store.mirror[existingIdx] = { ...store.mirror[existingIdx], ...row };
            } else {
              store.mirror.push({ ...row });
            }
            store.calls.push({ table, kind: 'upsert', rows: [row] });
          }
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

const ROUND_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const GROUP_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const GROUP_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function seedGroups(store: FakeStore) {
  store.groups.push(
    {
      id: GROUP_A,
      round_id: ROUND_ID,
      delivery_reference_stem: 'STEM_A',
      best_bracket_stem: null,
    },
    {
      id: GROUP_B,
      round_id: ROUND_ID,
      delivery_reference_stem: 'STEM_B',
      best_bracket_stem: null,
    },
  );
}

Deno.test('persistStage4Overrides: first run inserts audit + mirror rows', async () => {
  const store: FakeStore = { groups: [], audit: [], mirror: [], calls: [] };
  seedGroups(store);
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'living_room',
        stage_4_value: 'kitchen',
        reason: 'visual evidence shows kitchen tiles',
      },
      {
        stem: 'STEM_B',
        field: 'composition_type',
        stage_1_value: 'wide',
        stage_4_value: 'detail',
        reason: 'tight crop on faucet',
      },
    ],
    warnings,
  });

  assertStrictEquals(count, 2);
  assertStrictEquals(store.audit.length, 2);
  assertStrictEquals(store.mirror.length, 2);
  assertStrictEquals(warnings.length, 0);

  // Delete fired before insert (idempotent guard).
  const stage4Calls = store.calls.filter(
    (c) => c.table === 'shortlisting_stage4_overrides',
  );
  assertStrictEquals(stage4Calls[0].kind, 'delete');
  assertStrictEquals(stage4Calls[1].kind, 'insert');
});

Deno.test('persistStage4Overrides: second run replaces first (no duplicate-key warning)', async () => {
  const store: FakeStore = { groups: [], audit: [], mirror: [], calls: [] };
  seedGroups(store);
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  // First run.
  await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'living_room',
        stage_4_value: 'kitchen',
        reason: 'first run',
      },
    ],
    warnings,
  });
  assertStrictEquals(store.audit.length, 1);
  assertStrictEquals(warnings.length, 0);

  // Second run with a DIFFERENT (stem, field) for STEM_A — would collide on
  // uniq(round_id, stem, field) without the delete-first guard.
  const count2 = await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'living_room',
        stage_4_value: 'powder_room',
        reason: 'second run revised',
      },
      {
        stem: 'STEM_B',
        field: 'vantage_point',
        stage_1_value: 'standing',
        stage_4_value: 'kneeling',
        reason: 'second run new dim',
      },
    ],
    warnings,
  });

  assertStrictEquals(count2, 2);
  // After delete-prior + insert: only the second-run rows remain.
  assertStrictEquals(store.audit.length, 2);
  // No duplicate-key warning surfaced.
  assertEquals(
    warnings.filter((w) => w.includes('duplicate key')),
    [],
  );
  // Final state contains only the second-run reasons.
  const reasons = store.audit.map((r) => r.reason).sort();
  assertEquals(reasons, ['second run new dim', 'second run revised']);
});

Deno.test('persistStage4Overrides: delete-prior error logs warning but proceeds with insert', async () => {
  const store: FakeStore = {
    groups: [],
    audit: [],
    mirror: [],
    calls: [],
    failNextDelete: true,
  };
  seedGroups(store);
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'living_room',
        stage_4_value: 'kitchen',
        reason: 'unaffected by delete failure',
      },
    ],
    warnings,
  });

  // Insert proceeded despite delete-prior failure.
  assertStrictEquals(count, 1);
  assertStrictEquals(store.audit.length, 1);
  // Warning was surfaced (not swallowed).
  assertEquals(
    warnings.filter((w) => w.includes('delete-prior failed')).length,
    1,
  );
});

Deno.test('persistStage4Overrides: empty input returns 0 with no DB calls', async () => {
  // Defensive guard — a Stage 4 round that produced no overrides shouldn't
  // touch the audit table at all (no DELETE, no INSERT). Cheap path.
  const store: FakeStore = { groups: [], audit: [], mirror: [], calls: [] };
  seedGroups(store);
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const count = await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [],
    warnings,
  });

  assertStrictEquals(count, 0);
  assertStrictEquals(store.audit.length, 0);
  assertStrictEquals(store.mirror.length, 0);
  // No DB calls at all — early return.
  assertStrictEquals(store.calls.length, 0);
  assertStrictEquals(warnings.length, 0);
});

Deno.test('persistStage4Overrides: third run on same round still yields a single set (idempotent)', async () => {
  // Three sequential runs on the same round each with overlapping (stem, field)
  // pairs — the delete-then-insert pattern should keep the audit table at
  // exactly the latest run's row count, never throwing on uniq violation.
  const store: FakeStore = { groups: [], audit: [], mirror: [], calls: [] };
  seedGroups(store);
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  // Run 1.
  await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'a',
        stage_4_value: 'b',
        reason: 'r1',
      },
    ],
    warnings,
  });
  assertStrictEquals(store.audit.length, 1);

  // Run 2.
  await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'a',
        stage_4_value: 'c',
        reason: 'r2',
      },
      {
        stem: 'STEM_B',
        field: 'composition_type',
        stage_1_value: 'wide',
        stage_4_value: 'detail',
        reason: 'r2-extra',
      },
    ],
    warnings,
  });
  assertStrictEquals(store.audit.length, 2);

  // Run 3 — back to a single override.
  await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'a',
        stage_4_value: 'd',
        reason: 'r3',
      },
    ],
    warnings,
  });

  // Final state mirrors the LATEST run only (delete-prior wins).
  assertStrictEquals(store.audit.length, 1);
  assertStrictEquals(store.audit[0].reason, 'r3');
  assertEquals(
    warnings.filter((w) => w.includes('duplicate key')),
    [],
  );
});

Deno.test('persistStage4Overrides: per-round delete is scoped (other rounds untouched)', async () => {
  // The unique index is on (round_id, stem, field). The delete-prior is
  // scoped to args.roundId — verify a second round's audit rows are not
  // wiped by a Stage 4 re-run on the first round.
  const OTHER_ROUND = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  const store: FakeStore = { groups: [], audit: [], mirror: [], calls: [] };
  seedGroups(store);
  // Pre-seed an audit row from a different round — it must survive.
  store.audit.push({
    round_id: OTHER_ROUND,
    group_id: null,
    stem: 'STEM_X',
    field: 'room_type',
    stage_1_value: 'living_room',
    stage_4_value: 'office',
    reason: 'untouched',
  });
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  await persistStage4Overrides({
    admin,
    roundId: ROUND_ID,
    stage4Overrides: [
      {
        stem: 'STEM_A',
        field: 'room_type',
        stage_1_value: 'living_room',
        stage_4_value: 'kitchen',
        reason: 'cross-round isolation',
      },
    ],
    warnings,
  });

  // Both rounds' rows present.
  assertStrictEquals(store.audit.length, 2);
  const otherRow = store.audit.find((r) => r.round_id === OTHER_ROUND);
  assertStrictEquals(otherRow?.reason, 'untouched');
  const ourRow = store.audit.find((r) => r.round_id === ROUND_ID);
  assertStrictEquals(ourRow?.reason, 'cross-round isolation');
  // Delete was filtered by round_id (scoped per round).
  const deleteCalls = store.calls.filter(
    (c) => c.table === 'shortlisting_stage4_overrides' && c.kind === 'delete',
  );
  assertStrictEquals(deleteCalls.length, 1);
  // The delete filter must have included round_id scoping.
  const filters = deleteCalls[0].filters ?? [];
  assertStrictEquals(filters.length, 1);
  assertStrictEquals(filters[0][0], 'round_id');
  assertStrictEquals(filters[0][1], ROUND_ID);
});

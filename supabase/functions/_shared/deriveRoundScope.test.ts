/**
 * deriveRoundScope.test.ts — unit tests for Stage 4 scope derivation.
 *
 * Run:
 *   deno test --no-check --allow-all \
 *     supabase/functions/_shared/deriveRoundScope.test.ts
 *
 * Covers:
 *  - happy path: package name → package_id, project_id → project_type_id,
 *    engine_grade_id → grade_id; price_tier hardcoded; product_id NULL.
 *  - missing package row: package_id stays NULL + warning emitted.
 *  - missing project row: project_type_id stays NULL + warning emitted.
 *  - NULL engine_grade_id: grade_id stays NULL + warning emitted.
 *  - cache: second call for same round_id reuses cached result (no extra DB hits).
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  deriveRoundScope,
  clearScopeCache,
  HARDCODED_STANDARD_PRICE_TIER_ID,
  type DeriveRoundScopeRow,
} from './deriveRoundScope.ts';

const ROUND_ID = '11111111-1111-1111-1111-111111111111';
const PROJECT_ID = '22222222-2222-2222-2222-222222222222';
const PACKAGE_ID = '33333333-3333-3333-3333-333333333333';
const PROJECT_TYPE_ID = '44444444-4444-4444-4444-444444444444';
const GRADE_ID = '55555555-5555-5555-5555-555555555555';

interface FakeStore {
  packages: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; project_type_id: string | null }>;
  callsByTable: Record<string, number>;
}

function makeFakeAdmin(store: FakeStore): unknown {
  store.callsByTable = store.callsByTable || {};
  // deno-lint-ignore no-explicit-any
  const buildSelectChain = (table: string): any => {
    let _column = '';
    let _value: unknown = null;
    return {
      select() {
        return this;
      },
      eq(col: string, val: unknown) {
        _column = col;
        _value = val;
        return this;
      },
      maybeSingle() {
        store.callsByTable[table] = (store.callsByTable[table] || 0) + 1;
        if (table === 'packages') {
          const row = store.packages.find((p) => p[_column as 'name' | 'id'] === _value);
          return Promise.resolve({ data: row || null, error: null });
        }
        if (table === 'projects') {
          const row = store.projects.find((p) => p[_column as 'id'] === _value);
          return Promise.resolve({ data: row || null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  };
  return {
    from(table: string) {
      return buildSelectChain(table);
    },
  };
}

function makeRound(overrides: Partial<DeriveRoundScopeRow> = {}): DeriveRoundScopeRow {
  return {
    id: ROUND_ID,
    project_id: PROJECT_ID,
    package_type: 'Silver Package',
    engine_grade_id: GRADE_ID,
    ...overrides,
  };
}

Deno.test('deriveRoundScope: happy path resolves all four scope IDs', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [{ id: PACKAGE_ID, name: 'Silver Package' }],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const result = await deriveRoundScope({ admin, round: makeRound() });
  assertStrictEquals(result.package_id, PACKAGE_ID);
  assertStrictEquals(result.project_type_id, PROJECT_TYPE_ID);
  assertStrictEquals(result.grade_id, GRADE_ID);
  assertStrictEquals(result.price_tier_id, HARDCODED_STANDARD_PRICE_TIER_ID);
  assertStrictEquals(result.product_id, null);
  assertEquals(result.warnings, []);
});

Deno.test('deriveRoundScope: missing package row yields NULL package_id + warning', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const result = await deriveRoundScope({
    admin,
    round: makeRound({ package_type: 'Phantom Package' }),
  });
  assertStrictEquals(result.package_id, null);
  assertStrictEquals(result.project_type_id, PROJECT_TYPE_ID);
  assert(result.warnings.some((w) => w.includes("name='Phantom Package'")));
});

Deno.test('deriveRoundScope: missing project_id yields NULL project_type_id + warning', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [{ id: PACKAGE_ID, name: 'Silver Package' }],
    projects: [],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const result = await deriveRoundScope({
    admin,
    round: makeRound({ project_id: 'no-such-project' }),
  });
  assertStrictEquals(result.project_type_id, null);
  assert(result.warnings.some((w) => w.includes('no project found')));
});

Deno.test('deriveRoundScope: NULL engine_grade_id is tolerated with warning', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [{ id: PACKAGE_ID, name: 'Silver Package' }],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const result = await deriveRoundScope({
    admin,
    round: makeRound({ engine_grade_id: null }),
  });
  assertStrictEquals(result.grade_id, null);
  assert(result.warnings.some((w) => w.includes('engine_grade_id is NULL')));
});

Deno.test('deriveRoundScope: NULL package_type emits a warning + leaves package_id NULL', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const result = await deriveRoundScope({
    admin,
    round: makeRound({ package_type: null }),
  });
  assertStrictEquals(result.package_id, null);
  assert(result.warnings.some((w) => w.includes('package_type is NULL/empty')));
});

Deno.test('deriveRoundScope: cache reuses prior result for same round_id', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [{ id: PACKAGE_ID, name: 'Silver Package' }],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const first = await deriveRoundScope({ admin, round: makeRound() });
  const second = await deriveRoundScope({ admin, round: makeRound() });
  // Same object reference (cache returns the cached result).
  assertStrictEquals(first, second);
  // Two lookups happened on the FIRST call; second call hit cache (no extra DB).
  assertStrictEquals(store.callsByTable['packages'], 1);
  assertStrictEquals(store.callsByTable['projects'], 1);
});

Deno.test('deriveRoundScope: cache is keyed on round_id (different rounds run separately)', async () => {
  clearScopeCache();
  const store: FakeStore = {
    packages: [{ id: PACKAGE_ID, name: 'Silver Package' }],
    projects: [{ id: PROJECT_ID, project_type_id: PROJECT_TYPE_ID }],
    callsByTable: {},
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  await deriveRoundScope({ admin, round: makeRound({ id: 'round-A' }) });
  await deriveRoundScope({ admin, round: makeRound({ id: 'round-B' }) });
  // Two rounds → two sets of DB lookups.
  assertStrictEquals(store.callsByTable['packages'], 2);
  assertStrictEquals(store.callsByTable['projects'], 2);
});

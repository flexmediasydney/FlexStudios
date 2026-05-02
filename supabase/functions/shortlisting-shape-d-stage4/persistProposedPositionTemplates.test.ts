/**
 * Mig 444 — persistProposedPositionTemplates + auto-promotion threshold tests.
 *
 * Run:
 *   deno test --no-check --allow-all \
 *     supabase/functions/shortlisting-shape-d-stage4/persistProposedPositionTemplates.test.ts
 *
 * Covers:
 *  - Each template proposal calls the upsert RPC once.
 *  - When the RPC is missing (mig 444 not applied yet), the helper warns + bails
 *    early without throwing.
 *  - Empty array returns 0 with no RPC calls.
 *  - Missing label is skipped with a warning (defensive vs malformed Gemini output).
 *  - The schema-level threshold contract (>= 5 distinct rounds + >= 15 total
 *    proposals) is mirrored in the auto-promotion fn signature defaults so that
 *    a refactor can't silently move them.
 */

import {
  assert,
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { persistProposedPositionTemplates } from './index.ts';

const ROUND_ID = '33333333-3333-3333-3333-333333333333';

interface RpcCall {
  fn: string;
  params: Record<string, unknown>;
}

interface FakeStore {
  rpcCalls: RpcCall[];
  /** When set, the RPC fails with "function does not exist" simulating missing mig. */
  rpcMissing?: boolean;
  /** When set, the RPC fails with this message for testing other error paths. */
  rpcErrorMessage?: string;
}

function makeFakeAdmin(store: FakeStore): unknown {
  return {
    rpc(fn: string, params: Record<string, unknown>) {
      store.rpcCalls.push({ fn, params });
      if (store.rpcMissing) {
        return Promise.resolve({
          error: {
            message: `function public.${fn} does not exist`,
          },
        });
      }
      if (store.rpcErrorMessage) {
        return Promise.resolve({ error: { message: store.rpcErrorMessage } });
      }
      return Promise.resolve({ data: 'fake-suggestion-uuid', error: null });
    },
  };
}

Deno.test('persistProposedPositionTemplates: 2 templates -> 2 RPC calls with correct params', async () => {
  const store: FakeStore = { rpcCalls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const templates = [
    {
      proposed_template_label: 'Kitchen — gulley with island foreground',
      constraint_pattern: { room_type: 'kitchen', composition_type: 'gulley_island' },
      candidate_stems: ['IMG_K1', 'IMG_K2'],
      reasoning: 'Two strong examples of this composition in the round.',
    },
    {
      proposed_template_label: 'Hallway through to alfresco',
      constraint_pattern: { room_type: 'hallway', zone_focus: 'doorway_through' },
      candidate_stems: ['IMG_H1'],
      reasoning: 'Recurring pattern in 4-bed homes.',
    },
  ];

  const inserted = await persistProposedPositionTemplates({
    admin,
    roundId: ROUND_ID,
    proposedPositionTemplates: templates,
    warnings,
  });

  assertStrictEquals(inserted, 2);
  assertStrictEquals(store.rpcCalls.length, 2);

  const c0 = store.rpcCalls[0];
  assertStrictEquals(c0.fn, 'shortlisting_record_position_template_suggestion');
  assertStrictEquals(c0.params.p_round_id, ROUND_ID);
  assertStrictEquals(c0.params.p_label, 'Kitchen — gulley with island foreground');
  assertEquals(c0.params.p_constraint_pattern, {
    room_type: 'kitchen',
    composition_type: 'gulley_island',
  });
  assertEquals(c0.params.p_candidate_stems, ['IMG_K1', 'IMG_K2']);
  assertStrictEquals(
    c0.params.p_reasoning,
    'Two strong examples of this composition in the round.',
  );
});

Deno.test('persistProposedPositionTemplates: empty array -> 0 RPC calls', async () => {
  const store: FakeStore = { rpcCalls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const inserted = await persistProposedPositionTemplates({
    admin,
    roundId: ROUND_ID,
    proposedPositionTemplates: [],
    warnings,
  });
  assertStrictEquals(inserted, 0);
  assertStrictEquals(store.rpcCalls.length, 0);
});

Deno.test('persistProposedPositionTemplates: missing RPC -> warn + bail early', async () => {
  const store: FakeStore = { rpcCalls: [], rpcMissing: true };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const inserted = await persistProposedPositionTemplates({
    admin,
    roundId: ROUND_ID,
    proposedPositionTemplates: [
      {
        proposed_template_label: 'A',
        constraint_pattern: {},
        candidate_stems: [],
        reasoning: 'x',
      },
      {
        proposed_template_label: 'B',
        constraint_pattern: {},
        candidate_stems: [],
        reasoning: 'y',
      },
    ],
    warnings,
  });
  // RPC missing on first call -> bail (don't try second)
  assertStrictEquals(inserted, 0);
  assertStrictEquals(store.rpcCalls.length, 1);
  assert(warnings.some((w) => w.includes('RPC missing')));
});

Deno.test('persistProposedPositionTemplates: skip entries with missing label', async () => {
  const store: FakeStore = { rpcCalls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const inserted = await persistProposedPositionTemplates({
    admin,
    roundId: ROUND_ID,
    proposedPositionTemplates: [
      // valid
      {
        proposed_template_label: 'Valid',
        constraint_pattern: {},
        candidate_stems: ['s1'],
        reasoning: 'r',
      },
      // missing label
      {
        constraint_pattern: {},
        candidate_stems: [],
        reasoning: 'r',
      },
    ],
    warnings,
  });
  assertStrictEquals(inserted, 1);
  assert(warnings.some((w) => w.includes('missing proposed_template_label')));
});

Deno.test('persistProposedPositionTemplates: per-call RPC failure does not abort the rest', async () => {
  // Different from "RPC missing" — a generic transient error on one call
  // should warn but continue to the next template.
  const store: FakeStore = {
    rpcCalls: [],
    rpcErrorMessage: 'transient unique violation', // not the "does not exist" path
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const warnings: string[] = [];

  const inserted = await persistProposedPositionTemplates({
    admin,
    roundId: ROUND_ID,
    proposedPositionTemplates: [
      {
        proposed_template_label: 'A',
        constraint_pattern: {},
        candidate_stems: [],
        reasoning: 'r',
      },
      {
        proposed_template_label: 'B',
        constraint_pattern: {},
        candidate_stems: [],
        reasoning: 'r',
      },
    ],
    warnings,
  });
  // Both attempted, both failed, none counted, but no early bail.
  assertStrictEquals(inserted, 0);
  assertStrictEquals(store.rpcCalls.length, 2);
  // 2 warnings for 2 failures
  assertEquals(
    warnings.filter((w) => w.includes('rpc failed')).length,
    2,
  );
});

// ─── Auto-promotion threshold contract test ──────────────────────────────────
// The plpgsql fn cannot be invoked from Deno; we instead read mig 444's SQL
// text and assert the documented thresholds match the spec (>= 5 rounds,
// >= 15 total proposals). A refactor that moves them silently fails this test.

Deno.test('mig 444 SQL: shortlisting_promote_position_template_suggestions threshold defaults are 5 / 15', async () => {
  const sql = await Deno.readTextFile(
    new URL('../../migrations/444_position_decisions_persistence.sql', import.meta.url),
  );
  // Defaults must be visible on the function definition
  const sigMatch = /shortlisting_promote_position_template_suggestions\(\s*p_min_rounds\s+integer\s+DEFAULT\s+5\s*,\s*p_min_proposals\s+integer\s+DEFAULT\s+15\s*\)/i;
  assert(
    sigMatch.test(sql),
    'shortlisting_promote_position_template_suggestions must have DEFAULT 5 / DEFAULT 15 thresholds in mig 444',
  );
  // Cron schedule must match Mondays 18:00 UTC
  assert(
    sql.includes("'0 18 * * 1'"),
    'mig 444 must schedule the auto-promotion fn on cron 0 18 * * 1 (Mondays 18:00 UTC)',
  );
  // The threshold body must use both columns
  assert(
    sql.includes('evidence_round_count >= p_min_rounds'),
    'mig 444 must filter on evidence_round_count >= p_min_rounds',
  );
  assert(
    sql.includes('evidence_total_proposals >= p_min_proposals'),
    'mig 444 must filter on evidence_total_proposals >= p_min_proposals',
  );
});

Deno.test('mig 444 SQL: auto-promoted slot defaults are is_active=false + auto_ prefix', async () => {
  const sql = await Deno.readTextFile(
    new URL('../../migrations/444_position_decisions_persistence.sql', import.meta.url),
  );
  // Slot id is prefixed `auto_` so operator-curated slots can't collide
  assert(
    sql.includes("'auto_'"),
    'mig 444 must prefix auto-promoted slot ids with auto_',
  );
  // Promoted slots are inactive until operator review
  assert(
    sql.includes('false,                                  -- inactive until operator review'),
    'mig 444 must promote with is_active=false',
  );
  // Audit event emitted
  assert(
    sql.includes("'position_template_auto_promoted'"),
    'mig 444 must emit a position_template_auto_promoted event for each promotion',
  );
});

Deno.test('mig 444 SQL: shortlisting_position_decisions UNIQUE on (round_id, position_index)', async () => {
  const sql = await Deno.readTextFile(
    new URL('../../migrations/444_position_decisions_persistence.sql', import.meta.url),
  );
  assert(
    /UNIQUE\s*\(\s*round_id\s*,\s*position_index\s*\)/i.test(sql),
    'shortlisting_position_decisions must declare UNIQUE (round_id, position_index)',
  );
  // CASCADE on round delete (round teardown cleans up its decisions)
  assert(
    sql.includes('REFERENCES public.shortlisting_rounds(id) ON DELETE CASCADE'),
    'shortlisting_position_decisions.round_id must FK with ON DELETE CASCADE',
  );
});

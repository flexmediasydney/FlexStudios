/**
 * W11.7.17 hotfix-2 (Fix B) — engine_run_audit upsert observability tests.
 *
 * Run: deno test --no-check --allow-all \
 *   supabase/functions/shortlisting-shape-d-stage4/engineRunAudit.test.ts
 *
 * Covers (Stage 4 side — updateEngineRunAudit):
 *  - Success path: row is upserted, success line is logged to stdout, no
 *    warnings pushed.
 *  - Failure path (upsert returns an error): the failure is mirrored to BOTH
 *    args.warnings AND console.warn so it surfaces in `supabase functions
 *    logs` (previously failures only landed in args.warnings → audit JSON).
 *  - First-run vs accumulator: when there's no prior row, stage1 totals
 *    default to 0 and total_cost_usd reflects only the Stage 4 contribution.
 *    A subsequent re-run accumulates stage4 cost on top of the prior row
 *    and includes any landed Stage 1 cost in total_cost_usd (regression
 *    guard for Rainbow Cres c55374b1 total_cost overwrite bug).
 */

import {
  assertEquals,
  assertStrictEquals,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { updateEngineRunAudit } from './index.ts';

interface UpsertCall {
  row: Record<string, unknown>;
  onConflict?: string;
}

interface FakeAuditStore {
  // Most recent row keyed by round_id (the PK).
  rows: Map<string, Record<string, unknown>>;
  upsertCalls: UpsertCall[];
  failNextUpsert?: { message: string };
}

function makeFakeAdmin(store: FakeAuditStore): unknown {
  const buildSelectChain = (table: string) => ({
    eq(_col: string, val: unknown) {
      return {
        maybeSingle() {
          if (table !== 'engine_run_audit') {
            return Promise.resolve({ data: null, error: null });
          }
          const row = store.rows.get(String(val)) ?? null;
          return Promise.resolve({ data: row, error: null });
        },
      };
    },
  });

  return {
    from(table: string) {
      return {
        select(_columns: string) {
          return buildSelectChain(table);
        },
        // deno-lint-ignore no-explicit-any
        upsert(row: Record<string, unknown>, opts: any) {
          if (table !== 'engine_run_audit') {
            return Promise.resolve({ error: null });
          }
          if (store.failNextUpsert) {
            const err = store.failNextUpsert;
            store.failNextUpsert = undefined;
            store.upsertCalls.push({ row, onConflict: opts?.onConflict });
            return Promise.resolve({ error: err });
          }
          const rid = String(row.round_id);
          const prior = store.rows.get(rid) ?? {};
          store.rows.set(rid, { ...prior, ...row });
          store.upsertCalls.push({ row, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
  };
}

// Capture console.warn / console.log into arrays so we can assert on
// observability changes without mocking the global console.
function captureConsole(): {
  logs: string[];
  warns: string[];
  restore: () => void;
} {
  const logs: string[] = [];
  const warns: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((a) => String(a)).join(' '));
  };
  return {
    logs,
    warns,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
    },
  };
}

const ROUND_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

Deno.test('updateEngineRunAudit: success path upserts row and logs ok line to stdout', async () => {
  const store: FakeAuditStore = { rows: new Map(), upsertCalls: [] };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const cap = captureConsole();
  const warnings: string[] = [];

  try {
    await updateEngineRunAudit({
      admin,
      roundId: ROUND_ID,
      vendorUsed: 'google',
      modelUsed: 'gemini-2.5-pro',
      failoverTriggered: false,
      failoverReason: null,
      stage4CostUsd: 1.4372,
      stage4WallMs: 95_000,
      stage4InputTokens: 12_000,
      stage4OutputTokens: 8_000,
      stage4ThinkingTokens: 4_096,
      promptBlockVersions: { stage4_prompt: 'v1.0.0' },
      warnings,
    });
  } finally {
    cap.restore();
  }

  // Row was upserted with the expected shape.
  assertStrictEquals(store.upsertCalls.length, 1);
  const call = store.upsertCalls[0];
  assertStrictEquals(call.onConflict, 'round_id');
  assertStrictEquals(call.row.round_id, ROUND_ID);
  // First run with no prior — total_cost == stage4 cost (rounded).
  assertStrictEquals(call.row.stage4_total_cost_usd, 1.4372);
  assertStrictEquals(call.row.total_cost_usd, 1.4372);
  assertStrictEquals(call.row.stage4_call_count, 1);
  // W11.8.2 audit-fix Fix C: thinking tokens populated.
  assertStrictEquals(call.row.stage4_total_thinking_tokens, 4_096);
  assertEquals(call.row.stages_completed, ['stage4', 'persistence']);

  // Success line went to stdout (so `supabase functions logs` shows it).
  const ok = cap.logs.find((l) =>
    l.includes('engine_run_audit Stage 4 upsert ok')
    && l.includes(`round=${ROUND_ID}`),
  );
  assertStrictEquals(typeof ok, 'string');
  // No warnings pushed on success.
  assertStrictEquals(warnings.length, 0);
  // No console.warn on success.
  assertStrictEquals(cap.warns.length, 0);
});

Deno.test('updateEngineRunAudit: upsert error mirrors to BOTH args.warnings and console.warn', async () => {
  const store: FakeAuditStore = {
    rows: new Map(),
    upsertCalls: [],
    failNextUpsert: { message: 'connection reset by peer' },
  };
  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const cap = captureConsole();
  const warnings: string[] = [];

  try {
    await updateEngineRunAudit({
      admin,
      roundId: ROUND_ID,
      // W11.8.1: vendor narrowed to 'google'; failover stripped. Test now
      // exercises the connection-error mirror path on a normal Gemini call.
      vendorUsed: 'google',
      modelUsed: 'gemini-2.5-pro',
      failoverTriggered: false,
      failoverReason: null,
      stage4CostUsd: 0.5,
      stage4WallMs: 30_000,
      stage4InputTokens: 1_000,
      stage4OutputTokens: 500,
      stage4ThinkingTokens: 0,
      promptBlockVersions: {},
      warnings,
    });
  } finally {
    cap.restore();
  }

  // The upsert was attempted exactly once.
  assertStrictEquals(store.upsertCalls.length, 1);
  // Failure was pushed into args.warnings (Dropbox audit JSON path).
  const warned = warnings.find((w) =>
    w.includes('engine_run_audit Stage 4 update failed')
    && w.includes('connection reset by peer'),
  );
  assertStrictEquals(typeof warned, 'string');
  // Failure ALSO went to stdout via console.warn (Fix B core change — the
  // sparse-engine_run_audit symptom traced back to failures only landing
  // in the Dropbox audit JSON nobody was grepping).
  const consoleWarned = cap.warns.find((w) =>
    w.includes('engine_run_audit Stage 4 update failed')
    && w.includes(`round=${ROUND_ID}`),
  );
  assertStrictEquals(typeof consoleWarned, 'string');
  // No success line emitted.
  assertEquals(
    cap.logs.filter((l) => l.includes('engine_run_audit Stage 4 upsert ok')),
    [],
  );
});

Deno.test('updateEngineRunAudit: re-run accumulates stage4 + preserves stage1 in total_cost', async () => {
  // Regression guard for Rainbow Cres c55374b1: total_cost_usd previously
  // dropped Stage 4's contribution on a Stage 1 retry (Fix B sister change
  // in shortlisting-shape-d). On the Stage 4 side, re-runs must accumulate
  // stage4 cost on top of priors AND include stage1 totals in total_*.
  const store: FakeAuditStore = { rows: new Map(), upsertCalls: [] };
  // Pre-seed a prior row representing a completed Stage 1 + earlier Stage 4.
  store.rows.set(ROUND_ID, {
    round_id: ROUND_ID,
    engine_mode: 'shape_d_full',
    vendor_used: 'google',
    stage1_total_cost_usd: 35.0,
    stage1_total_wall_ms: 600_000,
    stage1_total_input_tokens: 100_000,
    stage1_total_output_tokens: 50_000,
    stage4_total_cost_usd: 0.5,
    stage4_total_wall_ms: 20_000,
    stage4_call_count: 1,
    stage4_total_input_tokens: 5_000,
    stage4_total_output_tokens: 2_000,
    stage4_total_thinking_tokens: 2_048,
    stages_completed: ['pass0', 'stage1', 'stage4', 'persistence'],
    total_cost_usd: 35.5,
    total_wall_ms: 620_000,
    total_input_tokens: 105_000,
    total_output_tokens: 52_000,
    prompt_block_versions: { stage1_prompt: 'v3.0.0' },
  });

  // deno-lint-ignore no-explicit-any
  const admin = makeFakeAdmin(store) as any;
  const cap = captureConsole();
  const warnings: string[] = [];

  try {
    await updateEngineRunAudit({
      admin,
      roundId: ROUND_ID,
      vendorUsed: 'google',
      modelUsed: 'gemini-2.5-pro',
      failoverTriggered: false,
      failoverReason: null,
      stage4CostUsd: 0.9372, // second Stage 4 invocation cost
      stage4WallMs: 40_000,
      stage4InputTokens: 6_000,
      stage4OutputTokens: 3_000,
      stage4ThinkingTokens: 3_500,
      promptBlockVersions: { stage4_prompt: 'v1.0.0' },
      warnings,
    });
  } finally {
    cap.restore();
  }

  assertStrictEquals(store.upsertCalls.length, 1);
  const row = store.upsertCalls[0].row;
  // Stage 4 totals accumulated.
  assertStrictEquals(row.stage4_call_count, 2);
  assertStrictEquals(row.stage4_total_cost_usd, 1.4372); // 0.5 + 0.9372
  assertStrictEquals(row.stage4_total_input_tokens, 11_000);
  assertStrictEquals(row.stage4_total_output_tokens, 5_000);
  // W11.8.2 audit-fix Fix C: thinking tokens accumulate.
  assertStrictEquals(row.stage4_total_thinking_tokens, 5_548); // 2048 + 3500
  // Wall-ms takes the max (single longest call), not a sum.
  assertStrictEquals(row.stage4_total_wall_ms, 40_000);
  // total_cost_usd preserves landed Stage 1 cost (35.0) — it does NOT regress
  // to stage4-only. This is the Rainbow Cres c55374b1 regression guard.
  assertStrictEquals(row.total_cost_usd, 36.4372);
  assertStrictEquals(row.total_input_tokens, 111_000);
  assertStrictEquals(row.total_output_tokens, 55_000);
  // Prompt block versions merged (Stage 1's stage1_prompt preserved + Stage
  // 4's stage4_prompt added).
  const blocks = row.prompt_block_versions as Record<string, string>;
  assertStrictEquals(blocks.stage1_prompt, 'v3.0.0');
  assertStrictEquals(blocks.stage4_prompt, 'v1.0.0');
  // No warnings on the happy path; success was logged.
  assertStrictEquals(warnings.length, 0);
  const ok = cap.logs.find((l) =>
    l.includes('engine_run_audit Stage 4 upsert ok'),
  );
  assertStrictEquals(typeof ok, 'string');
});

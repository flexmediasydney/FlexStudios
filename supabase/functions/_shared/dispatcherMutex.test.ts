/**
 * Unit tests for dispatcherMutex (row-based dispatcher single-flight).
 *
 * Run:
 *   deno test --allow-all supabase/functions/_shared/dispatcherMutex.test.ts
 *
 * The CI gate runs `_shared/*.test.ts` so this is auto-included.
 *
 * Strategy: hand-roll a fake supabase-js builder that captures every chained
 * call so we can assert (a) the right SQL shape was emitted and (b) acquire /
 * release behave correctly across the matrix of conflict / no-conflict /
 * stale-row scenarios. Real PostgREST round-trips are not exercised — those
 * are covered by integration tests against a Supabase branch.
 */

import {
  assertEquals,
  assert,
  assertRejects,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { tryAcquireMutex, releaseMutex } from './dispatcherMutex.ts';

// ─── Fake supabase client ────────────────────────────────────────────────────

type Filter = { col: string; op: 'eq' | 'lt'; value: unknown };

type Op = {
  table: string;
  kind: 'insert' | 'delete';
  /** For inserts: the row payload. */
  payload?: Record<string, unknown>;
  /** For deletes: the chain of .eq()/.lt() filters. */
  filters?: Filter[];
};

type InsertResult =
  | { kind: 'ok'; row: Record<string, unknown> | null }
  | { kind: 'conflict' }
  | { kind: 'error'; code?: string; message?: string };

interface FakeAdminOpts {
  /** Result for the next INSERT (acquire). Defaults to ok+row. */
  insertResult?: InsertResult;
  /** Result for the DELETE (release). Defaults to ok. */
  deleteError?: { code?: string; message?: string };
}

function makeFakeAdmin(opts: FakeAdminOpts = {}) {
  const ops: Op[] = [];

  const fromImpl = (table: string) => {
    return {
      // ── INSERT path ────────────────────────────────────────────────────
      insert(payload: Record<string, unknown>) {
        const op: Op = { table, kind: 'insert', payload };
        ops.push(op);
        return {
          select(_cols: string) {
            return {
              async maybeSingle() {
                const r = opts.insertResult ?? {
                  kind: 'ok',
                  row: { lock_name: payload.lock_name },
                };
                if (r.kind === 'ok') return { data: r.row, error: null };
                if (r.kind === 'conflict') {
                  return {
                    data: null,
                    error: {
                      code: '23505',
                      message:
                        'duplicate key value violates unique constraint "dispatcher_locks_pkey"',
                    },
                  };
                }
                return {
                  data: null,
                  error: {
                    code: r.code ?? 'XX000',
                    message: r.message ?? 'fake error',
                  },
                };
              },
            };
          },
        };
      },
      // ── DELETE path ────────────────────────────────────────────────────
      // Build a thenable so chained .eq().lt() resolves at the end.
      delete() {
        const filters: Filter[] = [];
        const op: Op = { table, kind: 'delete', filters };
        ops.push(op);
        const builder: {
          eq(col: string, value: unknown): typeof builder;
          lt(col: string, value: unknown): typeof builder;
          then<T1 = unknown>(
            onF: (v: { data: null; error: { code?: string; message?: string } | null }) => T1,
          ): Promise<T1>;
        } = {
          eq(col, value) {
            filters.push({ col, op: 'eq', value });
            return builder;
          },
          lt(col, value) {
            filters.push({ col, op: 'lt', value });
            return builder;
          },
          then<T1>(
            onF: (v: { data: null; error: { code?: string; message?: string } | null }) => T1,
          ): Promise<T1> {
            return Promise.resolve(
              onF({ data: null, error: opts.deleteError ?? null }),
            );
          },
        };
        return builder;
      },
    };
  };

  return {
    admin: { from: fromImpl } as unknown as Parameters<typeof tryAcquireMutex>[0],
    ops,
  };
}

// ─── tryAcquireMutex tests ───────────────────────────────────────────────────

Deno.test(
  'tryAcquireMutex: stale-lock pre-clear DELETE runs before INSERT',
  async () => {
    const { admin, ops } = makeFakeAdmin({
      insertResult: { kind: 'ok', row: { lock_name: 'shortlisting-job-dispatcher' } },
    });

    const ok = await tryAcquireMutex(
      admin,
      'shortlisting-job-dispatcher',
      'tick-1',
    );

    assertEquals(ok, true);
    // Two ops: stale-clear DELETE then INSERT.
    assertEquals(ops.length, 2);
    assertEquals(ops[0].kind, 'delete');
    assertEquals(ops[0].table, 'dispatcher_locks');
    assertEquals(ops[1].kind, 'insert');
    assertEquals(ops[1].table, 'dispatcher_locks');
  },
);

Deno.test(
  'tryAcquireMutex: stale-clear filters by lock_name + acquired_at < cutoff',
  async () => {
    const { admin, ops } = makeFakeAdmin();
    await tryAcquireMutex(admin, 'drone-job-dispatcher', 'tick-2');

    const deleteOp = ops[0];
    assertEquals(deleteOp.kind, 'delete');
    assert(deleteOp.filters);
    // lock_name eq filter is present.
    const eqLockName = deleteOp.filters!.find(
      (f) => f.col === 'lock_name' && f.op === 'eq',
    );
    assertEquals(eqLockName?.value, 'drone-job-dispatcher');
    // acquired_at lt filter is present (ISO timestamp ~20min ago).
    const ltAcquiredAt = deleteOp.filters!.find(
      (f) => f.col === 'acquired_at' && f.op === 'lt',
    );
    assert(ltAcquiredAt, 'acquired_at < cutoff filter must be present');
    // Cutoff should be roughly 20 minutes before "now". We allow a generous
    // 60s window to absorb test runtime.
    const cutoff = new Date(ltAcquiredAt!.value as string).getTime();
    const expected = Date.now() - 20 * 60 * 1000;
    assert(
      Math.abs(cutoff - expected) < 60 * 1000,
      `stale cutoff ${cutoff} should be ~20min before now (${expected})`,
    );
  },
);

Deno.test(
  'tryAcquireMutex: INSERT row carries lock_name + acquired_by + expected_finish',
  async () => {
    const { admin, ops } = makeFakeAdmin();
    await tryAcquireMutex(
      admin,
      'shortlisting-job-dispatcher',
      'tick-abc',
      5 * 60 * 1000, // 5 minutes
    );

    const insertOp = ops.find((o) => o.kind === 'insert');
    assert(insertOp, 'expected an INSERT op');
    assertEquals(insertOp!.payload!.lock_name, 'shortlisting-job-dispatcher');
    assertEquals(insertOp!.payload!.acquired_by, 'tick-abc');
    // expected_finish must be ~now + 5min.
    const finish = new Date(
      insertOp!.payload!.expected_finish as string,
    ).getTime();
    const target = Date.now() + 5 * 60 * 1000;
    assert(
      Math.abs(finish - target) < 60 * 1000,
      `expected_finish ${finish} should be ~5min ahead of now (${target})`,
    );
  },
);

Deno.test('tryAcquireMutex: success path returns true', async () => {
  const { admin } = makeFakeAdmin({
    insertResult: { kind: 'ok', row: { lock_name: 'shortlisting-job-dispatcher' } },
  });
  const ok = await tryAcquireMutex(
    admin,
    'shortlisting-job-dispatcher',
    'tick-success',
  );
  assertEquals(ok, true);
});

Deno.test(
  'tryAcquireMutex: 23505 unique violation returns false (lock held)',
  async () => {
    const { admin } = makeFakeAdmin({ insertResult: { kind: 'conflict' } });
    const ok = await tryAcquireMutex(
      admin,
      'shortlisting-job-dispatcher',
      'tick-late',
    );
    assertEquals(ok, false);
  },
);

Deno.test(
  'tryAcquireMutex: non-23505 errors propagate (do not return false)',
  async () => {
    const { admin } = makeFakeAdmin({
      insertResult: {
        kind: 'error',
        code: '42P01',
        message: 'relation "dispatcher_locks" does not exist',
      },
    });
    await assertRejects(
      () => tryAcquireMutex(admin, 'shortlisting-job-dispatcher', 'tick-broken'),
      Error,
      'dispatcher_locks',
    );
  },
);

Deno.test(
  'tryAcquireMutex: maybeSingle returns null without error → false',
  async () => {
    // Edge case: no error code AND no row returned (shouldn't happen with the
    // real Postgres but the contract is `data !== null` so test the boundary).
    const { admin } = makeFakeAdmin({
      insertResult: { kind: 'ok', row: null },
    });
    const ok = await tryAcquireMutex(
      admin,
      'shortlisting-job-dispatcher',
      'tick-null',
    );
    assertEquals(ok, false);
  },
);

// ─── releaseMutex tests ──────────────────────────────────────────────────────

Deno.test(
  'releaseMutex: emits DELETE filtered by lock_name AND acquired_by',
  async () => {
    const { admin, ops } = makeFakeAdmin();
    await releaseMutex(admin, 'shortlisting-job-dispatcher', 'tick-xyz');

    assertEquals(ops.length, 1);
    const delOp = ops[0];
    assertEquals(delOp.kind, 'delete');
    assertEquals(delOp.table, 'dispatcher_locks');
    assert(delOp.filters);
    // BOTH eq filters must be present — without acquired_by we'd risk
    // deleting another tick's lock.
    const eqLockName = delOp.filters!.find(
      (f) => f.col === 'lock_name' && f.op === 'eq',
    );
    const eqAcquiredBy = delOp.filters!.find(
      (f) => f.col === 'acquired_by' && f.op === 'eq',
    );
    assertEquals(eqLockName?.value, 'shortlisting-job-dispatcher');
    assertEquals(eqAcquiredBy?.value, 'tick-xyz');
  },
);

Deno.test(
  'releaseMutex: tolerates no-op DELETE (row already swept)',
  async () => {
    // The fake DELETE returns { error: null } regardless of whether a row
    // matched — that's how supabase-js behaves for a delete that affected 0
    // rows. releaseMutex must NOT throw in this case.
    const { admin } = makeFakeAdmin();
    // No throw expected.
    await releaseMutex(admin, 'shortlisting-job-dispatcher', 'tick-nonexistent');
  },
);

Deno.test('releaseMutex: surfaces actual DB errors to caller', async () => {
  const { admin } = makeFakeAdmin({
    deleteError: { code: '08006', message: 'connection terminated' },
  });
  await assertRejects(
    () => releaseMutex(admin, 'shortlisting-job-dispatcher', 'tick-broken'),
    Error,
    'connection terminated',
  );
});

Deno.test(
  'releaseMutex: a tick can NOT delete a lock held by a different tick',
  async () => {
    // Verifies the filter shape: even though we can't fully simulate Postgres,
    // we assert that releaseMutex emits acquired_by=ourTickId so the SQL
    // wouldn't match a row owned by a different tick. (The real DB would
    // return rowCount=0; the fake simulates that with a no-op DELETE.)
    const { admin, ops } = makeFakeAdmin();
    await releaseMutex(admin, 'shortlisting-job-dispatcher', 'tick-mine');

    const delOp = ops[0];
    const eqAcquiredBy = delOp.filters!.find(
      (f) => f.col === 'acquired_by' && f.op === 'eq',
    );
    // If this filter is missing, ANY tick could delete the lock — that's the
    // bug we're guarding against.
    assert(eqAcquiredBy, 'releaseMutex must always filter by acquired_by');
    assertEquals(eqAcquiredBy!.value, 'tick-mine');
  },
);

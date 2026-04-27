# W7.5 — `pg_advisory_lock` Cross-Connection Unlock Fix — Decision Doc

**Status:** Decision phase. Choose an option, then ~half-day execution.
**Origin:** Surfaced during Round 2 dispatcher debugging on 2026-04-27.

## The bug

`shortlisting-job-dispatcher/index.ts` uses `pg_advisory_lock` for single-flight enforcement:

```typescript
const DISPATCHER_LOCK_KEY = stableHashBigInt('shortlisting-job-dispatcher');
// At tick start:
const { data: lockResp } = await admin.rpc('pg_try_advisory_lock', { lock_id: DISPATCHER_LOCK_KEY });
// At tick end (in finally block):
await admin.rpc('pg_advisory_unlock', { lock_id: DISPATCHER_LOCK_KEY });
```

`pg_advisory_lock` is **session-scoped** in Postgres. The lock is held by the session that acquired it, released by the same session calling `pg_advisory_unlock` OR when the session terminates.

The bug: PostgREST's connection pooling routes each `admin.rpc(...)` call to **whichever connection is free** in its pool. The lock-acquire RPC runs on connection A. The lock-release RPC routes to whichever connection — often connection B. `pg_advisory_unlock` returns `false` silently because connection B doesn't hold the lock. The lock stays on connection A's session indefinitely (until the session is recycled by the pool — typically 10+ minutes idle).

Symptoms observed in Round 2:
- Dispatcher cron runs every minute
- Each tick claims jobs (different connection, no problem)
- Each tick "releases" the lock at the end (cross-connection failure, lock not released)
- Next tick tries to acquire — gets the lock from the pool's perspective IF the previous holder happened to also be released by pool eviction; otherwise hits "concurrent_dispatch" silently
- Stale locks accumulate; debug shows `pid` rotating across cron ticks but `lock_id` persisting

The dispatcher worked OK in Round 2 *eventually* because PostgREST's pool eviction happens to clear stale sessions, but the behaviour is brittle and unpredictable.

## Two options

### Option A — `pg_advisory_xact_lock` (transaction-scoped)

Replace `pg_advisory_lock` with `pg_advisory_xact_lock`. The lock is auto-released on transaction commit/rollback. No explicit unlock needed.

**Implementation requirement.** The entire dispatcher tick body must run inside a single Postgres transaction. Today it doesn't — each `admin.rpc(...)` and `admin.from(...).update(...)` is its own implicit transaction.

To wrap the tick body in a single transaction, the dispatcher would need to:
1. Either: rewrite the tick body as a single SECURITY DEFINER PL/pgSQL function and call that. Massive refactor; the tick body is currently TypeScript with embedded Anthropic/Dropbox HTTP calls (impossible inside a Postgres function).
2. Or: open a transaction at the start of the tick via `BEGIN`, do all DB work, `COMMIT` at end. PostgREST + supabase-js doesn't natively support multi-statement transactions across RPC calls. Would need to drop down to a direct pg connection (e.g. via `Deno.connect` + a Postgres client lib).

**Pros:**
- Built-in Postgres feature
- Auto-released — no leaked state ever
- Slightly cheaper than option B (no extra row writes)

**Cons:**
- Requires either a massive PL/pgSQL rewrite OR adding a direct-pg connection alongside PostgREST
- The tick body has HTTP calls (Anthropic, Dropbox) — these can take 60+ seconds. Holding a Postgres transaction open for that long is an anti-pattern (idle-in-transaction warnings, locks held against other writers)
- Hard to instrument: who holds the lock? you query `pg_locks` (already opaque)

### Option B — Row-based mutex (recommended)

Create a `dispatcher_locks` table. Insert a row at tick start with a unique constraint on the lock name; delete the row at tick end.

```sql
CREATE TABLE dispatcher_locks (
  lock_name        TEXT PRIMARY KEY,         -- e.g. 'shortlisting-job-dispatcher'
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acquired_by      TEXT NOT NULL,            -- e.g. tick instance ID
  expected_finish  TIMESTAMPTZ,              -- soft deadline for stale detection
  metadata         JSONB                      -- optional: tick start time, function version, etc.
);
```

Acquire:
```sql
INSERT INTO dispatcher_locks (lock_name, acquired_by, expected_finish)
VALUES ('shortlisting-job-dispatcher', $tick_id, NOW() + INTERVAL '5 minutes')
ON CONFLICT (lock_name) DO NOTHING
RETURNING lock_name;
```

If the INSERT returns a row → we have the lock. If it returns nothing → lock is held by another tick → bail with `concurrent_dispatch`.

Release:
```sql
DELETE FROM dispatcher_locks WHERE lock_name = 'shortlisting-job-dispatcher' AND acquired_by = $tick_id;
```

Stale-lock recovery (runs at top of every tick before acquiring):
```sql
DELETE FROM dispatcher_locks
 WHERE lock_name = 'shortlisting-job-dispatcher'
   AND expected_finish < NOW();
```

Or simply:
```sql
DELETE FROM dispatcher_locks
 WHERE lock_name = 'shortlisting-job-dispatcher'
   AND acquired_at < NOW() - INTERVAL '20 minutes';
```

**Pros:**
- Zero connection-pool sensitivity — each operation is one Postgres statement, no session affinity required
- Auditable: `SELECT * FROM dispatcher_locks` tells you who holds the lock + when + with what context
- Stale-lock recovery is trivial and visible (DELETE pre-clears stale rows; you can see what was cleared)
- Easy to extend (multiple lock names for future single-flight needs — benchmark runner, future maintenance jobs)
- Survives any kind of connection-pool weirdness (pgBouncer, supavisor, direct, all the same)

**Cons:**
- One extra row write + delete per tick (~5ms overhead — negligible)
- More code than `pg_advisory_lock` (but only ~30 lines)

## Recommendation: Option B

Reasons:
1. The tick body has long-running HTTP calls (Anthropic Sonnet can take 30s+; Dropbox batch polling waits up to 3min). Holding a Postgres transaction open across these is fundamentally wrong for option A.
2. The connection-pool sensitivity is the BUG we're fixing. Option A solves it incidentally; option B eliminates the dependency entirely.
3. Auditable via SQL — invaluable for ops debugging.
4. The "extra row write" overhead is meaningless against the cost of the actual tick work.

## Implementation plan

```
Migration (next available — N):
  CREATE TABLE dispatcher_locks (lock_name PRIMARY KEY, ...)
  CREATE INDEX idx_dispatcher_locks_acquired_at ON dispatcher_locks(acquired_at);

  -- Pre-warm: clear any stale rows from a prior CHANGE in case of mid-flight
  DELETE FROM dispatcher_locks WHERE lock_name = 'shortlisting-job-dispatcher';
```

Edge function changes (`shortlisting-job-dispatcher/index.ts`):

```typescript
const DISPATCHER_LOCK_NAME = 'shortlisting-job-dispatcher';
const STALE_LOCK_AGE_MINUTES = 20;

async function tryAcquireMutex(admin: SupabaseClient, tickId: string): Promise<boolean> {
  // 1. Clear stale locks first
  await admin.from('dispatcher_locks')
    .delete()
    .eq('lock_name', DISPATCHER_LOCK_NAME)
    .lt('acquired_at', new Date(Date.now() - STALE_LOCK_AGE_MINUTES * 60_000).toISOString());

  // 2. Try to insert our row
  const { data, error } = await admin.from('dispatcher_locks')
    .insert({
      lock_name: DISPATCHER_LOCK_NAME,
      acquired_by: tickId,
      expected_finish: new Date(Date.now() + 5 * 60_000).toISOString(),
    })
    .select('lock_name')
    .maybeSingle();

  if (error && error.code === '23505') {
    // unique constraint violation → another tick holds the lock
    return false;
  }
  if (error) throw error;
  return data !== null;
}

async function releaseMutex(admin: SupabaseClient, tickId: string): Promise<void> {
  await admin.from('dispatcher_locks')
    .delete()
    .eq('lock_name', DISPATCHER_LOCK_NAME)
    .eq('acquired_by', tickId);
  // Don't error on no-op delete — stale-lock pre-clear may have already removed it
}

// Replace the existing pg_try_advisory_lock / pg_advisory_unlock pattern
serveWithAudit(GENERATOR, async (req) => {
  // ... auth + body parsing ...
  const tickId = crypto.randomUUID();
  const admin = getAdminClient();

  const acquired = await tryAcquireMutex(admin, tickId);
  if (!acquired) {
    return jsonResponse({ success: true, claimed: 0, dispatched: 0, failed: 0, skipped: 'concurrent_dispatch' }, 200, req);
  }

  try {
    return await runDispatcherTick(admin, req, /* ... */);
  } finally {
    await releaseMutex(admin, tickId).catch((err) =>
      console.warn(`[${GENERATOR}] mutex release failed (will be cleaned up by stale-lock sweep): ${err.message}`)
    );
  }
});
```

Other dispatchers (`drone-job-dispatcher`) follow the same pattern but use a different `lock_name`. Single migration adds one shared `dispatcher_locks` table; both dispatchers reference different rows.

## Migration safety per `MIGRATION_SAFETY.md`

```sql
-- Forward
CREATE TABLE IF NOT EXISTS dispatcher_locks (
  lock_name        TEXT PRIMARY KEY,
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acquired_by      TEXT NOT NULL,
  expected_finish  TIMESTAMPTZ,
  metadata         JSONB
);

CREATE INDEX IF NOT EXISTS idx_dispatcher_locks_acquired_at
  ON dispatcher_locks(acquired_at);

-- Pre-warm: clear any stale rows in case of mid-deploy state
DELETE FROM dispatcher_locks WHERE acquired_at < NOW() - INTERVAL '1 hour';

-- Rollback (if this migration breaks production):
--
-- DROP TABLE dispatcher_locks;
--
-- After rollback: the dispatcher reverts to pg_advisory_lock pattern. The
-- known cross-connection unlock bug returns. Stale advisory locks self-clear
-- on session recycle (~10 min). Acceptable rollback state.
```

## Effort estimate

- Half-day to write + test
- Ships with P0-2 burst (also touches dispatcher) OR as its own quick burst

## Pre-execution checklist

- [ ] Joseph signs off on Option B
- [ ] Migration number reserved
- [ ] Drone dispatcher reviewed for parallel migration (uses same lock pattern)

/**
 * dispatcherMutex — row-based single-flight mutex for cron dispatchers.
 *
 * Replaces `pg_advisory_lock` / `pg_advisory_unlock` (Wave 7 P1-11 / W7.5).
 * Advisory locks are session-scoped, but PostgREST's pool routes each RPC
 * to a different connection — the unlock RPC silently fails because the
 * connection it lands on doesn't hold the lock. Row-based mutex avoids any
 * session affinity: acquire = INSERT, release = DELETE.
 *
 * Design spec: docs/design-specs/W7-5-pg-advisory-lock-fix.md
 * Backing table: dispatcher_locks (migration 336)
 *
 * Usage (per dispatcher tick):
 *   const tickId = crypto.randomUUID();
 *   const acquired = await tryAcquireMutex(admin, 'shortlisting-job-dispatcher', tickId);
 *   if (!acquired) return jsonResponse({ skipped: 'concurrent_dispatch' }, 200, req);
 *   try {
 *     return await runTickBody(...);
 *   } finally {
 *     await releaseMutex(admin, 'shortlisting-job-dispatcher', tickId).catch(...);
 *   }
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Stale-lock age (minutes). Any lock row older than this is presumed orphaned
 * (an Edge Function panic between acquire and release leaves the row behind)
 * and is deleted at the start of every acquire attempt. 20 minutes matches
 * the dispatchers' own STALE_CLAIM_MIN sweep window — a tick that ran longer
 * than 20 minutes is presumed dead.
 */
const STALE_LOCK_AGE_MINUTES = 20;

/**
 * How long to schedule the soft expected_finish. Rows older than
 * STALE_LOCK_AGE_MINUTES are pre-cleared regardless, but expected_finish gives
 * ops a one-glance answer to "when does this lock auto-clear?" without doing
 * NOW() math. Matches the dispatcher's worst-case wall-clock budget (≈3min
 * Modal SfM + Dropbox batch) plus headroom.
 */
const EXPECTED_FINISH_MINUTES = 5;

/**
 * Try to acquire the named mutex for this tick.
 *
 * 1. Pre-clear any rows older than STALE_LOCK_AGE_MINUTES — an Edge Function
 *    panic can leave a row behind, so the next tick's acquire MUST be able to
 *    self-recover.
 * 2. INSERT a new row with ON CONFLICT DO NOTHING. If the INSERT returns a
 *    row, we have the lock. If a unique-violation (`23505`) comes back, the
 *    lock is held by another tick — return false.
 *
 * Returns `true` if the mutex was acquired by this tick, `false` if another
 * tick already holds it. Throws on unexpected DB errors.
 */
export async function tryAcquireMutex(
  admin: SupabaseClient,
  lockName: string,
  tickId: string,
  expectedFinishMs: number = EXPECTED_FINISH_MINUTES * 60 * 1000,
): Promise<boolean> {
  // 1) Stale-lock pre-clear. Bounded by lock_name so concurrent dispatchers
  //    (shortlisting + drone) don't step on each other.
  const staleCutoff = new Date(
    Date.now() - STALE_LOCK_AGE_MINUTES * 60 * 1000,
  ).toISOString();
  await admin
    .from('dispatcher_locks')
    .delete()
    .eq('lock_name', lockName)
    .lt('acquired_at', staleCutoff);

  // 2) INSERT the lock row. Postgres unique-violation on lock_name PRIMARY
  //    KEY → another tick already holds it.
  const expectedFinish = new Date(Date.now() + expectedFinishMs).toISOString();
  const { data, error } = await admin
    .from('dispatcher_locks')
    .insert({
      lock_name: lockName,
      acquired_by: tickId,
      expected_finish: expectedFinish,
    })
    .select('lock_name')
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation. supabase-js surfaces Postgres error.code on
    // the error object; the lock-already-held case is the canonical 23505
    // for an INSERT against a PRIMARY KEY.
    if (error.code === '23505') return false;
    // supabase-js error is a plain object, not an Error instance — wrap so
    // callers can rely on `instanceof Error` and `err.message`.
    throw new Error(
      `dispatcher_locks INSERT failed (code=${error.code ?? 'unknown'}): ${error.message ?? String(error)}`,
    );
  }

  return data !== null;
}

/**
 * Release the mutex.
 *
 * DELETE matches BOTH lock_name AND acquired_by, so a tick can never delete
 * a lock held by a sibling — if the row is gone (e.g. the stale-lock sweep
 * cleared it because we ran past the threshold), the DELETE is a no-op and
 * we don't error. Caller can `.catch()` to log without failing the tick.
 */
export async function releaseMutex(
  admin: SupabaseClient,
  lockName: string,
  tickId: string,
): Promise<void> {
  const { error } = await admin
    .from('dispatcher_locks')
    .delete()
    .eq('lock_name', lockName)
    .eq('acquired_by', tickId);

  if (error) {
    // Non-fatal — ops will see this in logs, and the next tick's stale-lock
    // sweep will clear the row anyway. Re-throw so the dispatcher's outer
    // catch can log a single warn line. supabase-js error is a plain object,
    // not an Error instance — wrap so callers can rely on `err.message`.
    throw new Error(
      `dispatcher_locks DELETE failed (code=${error.code ?? 'unknown'}): ${error.message ?? String(error)}`,
    );
  }
}

-- Wave 7 P1-11 (W7.5): dispatcher_locks — row-based mutex for cron dispatchers.
--
-- Replaces `pg_advisory_lock` single-flight enforcement in
-- shortlisting-job-dispatcher and drone-job-dispatcher. Advisory locks are
-- session-scoped: PostgREST routes the unlock RPC to a different connection
-- than the one that acquired the lock, so `pg_advisory_unlock` returns false
-- silently and stale locks accumulate until pool eviction (~10min).
--
-- The row-based mutex is connection-pool agnostic. Each operation is a single
-- INSERT or DELETE statement — there is no session affinity to leak. Stale
-- rows are pre-cleared by the dispatcher itself on every tick (entries older
-- than 20 minutes) so an Edge-Function panic mid-tick can't permanently
-- block subsequent ticks. The 1-hour pre-warm DELETE below covers any rows
-- in flight at deploy time.
--
-- See docs/design-specs/W7-5-pg-advisory-lock-fix.md for the full decision
-- record. Option B (row-based) was chosen over Option A (xact-lock) because
-- the dispatcher tick body has long-running HTTP calls (Anthropic 30s+,
-- Dropbox batch up to 3min) that make holding a Postgres transaction across
-- the tick fundamentally wrong.
--
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

-- Pre-warm: clear any stale rows from a prior CHANGE in case of mid-deploy
-- state. The dispatcher's own per-tick stale-lock sweep uses 20 minutes;
-- 1 hour here is the wider safety net for the deploy window itself.
DELETE FROM dispatcher_locks WHERE acquired_at < NOW() - INTERVAL '1 hour';

COMMENT ON TABLE dispatcher_locks IS
  'Wave 7 P1-11: row-based mutex for cron dispatchers. One row per active dispatcher tick (lock_name = dispatcher fn name, acquired_by = tick UUID). INSERT...ON CONFLICT DO NOTHING for acquire; DELETE WHERE lock_name=? AND acquired_by=? for release. Pre-cleared by the dispatcher itself for rows older than 20 minutes. See docs/design-specs/W7-5-pg-advisory-lock-fix.md.';

NOTIFY pgrst, 'reload schema';

-- Rollback (run manually if this migration breaks production):
--
-- DROP INDEX IF EXISTS idx_dispatcher_locks_acquired_at;
-- DROP TABLE IF EXISTS dispatcher_locks;
--
-- After rollback the dispatcher reverts to the pg_advisory_lock pattern. The
-- known cross-connection unlock bug returns: stale advisory locks self-clear
-- on session recycle (~10 min PostgREST pool churn). Acceptable rollback
-- state — the dispatcher functioned this way for several waves before P1-11.
--
-- Forward callers (shortlisting-job-dispatcher, drone-job-dispatcher) MUST
-- be reverted to the advisory-lock pattern before dropping the table, or
-- every dispatcher tick errors on the missing INSERT/DELETE. Coordinate
-- the table drop with a code revert in the same deploy window.

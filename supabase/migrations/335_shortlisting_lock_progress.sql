-- Wave 7 P0-1: shortlisting_lock_progress — async-batch lock progress tracker.
--
-- Backs the rewrite of `shortlist-lock` from per-file `/files/move_v2` calls
-- (which times out at the 150s edge gateway window for >50-file rounds) to
-- Dropbox's `/files/move_batch_v2` async batch endpoint. The new flow:
--
--   1. shortlist-lock submits ALL moves in one async batch call
--   2. INSERT shortlisting_lock_progress(stage='submitting', total_moves, ...)
--   3. Dropbox returns async_job_id immediately
--   4. Background poller (EdgeRuntime.waitUntil) polls /files/move_batch/check_v2
--      every 3s and updates progress.last_polled_at + poll_attempt_count
--   5. On '.tag' === 'complete', stage flips to 'finalizing' → 'complete'
--   6. New endpoint shortlist-lock-status reads this row for the frontend's
--      live progress bar
--
-- Resume-after-failure semantics live in the `shortlist-lock` function: when
-- called with `{round_id, resume:true}`, it looks up the latest row, checks
-- stage='failed', and re-submits a fresh batch.
--
-- Forward
CREATE TABLE IF NOT EXISTS shortlisting_lock_progress (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id                    UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  stage                       TEXT NOT NULL DEFAULT 'pending',
  -- stage values:
  --   'pending'      — row created, batch not yet submitted (transient, <1s)
  --   'submitting'   — calling /files/move_batch_v2 with the entries list
  --   'polling'      — async_job_id received, polling /files/move_batch/check_v2
  --   'finalizing'   — Dropbox reports complete, applying DB updates (round
  --                    status + training extractor invoke)
  --   'complete'     — round.status='locked' applied, terminal state
  --   'failed'       — Dropbox reported failed OR poll loop exhausted, terminal
  async_job_id                TEXT,
  total_moves                 INTEGER NOT NULL DEFAULT 0,
  succeeded_moves             INTEGER NOT NULL DEFAULT 0,
  failed_moves                INTEGER NOT NULL DEFAULT 0,
  approved_count              INTEGER NOT NULL DEFAULT 0,
  rejected_count              INTEGER NOT NULL DEFAULT 0,
  last_polled_at              TIMESTAMPTZ,
  poll_attempt_count          INTEGER NOT NULL DEFAULT 0,
  error_message               TEXT,
  errors_sample               JSONB,
  -- errors_sample carries up to the first 20 failed entries with `{from_path,
  -- failure_tag}` so the operator can spot patterns ("all my IMG_57xx files
  -- failed because they were moved manually first") without us bloating the
  -- row with thousands of failure objects.
  started_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  -- Only one row per round. UNIQUE handles re-runs: shortlist-lock must
  -- DELETE the prior row (or rely on its terminal state) before inserting
  -- a new one. DEFERRABLE INITIALLY DEFERRED so a transactional re-submit
  -- (DELETE + INSERT in one statement) doesn't conflict mid-transaction.
  CONSTRAINT uniq_lock_progress_active_per_round UNIQUE (round_id) DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX IF NOT EXISTS idx_lock_progress_round
  ON shortlisting_lock_progress(round_id);

-- Partial index for the dispatcher / janitor cron that may sweep stuck
-- in-flight progress rows (failed without a clean terminal state). Most
-- queries care only about non-terminal rows; the partial cuts index size
-- by ~95% in steady state.
CREATE INDEX IF NOT EXISTS idx_lock_progress_stage
  ON shortlisting_lock_progress(stage)
  WHERE stage NOT IN ('complete', 'failed');

COMMENT ON TABLE shortlisting_lock_progress IS
  'Wave 7 P0-1: progress tracker for shortlist-lock''s async batch-move flow. One row per lock attempt per round (UNIQUE deferrable). Read by shortlist-lock-status edge fn for the swimlane progress dialog.';

-- Rollback (run manually if this migration breaks production):
--
-- DROP INDEX IF EXISTS idx_lock_progress_stage;
-- DROP INDEX IF EXISTS idx_lock_progress_round;
-- DROP TABLE IF EXISTS shortlisting_lock_progress;
--
-- The rollback is data-lossy if any in-flight or recently-completed lock
-- progress rows exist. To preserve audit history before dropping:
--   CREATE TABLE _rollback_shortlisting_lock_progress AS
--     SELECT * FROM shortlisting_lock_progress;
-- Then DROP TABLE shortlisting_lock_progress.
--
-- Forward callers (shortlist-lock, shortlist-lock-status edge fns) MUST be
-- removed or re-pointed at a no-op before dropping the table, or every lock
-- attempt 500s on the missing INSERT.

NOTIFY pgrst, 'reload schema';

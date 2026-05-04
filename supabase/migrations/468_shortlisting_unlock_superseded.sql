-- 468_shortlisting_unlock_superseded.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Soft-supersede committed_decisions when a locked round is unlocked.
-- Per Joseph 2026-05-04:
--
--   "we lock and commit, but then want to make more adjustments. can we
--    unlock?"  Yes — added shortlist-unlock as a master_admin-only
--    operation that reverses the Dropbox file moves and lets the
--    operator resume the swimlane on the same round.
--
-- The challenge: training pipelines (mig 467) read
-- shortlisting_committed_decisions to learn from operator decisions.
-- An unlock invalidates the prior commit — the operator is going to
-- change their mind.  Re-locking writes new committed_decisions on top
-- (UPSERT on round_id + group_id), but a training extractor that ran
-- BETWEEN the unlock and the relock would have already consumed the
-- stale rows.
--
-- Resolution: add a `superseded` boolean.  shortlist-unlock flips it to
-- TRUE for every row in the round.  shortlisting-training-extractor
-- filters WHERE superseded = FALSE (mig 468 update; backfilled to
-- FALSE for all existing rows so no behaviour change for normal locks).
-- The relock flow does NOT clear `superseded`; instead its UPSERT
-- writes new rows with superseded=FALSE because that's the column
-- default.  So an unlock+relock sequence leaves only the LATEST
-- decision visible to training, with the prior cycle's row marked
-- superseded for audit only.
--
-- Why a boolean and not DELETE: deleting would erase the audit trail of
-- "the operator first picked X, then changed their mind".  That history
-- is valuable for diagnostics ("why did the AI learn the wrong thing?
-- → operator unlocked + flipped 8 cards on 2026-05-10").

BEGIN;

ALTER TABLE public.shortlisting_committed_decisions
  ADD COLUMN IF NOT EXISTS superseded boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.shortlisting_committed_decisions.superseded IS
  'TRUE when shortlist-unlock has invalidated this row.  Training pipelines filter WHERE superseded=FALSE so they never learn from a decision the operator later reversed.  A subsequent relock does NOT touch superseded rows — its UPSERT writes new rows (superseded=FALSE by default) on top of the same (round_id, group_id) primary key, so only the latest live commit is visible to training while the historical row is preserved for audit.  See mig 468.';

-- Partial index — overwhelming majority of rows are non-superseded;
-- training extractor scans live rows by round_id and benefits from
-- this filter.
CREATE INDEX IF NOT EXISTS shortlisting_committed_decisions_live_idx
  ON public.shortlisting_committed_decisions (round_id)
  WHERE superseded = false;

COMMIT;

-- ─── ROLLBACK ─────────────────────────────────────────────────────────────
-- DROP INDEX IF EXISTS shortlisting_committed_decisions_live_idx;
-- ALTER TABLE shortlisting_committed_decisions DROP COLUMN IF EXISTS superseded;

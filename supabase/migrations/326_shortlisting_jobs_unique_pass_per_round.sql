-- Wave 6 P-audit-fix: mig 326: prevent double-enqueue of pass jobs per round
-- (Audit defect #16). The dispatcher's chainNextKind logic does a read-then-
-- write pattern that can race when concurrent ticks process sibling extract
-- finishes. Two ticks can both pass the "all extracts succeeded" idempotency
-- check, then both INSERT a pass0 job for the same round → 2 pass0 jobs run
-- concurrently → composition_groups UNIQUE collision (round_id, group_index).
--
-- Fix: add a partial unique index that prevents duplicate non-terminal pass
-- jobs per round. The second concurrent INSERT fails with a unique violation
-- which the dispatcher already swallows in chainNextKind (chain failures are
-- non-fatal — the parent job is already marked succeeded).
--
-- Scope: only pass0/pass1/pass2/pass3 — NOT extract (which fans out per round)
-- and NOT ingest (which has its own debounce index from mig 284). Statuses
-- 'failed' and 'dead_letter' are excluded so a dead-letter resurrection can
-- proceed once the dead row is cleared.
--
-- Note: this migration was specified as "301" in the audit brief; that slot
-- was already taken by drone migrations (drone_pipeline_state_rpc) so this
-- ships as 326 — the next free slot above the current max (325).

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_jobs_active_pass_per_round
  ON shortlisting_jobs (round_id, kind)
  WHERE kind IN ('pass0', 'pass1', 'pass2', 'pass3')
    AND status IN ('pending', 'running', 'succeeded');

COMMENT ON INDEX uniq_shortlisting_jobs_active_pass_per_round IS
  'Prevents dispatcher chain race (audit defect #16): two concurrent ticks enqueueing the same pass kind for the same round. Resurrection (status=dead_letter) bypasses by deleting the dead row first OR via the existing chainNextKind idempotency check (which queries by status IN pending/running/succeeded).';

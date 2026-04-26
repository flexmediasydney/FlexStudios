-- Wave 6 P-audit-fix-2 Class A: mig 327: shortlisting_quarantine UNIQUE(round_id, group_id)
--
-- Audit defect #6 (P0): Pass 0 inserts shortlisting_quarantine rows for
-- out_of_scope hard-rejects but has no idempotency guard. A re-run on the
-- same round (e.g. after a partial-state crash + manual resurrect) inserts
-- duplicate rows for the same (round_id, group_id) pair.
--
-- Mitigation: partial unique index ensures the second insert fails with a
-- conflict, and Pass 0 explicitly DELETEs all quarantine rows for the round
-- before re-running (see Class A code change). The partial index is the DB
-- backstop in case a future code path forgets the cleanup.
--
-- group_id is nullable historically (pre-Pass-0 manual quarantine) — the
-- WHERE clause restricts the constraint to Pass-0-emitted rows.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shortlisting_quarantine_round_group
  ON shortlisting_quarantine (round_id, group_id)
  WHERE group_id IS NOT NULL;

COMMENT ON INDEX uniq_shortlisting_quarantine_round_group IS
  'Wave 6 P-audit-fix-2 #6: prevents Pass 0 retry from inserting duplicate quarantine rows for the same (round_id, group_id) pair. Pass 0 also pre-DELETEs as belt-and-braces.';

NOTIFY pgrst, 'reload schema';

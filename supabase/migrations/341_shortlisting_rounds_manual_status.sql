-- Wave 7 P1-19 (W7.13): extend the shortlisting_rounds.status CHECK constraint
-- to allow 'manual' so the manual-mode synthetic-round insert in
-- shortlisting-ingest succeeds.
--
-- Background: migration 282 created shortlisting_rounds with a
-- CHECK (status IN ('pending','processing','proposed','locked','delivered'))
-- constraint. W7.7 (mig 339) added the manual_mode_reason column for the
-- manual-mode flow but did NOT extend the enum. shortlisting-ingest.createManualRound
-- inserts status='manual' on a synthetic row at lock time (Option A — keeps the
-- state machine + audit JSON unified per the W7.13 spec). Without this
-- migration, the insert raises a CHECK violation and manual-mode rounds
-- silently fail.
--
-- 'manual' is a terminal-ish state: the synthetic row sits in 'manual' from
-- creation until shortlist-lock (mode='manual') flips it to 'locked'. The
-- dispatcher never sees these rounds — there are no shortlisting_jobs rows
-- pointing at them — so adding 'manual' to the enum is a pure additive
-- relaxation with no other code-path implications.

ALTER TABLE shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;

ALTER TABLE shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_status_check
  CHECK (status IN ('pending','processing','proposed','locked','delivered','manual'));

COMMENT ON COLUMN shortlisting_rounds.status IS
  'Wave 7 P1-19 (W7.13): added ''manual'' for manual-mode synthetic rounds '
  '(project_types.shortlisting_supported=false OR expected_count_target=0). '
  'Manual rounds skip Pass 0/1/2/3 and transition manual → locked at lock time.';

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual; only if migration breaks production) ──────────────────
-- ALTER TABLE shortlisting_rounds DROP CONSTRAINT IF EXISTS shortlisting_rounds_status_check;
-- ALTER TABLE shortlisting_rounds
--   ADD CONSTRAINT shortlisting_rounds_status_check
--   CHECK (status IN ('pending','processing','proposed','locked','delivered'));

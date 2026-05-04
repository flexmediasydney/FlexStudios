-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 469 — Stage 4 override "Override" path (operator-typed correction)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds a third terminal review state — `'override'` — to
-- shortlisting_stage4_overrides.review_status so the operator can capture
-- their own corrected value when neither stage_1_value nor stage_4_value is
-- right. The operator-typed value is persisted in a new `override_value`
-- column and used as the human_value when the row graduates into
-- engine_fewshot_examples.
--
-- Why a third state vs reusing 'approved':
--   - 'approved' means "Stage 4 was right" → graduates with human_value = stage_4_value.
--   - 'override' means "neither was right" → graduates with human_value = override_value.
--   - Distinct states keep the dashboard counts honest and let analytics
--     differentiate "Stage 4 trusted" from "human had to step in fully".
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE shortlisting_stage4_overrides
  ADD COLUMN IF NOT EXISTS override_value TEXT;

COMMENT ON COLUMN shortlisting_stage4_overrides.override_value IS
  'Operator-typed correct value when neither stage_1_value nor stage_4_value '
  'was right. Set only when review_status = ''override''. Used as human_value '
  'when the row graduates into engine_fewshot_examples.';

-- Replace the CHECK constraint to allow the new state.
ALTER TABLE shortlisting_stage4_overrides
  DROP CONSTRAINT IF EXISTS shortlisting_stage4_overrides_review_status_chk;

ALTER TABLE shortlisting_stage4_overrides
  ADD CONSTRAINT shortlisting_stage4_overrides_review_status_chk
  CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'deferred', 'override'));

COMMENT ON COLUMN shortlisting_stage4_overrides.review_status IS
  'Operator review state. "pending_review" (in queue) | "approved" (Stage 4 '
  'was right; graduates) | "rejected" (Stage 1 was right; declined) | '
  '"deferred" (look-later) | "override" (neither was right; operator typed '
  'override_value; graduates with human_value = override_value).';

NOTIFY pgrst, 'reload schema';

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP CONSTRAINT IF EXISTS shortlisting_stage4_overrides_review_status_chk;
-- ALTER TABLE shortlisting_stage4_overrides
--   ADD CONSTRAINT shortlisting_stage4_overrides_review_status_chk
--   CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'deferred'));
-- ALTER TABLE shortlisting_stage4_overrides DROP COLUMN IF EXISTS override_value;

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 378 — Wave 11.6/11.7: Stage 4 override review_status
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Spec: docs/design-specs/W11-6-rejection-reasons-dashboard.md §F (Stage 4
--       self-correction events) + W11.7.7 §"Stage 4 override review queue"
--
-- W11.6/W11.7.7's operator UX layer needs a queue page for Stage 4's self-
-- corrections so a master_admin can sanity-check them before they graduate
-- into the few-shot library. Today rows in shortlisting_stage4_overrides
-- (mig 371) are emitted by Stage 4 with no review state — the only way to
-- distinguish "queued for review" from "already approved" is to JOIN against
-- a separate audit table that doesn't exist.
--
-- This migration adds an inline review_status column with three states:
--   * 'pending_review' — default; Stage 4 just emitted; needs a human eye
--   * 'approved'       — operator approved the correction (graduates to
--                         engine_fewshot_examples in approve-stage4-override)
--   * 'rejected'       — operator rejected the correction; logged for tuning
--   * 'deferred'       — operator skipped (look-later)
--
-- ─── DESIGN DECISIONS ────────────────────────────────────────────────────────
--
-- 1. Inline column vs separate audit table. We pick inline because
--      (a) the queue render needs to filter on this column on every page
--          load — a separate audit table requires a JOIN.
--      (b) the column has a small finite domain (4 enum values) — no need
--          for a side table to hold extra context. The "who reviewed when"
--          context lives on the same row via reviewed_by + reviewed_at.
--      (c) cardinality is bounded — even at 200 overrides/round × 100
--          rounds/week, this is <1M rows in 6 months.
--
-- 2. Default 'pending_review' (not NULL) so the queue is the source of
--    truth: every Stage 4 override starts in the queue and only leaves
--    when an operator acts on it. NULL → "not in queue" is ambiguous.
--
-- 3. CHECK constraint enforces the 4 states. If we ever want to add
--    'auto_approved' (Stage 4 correction matched a pre-approved pattern),
--    the constraint is the place to update.
--
-- 4. reviewed_by + reviewed_at are nullable — only populated on
--    approve/reject/defer transitions. NULL in those columns means the
--    row is still pending.
--
-- 5. RLS already exists from mig 371 (SELECT to master_admin + admin).
--    UPDATE policy added here so master_admin can flip the status from
--    the queue UI. INSERT/DELETE remain service-role only (Stage 4
--    edge fn writes via service role; rejections are UPDATEs not DELETEs
--    so we keep the audit trail).
--
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. ADD COLUMNS ──────────────────────────────────────────────────────────

ALTER TABLE shortlisting_stage4_overrides
  ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'pending_review';

ALTER TABLE shortlisting_stage4_overrides
  ADD COLUMN IF NOT EXISTS reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

ALTER TABLE shortlisting_stage4_overrides
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

ALTER TABLE shortlisting_stage4_overrides
  ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- ─── 2. CHECK CONSTRAINT ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'shortlisting_stage4_overrides_review_status_chk'
  ) THEN
    ALTER TABLE shortlisting_stage4_overrides
      ADD CONSTRAINT shortlisting_stage4_overrides_review_status_chk
      CHECK (review_status IN ('pending_review', 'approved', 'rejected', 'deferred'));
  END IF;
END $$;

COMMENT ON COLUMN shortlisting_stage4_overrides.review_status IS
  'Wave 11.7.7 / W11.6 operator review state. "pending_review" (default; in '
  'queue) | "approved" (graduated; feeds engine_fewshot_examples) | "rejected" '
  '(declined; tuning signal) | "deferred" (look-later; stays in queue).';

COMMENT ON COLUMN shortlisting_stage4_overrides.reviewed_by IS
  'auth.users.id of the master_admin / admin who acted on the override. NULL '
  'while review_status = pending_review.';

COMMENT ON COLUMN shortlisting_stage4_overrides.reviewed_at IS
  'Timestamp of the most recent review_status transition (approve/reject/defer). '
  'NULL while review_status = pending_review.';

COMMENT ON COLUMN shortlisting_stage4_overrides.review_notes IS
  'Optional operator-supplied note on the review action. Useful when rejecting '
  '("Stage 4 over-corrected — Stage 1 was actually right") or deferring '
  '("need to compare against more context before deciding").';

-- ─── 3. INDEXES ──────────────────────────────────────────────────────────────

-- The queue UI's primary read is "all pending_review rows ordered by created_at
-- DESC". A partial index on pending_review makes that fast at any volume.
CREATE INDEX IF NOT EXISTS idx_stage4_overrides_pending
  ON shortlisting_stage4_overrides(created_at DESC)
  WHERE review_status = 'pending_review';

-- Per-status filter on the queue page sidebar.
CREATE INDEX IF NOT EXISTS idx_stage4_overrides_status
  ON shortlisting_stage4_overrides(review_status);

-- "What did this user review recently?" lookup.
CREATE INDEX IF NOT EXISTS idx_stage4_overrides_reviewed_by
  ON shortlisting_stage4_overrides(reviewed_by, reviewed_at DESC)
  WHERE reviewed_by IS NOT NULL;

-- ─── 4. UPDATE RLS POLICY ────────────────────────────────────────────────────
-- The SELECT policy was created by mig 371. Add an UPDATE policy so
-- master_admin can flip review_status from the queue UI. We also gate by
-- column — only review_* columns may be UPDATEd by master_admin; the rest
-- of the row (round_id, stem, field, stage_1_value, stage_4_value, reason)
-- remain immutable from the user's perspective.
--
-- Postgres doesn't support column-level UPDATE policies directly via WITH
-- CHECK; we rely on the edge fn (approve-stage4-override) to be the only
-- caller and trust the RLS UPDATE policy to gate by role. If we later need
-- column-level enforcement, we'd add a BEFORE UPDATE trigger that compares
-- OLD vs NEW for the immutable columns.

DROP POLICY IF EXISTS "shortlisting_stage4_overrides_update_master"
  ON shortlisting_stage4_overrides;
CREATE POLICY "shortlisting_stage4_overrides_update_master"
  ON shortlisting_stage4_overrides
  FOR UPDATE TO authenticated USING (
    get_user_role() IN ('master_admin', 'admin')
  );

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (manual; only if migration breaks production) ─────────────────
--
-- DROP POLICY IF EXISTS "shortlisting_stage4_overrides_update_master"
--   ON shortlisting_stage4_overrides;
-- DROP INDEX IF EXISTS idx_stage4_overrides_reviewed_by;
-- DROP INDEX IF EXISTS idx_stage4_overrides_status;
-- DROP INDEX IF EXISTS idx_stage4_overrides_pending;
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP CONSTRAINT IF EXISTS shortlisting_stage4_overrides_review_status_chk;
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP COLUMN IF EXISTS review_notes;
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP COLUMN IF EXISTS reviewed_at;
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP COLUMN IF EXISTS reviewed_by;
-- ALTER TABLE shortlisting_stage4_overrides
--   DROP COLUMN IF EXISTS review_status;

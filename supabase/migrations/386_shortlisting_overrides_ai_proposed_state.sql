-- 386_shortlisting_overrides_ai_proposed_state.sql
--
-- W11.7.1 REGRESSION FIX (2026-05-01): the Shape D Stage 4 persistSlotDecisions
-- function was writing rows to shortlisting_overrides with
-- human_action='approved_as_proposed' for the AI's own picks. The swimlane
-- (ShortlistingSwimlane.jsx) interprets that value as "the human approved
-- this proposal" and moves the card from PROPOSED to APPROVED column —
-- without the operator touching anything.
--
-- Joseph caught this on Rainbow Cres (round c55374b1): 8 cards landed in
-- HUMAN APPROVED before he'd interacted. Investigation showed 15 of 24
-- approved_as_proposed rows across all rounds were system-written (rather
-- than human-written) — distinguishable by review_duration_seconds IS NULL
-- (humans always have a non-null duration; the system worker doesn't set it).
--
-- The runtime fix:
--   - Stage 4 persistSlotDecisions now writes human_action='ai_proposed'
--   - ShortlistingSwimlane.jsx switch handles 'ai_proposed' as "move to
--     PROPOSED column" (not APPROVED)
--
-- This migration backfills the 15 already-misclassified system rows.

-- Step 1: Extend the CHECK constraint to allow the new 'ai_proposed' value.
-- The original 4 values stay valid (real human actions); 'ai_proposed' is the
-- new "AI's pick, no human interaction yet" state.
ALTER TABLE shortlisting_overrides
  DROP CONSTRAINT IF EXISTS shortlisting_overrides_human_action_check;
ALTER TABLE shortlisting_overrides
  ADD CONSTRAINT shortlisting_overrides_human_action_check
  CHECK (human_action = ANY (ARRAY[
    'approved_as_proposed'::text,
    'removed'::text,
    'swapped'::text,
    'added_from_rejects'::text,
    'ai_proposed'::text
  ]));

-- Step 2: Backfill the 15 system-written rows that were misclassified.
-- `confirmed_with_review` defaults to TRUE so it's not a useful signal —
-- `review_duration_seconds IS NULL` is the reliable distinguisher (humans
-- always have a measured duration; the worker doesn't set it).
UPDATE shortlisting_overrides
   SET human_action = 'ai_proposed'
 WHERE human_action = 'approved_as_proposed'
   AND review_duration_seconds IS NULL;

-- Observability: log the row counts post-update so the migration audit shows
-- what shifted.
DO $$
DECLARE
  v_ai_proposed int;
  v_human_approved int;
BEGIN
  SELECT COUNT(*) INTO v_ai_proposed
    FROM shortlisting_overrides WHERE human_action = 'ai_proposed';
  SELECT COUNT(*) INTO v_human_approved
    FROM shortlisting_overrides WHERE human_action = 'approved_as_proposed';
  RAISE NOTICE
    'Migration 386: backfill complete — ai_proposed=%, human approved_as_proposed=% (preserved real human approvals)',
    v_ai_proposed, v_human_approved;
END $$;

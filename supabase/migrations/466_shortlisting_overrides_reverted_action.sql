-- 466_shortlisting_overrides_reverted_action.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Add 'reverted_to_ai_proposed' to the human_action check on
-- shortlisting_overrides.
--
-- Operator-feedback (2026-05-04): dragging a card BACK to the AI Proposed
-- column appeared to do nothing because the prior approve/reject row was
-- still in the DB and re-asserted "card is approved" on refetch.  Adding
-- a first-class undo action lets the operator say "I changed my mind,
-- the AI's choice was right after all" without emitting a 'removed'
-- training signal that would teach the engine the AI was wrong.
--
-- Semantics:
--   - approved_as_proposed → POSITIVE training signal (operator agreed)
--   - removed              → NEGATIVE training signal (operator overrode)
--   - reverted_to_ai_proposed → NEUTRAL (operator explored alternatives,
--     ultimately came back to the AI's pick — neither a win nor a loss
--     for the engine, but worth recording for audit + future analysis)
--
-- shortlistLockMoves.computeApprovedRejectedSets adds the action to the
-- approved set + clears any prior 'explicitly_removed' flag so the
-- rejection-reasons pipeline doesn't pick this group up.
--
-- This migration is paired with the in-flight code change to
-- deriveHumanAction in ShortlistingSwimlane.jsx (drag from approved or
-- rejected → proposed now emits 'reverted_to_ai_proposed' instead of
-- silently emitting nothing) and the VALID_ACTIONS Set in the
-- shortlisting-overrides edge fn.

BEGIN;

ALTER TABLE public.shortlisting_overrides
  DROP CONSTRAINT IF EXISTS shortlisting_overrides_human_action_check;

ALTER TABLE public.shortlisting_overrides
  ADD CONSTRAINT shortlisting_overrides_human_action_check
    CHECK (human_action = ANY (ARRAY[
      'approved_as_proposed'::text,
      'removed'::text,
      'swapped'::text,
      'added_from_rejects'::text,
      'ai_proposed'::text,
      'reverted_to_ai_proposed'::text
    ]));

COMMENT ON CONSTRAINT shortlisting_overrides_human_action_check
  ON public.shortlisting_overrides IS
  'Allowed human_action values for swimlane interactions. ''reverted_to_ai_proposed'' (added 2026-05-04) lets operators undo a prior approve/reject and return a card to the AI-proposed state without emitting a negative training signal.';

COMMIT;

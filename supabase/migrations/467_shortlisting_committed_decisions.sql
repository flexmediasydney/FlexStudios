-- 467_shortlisting_committed_decisions.sql
-- ─────────────────────────────────────────────────────────────────────────
-- Separate "WIP review state" (every drag = a row in shortlisting_overrides)
-- from "canonical AI training feedback" (one row per group at LOCK time
-- in shortlisting_committed_decisions).  Per Joseph 2026-05-04:
--
--   "if you log instantly every instance of movements as official AI
--    engine feedback, i think you're going to get flooded with bad
--    review/feedback data into the ai learning loop. instead, i think
--    once the initial shortlist proposal for the round is generated,
--    you should have a starting state for each file - and only upon
--    Locking, would you actually commit all the feedback/review/learnings
--    into the engine."
--
-- Two changes:
--   1. shortlisting_rounds.initial_proposed_group_ids — JSONB array of
--      group_ids the AI initially proposed.  Captured ONCE on first
--      Stage 4 emit, frozen against re-runs.  Used at lock time to
--      compute the initial vs final state delta.
--   2. shortlisting_committed_decisions — one row per (round, group)
--      written by shortlist-lock at lock time.  Carries the
--      feedback_signal derived from delta + annotations aligned with
--      the FINAL state (intermediate "I changed my mind" reasons are
--      filtered out so contradictory feedback never reaches training).
--
-- Training pipelines (fewshot graduation, signal_attribution,
-- canonical-rollup) read shortlisting_committed_decisions ONLY.  The
-- noisy WIP table stays for audit + UI persistence but is no longer the
-- training source.

BEGIN;

-- ─── shortlisting_rounds: initial_proposed_group_ids snapshot ────────────

ALTER TABLE public.shortlisting_rounds
  ADD COLUMN IF NOT EXISTS initial_proposed_group_ids jsonb;

COMMENT ON COLUMN public.shortlisting_rounds.initial_proposed_group_ids IS
  'JSONB array of composition_groups.id values the AI initially proposed for this round (set on FIRST Stage 4 emit, frozen against re-runs). Used by shortlist-lock to compute the initial vs final state delta when writing shortlisting_committed_decisions. NULL for legacy rounds run before mig 467.';

-- ─── shortlisting_committed_decisions ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.shortlisting_committed_decisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id        uuid NOT NULL REFERENCES public.shortlisting_rounds(id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  group_id        uuid NOT NULL REFERENCES public.composition_groups(id) ON DELETE CASCADE,

  initial_state   text NOT NULL CHECK (initial_state IN ('ai_proposed', 'not_proposed')),
  final_state     text NOT NULL CHECK (final_state   IN ('approved', 'rejected')),

  feedback_signal text NOT NULL CHECK (feedback_signal IN (
    'agreed_with_ai_pick',     -- AI proposed   → operator approved   (POSITIVE)
    'agreed_with_ai_reject',   -- AI not proposed → operator rejected (POSITIVE)
    'overrode_to_approve',     -- AI not proposed → operator approved (CORRECTIVE: AI missed)
    'overrode_to_reject'       -- AI proposed   → operator rejected   (CORRECTIVE: AI wrong)
  )),

  -- Pulled from the override that ESTABLISHED the final state (latest
  -- aligned action).  Annotations from intermediate reverted-state
  -- moves are NOT retained — only the final-state-aligned reason
  -- contributes to training.
  ai_proposed_slot_id        text,
  ai_proposed_score          numeric,
  combined_score             numeric,
  primary_signal_overridden  text,
  override_reason            text,
  client_review_notes        text,

  -- Diagnostic: how many overrides did this group accumulate before
  -- the operator settled?  1 = decisive; 5+ = exploratory.  Useful
  -- input for weighting the training signal (lower confidence on
  -- thrashy reviews).
  movement_count             integer NOT NULL DEFAULT 0,

  committed_at  timestamptz NOT NULL DEFAULT now(),
  committed_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,

  -- One canonical decision per (round, group).  Re-locking a round
  -- UPSERTs onto this constraint.
  UNIQUE (round_id, group_id)
);

COMMENT ON TABLE public.shortlisting_committed_decisions IS
  'Lock-time canonical AI training feedback.  One row per (round, group) written by shortlist-lock based on the delta between the AI''s initial_proposed_group_ids snapshot and the operator''s final approved/rejected sets.  Annotations from intermediate moves that were reverted are discarded — only the final-state-aligned reason survives.';

COMMENT ON COLUMN public.shortlisting_committed_decisions.feedback_signal IS
  'Derived from (initial_state, final_state) pair: agreed_with_ai_pick = AI proposed → operator approved (positive); agreed_with_ai_reject = AI not proposed → operator rejected (positive); overrode_to_approve = AI not proposed → operator approved (corrective: AI missed); overrode_to_reject = AI proposed → operator rejected (corrective: AI wrong).';

COMMENT ON COLUMN public.shortlisting_committed_decisions.movement_count IS
  'Count of shortlisting_overrides rows for this (round, group). 1 = decisive; high count = exploratory. Useful for training weight (low confidence on thrashy reviews).';

-- ─── Indexes ─────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS shortlisting_committed_decisions_round_idx
  ON public.shortlisting_committed_decisions (round_id);
CREATE INDEX IF NOT EXISTS shortlisting_committed_decisions_project_idx
  ON public.shortlisting_committed_decisions (project_id);
CREATE INDEX IF NOT EXISTS shortlisting_committed_decisions_signal_idx
  ON public.shortlisting_committed_decisions (feedback_signal);
CREATE INDEX IF NOT EXISTS shortlisting_committed_decisions_committed_at_idx
  ON public.shortlisting_committed_decisions (committed_at DESC);

-- ─── RLS ─────────────────────────────────────────────────────────────────
-- master_admin / admin / manager RW.  All authenticated read so the
-- swimlane + coverage tab can render the post-lock summary.

ALTER TABLE public.shortlisting_committed_decisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS shortlisting_committed_decisions_read
  ON public.shortlisting_committed_decisions;
CREATE POLICY shortlisting_committed_decisions_read
  ON public.shortlisting_committed_decisions
  FOR SELECT
  TO authenticated
  USING (true);

-- service_role (Supabase Edge Functions) bypasses RLS — that's how
-- shortlist-lock writes the rows. No INSERT/UPDATE policy for
-- authenticated users; all writes go via the locked-down edge fn path.

COMMIT;

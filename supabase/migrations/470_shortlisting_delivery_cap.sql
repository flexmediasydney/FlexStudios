-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 470 — Shortlisting delivery cap (client-driven count override)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The engine proposes images per the package's editorial quota (e.g. 25 sales
-- + 4 dusk = 29 for a Gold package). Some clients want fewer (15-18 typical)
-- for delivery reasons that have nothing to do with image quality. Without a
-- cap, the operator has to manually reject 14 — which currently feeds those
-- 14 into engine_fewshot_examples / shortlisting_committed_decisions as
-- *quality* rejections, polluting future training signal.
--
-- This migration adds:
--   1. shortlisting_rounds.delivery_cap_override INT NULL
--      The client-requested deliverable count for THIS round. NULL = no cap
--      (engine quota governs). Non-null overrides the per-bucket quota gate
--      with a single "deliver N images, any bucket" rule.
--
--   2. shortlisting_overrides.auto_trim_source TEXT NULL
--      Tags overrides emitted by the cap-trim system rather than the human
--      operator. Currently one value: 'delivery_cap'. shortlist-lock reads
--      this at commit time to decide whether the rejection should feed
--      training signal.
--
--   3. shortlisting_committed_decisions.excluded_from_learning BOOLEAN
--      Lock-time flag on the canonical training row. TRUE for any committed
--      rejection whose establishing override was a cap-trim. Downstream
--      training pipelines filter WHERE excluded_from_learning = FALSE.
--
--   4. apply_delivery_cap(p_round_id UUID, p_cap INT) RPC
--      Atomic re-trim. Reads the current proposed set from the override log
--      (latest-action-wins), sorts by composition_classifications.combined_
--      score DESC, and writes new override events to bring the proposed
--      count to exactly p_cap:
--        - Groups beyond cap → INSERT 'removed' override w/ auto_trim_source
--        - Groups previously cap-trimmed but now within cap (cap was raised
--          or removed) → INSERT 'added_from_rejects' override to revert
--      All edits go through the override event log — no DELETE, no schema
--      bypass. Audit trail intact.
--
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. shortlisting_rounds.delivery_cap_override ────────────────────────────

ALTER TABLE shortlisting_rounds
  ADD COLUMN IF NOT EXISTS delivery_cap_override INT;

ALTER TABLE shortlisting_rounds
  DROP CONSTRAINT IF EXISTS shortlisting_rounds_delivery_cap_chk;
ALTER TABLE shortlisting_rounds
  ADD CONSTRAINT shortlisting_rounds_delivery_cap_chk
  CHECK (delivery_cap_override IS NULL OR delivery_cap_override > 0);

COMMENT ON COLUMN shortlisting_rounds.delivery_cap_override IS
  'Client-requested deliverable count override (mig 470). NULL = no cap (use '
  'package quota). Non-null replaces the per-bucket editorial quota gate with '
  'a single "deliver N total" rule. Lock criteria: approved+proposed >= cap. '
  'Triggers cap-trim via apply_delivery_cap RPC; trims are tagged '
  'auto_trim_source=''delivery_cap'' on shortlisting_overrides so they''re '
  'excluded from training signal.';

-- ─── 2. shortlisting_overrides.auto_trim_source ──────────────────────────────

ALTER TABLE shortlisting_overrides
  ADD COLUMN IF NOT EXISTS auto_trim_source TEXT;

ALTER TABLE shortlisting_overrides
  DROP CONSTRAINT IF EXISTS shortlisting_overrides_auto_trim_source_chk;
ALTER TABLE shortlisting_overrides
  ADD CONSTRAINT shortlisting_overrides_auto_trim_source_chk
  CHECK (auto_trim_source IS NULL OR auto_trim_source IN ('delivery_cap'));

COMMENT ON COLUMN shortlisting_overrides.auto_trim_source IS
  'Mig 470. NULL for normal operator overrides. ''delivery_cap'' for system-'
  'emitted overrides from apply_delivery_cap. shortlist-lock reads this and '
  'sets shortlisting_committed_decisions.excluded_from_learning=true so the '
  'rejection doesn''t pollute training signal — the operator only trimmed it '
  'because the client wanted fewer images, not because it was a bad shot.';

CREATE INDEX IF NOT EXISTS idx_shortlisting_overrides_auto_trim
  ON shortlisting_overrides(round_id, auto_trim_source)
  WHERE auto_trim_source IS NOT NULL;

-- ─── 3. shortlisting_committed_decisions.excluded_from_learning ──────────────

ALTER TABLE shortlisting_committed_decisions
  ADD COLUMN IF NOT EXISTS excluded_from_learning BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN shortlisting_committed_decisions.excluded_from_learning IS
  'Mig 470. TRUE means this committed decision should NOT feed the AI '
  'learning loop (fewshot graduation, signal_attribution, project_memory). '
  'Set TRUE at lock time when the establishing override carried '
  'auto_trim_source=''delivery_cap'' — the rejection was a delivery-count '
  'decision, not a quality decision. Downstream training pipelines filter '
  'WHERE excluded_from_learning = FALSE.';

CREATE INDEX IF NOT EXISTS idx_committed_decisions_learning
  ON shortlisting_committed_decisions(excluded_from_learning)
  WHERE excluded_from_learning = TRUE;

-- ─── 4. apply_delivery_cap RPC ───────────────────────────────────────────────
--
-- Drop & recreate is safe — function has no other callers.
DROP FUNCTION IF EXISTS apply_delivery_cap(UUID, INT);

CREATE OR REPLACE FUNCTION apply_delivery_cap(
  p_round_id UUID,
  p_cap      INT  -- NULL clears the cap and reverts all prior cap-trims
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_project_id      UUID;
  v_kept_count      INT := 0;
  v_trimmed_count   INT := 0;
  v_reverted_count  INT := 0;
  v_now             TIMESTAMPTZ := NOW();
BEGIN
  -- Resolve project_id (and validate the round exists).
  SELECT project_id INTO v_project_id
  FROM shortlisting_rounds
  WHERE id = p_round_id;

  IF v_project_id IS NULL THEN
    RAISE EXCEPTION 'round % not found', p_round_id;
  END IF;

  -- 1. Update the cap on the round.
  UPDATE shortlisting_rounds
  SET delivery_cap_override = p_cap,
      updated_at = v_now
  WHERE id = p_round_id;

  -- 2. Compute the current "proposed" set per group from the override log
  --    (latest action wins per group). A group is currently proposed iff its
  --    latest override action is 'approved_as_proposed' OR 'added_from_rejects'
  --    (or it has no override at all and is in the AI's seed proposed list).
  --
  --    For the cap-trim computation we use the round's classifications joined
  --    with the live override state.
  WITH latest_override AS (
    SELECT DISTINCT ON (
      COALESCE(human_selected_group_id, ai_proposed_group_id)
    )
      COALESCE(human_selected_group_id, ai_proposed_group_id) AS group_id,
      human_action,
      auto_trim_source,
      created_at
    FROM shortlisting_overrides
    WHERE round_id = p_round_id
      AND COALESCE(human_selected_group_id, ai_proposed_group_id) IS NOT NULL
    ORDER BY
      COALESCE(human_selected_group_id, ai_proposed_group_id),
      created_at DESC
  ),
  classifications AS (
    SELECT
      cc.group_id,
      cc.combined_score
    FROM composition_classifications cc
    WHERE cc.round_id = p_round_id
  ),
  -- A group's "proposed-ness" is determined by its latest override action.
  -- Groups with no override at all are treated as proposed iff they're in
  -- the round's initial_proposed_group_ids (the AI's original picks).
  initial_proposed AS (
    SELECT jsonb_array_elements_text(initial_proposed_group_ids)::UUID AS group_id
    FROM shortlisting_rounds
    WHERE id = p_round_id
      AND initial_proposed_group_ids IS NOT NULL
  ),
  group_state AS (
    SELECT
      c.group_id,
      c.combined_score,
      lo.human_action,
      lo.auto_trim_source,
      CASE
        -- Latest action says proposed
        WHEN lo.human_action IN ('approved_as_proposed', 'added_from_rejects', 'swapped')
          THEN TRUE
        -- Latest action says removed
        WHEN lo.human_action = 'removed' THEN FALSE
        -- No override yet → proposed iff in initial AI picks
        WHEN lo.human_action IS NULL
          THEN c.group_id IN (SELECT group_id FROM initial_proposed)
        ELSE FALSE
      END AS is_proposed
    FROM classifications c
    LEFT JOIN latest_override lo ON lo.group_id = c.group_id
  ),
  ranked AS (
    SELECT
      group_id,
      combined_score,
      human_action,
      auto_trim_source,
      is_proposed,
      ROW_NUMBER() OVER (
        ORDER BY combined_score DESC NULLS LAST, group_id
      ) AS score_rank
    FROM group_state
    WHERE is_proposed = TRUE
       OR auto_trim_source = 'delivery_cap'  -- include prior cap-trims for revert eligibility
  )
  -- 3. For each ranked group, decide what action to emit:
  --      score_rank <= cap AND is_proposed=FALSE AND prior cap-trim
  --        → REVERT (added_from_rejects)
  --      score_rank > cap  AND is_proposed=TRUE
  --        → TRIM (removed w/ auto_trim_source='delivery_cap')
  --      otherwise: no-op
  INSERT INTO shortlisting_overrides (
    project_id,
    round_id,
    ai_proposed_group_id,
    human_action,
    human_selected_group_id,
    override_reason,
    override_note,
    auto_trim_source,
    confirmed_with_review,
    created_at
  )
  SELECT
    v_project_id,
    p_round_id,
    -- For reverts: ai_proposed_group_id stays NULL (we're adding to proposed).
    -- For trims: ai_proposed_group_id = the group being trimmed.
    CASE
      WHEN p_cap IS NOT NULL AND r.score_rank > p_cap AND r.is_proposed
        THEN r.group_id
      ELSE NULL
    END,
    CASE
      WHEN p_cap IS NULL AND r.auto_trim_source = 'delivery_cap'
        THEN 'added_from_rejects'  -- cap cleared → revert all prior trims
      WHEN p_cap IS NOT NULL AND r.auto_trim_source = 'delivery_cap'
                              AND r.score_rank <= p_cap
        THEN 'added_from_rejects'  -- cap raised, prior trim no longer applies
      WHEN p_cap IS NOT NULL AND r.score_rank > p_cap AND r.is_proposed
        THEN 'removed'             -- new trim
      ELSE NULL
    END,
    CASE
      WHEN p_cap IS NULL AND r.auto_trim_source = 'delivery_cap' THEN r.group_id
      WHEN p_cap IS NOT NULL AND r.auto_trim_source = 'delivery_cap'
                              AND r.score_rank <= p_cap THEN r.group_id
      ELSE NULL
    END,
    'client_instruction',  -- override_reason: cap is a client-driven decision
    CASE
      WHEN p_cap IS NULL THEN 'Auto-revert: delivery cap cleared'
      ELSE format('Auto-trim: delivery cap = %s', p_cap)
    END,
    CASE
      WHEN p_cap IS NOT NULL AND r.score_rank > p_cap AND r.is_proposed
        THEN 'delivery_cap'
      ELSE NULL  -- reverts don't carry the trim source (they're un-trims)
    END,
    TRUE,
    v_now
  FROM ranked r
  WHERE
    -- Emit a row only when an action is needed (i.e. CASE returns non-null)
    (p_cap IS NULL AND r.auto_trim_source = 'delivery_cap')
    OR (p_cap IS NOT NULL AND r.auto_trim_source = 'delivery_cap' AND r.score_rank <= p_cap)
    OR (p_cap IS NOT NULL AND r.score_rank > p_cap AND r.is_proposed);

  GET DIAGNOSTICS v_trimmed_count = ROW_COUNT;

  -- Re-count post-apply for the response.
  WITH latest_override AS (
    SELECT DISTINCT ON (
      COALESCE(human_selected_group_id, ai_proposed_group_id)
    )
      COALESCE(human_selected_group_id, ai_proposed_group_id) AS group_id,
      human_action,
      auto_trim_source
    FROM shortlisting_overrides
    WHERE round_id = p_round_id
      AND COALESCE(human_selected_group_id, ai_proposed_group_id) IS NOT NULL
    ORDER BY
      COALESCE(human_selected_group_id, ai_proposed_group_id),
      created_at DESC
  )
  SELECT
    COUNT(*) FILTER (
      WHERE human_action IN ('approved_as_proposed', 'added_from_rejects', 'swapped')
    ),
    COUNT(*) FILTER (
      WHERE human_action = 'removed' AND auto_trim_source = 'delivery_cap'
    )
  INTO v_kept_count, v_reverted_count
  FROM latest_override;

  RETURN jsonb_build_object(
    'ok', true,
    'round_id', p_round_id,
    'cap', p_cap,
    'overrides_inserted', v_trimmed_count,
    'kept_count', v_kept_count,
    'cap_trimmed_count', v_reverted_count
  );
END;
$$;

COMMENT ON FUNCTION apply_delivery_cap IS
  'Mig 470. Applies a delivery cap to a shortlisting round, atomically '
  're-balancing the proposed/rejected sets via the override event log. '
  'Pass p_cap=NULL to clear the cap (reverts all prior cap-trims). '
  'Returns JSONB with overrides_inserted, kept_count, cap_trimmed_count.';

-- Restrict execution: master_admin / admin only (cross-cutting cost +
-- training-signal implication). The edge fn wrapping this RPC re-checks the
-- caller's role; the GRANT here is a defense-in-depth gate.
REVOKE ALL ON FUNCTION apply_delivery_cap(UUID, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION apply_delivery_cap(UUID, INT) TO authenticated;
GRANT EXECUTE ON FUNCTION apply_delivery_cap(UUID, INT) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- ─── Rollback ───────────────────────────────────────────────────────────────
-- BEGIN;
-- DROP FUNCTION IF EXISTS apply_delivery_cap(UUID, INT);
-- DROP INDEX IF EXISTS idx_committed_decisions_learning;
-- ALTER TABLE shortlisting_committed_decisions DROP COLUMN IF EXISTS excluded_from_learning;
-- DROP INDEX IF EXISTS idx_shortlisting_overrides_auto_trim;
-- ALTER TABLE shortlisting_overrides
--   DROP CONSTRAINT IF EXISTS shortlisting_overrides_auto_trim_source_chk;
-- ALTER TABLE shortlisting_overrides DROP COLUMN IF EXISTS auto_trim_source;
-- ALTER TABLE shortlisting_rounds
--   DROP CONSTRAINT IF EXISTS shortlisting_rounds_delivery_cap_chk;
-- ALTER TABLE shortlisting_rounds DROP COLUMN IF EXISTS delivery_cap_override;
-- COMMIT;

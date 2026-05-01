-- W11.6.1-hotfix BUG #3 — Retouch tab Shape D plumbing.
--
-- Shape D writes retouch signals to composition_classifications
-- (flag_for_retouching=TRUE + clutter_severity + clutter_detail). The
-- legacy shortlisting_retouch_flags table has zero rows on Shape D
-- rounds, so the Retouch sub-tab in ProjectShortlistingTab read empty.
--
-- The Resolve action used to flip shortlisting_retouch_flags.resolved.
-- Under Shape D there's no equivalent column on
-- composition_classifications, so we add two:
--   - retouch_resolved_at  TIMESTAMPTZ NULL  — when the operator marked
--                                              the retouch flag handled.
--   - retouch_resolved_by  UUID         NULL — who marked it.
--
-- The Retouch UI filters WHERE retouch_resolved_at IS NULL so resolved
-- rows disappear from the active queue (mirrors the legacy "resolved"
-- column semantics). A "Show resolved" toggle re-includes them.
--
-- Indexed for the "active retouch queue" filter the UI runs every render.

ALTER TABLE composition_classifications
  ADD COLUMN IF NOT EXISTS retouch_resolved_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS retouch_resolved_by UUID NULL;

COMMENT ON COLUMN composition_classifications.retouch_resolved_at IS
  'W11.6.1-hotfix: when the operator marked this row''s retouch flag handled. NULL=still in active retouch queue. Filter the UI WHERE retouch_resolved_at IS NULL for the unresolved view.';

COMMENT ON COLUMN composition_classifications.retouch_resolved_by IS
  'W11.6.1-hotfix: who marked the retouch flag handled. Pairs with retouch_resolved_at.';

-- Partial index — only the unresolved-and-flagged rows. Tiny + hot.
CREATE INDEX IF NOT EXISTS idx_comp_class_retouch_active
  ON composition_classifications (round_id, classified_at DESC)
  WHERE flag_for_retouching = TRUE AND retouch_resolved_at IS NULL;

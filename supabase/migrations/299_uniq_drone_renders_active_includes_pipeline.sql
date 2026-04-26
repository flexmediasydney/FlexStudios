-- ═══════════════════════════════════════════════════════════════════════════
-- 299: uniq_drone_renders_active_per_variant must include pipeline
-- ───────────────────────────────────────────────────────────────────────────
-- QC4 finding NB-2 (Walker A): the unique index was on
--   (shot_id, kind, COALESCE(output_variant,'default'), column_state)
-- WHERE column_state IN ('pool','accepted','adjustments','final')
--
-- Conflict: a shot can't have BOTH a pipeline='raw' column_state='pool'
-- render AND a pipeline='edited' column_state='pool' render with the same
-- kind+variant — they collide on the unique constraint, even though Wave 5
-- mig 282's pipeline-split intent supports them coexisting (raw goes through
-- drone-render-edited→Edits subtab, raw stays in drone-render→Renders subtab).
--
-- Fix: add `pipeline` to the index column list.
-- ═══════════════════════════════════════════════════════════════════════════

DO $$
DECLARE v_count int;
BEGIN
  WITH dups AS (
    SELECT shot_id, kind, COALESCE(output_variant,'default') AS variant, column_state, pipeline, COUNT(*) AS n
    FROM drone_renders
    WHERE column_state IN ('pool','accepted','adjustments','final')
    GROUP BY 1,2,3,4,5
    HAVING COUNT(*) > 1
  )
  SELECT COUNT(*) INTO v_count FROM dups;
  IF v_count > 0 THEN
    RAISE EXCEPTION 'Cannot rebuild index: % duplicate (shot_id, kind, variant, column_state, pipeline) groups exist.', v_count;
  END IF;
  RAISE NOTICE 'Pre-check passed: 0 duplicates with the new key shape';
END $$;

DROP INDEX IF EXISTS uniq_drone_renders_active_per_variant;

CREATE UNIQUE INDEX uniq_drone_renders_active_per_variant
  ON drone_renders (shot_id, kind, COALESCE(output_variant, 'default'), column_state, pipeline)
  WHERE column_state IN ('pool','accepted','adjustments','final');

COMMENT ON INDEX uniq_drone_renders_active_per_variant IS
  'Per-shot uniqueness across (kind, variant, column_state, pipeline). QC4 mig 299 added pipeline to support pipeline-split coexistence. mig 282 vocab applies; rejected rows stack freely.';

NOTIFY pgrst, 'reload schema';

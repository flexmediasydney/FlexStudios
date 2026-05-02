-- 418_qc_iter2_w2_p0_persist_v2_fix.sql
-- W11.7.17 QC-iter2-W2 P0: persist v2 nested-shape backfill (F-D-002).
--
-- Companion migration to the persist-layer code change in
-- shortlisting-shape-d/index.ts. After the W11.7.17 cutover (2026-05-01),
-- the v2 universal schema started emitting `time_of_day_*`, exterior/detail
-- subject under `out.image_classification.{is_dusk, is_day, is_golden_hour,
-- is_night, subject, is_drone}`. The pre-fix persist read the top-level v1
-- fields (`out.time_of_day`, `out.is_exterior`, `out.is_detail_shot`,
-- `out.is_drone`) which v2 NEVER emits — so these columns landed NULL on
-- every row since the cutover.
--
-- This migration attempts a best-effort backfill of those rows. The
-- `image_classification` payload was NOT persisted to its own JSONB column
-- by the pre-fix code path (only the 4 *_specific blocks + observed_objects
-- + observed_attributes were persisted as JSONB). So we cannot recover the
-- exact per-row classification from the existing JSONB columns. The
-- `image_type` 11-option enum WAS persisted to its own column, however —
-- which is enough to recover `is_drone`, `is_detail_shot`, and a coarse
-- `time_of_day` for the `is_dusk`/`is_day` cases.
--
-- Recovery strategy:
--   * is_drone        ← image_type = 'is_drone'
--   * is_detail_shot  ← image_type = 'is_detail_shot'
--   * time_of_day     ← image_type = 'is_dusk' → 'dusk_twilight';
--                       image_type = 'is_day' → 'day';
--                       (other image_type values left NULL)
--   * is_exterior     ← image_type = 'is_facade_hero' → TRUE;
--                       (everything else left at the existing value)
--
-- Rows where image_type doesn't carry enough signal stay NULL — those are
-- documented as one-day data-loss in the QC-iter2 incident report. Going
-- forward, the persist-layer fix means new v2.0 rows populate correctly.

BEGIN;

-- ─── Diagnostic: count affected rows pre-backfill ────────────────────────────
DO $$
DECLARE
  v_affected_pre int;
BEGIN
  SELECT COUNT(*) INTO v_affected_pre FROM composition_classifications
    WHERE schema_version = 'v2.0'
      AND classified_at > '2026-05-01'
      AND (time_of_day IS NULL OR is_exterior IS NULL OR is_detail_shot IS NULL);
  RAISE NOTICE 'QC-iter2-W2 backfill: pre-backfill rows with NULL time_of_day/is_exterior/is_detail_shot=%', v_affected_pre;
END $$;

-- ─── Backfill ────────────────────────────────────────────────────────────────
-- Read image_type to infer the missing flat columns. UPDATE is idempotent
-- (no-op for rows that already have non-NULL values).
UPDATE composition_classifications
SET
  is_drone = CASE
    WHEN is_drone IS NULL OR is_drone = FALSE THEN
      (image_type = 'is_drone')
    ELSE is_drone
  END,
  is_detail_shot = CASE
    WHEN is_detail_shot IS NULL OR is_detail_shot = FALSE THEN
      (image_type = 'is_detail_shot')
    ELSE is_detail_shot
  END,
  is_exterior = CASE
    WHEN is_exterior IS NULL OR is_exterior = FALSE THEN
      (image_type = 'is_facade_hero')
    ELSE is_exterior
  END,
  time_of_day = CASE
    WHEN time_of_day IS NULL THEN
      CASE image_type
        WHEN 'is_dusk' THEN 'dusk_twilight'
        WHEN 'is_day' THEN 'day'
        ELSE NULL
      END
    ELSE time_of_day
  END
WHERE schema_version = 'v2.0'
  AND classified_at > '2026-05-01'
  AND (time_of_day IS NULL OR is_drone IS NULL OR is_exterior IS NULL OR is_detail_shot IS NULL OR is_drone = FALSE OR is_exterior = FALSE OR is_detail_shot = FALSE);

-- ─── Diagnostic: post-backfill ───────────────────────────────────────────────
DO $$
DECLARE
  v_remaining_null_tod int;
  v_recovered_drone int;
  v_recovered_detail int;
  v_recovered_facade int;
BEGIN
  SELECT COUNT(*) INTO v_remaining_null_tod FROM composition_classifications
    WHERE schema_version = 'v2.0' AND classified_at > '2026-05-01' AND time_of_day IS NULL;
  SELECT COUNT(*) INTO v_recovered_drone FROM composition_classifications
    WHERE schema_version = 'v2.0' AND classified_at > '2026-05-01' AND is_drone = TRUE;
  SELECT COUNT(*) INTO v_recovered_detail FROM composition_classifications
    WHERE schema_version = 'v2.0' AND classified_at > '2026-05-01' AND is_detail_shot = TRUE;
  SELECT COUNT(*) INTO v_recovered_facade FROM composition_classifications
    WHERE schema_version = 'v2.0' AND classified_at > '2026-05-01' AND is_exterior = TRUE;
  RAISE NOTICE 'QC-iter2-W2 backfill: post-backfill remaining NULL time_of_day=%, recovered is_drone=%, is_detail_shot=%, is_exterior=%',
    v_remaining_null_tod, v_recovered_drone, v_recovered_detail, v_recovered_facade;
END $$;

COMMIT;

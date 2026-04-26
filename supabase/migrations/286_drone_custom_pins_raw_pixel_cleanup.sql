-- 286_drone_custom_pins_raw_pixel_cleanup
--
-- Wave 5 Phase 2 / S1: hard-delete pre-Wave-5 raw-side pixel-anchored
-- manual pins. Joseph's call (revised from architect plan): hard delete,
-- NOT archive.
--
-- The 6 manual pixel-anchored pins on Everton are operator test data from
-- QC iteration 1 — disposable. Pin Editor is moving to edited-only in
-- Wave 5; pixel anchors on raw shots have no semantic meaning post-refactor.
-- Operators may re-create on Edited cards if still needed.
--
-- Safety:
--   - DO $$ block pre-counts and refuses to delete >20 rows
--   - Post-check verifies zero remaining rows match the predicate
--   - World-anchored manual pins (pixel_anchored_shot_id IS NULL) are
--     intentionally untouched and survive the migration

-- Pre-check: capture exactly what we're about to delete
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM drone_custom_pins
  WHERE source = 'manual' AND pixel_anchored_shot_id IS NOT NULL;

  RAISE NOTICE 'About to hard-delete % manual pixel-anchored pins', v_count;

  IF v_count > 20 THEN
    RAISE EXCEPTION 'Refusing to delete more than 20 pins (got %); investigate before proceeding', v_count;
  END IF;
END $$;

DELETE FROM drone_custom_pins
WHERE source = 'manual' AND pixel_anchored_shot_id IS NOT NULL;

-- Post-check
DO $$
DECLARE
  v_remaining int;
BEGIN
  SELECT COUNT(*) INTO v_remaining
  FROM drone_custom_pins
  WHERE source = 'manual' AND pixel_anchored_shot_id IS NOT NULL;
  IF v_remaining > 0 THEN
    RAISE EXCEPTION 'Cleanup failed: % rows remain', v_remaining;
  END IF;
END $$;

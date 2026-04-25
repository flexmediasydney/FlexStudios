-- ════════════════════════════════════════════════════════════════════════
-- Migration 259 — drone_shots.lifecycle_state default + NOT NULL (QC6 #10)
--
-- Migration 242 introduced lifecycle_state but left it nullable + no default.
-- New ingests post-mig produce NULL-state rows (since the writers haven't been
-- updated to seed it explicitly), and downstream code that reads the column
-- has to fall back to mood-music defaults all over the place.
--
-- Plan:
--   1. Backfill any remaining NULL rows using the same role→state mapping the
--      mig-242 backfill used (nadir_grid → 'sfm_only', everything else
--      → 'raw_proposed').
--   2. SET DEFAULT 'raw_proposed' so future inserts that don't specify
--      lifecycle_state get a sensible value (the common case is a fresh raw
--      ingest).
--   3. SET NOT NULL once everything is populated.
--
-- The only producer that DOES specify lifecycle_state explicitly today is the
-- raw-preview pipeline (which writes 'sfm_only' for grids); the 'raw_proposed'
-- default matches every other ingest path.
-- ════════════════════════════════════════════════════════════════════════

-- 1. Backfill NULLs via the role-aware mapping.
UPDATE drone_shots
SET lifecycle_state = CASE
  WHEN shot_role = 'nadir_grid' THEN 'sfm_only'
  ELSE 'raw_proposed'
END
WHERE lifecycle_state IS NULL;

-- 2. Default for future inserts.
ALTER TABLE drone_shots
  ALTER COLUMN lifecycle_state SET DEFAULT 'raw_proposed';

-- 3. NOT NULL — safe now that all rows are populated.
ALTER TABLE drone_shots
  ALTER COLUMN lifecycle_state SET NOT NULL;

NOTIFY pgrst, 'reload schema';

-- Wave 10.1 P2-6 (W10.1): composition_groups gains camera_source +
-- is_secondary_camera so Pass 0 can partition multi-camera shoots and the
-- swimlane can render a per-source banner.
--
-- Today's bracketDetector lumps every file into a single timeline. When a
-- shoot uses 2+ cameras (R5 primary + R6 / iPhone secondary) the timestamps
-- interleave, settings-continuity breaks mid-bracket, and the detector emits
-- junk groups. The fix: detect camera_source per file from EXIF (model + body
-- serial), partition bracket detection by source, tag non-primary-camera
-- files as is_secondary_camera=true, and emit them as singletons.
--
-- See docs/design-specs/W10-1-multi-camera-partitioning.md for the full
-- design. Q1-Q3 resolved by orchestrator:
--   Q1 — primary-camera selection: largest bucket; Canon model > non-Canon
--        as tie-break (R5/R6 > Sony > iPhone).
--   Q2 — binary is_secondary_camera BOOLEAN for v1; future waves can add a
--        tier enum if needed.
--   Q3 — drift validation out of scope for v1; partitioner carries a TODO
--        comment for a future timing-drift sanity check.
--
-- ─── Forward ────────────────────────────────────────────────────────────────

ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS camera_source TEXT;

ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS is_secondary_camera BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN composition_groups.camera_source IS
  'Wave 10.1 P2-6 (W10.1): canonical camera identifier — "<model>:<serial>" '
  'lowercased and slug-normalised (non-alphanumerics → "-"). Two cameras of '
  'the same model produce different camera_sources because of the body '
  'serial. NULL for legacy rows pre-W10.1 (untouched by this migration; the '
  'partitioner only writes the column for new rounds).';

COMMENT ON COLUMN composition_groups.is_secondary_camera IS
  'Wave 10.1 P2-6 (W10.1): TRUE when this group came from a non-primary '
  'camera_source on the round (i.e. this source contributed fewer files than '
  'the round''s primary, or non-Canon when ties broken). Pass 0 emits these '
  'as singletons (file_count=1, no bracket merge). The swimlane displays an '
  'informational banner when the round has >0 such groups.';

-- Partial index: queries that filter by camera_source are bounded to the
-- subset of rows with a non-NULL value. Pre-W10.1 rows stay out of the index
-- entirely, keeping it small while the legacy population dominates.
CREATE INDEX IF NOT EXISTS idx_composition_groups_camera_source
  ON composition_groups(camera_source)
  WHERE camera_source IS NOT NULL;

NOTIFY pgrst, 'reload schema';

-- ─── Rollback (run MANUALLY if this migration breaks production) ────────────
--
-- DROP INDEX IF EXISTS idx_composition_groups_camera_source;
-- ALTER TABLE composition_groups DROP COLUMN IF EXISTS is_secondary_camera;
-- ALTER TABLE composition_groups DROP COLUMN IF EXISTS camera_source;
-- NOTIFY pgrst, 'reload schema';
--
-- Backfill is N/A: legacy rows stay camera_source=NULL,
-- is_secondary_camera=FALSE (default). Pass 0 only writes the columns for
-- new rounds. The swimlane handles NULL gracefully (no banner, no badge).
--
-- Forward callers (shortlisting-pass0 / shortlisting-extract chain) MUST be
-- re-deployed at the prior commit BEFORE dropping the columns or every Pass
-- 0 run 500s on the missing fields. Coordinate the column drop with a code
-- revert in the same deploy window.

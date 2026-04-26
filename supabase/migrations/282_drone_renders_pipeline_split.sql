-- 282_drone_renders_pipeline_split
--
-- Wave 5 Phase 2 / S1: introduce raw|edited pipeline split for drone_renders
-- and drone_jobs.
--
-- DEFAULT 'raw' is set on drone_renders.pipeline so old in-flight code that
-- still writes drone_renders rows without specifying pipeline continues to
-- work until S2 deploys. The DEFAULT can be dropped in a later migration
-- once all writers explicitly set pipeline.
--
-- Existing values: 100% column_state='preview' (16 rows on Everton).
-- Migration backfills 'preview' -> 'pool' (the new Raw Pool column).

-- A. drone_renders.pipeline (raw|edited) with DEFAULT 'raw' for safe rollout
ALTER TABLE drone_renders
  ADD COLUMN IF NOT EXISTS pipeline text NOT NULL DEFAULT 'raw';

ALTER TABLE drone_renders
  ADD CONSTRAINT drone_renders_pipeline_check
    CHECK (pipeline IN ('raw','edited'));

-- B. Replace column_state CHECK with pipeline-aware predicate.
ALTER TABLE drone_renders DROP CONSTRAINT drone_renders_column_state_check;

UPDATE drone_renders SET column_state = 'pool' WHERE column_state IN ('preview','proposed');

ALTER TABLE drone_renders
  ADD CONSTRAINT drone_renders_column_state_check
    CHECK (
      (pipeline = 'raw'    AND column_state IN ('pool','accepted','rejected'))
      OR
      (pipeline = 'edited' AND column_state IN ('pool','adjustments','final','rejected'))
    );

-- C. drone_jobs.pipeline payload field — nullable for back-compat
ALTER TABLE drone_jobs
  ADD COLUMN IF NOT EXISTS pipeline text
    CHECK (pipeline IS NULL OR pipeline IN ('raw','edited'));

CREATE INDEX IF NOT EXISTS idx_drone_jobs_pipeline_pending
  ON drone_jobs (pipeline) WHERE status IN ('pending','running');

-- D. Replace migration 240's partial-unique render-debounce index with a
-- pipeline-aware variant so a raw and edited render for the same shoot
-- can coexist.
DROP INDEX IF EXISTS idx_drone_jobs_unique_pending_render;
CREATE UNIQUE INDEX idx_drone_jobs_unique_pending_render
  ON drone_jobs (shoot_id, COALESCE(pipeline,'raw'))
  WHERE status IN ('pending','running') AND kind = 'render';

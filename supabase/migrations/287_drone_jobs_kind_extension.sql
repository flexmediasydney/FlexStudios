-- 287_drone_jobs_kind_extension
--
-- Wave 5 Phase 2 / S1: extend drone_jobs.kind CHECK to include the two new
-- job kinds introduced by the Wave 5 pipeline split:
--   - render_edited:               edited-pipeline render jobs (S2/S3)
--   - boundary_save_render_cascade: cascade trigger that re-renders all
--                                   shoots on a project when a boundary is
--                                   saved (S5)
--
-- Existing kinds are preserved as-is.

ALTER TABLE drone_jobs DROP CONSTRAINT drone_jobs_kind_check;
ALTER TABLE drone_jobs
  ADD CONSTRAINT drone_jobs_kind_check
    CHECK (kind IN (
      'ingest','sfm','render','render_preview','raw_preview_render',
      'poi_fetch','cadastral_fetch',
      'render_edited',
      'boundary_save_render_cascade'
    ));

-- Track WHERE projects.confirmed_lat/lng came from so the SfM autopilot can
-- safely overwrite its own writes but NEVER overwrite an operator's manual
-- confirmation. NULL = never confirmed; 'manual' = operator clicked the
-- map; 'sfm' = SfM worker computed centroid from nadir cameras.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS confirmed_source text DEFAULT NULL;

COMMENT ON COLUMN projects.confirmed_source IS
  'Provenance of confirmed_lat/lng. NULL=never confirmed, ''manual''=operator, ''sfm''=auto-computed by drone SfM worker. Auto-writes only allowed when source is NULL or ''sfm''.';

NOTIFY pgrst, 'reload schema';

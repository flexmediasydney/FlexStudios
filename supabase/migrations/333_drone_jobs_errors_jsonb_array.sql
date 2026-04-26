-- Wave 14 Stream 3: drone_jobs.errors jsonb (append-only per-attempt audit array)
--
-- Context: drone_jobs.error_message is a single TEXT column that's overwritten
-- by every markFailed() retry. A multi-attempt job that fails on attempt 1 with
-- "Modal returned 503" then succeeds on attempt 2 (or dies on attempt 3 with a
-- different error) leaves operators reading function logs to reconstruct what
-- actually happened. (Noted in QC iter 7 F27 + dispatcher comment around L1126.)
--
-- This migration adds a jsonb array column where each markFailed/dispatcher
-- retry pushes one entry: {attempt, message, http_status, modal_resource_limit,
-- occurred_at}. Replaces the OVERWRITE pattern with APPEND. error_message stays
-- intact (most-recent error fragment) for backwards compat — frontend +
-- AlertsPanel + older queries still rely on it.
--
-- Index: GIN partial on rows with at least one error entry — keeps the index
-- small (the vast majority of jobs succeed first-try with errors=[]) while
-- still letting AlertsPanel-style "show me jobs with N+ failed attempts"
-- queries hit a usable index.

ALTER TABLE drone_jobs
  ADD COLUMN IF NOT EXISTS errors jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN drone_jobs.errors IS
  'Wave 14 S3: append-only array of {attempt, message, http_status, modal_resource_limit, occurred_at} entries. Each markFailed/dispatcher retry pushes one entry. Replaces error_message overwrite pattern with per-attempt audit trail. error_message kept as the most-recent error fragment for backwards compat.';

CREATE INDEX IF NOT EXISTS idx_drone_jobs_errors_recent
  ON drone_jobs USING gin (errors)
  WHERE jsonb_array_length(errors) > 0;

NOTIFY pgrst, 'reload schema';

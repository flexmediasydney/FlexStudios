-- Render-job dedupe: prevent operators spamming Save → N identical render jobs.
-- Migration 228 set the precedent for 'ingest'; mirror it for 'render'.
-- Partial unique index on shoot_id where status IN pending/running and kind='render'.

CREATE UNIQUE INDEX IF NOT EXISTS idx_drone_jobs_unique_pending_render
  ON drone_jobs (shoot_id)
  WHERE status IN ('pending', 'running') AND kind = 'render';

NOTIFY pgrst, 'reload schema';

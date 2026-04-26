-- Wave 11 S1: backfill drone_jobs.shot_id from payload.shot_id for per-shot kinds.
-- Some legacy enqueue paths only stored shot_id inside the payload JSONB blob.
-- Promote it to the dedicated column so per-shot dedupe / cascade joins work.

UPDATE drone_jobs
   SET shot_id = (payload->>'shot_id')::uuid
 WHERE shot_id IS NULL
   AND kind IN ('render','render_edited','raw_preview_render')
   AND payload ? 'shot_id'
   AND (payload->>'shot_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Hot index for cascade lookups by shot, scoped to non-null shot_id only.
CREATE INDEX IF NOT EXISTS idx_drone_jobs_shot_id_recent
  ON drone_jobs(shot_id, created_at DESC)
  WHERE shot_id IS NOT NULL;

-- Wave 11 S1: enforce shot_id invariant for per-shot drone_jobs kinds.
-- Per-shot kinds (render, render_edited, raw_preview_render) MUST carry a shot
-- reference either via the dedicated shot_id column OR via payload.shot_id JSONB.
-- This catches malformed enqueue paths (e.g. render_continuation that forgets
-- to pass the shot down from a per-shoot stage) at INSERT time instead of
-- letting them sit broken in the queue forever.
--
-- Applied as NOT VALID then VALIDATE so existing rows are checked atomically;
-- pre-existing violators were quarantined / removed by W11-S1 cleanup before
-- this migration ran.

ALTER TABLE drone_jobs
  ADD CONSTRAINT drone_jobs_shot_id_required_for_per_shot_kinds
  CHECK (
    kind NOT IN ('render','render_edited','raw_preview_render')
    OR shot_id IS NOT NULL
    OR (payload ? 'shot_id' AND (payload->>'shot_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) NOT VALID;

ALTER TABLE drone_jobs VALIDATE CONSTRAINT drone_jobs_shot_id_required_for_per_shot_kinds;

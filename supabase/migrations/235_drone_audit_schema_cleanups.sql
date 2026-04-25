-- Migration 235: drone module audit schema cleanups
--
-- Closes:
--   #25  drone_events.project_id NOT NULL prevents audit-event recovery when
--        the render's project can't be resolved. Make nullable so the action
--        is at least logged with a `payload.project_resolution_failed: true`
--        flag the operator can investigate later.
--
--   #12  drone_shoots needs UNIQUE(project_id, flight_started_at) so two
--        concurrent webhook-triggered ingests on the same project can't
--        produce overlapping shoot rows for the same flight.
--
--   #52  project_folder_events needs UNIQUE(dropbox_id, event_type) so two
--        webhook deliveries for the same file can't both insert
--        `file_added`. ON CONFLICT DO NOTHING semantics on the insert side.
--
--   #95  drone_themes brand-level CHECK is dormant (brand entity doesn't
--        exist yet) but the constraint allows future inserts that would
--        FK-orphan immediately. Add a CHECK that explicitly rejects
--        owner_kind='brand' until the brand entity ships.
--
--   #20  drone_jobs CHECK currently allows BOTH 'sfm' AND 'sfm_run'.
--        Drop 'sfm_run' so callers settle on 'sfm' (the value drone-ingest
--        actually enqueues). Anything still writing 'sfm_run' becomes a hard
--        error visible in dispatcher logs.
--
--   #91-followup  Confirmed drone_jobs is on the realtime publication via
--        migration 233; nothing to do here.

-- ── #25 audit-event project_id nullable ────────────────────────────────────
ALTER TABLE drone_events ALTER COLUMN project_id DROP NOT NULL;
COMMENT ON COLUMN drone_events.project_id IS
  'Nullable so audit events can be recorded even when project resolution '
  'fails (set payload.project_resolution_failed=true in that case).';

-- ── #12 drone_shoots flight uniqueness per project ─────────────────────────
-- A flight is uniquely identified by (project_id, exact-second-precision
-- flight_started_at). Same-second collisions are vanishingly rare in real
-- pilot operations. We use a NOT-VALID add to skip historical row scan; the
-- partial index below is the actual enforcement primitive.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_drone_shoots_project_flight_started
  ON drone_shoots (project_id, flight_started_at)
  WHERE flight_started_at IS NOT NULL;

-- ── #52 project_folder_events file-added dedupe ────────────────────────────
-- A file_added event is uniquely identified by its dropbox_id (file content
-- hash from Dropbox). Two webhooks for the same physical file (Dropbox
-- fan-out) currently both insert; this collapses them. file_modified /
-- file_deleted etc. retain their existing semantics — only file_added
-- benefits from this dedupe (it's the high-frequency racy event).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_project_folder_events_file_added_dbx
  ON project_folder_events (dropbox_id)
  WHERE event_type = 'file_added' AND dropbox_id IS NOT NULL;

-- ── #95 reject owner_kind='brand' until brand entity ships ────────────────
-- The schema CHECK already allows 'brand' but there's no FK target for
-- owner_id on a brand. This adds an explicit guard.
ALTER TABLE drone_themes DROP CONSTRAINT IF EXISTS drone_themes_brand_not_yet_supported;
ALTER TABLE drone_themes ADD CONSTRAINT drone_themes_brand_not_yet_supported
  CHECK (owner_kind <> 'brand') NOT VALID;
ALTER TABLE drone_themes VALIDATE CONSTRAINT drone_themes_brand_not_yet_supported;

-- ── #20 collapse drone_jobs.kind enum: drop 'sfm_run' ──────────────────────
-- Need to make sure no production rows have 'sfm_run' first. Backfill any
-- such rows to 'sfm' (functionally identical to the dispatcher).
UPDATE drone_jobs SET kind = 'sfm' WHERE kind = 'sfm_run';
ALTER TABLE drone_jobs DROP CONSTRAINT IF EXISTS drone_jobs_kind_check;
ALTER TABLE drone_jobs ADD CONSTRAINT drone_jobs_kind_check
  CHECK (kind = ANY (ARRAY[
    'ingest', 'sfm', 'render', 'render_preview', 'poi_fetch', 'cadastral_fetch'
  ]));

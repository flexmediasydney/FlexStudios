-- ═══════════════════════════════════════════════════════════════════════════
-- 322: Wave 13 B — belt-and-braces DB trigger that enqueues render_edited
--      when an editor's delivery sets drone_shots.edited_dropbox_path.
-- ───────────────────────────────────────────────────────────────────────────
-- dropbox-webhook is the canonical entry point; this trigger ensures coverage
-- even if the webhook is offline or the operator manually sets the path.
--
-- Idempotency: relies on the partial unique index from mig 294
-- (idx_drone_jobs_unique_pending_render keys on
--  (shoot_id, COALESCE(pipeline,'raw'), COALESCE(payload->>'shot_id',''))
--  WHERE status IN ('pending','running') AND kind IN ('render','render_edited'))
-- via ON CONFLICT DO NOTHING — a duplicate enqueue from webhook + trigger
-- collapses cleanly.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.drone_shots_enqueue_render_edited_on_edited_path()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_project_id uuid;
BEGIN
  -- Only fire on transition NULL → non-NULL
  IF NOT (OLD.edited_dropbox_path IS NULL AND NEW.edited_dropbox_path IS NOT NULL) THEN
    RETURN NEW;
  END IF;

  -- Resolve project_id via shoot
  SELECT project_id INTO v_project_id FROM drone_shoots WHERE id = NEW.shoot_id;
  IF v_project_id IS NULL THEN
    RAISE WARNING '[wave13-b] drone_shots % has no resolvable project_id; skipping render_edited enqueue', NEW.id;
    RETURN NEW;
  END IF;

  INSERT INTO drone_jobs (
    project_id, shoot_id, shot_id, kind, status, pipeline,
    payload
  ) VALUES (
    v_project_id, NEW.shoot_id, NEW.id, 'render_edited', 'pending', 'edited',
    jsonb_build_object(
      'shoot_id', NEW.shoot_id,
      'shot_id', NEW.id,
      'reason', 'edited_path_set_db_trigger',
      'column_state', 'pool',
      'pipeline', 'edited',
      'kind', 'poi_plus_boundary'
    )
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drone_shots_enqueue_render_edited ON drone_shots;
CREATE TRIGGER trg_drone_shots_enqueue_render_edited
  AFTER UPDATE OF edited_dropbox_path ON drone_shots
  FOR EACH ROW
  EXECUTE FUNCTION public.drone_shots_enqueue_render_edited_on_edited_path();

COMMENT ON FUNCTION public.drone_shots_enqueue_render_edited_on_edited_path IS
  'Wave 13 B: belt-and-braces enqueue of render_edited when edited_dropbox_path transitions NULL → non-NULL. dropbox-webhook is the primary path; this trigger covers webhook-offline edge cases.';

NOTIFY pgrst, 'reload schema';

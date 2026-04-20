-- 203_project_status_guards.sql
-- Two critical guards on the projects table around status transitions.
--
-- Problem evidence (2026-04-20, project 8 Karuah St):
--   1. status changed many times during the project's lifecycle, but
--      project_stage_timers is empty — meaning every stage transition was
--      silently lost. Root cause: timers are only written by the edge
--      function `trackProjectStageChange`, which is invoked from a handful
--      of frontend paths. Any status change bypassing those paths (direct
--      SQL, migration scripts, other functions) never produces a timer row.
--   2. The project was moved out of `in_revision` while a revision with
--      status='identified' was still open. Root cause: the open-revision
--      guard only fires via `syncProjectRevisionStatus`, which runs reactively
--      on REVISION changes, not on PROJECT changes. Dragging on Kanban never
--      triggered the check.
--
-- Fix — two DB triggers that enforce invariants at the storage layer, below
-- every possible code path (edge fns, UI, direct SQL, background jobs):
--
--   trg_project_stage_timer_sync   — AFTER UPDATE on projects
--     Closes any open timer for this project, then opens a new one for the
--     new stage. Idempotent with the existing trackProjectStageChange edge
--     function: if that fn got there first and there's already an open timer
--     for the new stage, the trigger no-ops.
--
--   trg_project_revision_guard     — BEFORE UPDATE on projects
--     Blocks status change out of 'in_revision' when any open revision exists
--     (status NOT IN ('completed','delivered','cancelled','rejected')).
--     RAISE EXCEPTION so the entire UPDATE aborts cleanly.

BEGIN;

-- ── Timer sync ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_stage_timer_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now             timestamptz := COALESCE(NEW.last_status_change, now());
  v_next_visit_num  int;
  v_valid_stages    text[] := ARRAY[
    'pending_review','to_be_scheduled','scheduled','onsite','uploaded',
    'submitted','in_progress','in_production','ready_for_partial',
    'in_revision','delivered','cancelled'
  ];
BEGIN
  -- No-op if status didn't actually change
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Skip unknown stages (defensive — prevents garbage input from creating
  -- phantom rows)
  IF NEW.status IS NULL OR NOT (NEW.status = ANY(v_valid_stages)) THEN
    RETURN NEW;
  END IF;

  -- Close every open timer for this project (there should only ever be one,
  -- but bulk-close defensively in case the edge fn and trigger raced earlier).
  UPDATE project_stage_timers
  SET exit_time        = v_now,
      duration_seconds = GREATEST(0, LEAST(
        EXTRACT(EPOCH FROM (v_now - entry_time))::int,
        90 * 24 * 3600   -- 90-day hard cap, matches edge fn
      )),
      is_current       = false,
      updated_at       = now()
  WHERE project_id = NEW.id
    AND exit_time IS NULL;

  -- Idempotency with trackProjectStageChange: if an open timer for the new
  -- stage was just created by the edge fn (race), bail. Re-querying post-UPDATE
  -- so we see the edge fn's insert if it sneaked in first.
  IF EXISTS (
    SELECT 1 FROM project_stage_timers
    WHERE project_id = NEW.id
      AND stage      = NEW.status
      AND exit_time IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  -- Compute visit number (how many times this project has entered this stage)
  SELECT COALESCE(MAX(visit_number), 0) + 1
    INTO v_next_visit_num
  FROM project_stage_timers
  WHERE project_id = NEW.id AND stage = NEW.status;

  -- Open new timer for the new stage
  INSERT INTO project_stage_timers (
    project_id, stage, entry_time, exit_time, duration_seconds,
    visit_number, is_current, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.status, v_now, NULL, 0, v_next_visit_num, true, now(), now()
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_stage_timer_sync ON projects;
CREATE TRIGGER trg_project_stage_timer_sync
AFTER UPDATE OF status ON projects
FOR EACH ROW
EXECUTE FUNCTION project_stage_timer_sync();

-- ── Revision guard ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION project_status_guard_against_open_revisions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_open_count int;
BEGIN
  -- Only act on real status change
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Only block when moving AWAY from in_revision. Moving INTO it is fine.
  IF OLD.status IS DISTINCT FROM 'in_revision' THEN
    RETURN NEW;
  END IF;
  IF NEW.status = 'in_revision' THEN
    RETURN NEW;
  END IF;

  -- Count open revisions. Matches the set used by syncProjectRevisionStatus.
  SELECT count(*) INTO v_open_count
  FROM project_revisions
  WHERE project_id = NEW.id
    AND status NOT IN ('completed','delivered','cancelled','rejected');

  IF v_open_count > 0 THEN
    RAISE EXCEPTION 'Cannot move project out of in_revision: % open revision(s) exist. Close (complete/cancel/reject) all revisions first.',
      v_open_count
      USING ERRCODE = 'check_violation',
            HINT = 'Use the Requests tab to mark the revision as completed, or cancel it.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_project_revision_guard ON projects;
CREATE TRIGGER trg_project_revision_guard
BEFORE UPDATE OF status ON projects
FOR EACH ROW
EXECUTE FUNCTION project_status_guard_against_open_revisions();

COMMIT;

-- 474_auto_log_completed_task_effort.sql
--
-- Centralises the "auto-log effort on task completion" rule into a database
-- trigger so it applies uniformly regardless of which code path closes the
-- task (Tonomo delivery webhook, central Tasks page kanban/list/bulk,
-- in-project Tasks tab, edge functions, future tooling).
--
-- Background: the rule previously lived only in TaskManagement.jsx. Tasks
-- closed via processTonomoQueue/handleDelivered.ts and pages/Tasks.jsx
-- (kanban drag, list tick, bulk complete) bypassed it, leaving completed
-- tasks with no time log. ~30% of completed-with-estimate tasks were
-- affected; the visible symptom is a Project Effort card showing partial
-- utilisation for a role even when every task is ticked off.
--
-- Behaviour:
--   - On UPDATE where is_completed transitions false→true:
--       if estimated_minutes > 0 AND no time log exists for the task,
--       insert a synthetic time log with log_source='auto_completion' and
--       total_seconds = estimated_minutes × 60.
--   - On UPDATE where is_completed transitions true→false (re-open):
--       delete any auto_completion logs for the task. Manual entries and
--       auto_onsite logs (real shoot effort) are preserved.
--   - On INSERT where is_completed = true (rare, but covers webhooks that
--       create already-closed tasks): same auto-log logic as the UPDATE
--       path.
--
-- The trigger also keeps project_tasks.total_effort_logged in sync so
-- consumers reading the cached column (Org2MetricsCard, ProjectRevisionsTab)
-- see the right number without waiting for the realtime reconcile pass.

CREATE OR REPLACE FUNCTION auto_log_completed_task_effort()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_estimated_seconds integer;
  v_existing_logs     integer;
  v_log_user_id       uuid;
  v_user_name         text;
  v_user_email        text;
  v_start_time        timestamptz;
  v_end_time          timestamptz;
BEGIN
  -- Re-opening a completed task: drop any synthetic auto_completion logs
  -- so the recorded effort doesn't represent work that hasn't happened.
  -- Only auto_completion is removed; manual entries and auto_onsite
  -- (real shoot time, owned by the project lifecycle) are preserved.
  IF TG_OP = 'UPDATE'
     AND OLD.is_completed = true
     AND NEW.is_completed = false THEN
    DELETE FROM task_time_logs
    WHERE task_id = NEW.id
      AND log_source = 'auto_completion'
      AND COALESCE(is_manual, false) = false;

    -- Recompute total_effort_logged from remaining logs.
    UPDATE project_tasks
    SET total_effort_logged = COALESCE(
      (SELECT SUM(total_seconds) FROM task_time_logs
       WHERE task_id = NEW.id AND status = 'completed' AND COALESCE(is_active, false) = false),
      0
    )
    WHERE id = NEW.id;

    RETURN NEW;
  END IF;

  -- Marking complete: insert auto_completion log when warranted.
  -- Fires for both UPDATE (false→true) and INSERT (with is_completed=true).
  IF (TG_OP = 'UPDATE' AND OLD.is_completed = false AND NEW.is_completed = true)
     OR (TG_OP = 'INSERT' AND NEW.is_completed = true) THEN

    IF COALESCE(NEW.estimated_minutes, 0) <= 0
       OR COALESCE(NEW.is_deleted, false) = true
       OR COALESCE(NEW.is_archived, false) = true THEN
      RETURN NEW;
    END IF;

    SELECT COUNT(*) INTO v_existing_logs
    FROM task_time_logs
    WHERE task_id = NEW.id;

    IF v_existing_logs > 0 THEN
      RETURN NEW;
    END IF;

    v_estimated_seconds := (NEW.estimated_minutes * 60)::integer;

    -- Resolve a user attribution: prefer the task assignee, fall back to
    -- project owner, and only persist a value that exists in users.
    -- For team-assigned tasks, leave user_id NULL (team_id captures it).
    v_log_user_id := NEW.assigned_to;
    IF v_log_user_id IS NULL AND NEW.assigned_to_team_id IS NULL THEN
      SELECT project_owner_id INTO v_log_user_id
      FROM projects WHERE id = NEW.project_id;
    END IF;
    IF v_log_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM users WHERE id = v_log_user_id) THEN
      v_log_user_id := NULL;
    END IF;

    v_user_name := NULLIF(COALESCE(NEW.assigned_to_name, ''), '');
    IF v_user_name IS NULL AND v_log_user_id IS NOT NULL THEN
      SELECT NULLIF(COALESCE(full_name, email, ''), '')
      INTO v_user_name
      FROM users WHERE id = v_log_user_id;
    END IF;

    IF v_log_user_id IS NOT NULL THEN
      SELECT email INTO v_user_email FROM users WHERE id = v_log_user_id;
    END IF;

    -- Pin the log timestamp to completion time so the audit trail reads
    -- naturally; fall back to NOW() for INSERTs without completed_at.
    v_start_time := COALESCE(NEW.completed_at, NOW());
    -- Defensive: ttl_reasonable_start requires start_time > 2020-01-01.
    IF v_start_time <= '2020-01-01'::timestamptz THEN
      v_start_time := NOW();
    END IF;
    v_end_time := v_start_time + make_interval(secs => v_estimated_seconds);

    INSERT INTO task_time_logs (
      task_id, project_id, user_id,
      user_name, user_email, role,
      status, is_active, is_manual, log_source,
      start_time, end_time, total_seconds,
      paused_duration, team_id, team_name
    ) VALUES (
      NEW.id, NEW.project_id, v_log_user_id,
      COALESCE(v_user_name, ''), COALESCE(v_user_email, ''),
      COALESCE(NEW.auto_assign_role, 'none'),
      'completed', false, false, 'auto_completion',
      v_start_time, v_end_time, v_estimated_seconds,
      0, NEW.assigned_to_team_id, NEW.assigned_to_team_name
    );

    -- Keep cached total in sync. Column-targeted UPDATE doesn't re-fire
    -- the AFTER UPDATE OF is_completed trigger; the WHEN clause guards
    -- against any future broadening of the trigger's column scope.
    UPDATE project_tasks
    SET total_effort_logged = v_estimated_seconds
    WHERE id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_auto_log_completed_effort ON project_tasks;
CREATE TRIGGER trg_auto_log_completed_effort
AFTER UPDATE OF is_completed ON project_tasks
FOR EACH ROW
WHEN (OLD.is_completed IS DISTINCT FROM NEW.is_completed)
EXECUTE FUNCTION auto_log_completed_task_effort();

DROP TRIGGER IF EXISTS trg_auto_log_completed_effort_insert ON project_tasks;
CREATE TRIGGER trg_auto_log_completed_effort_insert
AFTER INSERT ON project_tasks
FOR EACH ROW
WHEN (NEW.is_completed = true)
EXECUTE FUNCTION auto_log_completed_task_effort();

-- ──────────────────────────────────────────────────────────────────────
-- Backfill: every historically-completed task that has an estimate but
-- no time log gets a synthetic auto_completion log. 354 tasks expected
-- as of 2026-05-05.
-- ──────────────────────────────────────────────────────────────────────

WITH targets AS (
  SELECT
    pt.id, pt.project_id,
    pt.assigned_to, pt.assigned_to_name,
    pt.assigned_to_team_id, pt.assigned_to_team_name,
    pt.auto_assign_role,
    (pt.estimated_minutes * 60)::integer AS est_seconds,
    GREATEST(
      COALESCE(pt.completed_at, pt.updated_at, pt.created_at, NOW()),
      '2020-01-02'::timestamptz
    ) AS log_start
  FROM project_tasks pt
  WHERE pt.is_completed = true
    AND COALESCE(pt.is_deleted, false)  = false
    AND COALESCE(pt.is_archived, false) = false
    AND COALESCE(pt.estimated_minutes, 0) > 0
    AND NOT EXISTS (
      SELECT 1 FROM task_time_logs ttl WHERE ttl.task_id = pt.id
    )
),
resolved AS (
  SELECT
    t.*,
    COALESCE(
      (SELECT u.id FROM users u WHERE u.id = t.assigned_to),
      CASE
        WHEN t.assigned_to_team_id IS NULL THEN
          (SELECT p.project_owner_id
             FROM projects p
            WHERE p.id = t.project_id
              AND EXISTS (SELECT 1 FROM users u WHERE u.id = p.project_owner_id))
        ELSE NULL
      END
    ) AS log_user_id
  FROM targets t
),
inserted AS (
  INSERT INTO task_time_logs (
    task_id, project_id, user_id,
    user_name, user_email, role,
    status, is_active, is_manual, log_source,
    start_time, end_time, total_seconds,
    paused_duration, team_id, team_name
  )
  SELECT
    r.id, r.project_id, r.log_user_id,
    COALESCE(
      NULLIF(r.assigned_to_name, ''),
      (SELECT NULLIF(COALESCE(u.full_name, u.email, ''), '')
         FROM users u WHERE u.id = r.log_user_id),
      ''
    ),
    COALESCE((SELECT u.email FROM users u WHERE u.id = r.log_user_id), ''),
    COALESCE(r.auto_assign_role, 'none'),
    'completed', false, false, 'auto_completion',
    r.log_start,
    r.log_start + make_interval(secs => r.est_seconds),
    r.est_seconds,
    0,
    r.assigned_to_team_id,
    r.assigned_to_team_name
  FROM resolved r
  RETURNING task_id, total_seconds
)
UPDATE project_tasks pt
SET total_effort_logged = i.total_seconds
FROM inserted i
WHERE pt.id = i.task_id;

COMMENT ON FUNCTION auto_log_completed_task_effort() IS
  'Auto-generates a TaskTimeLog of estimated duration when a task is closed
   without one, and removes that synthetic log on re-open. Centralises the
   rule that previously lived only in TaskManagement.jsx (single tick, bulk
   complete) and was missing from Tonomo delivery, Tasks.jsx kanban/list/bulk,
   and any other path that simply UPDATEs is_completed. See migration 474.';

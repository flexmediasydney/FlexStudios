-- Update trigger to allow auto-completion and auto-onsite time logs
-- on completed tasks. Previously ALL inserts were blocked if the task
-- was completed, which prevented the auto-effort-on-completion feature.
CREATE OR REPLACE FUNCTION guard_time_log_on_deleted_task() RETURNS trigger AS $$
DECLARE
  task_deleted BOOLEAN;
  task_completed BOOLEAN;
BEGIN
  SELECT is_deleted, is_completed INTO task_deleted, task_completed
  FROM project_tasks WHERE id = NEW.task_id;

  IF task_deleted = true THEN
    RAISE EXCEPTION 'Cannot create time log on a deleted task';
  END IF;

  -- Allow auto-completion and auto-onsite logs on completed tasks
  -- (these are created at the moment of completion or stage transition)
  IF task_completed = true AND NEW.log_source NOT IN ('auto_completion', 'auto_onsite') THEN
    RAISE EXCEPTION 'Cannot create time log on a completed task';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

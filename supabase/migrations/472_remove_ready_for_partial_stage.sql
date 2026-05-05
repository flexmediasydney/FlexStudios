-- 472_remove_ready_for_partial_stage.sql
--
-- Removes the 'ready_for_partial' project stage ("Partially Delivered" in
-- the UI). Pipeline now goes: in_production → in_revision → delivered.
--
-- Strategy: forward-migrate any project currently in 'ready_for_partial'
-- to 'in_production' (the prior stage), then tighten the CHECK constraint
-- and refresh the project_stage_timer_sync trigger function to drop the
-- value. The bulk UPDATE fires the trigger so timers self-stitch.

BEGIN;

-- 1. Forward-migrate live rows: ready_for_partial → in_production.
UPDATE projects
SET status             = 'in_production',
    last_status_change = now(),
    updated_at         = now()
WHERE status = 'ready_for_partial';

-- 2. Tighten CHECK constraint.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (
  status IN (
    'inquiry',
    'pending_review',
    'to_be_scheduled',
    'scheduled',
    'onsite',
    'uploaded',
    'in_progress',
    'in_production',
    'in_revision',
    'delivered',
    'cancelled',
    'goal_not_started',
    'goal_active',
    'goal_on_hold',
    'goal_completed',
    'goal_cancelled'
  )
);

-- 3. Refresh project_stage_timer_sync (drops 'ready_for_partial' from
--    v_valid_stages). All other behaviour preserved from migration 471.
CREATE OR REPLACE FUNCTION project_stage_timer_sync()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_now             timestamptz;
  v_next_visit_num  int;
  v_valid_stages    text[] := ARRAY[
    'pending_review','to_be_scheduled','scheduled','onsite','uploaded',
    'in_progress','in_production',
    'in_revision','delivered','cancelled'
  ];
BEGIN
  IF NEW.last_status_change IS DISTINCT FROM OLD.last_status_change
     AND NEW.last_status_change IS NOT NULL THEN
    v_now := NEW.last_status_change;
  ELSE
    v_now := now();
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status IS NULL OR NOT (NEW.status = ANY(v_valid_stages)) THEN
    RETURN NEW;
  END IF;

  UPDATE project_stage_timers
  SET exit_time        = v_now,
      duration_seconds = GREATEST(0, LEAST(
        EXTRACT(EPOCH FROM (v_now - entry_time))::int,
        90 * 24 * 3600
      )),
      is_current       = false,
      updated_at       = now()
  WHERE project_id = NEW.id
    AND exit_time IS NULL;

  IF EXISTS (
    SELECT 1 FROM project_stage_timers
    WHERE project_id = NEW.id
      AND stage      = NEW.status
      AND exit_time IS NULL
  ) THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(MAX(visit_number), 0) + 1
    INTO v_next_visit_num
  FROM project_stage_timers
  WHERE project_id = NEW.id AND stage = NEW.status;

  INSERT INTO project_stage_timers (
    project_id, stage, entry_time, exit_time, duration_seconds,
    visit_number, is_current, created_at, updated_at
  ) VALUES (
    NEW.id, NEW.status, v_now, NULL, 0, v_next_visit_num, true, now(), now()
  );

  RETURN NEW;
END;
$$;

COMMIT;

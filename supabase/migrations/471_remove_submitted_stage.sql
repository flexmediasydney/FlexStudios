-- 471_remove_submitted_stage.sql
--
-- Removes the 'submitted' project stage. The pipeline now goes
-- directly from 'uploaded' to 'in_progress' (rebranded "Stills in
-- Progress" in the UI). 'in_production' has also been rebranded to
-- "Video in Progress" — display-only, no value change.
--
-- Strategy: forward-migrate any project currently in 'submitted' to
-- 'in_progress' (the natural successor), then tighten the CHECK
-- constraint and update the stage-timer trigger function. The bulk
-- UPDATE fires the project_stage_timer_sync trigger, which closes the
-- open submitted timer and opens a fresh in_progress one — no manual
-- timer stitching needed.

BEGIN;

-- 1. Forward-migrate live rows: submitted → in_progress.
--    Bumping last_status_change makes the trigger record now() as the
--    transition time (rather than the stale prior value).
UPDATE projects
SET status             = 'in_progress',
    last_status_change = now(),
    updated_at         = now()
WHERE status = 'submitted';

-- 2. Tighten the CHECK constraint (drops 'submitted' from the allow-list).
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check CHECK (
  status IN (
    -- Production statuses
    'inquiry',
    'pending_review',
    'to_be_scheduled',
    'scheduled',
    'onsite',
    'uploaded',
    'in_progress',
    'in_production',
    'ready_for_partial',
    'in_revision',
    'delivered',
    'cancelled',
    -- Goal statuses
    'goal_not_started',
    'goal_active',
    'goal_on_hold',
    'goal_completed',
    'goal_cancelled'
  )
);

-- 3. Replace project_stage_timer_sync to drop 'submitted' from
--    v_valid_stages. Keeps every other behaviour from migration 369
--    (now() fallback when last_status_change is stale, idempotency
--    guard against trackProjectStageChange race, etc.).
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
    'in_progress','in_production','ready_for_partial',
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

-- 4. Remove the orphaned automation rule "P2 — Stale Submitted Alert"
--    (seeded by seedAutomationRules; no longer matches any rows).
DELETE FROM project_automation_rules
WHERE name = 'P2 — Stale Submitted Alert';

COMMIT;

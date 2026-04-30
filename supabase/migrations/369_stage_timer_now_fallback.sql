-- 369_stage_timer_now_fallback.sql
--
-- Hardens project_stage_timer_sync (migration 203) against callers that
-- update projects.status without also bumping last_status_change.
--
-- Symptom: 7e/164 Burwood Rd raised a revision on 2026-04-30 11:52:33 and
-- correctly transitioned delivered → in_revision, but the new in_revision
-- timer's entry_time was back-dated to 2026-04-29 23:48:30 (the prior
-- transition into delivered) and the closing delivered timer got
-- exit_time = entry_time (0 sec). Root cause: syncProjectRevisionStatus
-- updates only status + previous_status, so NEW.last_status_change is the
-- stale value from the previous transition.
--
-- Fix: only trust NEW.last_status_change when it's actually newer than
-- OLD.last_status_change. Otherwise fall back to now(). This protects every
-- future caller that forgets to bump the timestamp.

BEGIN;

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
    'submitted','in_progress','in_production','ready_for_partial',
    'in_revision','delivered','cancelled'
  ];
BEGIN
  -- Use the caller's last_status_change ONLY if it actually changed in this
  -- UPDATE. Otherwise it's a stale leftover from the prior transition and
  -- would back-date the new timer.
  IF NEW.last_status_change IS DISTINCT FROM OLD.last_status_change
     AND NEW.last_status_change IS NOT NULL THEN
    v_now := NEW.last_status_change;
  ELSE
    v_now := now();
  END IF;

  -- No-op if status didn't actually change
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;

  -- Skip unknown stages (defensive)
  IF NEW.status IS NULL OR NOT (NEW.status = ANY(v_valid_stages)) THEN
    RETURN NEW;
  END IF;

  -- Close every open timer for this project.
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

  -- Idempotency with trackProjectStageChange edge fn race
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

-- ── Backfill: 7e/164 Burwood Rd (cef035ef) ──────────────────────────────
-- delivered timer was zero-durationed and in_revision was back-dated. The
-- actual transition time is the project's updated_at (when the trigger
-- fired). Restore both rows to that timestamp.
DO $$
DECLARE
  v_project_id  uuid := 'cef035ef-5a59-4556-bf04-1de345c7c09f';
  v_actual_at   timestamptz;
  v_delivered_entry timestamptz;
BEGIN
  -- Use project.updated_at as the real transition time (set when the
  -- syncProjectRevisionStatus UPDATE fired the trigger).
  SELECT updated_at INTO v_actual_at FROM projects WHERE id = v_project_id;
  IF v_actual_at IS NULL THEN
    RETURN;
  END IF;

  -- delivered timer entry_time stays as-is (when it actually entered
  -- delivered); only fix exit_time + duration.
  SELECT entry_time INTO v_delivered_entry
  FROM project_stage_timers
  WHERE project_id = v_project_id
    AND stage = 'delivered'
    AND visit_number = 1
  ORDER BY created_at DESC
  LIMIT 1;

  UPDATE project_stage_timers
  SET exit_time        = v_actual_at,
      duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (v_actual_at - entry_time))::int),
      updated_at       = now()
  WHERE project_id = v_project_id
    AND stage = 'delivered'
    AND exit_time = entry_time;

  UPDATE project_stage_timers
  SET entry_time = v_actual_at,
      updated_at = now()
  WHERE project_id = v_project_id
    AND stage = 'in_revision'
    AND exit_time IS NULL
    AND is_current = true;

  -- Bump last_status_change so future sync paths see a current value.
  UPDATE projects
  SET last_status_change = v_actual_at
  WHERE id = v_project_id
    AND last_status_change < v_actual_at;
END $$;

COMMIT;

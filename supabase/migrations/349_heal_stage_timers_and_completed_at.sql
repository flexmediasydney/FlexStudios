-- 349_heal_stage_timers_and_completed_at.sql
--
-- Two heals from the 2026-04-28 project-details audit:
--
-- 1. Projects whose current stage has no open `project_stage_timers` row.
--    Caused by a race between the DB trigger `project_stage_timer_sync` and
--    the edge function `trackProjectStageChange`: both close-then-create.
--    The edge fn would close the trigger's freshly opened timer and the
--    front-end orphan-closer would close any survivor that arrived before
--    project.status had propagated. Result: a frozen "in stage for X" timer
--    in the UI for every affected project. The edge fn no longer touches
--    timer rows; this migration heals the existing damage.
--
-- 2. Tasks with `is_completed = true` AND `completed_at IS NULL`. Caused by
--    `logOnsiteEffortOnUpload` (and earlier auto-completion paths) flipping
--    `is_completed` without writing the timestamp. The CompletionTimer in
--    the UI returns null for these, hiding completion time everywhere.

BEGIN;

-- ── Heal 1: open timer for current stage ─────────────────────────────────
INSERT INTO project_stage_timers (
  project_id, stage, entry_time, exit_time, duration_seconds,
  visit_number, is_current, created_at, updated_at
)
SELECT
  p.id,
  p.status,
  COALESCE(p.last_status_change, p.created_at, now()),
  NULL,
  0,
  COALESCE(
    (SELECT MAX(visit_number) FROM project_stage_timers
     WHERE project_id = p.id AND stage = p.status),
    0
  ) + 1,
  true,
  now(),
  now()
FROM projects p
WHERE p.status IS NOT NULL
  AND p.status IN (
    'pending_review','to_be_scheduled','scheduled','onsite','uploaded',
    'submitted','in_progress','in_production','ready_for_partial',
    'in_revision','delivered'
  )
  AND p.status NOT IN ('cancelled')
  AND COALESCE(p.is_archived, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM project_stage_timers t
    WHERE t.project_id = p.id
      AND t.stage = p.status
      AND t.exit_time IS NULL
  );

-- ── Heal 2: completed tasks with NULL completed_at ───────────────────────
UPDATE project_tasks
SET completed_at = COALESCE(updated_at, now())
WHERE is_completed = true
  AND completed_at IS NULL;

COMMIT;

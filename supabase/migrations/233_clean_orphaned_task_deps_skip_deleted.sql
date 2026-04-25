-- 233_clean_orphaned_task_deps_skip_deleted.sql
-- Fix: clean_orphaned_task_deps was cascading into already-deleted tasks,
-- which then tripped guard_deleted_task_update and aborted the soft-delete.
--
-- ── Symptom ───────────────────────────────────────────────────────────────
-- 46 Brays Rd, Concord — when Tonomo removed Dusk Video Package, the project's
-- packages array went to []. syncProjectTasksFromProducts and
-- cleanupOrphanedProjectTasks both correctly identified 8 tasks as orphans
-- (Sales Images, Drones x2, Dusk Images, Video x2, Floorplan x2). But every
-- soft-delete attempt threw "Cannot update a deleted task. Restore it first."
-- and the orphans persisted, leaving the project showing "only Cut Down Reel"
-- in products while the tasks list still implies a full package.
--
-- ── Root cause ────────────────────────────────────────────────────────────
-- 1. Soft-delete sets is_deleted=true on task A.
-- 2. AFTER UPDATE trigger clean_orphaned_task_deps fires for task A.
-- 3. It runs an UPDATE across ALL tasks in the same project whose
--    depends_on_task_ids text contains task A's id — INCLUDING tasks that
--    are themselves already is_deleted=true.
-- 4. That update on a deleted task hits guard_deleted_task_update, which
--    raises "Cannot update a deleted task" because is_deleted is true on
--    both OLD and NEW.
-- 5. The exception unwinds, task A is NOT marked deleted, orphan stays.
--
-- ── Fix ───────────────────────────────────────────────────────────────────
-- Add `is_deleted = false` to the clean_orphaned_task_deps WHERE clause.
-- Already-deleted tasks have no live dependency surface — their deps array
-- is functionally inert, so cleaning it has no value and only causes the
-- guard to abort the parent operation.

CREATE OR REPLACE FUNCTION public.clean_orphaned_task_deps()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_deleted = true AND (OLD.is_deleted IS DISTINCT FROM true) THEN
    UPDATE project_tasks
    SET depends_on_task_ids = (
      SELECT jsonb_agg(dep)
      FROM jsonb_array_elements_text(depends_on_task_ids) dep
      WHERE dep::UUID != NEW.id
    )
    WHERE project_id = NEW.project_id
      AND is_deleted = false
      AND depends_on_task_ids IS NOT NULL
      AND depends_on_task_ids::text LIKE '%' || NEW.id::text || '%';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.clean_orphaned_task_deps() IS
  'Strip a task ID from sibling tasks dependencies when it is soft-deleted. '
  'Restricted to is_deleted=false rows to avoid tripping guard_deleted_task_update '
  'when a downstream task was already deleted (see migration 233).';

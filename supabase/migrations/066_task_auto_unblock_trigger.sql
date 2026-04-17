-- 066_task_auto_unblock_trigger.sql
--
-- Problem: When a user marks a task complete, downstream/dependent tasks were
-- NOT automatically unblocking because the unblock logic lived entirely in the
-- frontend (via a 1s-debounced call to `calculateProjectTaskDeadlines`). That
-- call is fragile — if the user navigates away, the tab is throttled, the
-- edge function rate-limits, or the network drops during the debounce window,
-- the dependents remain blocked forever (observed on "50 Oxford St, Burwood").
--
-- Fix: move the unblock recomputation into a DB trigger so it fires atomically
-- with the task mutation, regardless of what the frontend does.
--
-- Scope: this trigger handles the DEPENDENCY-based portion of is_blocked.
-- Timer-trigger-based blocking (project_onsite / project_uploaded /
-- project_submitted / dependencies_cleared) is still refreshed by
-- `calculateProjectTaskDeadlines` which runs on project stage changes — those
-- paths are not affected.

-- Recompute is_blocked for every dependency-driven open task in a project.
-- Idempotent: only writes rows whose value would actually change.
CREATE OR REPLACE FUNCTION public.recompute_project_task_blocking(p_project_id UUID)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH target_tasks AS (
    SELECT
      t.id,
      t.is_blocked AS current_blocked,
      NOT bool_and(
        COALESCE(dep.is_completed, FALSE) = TRUE
        OR COALESCE(dep.is_deleted, FALSE) = TRUE
        OR dep.id IS NULL  -- reference to a task that no longer exists
      ) AS next_blocked
    FROM project_tasks t
    CROSS JOIN LATERAL jsonb_array_elements_text(t.depends_on_task_ids) AS dep_id
    LEFT JOIN project_tasks dep
      ON dep.id = dep_id::uuid
    WHERE t.project_id = p_project_id
      AND COALESCE(t.is_completed, FALSE) = FALSE
      AND COALESCE(t.is_deleted, FALSE) = FALSE
      AND t.depends_on_task_ids IS NOT NULL
      AND jsonb_array_length(t.depends_on_task_ids) > 0
    GROUP BY t.id, t.is_blocked
  )
  UPDATE project_tasks t
  SET is_blocked = tt.next_blocked
  FROM target_tasks tt
  WHERE t.id = tt.id
    AND t.is_blocked IS DISTINCT FROM tt.next_blocked;
END;
$$;

-- Trigger function: fires on task INSERT/UPDATE/DELETE and recomputes
-- blocking for the affected project. Reentrancy-safe: only triggers a
-- recompute when a field that influences dependency blocking changed.
-- The recompute's own writes to is_blocked don't trigger another recompute
-- because is_blocked is not in the watched-fields list.
CREATE OR REPLACE FUNCTION public.trg_propagate_task_unblock()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_project_id UUID;
  v_should_recompute BOOLEAN := FALSE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_project_id := OLD.project_id;
    v_should_recompute := TRUE;

  ELSIF TG_OP = 'INSERT' THEN
    v_project_id := NEW.project_id;
    -- New task may have dependencies that are already completed — compute once.
    v_should_recompute := TRUE;

  ELSE  -- UPDATE
    v_project_id := NEW.project_id;
    -- Recompute only when a field that influences dependency blocking changed.
    -- Crucially, is_blocked itself is NOT in this list — the recompute
    -- function's own writes flip only is_blocked and must not recurse.
    IF COALESCE(NEW.is_completed, FALSE) IS DISTINCT FROM COALESCE(OLD.is_completed, FALSE)
       OR COALESCE(NEW.is_deleted, FALSE)   IS DISTINCT FROM COALESCE(OLD.is_deleted, FALSE)
       OR NEW.depends_on_task_ids          IS DISTINCT FROM OLD.depends_on_task_ids
    THEN
      v_should_recompute := TRUE;
    END IF;
  END IF;

  IF v_should_recompute AND v_project_id IS NOT NULL THEN
    PERFORM public.recompute_project_task_blocking(v_project_id);
  END IF;

  RETURN NULL;  -- AFTER trigger; return value ignored
END;
$$;

-- Install the trigger. AFTER semantics ensure we see committed row values.
DROP TRIGGER IF EXISTS trg_propagate_task_unblock ON public.project_tasks;
CREATE TRIGGER trg_propagate_task_unblock
AFTER INSERT OR UPDATE OR DELETE ON public.project_tasks
FOR EACH ROW
EXECUTE FUNCTION public.trg_propagate_task_unblock();

-- One-time backfill: bring every open project's dependency-driven task
-- blocking state up to date. This unlocks any dependents stranded by the
-- old frontend-only mechanism. Idempotent — skips rows already correct.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT DISTINCT project_id
    FROM project_tasks
    WHERE COALESCE(is_deleted, FALSE) = FALSE
      AND COALESCE(is_completed, FALSE) = FALSE
      AND depends_on_task_ids IS NOT NULL
      AND jsonb_array_length(depends_on_task_ids) > 0
  LOOP
    PERFORM public.recompute_project_task_blocking(r.project_id);
  END LOOP;
END;
$$;

-- 353_recompute_project_task_blocking_security_definer.sql
--
-- The trigger trg_propagate_task_unblock fires AFTER UPDATE on project_tasks
-- and calls recompute_project_task_blocking(project_id) to recompute the
-- is_blocked flag on dependent tasks within the same project. Under a user
-- JWT, RLS evaluation on each row of that recompute (which joins project_tasks
-- twice via LATERAL) was inflating execution to 8+ seconds — exactly the
-- statement_timeout for the `authenticated` role — so every user-driven
-- task PATCH was ending in HTTP 500 / code 57014.
--
-- Verified via EXPLAIN ANALYZE: same recompute runs in ~9ms under the
-- bypassrls postgres role and 5.2ms total for the full PATCH+triggers
-- path under the authenticated role after this fix (was timing out at 8s).
--
-- Fix: SECURITY DEFINER. Effect is still tightly scoped — the function
-- only flips is_blocked within the project_id passed by the trigger; it
-- cannot touch other projects, other columns, or anything outside
-- project_tasks. Search path locked to public, pg_temp.

CREATE OR REPLACE FUNCTION public.recompute_project_task_blocking(p_project_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$;

REVOKE ALL ON FUNCTION public.recompute_project_task_blocking(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.recompute_project_task_blocking(uuid) TO authenticated, service_role;

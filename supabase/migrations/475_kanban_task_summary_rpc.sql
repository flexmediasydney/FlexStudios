-- Kanban task summary RPC.
--
-- Returns one row per project containing a JSONB array of "slim" task records
-- pre-joined with product.category and project_revisions.request_kind. This
-- lets the kanban Task Progress card field render bucketed progress + popover
-- task lists from a single tiny payload, instead of:
--   1. fetching every full ProjectTask row across all visible projects (~3MB
--      after Supabase's silent 1000-row paginated cap), AND
--   2. doing per-card client-side joins against the products list to derive
--      each task's category and against project_revisions to derive its
--      request_kind.
--
-- Slim task fields (id/title/due_date/is_completed/product_id/
-- product_category/revision_id/request_kind/order) cover everything the
-- card-field renderer needs, including the popover task list.
--
-- Tasks excluded from the summary:
--   - is_deleted          (already filtered out everywhere downstream)
--   - is_archived         (same)
--   - parent_task_id IS NOT NULL (subtasks; kanban shows top-level only)
--
-- SECURITY INVOKER means the function runs with the caller's RLS context,
-- so users only see tasks they're already permitted to see via the existing
-- project_tasks / projects RLS policies.
CREATE OR REPLACE FUNCTION public.get_kanban_task_summary(project_ids uuid[])
RETURNS TABLE (
  project_id uuid,
  tasks jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    pt.project_id,
    jsonb_agg(
      jsonb_build_object(
        'id', pt.id,
        'title', pt.title,
        'due_date', pt.due_date,
        'is_completed', COALESCE(pt.is_completed, false),
        'is_deleted', false,
        'is_archived', false,
        'product_id', pt.product_id,
        'product_category', p.category,
        'revision_id', pt.revision_id,
        'request_kind',
          CASE
            WHEN pt.revision_id IS NOT NULL THEN COALESCE(pr.request_kind, 'revision')
            ELSE NULL
          END,
        'parent_task_id', pt.parent_task_id,
        'order', pt."order",
        'project_id', pt.project_id
      ) ORDER BY pt."order"
    ) AS tasks
  FROM project_tasks pt
  LEFT JOIN products p ON pt.product_id = p.id
  LEFT JOIN project_revisions pr ON pt.revision_id = pr.id
  WHERE pt.project_id = ANY(project_ids)
    AND NOT COALESCE(pt.is_deleted, false)
    AND NOT COALESCE(pt.is_archived, false)
    AND pt.parent_task_id IS NULL
  GROUP BY pt.project_id;
$$;

GRANT EXECUTE ON FUNCTION public.get_kanban_task_summary(uuid[]) TO authenticated;

COMMENT ON FUNCTION public.get_kanban_task_summary(uuid[]) IS
  'Per-project slim task list for the kanban Task Progress card field. '
  'Pre-joins product.category and project_revisions.request_kind so the '
  'client never has to ship full ProjectTask rows or do bucketing lookups.';

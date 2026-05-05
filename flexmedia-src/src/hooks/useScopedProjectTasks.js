import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';

const STALE_MS = 60 * 1000;

/**
 * Multi-project task fetcher for the kanban / project list.
 *
 * Calls the `get_kanban_task_summary(project_ids)` Postgres RPC, which
 * returns one row per project with a JSONB array of *slim* task records
 * pre-joined with product.category and project_revisions.request_kind.
 * That cuts the kanban's task payload from ~3MB of full ProjectTask rows
 * down to ~200KB of just-the-fields-we-render, eliminates Supabase's
 * silent 1000-row cap (which caused random projects to lose their entire
 * task set), and removes per-card client-side joins.
 *
 * Realtime: when a ProjectTask event fires for a project in scope, we
 * debounce-refetch that project's summary via the same RPC and patch the
 * cache surgically. No full-list invalidation, no row-level subscription
 * to thousands of tasks.
 *
 * Returns `{ data, loading, error, refetch }` where `data` is a flat array
 * of slim task objects (each with project_id), matching the shape
 * downstream consumers (tasksByProject grouping, KanbanBoard, list-view
 * sort) already expect.
 */
export function useScopedProjectTasks(projectIds) {
  const queryClient = useQueryClient();

  // Stable, deduped, sorted ID list — gives a stable query key so React
  // Query hits the same cache entry across renders that pass equivalent
  // inputs.
  const ids = useMemo(() => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return [];
    const set = new Set();
    for (const id of projectIds) if (id) set.add(id);
    return [...set].sort();
  }, [projectIds]);

  const queryKey = useMemo(() => ['kanban-task-summary', ids], [ids]);

  const query = useQuery({
    queryKey,
    enabled: ids.length > 0,
    staleTime: STALE_MS,
    queryFn: async () => {
      if (ids.length === 0) return [];
      const rows = await api.rpc('get_kanban_task_summary', { project_ids: ids });
      return rows || [];
    },
  });

  // Flatten [{ project_id, tasks: [...] }, ...] into a flat task[] so
  // downstream code (tasksByProject grouping, sort comparator, KanbanBoard
  // card rendering) doesn't change shape.
  const flatTasks = useMemo(() => {
    const flat = [];
    for (const row of query.data || []) {
      if (Array.isArray(row?.tasks)) {
        for (const t of row.tasks) flat.push(t);
      }
    }
    return flat;
  }, [query.data]);

  // Realtime: surgical per-project refresh on ProjectTask events.
  const pendingRefreshes = useRef(new Set());
  const refreshTimer = useRef(null);

  useEffect(() => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);

    const flush = async () => {
      const toRefresh = [...pendingRefreshes.current];
      pendingRefreshes.current.clear();
      refreshTimer.current = null;
      if (toRefresh.length === 0) return;
      try {
        const fresh = await api.rpc('get_kanban_task_summary', { project_ids: toRefresh });
        const freshById = new Map((fresh || []).map(r => [r.project_id, r]));
        queryClient.setQueryData(queryKey, (prev = []) => {
          if (!Array.isArray(prev)) return prev;
          const next = [];
          const handled = new Set();
          for (const row of prev) {
            if (toRefresh.includes(row.project_id)) {
              const replacement = freshById.get(row.project_id);
              if (replacement) {
                next.push(replacement);
                handled.add(row.project_id);
              }
              // else: project lost all active tasks → drop the row.
            } else {
              next.push(row);
            }
          }
          // Projects that previously had no row but do now (e.g. first task
          // created on an empty project).
          for (const r of fresh || []) {
            if (!handled.has(r.project_id) && !prev.some(p => p.project_id === r.project_id)) {
              next.push(r);
            }
          }
          return next;
        });
      } catch (_err) {
        // Silent — next stale-time refetch will reconcile.
      }
    };

    const schedule = (pid) => {
      pendingRefreshes.current.add(pid);
      if (refreshTimer.current) return;
      refreshTimer.current = setTimeout(flush, 200);
    };

    const unsubscribe = api.entities.ProjectTask.subscribe((event) => {
      if (!event) return;
      const pid = event?.data?.project_id;

      if (event.type === 'delete') {
        // Delete events don't carry project_id — locate the deleted task
        // in the current cache and refresh its project.
        const cached = queryClient.getQueryData(queryKey) || [];
        for (const row of cached) {
          if (Array.isArray(row?.tasks) && row.tasks.some(t => t.id === event.id)) {
            schedule(row.project_id);
            break;
          }
        }
        return;
      }

      if (pid && idSet.has(pid)) {
        schedule(pid);
      }
    });

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      pendingRefreshes.current.clear();
      if (typeof unsubscribe === 'function') unsubscribe();
    };
    // queryKey is derived from ids — depending on it would create a new
    // subscription every ids change anyway.
  }, [ids, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    data: flatTasks,
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

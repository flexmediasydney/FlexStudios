import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';

const STALE_MS = 60 * 1000;

/**
 * Multi-project scoped task fetcher for the kanban / project list.
 *
 * Replaces the global `useEntityList("ProjectTask", "-due_date", 5000)` —
 * which loaded EVERY task row in the org and made every Realtime event
 * invalidate a 5000-row cache. This hook fetches only the tasks for the
 * project IDs the page actually shows, via a single `project_id IN (...)`
 * query, and patches the cache in place on Realtime events scoped to the
 * same project set.
 *
 * Returns the same `{ tasks, loading }` shape callers expect from
 * useEntityList, so consumers downstream don't change.
 */
export function useScopedProjectTasks(projectIds) {
  const queryClient = useQueryClient();

  // Stable, deduped, sorted ID list — gives a stable query key so React Query
  // hits the same cache entry across renders that pass equivalent inputs.
  const ids = useMemo(() => {
    if (!Array.isArray(projectIds) || projectIds.length === 0) return [];
    const set = new Set();
    for (const id of projectIds) if (id) set.add(id);
    return [...set].sort();
  }, [projectIds]);

  const queryKey = useMemo(() => ['scoped-project-tasks', ids], [ids]);

  const query = useQuery({
    queryKey,
    enabled: ids.length > 0,
    staleTime: STALE_MS,
    queryFn: async () => {
      if (ids.length === 0) return [];
      // applyFilters supports the `$in` operator → PostgREST `.in('project_id', ids)`.
      // 5000 is a safety cap; typical org has 1-3k active tasks across visible projects.
      const rows = await api.entities.ProjectTask.filter(
        { project_id: { $in: ids } },
        '-due_date',
        5000
      );
      return rows || [];
    },
  });

  // Realtime patches the cache in place so the UI doesn't depend on a refetch
  // for every task event. Mirrors the strategy in src/hooks/useProjectTasks.js
  // but scoped to a set of projects rather than a single one.
  useEffect(() => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const unsubscribe = api.entities.ProjectTask.subscribe((event) => {
      const eventPid = event?.data?.project_id;
      // Always handle deletes (we may not know the project_id of the deleted row).
      // For create/update, only handle events for projects in our scope.
      if (event?.type !== 'delete' && (!eventPid || !idSet.has(eventPid))) return;

      queryClient.setQueryData(queryKey, (prev = []) => {
        if (!Array.isArray(prev)) return prev;
        if (event.type === 'delete') {
          return prev.filter(t => t.id !== event.id);
        }
        if (!event.data) return prev;
        const idx = prev.findIndex(t => t.id === event.id);
        if (idx === -1) {
          return event.type === 'create' ? [...prev, event.data] : prev;
        }
        // Out-of-order event guard — same as useProjectTasks.
        const existing = prev[idx];
        const existingTs = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const incomingTs = event.data?.updated_at ? new Date(event.data.updated_at).getTime() : 0;
        if (incomingTs && existingTs && incomingTs < existingTs) return prev;
        const next = prev.slice();
        next[idx] = event.data;
        return next;
      });
    });
    return typeof unsubscribe === 'function' ? () => unsubscribe() : undefined;
    // queryKey is derived from ids — depending on it would create a new
    // subscription every ids change anyway.
  }, [ids, queryClient]); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    data: query.data || [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

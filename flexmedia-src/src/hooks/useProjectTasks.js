import { useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';

const STALE_MS = 60 * 1000;

/**
 * Stable queryKey for project-scoped task data. Exposed so callers can pass it
 * to setQueryData / invalidateQueries without recomputing.
 */
export function projectTasksQueryKey(projectId, sort = 'order') {
  return ['project-tasks-scoped', projectId, sort];
}

/**
 * Project-scoped task fetcher.
 *
 * Replaces `useEntityList("ProjectTask", …, t => t.project_id === id)`, which
 * pulled the global ProjectTask cache (~5,000 rows) and filtered client-side.
 * This hook fetches only the rows for one project — typically ~17 — via
 * server-side filter, and keeps in sync via the same Realtime channel the
 * shared entity hooks use.
 *
 * Multiple consumers on the same projectId share one fetch (TanStack dedups
 * on queryKey). Realtime events for that project invalidate the query.
 */
export function useProjectTasks(projectId, { sort = 'order' } = {}) {
  const queryClient = useQueryClient();
  const queryKey = projectTasksQueryKey(projectId, sort);

  const query = useQuery({
    queryKey,
    enabled: Boolean(projectId),
    staleTime: STALE_MS,
    queryFn: async () => {
      const rows = await api.entities.ProjectTask.filter(
        { project_id: projectId },
        sort,
        500
      );
      return rows || [];
    },
  });

  // Realtime keeps the cache live when the channel is healthy. When realtime
  // is down (auth glitches, network, 401 storms), the patch on a successful
  // write — see `patchTaskInCache` below — keeps the UI correct even without
  // a realtime confirmation.
  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = api.entities.ProjectTask.subscribe((event) => {
      const isForThisProject = event?.data?.project_id === projectId;
      if (!isForThisProject && event?.type !== 'delete') return;
      // Patch in-place rather than invalidate — invalidation kicks off a full
      // refetch that can race with optimistic state. Patching keeps the UI
      // consistent. Realtime events for a task can also arrive OUT OF ORDER
      // (e.g., a takeover-only update carrying is_completed=false delivered
      // *after* the toggle update carrying is_completed=true) — compare
      // updated_at and ignore stale events to prevent the cache regressing.
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
        const existing = prev[idx];
        const existingTs = existing?.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const incomingTs = event.data?.updated_at ? new Date(event.data.updated_at).getTime() : 0;
        if (incomingTs && existingTs && incomingTs < existingTs) {
          // Stale event — ignore.
          return prev;
        }
        const next = prev.slice();
        next[idx] = event.data;
        return next;
      });
    });
    return typeof unsubscribe === 'function' ? () => unsubscribe() : undefined;
    // queryKey is derived from [projectId, sort]
  }, [projectId, sort, queryClient]);

  /**
   * Patch a single task in the cache after a successful local write.
   * Pass the FULL row returned by `api.entities.ProjectTask.update` so the
   * cache's `updated_at` advances correctly — the realtime stale-event
   * filter compares this timestamp to incoming events, and a partial patch
   * that leaves an old `updated_at` would let an out-of-order earlier
   * event regress the cache (tick → untick).
   */
  const patchTaskInCache = useCallback((taskId, fullRow) => {
    if (!taskId || !fullRow) return;
    queryClient.setQueryData(queryKey, (prev = []) => {
      if (!Array.isArray(prev)) return prev;
      const idx = prev.findIndex(t => t.id === taskId);
      if (idx === -1) return prev;
      const next = prev.slice();
      // Merge to preserve any optimistic-only fields, but use the row's
      // real updated_at as the authoritative ordering key.
      next[idx] = { ...prev[idx], ...fullRow };
      return next;
    });
    // queryKey is derived from [projectId, sort]
  }, [queryClient, projectId, sort]); // eslint-disable-line

  return {
    tasks: query.data || [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
    patchTaskInCache,
  };
}

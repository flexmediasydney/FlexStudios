import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';

const STALE_MS = 60 * 1000;

/**
 * Stable queryKey for project-scoped revision data. Exposed so callers can
 * pass it to setQueryData / invalidateQueries without recomputing.
 */
export function projectRevisionsQueryKey(projectId, sort = '-created_date') {
  return ['project-revisions-scoped', projectId, sort];
}

/**
 * Project-scoped revision fetcher.
 *
 * Replaces `useEntityList("ProjectRevision", null, 200, { project_id })`,
 * which pulled the global ProjectRevision cache (~hundreds of rows org-wide)
 * and registered a listener that re-fired filter+sort on every revision
 * write anywhere in the system.
 *
 * Mirrors useProjectTasks — server-scoped filter, ~10-20 rows per project,
 * Realtime keeps the cache live by patching in-place rather than invalidating.
 *
 * Multiple consumers on the same projectId share one fetch (TanStack dedups
 * on queryKey).
 */
export function useProjectRevisions(projectId, { sort = '-created_date' } = {}) {
  const queryClient = useQueryClient();
  const queryKey = projectRevisionsQueryKey(projectId, sort);

  const query = useQuery({
    queryKey,
    enabled: Boolean(projectId),
    staleTime: STALE_MS,
    queryFn: async () => {
      const rows = await api.entities.ProjectRevision.filter(
        { project_id: projectId },
        sort,
        200
      );
      return rows || [];
    },
  });

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = api.entities.ProjectRevision.subscribe((event) => {
      const isForThisProject = event?.data?.project_id === projectId;
      if (!isForThisProject && event?.type !== 'delete') return;
      queryClient.setQueryData(queryKey, (prev = []) => {
        if (!Array.isArray(prev)) return prev;
        if (event.type === 'delete') {
          return prev.filter(r => r.id !== event.id);
        }
        if (!event.data) return prev;
        const idx = prev.findIndex(r => r.id === event.id);
        if (idx === -1) {
          return event.type === 'create' ? [event.data, ...prev] : prev;
        }
        // Compare updated_at to ignore stale out-of-order events.
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
    // queryKey is derived from [projectId, sort]
  }, [projectId, sort, queryClient]);

  return {
    revisions: query.data || [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

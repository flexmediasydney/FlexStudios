import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';

const STALE_MS = 60 * 1000;

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
  const queryKey = ['project-tasks-scoped', projectId, sort];

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

  useEffect(() => {
    if (!projectId) return;
    const unsubscribe = api.entities.ProjectTask.subscribe((event) => {
      if (event?.data?.project_id !== projectId && event?.type !== 'delete') return;
      queryClient.invalidateQueries({ queryKey });
    });
    return typeof unsubscribe === 'function' ? () => unsubscribe() : undefined;
  }, [projectId, sort, queryClient]);

  return {
    tasks: query.data || [],
    loading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}

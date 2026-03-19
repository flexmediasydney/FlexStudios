/**
 * prefetchRoutes.jsx
 *
 * Utilities for prefetching data on hover / intent so that navigation
 * to commonly visited routes feels instant.
 *
 * Usage:
 *   import { usePrefetchProjectDetails, PrefetchOnHover } from '@/components/lib/prefetchRoutes';
 *
 *   // Hook style — call in parent, pass handlers to child
 *   const { prefetch } = usePrefetchProjectDetails();
 *   <Link onMouseEnter={() => prefetch(projectId)} to={...}>
 *
 *   // Wrapper style — wrap any element
 *   <PrefetchOnHover prefetchFn={() => prefetch(projectId)}>
 *     <Link to={...}>Project</Link>
 *   </PrefetchOnHover>
 */

import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { queryKeys } from '@/components/lib/query-client';


// ─── Prefetch Project Details ───────────────────────────────────────────────
// Warms the cache for the Project entity and its tasks so that navigating
// to /ProjectDetails?id=X feels instant.

export function usePrefetchProjectDetails() {
  const queryClient = useQueryClient();
  const pendingRef = useRef(new Set());

  const prefetch = useCallback((projectId) => {
    if (!projectId || pendingRef.current.has(projectId)) return;
    pendingRef.current.add(projectId);

    // Prefetch project detail
    queryClient.prefetchQuery({
      queryKey: queryKeys.projects.detail(projectId),
      queryFn: () => base44.entities.Project.get(projectId),
      staleTime: 2 * 60 * 1000, // don't re-fetch if already fresh
    });

    // Prefetch project tasks
    queryClient.prefetchQuery({
      queryKey: queryKeys.tasks.byProject(projectId),
      queryFn: () => base44.entities.ProjectTask.filter(
        { project_id: projectId, is_deleted: false },
        null,
        200
      ),
      staleTime: 2 * 60 * 1000,
    });

    // Clean up the pending set after a short delay so future hovers re-trigger if needed
    setTimeout(() => pendingRef.current.delete(projectId), 30_000);
  }, [queryClient]);

  return { prefetch };
}


// ─── Prefetch Email Thread ──────────────────────────────────────────────────
// Warms the cache for an email thread's messages before the user clicks.

export function usePrefetchEmailThread() {
  const queryClient = useQueryClient();
  const pendingRef = useRef(new Set());

  const prefetch = useCallback((threadId, accountId) => {
    if (!threadId || pendingRef.current.has(threadId)) return;
    pendingRef.current.add(threadId);

    queryClient.prefetchQuery({
      queryKey: queryKeys.emails.thread(threadId),
      queryFn: () => base44.entities.EmailMessage.filter(
        { gmail_thread_id: threadId, email_account_id: accountId },
        'received_at',
        50
      ),
      staleTime: 2 * 60 * 1000,
    });

    setTimeout(() => pendingRef.current.delete(threadId), 30_000);
  }, [queryClient]);

  return { prefetch };
}


// ─── Generic PrefetchOnHover Wrapper ────────────────────────────────────────
// Wraps any child element and calls prefetchFn on mouse enter with a
// debounce to avoid triggering on quick mouseover sweeps.

export function PrefetchOnHover({ children, prefetchFn, delay = 100 }) {
  const timerRef = useRef(null);

  const handleMouseEnter = useCallback(() => {
    timerRef.current = setTimeout(() => {
      if (prefetchFn) prefetchFn();
    }, delay);
  }, [prefetchFn, delay]);

  const handleMouseLeave = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  return (
    <span
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{ display: 'contents' }}
    >
      {children}
    </span>
  );
}

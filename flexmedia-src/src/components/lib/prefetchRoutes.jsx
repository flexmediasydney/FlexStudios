/**
 * prefetchRoutes.jsx
 *
 * Utilities for prefetching data on hover / intent so that navigation
 * to commonly visited routes feels instant.
 *
 * These functions warm the custom entity cache used by useEntityList /
 * useEntityData (in useEntityData.jsx), NOT the React Query cache.
 * This ensures that when a component mounts after navigation, the data
 * is already available and no HTTP request is needed.
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
import {
  prefetchSingleEntity,
  prefetchEntityList,
} from '@/components/hooks/useEntityData';


// ─── Prefetch Project Details ───────────────────────────────────────────────
// Warms the custom entity cache for the Project entity and its tasks so that
// navigating to /ProjectDetails?id=X feels instant.

export function usePrefetchProjectDetails() {
  const pendingRef = useRef(new Set());

  const prefetch = useCallback((projectId) => {
    if (!projectId || pendingRef.current.has(projectId)) return;
    pendingRef.current.add(projectId);

    // Warm the single-entity cache for this project
    prefetchSingleEntity('Project', projectId).catch(() => {});

    // Warm the task list cache (useEntityList reads from this)
    prefetchEntityList('ProjectTask').catch(() => {});

    // Clean up the pending set after a short delay so future hovers re-trigger if needed
    setTimeout(() => pendingRef.current.delete(projectId), 30_000);
  }, []);

  return { prefetch };
}


// ─── Prefetch Email Thread ──────────────────────────────────────────────────
// Warms the custom entity cache for email messages before the user clicks.

export function usePrefetchEmailThread() {
  const pendingRef = useRef(new Set());

  const prefetch = useCallback((threadId) => {
    if (!threadId || pendingRef.current.has(threadId)) return;
    pendingRef.current.add(threadId);

    // Warm the email message list cache
    prefetchEntityList('EmailMessage').catch(() => {});

    setTimeout(() => pendingRef.current.delete(threadId), 30_000);
  }, []);

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

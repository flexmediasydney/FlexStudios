import React, { createContext, useState, useEffect, useContext, useMemo } from 'react';
import { api } from '@/api/supabaseClient';

export const ActiveTimersContext = createContext();

export function ActiveTimersProvider({ children, currentUser }) {
  const [activeTimers, setActiveTimers] = useState([]);

  // Reset active timers when user changes (e.g. logout then login as different user)
  // Without this, stale timers from the previous user remain visible until the fetch completes.
  useEffect(() => {
    if (!currentUser?.id) setActiveTimers([]);
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;

    let isMounted = true;

    // Fetch active timers for this user
    const loadActiveTimers = async () => {
      try {
        const logs = await api.entities.TaskTimeLog.filter({
          user_id: currentUser.id,
          is_active: true,
        });
        if (isMounted) setActiveTimers(logs);
      } catch (err) {
        // Silent fail on rate limit - subscription will keep state current
        if (isMounted && !err.message?.includes('Rate limit')) {
          console.warn('Failed to load active timers:', err.message);
        }
      }
    };

    // Debounce initial load to prevent rapid refetches
    const timeout = setTimeout(loadActiveTimers, 300);

    // Subscribe to real-time updates in the same effect to ensure cleanup is coordinated
    const unsubscribe = api.entities.TaskTimeLog.subscribe((event) => {
      if (!isMounted) return;
      if (!event.data || event.data.user_id !== currentUser.id) return;

      setActiveTimers(prev => {
        if (event.type === 'create') {
          // Only add genuinely running timers — not completed manual entries or paused logs
          if (event.data.is_active && event.data.status === 'running') {
            // Deduplicate: if already tracked (initial fetch raced with subscription), update in place
            const exists = prev.some(t => t.id === event.data.id);
            if (exists) return prev.map(t => t.id === event.data.id ? event.data : t);
            return [...prev, event.data];
          }
          return prev;
        } else if (event.type === 'update') {
          // BUG FIX (subscription audit): use event.data.id consistently instead of
          // event.id. While they're typically equal for create/update, using event.data.id
          // is more reliable because event.id falls back through a chain (record?.id ??
          // payload.old?.id) which can differ from the actual record ID in edge cases.
          const dataId = event.data.id;
          if (event.data.is_active && event.data.status === 'running') {
            // Upsert: update if already tracked, otherwise add (handles resume from paused
            // state — initial load only fetches status=running, so a paused-then-resumed
            // timer would be missing from the array without the add path)
            const exists = prev.some(t => t.id === dataId);
            if (exists) {
              return prev.map(t => t.id === dataId ? event.data : t);
            }
            return [...prev, event.data];
          } else {
            return prev.filter(t => t.id !== dataId);
          }
        } else if (event.type === 'delete') {
          // For DELETE, event.data may be null — fall back to event.id
          const deletedId = event.data?.id || event.id;
          return prev.filter(t => t.id !== deletedId);
        }
        return prev;
      });
    });

    return () => {
      clearTimeout(timeout);
      isMounted = false;
      unsubscribe();
    };
  }, [currentUser?.id]);

  // BUG FIX: memoize context value to prevent all consumers from re-rendering
  // when the provider re-renders due to parent state changes unrelated to timers.
  const contextValue = useMemo(
    () => ({ activeTimers, setActiveTimers }),
    [activeTimers]
  );

  return (
    <ActiveTimersContext.Provider value={contextValue}>
      {children}
    </ActiveTimersContext.Provider>
  );
}

export function useActiveTimers() {
  const context = useContext(ActiveTimersContext);
  if (!context) {
    throw new Error('useActiveTimers must be used within ActiveTimersProvider');
  }
  return context;
}
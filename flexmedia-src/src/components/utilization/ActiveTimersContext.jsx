import React, { createContext, useState, useEffect, useContext, useMemo } from 'react';
import { api } from '@/api/supabaseClient';

export const ActiveTimersContext = createContext();

export function ActiveTimersProvider({ children, currentUser }) {
  const [activeTimers, setActiveTimers] = useState([]);

  useEffect(() => {
    if (!currentUser?.id) return;

    let isMounted = true;

    // Fetch active timers for this user
    const loadActiveTimers = async () => {
      try {
        const logs = await api.entities.TaskTimeLog.filter({
          user_id: currentUser.id,
          is_active: true,
          status: 'running'
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
            // Prevent duplicates (e.g., subscription fires after initial fetch already added it)
            if (prev.some(t => t.id === event.data.id)) return prev;
            return [...prev, event.data];
          }
          return prev;
        } else if (event.type === 'update') {
          if (event.data.is_active && event.data.status === 'running') {
            // If already tracked, update it; otherwise add it (handles resume from paused)
            const exists = prev.some(t => t.id === event.id);
            if (exists) {
              return prev.map(t => t.id === event.id ? event.data : t);
            }
            return [...prev, event.data];
          } else {
            return prev.filter(t => t.id !== event.id);
          }
        } else if (event.type === 'delete') {
          return prev.filter(t => t.id !== event.id);
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
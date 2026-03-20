import React, { createContext, useState, useEffect, useContext } from 'react';
import { base44 } from '@/api/base44Client';

export const ActiveTimersContext = createContext();

export function ActiveTimersProvider({ children, currentUser }) {
  const [activeTimers, setActiveTimers] = useState([]);

  useEffect(() => {
    if (!currentUser?.id) return;

    let isMounted = true;

    // Fetch active timers for this user
    const loadActiveTimers = async () => {
      try {
        const logs = await base44.entities.TaskTimeLog.filter({
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
    
    return () => {
      clearTimeout(timeout);
      isMounted = false;
    };
  }, [currentUser?.id]);

  useEffect(() => {
    if (!currentUser?.id) return;

    // Subscribe to real-time updates (separate effect to avoid re-subscribing on every user change)
    const unsubscribe = base44.entities.TaskTimeLog.subscribe((event) => {
      if (!event.data || event.data.user_id !== currentUser.id) return;

      setActiveTimers(prev => {
        if (event.type === 'create') {
          // Only add genuinely running timers — not completed manual entries or paused logs
          if (event.data.is_active && event.data.status === 'running') {
            return [...prev, event.data];
          }
          return prev;
        } else if (event.type === 'update') {
          if (event.data.is_active && event.data.status === 'running') {
            return prev.map(t => t.id === event.id ? event.data : t);
          } else {
            return prev.filter(t => t.id !== event.id);
          }
        } else if (event.type === 'delete') {
          return prev.filter(t => t.id !== event.id);
        }
        return prev;
      });
    });

    return unsubscribe;
  }, [currentUser?.id]);

  return (
    <ActiveTimersContext.Provider value={{ activeTimers, setActiveTimers }}>
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
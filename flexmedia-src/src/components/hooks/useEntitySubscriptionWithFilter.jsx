import { useEffect, useState } from 'react';
import { api } from '@/api/supabaseClient';

/**
 * Hook that subscribes to real-time updates for entities matching a filter
 * Replaces polling with true real-time subscription for better performance
 */
export function useEntitySubscriptionWithFilter(entityName, filter = {}, initialData = [], { sortBy = null, limit = null } = {}) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    // Initial fetch
    const fetchInitial = async () => {
      try {
        const results = await api.entities[entityName].filter(filter, sortBy, limit);
        if (isMounted) {
          setData(results);
          setLoading(false);
        }
      } catch (error) {
        console.error(`Failed to fetch ${entityName}:`, error);
        if (isMounted) setLoading(false);
      }
    };

    fetchInitial();

    // Subscribe to all changes - let subscription update state
    //
    // BUG FIX (subscription audit): CREATE events could add duplicates if the
    // subscription fires after fetchInitial() already included the item.
    // Now checks for existing ID before appending.
    const unsubscribe = api.entities[entityName].subscribe((event) => {
      if (!isMounted) return;

      setData((prevData) => {
        if (event.type === 'create') {
          // Check if new entity matches filter
          if (matchesFilter(event.data, filter)) {
            // BUG FIX: prevent duplicates from race between fetchInitial and subscription
            if (prevData.some(item => item.id === event.data?.id)) return prevData;
            return [...prevData, event.data];
          }
          return prevData;
        } else if (event.type === 'update') {
          // Check if still matches filter after update
          if (matchesFilter(event.data, filter)) {
            const exists = prevData.find(item => item.id === event.id);
            if (exists) {
              return prevData.map(item => item.id === event.id ? event.data : item);
            } else {
              return [...prevData, event.data];
            }
          } else {
            // Entity no longer matches filter
            return prevData.filter(item => item.id !== event.id);
          }
        } else if (event.type === 'delete') {
          return prevData.filter(item => item.id !== event.id);
        }
        return prevData;
      });
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [entityName, JSON.stringify(filter)]);

  const refetch = async () => {
    try {
      const results = await api.entities[entityName].filter(filter, sortBy, limit);
      setData(results);
    } catch (error) {
      console.error(`Failed to refetch ${entityName}:`, error);
    }
  };

  return { data, loading, refetch };
}

/**
 * Check if an entity matches the filter criteria.
 * Treats null/undefined as equivalent to false for boolean filters
 * (e.g., is_deleted: false should match entities where is_deleted is null/undefined).
 */
function matchesFilter(entity, filter) {
  if (!entity || typeof entity !== 'object') return false;
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      if (!value.includes(entity[key])) return false;
    } else if (typeof value === 'boolean') {
      // For boolean filters, treat null/undefined as false
      const entityVal = entity[key] == null ? false : entity[key];
      if (entityVal !== value) return false;
    } else if (entity[key] !== value) {
      return false;
    }
  }
  return true;
}
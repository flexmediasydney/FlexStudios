import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Hook that subscribes to real-time updates for entities matching a filter
 * Replaces polling with true real-time subscription for better performance
 */
export function useEntitySubscriptionWithFilter(entityName, filter = {}, initialData = []) {
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;

    // Initial fetch
    const fetchInitial = async () => {
      try {
        const results = await base44.entities[entityName].filter(filter);
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
    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      if (!isMounted) return;

      setData((prevData) => {
        if (event.type === 'create') {
          // Check if new entity matches filter
          if (matchesFilter(event.data, filter)) {
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
      const results = await base44.entities[entityName].filter(filter);
      setData(results);
    } catch (error) {
      console.error(`Failed to refetch ${entityName}:`, error);
    }
  };

  return { data, loading, refetch };
}

/**
 * Check if an entity matches the filter criteria
 */
function matchesFilter(entity, filter) {
  for (const [key, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      if (!value.includes(entity[key])) return false;
    } else if (entity[key] !== value) {
      return false;
    }
  }
  return true;
}
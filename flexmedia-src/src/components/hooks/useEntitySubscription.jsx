import { useEffect, useState, useRef } from 'react';
import { api } from '@/api/supabaseClient';

/**
 * Hook that subscribes to real-time updates for a specific entity
 * and updates component state immediately when changes occur.
 *
 * BUG FIXES (subscription audit):
 *  1. DELETE events now handled — previously ignored because event.data is null
 *     on DELETE, so the `event.data` truthiness check silently dropped them.
 *  2. Initial fetch added — without it, if initialData is null the component
 *     shows nothing until a realtime event arrives.
 */
export function useEntitySubscription(entityName, entityId, initialData = null) {
  const [data, setData] = useState(initialData);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (!entityId || !entityName) return;
    mountedRef.current = true;

    // Fetch current state so the component isn't blank until an event fires
    api.entities[entityName].get(entityId)
      .then(item => { if (mountedRef.current && item) setData(item); })
      .catch(() => { /* non-fatal — subscription will keep state current */ });

    // Subscribe to all changes for this entity type
    const unsubscribe = api.entities[entityName].subscribe((event) => {
      if (!event || !mountedRef.current) return;
      if (event.id !== entityId) return;

      // BUG FIX: handle DELETE events (event.data is null for deletes)
      if (event.type === 'delete') {
        setData(null);
      } else if (event.data) {
        setData(event.data);
      }
    });

    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, [entityName, entityId]);

  return data;
}

/**
 * Hook that subscribes to updates for a collection of entities.
 * Useful for parent components that need to track multiple children.
 *
 * BUG FIXES (subscription audit):
 *  1. CREATE now checks for duplicates — race between initial data and
 *     subscription could add the same item twice.
 *  2. UPDATE for items not yet in list now adds them instead of silently
 *     dropping the update (handles race condition).
 */
export function useEntityCollectionSubscription(entityName, filter = {}, initialData = []) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    if (!entityName) return;

    const unsubscribe = api.entities[entityName].subscribe((event) => {
      if (!event) return;
      setData((prevData) => {
        if (event.type === 'create' && event.data) {
          // BUG FIX: prevent duplicates from race between fetch and subscription
          if (prevData.some(item => item.id === event.data.id)) return prevData;
          return [...prevData, event.data];
        } else if (event.type === 'update' && event.data) {
          const exists = prevData.some(item => item.id === event.id);
          if (exists) {
            return prevData.map((item) =>
              item.id === event.id ? event.data : item
            );
          }
          // BUG FIX: item not in list yet (race condition) — add it
          return [...prevData, event.data];
        } else if (event.type === 'delete') {
          return prevData.filter((item) => item.id !== event.id);
        }
        return prevData;
      });
    });

    return unsubscribe;
  }, [entityName]);

  return data;
}
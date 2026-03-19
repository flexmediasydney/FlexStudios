import { useEffect, useState } from 'react';
import { base44 } from '@/api/base44Client';

/**
 * Hook that subscribes to real-time updates for a specific entity
 * and updates component state immediately when changes occur
 */
export function useEntitySubscription(entityName, entityId, initialData = null) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    if (!entityId || !entityName) return;

    // Subscribe to all changes for this entity type
    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      if (!event) return;
      // If this is the entity we're watching, update state
      if (event.id === entityId && event.data) {
        setData(event.data);
      }
    });

    return unsubscribe;
  }, [entityName, entityId]);

  return data;
}

/**
 * Hook that subscribes to updates for a collection of entities
 * Useful for parent components that need to track multiple children
 */
export function useEntityCollectionSubscription(entityName, filter = {}, initialData = []) {
  const [data, setData] = useState(initialData);

  useEffect(() => {
    if (!entityName) return;

    const unsubscribe = base44.entities[entityName].subscribe((event) => {
      if (!event) return;
      setData((prevData) => {
        if (event.type === 'create' && event.data) {
          return [...prevData, event.data];
        } else if (event.type === 'update' && event.data) {
          return prevData.map((item) =>
            item.id === event.id ? event.data : item
          );
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
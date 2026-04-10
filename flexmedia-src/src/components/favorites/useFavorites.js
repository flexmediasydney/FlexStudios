/**
 * useFavorites.js — Hook for media favorites and tagging
 *
 * Provides favorites list, tag registry, and CRUD operations for
 * the MediaFavorite + MediaTag entities. Uses the shared entity
 * cache (useEntityList) so all mounted components stay in sync
 * via Supabase Realtime.
 *
 * Performance notes:
 * - isFavorited / getFavorite use Map-keyed lookups (O(1)) instead of array.find()
 * - Errors surface via sonner toast instead of silent console.warn
 * - toggleMultiple supports bulk favorite/unfavorite operations
 */

import { useMemo, useCallback, useState, useRef } from 'react';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';

export function useFavorites() {
  const { data: user } = useCurrentUser();
  const userId = user?.id;

  // Load all favorites (sorted newest-first) and tag registry
  const { data: allFavorites, loading: favLoading } = useEntityList('MediaFavorite', '-created_date');
  const { data: allTags, loading: tagsLoading } = useEntityList('MediaTag', 'name');

  // Optimistic state: tracks pending toggles before the cache round-trip completes.
  // Keys are "file:<path>" or "project:<id>", values are true (added) or false (removed).
  const [optimisticToggles, setOptimisticToggles] = useState({});
  const toggleVersionRef = useRef(0); // monotonic counter to discard stale reconciliations
  const optimisticIdCounter = useRef(0); // monotonic ID to avoid Date.now() collisions in rapid toggles
  const inFlightKeys = useRef(new Set()); // guards against duplicate toggles for the same key

  // Filter to current user's favorites, then overlay optimistic state
  const favorites = useMemo(() => {
    if (!userId || !allFavorites) return [];
    let result = allFavorites.filter(f => f.user_id === userId);

    // Apply optimistic removals and additions
    const toggleEntries = Object.entries(optimisticToggles);
    if (toggleEntries.length > 0) {
      // Remove items that were optimistically unfavorited
      result = result.filter(f => {
        const fileKey = f.file_path ? `file:${f.file_path}` : null;
        const projKey = f.project_id ? `project:${f.project_id}` : null;
        if (fileKey && optimisticToggles[fileKey] === false) return false;
        if (projKey && optimisticToggles[projKey] === false) return false;
        return true;
      });

      // Add placeholder items for optimistic additions (if not already in list).
      // Optimistic additions are stored as record objects (not false).
      for (const [key, value] of toggleEntries) {
        if (value === false) continue; // skip removals
        if (typeof value === 'object' && value !== null) {
          // Check the item isn't already present (by file_path or project_id match)
          const alreadyPresent = result.some(f =>
            (value.file_path && f.file_path === value.file_path) ||
            (value.project_id && f.project_id === value.project_id)
          );
          if (!alreadyPresent) {
            result = [...result, { ...value, _optimisticKey: key }];
          }
        }
      }
    }

    return result;
  }, [allFavorites, userId, optimisticToggles]);

  // ── Map-based lookup indexes (O(1) per lookup instead of O(n)) ──
  const favoriteByFilePath = useMemo(() => {
    const map = new Map();
    for (const f of favorites) {
      if (f.file_path) map.set(f.file_path, f);
    }
    return map;
  }, [favorites]);

  const favoriteByProjectId = useMemo(() => {
    const map = new Map();
    for (const f of favorites) {
      if (f.project_id) map.set(f.project_id, f);
    }
    return map;
  }, [favorites]);

  /**
   * Check if a file or project is favorited by the current user.
   * Pass filePath for file favorites, projectId for project favorites.
   * Uses Map lookup for O(1) performance.
   */
  const isFavorited = useCallback((filePath, projectId) => {
    if (!userId) return false;
    if (filePath && favoriteByFilePath.has(filePath)) return true;
    if (projectId && favoriteByProjectId.has(projectId)) return true;
    return false;
  }, [userId, favoriteByFilePath, favoriteByProjectId]);

  /**
   * Get the full favorite record for a file or project, or null.
   * Uses Map lookup for O(1) performance.
   */
  const getFavorite = useCallback((filePath, projectId) => {
    if (!userId) return null;
    if (filePath) {
      const match = favoriteByFilePath.get(filePath);
      if (match) return match;
    }
    if (projectId) {
      const match = favoriteByProjectId.get(projectId);
      if (match) return match;
    }
    return null;
  }, [userId, favoriteByFilePath, favoriteByProjectId]);

  /**
   * Toggle a favorite on/off. Creates or deletes the MediaFavorite record
   * and writes an AuditLog entry.
   *
   * Uses optimistic updates: the UI reflects the new state instantly,
   * then reconciles once the API + cache round-trip completes.
   *
   * @returns {boolean} The new favorited state (true = now favorited, false = removed)
   */
  const toggleFavorite = useCallback(async ({
    filePath,
    projectId,
    fileName,
    fileType,
    projectTitle,
    propertyAddress,
    tonomoBasePath,
    _skipRefetch = false, // internal: skip cache refetch (batch caller does it once)
    _skipToast = false,   // internal: skip success toast (batch caller shows summary)
  }) => {
    if (!userId) return false;

    const optimisticKey = filePath ? `file:${filePath}` : `project:${projectId}`;

    // Guard: reject duplicate toggle for the same key while one is in-flight
    if (inFlightKeys.current.has(optimisticKey)) return isFavorited(filePath, projectId);
    inFlightKeys.current.add(optimisticKey);

    const existing = getFavorite(filePath, projectId);
    const version = ++toggleVersionRef.current;
    const displayName = fileName || projectTitle || 'item';

    if (existing) {
      // ── Optimistic removal ──
      setOptimisticToggles(prev => ({ ...prev, [optimisticKey]: false }));

      try {
        await api.entities.MediaFavorite.delete(existing.id);
        // Decrement usage_count for each tag on the deleted favorite
        if (existing.tags?.length > 0) {
          const freshTags = await api.entities.MediaTag.list('-created_date', 200).catch(() => []);
          for (const tagName of existing.tags) {
            const tag = freshTags.find(t => t.name === tagName);
            if (tag && tag.usage_count > 0) {
              api.entities.MediaTag.update(tag.id, { usage_count: tag.usage_count - 1 }).catch(() => {});
            }
          }
        }
        api.entities.AuditLog.create({
          entity_type: 'media_favorite',
          entity_id: existing.id,
          action: 'unfavorited',
          user_id: userId,
          user_name: user?.full_name || user?.email || 'Unknown',
          entity_name: fileName || projectTitle || filePath || projectId || 'Unknown',
          details: {
            file_name: fileName || null,
            file_path: filePath || null,
            file_type: fileType || null,
            project_id: projectId || null,
            project_title: projectTitle || null,
            property_address: propertyAddress || null,
            tonomo_base_path: tonomoBasePath || null,
          },
        }).catch(err => { console.warn('[useFavorites] Audit log failed:', err?.message); });
      } catch (err) {
        // Revert optimistic state on failure
        inFlightKeys.current.delete(optimisticKey);
        if (toggleVersionRef.current === version) {
          setOptimisticToggles(prev => {
            const next = { ...prev };
            delete next[optimisticKey];
            return next;
          });
        }
        toast.error('Failed to remove favorite', {
          description: err?.message || `Could not unfavorite "${displayName}". Please try again.`,
        });
        // Refetch to sync with server truth after failed optimistic revert
        try { await refetchEntityList('MediaFavorite'); } catch {}
        return true; // still favorited
      }
    } else {
      // ── Optimistic addition ──
      const favoritedByName = user?.full_name || user?.email || 'Unknown';
      const optimisticRecord = {
        id: `_optimistic_${Date.now()}_${++optimisticIdCounter.current}`,
        user_id: userId,
        file_path: filePath || null,
        project_id: projectId || null,
        file_name: fileName || null,
        file_type: fileType || null,
        project_title: projectTitle || null,
        property_address: propertyAddress || null,
        tonomo_base_path: tonomoBasePath || null,
        favorited_by_name: favoritedByName,
        tags: [],
        created_date: new Date().toISOString(),
      };
      setOptimisticToggles(prev => ({ ...prev, [optimisticKey]: optimisticRecord }));

      try {
        const record = await api.entities.MediaFavorite.create({
          user_id: userId,
          file_path: filePath || null,
          project_id: projectId || null,
          file_name: fileName || null,
          file_type: fileType || null,
          project_title: projectTitle || null,
          property_address: propertyAddress || null,
          tonomo_base_path: tonomoBasePath || null,
          favorited_by_name: favoritedByName,
          tags: [],
        });
        api.entities.AuditLog.create({
          entity_type: 'media_favorite',
          entity_id: record.id,
          action: 'favorited',
          user_id: userId,
          user_name: user?.full_name || user?.email || 'Unknown',
          entity_name: fileName || projectTitle || filePath || projectId || 'Unknown',
          details: {
            file_name: fileName || null,
            file_path: filePath || null,
            file_type: fileType || null,
            project_id: projectId || null,
            project_title: projectTitle || null,
            property_address: propertyAddress || null,
            tonomo_base_path: tonomoBasePath || null,
          },
        }).catch(err => { console.warn('[useFavorites] Audit log failed:', err?.message); });
      } catch (err) {
        // Revert optimistic state on failure
        inFlightKeys.current.delete(optimisticKey);
        if (toggleVersionRef.current === version) {
          setOptimisticToggles(prev => {
            const next = { ...prev };
            delete next[optimisticKey];
            return next;
          });
        }
        toast.error('Failed to add favorite', {
          description: err?.message || `Could not favorite "${displayName}". Please try again.`,
        });
        // Refetch to sync with server truth after failed optimistic revert
        try { await refetchEntityList('MediaFavorite'); } catch {}
        return false; // still not favorited
      }
    }

    // Refresh the shared cache so all components update, then clear optimistic state.
    // In batch mode (_skipRefetch), the caller does a single refetch after all toggles.
    if (!_skipRefetch) {
      try {
        await refetchEntityList('MediaFavorite');
      } finally {
        // Always clear optimistic state and in-flight guard, even if refetch fails.
        // Only clear if no newer toggle has been issued (prevents stale reconciliation)
        inFlightKeys.current.delete(optimisticKey);
        if (toggleVersionRef.current === version) {
          setOptimisticToggles(prev => {
            const next = { ...prev };
            delete next[optimisticKey];
            return next;
          });
        }
      }
    } else {
      inFlightKeys.current.delete(optimisticKey);
    }

    // Success toast for single toggle (suppressed in batch mode)
    if (!_skipToast) {
      if (existing) {
        toast.success('Removed from favorites', {
          description: `"${displayName}" unfavorited.`,
          duration: 2000,
        });
      } else {
        toast.success('Added to favorites', {
          description: `"${displayName}" favorited.`,
          duration: 2000,
        });
      }
    }

    return !existing;
  }, [userId, user, getFavorite, isFavorited]);

  /**
   * Toggle multiple items at once. Accepts an array of item descriptors
   * and a target state (true = favorite all, false = unfavorite all).
   * Operations run in parallel with individual optimistic updates.
   *
   * @param {Array<{filePath, projectId, fileName, fileType, projectTitle, propertyAddress, tonomoBasePath}>} items
   * @param {boolean} targetState - true to favorite all, false to unfavorite all
   * @returns {number} Count of items that were actually toggled
   */
  const toggleMultiple = useCallback(async (items, targetState) => {
    if (!userId || !items?.length) return 0;

    let toggledCount = 0;
    const itemsToToggle = items.filter(item => {
      const currentlyFavorited = isFavorited(item.filePath, item.projectId);
      // Only toggle items that need changing
      return targetState ? !currentlyFavorited : currentlyFavorited;
    });

    if (itemsToToggle.length === 0) {
      toast.info('No changes needed', {
        description: `All ${items.length} items are already ${targetState ? 'favorited' : 'unfavorited'}.`,
      });
      return 0;
    }

    try {
      // toggleFavorite never rejects — it catches errors internally and returns a boolean.
      // Use the return value (new favorited state) to detect whether the toggle succeeded:
      // - If targetState is true (favoriting), success means the return is true.
      // - If targetState is false (unfavoriting), success means the return is false.
      // Pass _skipRefetch + _skipToast so we do ONE refetch after all toggles complete.
      const results = await Promise.all(
        itemsToToggle.map(item => toggleFavorite({ ...item, _skipRefetch: true, _skipToast: true }))
      );

      // Single refetch after all toggles
      try {
        await refetchEntityList('MediaFavorite');
      } catch {
        // Swallow refetch error — optimistic state will be cleared below
      }

      toggledCount = results.filter(r => r === targetState).length;
      const failedCount = results.length - toggledCount;

      if (failedCount > 0) {
        toast.warning(`${toggledCount} ${targetState ? 'favorited' : 'unfavorited'}, ${failedCount} failed`, {
          description: 'Some items could not be updated. Please try again.',
        });
      } else {
        toast.success(`${toggledCount} items ${targetState ? 'favorited' : 'unfavorited'}`);
      }
    } catch (err) {
      toast.error('Batch operation failed', {
        description: err?.message || 'Could not complete the bulk operation.',
      });
    } finally {
      setOptimisticToggles(prev => {
        const next = { ...prev };
        for (const item of itemsToToggle) {
          const key = item.filePath ? `file:${item.filePath}` : `project:${item.projectId}`;
          delete next[key];
        }
        return next;
      });
    }

    return toggledCount;
  }, [userId, isFavorited, toggleFavorite]);

  /**
   * Update tags on a favorite and sync the media_tags registry.
   * Creates new MediaTag records for any tags that don't exist yet,
   * and increments/decrements usage_count accordingly.
   */
  const updateTags = useCallback(async (favoriteId, newTags) => {
    if (!userId || !favoriteId) return;

    // Get the current favorite to diff tags
    const current = allFavorites?.find(f => f.id === favoriteId);
    if (!current) {
      toast.error('Cannot update tags', {
        description: 'Favorite record not found. It may have been removed.',
      });
      return;
    }
    const oldTags = Array.isArray(current.tags) ? current.tags : [];
    const displayName = current?.file_name || current?.project_title || 'item';

    try {
      // Update the favorite record
      await api.entities.MediaFavorite.update(favoriteId, { tags: newTags });

      // Determine added/removed tags for registry updates
      const added = newTags.filter(t => !oldTags.includes(t));
      const removed = oldTags.filter(t => !newTags.includes(t));

      // Upsert new tags into the registry.
      // Re-fetch fresh tag list to avoid stale usage_count from concurrent updateTags calls.
      const freshTags = await refetchEntityList('MediaTag') || allTags || [];
      for (const tagName of added) {
        const existing = freshTags.find(t => t.name === tagName);
        if (existing) {
          await api.entities.MediaTag.update(existing.id, {
            usage_count: (existing.usage_count || 0) + 1,
          });
        } else {
          await api.entities.MediaTag.create({
            name: tagName,
            usage_count: 1,
            created_by_id: userId,
            created_by_name: user?.full_name || user?.email || 'Unknown',
          });
        }
      }

      // Decrement usage_count for removed tags
      for (const tagName of removed) {
        const existing = freshTags.find(t => t.name === tagName);
        if (existing && (existing.usage_count || 0) > 0) {
          await api.entities.MediaTag.update(existing.id, {
            usage_count: Math.max(0, (existing.usage_count || 0) - 1),
          });
        }
      }

      // Audit log — fire-and-forget (consistent with toggle audit logs)
      api.entities.AuditLog.create({
        entity_type: 'media_favorite',
        entity_id: favoriteId,
        action: 'tags_updated',
        user_id: userId,
        user_name: user?.full_name || user?.email || 'Unknown',
        entity_name: current?.file_name || current?.project_title || 'Unknown',
        details: {
          file_name: current?.file_name || null,
          file_path: current?.file_path || null,
          file_type: current?.file_type || null,
          project_id: current?.project_id || null,
          project_title: current?.project_title || null,
          tonomo_base_path: current?.tonomo_base_path || null,
          tags: newTags,
          added_tags: added,
          removed_tags: removed,
        },
      }).catch(err => { console.warn('[useFavorites] Audit log failed:', err?.message); });

      // Refresh caches
      await Promise.all([
        refetchEntityList('MediaFavorite'),
        refetchEntityList('MediaTag'),
      ]);

      // Success toast for tag updates
      if (added.length > 0 && removed.length === 0) {
        toast.success(`Tag${added.length > 1 ? 's' : ''} added`, {
          description: `Added ${added.map(t => '#' + t).join(', ')} to "${displayName}".`,
          duration: 2500,
        });
      } else if (removed.length > 0 && added.length === 0) {
        toast.success(`Tag${removed.length > 1 ? 's' : ''} removed`, {
          description: `Removed ${removed.map(t => '#' + t).join(', ')} from "${displayName}".`,
          duration: 2500,
        });
      } else if (added.length > 0 && removed.length > 0) {
        toast.success('Tags updated', {
          description: `Updated tags on "${displayName}".`,
          duration: 2500,
        });
      }
    } catch (err) {
      toast.error('Failed to update tags', {
        description: err?.message || `Could not update tags on "${displayName}". Please try again.`,
      });
      // Re-throw so callers can handle if needed
      throw err;
    }
  }, [userId, user, allFavorites, allTags]);

  return {
    favorites,
    allTags: allTags || [],
    isFavorited,
    getFavorite,
    toggleFavorite,
    toggleMultiple,
    updateTags,
    loading: favLoading || tagsLoading,
  };
}

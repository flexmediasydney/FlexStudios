/**
 * useFavorites.js — Hook for media favorites and tagging
 *
 * Provides favorites list, tag registry, and CRUD operations for
 * the MediaFavorite + MediaTag entities. Uses the shared entity
 * cache (useEntityList) so all mounted components stay in sync
 * via Supabase Realtime.
 */

import { useMemo, useCallback } from 'react';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import { api } from '@/api/supabaseClient';

export function useFavorites() {
  const { data: user } = useCurrentUser();
  const userId = user?.id;

  // Load all favorites (sorted newest-first) and tag registry
  const { data: allFavorites, loading: favLoading } = useEntityList('MediaFavorite', '-created_date');
  const { data: allTags, loading: tagsLoading } = useEntityList('MediaTag', 'name');

  // Filter to current user's favorites
  const favorites = useMemo(() => {
    if (!userId || !allFavorites) return [];
    return allFavorites.filter(f => f.user_id === userId);
  }, [allFavorites, userId]);

  /**
   * Check if a file or project is favorited by the current user.
   * Pass filePath for file favorites, projectId for project favorites.
   */
  const isFavorited = useCallback((filePath, projectId) => {
    if (!userId) return false;
    return favorites.some(f =>
      (filePath && f.file_path === filePath) ||
      (projectId && f.project_id === projectId)
    );
  }, [favorites, userId]);

  /**
   * Get the full favorite record for a file or project, or null.
   */
  const getFavorite = useCallback((filePath, projectId) => {
    if (!userId) return null;
    return favorites.find(f =>
      (filePath && f.file_path === filePath) ||
      (projectId && f.project_id === projectId)
    ) || null;
  }, [favorites, userId]);

  /**
   * Toggle a favorite on/off. Creates or deletes the MediaFavorite record
   * and writes an AuditLog entry.
   */
  const toggleFavorite = useCallback(async ({
    filePath,
    projectId,
    fileName,
    fileType,
    projectTitle,
    propertyAddress,
    tonomoBasePath,
  }) => {
    if (!userId) return;

    const existing = getFavorite(filePath, projectId);

    if (existing) {
      // Remove favorite
      await api.entities.MediaFavorite.delete(existing.id);
      await api.entities.AuditLog.create({
        entity_type: 'media_favorite',
        entity_id: existing.id,
        action: 'unfavorited',
        user_id: userId,
        user_name: user?.full_name || user?.email || 'Unknown',
        details: filePath
          ? `Removed favorite: ${fileName || filePath}`
          : `Removed favorite: ${projectTitle || projectId}`,
      });
    } else {
      // Create favorite
      const record = await api.entities.MediaFavorite.create({
        user_id: userId,
        file_path: filePath || null,
        project_id: projectId || null,
        file_name: fileName || null,
        file_type: fileType || null,
        project_title: projectTitle || null,
        property_address: propertyAddress || null,
        tonomo_base_path: tonomoBasePath || null,
        tags: [],
      });
      await api.entities.AuditLog.create({
        entity_type: 'media_favorite',
        entity_id: record.id,
        action: 'favorited',
        user_id: userId,
        user_name: user?.full_name || user?.email || 'Unknown',
        details: filePath
          ? `Favorited file: ${fileName || filePath}`
          : `Favorited project: ${projectTitle || projectId}`,
      });
    }

    // Refresh the shared cache so all components update
    await refetchEntityList('MediaFavorite');
  }, [userId, user, getFavorite]);

  /**
   * Update tags on a favorite and sync the media_tags registry.
   * Creates new MediaTag records for any tags that don't exist yet,
   * and increments/decrements usage_count accordingly.
   */
  const updateTags = useCallback(async (favoriteId, newTags) => {
    if (!userId || !favoriteId) return;

    // Get the current favorite to diff tags
    const current = allFavorites?.find(f => f.id === favoriteId);
    const oldTags = current?.tags || [];

    // Update the favorite record
    await api.entities.MediaFavorite.update(favoriteId, { tags: newTags });

    // Determine added/removed tags for registry updates
    const added = newTags.filter(t => !oldTags.includes(t));
    const removed = oldTags.filter(t => !newTags.includes(t));

    // Upsert new tags into the registry
    for (const tagName of added) {
      const existing = allTags?.find(t => t.name === tagName);
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
      const existing = allTags?.find(t => t.name === tagName);
      if (existing && (existing.usage_count || 0) > 0) {
        await api.entities.MediaTag.update(existing.id, {
          usage_count: Math.max(0, (existing.usage_count || 0) - 1),
        });
      }
    }

    // Audit log
    await api.entities.AuditLog.create({
      entity_type: 'media_favorite',
      entity_id: favoriteId,
      action: 'tags_updated',
      user_id: userId,
      user_name: user?.full_name || user?.email || 'Unknown',
      details: `Tags: [${newTags.join(', ')}]`,
    });

    // Refresh caches
    await Promise.all([
      refetchEntityList('MediaFavorite'),
      refetchEntityList('MediaTag'),
    ]);
  }, [userId, user, allFavorites, allTags]);

  return {
    favorites,
    allTags: allTags || [],
    isFavorited,
    getFavorite,
    toggleFavorite,
    updateTags,
    loading: favLoading || tagsLoading,
  };
}

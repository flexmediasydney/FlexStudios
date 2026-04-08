/**
 * FavoriteButton.jsx — Star toggle for files and projects
 *
 * Small, unobtrusive button that fits in thumbnail overlays or header bars.
 * Filled yellow star when favorited, outline when not.
 */

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useFavorites } from './useFavorites';

const SIZES = {
  sm: 'h-4 w-4',
  md: 'h-5 w-5',
  lg: 'h-6 w-6',
};

const BUTTON_SIZES = {
  sm: 'p-1',
  md: 'p-1.5',
  lg: 'p-2',
};

export default function FavoriteButton({
  filePath,
  projectId,
  fileName,
  fileType,
  projectTitle,
  propertyAddress,
  tonomoBasePath,
  size = 'sm',
  className,
}) {
  const { isFavorited, toggleFavorite } = useFavorites();
  const serverActive = isFavorited(filePath, projectId);

  // Local optimistic state: null means "follow server", boolean means "override"
  const [optimistic, setOptimistic] = useState(null);
  const togglingRef = useRef(false);

  // Sync local optimistic state back to server truth once the hook data catches up
  useEffect(() => {
    if (optimistic !== null && optimistic === serverActive) {
      setOptimistic(null);
    }
  }, [serverActive, optimistic]);

  const active = optimistic !== null ? optimistic : serverActive;

  const handleClick = useCallback((e) => {
    e.stopPropagation();
    e.preventDefault();

    // Prevent double-click while a toggle is in flight
    if (togglingRef.current) return;
    togglingRef.current = true;

    // Flip the star instantly
    setOptimistic(!active);

    toggleFavorite({
      filePath,
      projectId,
      fileName,
      fileType,
      projectTitle,
      propertyAddress,
      tonomoBasePath,
    }).catch(() => {
      // On failure, revert to server state
      setOptimistic(null);
    }).finally(() => {
      togglingRef.current = false;
    });
  }, [active, filePath, projectId, fileName, fileType, projectTitle, propertyAddress, tonomoBasePath, toggleFavorite]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        'inline-flex items-center justify-center rounded-md transition-colors',
        'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        BUTTON_SIZES[size] || BUTTON_SIZES.sm,
        className,
      )}
      title={active ? 'Remove from favorites' : 'Add to favorites'}
    >
      <Star
        className={cn(
          SIZES[size] || SIZES.sm,
          'transition-colors',
          active
            ? 'fill-yellow-400 text-yellow-400'
            : 'text-muted-foreground hover:text-yellow-400',
        )}
      />
    </button>
  );
}

/**
 * FavoriteButton.jsx — Star toggle for files and projects
 *
 * Small, unobtrusive button that fits in thumbnail overlays or header bars.
 * Filled yellow star when favorited, outline when not.
 *
 * Features:
 * - Scale bounce animation on toggle (120% -> 100%)
 * - Color flash on toggle for tactile feedback
 * - Pulse animation while API call is in-flight
 * - Tooltip with "Add to favorites" / "Remove from favorites"
 * - sm/md/lg size variants with proportional click areas
 */

import React, { useCallback, useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Star } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFavorites } from './useFavorites';

const ICON_SIZES = {
  sm: 16,
  md: 20,
  lg: 24,
};

const BUTTON_PADDING = {
  sm: 'p-1.5',
  md: 'p-2',
  lg: 'p-2.5',
};

// Minimum touch-target sizing for each variant (larger than icon for easy clicking)
const MIN_SIZES = {
  sm: 'min-w-[28px] min-h-[28px]',
  md: 'min-w-[34px] min-h-[34px]',
  lg: 'min-w-[40px] min-h-[40px]',
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
  const [isToggling, setIsToggling] = useState(false);
  const [flashKey, setFlashKey] = useState(0); // Increment to trigger color flash
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
    setIsToggling(true);

    // Flip the star instantly + trigger color flash
    setOptimistic(!active);
    setFlashKey(k => k + 1);

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
      setIsToggling(false);
    });
  }, [active, filePath, projectId, fileName, fileType, projectTitle, propertyAddress, tonomoBasePath, toggleFavorite]);

  const iconSize = ICON_SIZES[size] || ICON_SIZES.sm;

  return (
    <TooltipProvider delayDuration={400}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handleClick}
            className={cn(
              'inline-flex items-center justify-center rounded-md transition-colors relative',
              'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
              BUTTON_PADDING[size] || BUTTON_PADDING.sm,
              MIN_SIZES[size] || MIN_SIZES.sm,
              className,
            )}
            aria-label={active ? 'Remove from favorites' : 'Add to favorites'}
          >
            {/* Glow effect behind the star when active */}
            <AnimatePresence>
              {active && (
                <motion.span
                  className="absolute inset-0 rounded-md bg-yellow-400/10 pointer-events-none"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                />
              )}
            </AnimatePresence>

            {/* Color flash on toggle */}
            <AnimatePresence mode="wait">
              <motion.span
                key={flashKey}
                className="absolute inset-0 rounded-md pointer-events-none"
                initial={{ backgroundColor: 'rgba(250, 204, 21, 0.3)' }}
                animate={{ backgroundColor: 'rgba(250, 204, 21, 0)' }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </AnimatePresence>

            {/* Star icon with bounce animation */}
            <motion.div
              key={`star-${active}`}
              initial={{ scale: 1.2 }}
              animate={{
                scale: 1,
                ...(isToggling ? { opacity: [1, 0.7, 1] } : {}),
              }}
              transition={{
                scale: { type: 'spring', stiffness: 500, damping: 15, mass: 0.5 },
                opacity: { duration: 0.8, repeat: isToggling ? Infinity : 0 },
              }}
              className="relative z-10"
            >
              <Star
                size={iconSize}
                className={cn(
                  'transition-colors duration-200',
                  active
                    ? 'fill-yellow-400 text-yellow-400 drop-shadow-[0_0_4px_rgba(250,204,21,0.5)]'
                    : 'text-muted-foreground hover:text-yellow-400/70',
                  isToggling && !active && 'animate-pulse',
                )}
              />
            </motion.div>
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          {active ? 'Remove from favorites' : 'Add to favorites'}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

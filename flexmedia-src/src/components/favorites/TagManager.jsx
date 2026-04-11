/**
 * TagManager.jsx — Popover for managing tags on a favorited item
 *
 * Shows current tags as removable colored pills, an input with autocomplete
 * from the global MediaTag registry, and handles add/remove via
 * the useFavorites hook.
 *
 * Features:
 * - Colored tag pills from media_tags registry
 * - Autocomplete with colors + usage counts
 * - Quick-add buttons for popular tags
 * - Slide-in / fade-out animations for tags
 * - Full keyboard navigation (Tab, Enter, Escape, arrow keys)
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Tag, X, Plus, Hash } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFavorites } from './useFavorites';
import { toast } from 'sonner';

// Default palette for tags without a registry color
const DEFAULT_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

function getTagColor(tagName, allTags) {
  const registered = allTags?.find(t => t.name === tagName);
  if (registered?.color) return registered.color;
  // Deterministic color from name hash
  let hash = 0;
  for (let i = 0; i < tagName.length; i++) {
    hash = tagName.charCodeAt(i) + ((hash << 5) - hash);
  }
  return DEFAULT_COLORS[Math.abs(hash) % DEFAULT_COLORS.length];
}

function TagPill({ tag, color, onRemove, isRemoving }) {
  return (
    <motion.span
      layout
      initial={{ opacity: 0, scale: 0.8, x: -8 }}
      animate={{ opacity: 1, scale: 1, x: 0 }}
      exit={{ opacity: 0, scale: 0.8, x: 8 }}
      transition={{ type: 'spring', stiffness: 400, damping: 25 }}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
      style={{
        backgroundColor: `${color}18`,
        color: color,
        border: `1px solid ${color}30`,
      }}
    >
      {tag}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onRemove(tag);
        }}
        className="rounded-full p-0.5 transition-colors hover:bg-black/10 dark:hover:bg-white/10"
        aria-label={`Remove tag ${tag}`}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </motion.span>
  );
}

export default function TagManager({ favoriteId, currentTags = [], onTagsChanged, onEnsureAndTag, allowCreation = true }) {
  const { allTags, updateTags } = useFavorites();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [removingTag, setRemovingTag] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef(null);
  const suggestionsRef = useRef(null);

  // Focus input when popover opens; reset state when it closes
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setInput('');
      setFocusedIndex(-1);
      setRemovingTag(null);
      setIsSaving(false);
    }
  }, [open]);

  // Autocomplete suggestions: show ALL existing tags when empty, filter when typing
  const suggestions = useMemo(() => {
    const lower = input.trim().toLowerCase();
    return (allTags || [])
      .filter(t =>
        !currentTags.includes(t.name) &&
        (!lower || t.name.toLowerCase().includes(lower))
      )
      .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0))
      .slice(0, 12);
  }, [input, allTags, currentTags]);

  // Quick-add tags: top used tags not already applied
  const quickTags = useMemo(() => {
    return (allTags || [])
      .filter(t => !currentTags.includes(t.name) && (t.usage_count || 0) > 0)
      .sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0))
      .slice(0, 5);
  }, [allTags, currentTags]);

  // Persist tag changes: if favoriteId exists, use updateTags directly.
  // If no favoriteId yet, use onEnsureAndTag to auto-create the favorite first.
  const persistTags = useCallback(async (newTags) => {
    if (favoriteId) {
      await updateTags(favoriteId, newTags);
    } else if (onEnsureAndTag) {
      await onEnsureAndTag(newTags);
    }
  }, [favoriteId, updateTags, onEnsureAndTag]);

  const addTag = useCallback(async (tagName) => {
    if (isSaving) return;
    const trimmed = tagName.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, ' ').replace(/^[-_ ]+|[-_ ]+$/g, '').trim();
    if (!trimmed || trimmed.length > 50 || currentTags.some(t => t.toLowerCase() === trimmed)) return;

    // When creation is disabled, only allow selecting existing tags from the registry
    if (!allowCreation) {
      const exists = (allTags || []).some(t => t.name.toLowerCase() === trimmed.toLowerCase());
      if (!exists) {
        toast.error('Tag not found — create new tags in Favorites');
        return;
      }
    }

    const newTags = [...currentTags, trimmed];
    setInput('');
    setFocusedIndex(-1);
    setIsSaving(true);
    onTagsChanged?.(newTags);
    try {
      await persistTags(newTags);
    } catch {
      // persistTags / updateTags already shows a toast.error; revert local state
      onTagsChanged?.(currentTags);
    } finally {
      setIsSaving(false);
    }
  }, [currentTags, persistTags, onTagsChanged, isSaving, allowCreation, allTags]);

  const removeTag = useCallback(async (tagName) => {
    if (isSaving) return;
    setRemovingTag(tagName);
    setIsSaving(true);
    const newTags = currentTags.filter(t => t !== tagName);
    onTagsChanged?.(newTags);
    try {
      await persistTags(newTags);
    } catch {
      // persistTags / updateTags already shows a toast.error; revert local state
      onTagsChanged?.(currentTags);
    } finally {
      setRemovingTag(null);
      setIsSaving(false);
    }
  }, [currentTags, persistTags, onTagsChanged, isSaving]);

  const handleKeyDown = useCallback((e) => {
    const hasSuggestions = suggestions.length > 0;

    switch (e.key) {
      case 'Enter':
        e.preventDefault();
        if (focusedIndex >= 0 && focusedIndex < suggestions.length) {
          addTag(suggestions[focusedIndex].name);
        } else if (input.trim()) {
          addTag(input);
        }
        break;

      case ',':
        if (input.trim()) {
          e.preventDefault();
          addTag(input);
        }
        break;

      case 'Escape':
        if (input.trim()) {
          e.preventDefault();
          setInput('');
          setFocusedIndex(-1);
        } else {
          setOpen(false);
        }
        break;

      case 'ArrowDown':
        if (hasSuggestions) {
          e.preventDefault();
          setFocusedIndex(prev => Math.min(prev + 1, suggestions.length - 1));
        }
        break;

      case 'ArrowUp':
        if (hasSuggestions) {
          e.preventDefault();
          setFocusedIndex(prev => Math.max(prev - 1, -1));
        }
        break;

      case 'Tab':
        if (hasSuggestions && !e.shiftKey) {
          e.preventDefault();
          setFocusedIndex(prev => (prev + 1) % suggestions.length);
        }
        break;

      case 'Backspace':
        if (!input && currentTags.length > 0) {
          removeTag(currentTags[currentTags.length - 1]);
        }
        break;

      default:
        break;
    }
  }, [input, suggestions, focusedIndex, addTag, currentTags, removeTag]);

  // Reset focused index when suggestions change
  useEffect(() => {
    setFocusedIndex(-1);
  }, [suggestions.length]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md p-1.5 transition-colors',
            'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'text-muted-foreground hover:text-foreground',
            currentTags.length > 0 && 'text-foreground',
          )}
          title="Manage tags"
          aria-label={`Manage tags (${currentTags.length} tags)`}
        >
          <Tag className="h-4 w-4" />
          {currentTags.length > 0 && (
            <span className="ml-0.5 text-[10px] font-medium tabular-nums">
              {currentTags.length}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-80 p-0 shadow-lg border border-border/50"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 space-y-3">
          {/* Header */}
          <div className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5 text-muted-foreground" />
            <p className="text-xs font-medium text-muted-foreground tracking-wide uppercase">Tags</p>
          </div>

          {/* Current tags as removable colored pills */}
          <AnimatePresence mode="popLayout">
            {currentTags.length > 0 && (
              <motion.div
                className="flex flex-wrap gap-1.5"
                layout
              >
                <AnimatePresence mode="popLayout">
                  {currentTags.map((tag) => (
                    <TagPill
                      key={tag}
                      tag={tag}
                      color={getTagColor(tag, allTags)}
                      onRemove={removeTag}
                      isRemoving={removingTag === tag}
                    />
                  ))}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Input for adding new tags */}
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add tags (e.g. hero-shot, exterior)"
            className="h-8 text-sm bg-muted/30 border-muted"
          />

          {/* Autocomplete suggestions */}
          <AnimatePresence>
            {suggestions.length > 0 && (
              <motion.div
                ref={suggestionsRef}
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.15 }}
                className="border border-border/50 rounded-md max-h-40 overflow-y-auto"
              >
                {suggestions.map((tag, idx) => {
                  const color = tag.color || getTagColor(tag.name, allTags);
                  return (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => addTag(tag.name)}
                      className={cn(
                        'w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 transition-colors',
                        idx === focusedIndex
                          ? 'bg-accent text-accent-foreground'
                          : 'hover:bg-accent/50',
                      )}
                    >
                      <span
                        className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: color }}
                      />
                      <span className="flex-1 truncate">{tag.name}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {tag.usage_count || 0}
                      </span>
                    </button>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Hint when typing with no suggestions */}
          {input.trim() && suggestions.length === 0 && !currentTags.includes(input.trim().toLowerCase()) && (
            <p className="text-[11px] text-muted-foreground px-1">
              {allowCreation ? (
                <>Press <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Enter</kbd> to create "{input.trim()}"</>
              ) : (
                <span className="text-muted-foreground">Tag not found — create tags in Favorites</span>
              )}
            </p>
          )}

          {/* Quick-add popular tags */}
          {quickTags.length > 0 && !input.trim() && (
            <div className="pt-1 border-t border-border/50">
              <p className="text-[10px] font-medium text-muted-foreground mb-1.5 tracking-wide uppercase">
                Popular
              </p>
              <div className="flex flex-wrap gap-1">
                {quickTags.map((tag) => {
                  const color = tag.color || getTagColor(tag.name, allTags);
                  return (
                    <button
                      key={tag.name}
                      type="button"
                      onClick={() => addTag(tag.name)}
                      className={cn(
                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px]',
                        'border border-dashed transition-all duration-150',
                        'hover:border-solid hover:scale-105 active:scale-95',
                      )}
                      style={{
                        borderColor: `${color}40`,
                        color: color,
                      }}
                    >
                      <Plus className="h-2.5 w-2.5" />
                      {tag.name}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

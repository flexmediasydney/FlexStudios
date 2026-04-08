/**
 * TagManager.jsx — Popover for managing tags on a favorited item
 *
 * Shows current tags as removable pills, an input with autocomplete
 * from the global MediaTag registry, and handles add/remove via
 * the useFavorites hook.
 */

import React, { useState, useRef, useCallback, useMemo } from 'react';
import { Tag, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useFavorites } from './useFavorites';

export default function TagManager({ favoriteId, currentTags = [], onTagsChanged }) {
  const { allTags, updateTags } = useFavorites();
  const [input, setInput] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef(null);

  // Autocomplete suggestions: tags from registry that match input and aren't already applied
  const suggestions = useMemo(() => {
    if (!input.trim()) return [];
    const lower = input.trim().toLowerCase();
    return (allTags || [])
      .filter(t =>
        t.name.toLowerCase().includes(lower) &&
        !currentTags.includes(t.name)
      )
      .slice(0, 8)
      .map(t => t.name);
  }, [input, allTags, currentTags]);

  const addTag = useCallback(async (tagName) => {
    const trimmed = tagName.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '');
    if (!trimmed || currentTags.includes(trimmed)) return;

    const newTags = [...currentTags, trimmed];
    await updateTags(favoriteId, newTags);
    onTagsChanged?.(newTags);
    setInput('');
  }, [currentTags, favoriteId, updateTags, onTagsChanged]);

  const removeTag = useCallback(async (tagName) => {
    const newTags = currentTags.filter(t => t !== tagName);
    await updateTags(favoriteId, newTags);
    onTagsChanged?.(newTags);
  }, [currentTags, favoriteId, updateTags, onTagsChanged]);

  const handleKeyDown = useCallback((e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault();
      addTag(input);
    }
  }, [input, addTag]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center justify-center rounded-md p-1 transition-colors',
            'hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'text-muted-foreground hover:text-foreground',
          )}
          title="Manage tags"
        >
          <Tag className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start" onClick={(e) => e.stopPropagation()}>
        <div className="space-y-3">
          <p className="text-xs font-medium text-muted-foreground">Tags</p>

          {/* Current tags as removable pills */}
          {currentTags.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {currentTags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded-full text-xs"
                >
                  {tag}
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    className="hover:opacity-70"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Input for adding new tags */}
          <Input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Add tag..."
            className="h-8 text-sm"
          />

          {/* Autocomplete suggestions */}
          {suggestions.length > 0 && (
            <div className="border rounded-md max-h-32 overflow-y-auto">
              {suggestions.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => addTag(name)}
                  className="w-full text-left px-2 py-1.5 text-xs hover:bg-accent transition-colors"
                >
                  {name}
                </button>
              ))}
            </div>
          )}

          {input.trim() && suggestions.length === 0 && !currentTags.includes(input.trim().toLowerCase()) && (
            <p className="text-xs text-muted-foreground">
              Press Enter to create "{input.trim()}"
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

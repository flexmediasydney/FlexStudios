import React, { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

const shortcuts = [
  { category: 'Navigation', items: [
    { keys: ['⌘', 'K'], description: 'Global search' },
    { keys: ['Esc'], description: 'Clear search / Close modal' },
  ]},
  { category: 'Projects', items: [
    { keys: ['⌘', 'N'], description: 'Create new project' },
    { keys: ['⌘', 'K'], description: 'Kanban view' },
    { keys: ['⌘', 'G'], description: 'Grid view' },
    { keys: ['⌘', 'L'], description: 'List view' },
    { keys: ['Shift', 'F'], description: 'Fit columns to screen' },
  ]},
  { category: 'General', items: [
    { keys: ['?'], description: 'Show this help menu' },
  ]},
];

export default function KeyboardShortcutsModal({ open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <kbd className="px-2 py-1 rounded bg-muted text-sm font-medium">?</kbd>
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription>
            Quick reference for all keyboard shortcuts available in the app
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 mt-4 max-h-[60vh] overflow-y-auto">
          {shortcuts.map(group => (
            <div key={group.category}>
              <h3 className="text-sm font-semibold text-foreground mb-3">{group.category}</h3>
              <div className="space-y-2 ml-2">
                {group.items.map((item, idx) => (
                  <div key={idx} className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">{item.description}</span>
                    <div className="flex items-center gap-1.5">
                      {item.keys.map((key, keyIdx) => (
                        <React.Fragment key={keyIdx}>
                          {keyIdx > 0 && <span className="text-xs text-muted-foreground">+</span>}
                          <kbd className="px-2 py-1 rounded border border-border bg-muted text-xs font-medium font-mono">
                            {key}
                          </kbd>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="text-xs text-muted-foreground mt-6 pt-4 border-t">
          💡 Tip: Press <kbd className="px-1.5 py-0.5 rounded bg-muted text-[10px] font-medium">?</kbd> anywhere to show this menu
        </div>
      </DialogContent>
    </Dialog>
  );
}
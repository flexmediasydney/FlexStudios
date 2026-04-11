import React from "react";
import { cn } from "@/lib/utils";
import { X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Floating bulk action bar shown when items are selected.
 *
 * selectedCount: number
 * actions: [{ label, variant?, options?: string[], onAction: (option?) => void }]
 * onClear: () => void
 * loading: boolean
 */
export default function BulkActionBar({ selectedCount = 0, actions = [], onClear, loading = false }) {
  if (selectedCount === 0 || actions.length === 0) return null;

  return (
    <div className="sticky top-0 z-30 flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg mb-3 animate-in fade-in slide-in-from-top-2">
      <span className="text-sm font-medium text-primary tabular-nums">
        {selectedCount} {selectedCount === 1 ? 'item' : 'items'} selected
      </span>

      <div className="h-4 w-px bg-border" />

      {actions.map((action, i) => {
        if (action.options) {
          return (
            <div key={i} className="flex items-center gap-1">
              <span className="text-xs text-muted-foreground mr-1">{action.label}:</span>
              {action.options.map(opt => (
                <Button
                  key={opt}
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={loading}
                  onClick={() => action.onAction(opt)}
                >
                  {opt}
                </Button>
              ))}
            </div>
          );
        }
        return (
          <Button
            key={i}
            variant={action.variant || "outline"}
            size="sm"
            className="h-7 text-xs"
            disabled={loading}
            onClick={() => action.onAction()}
          >
            {action.label}
          </Button>
        );
      })}

      {loading && <Loader2 className="h-4 w-4 animate-spin text-primary" />}

      <div className="flex-1" />

      <Button
        variant="ghost"
        size="sm"
        className="h-7 text-xs text-muted-foreground"
        onClick={onClear}
        title="Clear selection"
      >
        <X className="h-3 w-3 mr-1" /> Clear
      </Button>
    </div>
  );
}

import React, { useState } from "react";
import { cn } from "@/lib/utils";
import { X, ChevronDown, Filter } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

function DropdownFilter({ filter: d }) {
  const [open, setOpen] = useState(false);
  const Icon = d.icon;
  const selectedOption = d.options.find(o => o.value === d.value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn(
          "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border",
          d.value
            ? "bg-primary/10 text-primary border-primary/30"
            : "bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground"
        )}>
          {Icon && <Icon className="h-3 w-3" />}
          <span>{selectedOption ? selectedOption.label : d.label}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1.5 max-h-64 overflow-auto" align="start">
        <button
          onClick={() => { d.onChange(null); setOpen(false); }}
          className={cn(
            "w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors",
            !d.value ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted text-muted-foreground"
          )}
        >
          All
        </button>
        {d.options.map(o => (
          <button
            key={o.value}
            onClick={() => { d.onChange(o.value); setOpen(false); }}
            className={cn(
              "w-full text-left px-2.5 py-1.5 rounded text-xs transition-colors truncate",
              d.value === o.value ? "bg-primary/10 text-primary font-medium" : "hover:bg-muted"
            )}
          >
            {o.label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/**
 * Reusable smart filter bar with quick filter pills and dropdown filters.
 *
 * quickFilters: [{ id, label, icon: LucideIcon, count, color? }]
 * activeFilters: Set of active filter IDs
 * onToggleFilter: (id) => void
 * dropdownFilters: [{ id, label, icon: LucideIcon, options: [{value, label}], value, onChange }]
 * onClearAll: () => void
 */
export default function SmartFilterBar({
  quickFilters = [],
  activeFilters = new Set(),
  onToggleFilter,
  dropdownFilters = [],
  onClearAll,
  totalCount = 0,
  filteredCount = 0,
}) {
  const hasActive = activeFilters.size > 0 || dropdownFilters.some(d => d.value);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        {/* Quick filter pills */}
        {quickFilters.map(f => {
          const isActive = activeFilters.has(f.id);
          const Icon = f.icon;
          return (
            <button
              key={f.id}
              onClick={() => onToggleFilter(f.id)}
              className={cn(
                "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border",
                isActive
                  ? "bg-primary text-primary-foreground border-primary shadow-sm"
                  : "bg-background text-muted-foreground border-border hover:bg-muted hover:text-foreground hover:border-foreground/20"
              )}
            >
              {Icon && <Icon className="h-3 w-3" />}
              <span>{f.label}</span>
              {f.count != null && (
                <span className={cn(
                  "ml-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full text-[10px] font-bold tabular-nums",
                  isActive ? "bg-primary-foreground/20 text-primary-foreground" : "bg-muted text-muted-foreground",
                  f.count === 0 && !isActive && "opacity-50"
                )}>
                  {f.count > 99 ? '99+' : f.count}
                </span>
              )}
            </button>
          );
        })}

        {/* Dropdown filters */}
        {dropdownFilters.map(d => (
          <DropdownFilter key={d.id} filter={d} />
        ))}

        {/* Clear all + count */}
        {hasActive && (
          <>
            <button
              onClick={onClearAll}
              className="inline-flex items-center gap-1 px-2 py-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
            {filteredCount !== totalCount && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {filteredCount} of {totalCount}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

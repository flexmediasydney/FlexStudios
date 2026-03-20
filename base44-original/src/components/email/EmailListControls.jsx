import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuCheckboxItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Link2 } from "lucide-react";
import { cn } from "@/lib/utils";

export default function EmailListControls({
  sortBy,
  onSortChange,
  showAttachments,
  onAttachmentsFilterChange,
  totalCount,
  filteredCount,
  selectedCount,
  onLinkProject,
  onFitToScreen,
  onResetColumns,
}) {
  const sortOptions = [
    { value: 'newest', label: 'Newest first' },
    { value: 'oldest', label: 'Oldest first' },
    { value: 'sender', label: 'Sender (A-Z)' },
    { value: 'subject', label: 'Subject (A-Z)' },
    { value: 'unread', label: 'Unread first' },
  ];

  const currentSortLabel = sortOptions.find(o => o.value === sortBy)?.label || 'Sort';

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/20">
      {/* Sort Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted/60 transition-colors border border-border/40 hover:border-border" title={`Sorted by: ${currentSortLabel}`}>
            Sort: {currentSortLabel}
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          {sortOptions.map(option => (
            <DropdownMenuCheckboxItem
              key={option.value}
              checked={sortBy === option.value}
              onCheckedChange={() => onSortChange(option.value)}
            >
              {option.label}
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Filter Dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-muted/60 transition-colors border border-border/40 hover:border-border">
            Filter
            <ChevronDown className="h-3.5 w-3.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-48">
          <DropdownMenuCheckboxItem
            checked={showAttachments}
            onCheckedChange={onAttachmentsFilterChange}
          >
            Only with attachments
          </DropdownMenuCheckboxItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Column width controls */}
      <div className="flex items-center gap-1">
        {onFitToScreen && (
          <button
            onClick={onFitToScreen}
            className="inline-flex items-center gap-1 px-2 py-1.5 rounded text-[11px] text-muted-foreground hover:bg-muted/60 transition-colors border border-border/30 hover:border-border"
            title="Fit all columns to screen width"
          >
            ⇔ Fit
          </button>
        )}
        {onResetColumns && (
          <button
            onClick={onResetColumns}
            className="inline-flex items-center px-2 py-1.5 rounded text-[11px] text-muted-foreground hover:bg-muted/60 transition-colors"
            title="Reset column widths to defaults"
          >
            ↺
          </button>
        )}
      </div>

      {/* Link Project Button (when emails selected) */}
      {selectedCount > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={onLinkProject}
          className="h-8 px-3 gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/50"
          title={`Link ${selectedCount} email${selectedCount !== 1 ? 's' : ''} to a project`}
        >
          <Link2 className="h-3.5 w-3.5" />
          Link Project
        </Button>
      )}



      {/* Results counter */}
      <div className="ml-auto text-xs text-muted-foreground/70 font-medium" title={`${filteredCount} visible${filteredCount !== totalCount ? ` of ${totalCount} total` : ''}`}>
        {filteredCount === totalCount 
          ? `${totalCount} email${totalCount !== 1 ? 's' : ''}` 
          : `${filteredCount} of ${totalCount}`}
      </div>
    </div>
  );
}
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Paperclip, Users } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const COLUMN_META = {
  checkbox:    { label: null,                               tooltip: null },
  from:        { label: "From",                             tooltip: null },
  subject:     { label: "Subject",                          tooltip: null },
  attachments: { label: <Paperclip className="h-3 w-3" />, tooltip: "Attachments" },
  visibility:  { label: <Users className="h-3 w-3" />,     tooltip: "Visibility (shared / private)" },
  date:        { label: "Date",                             tooltip: "Date received" },
  actions:     { label: "Project",                          tooltip: "Linked project — click to link or change" },
};

export default function EmailListHeader({
  columns,
  allSelected,
  onSelectAll,
  onReorderColumns,
  onResizeColumn,
}) {
  const [draggedId, setDraggedId] = useState(null);
  const [resizingId, setResizingId] = useState(null);

  const totalWidth = columns.reduce((sum, c) => sum + (c.width ?? 0), 0);

  const handleDragStart = (e, colId) => {
    setDraggedId(colId);
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  };

  const handleDrop = (e, targetId) => {
    e.preventDefault();
    if (draggedId && draggedId !== targetId) {
      onReorderColumns?.(draggedId, targetId);
    }
    setDraggedId(null);
  };

  const handleResizeMouseDown = (e, colId, currentWidth) => {
    e.preventDefault();
    e.stopPropagation();
    setResizingId(colId);

    const onMouseMove = (moveEvent) => {
      const delta = moveEvent.clientX - e.clientX;
      onResizeColumn?.(colId, currentWidth + delta);
    };

    const onMouseUp = () => {
      setResizingId(null);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  };

  return (
    <TooltipProvider delayDuration={500}>
      <div
        className="bg-muted/20 border-b flex items-center gap-0 text-[11px] font-semibold text-muted-foreground/60 h-8 select-none"
        style={{ minWidth: `${totalWidth}px`, width: `${totalWidth}px` }}
      >
        {columns.map((col) => {
          const meta = COLUMN_META[col.id] || { label: col.label || col.id, tooltip: null };
          const isIconOnly = col.id === "attachments" || col.id === "visibility";
          const isDraggingThis = draggedId === col.id;

          if (col.id === "checkbox") {
            return (
              <div
                key="checkbox"
                className="flex-shrink-0 flex items-center justify-center"
                style={{ width: `${col.width}px`, minWidth: `${col.width}px` }}
              >
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={onSelectAll}
                  className="h-3.5 w-3.5 cursor-pointer rounded border accent-blue-600"
                  aria-label="Select all emails"
                />
              </div>
            );
          }

          const cellInner = (
            <div
              key={col.id}
              draggable={col.id !== "checkbox"}
              onDragStart={(e) => handleDragStart(e, col.id)}
              onDragOver={handleDragOver}
              onDrop={(e) => handleDrop(e, col.id)}
              onDragEnd={() => setDraggedId(null)}
              style={{ width: `${col.width}px`, minWidth: `${col.width}px` }}
              className={cn(
                "flex-shrink-0 flex items-center px-2 relative group/col transition-colors duration-100",
                "cursor-grab active:cursor-grabbing",
                isIconOnly && "justify-center px-1",
                isDraggingThis && "bg-blue-100 opacity-60"
              )}
            >
              <span className="truncate flex-1 flex items-center gap-1">
                {meta.label}
              </span>

              {/* Resize handle — only for resizable columns */}
              {col.resizable && (
                <div
                  onMouseDown={(e) => handleResizeMouseDown(e, col.id, col.width)}
                  className={cn(
                    "absolute right-0 top-0 h-full w-1.5 cursor-col-resize z-10",
                    "bg-transparent hover:bg-primary/40 transition-colors",
                    resizingId === col.id && "bg-primary/60"
                  )}
                />
              )}
            </div>
          );

          if (meta.tooltip) {
            return (
              <Tooltip key={col.id}>
                <TooltipTrigger asChild>{cellInner}</TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs">
                  {meta.tooltip}
                </TooltipContent>
              </Tooltip>
            );
          }

          return cellInner;
        })}
      </div>
    </TooltipProvider>
  );
}
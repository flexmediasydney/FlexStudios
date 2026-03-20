import React from 'react';
import { GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';

export default function ColumnHeaderCell({
  column,
  onDragStart,
  onDragOver,
  onDrop,
  onResizeStart,
  isDragging
}) {
  return (
    <div
      draggable={column.resizable || column.id !== 'checkbox'}
      onDragStart={(e) => onDragStart(e, column.id)}
      onDragOver={onDragOver}
      onDrop={(e) => onDrop(e, column.id)}
      style={{ width: `${column.width}px` }}
      className={cn(
        'flex items-center gap-1.5 px-2 py-2 flex-shrink-0 relative group cursor-grab active:cursor-grabbing transition-all select-none',
        isDragging && 'bg-blue-100 shadow-lg scale-105'
      )}
    >
      <GripVertical className="h-3.5 w-3.5 text-muted-foreground/60 opacity-0 group-hover:opacity-100 transition-opacity" />
      <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider truncate flex-1">
        {column.label}
      </span>

      {column.resizable && (
        <div
          onMouseDown={(e) => onResizeStart(e, column.id)}
          className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent hover:bg-primary/40 active:bg-primary transition-colors"
          title="Drag to resize column"
        />
      )}
    </div>
  );
}
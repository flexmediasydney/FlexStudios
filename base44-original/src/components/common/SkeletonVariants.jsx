import React from 'react';
import { Skeleton } from '@/components/ui/skeleton';

export function CardSkeleton({ count = 3 }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array(count).fill(0).map((_, i) => (
        <div key={i} className="rounded-lg border bg-card p-4 space-y-3">
          <Skeleton className="h-5 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <div className="space-y-2">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-4/5" />
          </div>
          <div className="flex gap-2 pt-2">
            <Skeleton className="h-6 w-12" />
            <Skeleton className="h-6 w-12" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function TableRowSkeleton({ rows = 5 }) {
  return (
    <div className="space-y-2">
      {Array(rows).fill(0).map((_, i) => (
        <div key={i} className="flex gap-4 p-3 rounded-lg border bg-muted/30">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-20 ml-auto" />
        </div>
      ))}
    </div>
  );
}

export function ListItemSkeleton({ items = 4 }) {
  return (
    <div className="space-y-2">
      {Array(items).fill(0).map((_, i) => (
        <div key={i} className="flex items-center gap-3 p-3 rounded-lg border">
          <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-24" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function KanbanColumnSkeleton({ columns = 4 }) {
  return (
    <div className="flex gap-4 overflow-x-auto pb-4">
      {Array(columns).fill(0).map((_, colIdx) => (
        <div key={colIdx} className="flex-shrink-0 w-80 space-y-2">
          <Skeleton className="h-10 w-full rounded-t-lg" />
          <div className="space-y-2 p-2 min-h-[400px]">
            {Array(3).fill(0).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full rounded-lg" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
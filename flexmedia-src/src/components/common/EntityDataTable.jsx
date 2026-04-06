import React, { useState, useMemo, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function EntityDataTable({
  columns,      // [{ key, label, render, sortable, width, align, noClick, sortValue }]
  data = [],
  onRowClick,
  loading = false,
  pageSize = 75,
  emptyMessage = "No records found",
}) {
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  // Reset page when data changes (search/filter applied)
  useEffect(() => setPage(0), [data]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find(c => c.key === sortKey);
    return [...data].sort((a, b) => {
      const av = col?.sortValue ? col.sortValue(a) : (a[sortKey] ?? '');
      const bv = col?.sortValue ? col.sortValue(b) : (b[sortKey] ?? '');
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, columns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safeCurrentPage = Math.min(page, totalPages - 1);
  const startIdx = safeCurrentPage * pageSize;
  const paginated = sorted.slice(startIdx, startIdx + pageSize);

  if (loading) {
    return (
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              {columns.map(col => (
                <th key={col.key} className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground" style={col.width ? { width: col.width } : undefined}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 8 }).map((_, i) => (
              <tr key={i} className="border-b">
                {columns.map(col => (
                  <td key={col.key} className="px-3 py-2.5">
                    <div className="h-4 rounded bg-muted animate-pulse" style={{ width: `${40 + Math.random() * 40}%` }} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="border rounded-lg overflow-hidden">
        <div className="overflow-x-auto max-h-[calc(100vh-240px)] overflow-y-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="border-b bg-muted/40 bg-card">
                {columns.map(col => (
                  <th
                    key={col.key}
                    className={cn(
                      "px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground tracking-wide whitespace-nowrap",
                      col.sortable && "cursor-pointer hover:bg-muted/70 hover:text-foreground transition-colors select-none",
                      col.align === 'right' && "text-right",
                      col.align === 'center' && "text-center",
                    )}
                    style={col.width ? { width: col.width } : undefined}
                    onClick={() => col.sortable && handleSort(col.key)}
                  >
                    {col.sortable ? (
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {sortKey === col.key
                          ? (sortDir === 'asc' ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />)
                          : <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-30" />}
                      </span>
                    ) : col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={columns.length} className="py-16 text-center text-sm text-muted-foreground">
                    {emptyMessage}
                  </td>
                </tr>
              ) : paginated.map((row, localIdx) => (
                <tr
                  key={row.id || localIdx}
                  className={cn(
                    "border-b last:border-0 group transition-colors hover:bg-muted/20",
                    onRowClick && "cursor-pointer"
                  )}
                  onClick={() => onRowClick?.(row)}
                >
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-2 align-middle",
                        col.align === 'right' && "text-right",
                        col.align === 'center' && "text-center",
                      )}
                      onClick={col.noClick ? e => e.stopPropagation() : undefined}
                    >
                      {col.render
                        ? col.render(row, startIdx + localIdx)
                        : <span className="text-xs text-muted-foreground">{row[col.key] ?? '—'}</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-1 pt-2 text-xs text-muted-foreground">
        <span>
          {sorted.length === 0
            ? '0 records'
            : `${startIdx + 1}–${Math.min(startIdx + pageSize, sorted.length)} of ${sorted.length}`}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7 text-xs" onClick={() => setPage(0)} disabled={safeCurrentPage === 0}>‹‹</Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safeCurrentPage === 0}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="px-2 tabular-nums">{safeCurrentPage + 1} / {totalPages}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safeCurrentPage >= totalPages - 1}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7 text-xs" onClick={() => setPage(totalPages - 1)} disabled={safeCurrentPage >= totalPages - 1}>››</Button>
          </div>
        )}
      </div>
    </div>
  );
}
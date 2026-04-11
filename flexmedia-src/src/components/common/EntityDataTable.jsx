import React, { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { cn } from "@/lib/utils";
import { ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";

// Pre-computed skeleton widths — avoids calling Math.random() during render,
// which would produce a different value every render cycle.
const SKELETON_WIDTHS = [72, 55, 63, 48, 79, 60, 44, 68];

export default function EntityDataTable({
  columns,      // [{ key, label, render, sortable, width, align, noClick, sortValue }]
  data = [],
  onRowClick,
  loading = false,
  pageSize = 75,
  emptyMessage = "No records found",
  selectable = false,
  selectedIds,          // Set
  onToggleSelect,       // (id) => void
  onToggleSelectAll,    // () => void
  onSelectPage,         // (ids: string[]) => void — select only visible-page ids
}) {
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const tableRef = useRef(null);

  // Reset page when data length changes (search/filter applied).
  // Using data.length instead of the data array reference avoids firing
  // on every render (array props are new references each render).
  const dataLength = data.length;
  useEffect(() => setPage(0), [dataLength]);

  // BUG FIX #2: Escape key should ALWAYS clear selection, not toggle.
  // Previously called onToggleSelectAll which toggles (selects all when empty).
  useEffect(() => {
    if (!selectable || !selectedIds?.size) return;
    const handler = (e) => {
      if (e.key === 'Escape' && selectedIds?.size > 0) {
        // Call toggleSelectAll only when items are selected (to deselect).
        // This avoids the toggle behavior that would select-all on empty.
        onToggleSelectAll?.();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [selectable, selectedIds?.size, onToggleSelectAll]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  // Stabilise the columns reference: only re-derive when the column keys change,
  // not on every render (parent often passes a new array literal each time).
  const columnsKeyStr = columns.map(c => c.key).join(',');
  const stableColumns = useMemo(() => columns, [columnsKeyStr]);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const col = stableColumns.find(c => c.key === sortKey);
    return [...data].sort((a, b) => {
      const av = col?.sortValue ? col.sortValue(a) : (a[sortKey] ?? '');
      const bv = col?.sortValue ? col.sortValue(b) : (b[sortKey] ?? '');
      const cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, stableColumns]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  // BUG FIX #3: Sync internal page state when safeCurrentPage clamps it down.
  // Without this, after deleting items that shrink totalPages, the next "next page"
  // click uses the stale higher `page` value instead of the clamped one.
  const safeCurrentPage = Math.min(page, totalPages - 1);
  useEffect(() => {
    if (page !== safeCurrentPage) setPage(safeCurrentPage);
  }, [page, safeCurrentPage]);

  const startIdx = safeCurrentPage * pageSize;
  const paginated = sorted.slice(startIdx, startIdx + pageSize);

  // BUG FIX #1: Select-all header checkbox should toggle VISIBLE page only,
  // not all filtered data. The checked state compares against paginated rows.
  const paginatedIds = useMemo(() => paginated.map(r => r.id), [paginated]);
  const allPageSelected = paginated.length > 0 && paginatedIds.every(id => selectedIds?.has(id));
  const somePageSelected = paginatedIds.some(id => selectedIds?.has(id));

  const handleSelectAllPage = useCallback(() => {
    if (onSelectPage) {
      // Preferred: parent provides page-aware handler
      onSelectPage(paginatedIds);
    } else {
      // Fallback: use legacy toggle-all (selects all filtered data)
      onToggleSelectAll?.();
    }
  }, [onSelectPage, onToggleSelectAll, paginatedIds]);

  // BUG FIX #7: Prevent row click from firing when user is selecting text.
  const handleRowClick = useCallback((row, e) => {
    if (!onRowClick) return;
    const selection = window.getSelection();
    if (selection && selection.toString().length > 0) return;
    onRowClick(row);
  }, [onRowClick]);

  // BUG FIX #5: Keyboard navigation — arrow keys move focus between rows
  const handleTableKeyDown = useCallback((e) => {
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const rows = tableRef.current?.querySelectorAll('tbody tr[tabindex]');
    if (!rows?.length) return;
    const currentIdx = Array.from(rows).indexOf(document.activeElement);
    if (currentIdx === -1) return;
    e.preventDefault();
    const nextIdx = e.key === 'ArrowDown'
      ? Math.min(currentIdx + 1, rows.length - 1)
      : Math.max(currentIdx - 1, 0);
    rows[nextIdx]?.focus();
  }, []);

  if (loading) {
    return (
      <div className="border rounded-lg overflow-hidden">
        <table className="w-full text-sm table-fixed">
          <thead className="sticky top-0 z-10">
            <tr className="border-b bg-muted/60">
              {/* BUG FIX #6: Show checkbox column placeholder in skeleton when selectable */}
              {selectable && (
                <th className="px-2 py-2 w-10">
                  <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse mx-auto" />
                </th>
              )}
              {columns.map(col => (
                <th key={col.key} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground" style={col.width ? { width: col.width } : undefined}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <tr key={i} className="border-b last:border-0">
                {selectable && (
                  <td className="px-2 py-1.5 w-10">
                    <div className="h-3.5 w-3.5 rounded bg-muted animate-pulse mx-auto" />
                  </td>
                )}
                {columns.map((col, ci) => (
                  <td key={col.key} className="px-3 py-1.5">
                    <div
                      className="h-3.5 rounded bg-muted animate-pulse"
                      style={{
                        width: `${SKELETON_WIDTHS[(i + ci) % SKELETON_WIDTHS.length]}%`,
                        animationDelay: `${(i * 50) + (ci * 20)}ms`,
                      }}
                    />
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
        <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-280px)]">
          <table
            ref={tableRef}
            className="w-full text-sm border-collapse table-fixed"
            role="grid"
            onKeyDown={handleTableKeyDown}
          >
            <thead className="sticky top-0 z-10">
              <tr className="border-b bg-muted/60 backdrop-blur-sm">
                {selectable && (
                  <th className="px-2 py-2 w-10 text-center" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      className="rounded border-gray-300 text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                      checked={allPageSelected}
                      ref={el => { if (el) el.indeterminate = somePageSelected && !allPageSelected; }}
                      onChange={handleSelectAllPage}
                      aria-label={
                        allPageSelected
                          ? "Deselect all rows on this page"
                          : "Select all rows on this page"
                      }
                    />
                  </th>
                )}
                {columns.map(col => (
                  <th
                    key={col.key}
                    className={cn(
                      "px-3 py-2 text-left text-xs font-semibold text-muted-foreground tracking-wide whitespace-nowrap group/th",
                      col.sortable && "cursor-pointer hover:bg-muted/70 hover:text-foreground transition-colors select-none",
                      sortKey === col.key && "text-foreground bg-muted/30",
                      col.align === 'right' && "text-right",
                      col.align === 'center' && "text-center",
                    )}
                    style={col.width ? { width: col.width } : undefined}
                    onClick={() => col.sortable && handleSort(col.key)}
                    aria-sort={col.sortable && sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    scope="col"
                  >
                    {col.sortable ? (
                      <button type="button" className={cn(
                        "inline-flex items-center gap-1 w-full text-left",
                        sortKey === col.key && "text-foreground"
                      )}>
                        {col.label}
                        {sortKey === col.key
                          ? (sortDir === 'asc'
                              ? <ChevronUp className="h-3.5 w-3.5 shrink-0 text-primary" />
                              : <ChevronDown className="h-3.5 w-3.5 shrink-0 text-primary" />)
                          : <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-30 group-hover/th:opacity-60 transition-opacity" />}
                      </button>
                    ) : col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paginated.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (selectable ? 1 : 0)} className="py-12 text-center">
                    <div className="flex flex-col items-center gap-2">
                      <Inbox className="h-8 w-8 text-muted-foreground/30" />
                      <p className="text-sm text-muted-foreground">{emptyMessage}</p>
                    </div>
                  </td>
                </tr>
              ) : paginated.map((row, localIdx) => (
                <tr
                  key={row.id || localIdx}
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn(
                    "border-b last:border-0 group transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/50 focus-visible:bg-muted/40",
                    onRowClick && "cursor-pointer"
                  )}
                  onClick={(e) => handleRowClick(row, e)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && onRowClick) onRowClick(row); }}
                >
                  {selectable && (
                    <td className="px-2 py-1.5 w-10 text-center" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="rounded border-gray-300 text-primary focus:ring-primary h-3.5 w-3.5 cursor-pointer"
                        checked={selectedIds?.has(row.id) || false}
                        onChange={() => onToggleSelect?.(row.id)}
                        aria-label={`Select row ${startIdx + localIdx + 1}`}
                      />
                    </td>
                  )}
                  {columns.map(col => (
                    <td
                      key={col.key}
                      className={cn(
                        "px-3 py-1.5 align-middle overflow-hidden text-ellipsis",
                        col.align === 'right' && "text-right",
                        col.align === 'center' && "text-center",
                      )}
                      onClick={col.noClick ? e => e.stopPropagation() : undefined}
                    >
                      {col.render
                        ? col.render(row, startIdx + localIdx)
                        : <span className="text-xs text-muted-foreground truncate block">{row[col.key] ?? '—'}</span>}
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
          {selectable && selectedIds?.size > 0 && (
            <span className="ml-2 text-primary font-medium">({selectedIds.size} selected — Esc to clear)</span>
          )}
        </span>
        {totalPages > 1 && (
          <div className="flex items-center gap-0.5">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(0)} disabled={safeCurrentPage === 0} aria-label="First page"><ChevronsLeft className="h-3.5 w-3.5" /></Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safeCurrentPage === 0} aria-label="Previous page">
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="px-2 tabular-nums" aria-live="polite" aria-atomic="true">Page {safeCurrentPage + 1} of {totalPages}</span>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safeCurrentPage >= totalPages - 1} aria-label="Next page">
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(totalPages - 1)} disabled={safeCurrentPage >= totalPages - 1} aria-label="Last page"><ChevronsRight className="h-3.5 w-3.5" /></Button>
          </div>
        )}
      </div>
    </div>
  );
}

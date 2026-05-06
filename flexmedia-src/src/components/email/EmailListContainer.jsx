import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import EmailListHeader from "./EmailListHeader";
import EmailListRow from "./EmailListRow";
import EmailListEmpty from "./EmailListEmpty";

export default function EmailListContainer({
  filteredThreads,
  columns,
  selectedMessages,
  onSelectThread,
  onSelectAll,
  onOpenThread,
  messagesLoading,
  filterUnread,
  searchQuery,
  filterView,
  onCompose,
  labelData,
  emailAccounts = [],
  showAccount = false,
  onLinkProject,
  onUnlinkProject,
  onToggleVisibility,
  onContextMenu,
  onReorderColumns,
  onResizeColumn,
  // Pagination props (replaces onLoadMore / hasMore / loadingMore / totalAvailable)
  page = 1,
  pageSize = 50,
  totalPages = 1,
  totalThreadCount = null,
  onPrevPage,
  onNextPage,
  onPageSizeChange,
  allowedPageSizes = [25, 50, 100, 200],
  // Colored legend of accounts on the current page:
  // [{ accountId, label: 'David', color: '#3b82f6', count: 7 }, ...]
  pageAccountBreakdown = [],
}) {
  const allSelected =
    selectedMessages.size === filteredThreads.length && filteredThreads.length > 0;

  const parentRef = useRef(null);

  const rowVirtualizer = useVirtualizer({
    count: filteredThreads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 37, // 36px row height + 1px border
    overscan: 10,
  });

  // Reset scroll position when the user switches folders/views, changes search,
  // or changes page. New page should start at the top, not wherever the previous
  // page's scroll position was.
  useEffect(() => {
    if (parentRef.current) {
      parentRef.current.scrollTop = 0;
    }
  }, [filterView, searchQuery, filterUnread, page, pageSize]);

  if (messagesLoading) {
    return (
      <div className="divide-y">
        {[...Array(20)].map((_, i) => (
          <div key={i} className="h-[36px] flex items-center px-3 gap-3 animate-pulse">
            <div className="h-3.5 w-3.5 bg-muted rounded flex-shrink-0" />
            <div className="h-3 w-32 bg-muted rounded flex-shrink-0" />
            <div className="h-4 w-16 bg-muted rounded-sm flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="h-3 bg-muted rounded w-4/5" />
            </div>
            <div className="h-5 w-28 bg-muted rounded-full flex-shrink-0" />
            <div className="h-5 w-5 bg-muted rounded-full flex-shrink-0" />
            <div className="h-6 w-6 bg-muted rounded-full flex-shrink-0" />
            <div className="h-3 w-12 bg-muted rounded flex-shrink-0" />
          </div>
        ))}
      </div>
    );
  }

  if (filteredThreads.length === 0) {
    return (
      <EmailListEmpty
        filterUnread={filterUnread}
        searchQuery={searchQuery}
        filterView={filterView}
        onCompose={onCompose}
      />
    );
  }

  // Range labels for the footer. "Showing X–Y of Z" now lives in the top-right
  // of the inbox header (see EmailInboxMain), so the bottom bar shows the
  // per-account color legend instead of the duplicate range.
  const total = totalThreadCount ?? filteredThreads.length;

  // Collapse the legend to 5 visible entries; the rest go into a popover
  // triggered by "+N more". Keeps the bar tidy when many accounts overlap.
  const MAX_VISIBLE_ACCOUNTS = 5;
  const visibleAccounts = pageAccountBreakdown.slice(0, MAX_VISIBLE_ACCOUNTS);
  const hiddenAccounts = pageAccountBreakdown.slice(MAX_VISIBLE_ACCOUNTS);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sticky header */}
      <div className="overflow-x-auto flex-shrink-0 border-b">
        <EmailListHeader
          columns={columns}
          allSelected={allSelected}
          onSelectAll={() => {
            if (allSelected) {
              onSelectAll(new Set());
            } else {
              onSelectAll(new Set(filteredThreads.map((t) => t.threadId)));
            }
          }}
          onReorderColumns={onReorderColumns}
          onResizeColumn={onResizeColumn}
        />
      </div>

      {/* Virtualized scroll body */}
      <div
        ref={parentRef}
        className="flex-1 overflow-y-auto overflow-x-auto min-h-0"
        role="list"
      >
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const thread = filteredThreads[virtualRow.index];
            return (
              <div
                key={thread.threadId}
                data-index={virtualRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <EmailListRow
                  thread={thread}
                  columns={columns}
                  isSelected={selectedMessages.has(thread.threadId)}
                  onSelect={onSelectThread}
                  onOpen={onOpenThread}
                  labelData={labelData}
                  emailAccounts={emailAccounts}
                  showAccount={showAccount}
                  onLinkProject={onLinkProject}
                  onUnlinkProject={onUnlinkProject}
                  onToggleVisibility={onToggleVisibility}
                  onContextMenu={onContextMenu}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Pagination bar
          Left:   per-account color legend for the CURRENT PAGE (dots match
                  the row stripe color), e.g. "● David 7 · ● Janet 10 · …"
          Center: prev / Page N of M / next
          Right:  per-page selector
          Top-right of header has the absolute range ("Showing X–Y of Z").    */}
      <div
        data-testid="inbox-pagination-bar"
        className="flex-shrink-0 flex items-center justify-between gap-4 px-4 py-1.5 border-t bg-muted/10 text-[12px] text-muted-foreground"
      >
        {/* Legend — only meaningful in "All Inboxes" view (i.e. when the
            parent passes a non-empty breakdown). Falls back to an empty flex
            cell so the center/right columns stay aligned. */}
        <div
          className="flex items-center gap-x-3 gap-y-1 flex-wrap tabular-nums text-[11px]"
          data-testid="inbox-page-legend"
        >
          {visibleAccounts.length === 0 ? (
            <span className="opacity-50">
              {total > 0 ? `${total.toLocaleString()} conversation${total !== 1 ? 's' : ''}` : ''}
            </span>
          ) : (
            <>
              {visibleAccounts.map((a) => (
                <span
                  key={a.accountId}
                  className="inline-flex items-center gap-1.5"
                  title={`${a.label} — ${a.count} on this page`}
                >
                  <span
                    className="h-2 w-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: a.color }}
                    aria-hidden="true"
                  />
                  <span className="text-foreground/75">{a.label}</span>
                  <span className="opacity-70">{a.count}</span>
                </span>
              ))}
              {hiddenAccounts.length > 0 && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      className="text-[11px] text-muted-foreground/80 hover:text-foreground underline-offset-2 hover:underline focus:outline-none focus:ring-1 focus:ring-primary rounded px-0.5"
                      aria-label={`Show ${hiddenAccounts.length} more inbox${hiddenAccounts.length !== 1 ? 'es' : ''}`}
                    >
                      +{hiddenAccounts.length} more
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-2 space-y-1" side="top" align="start">
                    {hiddenAccounts.map((a) => (
                      <div
                        key={a.accountId}
                        className="flex items-center gap-2 text-[11px] tabular-nums"
                      >
                        <span
                          className="h-2 w-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: a.color }}
                          aria-hidden="true"
                        />
                        <span className="text-foreground/80">{a.label}</span>
                        <span className="opacity-70 ml-auto">{a.count}</span>
                      </div>
                    ))}
                  </PopoverContent>
                </Popover>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onPrevPage}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="px-2 tabular-nums" aria-live="polite" aria-atomic="true">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onNextPage}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground/70">Per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange?.(v)}
          >
            <SelectTrigger className="h-7 w-[68px] text-xs px-2">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {allowedPageSizes.map((n) => (
                <SelectItem key={n} value={String(n)} className="text-xs">
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>
  );
}

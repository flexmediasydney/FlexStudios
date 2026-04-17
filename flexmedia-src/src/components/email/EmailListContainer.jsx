import { useRef, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
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
}) {
  const allSelected =
    selectedMessages.size === filteredThreads.length && filteredThreads.length > 0;

  const parentRef = useRef(null);

  const rowVirtualizer = useVirtualizer({
    count: filteredThreads.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 53, // 52px row height + 1px border
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
        {[...Array(12)].map((_, i) => (
          <div key={i} className="h-[52px] flex items-center px-3 gap-3 animate-pulse">
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

  // Range labels for the footer: "1-50 of 2,248"
  const total = totalThreadCount ?? filteredThreads.length;
  const startIdx = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const endIdx = Math.min(page * pageSize, total);

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
                  onToggleVisibility={onToggleVisibility}
                  onContextMenu={onContextMenu}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Pagination bar — left: "Showing X-Y of Z"; center: prev/page/next; right: page size */}
      <div className="flex-shrink-0 flex items-center justify-between gap-4 px-4 py-1.5 border-t bg-muted/10 text-[12px] text-muted-foreground">
        <span className="tabular-nums">
          {total > 0 ? (
            <>
              Showing {startIdx.toLocaleString()}-{endIdx.toLocaleString()} of {total.toLocaleString()} conversation{total !== 1 ? 's' : ''}
            </>
          ) : (
            '0 conversations'
          )}
        </span>

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

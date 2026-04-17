import { useRef, useCallback, useEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2 } from "lucide-react";
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
  onLoadMore,
  hasMore = false,
  loadingMore = false,
  totalAvailable = null,
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

  // Reset scroll position when the user actively switches folders/views or changes search.
  // CRITICAL: do NOT include filteredThreads.length here — loadMore() appending threads
  // would reset scroll to top, hiding the sentinel and breaking the intersection observer
  // (user would see only the first page of 50 threads forever).
  useEffect(() => {
    if (parentRef.current) {
      parentRef.current.scrollTop = 0;
    }
  }, [filterView, searchQuery, filterUnread]);

  // Intersection observer: trigger loadMore when user scrolls near the bottom
  const loadMoreRef = useRef(null);
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    const el = loadMoreRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loadingMore) {
          onLoadMore();
        }
      },
      { root: parentRef.current, rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [onLoadMore, hasMore, loadingMore]);

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

        {/* Load-more sentinel — triggers intersection observer */}
        {hasMore && (
          <div ref={loadMoreRef} className="flex items-center justify-center py-3">
            {loadingMore ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading more...
              </div>
            ) : (
              <div className="h-1" />
            )}
          </div>
        )}
      </div>

      {/* Count footer — shows "Showing X of Y" so pagination regressions are instantly visible */}
      {filteredThreads.length > 0 && (
        <div className="flex-shrink-0 px-4 py-1 border-t bg-muted/10 text-[11px] text-muted-foreground/50 text-right">
          {totalAvailable != null && totalAvailable > filteredThreads.length ? (
            <>
              Showing {filteredThreads.length.toLocaleString()} of {totalAvailable.toLocaleString()} conversation{totalAvailable !== 1 ? "s" : ""}
              {hasMore && <span className="ml-1 opacity-70">(scroll to load more)</span>}
            </>
          ) : (
            <>
              {filteredThreads.length.toLocaleString()} conversation{filteredThreads.length !== 1 ? "s" : ""}
            </>
          )}
        </div>
      )}
    </div>
  );
}

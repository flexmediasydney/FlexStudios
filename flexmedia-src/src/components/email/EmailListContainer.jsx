import { useState, useRef } from "react";
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
  onLinkProject,
  onToggleVisibility,
  onToggleStar,
  onContextMenu,
  onReorderColumns,
  onResizeColumn,
}) {
  const allSelected =
    selectedMessages.size === filteredThreads.length && filteredThreads.length > 0;

  if (messagesLoading) {
    return (
      <div className="divide-y">
        {[...Array(12)].map((_, i) => (
          <div key={i} className="h-[52px] flex items-center px-3 gap-3 animate-pulse">
            <div className="h-3.5 w-3.5 bg-muted rounded flex-shrink-0" />
            <div className="h-3.5 w-3.5 bg-muted rounded flex-shrink-0" />
            <div className="h-3 w-32 bg-muted rounded flex-shrink-0" />
            <div className="flex-1 space-y-1.5">
              <div className="h-3 bg-muted rounded w-4/5" />
              <div className="h-2.5 bg-muted/60 rounded w-3/5" />
            </div>
            <div className="h-3 w-14 bg-muted rounded flex-shrink-0" />
            <div className="h-7 w-16 bg-muted rounded-full flex-shrink-0" />
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

      {/* Scroll body */}
      <div
        className="flex-1 overflow-y-auto overflow-x-auto min-h-0 divide-y"
        role="list"
      >
        {filteredThreads.map((thread) => (
          <EmailListRow
            key={thread.threadId}
            thread={thread}
            columns={columns}
            isSelected={selectedMessages.has(thread.threadId)}
            onSelect={onSelectThread}
            onOpen={onOpenThread}
            labelData={labelData}
            onLinkProject={onLinkProject}
            onToggleVisibility={onToggleVisibility}
            onToggleStar={onToggleStar}
            onContextMenu={onContextMenu}
          />
        ))}
      </div>

      {/* Count footer */}
      {filteredThreads.length > 0 && (
        <div className="flex-shrink-0 px-4 py-1 border-t bg-muted/10 text-[11px] text-muted-foreground/50 text-right">
          {filteredThreads.length.toLocaleString()} conversation{filteredThreads.length !== 1 ? "s" : ""}
        </div>
      )}
    </div>
  );
}
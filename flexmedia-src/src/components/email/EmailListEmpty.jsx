import { Button } from "@/components/ui/button";
import { Plus, Inbox, Search, CheckCircle2, Archive, Trash2, Send, FileEdit } from "lucide-react";

const EMPTY_STATES = {
  inbox: {
    icon: Inbox,
    heading: "Your inbox is empty",
    description: "New emails will appear here. Compose a message to get started.",
    showCompose: true,
  },
  sent: {
    icon: Send,
    heading: "No sent emails",
    description: "Emails you send will appear here.",
    showCompose: true,
  },
  draft: {
    icon: FileEdit,
    heading: "No drafts",
    description: "Saved drafts will appear here.",
    showCompose: true,
  },
  archived: {
    icon: Archive,
    heading: "No archived emails",
    description: "Emails you archive will be stored here.",
    showCompose: false,
  },
  deleted: {
    icon: Trash2,
    heading: "Trash is empty",
    description: "Deleted emails will appear here for 30 days.",
    showCompose: false,
  },
};

export default function EmailListEmpty({
  filterUnread,
  searchQuery,
  filterView,
  onCompose
}) {
  // Search state
  if (searchQuery) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-sm px-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-muted/60 flex items-center justify-center">
            <Search className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">No results found</h3>
          <p className="text-xs text-muted-foreground leading-relaxed">
            No emails match <span className="font-medium text-foreground/80">"{searchQuery}"</span>
          </p>
          <p className="text-[11px] text-muted-foreground/60">
            Try different keywords, or use operators like <kbd className="px-1 py-0.5 bg-muted rounded font-mono text-[10px]">from:</kbd> <kbd className="px-1 py-0.5 bg-muted rounded font-mono text-[10px]">has:attachment</kbd>
          </p>
        </div>
      </div>
    );
  }

  // Unread filter state
  if (filterUnread) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center space-y-3 max-w-sm px-4">
          <div className="mx-auto w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
          </div>
          <h3 className="text-sm font-semibold text-foreground">All caught up</h3>
          <p className="text-xs text-muted-foreground">No unread emails in this view.</p>
        </div>
      </div>
    );
  }

  // Folder-specific empty state
  const state = EMPTY_STATES[filterView] || EMPTY_STATES.inbox;
  const Icon = state.icon;

  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-3 max-w-sm px-4">
        <div className="mx-auto w-12 h-12 rounded-full bg-muted/60 flex items-center justify-center">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <h3 className="text-sm font-semibold text-foreground">{state.heading}</h3>
        <p className="text-xs text-muted-foreground">{state.description}</p>
        {state.showCompose && onCompose && (
          <Button onClick={onCompose} variant="outline" size="sm" className="mt-2 gap-1.5 h-8 text-xs" title="Compose new email">
            <Plus className="h-3.5 w-3.5" />
            Compose
          </Button>
        )}
      </div>
    </div>
  );
}
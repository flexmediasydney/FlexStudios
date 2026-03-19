import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default function EmailListEmpty({ 
  filterUnread, 
  searchQuery, 
  filterView,
  onCompose 
}) {
  return (
    <div className="flex items-center justify-center h-full">
      <div className="text-center space-y-4">
        <div className="text-6xl mb-2">📭</div>
        <h3 className="text-base font-semibold text-foreground">
          {filterUnread ? "All caught up!" : 
           searchQuery ? "No results found" : 
           "No emails here"}
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          {filterUnread ? "You have no unread emails in this view." : 
           searchQuery ? `No emails match "${searchQuery}"` :
           filterView === "inbox" ? "Your inbox is empty. Compose a new email to get started." :
           `No ${filterView} emails found.`}
        </p>
        {filterView === "inbox" && !searchQuery && (
          <Button onClick={onCompose} className="mt-4 gap-2 h-9">
            <Plus className="h-4 w-4" />
            Compose Email
          </Button>
        )}
      </div>
    </div>
  );
}
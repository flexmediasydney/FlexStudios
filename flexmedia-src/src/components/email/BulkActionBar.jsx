import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Eye,
  Archive,
  Trash2,
  RefreshCw,
  Lock,
  Users,
  ChevronDown,
  Tag,
  X,
} from "lucide-react";
import { base44 } from "@/api/base44Client";
import { toast } from "sonner";
import LabelSelectorRobust from "./LabelSelectorRobust";
import { getAccountIdsFromThreads } from "./threadUtils";

export default function BulkActionBar({
  selectedCount,
  filteredCount,
  filterView,
  threads,
  selectedMessages,
  emailAccounts,
  user,
  onRefetch,
  setSelectedMessages,
}) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [labelPopoverOpen, setLabelPopoverOpen] = useState(false);

  const getAccountIds = () => getAccountIdsFromThreads(selectedMessages, threads);

  const handleMarkAsRead = async (allVisible = false) => {
    setIsProcessing(true);
    try {
      const threadIds = allVisible
        ? threads.map(t => t.threadId)
        : Array.from(selectedMessages);
      const count = threadIds.length;
      // When marking all visible, derive account IDs from the visible threads (not just selected)
      const accountIds = allVisible
        ? Array.from(new Set(threads.map(t => t.email_account_id).filter(Boolean)))
        : getAccountIds();

      const results = await Promise.allSettled(accountIds.map(accId =>
        base44.functions.invoke('markEmailsAsRead', {
          threadIds,
          emailAccountId: accId
        })
      ));
      const failures = results.filter(r => r.status === 'rejected').length;
      if (failures > 0) {
        toast.warning(`Marked as read with ${failures} account error${failures !== 1 ? 's' : ''}`);
      } else {
        toast.success(`Marked ${count} email${count !== 1 ? 's' : ''} as read`);
      }
      setSelectedMessages(new Set());
      onRefetch();
    } catch {
      toast.error("Failed to mark as read");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleVisibility = async (visibility) => {
    setIsProcessing(true);
    try {
      const accountIds = getAccountIds();
      const results = await Promise.allSettled(accountIds.map(accId =>
        base44.functions.invoke('setEmailVisibility', {
          threadIds: Array.from(selectedMessages),
          emailAccountId: accId,
          visibility
        })
      ));
      const failures = results.filter(r => r.status === 'rejected').length;
      if (failures > 0) {
        toast.warning(`Changed visibility with ${failures} error${failures !== 1 ? 's' : ''}`);
      } else {
        toast.success(`Changed to ${visibility}`);
      }
      setSelectedMessages(new Set());
      onRefetch();
    } catch {
      toast.error("Failed to change visibility");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleArchive = async () => {
    setIsProcessing(true);
    try {
      const accountIds = getAccountIds();
      const results = await Promise.allSettled(accountIds.map(accId =>
        base44.functions.invoke('archiveEmails', {
          threadIds: Array.from(selectedMessages),
          emailAccountId: accId
        })
      ));
      const failures = results.filter(r => r.status === 'rejected').length;
      if (failures > 0) {
        toast.warning(`Archived with ${failures} account error${failures !== 1 ? 's' : ''}`);
      } else {
        toast.success("Archived");
      }
      setSelectedMessages(new Set());
      onRefetch();
    } catch {
      toast.error("Failed to archive");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRestore = async () => {
    setIsProcessing(true);
    try {
      const accountIds = getAccountIds();
      const results = await Promise.allSettled(accountIds.map(accId =>
        base44.functions.invoke('restoreEmails', {
          threadIds: Array.from(selectedMessages),
          emailAccountId: accId
        })
      ));
      const failures = results.filter(r => r.status === 'rejected').length;
      if (failures > 0) {
        toast.warning(`Restored with ${failures} account error${failures !== 1 ? 's' : ''}`);
      } else {
        toast.success("Restored to inbox");
      }
      setSelectedMessages(new Set());
      onRefetch();
    } catch {
      toast.error("Failed to restore");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 bg-blue-50 border border-blue-200 p-3 rounded-lg shadow-sm animate-in slide-in-from-top-1 duration-200">
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1.5 bg-blue-100 px-2.5 py-1 rounded-full">
          <span className="text-xs font-bold text-blue-800">{selectedCount}</span>
          <span className="text-xs text-blue-600">selected</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const allThreadIds = new Set(threads.map(t => t.threadId));
            setSelectedMessages(allThreadIds);
          }}
          className="h-6 px-2 text-[10px] text-blue-600 hover:text-blue-800 hover:bg-blue-100"
          title="Select all visible"
        >
          Select all ({threads.length})
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setSelectedMessages(new Set())}
          className="h-5 w-5"
          title="Deselect all (Esc)"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>

      <div className="flex gap-1 flex-wrap">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="gap-1.5 h-8 text-xs"
              disabled={isProcessing}
              title="Mark emails as read/unread"
            >
              <Eye className="h-3.5 w-3.5" />
              Mark
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleMarkAsRead(false)} disabled={isProcessing}>
              Mark selected as read
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleMarkAsRead(true)} disabled={isProcessing}>
              Mark all visible as read
            </DropdownMenuItem>
            <DropdownMenuItem onClick={async () => {
              setIsProcessing(true);
              try {
                const accountIds = getAccountIds();
                const results = await Promise.allSettled(accountIds.map(accId =>
                  base44.functions.invoke('markEmailsAsUnread', {
                    threadIds: Array.from(selectedMessages),
                    emailAccountId: accId
                  })
                ));
                const failures = results.filter(r => r.status === 'rejected').length;
                if (failures > 0) {
                  toast.warning(`Marked as unread with ${failures} error${failures !== 1 ? 's' : ''}`);
                } else {
                  toast.success("Marked as unread");
                }
                setSelectedMessages(new Set());
                onRefetch();
              } catch {
                toast.error("Failed to mark as unread");
              } finally {
                setIsProcessing(false);
              }
            }} disabled={isProcessing}>
              Mark selected as unread
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button 
              variant="outline" 
              size="sm" 
              className="gap-1.5 h-8 text-xs"
              disabled={isProcessing}
              title="Change email visibility"
            >
              <Eye className="h-3.5 w-3.5" />
              Visibility
              <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleVisibility('private')} disabled={isProcessing}>
              <Lock className="h-4 w-4 mr-2" />
              Private
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleVisibility('shared')} disabled={isProcessing}>
              <Users className="h-4 w-4 mr-2" />
              Shared
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Popover open={labelPopoverOpen} onOpenChange={setLabelPopoverOpen}>
           <PopoverTrigger asChild>
             <Button 
               variant="outline" 
               size="sm" 
               className="gap-1.5 h-8 text-xs"
               disabled={selectedCount !== 1 || isProcessing}
               title="Manage labels (select one email)"
             >
               <Tag className="h-3.5 w-3.5" />
               Labels
               <ChevronDown className="h-3 w-3" />
             </Button>
           </PopoverTrigger>
           <PopoverContent align="end" className="w-72 p-0" onOpenAutoFocus={(e) => e.preventDefault()}>
            {selectedCount === 1 ? (
              <>
                {Array.from(selectedMessages).map(threadId => {
                  const thread = threads.find(t => t.threadId === threadId);
                  const account = emailAccounts.find(a => a.id === thread?.email_account_id);
                  if (!thread || !thread.messages || thread.messages.length === 0 || !account) return null;

                  return (
                    <div key={threadId} className="p-3">
                      <LabelSelectorRobust
                        emailAccountId={account.id}
                        selectedLabels={thread.messages[0]?.labels || []}
                        onLabelsChange={(labels) => {
                          Promise.all(
                            thread.messages.map(m =>
                              base44.entities.EmailMessage.update(m.id, { labels })
                            )
                          ).then(() => {
                            toast.success("Labels updated");
                            setLabelPopoverOpen(false);
                          }).catch(() => {
                            toast.error("Failed to update labels");
                          });
                        }}
                        isAdmin={user?.role === "master_admin"}
                        compact={true}
                      />
                    </div>
                  );
                })}
              </>
            ) : (
              <div className="p-3 text-xs text-muted-foreground">
                Select one email to manage labels
              </div>
            )}
          </PopoverContent>
        </Popover>

        {filterView !== 'deleted' && (
          <Button 
            variant="outline" 
            size="sm"
            className="gap-2 h-8"
            onClick={filterView === 'archived' ? handleRestore : handleArchive}
            disabled={isProcessing}
            title={filterView === 'archived' ? 'Restore to inbox' : 'Move to archive'}
          >
            {filterView === 'archived' ? (
              <>
                <RefreshCw className={`h-3.5 w-3.5 ${isProcessing ? 'animate-spin' : ''}`} />
                Restore
              </>
            ) : (
              <>
                <Archive className="h-3.5 w-3.5" />
                Archive
              </>
            )}
          </Button>
        )}

        <Button 
          variant="outline"
          size="sm"
          className="gap-1.5 h-8 text-xs"
          onClick={() => {
            if (filterView === 'deleted') {
              toast.error("Cannot permanently delete from deleted folder");
              return;
            }
            const isConfirmed = confirm(`Delete ${selectedCount} email${selectedCount !== 1 ? 's' : ''}?`);
            if (!isConfirmed) return;
            setIsProcessing(true);
            const accountIds = getAccountIds();
            Promise.allSettled(accountIds.map(accId =>
              base44.functions.invoke('deleteEmails', {
                threadIds: Array.from(selectedMessages),
                emailAccountId: accId,
                permanently: false
              })
            )).then((results) => {
              const failures = results.filter(r => r.status === 'rejected').length;
              if (failures > 0) {
                toast.warning(`Deleted with ${failures} account error${failures !== 1 ? 's' : ''}`);
              } else {
                toast.success("Deleted");
              }
              setSelectedMessages(new Set());
              onRefetch();
            }).catch(() => toast.error("Failed to delete"))
            .finally(() => setIsProcessing(false));
          }}
          disabled={isProcessing}
          title="Move to deleted folder"
        >
          <Trash2 className={`h-3.5 w-3.5 ${isProcessing ? 'animate-pulse' : ''}`} />
          Delete ({selectedCount})
        </Button>
      </div>
    </div>
  );
}
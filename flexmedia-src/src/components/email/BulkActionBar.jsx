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
  Eye,
  Archive,
  Trash2,
  RefreshCw,
  Lock,
  Users,
  ChevronDown,
  X,
  Loader2,
} from "lucide-react";
import { api } from "@/api/supabaseClient";
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
        api.functions.invoke('markEmailsAsRead', {
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
        api.functions.invoke('setEmailVisibility', {
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
        api.functions.invoke('archiveEmails', {
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
        api.functions.invoke('restoreEmails', {
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
        {isProcessing ? (
          <div className="flex items-center gap-1.5 bg-amber-100 px-2.5 py-1 rounded-full animate-pulse">
            <Loader2 className="h-3 w-3 animate-spin text-amber-700" />
            <span className="text-xs font-medium text-amber-700">Processing...</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 bg-blue-100 px-2.5 py-1 rounded-full">
            <span className="text-xs font-bold text-blue-800 tabular-nums">{selectedCount}</span>
            <span className="text-xs text-blue-600">selected</span>
          </div>
        )}
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
                  api.functions.invoke('markEmailsAsUnread', {
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

        {/* Labels — tri-state bulk support (Gmail-style: checked/indeterminate/unchecked) */}
        {(() => {
          const firstThreadId = Array.from(selectedMessages)[0];
          const firstThread = threads.find(t => t.threadId === firstThreadId);
          const account = emailAccounts.find(a => a.id === firstThread?.email_account_id);
          if (!firstThread || !account) return null;

          // Compute label state across ALL selected threads for tri-state display
          const selectedThreads = Array.from(selectedMessages).map(tid => threads.find(th => th.threadId === tid)).filter(Boolean);
          const totalSelected = selectedThreads.length;
          // Count how many selected threads have each label
          const labelCounts = {};
          selectedThreads.forEach(t => {
            const threadLabels = t.messages[0]?.labels || [];
            threadLabels.forEach(l => { labelCounts[l] = (labelCounts[l] || 0) + 1; });
          });
          // Labels ALL selected threads have → checked; SOME → indeterminate
          const allLabels = Object.keys(labelCounts).filter(l => labelCounts[l] === totalSelected);
          const someLabels = Object.keys(labelCounts).filter(l => labelCounts[l] > 0 && labelCounts[l] < totalSelected);

          return (
            <LabelSelectorRobust
              emailAccountId={account.id}
              selectedLabels={allLabels}
              indeterminateLabels={someLabels}
              onLabelsChange={(newLabels) => {
                // Apply additive/subtractive: compute per-thread what labels to set
                const allMessages = [];
                selectedThreads.forEach(t => {
                  const currentLabels = t.messages[0]?.labels || [];
                  // Add labels that are in newLabels but not in current
                  // Remove labels that were in selectedLabels (fully checked) but not in newLabels
                  const added = newLabels.filter(l => !allLabels.includes(l) && !someLabels.includes(l));
                  const removed = [...allLabels, ...someLabels].filter(l => !newLabels.includes(l));
                  let updatedLabels = [...new Set([...currentLabels, ...added])].filter(l => !removed.includes(l));
                  t.messages.forEach(m => {
                    allMessages.push({ id: m.id, labels: updatedLabels });
                  });
                });
                setIsProcessing(true);
                // Race condition fix: use allSettled so partial failures don't mask successful updates
                // Chunk updates to avoid overwhelming the API at scale
                (async () => {
                  try {
                    const CHUNK = 25;
                    const allResults = [];
                    for (let i = 0; i < allMessages.length; i += CHUNK) {
                      const chunkResults = await Promise.allSettled(
                        allMessages.slice(i, i + CHUNK).map(({ id, labels }) => api.entities.EmailMessage.update(id, { labels }))
                      );
                      allResults.push(...chunkResults);
                    }
                    const failed = allResults.filter(r => r.status === 'rejected').length;
                    if (failed > 0 && failed < allMessages.length) {
                      toast.warning(`Labels updated with ${failed} error${failed !== 1 ? 's' : ''} — some messages may be out of sync`);
                    } else if (failed === allMessages.length) {
                      toast.error("Failed to update labels");
                    } else {
                      toast.success(`Labels updated for ${selectedCount} email${selectedCount !== 1 ? 's' : ''}`);
                    }
                    setSelectedMessages(new Set());
                    onRefetch();
                  } catch {
                    toast.error("Failed to update labels");
                  } finally {
                    setIsProcessing(false);
                  }
                })();
              }}
              isAdmin={user?.role === "master_admin"}
              compact={false}
            />
          );
        })()}

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
            const isConfirmed = confirm(`Delete ${selectedCount} email${selectedCount !== 1 ? 's' : ''}?`);
            if (!isConfirmed) return;
            setIsProcessing(true);
            const accountIds = getAccountIds();
            Promise.allSettled(accountIds.map(accId =>
              api.functions.invoke('deleteEmails', {
                threadIds: Array.from(selectedMessages),
                emailAccountId: accId,
                permanently: false
              })
            )).then((results) => {
              const failures = results.filter(r => r.status === 'rejected').length;
              if (failures > 0) {
                toast.warning(`Deleted with ${failures} account error${failures !== 1 ? 's' : ''}`);
              } else {
                toast.success("Emails deleted successfully");
              }
              setSelectedMessages(new Set());
              onRefetch();
            }).catch(() => toast.error("Failed to delete emails. Please try again."))
            .finally(() => setIsProcessing(false));
          }}
          disabled={isProcessing || filterView === 'deleted'}
          title={filterView === 'deleted' ? "Already in deleted folder" : "Move to deleted folder"}
        >
          <Trash2 className={`h-3.5 w-3.5 ${isProcessing ? 'animate-pulse' : ''}`} />
          Delete ({selectedCount})
        </Button>
      </div>
    </div>
  );
}
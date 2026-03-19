import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { RefreshCw, Plus, Search, Archive, Flag, Trash2, Settings } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import EmailThreadViewer from "./EmailThreadViewer";
import EmailCompose from "./EmailCompose";
import EmailAccountSetup from "./EmailAccountSetup";
import EmailSettings from "./EmailSettings";
import { Skeleton } from "@/components/ui/skeleton";

const labelColors = {
  important: 'bg-red-100 text-red-700',
  follow_up: 'bg-orange-100 text-orange-700',
  client: 'bg-blue-100 text-blue-700',
  proposal: 'bg-green-100 text-green-700',
  completed: 'bg-gray-100 text-gray-700'
};

export default function EmailInbox() {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedThread, setSelectedThread] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const queryClient = useQueryClient();

  // Fetch email accounts
  const { data: emailAccounts = [], isLoading: accountsLoading } = useQuery({
    queryKey: ["email-accounts"],
    queryFn: () => base44.entities.EmailAccount.filter({ is_active: true })
  });

  // Set first active account as selected
  useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(emailAccounts[0]);
    }
  }, [emailAccounts, selectedAccount]);

  // Fetch messages for selected account
  const { data: messages = [], isLoading: messagesLoading, refetch: refetchMessages } = useQuery({
    queryKey: ["email-messages", selectedAccount?.id],
    queryFn: () => selectedAccount 
      ? base44.entities.EmailMessage.filter({ 
          email_account_id: selectedAccount.id,
          is_draft: false,
          is_sent: false
        }, "-received_at", 100)
      : [],
    enabled: !!selectedAccount
  });

  // Sync mutation — syncs the selected account using per-account OAuth tokens
  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!selectedAccount) throw new Error('No account selected');
      const result = await base44.functions.invoke('syncGmailMessagesForAccount', {
        accountId: selectedAccount.id,
        userId: selectedAccount.assigned_to_user_id,
      });
      return result;
    },
    onSuccess: (res) => {
      const n = res?.data?.synced ?? 0;
      toast.success(n > 0 ? `Synced ${n} new email${n !== 1 ? 's' : ''}` : "Already up to date");
      refetchMessages();
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to sync emails");
    }
  });

  // Update message mutation
  const updateMessageMutation = useMutation({
    mutationFn: (data) => base44.entities.EmailMessage.update(data.messageId, data.updates),
    onSuccess: () => {
      refetchMessages();
    }
  });

  // Group messages by thread
  const threads = messages.reduce((acc, msg) => {
    const existing = acc.find(t => t.threadId === msg.gmail_thread_id);
    if (existing) {
      existing.messages.push(msg);
    } else {
      acc.push({
        threadId: msg.gmail_thread_id,
        subject: msg.subject,
        from: msg.from_name || msg.from,
        lastMessage: msg.received_at,
        unreadCount: messages.filter(m => m.gmail_thread_id === msg.gmail_thread_id && m.is_unread).length,
        messages: [msg]
      });
    }
    return acc;
  }, []);

  const filteredThreads = threads.filter(t =>
    t.subject.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.from.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (emailAccounts.length === 0) {
    return <EmailAccountSetup />;
  }

  return (
    <div className="flex flex-col lg:grid lg:grid-cols-4 gap-0 lg:gap-4 h-full">
       {/* Top nav pills (mobile) or sidebar (desktop) */}
       <div className="lg:col-span-1 p-3 lg:p-0 border-b lg:border-b-0 lg:border-r bg-muted/30 lg:bg-transparent space-y-3">
         {/* Quick Actions */}
         <div className="flex gap-1.5 lg:flex-col">
           <Button 
             onClick={() => setShowCompose(true)} 
             className="flex-1 lg:w-full gap-1.5 bg-blue-600 hover:bg-blue-700 text-white font-bold shadow-sm h-8 lg:h-9 text-xs lg:text-sm"
             size="sm"
             title="Compose email (Ctrl+N)"
           >
             <Plus className="h-3 w-3 lg:h-3.5 lg:w-3.5" />
             <span className="hidden sm:inline">Compose</span>
           </Button>
           <Button
             variant="outline"
             size="sm"
             onClick={() => syncMutation.mutate()}
             disabled={syncMutation.isPending}
             title="Sync emails"
             className="h-8 lg:h-9 w-8 lg:w-full lg:justify-start lg:gap-1.5 px-2 lg:px-3"
           >
             <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? 'animate-spin' : ''} lg:mr-1`} />
             <span className="hidden lg:inline text-xs">Sync</span>
           </Button>
           <Button
             variant="outline"
             size="sm"
             onClick={() => setShowSettings(true)}
             title="Email settings"
             className="h-8 lg:h-9 w-8 lg:w-full lg:justify-start lg:gap-1.5 px-2 lg:px-3"
           >
             <Settings className="h-3.5 w-3.5 lg:mr-1" />
             <span className="hidden lg:inline text-xs">Settings</span>
           </Button>
         </div>

         {/* Email Accounts — horizontal scroll on mobile, vertical on desktop */}
         <div className="space-y-1.5">
           <p className="text-[10px] font-bold text-muted-foreground/50 uppercase tracking-wider px-1 hidden lg:block">Accounts</p>
           <div className="flex lg:flex-col gap-2 overflow-x-auto pb-2 lg:pb-0 lg:space-y-1.5">
             {emailAccounts.map(account => (
               <button
                 key={account.id}
                 onClick={() => setSelectedAccount(account)}
                 className={`flex-shrink-0 p-2 lg:p-2.5 rounded-lg border transition-all text-left min-h-10 lg:w-full whitespace-nowrap ${
                   selectedAccount?.id === account.id
                     ? 'bg-blue-50 border-blue-400 shadow-sm'
                     : 'bg-card border-border hover:border-blue-300 hover:bg-muted/50'
                 }`}
                 title={account.email_address}
               >
                 <p className={`text-xs font-bold truncate ${
                   selectedAccount?.id === account.id ? 'text-blue-900' : 'text-foreground'
                 }`}>{account.email_address.split('@')[0]}</p>
                 <p className="text-[10px] text-muted-foreground/60 truncate mt-0.5 hidden lg:block">{account.display_name}</p>
               </button>
             ))}
           </div>
         </div>
       </div>

      {/* Main Content */}
      <div className="lg:col-span-3 flex flex-col min-h-0">
        {selectedThread ? (
          <div className="flex flex-col h-full overflow-hidden">
            <EmailThreadViewer 
              thread={selectedThread}
              account={selectedAccount}
              onBack={() => setSelectedThread(null)}
            />
          </div>
        ) : (
          <div className="flex flex-col h-full bg-white border-l rounded-t-lg lg:rounded-lg shadow-xs overflow-hidden">
            {/* Header */}
            <div className="px-4 lg:px-6 py-3 lg:py-4 border-b bg-gradient-to-r from-muted/50 to-transparent space-y-2.5">
              <div className="flex justify-between items-start gap-3">
                <div>
                  <h2 className="text-base lg:text-lg font-bold leading-tight">Inbox</h2>
                  <p className="text-xs text-muted-foreground/60 mt-0.5">{filteredThreads.length} conversation{filteredThreads.length !== 1 ? 's' : ''}</p>
                </div>
                <Badge variant="secondary" className="text-xs lg:text-sm font-bold shrink-0">{messages.length}</Badge>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground/40" />
                <Input
                  placeholder="Search by subject, sender…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9 py-2 text-sm h-9"
                  aria-label="Search emails"
                  autoFocus
                />
              </div>
            </div>
            {/* Thread List */}
            <div className="flex-1 overflow-y-auto">
              {messagesLoading ? (
                <div className="p-3 lg:p-4 space-y-2">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="p-3 border-b rounded flex gap-3 animate-pulse opacity-50">
                      <div className="h-9 w-9 bg-muted rounded-full flex-shrink-0" />
                      <div className="flex-1 space-y-1.5 min-w-0">
                        <div className="h-3 bg-muted rounded w-2/3" />
                        <div className="h-2.5 bg-muted rounded w-3/4" />
                      </div>
                      <div className="h-3 bg-muted rounded w-16 flex-shrink-0" />
                    </div>
                  ))}
                </div>
              ) : filteredThreads.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-48 p-6 text-center">
                  <Search className="h-12 w-12 text-muted-foreground/20 mb-3" />
                  <p className="text-sm font-semibold text-foreground">No emails found</p>
                  <p className="text-xs text-muted-foreground/60 mt-1">Try adjusting your search or sync emails</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredThreads.map(thread => (
                    <button
                      key={thread.threadId}
                      onClick={() => setSelectedThread(thread)}
                      className="w-full p-3 lg:p-4 hover:bg-muted/40 cursor-pointer transition-colors active:bg-muted/60 text-left border-b-0"
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && setSelectedThread(thread)}
                    >
                      <div className="flex justify-between items-start gap-3 mb-1">
                        <div className="flex-1 min-w-0">
                          <h4 className={`text-sm truncate leading-tight ${thread.unreadCount > 0 ? 'font-bold text-foreground' : 'font-medium text-foreground/70'}`}>
                            {thread.subject || '(no subject)'}
                          </h4>
                          <p className={`text-xs truncate mt-0.5 ${thread.unreadCount > 0 ? 'text-foreground/60 font-medium' : 'text-muted-foreground/60'}`}>
                            {thread.from}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {thread.unreadCount > 0 && (
                            <Badge className="bg-blue-600 text-white text-[10px] font-bold h-5 px-1.5">{thread.unreadCount}</Badge>
                          )}
                          {thread.messages[0]?.is_starred && (
                            <Flag className="h-3.5 w-3.5 fill-amber-400 text-amber-400 flex-shrink-0" />
                          )}
                        </div>
                      </div>
                      <div className="flex justify-between items-center gap-2 text-[11px]">
                        <span className="text-muted-foreground/60">{format(new Date(thread.lastMessage), "MMM d")}</span>
                        {thread.messages.length > 1 && (
                          <span className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded text-[9px] font-semibold">{thread.messages.length} msgs</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            </div>
        )}
      </div>

      {/* Dialogs */}
      {showCompose && (
        <EmailCompose
          account={selectedAccount}
          onClose={() => setShowCompose(false)}
          onSent={() => {
            setShowCompose(false);
            refetchMessages();
          }}
        />
      )}

      {showSettings && (
        <EmailSettings
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}
import { useState, useEffect, useRef, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";
import { 
  RefreshCw,
  Plus,
  Search,
  Settings,
  Menu,
  X,
  ChevronDown,
  Link2,
  Tag,
  Clock
} from "lucide-react";

import { format, formatDistanceToNow, isToday } from "date-fns";
import { fixTimestamp } from "@/components/utils/dateUtils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import EmailThreadViewer from "./EmailThreadViewer";
import EmailComposeDialog from "./EmailComposeDialog";
import EmailAccountSetup from "./EmailAccountSetup";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useUndoRedo } from "@/components/hooks/useUndoRedo";
import { useEntitySubscriptionWithFilter } from "@/components/hooks/useEntitySubscriptionWithFilter";

import ProjectLinkDialogForInbox from "./ProjectLinkDialogForInbox";
import LabelSelectorRobust from "./LabelSelectorRobust";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import EmailListContainer from "./EmailListContainer";
import EmailListControls from "./EmailListControls";
import { useColumnManager } from "./useColumnManager";
import FolderButton from "./FolderButton";
import BulkActionBar from "./BulkActionBar";
import { FOLDER_FILTERS, applyFolderFilter } from "./emailFilterUtils";
import { getAccountIdsFromThreads } from "./threadUtils";

export default function EmailInboxMain() {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useState("");
  const [selectedThread, setSelectedThread] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [accountFilter, setAccountFilter] = useState("all");
  const [sidebarOpen, setSidebarOpen] = useState(
    typeof window !== 'undefined' && window.innerWidth >= 1024
  );
  const [filterUnread, setFilterUnread] = useState(false);
  const [filterView, setFilterView] = useState("inbox");
  const [selectedMessages, setSelectedMessages] = useState(new Set());
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const [filterFrom, setFilterFrom] = useState(null);
  const [filterLabel, setFilterLabel] = useState(null);
  const [filterProject, setFilterProject] = useState(null);
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [linkProjectThread, setLinkProjectThread] = useState(null);
  const [sortBy, setSortBy] = useState('newest');
  const [showAttachmentsOnly, setShowAttachmentsOnly] = useState(false);
  const [showReply, setShowReply] = useState(false);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [savedFilters, setSavedFilters] = useState(() => {
    try { return JSON.parse(localStorage.getItem('email-saved-filters') || '[]'); } catch { return []; }
  });
  const [showSaveFilter, setShowSaveFilter] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const MAX_UNDO_STACK = 20;
  const SEARCH_DEBOUNCE_MS = 300;
  const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000;
  const MAX_THREADS_TO_DISPLAY = 500;
  const containerRef = useRef(null);
  const sidebarScrollRef = useRef(null);
  const searchContainerRef = useRef(null);
  const [searchFocused, setSearchFocused] = useState(false);

  // Persist sidebar scroll position and clear selections on folder change
  useEffect(() => {
    const key = `inbox-sidebar-scroll-${filterView}`;
    if (sidebarScrollRef.current) {
      const saved = sessionStorage.getItem(key);
      if (saved) {
        sidebarScrollRef.current.scrollTop = parseInt(saved, 10);
      }
    }
    // Clear selections when switching folders
    setSelectedMessages(new Set());
    setSelectedThread(null);
  }, [filterView]);

  useEffect(() => {
    const key = `inbox-sidebar-scroll-${filterView}`;
    const timer = setInterval(() => {
      if (sidebarScrollRef.current) {
        sessionStorage.setItem(key, sidebarScrollRef.current.scrollTop.toString());
      }
    }, 500);
    return () => clearInterval(timer);
  }, [filterView]);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  
  // Enforce undo stack limit
  useEffect(() => {
    if (undoStack.length > MAX_UNDO_STACK) {
      setUndoStack(undoStack.slice(-MAX_UNDO_STACK));
    }
    if (redoStack.length > MAX_UNDO_STACK) {
      setRedoStack(redoStack.slice(-MAX_UNDO_STACK));
    }
  }, [undoStack.length, redoStack.length]);

  const {
    columns,
    fitToScreen,
    resetToDefault,
    resizeColumn,
    reorderColumns,
    isDragging,
    setIsDragging,
    isResizing,
    setIsResizing,
  } = useColumnManager();

  // Real-time subscriptions for data
  const { data: emailAccounts = [], loading: accountsLoading } = useEntitySubscriptionWithFilter(
    'EmailAccount',
    { is_active: true, assigned_to_user_id: user?.id }
  );

  const { data: labelData = [], loading: labelsLoading } = useEntitySubscriptionWithFilter(
    'EmailLabel',
    {}
  );

  useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(emailAccounts[0]);
    }
  }, [emailAccounts, selectedAccount]);

  // Real-time subscription for messages based on current view filter
  const messageFilters = useMemo(() => {
    const filters = {};
    switch (filterView) {
      case "draft":
        filters.is_draft = true;
        break;
      case "sent":
        filters.is_sent = true;
        break;
      case "deleted":
        filters.is_deleted = true;
        break;
      case "archived":
        filters.is_archived = true;
        break;
      default: // inbox
        filters.is_draft = false;
        filters.is_sent = false;
        filters.is_deleted = false;
        filters.is_archived = false;
    }
    return filters;
  }, [filterView]);

  const { data: messages = [], loading: messagesLoading, refetch: refetchMessages } = useEntitySubscriptionWithFilter(
    'EmailMessage',
    messageFilters,
    []
  );





  // Sync mutation - per-account sync using correct OAuth token
  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id || emailAccounts.length === 0) throw new Error('No accounts connected');
      const results = await Promise.allSettled(
        emailAccounts.map(account =>
          api.functions.invoke('syncGmailMessagesForAccount', {
            accountId: account.id,
            userId: user.id,
          })
        )
      );
      const synced = results.reduce((sum, r) => sum + (r.value?.data?.synced || 0), 0);
      const errors = results.filter(r => r.status === 'rejected').length;
      return { synced, errors };
    },
    onSuccess: ({ synced, errors }) => {
      if (synced > 0) {
        toast.success(`Synced ${synced} new email${synced !== 1 ? 's' : ''}`);
      } else if (errors > 0) {
        toast.error(`Sync completed with ${errors} account error${errors !== 1 ? 's' : ''} — check email settings`);
      } else {
        toast.success('Inbox up to date');
      }
    },
    onError: (error) => {
      toast.error(error?.message || 'Sync failed — check your email connection in Settings');
    },
  });

  // Background auto-sync: fetch new emails from Gmail every 5 minutes silently.
  // The subscription hook then picks up the new EmailMessage entities automatically.
  const lastSyncRef = useRef(null);
  useEffect(() => {
    if (emailAccounts.length === 0 || !user?.id) return;

    const runSync = () => {
      const now = Date.now();
      if (lastSyncRef.current && now - lastSyncRef.current < 10000) return;
      lastSyncRef.current = now;

      // Sync each account individually using per-account token (correct OAuth flow)
      emailAccounts.forEach((account, idx) => {
        setTimeout(() => {
          api.functions.invoke('syncGmailMessagesForAccount', {
            accountId: account.id,
            userId: user.id,
          }).catch(() => {});
        }, idx * 1500);
      });
    };

    const mountTimeout = setTimeout(runSync, 2000);
    const interval = setInterval(runSync, AUTO_SYNC_INTERVAL_MS);
    return () => {
      clearTimeout(mountTimeout);
      clearInterval(interval);
    };
  }, [emailAccounts.length, user?.id]);

  // Update message mutation - subscription handles UI updates automatically
  const updateMessageMutation = useMutation({
    mutationFn: (data) => api.entities.EmailMessage.update(data.messageId, data.updates)
  });

  // Delete emails mutation - subscription auto-updates UI
  const deleteEmailsMutation = useMutation({
    mutationFn: (data) => api.functions.invoke('deleteEmails', data),
    onSuccess: () => {
      toast.success("Emails deleted", {
        action: {
          label: "Undo",
          onClick: handleUndo
        }
      });
      // Push clean, serializable action to undo stack
      // Store ALL account IDs so undo restores across all accounts in multi-account selections
      const threadIds = Array.from(selectedMessages);
      const accountIds = getAccountIdsFromThreads(threadIds, threads);
      setUndoStack(prev => [...prev, {
        type: 'delete',
        data: { threadIds, accountIds }
      }]);
      setSelectedMessages(new Set());
      setRedoStack([]);
    },
    onError: () => {
      toast.error("Failed to delete emails");
    }
  });

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    const lastAction = undoStack[undoStack.length - 1];
    setRedoStack([...redoStack, lastAction]);
    setUndoStack(undoStack.slice(0, -1));
    
    // Reverse the action
    if (lastAction.type === 'delete') {
      // Restore deleted emails across all affected accounts
      const acctIds = lastAction.data.accountIds || [lastAction.data.emailAccountId];
      await Promise.allSettled(acctIds.map(accId =>
        api.functions.invoke('restoreEmails', {
          threadIds: lastAction.data.threadIds,
          emailAccountId: accId
        })
      ));
    } else if (lastAction.type === 'archive') {
      // Unarchive
      await Promise.all(
        lastAction.data.threadIds.map(threadId => {
          const thread = threads.find(t => t.threadId === threadId);
          if (thread) {
            return updateMessageMutation.mutateAsync({
              messageId: thread.messages[0].id,
              updates: { is_archived: false }
            });
          }
        }).filter(Boolean)
      );
    } else if (lastAction.type === 'visibility') {
      // Restore old visibility
      await Promise.all(
        lastAction.data.threadIds.map(threadId => {
          const thread = threads.find(t => t.threadId === threadId);
          if (thread) {
            return updateMessageMutation.mutateAsync({
              messageId: thread.messages[0].id,
              updates: { visibility: lastAction.data.oldVisibility }
            });
          }
        }).filter(Boolean)
      );
    } else if (lastAction.type === 'linkProject') {
      // Unlink project
      await Promise.all(
        lastAction.data.messageIds.map(msgId =>
          api.entities.EmailMessage.update(msgId, {
            project_id: null,
            project_title: null,
            visibility: 'private'
          })
        )
      );
    }
    // Subscription auto-updates UI
  };

  const handleRedo = async () => {
    if (redoStack.length === 0) return;
    const action = redoStack[redoStack.length - 1];
    setUndoStack([...undoStack, action]);
    setRedoStack(redoStack.slice(0, -1));
    
    // Redo the action
    if (action.type === 'delete') {
      deleteEmailsMutation.mutate(action.data);
    } else if (action.type === 'archive') {
      Promise.all(
        action.data.threadIds.map(threadId => {
          const thread = threads.find(t => t.threadId === threadId);
          if (thread) {
            return updateMessageMutation.mutateAsync({
              messageId: thread.messages[0].id,
              updates: { is_archived: true }
            });
          }
        }).filter(Boolean)
      );
    } else if (action.type === 'visibility') {
      Promise.all(
        action.data.threadIds.map(threadId => {
          const thread = threads.find(t => t.threadId === threadId);
          if (thread) {
            return updateMessageMutation.mutateAsync({
              messageId: thread.messages[0].id,
              updates: { visibility: action.data.newVisibility }
            });
          }
        }).filter(Boolean)
      );
    } else if (action.type === 'linkProject') {
      Promise.all(
        action.data.messageIds.map(msgId =>
          api.entities.EmailMessage.update(msgId, {
            project_id: action.data.projectId,
            project_title: action.data.projectTitle,
            visibility: 'shared'
          })
        )
      );
    }
  };

  // User's own account IDs — only show messages from these accounts (security scope)
  const userAccountIds = useMemo(
    () => new Set(emailAccounts.map(a => a.id)),
    [emailAccounts]
  );

  // Group messages by thread with proper uniqueness and memory management
  const threads = useMemo(() => {
    const threadMap = new Map();
    
    messages.forEach(msg => {
      // Security: silently discard any messages not belonging to user's accounts
      if (userAccountIds.size > 0 && !userAccountIds.has(msg.email_account_id)) return;

      // Use stable separator that won't collide
      const uniqueKey = `${msg.email_account_id}|||${msg.gmail_thread_id}`;
      const existing = threadMap.get(uniqueKey);
      
      if (existing) {
        existing.messages.push(msg);
        existing.unreadCount += msg.is_unread ? 1 : 0;
        // Update lastMessage if this message is newer
        if (new Date(msg.received_at) > new Date(existing.lastMessage)) {
          existing.lastMessage = msg.received_at;
        }
      } else {
        threadMap.set(uniqueKey, {
          uniqueKey,
          threadId: msg.gmail_thread_id,
          email_account_id: msg.email_account_id,
          subject: msg.subject,
          from: msg.from_name || msg.from,
          from_name: msg.from_name,
          from_email: msg.from,
          agent_name: msg.agent_name,
          agency_name: msg.agency_name,
          lastMessage: msg.received_at,
          unreadCount: msg.is_unread ? 1 : 0,
          is_starred: msg.is_starred,
          messages: [msg],
          project_id: msg.project_id,
          project_title: msg.project_title,
          is_archived: msg.is_archived,
          is_deleted: msg.is_deleted
        });
      }
    });
    
    return Array.from(threadMap.values());
  }, [messages, userAccountIds]);

  // Update selectedThread reference if it exists in threads (after subscription updates)
  useEffect(() => {
    if (selectedThread && threads.length > 0) {
      const updated = threads.find(t => t.threadId === selectedThread.threadId);
      if (updated) {
        setSelectedThread(updated);
      }
    }
  }, [threads]);

  // Optimized filtering with memoization
  const filteredThreads = useMemo(() => {
    let result = threads;
    
    // Filter by account
    if (accountFilter !== "all") {
      result = result.filter(t => t.email_account_id === accountFilter);
    }
    
    // Advanced search with operators
    if (debouncedSearchQuery.trim()) {
      const rawQuery = debouncedSearchQuery.toLowerCase();
      
      // Parse search operators: from:, to:, subject:, has:, label:
      const fromMatch = rawQuery.match(/from:(\S+)/);
      const toMatch = rawQuery.match(/to:(\S+)/);
      const subjectMatch = rawQuery.match(/subject:(\S+)/);
      const hasAttachment = rawQuery.includes('has:attachment');
      const labelMatch = rawQuery.match(/label:(\S+)/);
      const isUnread = rawQuery.includes('is:unread');
      const isStarred = rawQuery.includes('is:starred');

      // Remove operators from query for general search
      const cleanQuery = rawQuery
        .replace(/from:\S+/g, '')
        .replace(/to:\S+/g, '')
        .replace(/subject:\S+/g, '')
        .replace(/has:attachment/g, '')
        .replace(/label:\S+/g, '')
        .replace(/is:unread/g, '')
        .replace(/is:starred/g, '')
        .trim();
      
      result = result.filter(t => {
        const mainMessage = t.messages[0];
        try {
          // Operator filters
          if (fromMatch) {
            const fromTerm = fromMatch[1];
            const anyFromMatch = t.messages.some(m =>
              (m.from || '').toLowerCase().includes(fromTerm) ||
              (m.from_name || '').toLowerCase().includes(fromTerm)
            );
            if (!anyFromMatch) return false;
          }
          if (toMatch) {
            const toTerm = toMatch[1];
            const anyToMatch = t.messages.some(m =>
              m.to?.some(email => email.toLowerCase().includes(toTerm))
            );
            if (!anyToMatch) return false;
          }
          if (subjectMatch && !(t.subject || '').toLowerCase().includes(subjectMatch[1])) return false;
          if (hasAttachment) {
            const hasAny = t.messages.some(m => m.attachments?.length > 0);
            if (!hasAny) return false;
          }
          if (labelMatch) {
            const labelTerm = labelMatch[1];
            const hasLabel = t.messages.some(m => m.labels?.some(l => l.toLowerCase().includes(labelTerm)));
            if (!hasLabel) return false;
          }
          if (isUnread && t.unreadCount === 0) return false;
          if (isStarred && !t.is_starred) return false;

          // General text search across ALL messages in thread (if cleanQuery exists)
          // Use plain .includes() for literal matching — no regex escaping needed.
          // This correctly handles emoji, special characters (., *, [), etc.
          if (cleanQuery) {
            // Search subject
            if (t.subject?.toLowerCase().includes(cleanQuery)) return true;
            // Search project title
            if (t.project_title?.toLowerCase().includes(cleanQuery)) return true;
            // Search across all messages in thread: from, body, labels, attachments
            return t.messages.some(m =>
              (m.from || '').toLowerCase().includes(cleanQuery) ||
              (m.from_name || '').toLowerCase().includes(cleanQuery) ||
              m.body?.toLowerCase().includes(cleanQuery) ||
              m.labels?.some(l => l.toLowerCase().includes(cleanQuery)) ||
              m.attachments?.some(a => a.filename?.toLowerCase().includes(cleanQuery))
            );
          }

          return true;
        } catch {
          return false;
        }
      });
    }
    
    if (filterUnread) {
      result = result.filter(t => t.unreadCount > 0);
    }
    
    if (filterFrom) {
      result = result.filter(t => t.from_email === filterFrom);
    }
    
    if (filterLabel) {
      result = result.filter(t => t.messages[0].labels?.includes(filterLabel));
    }
    
    if (filterProject) {
      result = result.filter(t => t.project_id === filterProject);
    }

    // Apply sorting
    result = result.slice().sort((a, b) => {
      switch (sortBy) {
        case 'oldest':
          return new Date(a.lastMessage).getTime() - new Date(b.lastMessage).getTime();
        case 'sender':
          return (a.from_name || a.from).localeCompare(b.from_name || b.from);
        case 'subject':
          return (a.subject || '').localeCompare(b.subject || '');
        case 'unread':
          return b.unreadCount - a.unreadCount;
        case 'newest':
        default:
          return new Date(b.lastMessage).getTime() - new Date(a.lastMessage).getTime();
      }
    });

    // Apply attachments filter
    if (showAttachmentsOnly) {
      result = result.filter(t => t.messages[0]?.attachments?.length > 0);
    }

    return result;
  }, [threads, accountFilter, debouncedSearchQuery, filterUnread, filterFrom, filterLabel, filterProject, sortBy, showAttachmentsOnly]);

  // Keyboard shortcuts (must be after filteredThreads is defined)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input or contenteditable (ReactQuill)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      // Ignore if a dialog/modal is open (compose, etc.)
      if (showCompose) return;

      // Capture references to avoid stale closures
      const currentFilteredThreads = filteredThreads;
      const currentThreads = threads;

      // j/k navigation — works in list view, opens thread on Enter
      if (e.key === 'j') {
        e.preventDefault();
        const currentIndex = selectedThread ? currentFilteredThreads.findIndex(t => t.threadId === selectedThread.threadId) : currentFilteredThreads.findIndex(t => selectedMessages.has(t.threadId));
        if (currentIndex < currentFilteredThreads.length - 1) {
          const nextThread = currentFilteredThreads[currentIndex + 1];
          if (selectedThread) {
            setSelectedThread(nextThread);
          } else {
            setSelectedMessages(new Set([nextThread.threadId]));
          }
        }
      }
      if (e.key === 'k') {
        e.preventDefault();
        const currentIndex = selectedThread ? currentFilteredThreads.findIndex(t => t.threadId === selectedThread.threadId) : currentFilteredThreads.findIndex(t => selectedMessages.has(t.threadId));
        if (currentIndex > 0) {
          const prevThread = currentFilteredThreads[currentIndex - 1];
          if (selectedThread) {
            setSelectedThread(prevThread);
          } else {
            setSelectedMessages(new Set([prevThread.threadId]));
          }
        }
      }

      // Enter to open selected thread
      if (e.key === 'Enter' && !selectedThread && selectedMessages.size === 1) {
        e.preventDefault();
        const threadId = Array.from(selectedMessages)[0];
        const thread = currentThreads.find(t => t.threadId === threadId);
        if (thread) setSelectedThread(thread);
      }

      // a or e = archive
      if ((e.key === 'a' || e.key === 'e') && selectedMessages.size > 0 && filterView !== 'archived' && filterView !== 'deleted') {
        e.preventDefault();
        const accountIds = Array.from(new Set(
          Array.from(selectedMessages).map(msgId => {
            const thread = currentThreads.find(t => t.threadId === msgId);
            return thread?.email_account_id;
          }).filter(Boolean)
        ));
        Promise.all(accountIds.map(accId =>
          api.functions.invoke('archiveEmails', {
            threadIds: Array.from(selectedMessages),
            emailAccountId: accId
          })
        )).then(() => {
          toast.success("Archived");
          setSelectedMessages(new Set());
        });
      }

      // # = delete
      if (e.key === '#' && selectedMessages.size > 0 && filterView !== 'deleted') {
        e.preventDefault();
        if (confirm(`Delete ${selectedMessages.size} email(s)?`)) {
          const accountIds = Array.from(new Set(
            Array.from(selectedMessages).map(msgId => {
              const thread = currentThreads.find(t => t.threadId === msgId);
              return thread?.email_account_id;
            }).filter(Boolean)
          ));
          Promise.all(accountIds.map(accId =>
            api.functions.invoke('deleteEmails', {
              threadIds: Array.from(selectedMessages),
              emailAccountId: accId,
              permanently: false
            })
          )).then(() => {
            toast.success("Deleted");
            setSelectedMessages(new Set());
          });
        }
      }

      // c = compose
       if (e.key === 'c') {
         e.preventDefault();
         setShowCompose(true);
       }

      // r or R = reply to selected/open thread
       if ((e.key === 'r' || e.key === 'R') && !showCompose) {
         e.preventDefault();
         if (selectedThread) {
           setShowReply(true);
         } else if (selectedMessages.size === 1) {
           const threadId = Array.from(selectedMessages)[0];
           const thread = currentThreads.find(t => t.threadId === threadId);
           if (thread) {
             setSelectedThread(thread);
             // Open reply after thread loads
             setTimeout(() => setShowReply(true), 100);
           }
         }
       }

       // / = focus search bar
       if (e.key === '/' && !selectedThread) {
         e.preventDefault();
         const searchInput = searchContainerRef.current?.querySelector('input');
         if (searchInput) searchInput.focus();
       }

       // x = toggle selection of current focused email
       if (e.key === 'x' && !selectedThread) {
         e.preventDefault();
         if (selectedMessages.size === 1) {
           // Already selected, keep it - allows further keyboard ops
         } else if (currentFilteredThreads.length > 0) {
           // Select the first one if nothing selected
           setSelectedMessages(new Set([currentFilteredThreads[0].threadId]));
         }
       }

       // u = mark as unread
       if (e.key === 'u' && selectedMessages.size > 0) {
         e.preventDefault();
         const accountIds = Array.from(new Set(
           Array.from(selectedMessages).map(msgId => {
             const thread = currentThreads.find(t => t.threadId === msgId);
             return thread?.email_account_id;
           }).filter(Boolean)
         ));
         Promise.all(accountIds.map(accId =>
           api.functions.invoke('markEmailsAsUnread', {
             threadIds: Array.from(selectedMessages),
             emailAccountId: accId
           })
         )).then(() => {
           toast.success("Marked as unread");
           setSelectedMessages(new Set());
         });
       }

       // ? = show keyboard shortcuts help
       if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
         e.preventDefault();
         setShowKeyboardHelp(true);
       }

       // Escape = close thread viewer or clear search
         if (e.key === 'Escape') {
           if (selectedThread) {
             setSelectedThread(null);
           } else if (searchQuery) {
             setSearchQuery('');
           } else if (selectedMessages.size > 0) {
             setSelectedMessages(new Set());
           }
         }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedThread, selectedMessages, filteredThreads, filterView, threads, showCompose, searchQuery]);

  // Note: filterView is already applied in the query, no need to filter here

  const unreadCount = useMemo(() => {
    return threads.reduce((sum, t) => {
      // Only count unread from inbox (not archived/deleted/draft/sent)
      if (filterView === 'inbox' && !t.is_archived && !t.is_deleted) {
        return sum + t.unreadCount;
      } else if (filterView !== 'inbox') {
        return sum + t.unreadCount; // All unread in other folders
      }
      return sum;
    }, 0);
  }, [threads, filterView]);
  
  const totalEmailCount = threads.length;

  // ResizeObserver: fitToScreen runs whenever the list panel changes width
  // This is what makes columns fill the viewport dynamically on load, resize, and sidebar toggle
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        if (w > 0) fitToScreen(w);
      }
    });

    ro.observe(el);
    // Run immediately on mount so columns are right from frame 1
    const initialWidth = el.getBoundingClientRect().width;
    if (initialWidth > 0) fitToScreen(initialWidth);

    return () => ro.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — fitToScreen is stable, ro handles all future changes

  if (emailAccounts.length === 0) {
    return <EmailAccountSetup />;
  }

  return (
    <div className="flex h-full bg-background relative">
      {/* Mobile sidebar backdrop overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/30 z-20 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      {/* Sidebar - Optimized for modern compact layout */}
      <aside className={cn(
         "w-60 border-r bg-card flex flex-col transition-all duration-300 flex-shrink-0 shadow-sm",
         // On mobile: fixed overlay sidebar with z-index above backdrop
         "lg:relative lg:z-auto",
         sidebarOpen && "fixed inset-y-0 left-0 z-30 lg:relative lg:inset-auto",
         !sidebarOpen && "w-0 overflow-hidden"
       )}>
         <div ref={sidebarScrollRef} className="p-3 space-y-3 flex-1 overflow-y-auto">
          {/* Compose Button */}
          <Button 
            onClick={() => setShowCompose(true)} 
            className="w-full gap-2 bg-primary hover:bg-primary/90 h-9 text-sm"
            title="Compose new email (keyboard: c)"
          >
            <Plus className="h-4 w-4" />
            Compose
          </Button>

          {/* Folders */}
          <div className="space-y-1">
            <p className="text-[9px] font-semibold text-muted-foreground/70 px-2 uppercase tracking-widest">Folders</p>
            <FolderButton
              folder={FOLDER_FILTERS.inbox}
              isActive={filterView === "inbox" && !filterUnread}
              count={unreadCount}
              onClick={() => applyFolderFilter('inbox', {
                setFilterView, setFilterUnread, setFilterFrom, setFilterLabel, 
                setFilterProject, setSelectedMessages, setAccountFilter, setSortBy, setShowAttachmentsOnly
              })}
              title="Go to Inbox"
            />
            <FolderButton
              folder={FOLDER_FILTERS.draft}
              isActive={filterView === "draft"}
              count={filterView === "draft" ? threads.length : null}
              onClick={() => applyFolderFilter('draft', {
                setFilterView, setFilterUnread, setFilterFrom, setFilterLabel,
                setFilterProject, setSelectedMessages, setAccountFilter, setSortBy, setShowAttachmentsOnly
              })}
              title="Go to Drafts"
            />
            <FolderButton
              folder={FOLDER_FILTERS.sent}
              isActive={filterView === "sent"}
              count={filterView === "sent" ? threads.length : null}
              onClick={() => applyFolderFilter('sent', {
                setFilterView, setFilterUnread, setFilterFrom, setFilterLabel,
                setFilterProject, setSelectedMessages, setAccountFilter, setSortBy, setShowAttachmentsOnly
              })}
              title="Go to Sent"
            />
            <FolderButton
              folder={FOLDER_FILTERS.archived}
              isActive={filterView === "archived"}
              count={filterView === "archived" ? threads.length : null}
              onClick={() => applyFolderFilter('archived', {
                setFilterView, setFilterUnread, setFilterFrom, setFilterLabel,
                setFilterProject, setSelectedMessages, setAccountFilter, setSortBy, setShowAttachmentsOnly
              })}
              title="Go to Archived"
            />
            <FolderButton
              folder={FOLDER_FILTERS.deleted}
              isActive={filterView === "deleted"}
              count={filterView === "deleted" ? threads.length : null}
              onClick={() => applyFolderFilter('deleted', {
                setFilterView, setFilterUnread, setFilterFrom, setFilterLabel,
                setFilterProject, setSelectedMessages, setAccountFilter, setSortBy, setShowAttachmentsOnly
              })}
              title="Go to Deleted"
            />
            <button 
              onClick={() => setFilterUnread(!filterUnread)}
              className={cn(
                "w-full text-left px-3 py-2 rounded-md text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
                filterUnread && filterView === "inbox"
                  ? "bg-primary/90 text-primary-foreground shadow-sm" 
                  : "hover:bg-muted/80 text-muted-foreground hover:text-foreground"
              )}
              title="Filter unread emails in current folder"
            >
              🔔 Unread
            </button>
          </div>

          {/* Email Accounts - View All or Single Account */}
          <div className="space-y-2 border-t pt-4">
            <p className="text-[10px] font-semibold text-muted-foreground/80 px-2 uppercase tracking-wide">Accounts</p>
            {emailAccounts.length > 1 && (
              <div
                onClick={() => setAccountFilter("all")}
                className={cn(
                 "p-2.5 rounded-md border cursor-pointer transition-all",
                 accountFilter === "all"
                   ? 'bg-primary/90 text-primary-foreground border-primary shadow-sm'
                   : 'hover:bg-muted/80 border-border/60 hover:border-border'
                )}
                >
                <p className="text-xs font-semibold">All Inboxes</p>
                <p className="text-[10px] opacity-75">{threads.length} total</p>
              </div>
            )}
            {emailAccounts.map(account => {
              const accountThreads = threads.filter(t => t.email_account_id === account.id);
              const accountUnread = accountThreads.reduce((sum, t) => sum + t.unreadCount, 0);
              return (
                <div
                  key={account.id}
                  onClick={() => setAccountFilter(account.id)}
                  className={cn(
                    "p-2.5 rounded-md border cursor-pointer transition-all",
                    accountFilter === account.id
                      ? 'bg-primary/90 text-primary-foreground border-primary shadow-sm'
                      : 'hover:bg-muted/80 border-border/60 hover:border-border'
                  )}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold truncate">{account.email_address}</p>
                    {accountUnread > 0 && <Badge className="text-[9px] h-4 px-1.5">{accountUnread}</Badge>}
                  </div>
                  {account.display_name && account.display_name !== account.email_address && (
                    <p className="text-[10px] opacity-75 truncate">{account.display_name}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="p-3 border-t space-y-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="w-full gap-2 h-8 text-xs relative"
            title={syncMutation.isPending ? "Syncing..." : "Sync now"}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncMutation.isPending && 'animate-spin')} />
            {syncMutation.isPending ? (
              <span className="flex items-center gap-1">
                <span className="inline-block w-1 h-1 rounded-full bg-primary animate-pulse" />
                Syncing...
              </span>
            ) : 'Sync'}
          </Button>
          <Button 
            variant="ghost" 
            size="sm" 
            className="w-full gap-2 h-8 text-xs justify-start hover:bg-muted"
            onClick={() => navigate(createPageUrl('EmailSyncSettings'))}
            title="Email sync settings"
          >
            <Settings className="h-3.5 w-3.5" />
            Settings
          </Button>
          
          {/* Keyboard Shortcuts Hint */}
          <div className="text-[9px] text-muted-foreground/80 px-2 pt-2 border-t space-y-1 mt-2">
            <p className="font-semibold text-[9px] uppercase tracking-widest opacity-70">Shortcuts</p>
            <div className="space-y-0.5 text-[8px]">
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">c</kbd> Compose</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">j/k</kbd> Navigate</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">r</kbd> Reply</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">a/e</kbd> Archive</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">#</kbd> Delete</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">/</kbd> Search</p>
              <p><kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono">Esc</kbd> Back / Clear</p>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0" ref={containerRef}>
        {selectedThread ? (
          <EmailThreadViewer
            thread={selectedThread}
            account={emailAccounts.find(a => a.id === selectedThread.email_account_id) || selectedAccount}
            onBack={() => setSelectedThread(null)}
            currentView={filterView}
            emailAccounts={emailAccounts}
            onNextThread={(() => {
              const idx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
              if (idx >= 0 && idx < filteredThreads.length - 1) {
                return () => setSelectedThread(filteredThreads[idx + 1]);
              }
              return null;
            })()}
            onPrevThread={(() => {
              const idx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
              if (idx > 0) {
                return () => setSelectedThread(filteredThreads[idx - 1]);
              }
              return null;
            })()}
          />
        ) : (
          <>
            {/* Header - Modern compact design */}
            <div className="border-b bg-background/95 backdrop-blur-sm space-y-2">
              {/* Controls Bar */}
              <EmailListControls
                sortBy={sortBy}
                onSortChange={setSortBy}
                showAttachments={showAttachmentsOnly}
                onAttachmentsFilterChange={setShowAttachmentsOnly}
                totalCount={threads.length}
                filteredCount={filteredThreads.length}
                selectedCount={selectedMessages.size}
                onFitToScreen={() => {
                  const el = containerRef.current;
                  if (el) fitToScreen(el.getBoundingClientRect().width);
                }}
                onResetColumns={resetToDefault}
                onLinkProject={() => {
                  if (selectedMessages.size === 1) {
                    const threadId = Array.from(selectedMessages)[0];
                    const thread = threads.find(t => t.threadId === threadId);
                    if (thread) setLinkProjectThread(thread);
                  } else if (selectedMessages.size > 1) {
                    toast.info("Link projects one email at a time");
                  }
                }}
              />

              <div className="px-4 py-2 flex items-center justify-between gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  className="flex lg:hidden h-8 w-8"
                >
                  <Menu className="h-4 w-4" />
                </Button>

                <div className="flex-1 relative max-w-lg" ref={searchContainerRef}>
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground z-10" />
                  <Input
                      placeholder="Search... from: to: has:attachment is:unread (/ to focus, ? for help)"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onFocus={() => setSearchFocused(true)}
                      onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && searchQuery.trim()) {
                          // Save to recent searches
                          const recent = JSON.parse(localStorage.getItem('email-recent-searches') || '[]');
                          const updated = [searchQuery.trim(), ...recent.filter(s => s !== searchQuery.trim())].slice(0, 8);
                          localStorage.setItem('email-recent-searches', JSON.stringify(updated));
                          setSearchFocused(false);
                          e.target.blur();
                        }
                      }}
                      className="pl-9 pr-8 h-9 text-sm border-input/50 focus-visible:ring-1 bg-muted/40"
                     />
                     {searchQuery && (
                       <button
                         onClick={() => setSearchQuery('')}
                         className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                         title="Clear search (Escape)"
                         aria-label="Clear search"
                       >
                         <X className="h-3.5 w-3.5" />
                       </button>
                     )}
                     {/* Search hints dropdown */}
                     {searchFocused && !searchQuery && (
                       <div className="absolute top-full left-0 right-0 mt-1 bg-popover border border-border rounded-lg shadow-lg z-50 p-3 space-y-3">
                         {/* Recent searches */}
                         {(() => {
                           const recent = JSON.parse(localStorage.getItem('email-recent-searches') || '[]');
                           if (recent.length > 0) return (
                             <div>
                               <div className="flex items-center justify-between mb-1.5">
                                 <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">Recent</p>
                                 <button
                                   onClick={() => { localStorage.removeItem('email-recent-searches'); }}
                                   className="text-[10px] text-muted-foreground hover:text-foreground"
                                 >Clear</button>
                               </div>
                               <div className="space-y-0.5">
                                 {recent.map((q, i) => (
                                   <button
                                     key={i}
                                     onMouseDown={(e) => { e.preventDefault(); setSearchQuery(q); setSearchFocused(false); }}
                                     className="w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted/80 text-foreground/80 flex items-center gap-2"
                                   >
                                     <Clock className="h-3 w-3 text-muted-foreground/50 flex-shrink-0" />
                                     <span className="truncate">{q}</span>
                                   </button>
                                 ))}
                               </div>
                             </div>
                           );
                           return null;
                         })()}
                         {/* Search operators */}
                         <div>
                           <p className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider mb-1.5">Search operators</p>
                           <div className="grid grid-cols-2 gap-1">
                             {[
                               { op: 'from:', desc: 'Sender email' },
                               { op: 'to:', desc: 'Recipient' },
                               { op: 'subject:', desc: 'Subject line' },
                               { op: 'label:', desc: 'Label name' },
                               { op: 'has:attachment', desc: 'Has files' },
                             ].map(({ op, desc }) => (
                               <button
                                 key={op}
                                 onMouseDown={(e) => { e.preventDefault(); setSearchQuery(op); }}
                                 className="text-left text-xs px-2 py-1.5 rounded hover:bg-muted/80 flex items-center gap-1.5"
                               >
                                 <code className="text-[10px] bg-muted px-1 rounded font-mono text-primary">{op}</code>
                                 <span className="text-muted-foreground truncate">{desc}</span>
                               </button>
                             ))}
                           </div>
                         </div>
                         <p className="text-[10px] text-muted-foreground/60 italic">
                           Searches subject, sender, body text, labels, project names, and attachment filenames
                         </p>
                       </div>
                     )}
                </div>

                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-9 w-9" 
                  onClick={handleUndo}
                  disabled={undoStack.length === 0}
                  title={undoStack.length > 0 ? `Undo: ${undoStack[undoStack.length - 1].type}` : "Nothing to undo"}
                >
                  <span className="text-base">↶</span>
                </Button>

                <Button 
                  variant="ghost" 
                  size="icon" 
                  className="h-9 w-9" 
                  onClick={handleRedo}
                  disabled={redoStack.length === 0}
                  title={redoStack.length > 0 ? `Redo: ${redoStack[redoStack.length - 1].type}` : "Nothing to redo"}
                >
                  <span className="text-base">↷</span>
                </Button>
              </div>

              {/* Saved filter presets */}
              {(savedFilters.length > 0 || searchQuery || filterFrom || filterLabel || filterProject || showAttachmentsOnly || filterUnread) && (
                <div className="flex items-center gap-1.5 flex-wrap px-1">
                  {savedFilters.map((sf, i) => (
                    <Button
                      key={i}
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px] gap-1"
                      onClick={() => {
                        if (sf.searchQuery) setSearchQuery(sf.searchQuery);
                        if (sf.filterView) setFilterView(sf.filterView);
                        if (sf.filterFrom) setFilterFrom(sf.filterFrom);
                        if (sf.filterLabel) setFilterLabel(sf.filterLabel);
                        if (sf.filterProject) setFilterProject(sf.filterProject);
                        if (sf.filterUnread !== undefined) setFilterUnread(sf.filterUnread);
                        if (sf.showAttachmentsOnly !== undefined) setShowAttachmentsOnly(sf.showAttachmentsOnly);
                        if (sf.accountFilter) setAccountFilter(sf.accountFilter);
                      }}
                    >
                      {sf.name}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const updated = savedFilters.filter((_, j) => j !== i);
                          setSavedFilters(updated);
                          localStorage.setItem('email-saved-filters', JSON.stringify(updated));
                        }}
                        className="ml-0.5 hover:text-destructive"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </Button>
                  ))}
                  {(searchQuery || filterFrom || filterLabel || filterProject || showAttachmentsOnly || filterUnread) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-blue-600"
                      onClick={() => {
                        const name = prompt('Save current filter as:');
                        if (!name?.trim()) return;
                        const newFilter = {
                          name: name.trim(),
                          searchQuery, filterView, filterFrom, filterLabel, filterProject,
                          filterUnread, showAttachmentsOnly, accountFilter,
                        };
                        const updated = [...savedFilters, newFilter];
                        setSavedFilters(updated);
                        localStorage.setItem('email-saved-filters', JSON.stringify(updated));
                        toast.success(`Filter "${name.trim()}" saved`);
                      }}
                    >
                      + Save filter
                    </Button>
                  )}
                </div>
              )}

              {/* Pipedrive-style Filters */}
              {(filterFrom || filterLabel || filterProject) && (
                <div className="flex items-center flex-wrap gap-2">
                  {filterFrom && (
                    <div className="flex items-center gap-1.5 bg-muted/80 px-2.5 py-1 rounded-md text-xs font-medium border border-border/50 hover:border-border hover:bg-muted transition-colors">
                      <span className="text-muted-foreground">From:</span>
                      <span className="font-semibold truncate max-w-[200px]" title={filterFrom}>{filterFrom}</span>
                      <button onClick={() => setFilterFrom(null)} className="ml-0.5 hover:text-destructive transition-colors p-0.5">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {filterLabel && (
                    <div className="flex items-center gap-1.5 bg-muted/80 px-2.5 py-1 rounded-md text-xs font-medium border border-border/50 hover:border-border hover:bg-muted transition-colors">
                      <Tag className="h-3 w-3 text-muted-foreground" />
                      <span className="font-semibold">{filterLabel}</span>
                      <button onClick={() => setFilterLabel(null)} className="ml-0.5 hover:text-destructive transition-colors p-0.5">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                  {filterProject && (
                    <div className="flex items-center gap-1.5 bg-muted/80 px-2.5 py-1 rounded-md text-xs font-medium border border-border/50 hover:border-border hover:bg-muted transition-colors">
                      <Link2 className="h-3 w-3 text-muted-foreground" />
                      <span className="font-semibold">Project linked</span>
                      <button onClick={() => setFilterProject(null)} className="ml-0.5 hover:text-destructive transition-colors p-0.5">
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Filter Results Info */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
               <span className="font-semibold text-foreground/70">
                 {filteredThreads.length === totalEmailCount 
                   ? `${totalEmailCount} conversation${totalEmailCount !== 1 ? 's' : ''}` 
                   : `${filteredThreads.length} of ${totalEmailCount}`}
               </span>
               {searchQuery && <Badge variant="secondary" className="text-[10px] h-4">Search active</Badge>}
                {unreadCount > 0 && <span className="text-[10px]">• {unreadCount} unread</span>}
                {showAttachmentsOnly && <Badge variant="secondary" className="text-[10px] h-4">Attachments only</Badge>}
               </div>

               {/* Action Bar */}
               {selectedMessages.size > 0 && (
                <BulkActionBar
                  selectedCount={selectedMessages.size}
                  filteredCount={filteredThreads.length}
                  filterView={filterView}
                  threads={threads}
                  selectedMessages={selectedMessages}
                  emailAccounts={emailAccounts}
                  user={user}
                  onRefetch={refetchMessages}
                  setSelectedMessages={setSelectedMessages}
                />
               )}
            </div>

            {/* Email List — flex-1 so it fills remaining height after the header */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <EmailListContainer
                filteredThreads={filteredThreads}
                columns={columns}
                selectedMessages={selectedMessages}
                onSelectThread={(threadId) => {
                  const newSelected = new Set(selectedMessages);
                  if (newSelected.has(threadId)) {
                    newSelected.delete(threadId);
                  } else {
                    newSelected.add(threadId);
                  }
                  setSelectedMessages(newSelected);
                }}
                onSelectAll={setSelectedMessages}
                onOpenThread={(thread) => {
                  setSelectedThread(thread);
                  // Auto-mark as read when opening
                  if (thread.unreadCount > 0) {
                    const unreadMsgs = thread.messages.filter(m => m.is_unread);
                    unreadMsgs.forEach(msg => {
                      updateMessageMutation.mutate({ messageId: msg.id, updates: { is_unread: false } });
                    });
                  }
                }}
                messagesLoading={messagesLoading}
                filterUnread={filterUnread}
                searchQuery={searchQuery}
                filterView={filterView}
                onCompose={() => setShowCompose(true)}
                labelData={labelData}
                onLinkProject={(thread) => setLinkProjectThread(thread)}
                onToggleVisibility={async (thread, newVisibility) => {
                  try {
                    const msg = thread.messages[0];
                    if (!msg) return;
                    await updateMessageMutation.mutateAsync({
                      messageId: msg.id,
                      updates: { visibility: newVisibility },
                    });
                    toast.success(
                      newVisibility === 'shared'
                        ? 'Email shared with team'
                        : 'Email set to private'
                    );
                  } catch {
                    toast.error('Failed to update visibility');
                  }
                }}
                onToggleStar={async (thread) => {
                  try {
                    const msg = thread.messages[0];
                    if (!msg) return;
                    const newStarred = !thread.is_starred;
                    await updateMessageMutation.mutateAsync({
                      messageId: msg.id,
                      updates: { is_starred: newStarred },
                    });
                  } catch {
                    toast.error('Failed to update star');
                  }
                }}
                onReorderColumns={reorderColumns}
                onResizeColumn={resizeColumn}
                onContextMenu={async (thread, action) => {
                  try {
                    if (action === 'archive') {
                      await api.functions.invoke('archiveEmails', {
                        threadIds: [thread.threadId],
                        emailAccountId: thread.email_account_id,
                      });
                      toast.success('Archived');
                      refetchMessages();
                    } else if (action === 'delete') {
                      await api.functions.invoke('deleteEmails', {
                        threadIds: [thread.threadId],
                        emailAccountId: thread.email_account_id,
                      });
                      toast.success('Deleted');
                      refetchMessages();
                    }
                  } catch {
                    toast.error(`Failed to ${action} email`);
                  }
                }}
              />
            </div>
          </>
        )}
      </div>

      {/* Compose Dialog */}
       {showCompose && (
         <EmailComposeDialog
           account={selectedAccount}
           onClose={() => setShowCompose(false)}
           onSent={() => {
             setShowCompose(false);
             refetchMessages();
           }}
         />
       )}

       {/* Link Project Dialog */}
       {linkProjectThread && (
         <ProjectLinkDialogForInbox
           thread={linkProjectThread}
           open={!!linkProjectThread}
           onOpenChange={(open) => {
             if (!open) setLinkProjectThread(null);
           }}
           account={emailAccounts.find(a => a.id === linkProjectThread.email_account_id)}
         />
       )}

       {/* Keyboard Shortcuts Help */}
       <Dialog open={showKeyboardHelp} onOpenChange={setShowKeyboardHelp}>
         <DialogContent className="max-w-md">
           <DialogHeader>
             <DialogTitle>Keyboard Shortcuts</DialogTitle>
           </DialogHeader>
           <div className="grid grid-cols-2 gap-y-2 gap-x-6 text-sm">
             {[
               ['c', 'Compose new email'],
               ['r', 'Reply to thread'],
               ['/', 'Focus search bar'],
               ['j', 'Next email'],
               ['k', 'Previous email'],
               ['Enter', 'Open selected email'],
               ['x', 'Select email'],
               ['a / e', 'Archive selected'],
               ['u', 'Mark as unread'],
               ['#', 'Delete selected'],
               ['Esc', 'Close / deselect'],
               ['?', 'Show this help'],
             ].map(([key, desc]) => (
               <div key={key} className="contents">
                 <kbd className="px-2 py-0.5 bg-muted border rounded text-xs font-mono text-center w-fit">{key}</kbd>
                 <span className="text-muted-foreground">{desc}</span>
               </div>
             ))}
           </div>
         </DialogContent>
       </Dialog>
      </div>
      );
      }
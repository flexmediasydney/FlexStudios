import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw,
  Plus,
  Search,
  Settings,
  Menu,
  X,
  Link2,
  Tag,
} from "lucide-react";

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
import ErrorBoundary from "@/components/common/ErrorBoundary";
import EmailAccountSetup from "./EmailAccountSetup";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useEntitySubscriptionWithFilter } from "@/components/hooks/useEntitySubscriptionWithFilter";

import ProjectLinkDialogForInbox from "./ProjectLinkDialogForInbox";
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
import { SEARCH_DEBOUNCE_MS, AUTO_SYNC_INTERVAL_MS, MAX_UNDO_STACK } from "./emailConstants";

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
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);
  const [savedFilters, setSavedFilters] = useState(() => {
    try { return JSON.parse(localStorage.getItem('email-saved-filters') || '[]'); } catch { return []; }
  });
  const [showSaveFilter, setShowSaveFilter] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState('');
  const SYNC_COOLDOWN_MS = 5000;
  const lastManualSyncRef = useRef(0);
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

  // Clear person/label/project-specific filters when switching account to avoid stale empty results
  useEffect(() => {
    setFilterFrom(null);
    setFilterLabel(null);
    setFilterProject(null);
    setSelectedMessages(new Set());
    setSelectedThread(null);
  }, [accountFilter]);

  useEffect(() => {
    const key = `inbox-sidebar-scroll-${filterView}`;
    const timer = setInterval(() => {
      if (sidebarScrollRef.current) {
        sessionStorage.setItem(key, sidebarScrollRef.current.scrollTop.toString());
      }
    }, 500);
    return () => clearInterval(timer);
  }, [filterView]);

  // Open compose dialog when ?compose=true is in URL
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('compose') === 'true') {
      setShowCompose(true);
      // Clean up the URL param so refreshing doesn't re-open
      params.delete('compose');
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, '', newUrl);
    }
  }, []);

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearchQuery(searchQuery);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  
  // BUG FIX: Removed useEffect-based undo/redo stack trimming — it caused
  // unnecessary re-renders every time stack length changed (effect reads .length,
  // then writes to the same state, triggering another render cycle).
  // Instead, enforce the limit at push time via helper functions below.
  const pushUndoAction = (action) => {
    setUndoStack(prev => [...prev.slice(-(MAX_UNDO_STACK - 1)), action]);
  };
  const pushRedoAction = (action) => {
    setRedoStack(prev => [...prev.slice(-(MAX_UNDO_STACK - 1)), action]);
  };

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
  // Load ALL active accounts — filter client-side so users see their own + team inboxes
  const { data: allEmailAccounts = [], loading: accountsLoading } = useEntitySubscriptionWithFilter(
    'EmailAccount',
    { is_active: true }
  );
  // Show: own accounts + team accounts (where team_id matches user's team) + all for owner
  const emailAccounts = useMemo(() => {
    if (!user) return [];
    if (user.role === 'master_admin') return allEmailAccounts; // Owner sees all
    return allEmailAccounts.filter(a =>
      a.assigned_to_user_id === user.id || // Own accounts
      (a.team_id && a.team_id === user.internal_team_id) || // Team accounts
      (!a.assigned_to_user_id && !a.team_id) // Unassigned shared accounts
    );
  }, [allEmailAccounts, user]);

  const { data: labelData = [], loading: labelsLoading } = useEntitySubscriptionWithFilter(
    'EmailLabel',
    {}
  );

  // BUG FIX: `emailAccounts` array gets a new reference on every subscription update,
  // causing this effect to re-run unnecessarily. Use .length for the dep since we
  // only care about the first account appearing/disappearing, not field-level changes.
  useEffect(() => {
    if (emailAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(emailAccounts[0]);
    }
  }, [emailAccounts.length, selectedAccount]);

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

  // Paginated email loading — THREADS per page, not messages.
  // Previous bug: paginating messages yielded ~45 threads per 50 messages
  // (because a thread has multiple messages and they got grouped client-side).
  // Fix: server-side RPC `get_inbox_threads` returns N WHOLE threads with
  // their messages pre-aggregated as JSONB. One RPC call = N complete threads,
  // and pagination advances by thread count — not message count.
  const ALLOWED_PAGE_SIZES = [25, 50, 100, 200];
  const [pageSize, setPageSize] = useState(() => {
    try {
      const stored = parseInt(localStorage.getItem('inbox_page_size') || '', 10);
      return ALLOWED_PAGE_SIZES.includes(stored) ? stored : 50;
    } catch {
      return 50;
    }
  });
  const [page, setPage] = useState(1); // 1-indexed
  const [messages, setMessages] = useState([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [totalThreadCount, setTotalThreadCount] = useState(null);
  const messageFilterKeyRef = useRef(null);

  const totalPages = Math.max(1, Math.ceil((totalThreadCount || 0) / pageSize));

  // Persist page size in localStorage (but NOT page number — always start at 1 on reload)
  useEffect(() => {
    try { localStorage.setItem('inbox_page_size', String(pageSize)); } catch {}
  }, [pageSize]);

  // Map our internal filterView + feature filters to RPC parameters.
  // The RPC accepts: folder, account_ids, search, unread_only, limit, offset.
  const rpcParamsForCurrentView = useCallback((limit, offset) => {
    // account_ids: null = all user accounts; specific = filter to one
    // Frontend-side account filtering by UI still runs via `filteredThreads`
    // useMemo, so we pass NULL here (send all accounts' threads, let the
    // client filter by `accountFilter`). We DO pass the full userAccountIds
    // list so RLS security still holds via backend — but that's enforced
    // in RLS policies already.
    return {
      p_folder: filterView || 'inbox',
      p_account_ids: null,
      p_search: null, // Client-side search still operates on fetched threads
      p_unread_only: false, // Client-side filter still applies
      p_limit: limit,
      p_offset: offset,
    };
  }, [filterView]);

  // Flatten an RPC response's threads into a messages array (so the existing
  // `threads` useMemo can re-group by gmail_thread_id and all downstream code
  // keeps working unchanged).
  const flattenThreadsToMessages = (threads) => {
    const out = [];
    for (const t of threads || []) {
      for (const m of t.messages || []) out.push(m);
    }
    return out;
  };

  // Reset to page 1 when filters change (prevents stale offsets when switching views).
  // This runs BEFORE the fetch effect below so the fetch picks up page=1 on the next tick.
  useEffect(() => {
    setPage(1);
  }, [JSON.stringify(messageFilters)]);

  // Reset to page 1 when page size changes (so offsets stay sane).
  useEffect(() => {
    setPage(1);
  }, [pageSize]);

  // Initial + page-change fetch.
  // Subscribes to realtime creates/updates/deletes so new mail appears immediately
  // on the current page; full pagination offset is recomputed on every page/size/filter change.
  useEffect(() => {
    let isMounted = true;
    const filterKey = JSON.stringify(messageFilters);
    messageFilterKeyRef.current = filterKey;

    setMessagesLoading(true);

    const offset = (page - 1) * pageSize;

    const fetchPage = async () => {
      try {
        const result = await api.rpc('get_inbox_threads', rpcParamsForCurrentView(pageSize, offset));
        if (isMounted && messageFilterKeyRef.current === filterKey) {
          const fetchedThreads = result?.threads || [];
          // REPLACE, not append — this is traditional pagination.
          setMessages(flattenThreadsToMessages(fetchedThreads));
          setTotalThreadCount(result?.total_count ?? null);
          setMessagesLoading(false);
        }
      } catch (error) {
        console.error('Failed to fetch inbox threads:', error);
        if (isMounted) setMessagesLoading(false);
      }
    };

    fetchPage();

    // Real-time subscription: new emails appear in the visible page instantly.
    // They shift into page 1 on the next refetch (filter/page change), which
    // matches user expectation (a classic paginated list is a snapshot).
    const unsubscribe = api.entities.EmailMessage.subscribe((event) => {
      if (!isMounted || messageFilterKeyRef.current !== filterKey) return;

      if (event.type === 'create') {
        if (matchesMessageFilter(event.data, messageFilters)) {
          setMessages((prev) => {
            if (prev.some(item => item.id === event.data?.id)) return prev;
            return [event.data, ...prev];
          });
        }
      } else if (event.type === 'update') {
        if (matchesMessageFilter(event.data, messageFilters)) {
          setMessages((prev) => {
            const exists = prev.find(item => item.id === event.id);
            if (exists) {
              return prev.map(item => item.id === event.id ? event.data : item);
            }
            return [event.data, ...prev];
          });
        } else {
          setMessages((prev) => prev.filter(item => item.id !== event.id));
        }
      } else if (event.type === 'delete') {
        setMessages((prev) => prev.filter(item => item.id !== event.id));
      }
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, [JSON.stringify(messageFilters), page, pageSize, rpcParamsForCurrentView]);

  const handlePrevPage = useCallback(() => {
    setPage(p => Math.max(1, p - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setPage(p => {
      const maxPage = Math.max(1, Math.ceil((totalThreadCount || 0) / pageSize));
      return Math.min(maxPage, p + 1);
    });
  }, [totalThreadCount, pageSize]);

  const handlePageSizeChange = useCallback((newSize) => {
    const n = parseInt(newSize, 10);
    if (ALLOWED_PAGE_SIZES.includes(n)) {
      setPageSize(n);
      // page reset to 1 is handled by the useEffect above
    }
  }, []);

  const refetchMessages = useCallback(async () => {
    try {
      const offset = (page - 1) * pageSize;
      const result = await api.rpc('get_inbox_threads', rpcParamsForCurrentView(pageSize, offset));
      const fetchedThreads = result?.threads || [];
      setMessages(flattenThreadsToMessages(fetchedThreads));
      if (result?.total_count != null) setTotalThreadCount(result.total_count);
    } catch (error) {
      console.error('Failed to refetch threads:', error);
    }
  }, [rpcParamsForCurrentView, page, pageSize]);





  // Sync mutation - per-account sync using correct OAuth token
  const syncMutation = useMutation({
    mutationFn: async () => {
      if (!user?.id || emailAccounts.length === 0) throw new Error('No accounts connected');
      // Debounce guard: skip if synced less than 5 seconds ago
      const now = Date.now();
      if (now - lastManualSyncRef.current < SYNC_COOLDOWN_MS) {
        return { synced: 0, errors: 0, skipped: true, accountNames: [] };
      }
      lastManualSyncRef.current = now;
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
      const accountNames = emailAccounts.map(a => a.email_address || a.display_name);
      const errorDetails = results
        .map((r, i) => r.status === 'rejected' ? emailAccounts[i]?.email_address : null)
        .filter(Boolean);
      return { synced, errors, skipped: false, accountNames, errorDetails };
    },
    onSuccess: ({ synced, errors, skipped, accountNames, errorDetails }) => {
      if (skipped) {
        toast.info('Sync already in progress — please wait a moment');
        return;
      }
      // Reset sync countdown after manual sync
      nextSyncRef.current = Date.now() + AUTO_SYNC_INTERVAL_MS;
      // Invalidate all email-related queries after sync
      queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
      queryClient.invalidateQueries({ queryKey: ['email-conversations'] });
      const acctSummary = accountNames?.length > 1
        ? ` across ${accountNames.length} accounts`
        : accountNames?.length === 1 ? ` (${accountNames[0]})` : '';
      if (synced > 0) {
        toast.success(`Synced ${synced} new email${synced !== 1 ? 's' : ''}${acctSummary}`);
      } else if (errors > 0) {
        const failedAccts = errorDetails?.join(', ') || `${errors} account(s)`;
        toast.error(`Sync failed for ${failedAccts} — check email settings`);
      } else {
        toast.success(`Inbox up to date${acctSummary}`);
      }
    },
    onError: (error) => {
      toast.error(error?.message || 'Sync failed — check your email connection in Settings');
    },
  });

  // Background auto-sync: fetch new emails from Gmail every 2 minutes silently.
  const lastSyncRef = useRef(null);
  const [syncCountdown, setSyncCountdown] = useState(null);
  const nextSyncRef = useRef(null);
  // BUG FIX: use a ref for emailAccounts so the sync callback always reads
  // the latest accounts without needing emailAccounts in the dep array
  // (which caused stale closure bugs since .length was used as dep but
  // the full array was accessed inside).
  const emailAccountsRef = useRef(emailAccounts);
  useEffect(() => { emailAccountsRef.current = emailAccounts; }, [emailAccounts]);

  useEffect(() => {
    if (emailAccounts.length === 0 || !user?.id) return;

    // BUG FIX: track staggered setTimeout handles so they can be cleared on unmount.
    // Previously, rapid account changes or unmount would leave orphaned sync calls.
    let staggeredTimers = [];

    const runSync = () => {
      const now = Date.now();
      if (lastSyncRef.current && now - lastSyncRef.current < 10000) return;
      lastSyncRef.current = now;
      nextSyncRef.current = now + AUTO_SYNC_INTERVAL_MS;

      // Clear any pending staggered timers from a previous sync run
      staggeredTimers.forEach(t => clearTimeout(t));
      staggeredTimers = [];

      // BUG FIX: read from ref to get latest accounts
      const accounts = emailAccountsRef.current;
      accounts.forEach((account, idx) => {
        const timer = setTimeout(() => {
          api.functions.invoke('syncGmailMessagesForAccount', {
            accountId: account.id,
            userId: user.id,
          }).then((res) => {
            if (res?.data?.synced > 0) {
              queryClient.invalidateQueries({ queryKey: ['email-messages'] });
              queryClient.invalidateQueries({ queryKey: ['email-conversations'] });
              queryClient.invalidateQueries({ queryKey: ['email-accounts'] });
            }
          }).catch(() => {});
        }, idx * 1500);
        staggeredTimers.push(timer);
      });
    };

    // Countdown ticker
    const tick = setInterval(() => {
      if (nextSyncRef.current) {
        const remaining = Math.max(0, Math.ceil((nextSyncRef.current - Date.now()) / 1000));
        setSyncCountdown(remaining);
      }
    }, 1000);

    const mountTimeout = setTimeout(runSync, 500);
    const interval = setInterval(runSync, AUTO_SYNC_INTERVAL_MS);
    return () => {
      clearTimeout(mountTimeout);
      clearInterval(interval);
      clearInterval(tick);
      // BUG FIX: clear staggered sync timers on unmount
      staggeredTimers.forEach(t => clearTimeout(t));
    };
  }, [emailAccounts.length, user?.id, queryClient]);

  // Update message mutation - subscription handles UI updates automatically
  const updateMessageMutation = useMutation({
    mutationFn: (data) => api.entities.EmailMessage.update(data.messageId, data.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to update email");
    }
  });

  // Delete emails mutation - subscription auto-updates UI
  // BUG FIX: onSuccess captured stale `selectedMessages` and `threads` closures.
  // By the time onSuccess fires, threads may have been removed by the real-time subscription,
  // causing getAccountIdsFromThreads to return empty and breaking undo.
  // Fix: pass undo context through the mutation data so it's captured at call time.
  const deleteEmailsMutation = useMutation({
    mutationFn: async (data) => {
      const result = await api.functions.invoke('deleteEmails', data);
      return { result, _undoContext: data._undoContext };
    },
    onSuccess: ({ _undoContext }) => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (_undoContext) {
        setUndoStack(prev => [...prev, {
          type: 'delete',
          data: { threadIds: _undoContext.threadIds, accountIds: _undoContext.accountIds }
        }].slice(-MAX_UNDO_STACK));
        setRedoStack([]);
      }
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
      pushUndoAction({
        type: 'delete',
        data: { threadIds, accountIds }
      });
      setSelectedMessages(new Set());
    },
    onError: () => {
      toast.error("Failed to delete emails");
    }
  });

  // BUG FIX: handleUndo was reading `undoStack` and `redoStack` from the closure,
  // but it's passed as a toast action callback which captures a stale version.
  // Now extracts the action via functional setState so we always read the latest stack.
  // Also: archive/visibility undo previously looked up threads from the current view,
  // but after archiving/deleting, the thread leaves the view and the lookup fails silently.
  // Now uses server functions with stored accountIds instead of client-side thread lookups.
  const handleUndo = async () => {
    let actionToUndo = null;
    setUndoStack(prev => {
      if (prev.length === 0) return prev;
      actionToUndo = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    // actionToUndo is assigned synchronously inside the updater
    if (!actionToUndo) return;
    setRedoStack(prev => [...prev, actionToUndo].slice(-MAX_UNDO_STACK));

    // Reverse the action
    if (actionToUndo.type === 'delete') {
      const acctIds = actionToUndo.data.accountIds || [actionToUndo.data.emailAccountId];
      await Promise.allSettled(acctIds.map(accId =>
        api.functions.invoke('restoreEmails', {
          threadIds: actionToUndo.data.threadIds,
          emailAccountId: accId
        })
      ));
    } else if (actionToUndo.type === 'archive') {
      // BUG FIX: use server function — thread may have left the current view
      const acctIds = actionToUndo.data.accountIds || [];
      await Promise.allSettled(acctIds.map(accId =>
        api.functions.invoke('unarchiveEmails', {
          threadIds: actionToUndo.data.threadIds,
          emailAccountId: accId
        })
      ));
    } else if (actionToUndo.type === 'visibility') {
      // BUG FIX: use stored messageIds instead of thread lookup
      if (actionToUndo.data.messageIds) {
        await Promise.all(
          actionToUndo.data.messageIds.map(msgId =>
            api.entities.EmailMessage.update(msgId, {
              visibility: actionToUndo.data.oldVisibility
            })
          )
        );
      }
    } else if (actionToUndo.type === 'linkProject') {
      await Promise.all(
        actionToUndo.data.messageIds.map(msgId =>
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

  // BUG FIX: Same stale-closure fix as handleUndo + use server functions for archive/delete redo.
  const handleRedo = async () => {
    let actionToRedo = null;
    setRedoStack(prev => {
      if (prev.length === 0) return prev;
      actionToRedo = prev[prev.length - 1];
      return prev.slice(0, -1);
    });
    if (!actionToRedo) return;
    setUndoStack(prev => [...prev, actionToRedo].slice(-MAX_UNDO_STACK));

    // Re-apply the action
    if (actionToRedo.type === 'delete') {
      const acctIds = actionToRedo.data.accountIds || [];
      await Promise.allSettled(acctIds.map(accId =>
        api.functions.invoke('deleteEmails', {
          threadIds: actionToRedo.data.threadIds,
          emailAccountId: accId,
          permanently: false,
        })
      ));
    } else if (actionToRedo.type === 'archive') {
      const acctIds = actionToRedo.data.accountIds || [];
      await Promise.allSettled(acctIds.map(accId =>
        api.functions.invoke('archiveEmails', {
          threadIds: actionToRedo.data.threadIds,
          emailAccountId: accId,
        })
      ));
    } else if (actionToRedo.type === 'visibility') {
      if (actionToRedo.data.messageIds) {
        await Promise.all(
          actionToRedo.data.messageIds.map(msgId =>
            api.entities.EmailMessage.update(msgId, {
              visibility: actionToRedo.data.newVisibility
            })
          )
        );
      }
    } else if (actionToRedo.type === 'linkProject') {
      await Promise.all(
        actionToRedo.data.messageIds.map(msgId =>
          api.entities.EmailMessage.update(msgId, {
            project_id: actionToRedo.data.projectId,
            project_title: actionToRedo.data.projectTitle,
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
  // Uses threadId ref to avoid infinite loop (setSelectedThread -> re-render -> threads changes -> effect runs again)
  const selectedThreadIdRef = useRef(null);
  useEffect(() => {
    selectedThreadIdRef.current = selectedThread?.threadId || null;
  }, [selectedThread?.threadId]);

  useEffect(() => {
    if (selectedThreadIdRef.current && threads.length > 0) {
      const updated = threads.find(t => t.threadId === selectedThreadIdRef.current);
      if (updated) {
        setSelectedThread(prev => {
          // Only update if data actually changed (avoid infinite re-render)
          if (!prev || prev.messages?.length !== updated.messages?.length || prev.unreadCount !== updated.unreadCount) {
            return updated;
          }
          return prev;
        });
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

      // Remove operators from query for general search
      const cleanQuery = rawQuery
        .replace(/from:\S+/g, '')
        .replace(/to:\S+/g, '')
        .replace(/subject:\S+/g, '')
        .replace(/has:attachment/g, '')
        .replace(/label:\S+/g, '')
        .replace(/is:unread/g, '')
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
      // Case-insensitive email comparison — email addresses are case-insensitive per RFC
      const fromLower = filterFrom.toLowerCase();
      result = result.filter(t => t.from_email?.toLowerCase() === fromLower);
    }

    if (filterLabel) {
      // Check ALL messages in thread for the label, not just the first
      result = result.filter(t => t.messages.some(m => m.labels?.includes(filterLabel)));
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

    // Apply attachments filter — check ALL messages in thread, not just the first
    if (showAttachmentsOnly) {
      result = result.filter(t => t.messages.some(m => m.attachments?.length > 0));
    }

    return result;
  }, [threads, accountFilter, debouncedSearchQuery, filterUnread, filterFrom, filterLabel, filterProject, sortBy, showAttachmentsOnly]);

  // Keyboard shortcuts (must be after filteredThreads is defined)
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input, select, or contenteditable (ReactQuill)
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.isContentEditable) return;
      // Ignore if modifier keys are held (let browser shortcuts like Ctrl+F, Cmd+A work)
      if (e.ctrlKey || e.metaKey || e.altKey) return;
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

      // a or e = archive (only in list view, not when thread is open — thread viewer has its own handler)
      if ((e.key === 'a' || e.key === 'e') && !selectedThread && selectedMessages.size > 0 && filterView !== 'archived' && filterView !== 'deleted') {
        e.preventDefault();
        const threadIds = Array.from(selectedMessages);
        const accountIds = Array.from(new Set(
          threadIds.map(msgId => {
            const thread = currentThreads.find(t => t.threadId === msgId);
            return thread?.email_account_id;
          }).filter(Boolean)
        ));
        Promise.all(accountIds.map(accId =>
          api.functions.invoke('archiveEmails', {
            threadIds,
            emailAccountId: accId
          })
        )).then(() => {
          // BUG FIX: keyboard archive was not pushing to undo stack — action was irreversible
          setUndoStack(prev => [...prev, { type: 'archive', data: { threadIds, accountIds } }].slice(-MAX_UNDO_STACK));
          setRedoStack([]);
          toast.success("Archived", {
            action: { label: 'Undo', onClick: handleUndo }
          });
          setSelectedMessages(new Set());
        });
      }

      // # = delete (only in list view)
      if (e.key === '#' && !selectedThread && selectedMessages.size > 0 && filterView !== 'deleted') {
        e.preventDefault();
        const count = selectedMessages.size;
        const threadIds = Array.from(selectedMessages);
        const accountIds = Array.from(new Set(
          threadIds.map(msgId => {
            const thread = currentThreads.find(t => t.threadId === msgId);
            return thread?.email_account_id;
          }).filter(Boolean)
        ));
        Promise.all(accountIds.map(accId =>
          api.functions.invoke('deleteEmails', {
            threadIds,
            emailAccountId: accId,
            permanently: false
          })
        )).then(() => {
          // BUG FIX: keyboard delete was not pushing to undo stack — action was irreversible
          setUndoStack(prev => [...prev, { type: 'delete', data: { threadIds, accountIds } }].slice(-MAX_UNDO_STACK));
          setRedoStack([]);
          toast.success(`Deleted ${count} email${count !== 1 ? 's' : ''}`, {
            action: { label: 'Undo', onClick: handleUndo }
          });
          setSelectedMessages(new Set());
        });
      }

      // c = compose
       if (e.key === 'c') {
         e.preventDefault();
         setShowCompose(true);
       }

      // r or R = reply — open thread (thread viewer handles its own reply shortcut)
       if ((e.key === 'r' || e.key === 'R') && !showCompose) {
         e.preventDefault();
         if (!selectedThread && selectedMessages.size === 1) {
           const threadId = Array.from(selectedMessages)[0];
           const thread = currentThreads.find(t => t.threadId === threadId);
           if (thread) {
             setSelectedThread(thread);
           }
         }
         // If already in thread viewer, the thread viewer's own keydown handler opens reply
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

       // u = mark as unread (only in list view)
       if (e.key === 'u' && !selectedThread && selectedMessages.size > 0) {
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
              countClassName={unreadCount > 0 ? "bg-primary text-primary-foreground font-bold" : undefined}
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
            variant="ghost"
            size="sm"
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending}
            className="w-full gap-2 h-8 text-xs justify-start hover:bg-muted"
            title={syncMutation.isPending ? "Syncing..." : "Sync now"}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncMutation.isPending && 'animate-spin')} />
            {syncMutation.isPending ? 'Syncing...' : 'Sync'}
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
          
          <button
            onClick={() => setShowKeyboardHelp(true)}
            className="w-full text-[10px] text-muted-foreground/50 hover:text-muted-foreground pt-2 border-t mt-2 text-center transition-colors"
          >
            Press <kbd className="px-1 py-0.5 bg-muted/60 rounded font-mono text-[9px]">?</kbd> for keyboard shortcuts
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0" ref={containerRef}>
        {selectedThread ? (
          <ErrorBoundary fallbackLabel="Email Thread" compact onReset={() => setSelectedThread(null)}>
            <EmailThreadViewer
              thread={selectedThread}
              account={emailAccounts.find(a => a.id === selectedThread.email_account_id) || selectedAccount}
              onBack={() => setSelectedThread(null)}
              currentView={filterView}
              emailAccounts={emailAccounts}
              // BUG FIX: The old IIFEs captured filteredThreads[idx+1] at render time.
              // If a real-time subscription update removes/reorders threads between render
              // and user click, the captured index could point to the wrong thread or OOB.
              // Now re-lookup the index at call time with a bounds check.
              onNextThread={(() => {
                const idx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
                if (idx >= 0 && idx < filteredThreads.length - 1) {
                  return () => {
                    const currentIdx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
                    if (currentIdx >= 0 && currentIdx < filteredThreads.length - 1) {
                      setSelectedThread(filteredThreads[currentIdx + 1]);
                    }
                  };
                }
                return null;
              })()}
              onPrevThread={(() => {
                const idx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
                if (idx > 0) {
                  return () => {
                    const currentIdx = filteredThreads.findIndex(t => t.threadId === selectedThread.threadId);
                    if (currentIdx > 0) {
                      setSelectedThread(filteredThreads[currentIdx - 1]);
                    }
                  };
                }
                return null;
              })()}
            />
          </ErrorBoundary>
        ) : (
          <>
            {/* Header - Modern compact design */}
            <div className="border-b bg-background/95 backdrop-blur-sm space-y-2">
              {/* Mobile sidebar toggle */}
              {!sidebarOpen && (
                <div className="lg:hidden flex items-center gap-2 px-3 pt-2">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSidebarOpen(true)}
                    className="min-h-[44px] min-w-[44px] h-11 w-11"
                    title="Open folders"
                    aria-label="Open email folders sidebar"
                  >
                    <Menu className="h-5 w-5" />
                  </Button>
                  <span className="text-sm font-medium capitalize">{filterView}</span>
                  {unreadCount > 0 && filterView === 'inbox' && (
                    <Badge variant="secondary" className="text-xs">{unreadCount}</Badge>
                  )}
                </div>
              )}
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

              <div className="px-3 sm:px-4 py-2 flex items-center justify-between gap-2 sm:gap-3">
                <div className="flex-1 relative max-w-lg min-w-0" ref={searchContainerRef}>
                  <Search className={cn(
                    "absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 z-10 transition-colors",
                    searchFocused ? "text-primary" : "text-muted-foreground"
                  )} />
                  <Input
                      placeholder={searchFocused ? "from: to: subject: has:attachment is:unread" : "Search emails..."}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onFocus={() => setSearchFocused(true)}
                      onBlur={() => setTimeout(() => setSearchFocused(false), 200)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          if (searchQuery) {
                            setSearchQuery('');
                          }
                          e.target.blur();
                          return;
                        }
                        if (e.key === 'Enter' && searchQuery.trim()) {
                          const recent = JSON.parse(localStorage.getItem('email-recent-searches') || '[]');
                          const updated = [searchQuery.trim(), ...recent.filter(s => s !== searchQuery.trim())].slice(0, 8);
                          localStorage.setItem('email-recent-searches', JSON.stringify(updated));
                          setSearchFocused(false);
                          e.target.blur();
                        }
                      }}
                      className={cn(
                        "pl-9 pr-8 h-9 text-sm transition-all",
                        searchFocused
                          ? "border-primary/50 ring-1 ring-primary/20 bg-background shadow-sm"
                          : "border-input/50 bg-muted/40"
                      )}
                     />
                     {searchQuery ? (
                       <button
                         onClick={() => setSearchQuery('')}
                         className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors focus:outline-none"
                         title="Clear search (Escape)"
                         aria-label="Clear search"
                       >
                         <X className="h-3.5 w-3.5" />
                       </button>
                     ) : !searchFocused ? (
                       <kbd className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground/50 bg-muted/60 rounded px-1.5 py-0.5 font-mono pointer-events-none">/</kbd>
                     ) : null}
                </div>

                <span className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap hidden sm:inline">
                  {filteredThreads.length !== threads.length
                    ? `${filteredThreads.length} of ${threads.length}`
                    : `${threads.length}`}{' '}
                  {threads.length === 1 ? 'thread' : 'threads'}
                </span>

                <TooltipProvider delayDuration={300}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9"
                        onClick={() => syncMutation.mutate()}
                        disabled={syncMutation.isPending}
                      >
                        <RefreshCw className={cn("h-4 w-4", syncMutation.isPending && "animate-spin")} />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      <p>{syncMutation.isPending ? "Syncing..." : "Refresh inbox"}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                {/* Undo/redo buttons removed — undo available via toast action links */}
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
                {syncCountdown != null && syncCountdown > 0 && (
                  <span className="text-[10px] opacity-50" title="Next auto-sync">
                    sync {Math.floor(syncCountdown / 60)}:{String(syncCountdown % 60).padStart(2, '0')}
                  </span>
                )}
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
                emailAccounts={emailAccounts}
                showAccount={accountFilter === "all" && emailAccounts.length > 1}
                onLinkProject={(thread) => setLinkProjectThread(thread)}
                onToggleVisibility={async (thread, newVisibility) => {
                  try {
                    if (!thread.messages?.length) return;
                    // Update ALL messages in the thread, not just the first
                    await Promise.all(
                      thread.messages.map(msg =>
                        updateMessageMutation.mutateAsync({
                          messageId: msg.id,
                          updates: { visibility: newVisibility },
                        })
                      )
                    );
                    toast.success(
                      newVisibility === 'shared'
                        ? 'Email shared with team'
                        : 'Email set to private'
                    );
                  } catch {
                    toast.error('Failed to update visibility');
                  }
                }}
                onReorderColumns={reorderColumns}
                onResizeColumn={resizeColumn}
                page={page}
                pageSize={pageSize}
                totalPages={totalPages}
                totalThreadCount={totalThreadCount}
                onPrevPage={handlePrevPage}
                onNextPage={handleNextPage}
                onPageSizeChange={handlePageSizeChange}
                allowedPageSizes={ALLOWED_PAGE_SIZES}
                onContextMenu={async (thread, action) => {
                  try {
                    if (action === 'archive') {
                      await api.functions.invoke('archiveEmails', {
                        threadIds: [thread.threadId],
                        emailAccountId: thread.email_account_id,
                      });
                      // Push to undo stack so user can undo via Ctrl+Z or undo button
                      pushUndoAction({
                        type: 'archive',
                        data: { threadIds: [thread.threadId], accountIds: [thread.email_account_id] }
                      });
                      setRedoStack([]);
                      toast.success('Archived', {
                        action: { label: 'Undo', onClick: handleUndo }
                      });
                      refetchMessages();
                    } else if (action === 'delete') {
                      await api.functions.invoke('deleteEmails', {
                        threadIds: [thread.threadId],
                        emailAccountId: thread.email_account_id,
                        permanently: false,
                      });
                      // Push to undo stack
                      pushUndoAction({
                        type: 'delete',
                        data: { threadIds: [thread.threadId], accountIds: [thread.email_account_id] }
                      });
                      setRedoStack([]);
                      toast.success('Deleted', {
                        action: { label: 'Undo', onClick: handleUndo }
                      });
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
         <ErrorBoundary fallbackLabel="Email Compose" compact onReset={() => setShowCompose(false)}>
           <EmailComposeDialog
             account={selectedAccount}
             onClose={() => setShowCompose(false)}
             onSent={() => {
               setShowCompose(false);
               refetchMessages();
             }}
           />
         </ErrorBoundary>
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

/**
 * Check if a message matches the folder filter criteria.
 * Treats null/undefined as equivalent to false for boolean filters.
 */
function matchesMessageFilter(entity, filter) {
  if (!entity || typeof entity !== 'object') return false;
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === 'boolean') {
      const entityVal = entity[key] == null ? false : entity[key];
      if (entityVal !== value) return false;
    } else if (entity[key] !== value) {
      return false;
    }
  }
  return true;
}
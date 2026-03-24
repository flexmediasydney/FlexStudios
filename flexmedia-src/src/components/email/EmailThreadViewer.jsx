import { useState, useEffect, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { 
  ArrowLeft, Reply, ReplyAll, Forward, Archive, Trash2,
  MoreVertical, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  Lock, Users, Copy, Clock, ChevronsUpDown,
  Loader2, Eye, EyeOff, RefreshCw, AlertCircle, Printer, Link2
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatEmailDateTime, formatFileSize } from "./emailDateUtils";

import { sanitizeEmailHtml as _baseSanitize } from '@/utils/sanitizeHtml';

// Wrap centralized sanitizer with email-specific auto-linking and target enforcement
const sanitizeEmailHtml = (html) => {
  if (!html) return '';
  let clean = _baseSanitize(html);
  // Auto-link plain text URLs that aren't already inside <a> tags
  clean = clean.replace(
    /(?<![="'>])(https?:\/\/[^\s<>"']+)/gi,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  );
  // Ensure ALL links open in new tab (some emails have <a> without target)
  clean = clean.replace(/<a\s(?![^>]*target=)/gi, '<a target="_blank" rel="noopener noreferrer" ');
  return clean;
};
import { toast } from "sonner";
import EmailComposeReply from "./EmailComposeReply";
import EmailComposeDialog from "./EmailComposeDialog";
import ProjectLinkDialog from "./ProjectLinkDialog";
import LabelSelectorRobust from "./LabelSelectorRobust";
import LabelBadge from "./LabelBadge";
import EmailHeaderInfo from "./EmailHeaderInfo";
import EmailDetailSidebar from "./EmailDetailSidebar";
import PrioritySelector from "./PrioritySelector";
import EmailActivityLog from "./EmailActivityLog";
import EmailOpenStats from "./EmailOpenStats";
import EmailLinkStats from "./EmailLinkStats";
import SnoozeDialog from "./SnoozeDialog";
import QuickReplyTemplates from "./QuickReplyTemplates";
import ContactInfoCard from "./ContactInfoCard";

export default function EmailThreadViewer({ thread, account, onBack, currentView = 'inbox', emailAccounts = [], onNextThread, onPrevThread }) {
  const [showReply, setShowReply] = useState(false);
  const [showProjectLink, setShowProjectLink] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [replyMode, setReplyMode] = useState('reply'); // 'reply' | 'replyAll'
  const [replyToMessage, setReplyToMessage] = useState(null); // specific message to reply to
  const [expandedMessages, setExpandedMessages] = useState(() => {
    const lastId = thread.messages[thread.messages.length - 1]?.id;
    return lastId ? new Set([lastId]) : new Set();
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('email-sidebar-collapsed') === 'true'; } catch { return false; }
  });
  const [showRaw, setShowRaw] = useState(false);
  const [collapseOldQuotes, setCollapseOldQuotes] = useState(true);
  const [showSnoozeDialog, setShowSnoozeDialog] = useState(false);
  const [quickReplyBody, setQuickReplyBody] = useState('');
  const [showForward, setShowForward] = useState(false);
  const queryClient = useQueryClient();
  const latestMessageRef = useRef(null);
  const containerRef = useRef(null);

  // Auto-scroll to latest message on thread open
  useEffect(() => {
    if (latestMessageRef.current) {
      latestMessageRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [thread.threadId]);
  const { data: user } = useQuery({
    queryKey: ['current-user'],
    queryFn: () => api.auth.me()
  });

  // Subscribe to real-time updates for all messages in this thread
  const messageIds = thread.messages.map(m => m.id);
  const [liveMessages, setLiveMessages] = useState(thread.messages);

  // Reset state when navigating between threads (J/K keys)
  useEffect(() => {
    const lastId = thread.messages[thread.messages.length - 1]?.id;
    setExpandedMessages(lastId ? new Set([lastId]) : new Set());
    setLiveMessages(thread.messages);
    setReplyExpanded(false);
    setReplyMode('reply');
    setReplyToMessage(null);
    setShowForward(false);
    setShowRaw(false);
  }, [thread.threadId]);

  useEffect(() => {
    // Verify user owns this account (critical security check)
    if (!user || !account) return;
    
    if (account.assigned_to_user_id !== user.id) {
      toast.error("Unauthorized: You do not own this email account");
      onBack();
      return;
    }

    // Subscribe to EmailMessage updates — handle updates to existing messages,
    // new messages arriving in this thread (e.g., new reply), AND deletions.
    //
    // BUG FIX (subscription audit): DELETE events were ignored because the guard
    // `if (!event.data) return` exits early — Supabase sends data: null for DELETEs.
    // Messages deleted server-side stayed visible in the thread viewer.
    const unsubscribe = api.entities.EmailMessage.subscribe((event) => {
      if (!event) return;

      // BUG FIX: handle DELETE events (event.data is null for deletes)
      if (event.type === 'delete') {
        const deletedId = event.data?.id || event.id;
        setLiveMessages(prev => prev.filter(m => m.id !== deletedId));
        return;
      }

      if (!event.data) return;
      const data = event.data;

      setLiveMessages(prevMessages => {
        const existingIndex = prevMessages.findIndex(m => m.id === event.id);
        if (existingIndex >= 0) {
          // Update existing message
          const updated = [...prevMessages];
          updated[existingIndex] = data;
          return updated;
        }
        // New message — add it if it belongs to this thread and account
        if (data.gmail_thread_id === thread.threadId && data.email_account_id === thread.email_account_id) {
          // Prevent duplicates from race between fetch and subscription
          if (prevMessages.some(m => m.id === data.id)) return prevMessages;
          return [...prevMessages, data];
        }
        return prevMessages;
      });
    });

    return unsubscribe;
  }, [thread.threadId, thread.email_account_id, user?.id, account?.assigned_to_user_id]);

  // Use live messages, sorted by received_at (slice to avoid mutating state)
  const freshThread = {
    ...thread,
    messages: [...liveMessages].sort((a, b) => new Date(a.received_at) - new Date(b.received_at))
  };

  // Use the latest message as the canonical source for labels, priority, visibility, and actions.
  // messages are sorted oldest→newest (ascending received_at), so last index = most recent.
  const msg = freshThread.messages[freshThread.messages.length - 1];

  const copyEmail = (email) => {
    navigator.clipboard.writeText(email);
    toast.success(`Copied ${email}`);
  };

  const markAsReadMutation = useMutation({
    mutationFn: () => api.functions.invoke('markEmailsAsRead', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'marked_read',
          old_value: 'unread',
          new_value: 'read',
          description: 'Email marked as read'
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Marked as read");
    },
    onError: () => toast.error("Failed to mark as read")
  });

  const markAsUnreadMutation = useMutation({
    mutationFn: () => api.functions.invoke('markEmailsAsUnread', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'marked_unread',
          old_value: 'read',
          new_value: 'unread',
          description: 'Email marked as unread'
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Marked as unread");
    },
    onError: () => toast.error("Failed to mark as unread")
  });

  const archiveEmailMutation = useMutation({
    mutationFn: () => api.functions.invoke('archiveEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'archived',
          description: 'Email archived'
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Archived");
      onBack();
    },
    onError: () => toast.error("Failed to archive")
  });

  const restoreEmailMutation = useMutation({
    mutationFn: () => api.functions.invoke('restoreEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'restored',
          description: 'Email restored to inbox'
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Restored to inbox");
      onBack();
    },
    onError: () => toast.error("Failed to restore")
  });

  const setVisibilityMutation = useMutation({
    mutationFn: (visibility) => {
      if (!['private', 'shared'].includes(visibility)) {
        throw new Error('Invalid visibility value');
      }
      return api.functions.invoke('setEmailVisibility', {
        threadIds: [thread.threadId],
        emailAccountId: account?.id,
        visibility
      });
    },
    onSuccess: (_, visibility) => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'visibility_changed',
          old_value: msg.visibility || 'private',
          new_value: visibility,
          description: `Visibility changed to ${visibility}`
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Visibility updated");
    },
    onError: (error) => toast.error(error?.message || "Failed to update visibility")
  });

  const setPriorityMutation = useMutation({
    mutationFn: async (priority) => {
      const oldPriority = msg?.priority || 'none';
      await Promise.all(
        freshThread.messages.map(m =>
          api.entities.EmailMessage.update(m.id, { priority })
        )
      );
      return { oldPriority, newPriority: priority || 'none' };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["email-thread"] });
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'priority_changed',
          old_value: data.oldPriority,
          new_value: data.newPriority,
          description: `Priority changed from ${data.oldPriority} to ${data.newPriority}`
        }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['email-activity', msg.id] });
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Priority updated");
    },
    onError: () => {
      toast.error("Failed to update priority");
    }
  });

  const deleteEmailMutation = useMutation({
    mutationFn: () => api.functions.invoke('deleteEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id,
      permanently: false
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'deleted',
          description: 'Email deleted'
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success("Email deleted");
      onBack();
    },
    onError: () => {
      toast.error("Failed to delete email");
    }
  });

  const updateLabelsMutation = useMutation({
   mutationFn: (labels) =>
     Promise.all(freshThread.messages.map(m => api.entities.EmailMessage.update(m.id, { labels }))),
   onMutate: (newLabels) => {
     // Optimistic update — immediately reflect label changes in UI
     const previousMessages = [...liveMessages];
     setLiveMessages(prev => prev.map(m => ({ ...m, labels: newLabels })));
     return { previousMessages };
   },
   onSuccess: (_, newLabels) => {
     // Invalidate both thread and inbox list queries so inbox reflects changes
     queryClient.invalidateQueries({ queryKey: ["email-thread"] });
     queryClient.invalidateQueries({ queryKey: ["email-messages"] });
     if (msg?.id) {
       const oldLabels = msg.labels || [];
       const addedLabels = newLabels.filter(l => !oldLabels.includes(l));
       const removedLabels = oldLabels.filter(l => !newLabels.includes(l));

       if (addedLabels.length > 0) {
         api.functions.invoke('logEmailActivity', {
           email_message_id: msg.id,
           email_account_id: account?.id,
           action_type: 'label_added',
           old_value: oldLabels.join(', ') || 'none',
           new_value: newLabels.join(', '),
           description: `Labels added: ${addedLabels.join(', ')}`
         }).catch(err => console.error('Failed to log activity:', err));
       }
       if (removedLabels.length > 0) {
         api.functions.invoke('logEmailActivity', {
           email_message_id: msg.id,
           email_account_id: account?.id,
           action_type: 'label_removed',
           old_value: oldLabels.join(', '),
           new_value: newLabels.join(', ') || 'none',
           description: `Labels removed: ${removedLabels.join(', ')}`
         }).catch(err => console.error('Failed to log activity:', err));
       }
     }
     toast.success("Labels updated");
   },
   onError: (_, __, context) => {
     // Revert optimistic update on error
     if (context?.previousMessages) {
       setLiveMessages(context.previousMessages);
     }
     queryClient.invalidateQueries({ queryKey: ["email-messages"] });
     toast.error("Failed to update labels");
   }
  });

  const unlinkProjectMutation = useMutation({
    mutationFn: () => 
      Promise.all(freshThread.messages.map(m =>
        api.entities.EmailMessage.update(m.id, {
          project_id: null,
          project_title: null,
          visibility: 'private'
        })
      )),
    onSuccess: () => {
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'project_unlinked',
          old_value: msg.project_title || 'unknown',
          new_value: 'none',
          description: `Project unlinked from ${msg.project_title || 'project'}`
        }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['email-activity', msg.id] });
        }).catch(err => console.error('Failed to log activity:', err));
      }
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      toast.success("Project unlinked");
    },
    onError: () => {
      toast.error("Failed to unlink project");
    }
  });

  const linkProjectMutation = useMutation({
    mutationFn: (projectData) => 
      Promise.all(freshThread.messages.map(m =>
        api.entities.EmailMessage.update(m.id, {
          project_id: projectData.id,
          project_title: projectData.title
          // Do NOT force visibility to shared — owner controls that separately
        })
      )),
    onSuccess: (_, projectData) => {
      if (msg?.id) {
        api.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: 'project_linked',
          old_value: msg.project_title || 'none',
          new_value: projectData.title,
          description: `Email linked to project: ${projectData.title}`
        }).then(() => {
          queryClient.invalidateQueries({ queryKey: ['email-activity', msg.id] });
        }).catch(err => console.error('Failed to log activity:', err));
      }
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      setShowProjectLink(false);
      toast.success("Project linked");
    },
    onError: () => {
      toast.error("Failed to link project");
    }
  });

  // Auto-mark as read on open (fires once per unique thread open)
  // Uses a ref to track which threads have been auto-marked, preventing repeated calls
  const autoMarkedRef = useRef(new Set());
  useEffect(() => {
    if (!thread?.threadId || !account?.id) return;
    if (autoMarkedRef.current.has(thread.threadId)) return;
    const hasUnread = thread.messages.some(m => m.is_unread);
    if (!hasUnread) return;
    autoMarkedRef.current.add(thread.threadId);
    // Small delay so the UI renders the thread first, then marks read in background
    const timer = setTimeout(() => {
      api.functions.invoke('markEmailsAsRead', {
        threadIds: [thread.threadId],
        emailAccountId: account.id
      }).then(() => {
        queryClient.invalidateQueries({ queryKey: ['email-messages'] });
      }).catch(() => {}); // Silent — don't surface errors for background action
    }, 1500);
    return () => clearTimeout(timer);
  }, [thread.threadId, account?.id, queryClient]);

  // Track email opens (deduped: max once per 5 minutes per message)
  const lastOpenLogRef = useRef({});
  useEffect(() => {
    if (!msg?.id || !account?.id) return;

    const now = Date.now();
    const lastLog = lastOpenLogRef.current[msg.id];
    if (lastLog && now - lastLog < 5 * 60 * 1000) return; // Skip if logged within 5 min

    lastOpenLogRef.current[msg.id] = now;
    api.functions.invoke('logEmailActivity', {
      email_message_id: msg.id,
      email_account_id: account.id,
      action_type: 'opened',
      description: 'Email opened'
    }).catch(err => console.error('Failed to log email open:', err));
  }, [msg?.id, account?.id]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if typing in input/editor/select
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT' || e.target.contentEditable === 'true') return;
      // Ignore if any modifier key is held (Ctrl/Cmd/Alt) — let browser shortcuts (Ctrl+F, Cmd+A, etc.) work
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Don't fire action shortcuts when reply composer is open (except Escape)
      const composerOpen = replyExpanded || showForward;

      // Shift+R = Reply All
      if ((e.key === 'R') && e.shiftKey) {
        e.preventDefault();
        setReplyMode('replyAll');
        setReplyToMessage(null);
        setReplyExpanded(true);
        return;
      }
      // R = Reply (toggle)
      if (e.key === 'r' && !e.shiftKey) {
        e.preventDefault();
        setReplyMode('reply');
        setReplyToMessage(null);
        setReplyExpanded(v => !v);
        return;
      }
      // F = Forward (only lowercase f without shift, skip if composer is open)
      if (e.key === 'f' && !e.shiftKey && !composerOpen) {
        e.preventDefault();
        setShowForward(true);
        return;
      }
      // J or N = Next thread
      if ((e.key === 'j' || e.key === 'n') && !e.shiftKey) {
        e.preventDefault();
        onNextThread?.();
        return;
      }
      // K or P = Previous thread
      if ((e.key === 'k' || e.key === 'p') && !e.shiftKey) {
        e.preventDefault();
        onPrevThread?.();
        return;
      }
      // A = Archive (skip if composer is open to avoid accidental archive while typing)
      if (e.key === 'a' && !e.shiftKey && !composerOpen) {
        e.preventDefault();
        archiveEmailMutation.mutate();
        return;
      }
      // E = Expand all (skip if composer is open)
      if (e.key === 'e' && !e.shiftKey && !composerOpen) {
        e.preventDefault();
        setExpandedMessages(new Set(freshThread.messages.map(m => m.id)));
        return;
      }
      // Escape = Back (or close composer first)
      if (e.key === 'Escape') {
        e.preventDefault();
        if (replyExpanded) {
          setReplyExpanded(false);
          setReplyToMessage(null);
        } else if (showForward) {
          setShowForward(false);
        } else {
          onBack();
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [replyExpanded, showForward, freshThread, onNextThread, onPrevThread, onBack, archiveEmailMutation]);

  const { data: labelData = [] } = useQuery({
   queryKey: ["email-labels", account?.id],
   queryFn: () =>
     api.entities.EmailLabel.filter({
       email_account_id: account?.id,
     }),
   enabled: !!account?.id,
  });

  const getLabel = (labelName) => labelData.find((l) => l.name === labelName);

  const isLinkedToProject = !!msg?.project_id;

  const priorityConfig = {
    none: '',
    low: 'border-l-4 border-l-blue-300',
    medium: 'border-l-4 border-l-orange-400',
    attention: 'border-l-4 border-l-red-500',
    completed: 'border-l-4 border-l-emerald-500'
  };

  const totalMessages = freshThread.messages.length;
  const allExpanded = freshThread.messages.every(m => expandedMessages.has(m.id));
  const toggleAllExpanded = () => {
    if (allExpanded) {
      setExpandedMessages(new Set([freshThread.messages[freshThread.messages.length - 1]?.id]));
    } else {
      setExpandedMessages(new Set(freshThread.messages.map(m => m.id)));
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-0 max-w-[1600px] mx-auto h-full" ref={containerRef}>
      {/* Main Email Content */}
      <div className="lg:col-span-2 flex flex-col overflow-y-auto max-h-[calc(100vh-64px)] border-r">
        {/* Sticky Header */}
        <div className="sticky top-0 bg-background/95 backdrop-blur-sm z-10 px-4 py-2.5 border-b border-border shadow-sm flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onBack()}
              className="gap-1.5 hover:bg-muted text-foreground/80 font-medium shrink-0"
              title="Back to Inbox (Esc)"
              aria-label="Back to inbox"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Inbox</span>
            </Button>
            <span className="text-border hidden sm:inline">|</span>
            {/* Thread subject truncated */}
            <span className="text-sm font-semibold text-foreground truncate min-w-0 hidden sm:block">{thread.subject}</span>
          </div>
          {/* Right: prev/next + shortcuts hint */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground/50 hidden lg:inline mr-2">
              <kbd className="bg-muted px-1 rounded text-[10px]">J</kbd>/<kbd className="bg-muted px-1 rounded text-[10px]">K</kbd> nav
              <span className="mx-1">·</span>
              <kbd className="bg-muted px-1 rounded text-[10px]">R</kbd> reply
              <span className="mx-1">·</span>
              <kbd className="bg-muted px-1 rounded text-[10px]">⇧R</kbd> all
              <span className="mx-1">·</span>
              <kbd className="bg-muted px-1 rounded text-[10px]">F</kbd> fwd
              <span className="mx-1">·</span>
              <kbd className="bg-muted px-1 rounded text-[10px]">A</kbd> archive
              <span className="mx-1">·</span>
              <kbd className="bg-muted px-1 rounded text-[10px]">E</kbd> expand all
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onPrevThread?.()}
              disabled={!onPrevThread}
              title="Previous thread (P)"
              className="h-8 w-8 text-muted-foreground disabled:opacity-30"
              aria-label="Previous thread"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onNextThread?.()}
              disabled={!onNextThread}
              title="Next thread (N)"
              className="h-8 w-8 text-muted-foreground disabled:opacity-30"
              aria-label="Next thread"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Thread Header — Subject + Actions */}
        <div className={cn("px-5 pt-5 pb-4 bg-card border-b", priorityConfig[msg.priority] || '')}>
          {/* Subject */}
          <h1
            className="text-[22px] font-bold text-foreground leading-snug mb-3 pr-2 cursor-pointer group"
            title="Click to copy subject"
            onClick={() => { if (thread.subject) navigator.clipboard.writeText(thread.subject).then(() => toast.success('Subject copied')); }}
          >
            {thread.subject || <em className="text-muted-foreground font-normal">(no subject)</em>}
            <Copy className="h-3.5 w-3.5 inline ml-2 opacity-0 group-hover:opacity-40 transition-opacity" />
          </h1>

          {/* Action toolbar */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Primary actions */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setReplyMode('reply'); setReplyToMessage(null); setReplyExpanded(v => !v); }}
              className={cn("gap-1.5 font-medium", replyExpanded && replyMode === 'reply' && "bg-blue-50 border-blue-300 text-blue-700")}
              aria-label="Reply"
              title="Reply (R)"
            >
              <Reply className="h-3.5 w-3.5" />
              Reply
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => { setReplyMode('replyAll'); setReplyToMessage(null); setReplyExpanded(true); }}
              className={cn("gap-1.5 font-medium", replyExpanded && replyMode === 'replyAll' && "bg-blue-50 border-blue-300 text-blue-700")}
              aria-label="Reply All"
              title="Reply All (Shift+R)"
            >
              <ReplyAll className="h-3.5 w-3.5" />
              Reply All
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowForward(true)}
              className="gap-1.5 font-medium"
              aria-label="Forward"
              title="Forward (F)"
            >
              <Forward className="h-3.5 w-3.5" />
              Forward
            </Button>

            <div className="h-5 w-px bg-border mx-0.5" />

            {/* Visibility */}
            <button
              onClick={() => setVisibilityMutation.mutate(msg.visibility === 'shared' ? 'private' : 'shared')}
              className={cn(
                "h-8 px-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold transition-all active:scale-95",
                msg.visibility === 'shared'
                  ? "text-blue-700 bg-blue-50 hover:bg-blue-100"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted"
              )}
              aria-label={msg.visibility === 'shared' ? "Make private" : "Share with team"}
              title={msg.visibility === 'shared' ? "Shared with team — click to make private" : "Private — click to share"}
            >
              {msg.visibility === 'shared' ? <Users className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
              <span className="hidden sm:inline">{msg.visibility === 'shared' ? 'Shared' : 'Private'}</span>
            </button>

            {/* Snooze */}
            <button
              onClick={() => setShowSnoozeDialog(true)}
              className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all active:scale-95"
              aria-label="Snooze"
              title="Snooze"
            >
              <Clock className="h-4 w-4" />
            </button>

            {/* Priority selector */}
            <PrioritySelector
              priority={msg.priority}
              onPriorityChange={(p) => setPriorityMutation.mutate(p)}
            />

            <div className="h-5 w-px bg-border mx-0.5" />

            {/* Archive / Restore */}
            {currentView !== "archived" && currentView !== "deleted" ? (
              <button
                onClick={() => archiveEmailMutation.mutate()}
                disabled={archiveEmailMutation.isPending}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all active:scale-95 disabled:opacity-40"
                aria-label="Archive"
                title="Archive (A)"
              >
                {archiveEmailMutation.isPending
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Archive className="h-4 w-4" />}
              </button>
            ) : (
              <button
                onClick={() => restoreEmailMutation.mutate()}
                disabled={restoreEmailMutation.isPending}
                className="h-8 px-2.5 rounded-lg flex items-center gap-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 transition-all"
                aria-label="Restore to inbox"
              >
                <RefreshCw className={cn("h-3.5 w-3.5", restoreEmailMutation.isPending && "animate-spin")} />
                Restore
              </button>
            )}

            {/* More */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="h-8 w-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-all"
                  aria-label="More options"
                  title="More options"
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {msg.is_unread ? (
                  <DropdownMenuItem onClick={() => markAsReadMutation.mutate()}>
                    <Eye className="h-4 w-4 mr-2 text-muted-foreground" />
                    Mark as read
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={() => markAsUnreadMutation.mutate()}>
                    <EyeOff className="h-4 w-4 mr-2 text-muted-foreground" />
                    Mark as unread
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => {
                  navigator.clipboard.writeText(window.location.href).then(
                    () => toast.success('Thread link copied'),
                    () => toast.error('Failed to copy link')
                  );
                }}>
                  <Link2 className="h-4 w-4 mr-2 text-muted-foreground" />
                  Copy link to thread
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => window.print()}>
                  <Printer className="h-4 w-4 mr-2 text-muted-foreground" />
                  Print
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setShowDeleteConfirm(true)}
                  className="text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Labels row */}
          {(msg.labels?.length > 0 || true) && (
            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-border items-center">
              {msg.labels?.map((labelName) => {
                const label = getLabel(labelName);
                return (
                  <LabelBadge
                    key={labelName}
                    label={labelName}
                    color={label?.color || "#6b7280"}
                  />
                );
              })}
              <LabelSelectorRobust
                emailAccountId={account?.id}
                selectedLabels={msg.labels || []}
                onLabelsChange={(labels) => updateLabelsMutation.mutate(labels)}
                isAdmin={true}
                compact={true}
              />
            </div>
          )}
        </div>

        {/* Thread: From + message count bar */}
        <div className="px-5 py-2.5 border-b border-border bg-muted/40 flex items-center justify-between gap-2">
          <EmailHeaderInfo
            from={msg.from}
            fromName={msg.from_name}
            to={msg.to || []}
            cc={msg.cc || []}
            bcc={msg.bcc || []}
          />
          {totalMessages > 1 && (
            <button
              onClick={toggleAllExpanded}
              className="flex-shrink-0 flex items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground hover:bg-muted px-2 py-1 rounded-lg transition-all"
              title={allExpanded ? "Collapse all" : "Expand all (E)"}
              aria-label={allExpanded ? "Collapse all messages" : "Expand all messages"}
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
              {totalMessages} messages
            </button>
          )}
        </div>

        {/* Message list */}
        <div className="flex-1 divide-y divide-border bg-card">
          {(() => {
            const msgs = freshThread.messages;
            const collapsedCount = msgs.filter((m, i) => i < msgs.length - 1 && !expandedMessages.has(m.id)).length;
            const elements = [];

            msgs.forEach((msgItem, idx) => {
              const isExpanded = expandedMessages.has(msgItem.id);
              const isLatest = idx === msgs.length - 1;
              const initial = (msgItem.from_name || msgItem.from || '?').charAt(0).toUpperCase();
              const avatarColors = [
                'from-blue-400 to-blue-600', 'from-violet-400 to-violet-600',
                'from-emerald-400 to-emerald-600', 'from-orange-400 to-orange-600',
                'from-pink-400 to-pink-600', 'from-teal-400 to-teal-600',
              ];
              const avatarColor = avatarColors[(msgItem.from || '').length % avatarColors.length];

              // Show "N collapsed messages" summary bar before the latest message
              // when there are collapsed older messages
              if (isLatest && collapsedCount > 0 && msgs.length > 2) {
                const collapsedSenders = [...new Set(
                  msgs.slice(0, -1)
                    .filter(m => !expandedMessages.has(m.id))
                    .map(m => m.from_name || m.from || 'Unknown')
                )];

                elements.push(
                  <div
                    key="collapsed-summary"
                    className="flex items-center gap-3 px-5 py-2 bg-muted/60 border-y border-border cursor-pointer hover:bg-muted transition-colors"
                    onClick={() => {
                      // Expand all collapsed older messages
                      setExpandedMessages(new Set(msgs.map(m => m.id)));
                    }}
                    role="button"
                    tabIndex={0}
                    title="Click to expand all older messages"
                  >
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {/* Stacked avatar dots */}
                      <div className="flex -space-x-1.5">
                        {collapsedSenders.slice(0, 3).map((sender, si) => {
                          const sColor = avatarColors[(sender || '').length % avatarColors.length];
                          return (
                            <div
                              key={si}
                              className={cn(
                                "w-6 h-6 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white border-2 border-background",
                                sColor
                              )}
                            >
                              {sender.charAt(0).toUpperCase()}
                            </div>
                          );
                        })}
                      </div>
                      <span className="text-xs text-muted-foreground font-medium">
                        {collapsedCount} older message{collapsedCount !== 1 ? 's' : ''}
                        {collapsedSenders.length <= 3
                          ? ` from ${collapsedSenders.join(', ')}`
                          : ` from ${collapsedSenders.slice(0, 2).join(', ')} and ${collapsedSenders.length - 2} other${collapsedSenders.length - 2 !== 1 ? 's' : ''}`
                        }
                      </span>
                    </div>
                    <span className="text-[10px] text-muted-foreground flex items-center gap-1 flex-shrink-0">
                      <ChevronsUpDown className="h-3 w-3" />
                      Expand all
                    </span>
                  </div>
                );
              }

              elements.push(
                <div
                  key={msgItem.id}
                  ref={isLatest ? latestMessageRef : null}
                  className={cn(
                    "transition-all duration-150 group/msg",
                    !isExpanded && !isLatest && "hover:bg-muted/60 cursor-pointer",
                    isLatest && "bg-card"
                  )}
                >
                  {/* Message header row — always visible */}
                  <div
                    className={cn(
                      "flex items-center gap-3 px-5 py-3 cursor-pointer select-none",
                      isLatest && !isExpanded && "bg-blue-50/30"
                    )}
                    onClick={() => {
                      if (!isExpanded) {
                        setExpandedMessages(prev => new Set([...prev, msgItem.id]));
                      } else if (!isLatest) {
                        setExpandedMessages(prev => {
                          const next = new Set(prev);
                          next.delete(msgItem.id);
                          return next;
                        });
                      }
                    }}
                    aria-expanded={isExpanded}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => e.key === 'Enter' && !isLatest && setExpandedMessages(prev => {
                      const next = new Set(prev);
                      isExpanded ? next.delete(msgItem.id) : next.add(msgItem.id);
                      return next;
                    })}
                  >
                    {/* Avatar */}
                    <div className={cn(
                      "w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-sm font-bold text-white flex-shrink-0 shadow-sm",
                      avatarColor
                    )}>
                      {initial}
                    </div>

                    {/* Sender + preview */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-2">
                        <span className={cn("text-sm truncate", isExpanded ? "font-bold text-foreground" : "font-semibold text-foreground/80")}>
                          {msgItem.from_name || msgItem.from}
                        </span>
                        {!isExpanded && (
                          <span className="text-xs text-muted-foreground truncate min-w-0 hidden sm:block">
                            {msgItem.body ? msgItem.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80) : ''}
                          </span>
                        )}
                      </div>
                      {isExpanded && (
                        <p className="text-xs text-muted-foreground truncate">
                          to {(msgItem.to || []).join(', ')}
                        </p>
                      )}
                    </div>

                    {/* Right: date + actions */}
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      {/* Per-message reply actions — Pipedrive style, visible on hover */}
                      {isExpanded && (
                        <div className="flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); setReplyMode('reply'); setReplyToMessage(msgItem); setReplyExpanded(true); }}
                            className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-md transition-colors"
                            title="Reply to this message"
                            aria-label="Reply"
                          >
                            <Reply className="h-3.5 w-3.5 text-muted-foreground hover:text-blue-600" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setReplyMode('replyAll'); setReplyToMessage(msgItem); setReplyExpanded(true); }}
                            className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-md transition-colors"
                            title="Reply All to this message"
                            aria-label="Reply All"
                          >
                            <ReplyAll className="h-3.5 w-3.5 text-muted-foreground hover:text-blue-600" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setShowForward(true);
                              // Set replyToMessage so the forward dialog has the right message context
                              setReplyToMessage(msgItem);
                            }}
                            className="p-1.5 hover:bg-blue-50 dark:hover:bg-blue-950 rounded-md transition-colors"
                            title="Forward this message"
                            aria-label="Forward"
                          >
                            <Forward className="h-3.5 w-3.5 text-muted-foreground hover:text-blue-600" />
                          </button>
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground font-medium whitespace-nowrap">
                        {formatEmailDateTime(msgItem.received_at)}
                      </span>
                      {!isLatest && (
                        isExpanded
                          ? <ChevronUp className="h-4 w-4 text-muted-foreground" />
                          : <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                      {isExpanded && (
                        <button
                          onClick={(e) => { e.stopPropagation(); copyEmail(msgItem.from); }}
                          className="p-1 hover:bg-muted rounded-md transition-colors"
                          title="Copy sender email"
                          aria-label="Copy sender email"
                        >
                          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded: full body */}
                  {isExpanded && (
                    <div className="px-5 pb-6">
                      {/* Sandboxed email body — cap height for very large emails with scroll */}
                      <div
                        className="prose prose-sm max-w-none text-foreground leading-relaxed overflow-x-auto overflow-y-auto email-body-content"
                        style={{ fontFamily: 'inherit', maxHeight: '80vh' }}
                        dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msgItem.body) }}
                      />
                      <style>{`
                        .email-body-content a {
                          color: #2563eb !important;
                          text-decoration: underline !important;
                          word-break: break-all;
                        }
                        .email-body-content a:hover {
                          color: #1d4ed8 !important;
                        }
                        .email-body-content img {
                          max-width: 100%;
                          height: auto;
                        }
                      `}</style>

                      {/* Attachments */}
                      {msgItem.attachments && msgItem.attachments.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-border">
                          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider mb-3">
                            Attachments ({msgItem.attachments.length})
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {msgItem.attachments.map((att, aidx) => {
                              const isPdf = /\.pdf$/i.test(att.filename || '') ||
                                (att.mime_type || att.mimeType || '') === 'application/pdf';
                              const ext = att.filename?.split('.').pop()?.toUpperCase() || '?';

                              const handleDownload = async (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                // If we have a direct URL, use it (validate protocol)
                                if (att.file_url) {
                                  try {
                                    const u = new URL(att.file_url, window.location.origin);
                                    if (u.protocol === 'http:' || u.protocol === 'https:') {
                                      window.open(u.href, '_blank', 'noopener,noreferrer');
                                    }
                                  } catch { /* invalid URL, skip */ }
                                  return;
                                }
                                // Otherwise fetch from Gmail via edge function
                                if (!att.attachment_id) {
                                  toast.error('No attachment data available');
                                  return;
                                }
                                const btn = e.currentTarget;
                                btn.style.opacity = '0.5';
                                btn.style.pointerEvents = 'none';
                                try {
                                  const { data: { session } } = await api.supabase.auth.getSession();
                                  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/getEmailAttachment`, {
                                    method: 'POST',
                                    headers: {
                                      'Content-Type': 'application/json',
                                      'Authorization': `Bearer ${session?.access_token}`,
                                    },
                                    body: JSON.stringify({
                                      messageId: msgItem.gmail_message_id,
                                      attachmentId: att.attachment_id,
                                      accountId: thread.messages[0]?.email_account_id || account?.id,
                                    }),
                                  });
                                  if (!res.ok) throw new Error('Download failed');
                                  const result = await res.json();
                                  // Convert base64 to blob and download
                                  const byteChars = atob(result.data);
                                  const byteArray = new Uint8Array(byteChars.length);
                                  for (let i = 0; i < byteChars.length; i++) {
                                    byteArray[i] = byteChars.charCodeAt(i);
                                  }
                                  const blob = new Blob([byteArray], { type: att.mime_type || 'application/octet-stream' });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement('a');
                                  a.href = url;
                                  a.download = att.filename || 'attachment';
                                  document.body.appendChild(a);
                                  a.click();
                                  document.body.removeChild(a);
                                  URL.revokeObjectURL(url);
                                  toast.success(`Downloaded ${att.filename}`);
                                } catch (err) {
                                  console.error('Attachment download error:', err);
                                  toast.error('Failed to download attachment');
                                } finally {
                                  btn.style.opacity = '';
                                  btn.style.pointerEvents = '';
                                }
                              };

                              return (
                                <button
                                  key={aidx}
                                  onClick={handleDownload}
                                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-muted/60 border border-border hover:border-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950 dark:hover:bg-blue-950 transition-all group max-w-xs cursor-pointer text-left"
                                  title={`Download ${att.filename}`}
                                >
                                  <div className="w-8 h-8 bg-background rounded-lg border border-border flex items-center justify-center text-xs font-bold text-muted-foreground flex-shrink-0 uppercase">
                                    {isPdf ? 'PDF' : ext}
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-xs font-bold text-foreground/80 group-hover:text-blue-700 dark:group-hover:text-blue-400 truncate leading-tight">
                                      {att.filename}
                                    </p>
                                    {att.size > 0 && (
                                      <p className="text-[10px] text-muted-foreground font-medium mt-0.5">
                                        {formatFileSize(att.size)}
                                      </p>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            });

            return elements;
          })()}
        </div>

        {showProjectLink && (
          <ProjectLinkDialog
            thread={thread}
            onClose={() => setShowProjectLink(false)}
            onProjectLinked={(projectData) => linkProjectMutation.mutate(projectData)}
          />
        )}

        {/* Reply / Forward Box — Pipedrive-style */}
        <div className="sticky bottom-0 bg-card border-t border-border shadow-lg">
          {/* Collapsed reply bar */}
          {!replyExpanded ? (
            <div className="flex items-center gap-2 px-5 py-3">
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0",
                "bg-gradient-to-br from-slate-400 to-slate-600"
              )}>
                {user?.full_name?.charAt(0).toUpperCase() || '?'}
              </div>
              <button
                onClick={() => { setReplyMode('reply'); setReplyToMessage(null); setReplyExpanded(true); }}
                className="flex-1 text-left text-sm text-muted-foreground bg-muted/60 hover:bg-muted border border-border rounded-full px-4 py-2 transition-all"
                aria-label="Click to reply"
              >
                Reply to {msg.from_name || msg.from}…
              </button>
              <div className="flex items-center gap-0.5">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setReplyMode('reply'); setReplyToMessage(null); setReplyExpanded(true); }}
                  className="gap-1.5 text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-950 font-semibold"
                  aria-label="Reply"
                >
                  <Reply className="h-3.5 w-3.5" /> Reply
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { setReplyMode('replyAll'); setReplyToMessage(null); setReplyExpanded(true); }}
                  className="gap-1.5 text-muted-foreground hover:bg-muted font-medium"
                  aria-label="Reply All"
                >
                  <ReplyAll className="h-3.5 w-3.5" /> Reply All
                </Button>
                <div className="h-4 w-px bg-border mx-0.5" />
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setShowForward(true)}
                  className="gap-1.5 text-muted-foreground hover:bg-muted font-medium"
                  aria-label="Forward"
                >
                  <Forward className="h-3.5 w-3.5" /> Forward
                </Button>
              </div>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between mb-1">
                {/* Mode selector — switch between Reply / Reply All like Pipedrive */}
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setReplyMode('reply')}
                    className={cn(
                      "flex items-center gap-1.5 text-sm font-bold px-2.5 py-1 rounded-md transition-all",
                      replyMode === 'reply'
                        ? "text-blue-700 bg-blue-50"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    <Reply className="h-3.5 w-3.5" />
                    Reply
                  </button>
                  <button
                    onClick={() => setReplyMode('replyAll')}
                    className={cn(
                      "flex items-center gap-1.5 text-sm font-bold px-2.5 py-1 rounded-md transition-all",
                      replyMode === 'replyAll'
                        ? "text-blue-700 bg-blue-50"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted"
                    )}
                  >
                    <ReplyAll className="h-3.5 w-3.5" />
                    Reply All
                  </button>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setShowForward(true)}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors flex items-center gap-1"
                    aria-label="Forward instead"
                  >
                    <Forward className="h-3 w-3" />
                    Forward
                  </button>
                  <div className="h-4 w-px bg-border" />
                  <button
                    onClick={() => { setReplyExpanded(false); setReplyToMessage(null); }}
                    className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted transition-colors"
                    aria-label="Close reply"
                  >
                    Discard
                  </button>
                </div>
              </div>
              <QuickReplyTemplates
                onTemplateSelect={(template) => {
                  setQuickReplyBody(template.body || template.content || '');
                }}
                compact={true}
              />
              <EmailComposeReply
                key={`${replyMode}-${replyToMessage?.id || 'latest'}`}
                thread={freshThread}
                account={account}
                replyType={replyMode}
                replyToMessage={replyToMessage}
                onClose={() => {
                  setReplyExpanded(false);
                  setReplyToMessage(null);
                  setQuickReplyBody('');
                  // Invalidate email queries so inbox list + thread data refresh immediately
                  // (don't rely solely on real-time subscription which may have latency)
                  queryClient.invalidateQueries({ queryKey: ["email-messages"] });
                  queryClient.invalidateQueries({ queryKey: ["email-thread"] });
                  latestMessageRef.current?.scrollIntoView({ behavior: 'smooth' });
                }}
                onReplyMode={() => {}}
                emailAccounts={emailAccounts}
                defaultBodyPrefix={quickReplyBody}
              />
            </div>
          )}
        </div>

        </div>

      {/* Right Sidebar */}
      <div className="hidden lg:flex flex-col overflow-y-auto max-h-[calc(100vh-64px)] bg-muted/30 border-l">
        {/* Sidebar header */}
        <div className="px-4 py-3 border-b border-border bg-card sticky top-0 z-10">
          <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Details</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-3">
            {/* Contact card */}
            <ContactInfoCard
              sender={msg.from}
              senderName={msg.from_name}
              allMessages={freshThread.messages}
            />

            {/* Project link */}
            <EmailDetailSidebar
              thread={thread}
              onProjectLinkClick={() => setShowProjectLink(true)}
              onProjectUnlink={() => unlinkProjectMutation.mutate()}
            />

            {/* Email tracking stats */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Tracking</p>
              </div>
              <div className="p-4 space-y-3">
                <EmailOpenStats messageId={msg.id} />
                <EmailLinkStats messageBody={msg.body} />
              </div>
            </div>

            {/* Activity log */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <div className="px-4 py-3 border-b border-border">
                <p className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Activity</p>
              </div>
              <div className="max-h-72 overflow-y-auto">
                <EmailActivityLog messageId={msg.id} />
              </div>
            </div>

            {/* Raw source — collapsed by default, dev tool */}
            <div className="bg-card rounded-xl border border-border overflow-hidden">
              <button
                className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-muted-foreground uppercase tracking-wider hover:bg-muted transition-colors"
                onClick={() => setShowRaw(v => !v)}
                aria-expanded={showRaw}
                aria-label="Toggle email source"
              >
                <span>Email Source</span>
                {showRaw ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {showRaw && (
                <div className="border-t border-border">
                  <pre className="text-[10px] bg-slate-950 text-green-400 p-3 overflow-x-auto max-h-52 overflow-y-auto font-mono leading-relaxed">
                    {JSON.stringify({
                      from: msg.from,
                      to: msg.to,
                      cc: msg.cc,
                      subject: msg.subject,
                      date: msg.received_at,
                      message_id: msg.gmail_message_id,
                      thread_id: msg.gmail_thread_id
                    }, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Forward dialog */}
      {showForward && (
        <EmailComposeDialog
          email={replyToMessage || msg}
          account={account}
          type="forward"
          onClose={() => { setShowForward(false); setReplyToMessage(null); }}
          onSent={() => {
            setShowForward(false);
            setReplyToMessage(null);
            // Toast already shown by EmailComposeDialog.sendMutation.onSuccess — no duplicate needed
          }}
        />
      )}

      <SnoozeDialog
        open={showSnoozeDialog}
        onOpenChange={setShowSnoozeDialog}
        onSnooze={async (option) => {
          try {
            const snoozeTime = option.snooze_until;
            await Promise.all(
              freshThread.messages.map(m =>
                api.entities.EmailMessage.update(m.id, { snoozed_until: snoozeTime })
              )
            );
            queryClient.invalidateQueries({ queryKey: ['email-messages'] });
            const formatted = new Date(snoozeTime).toLocaleString(undefined, {
              weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
            });
            toast.success(`Snoozed until ${formatted}`);
            // Navigate back to inbox so snoozed thread disappears from view
            onBack();
          } catch (err) {
            console.error('Snooze failed:', err);
            toast.error('Failed to snooze email');
          }
        }}
      />

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>Move to trash?</AlertDialogTitle>
          <AlertDialogDescription>
            This thread will be moved to the deleted folder. You can restore it later.
          </AlertDialogDescription>
          <div className="flex gap-3 justify-end mt-4">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                deleteEmailMutation.mutate();
                setShowDeleteConfirm(false);
              }}
              className="bg-destructive hover:bg-destructive/90 gap-1.5"
              disabled={deleteEmailMutation.isPending}
            >
              {deleteEmailMutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Move to trash
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
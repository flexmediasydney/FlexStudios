import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { 
  ArrowLeft, Reply, ReplyAll, Forward, Archive, Trash2,
  MoreVertical, ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
  Lock, Users, Copy, Star, Clock, ChevronsUpDown, Tag,
  Loader2, Eye, EyeOff, RefreshCw, AlertCircle, Maximize2, Minimize2
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

// Sanitize HTML email bodies to prevent XSS.
// Strips: <script>, <style>, all on* event attributes, javascript: hrefs, data: URIs.
// Preserves: all visual formatting, links, images, tables, lists.
const sanitizeEmailHtml = (html) => {
  if (!html) return '';
  // Remove script and style blocks entirely
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  // Strip all on* event handler attributes (onclick, onload, onerror, etc.)
  clean = clean.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // Strip javascript: and data: URI schemes from href and src
  clean = clean.replace(/(href|src|action)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, 'href="#"');
  clean = clean.replace(/(href|src|action)\s*=\s*(?:"data:[^"]*"|'data:[^']*')/gi, 'href="#"');
  // Strip <base> tags (can redirect all relative links)
  clean = clean.replace(/<base\b[^>]*>/gi, '');
  // Strip <form> tags (phishing risk)
  clean = clean.replace(/<\/?form\b[^>]*>/gi, '');
  return clean;
};
import { toast } from "sonner";
import EmailComposeReply from "./EmailComposeReply";
import EmailComposeDialog from "./EmailComposeDialog";
import ProjectLinkDialog from "./ProjectLinkDialog";
import LabelSelectorRobust from "./LabelSelectorRobust";
import LabelBadge from "./LabelBadge";
import ProjectHoverCard from "./ProjectHoverCard";
import EmailHeaderInfo from "./EmailHeaderInfo";
import EmailDetailSidebar from "./EmailDetailSidebar";
import PrioritySelector from "./PrioritySelector";
import EmailActivityLog from "./EmailActivityLog";
import EmailOpenStats from "./EmailOpenStats";
import EmailLinkStats from "./EmailLinkStats";
import EmailHeaderActions from "./EmailHeaderActions";
import SnoozeDialog from "./SnoozeDialog";
import QuickReplyTemplates from "./QuickReplyTemplates";
import ContactInfoCard from "./ContactInfoCard";

export default function EmailThreadViewer({ thread, account, onBack, currentView = 'inbox', emailAccounts = [], onNextThread, onPrevThread }) {
  const [showReply, setShowReply] = useState(false);
  const [showProjectLink, setShowProjectLink] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [expandedMessages, setExpandedMessages] = useState(new Set([thread.messages[thread.messages.length - 1]?.id]));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [collapseOldQuotes, setCollapseOldQuotes] = useState(true);
  const [showSnoozeDialog, setShowSnoozeDialog] = useState(false);
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
    queryFn: () => base44.auth.me()
  });

  // Subscribe to real-time updates for all messages in this thread
  const messageIds = thread.messages.map(m => m.id);
  const [liveMessages, setLiveMessages] = useState(thread.messages);

  useEffect(() => {
    // Verify user owns this account (critical security check)
    if (!user || !account) return;
    
    if (account.assigned_to_user_id !== user.id) {
      toast.error("Unauthorized: You do not own this email account");
      onBack();
      return;
    }

    // Subscribe to EmailMessage updates
    const unsubscribe = base44.entities.EmailMessage.subscribe((event) => {
      if (messageIds.includes(event.id)) {
        setLiveMessages(prevMessages =>
          prevMessages.map(m => m.id === event.id ? event.data : m)
        );
      }
    });

    return unsubscribe;
  }, [messageIds.join(','), user?.id, account?.assigned_to_user_id]);

  // Use live messages, sorted by received_at
  const freshThread = {
    ...thread,
    messages: liveMessages.sort((a, b) => new Date(a.received_at) - new Date(b.received_at))
  };

  // Use the latest message as the canonical source for labels, priority, visibility, and actions.
  // messages are sorted oldest→newest (ascending received_at), so last index = most recent.
  const msg = freshThread.messages[freshThread.messages.length - 1];

  const copyEmail = (email) => {
    navigator.clipboard.writeText(email);
    toast.success(`Copied ${email}`);
  };

  const markAsReadMutation = useMutation({
    mutationFn: () => base44.functions.invoke('markEmailsAsRead', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
    mutationFn: () => base44.functions.invoke('markEmailsAsUnread', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
    mutationFn: () => base44.functions.invoke('archiveEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
    mutationFn: () => base44.functions.invoke('restoreEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id
    }),
    onSuccess: () => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
      return base44.functions.invoke('setEmailVisibility', {
        threadIds: [thread.threadId],
        emailAccountId: account?.id,
        visibility
      });
    },
    onSuccess: (_, visibility) => {
      queryClient.invalidateQueries({ queryKey: ["email-messages"] });
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
          base44.entities.EmailMessage.update(m.id, { priority })
        )
      );
      return { oldPriority, newPriority: priority || 'none' };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["email-thread"] });
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
    mutationFn: () => base44.functions.invoke('deleteEmails', {
      threadIds: [thread.threadId],
      emailAccountId: account?.id,
      permanently: false
    }),
    onSuccess: () => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
     Promise.all(freshThread.messages.map(m => base44.entities.EmailMessage.update(m.id, { labels }))),
   onSuccess: (_, newLabels) => {
     queryClient.invalidateQueries({ queryKey: ["email-thread"] });
     if (msg?.id) {
       const oldLabels = msg.labels || [];
       const addedLabels = newLabels.filter(l => !oldLabels.includes(l));
       const removedLabels = oldLabels.filter(l => !newLabels.includes(l));
       
       if (addedLabels.length > 0) {
         base44.functions.invoke('logEmailActivity', {
           email_message_id: msg.id,
           email_account_id: account?.id,
           action_type: 'label_added',
           old_value: oldLabels.join(', ') || 'none',
           new_value: newLabels.join(', '),
           description: `Labels added: ${addedLabels.join(', ')}`
         }).catch(err => console.error('Failed to log activity:', err));
       }
       if (removedLabels.length > 0) {
         base44.functions.invoke('logEmailActivity', {
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
   onError: () => {
     toast.error("Failed to update labels");
   }
  });

  const unlinkProjectMutation = useMutation({
    mutationFn: () => 
      Promise.all(freshThread.messages.map(m =>
        base44.entities.EmailMessage.update(m.id, {
          project_id: null,
          project_title: null,
          visibility: 'private'
        })
      )),
    onSuccess: () => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
      // Real-time subscription will handle UI update automatically
      toast.success("Project unlinked");
    },
    onError: () => {
      toast.error("Failed to unlink project");
    }
  });

  const setStarredMutation = useMutation({
    mutationFn: async (starred) => {
      await Promise.all(
        freshThread.messages.map(m =>
          base44.entities.EmailMessage.update(m.id, { is_starred: starred })
        )
      );
      return starred;
    },
    onSuccess: (starred) => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
          email_message_id: msg.id,
          email_account_id: account?.id,
          action_type: starred ? 'starred' : 'unstarred',
          description: `Email ${starred ? 'starred' : 'unstarred'}`
        }).catch(err => console.error('Failed to log activity:', err));
      }
      toast.success(starred ? "Starred" : "Unstarred");
    },
    onError: () => toast.error("Failed to update star")
  });

  const linkProjectMutation = useMutation({
    mutationFn: (projectData) => 
      Promise.all(freshThread.messages.map(m =>
        base44.entities.EmailMessage.update(m.id, {
          project_id: projectData.id,
          project_title: projectData.title
          // Do NOT force visibility to shared — owner controls that separately
        })
      )),
    onSuccess: (_, projectData) => {
      if (msg?.id) {
        base44.functions.invoke('logEmailActivity', {
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
      // Real-time subscription will handle UI update automatically
      setShowProjectLink(false);
      toast.success("Project linked");
    },
    onError: () => {
      toast.error("Failed to link project");
    }
  });

  // Auto-mark as read on open (fires once per unique thread open)
  useEffect(() => {
    if (!thread?.threadId || !account?.id) return;
    const hasUnread = thread.messages.some(m => m.is_unread);
    if (!hasUnread) return;
    base44.functions.invoke('markEmailsAsRead', {
      threadIds: [thread.threadId],
      emailAccountId: account.id
    }).catch(() => {}); // Silent — don't surface errors for background action
  }, [thread.threadId, account?.id]);

  // Track email opens
  useEffect(() => {
    if (!msg?.id || !account?.id) return;
    
    // Log as opened
    base44.functions.invoke('logEmailActivity', {
      email_message_id: msg.id,
      email_account_id: account.id,
      action_type: 'opened',
      description: 'Email opened'
    }).catch(err => console.error('Failed to log email open:', err));
  }, [msg?.id, account?.id]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if typing in input/editor
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.contentEditable === 'true') return;
      
      // R = Reply
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        setReplyExpanded(v => !v);
      }
      // F = Forward
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setShowForward(true);
      }
      // J or N = Next thread
      if (e.key === 'j' || e.key === 'J' || e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        onNextThread?.();
      }
      // K or P = Previous thread
      if (e.key === 'k' || e.key === 'K' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        onPrevThread?.();
      }
      // A = Archive
      if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        archiveEmailMutation.mutate();
      }
      // E = Expand all
      if (e.key === 'e' || e.key === 'E') {
        e.preventDefault();
        setExpandedMessages(new Set(freshThread.messages.map(m => m.id)));
      }
      // Escape = Back
      if (e.key === 'Escape') {
        e.preventDefault();
        onBack();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [replyExpanded, freshThread, onNextThread, onPrevThread, onBack]);

  const { data: labelData = [] } = useQuery({
   queryKey: ["email-labels", account?.id],
   queryFn: () =>
     base44.entities.EmailLabel.filter({
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
        <div className="sticky top-0 bg-white/95 backdrop-blur-sm z-10 px-4 py-2.5 border-b border-slate-200 shadow-sm flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-1 min-w-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onBack()}
              className="gap-1.5 hover:bg-slate-100 text-slate-700 font-medium shrink-0"
              title="Back to Inbox (Esc)"
              aria-label="Back to inbox"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Inbox</span>
            </Button>
            <span className="text-slate-300 hidden sm:inline">|</span>
            {/* Thread subject truncated */}
            <span className="text-sm font-semibold text-slate-800 truncate min-w-0 hidden sm:block">{thread.subject}</span>
          </div>
          {/* Right: prev/next + shortcuts hint */}
          <div className="flex items-center gap-1 shrink-0">
            <span className="text-xs text-muted-foreground/50 hidden lg:inline mr-2">
              <kbd className="bg-slate-100 px-1 rounded text-[10px]">J</kbd>/<kbd className="bg-slate-100 px-1 rounded text-[10px]">K</kbd> nav
              <span className="mx-1">·</span>
              <kbd className="bg-slate-100 px-1 rounded text-[10px]">R</kbd> reply
              <span className="mx-1">·</span>
              <kbd className="bg-slate-100 px-1 rounded text-[10px]">F</kbd> fwd
              <span className="mx-1">·</span>
              <kbd className="bg-slate-100 px-1 rounded text-[10px]">A</kbd> archive
              <span className="mx-1">·</span>
              <kbd className="bg-slate-100 px-1 rounded text-[10px]">E</kbd> expand all
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onPrevThread?.()}
              disabled={!onPrevThread}
              title="Previous thread (P)"
              className="h-8 w-8 text-slate-500 disabled:opacity-30"
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
              className="h-8 w-8 text-slate-500 disabled:opacity-30"
              aria-label="Next thread"
            >
              <ChevronDown className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Thread Header — Subject + Actions */}
        <div className={cn("px-5 pt-5 pb-4 bg-white border-b", priorityConfig[msg.priority] || '')}>
          {/* Subject */}
          <h1 className="text-[22px] font-bold text-slate-900 leading-snug mb-3 pr-2">
            {thread.subject || <em className="text-slate-400 font-normal">(no subject)</em>}
          </h1>

          {/* Action toolbar */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {/* Primary actions */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReplyExpanded(v => !v)}
              className={cn("gap-1.5 font-medium", replyExpanded && "bg-blue-50 border-blue-300 text-blue-700")}
              aria-label="Reply"
              title="Reply (R)"
            >
              <Reply className="h-3.5 w-3.5" />
              Reply
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

            <div className="h-5 w-px bg-slate-200 mx-0.5" />

            {/* Star */}
            <button
              onClick={() => setStarredMutation.mutate(!msg.is_starred)}
              className={cn(
                "h-8 w-8 rounded-lg flex items-center justify-center transition-all active:scale-95",
                msg.is_starred
                  ? "text-amber-500 bg-amber-50 hover:bg-amber-100"
                  : "text-slate-400 hover:text-amber-400 hover:bg-amber-50"
              )}
              aria-label={msg.is_starred ? "Remove star" : "Star this thread"}
              title={msg.is_starred ? "Unstar" : "Star"}
            >
              <Star className={cn("h-4 w-4 transition-all", msg.is_starred && "fill-current")} />
            </button>

            {/* Visibility */}
            <button
              onClick={() => setVisibilityMutation.mutate(msg.visibility === 'shared' ? 'private' : 'shared')}
              className={cn(
                "h-8 px-2 rounded-lg flex items-center gap-1.5 text-xs font-semibold transition-all active:scale-95",
                msg.visibility === 'shared'
                  ? "text-blue-700 bg-blue-50 hover:bg-blue-100"
                  : "text-slate-500 hover:text-slate-700 hover:bg-slate-100"
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
              className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all active:scale-95"
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

            <div className="h-5 w-px bg-slate-200 mx-0.5" />

            {/* Archive / Restore */}
            {currentView !== "archived" && currentView !== "deleted" ? (
              <button
                onClick={() => archiveEmailMutation.mutate()}
                disabled={archiveEmailMutation.isPending}
                className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all active:scale-95 disabled:opacity-40"
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
                  className="h-8 w-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-all"
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
                <DropdownMenuItem onClick={() => window.print()}>
                  <RefreshCw className="h-4 w-4 mr-2 text-muted-foreground" />
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
            <div className="flex flex-wrap gap-1.5 mt-3 pt-3 border-t border-slate-100 items-center">
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
        <div className="px-5 py-2.5 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between gap-2">
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
              className="flex-shrink-0 flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-200/60 px-2 py-1 rounded-lg transition-all"
              title={allExpanded ? "Collapse all" : "Expand all (E)"}
              aria-label={allExpanded ? "Collapse all messages" : "Expand all messages"}
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
              {totalMessages} messages
            </button>
          )}
        </div>

        {/* Message list */}
        <div className="flex-1 divide-y divide-slate-100 bg-white">
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
                    className="flex items-center gap-3 px-5 py-2 bg-slate-50/80 border-y border-slate-100 cursor-pointer hover:bg-slate-100/80 transition-colors"
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
                                "w-6 h-6 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white border-2 border-white",
                                sColor
                              )}
                            >
                              {sender.charAt(0).toUpperCase()}
                            </div>
                          );
                        })}
                      </div>
                      <span className="text-xs text-slate-500 font-medium">
                        {collapsedCount} older message{collapsedCount !== 1 ? 's' : ''}
                        {collapsedSenders.length <= 3
                          ? ` from ${collapsedSenders.join(', ')}`
                          : ` from ${collapsedSenders.slice(0, 2).join(', ')} and ${collapsedSenders.length - 2} other${collapsedSenders.length - 2 !== 1 ? 's' : ''}`
                        }
                      </span>
                    </div>
                    <span className="text-[10px] text-slate-400 flex items-center gap-1 flex-shrink-0">
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
                    "transition-all duration-150",
                    !isExpanded && !isLatest && "hover:bg-slate-50/80 cursor-pointer",
                    isLatest && "bg-white"
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
                        <span className={cn("text-sm truncate", isExpanded ? "font-bold text-slate-900" : "font-semibold text-slate-700")}>
                          {msgItem.from_name || msgItem.from}
                        </span>
                        {!isExpanded && (
                          <span className="text-xs text-slate-400 truncate min-w-0 hidden sm:block">
                            {msgItem.body ? msgItem.body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80) : ''}
                          </span>
                        )}
                      </div>
                      {isExpanded && (
                        <p className="text-xs text-slate-500 truncate">
                          to {(msgItem.to || []).join(', ')}
                        </p>
                      )}
                    </div>

                    {/* Right: date + actions */}
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-slate-400 font-medium whitespace-nowrap">
                        {formatEmailDateTime(msgItem.received_at)}
                      </span>
                      {!isLatest && (
                        isExpanded
                          ? <ChevronUp className="h-4 w-4 text-slate-400" />
                          : <ChevronDown className="h-4 w-4 text-slate-400" />
                      )}
                      {isExpanded && (
                        <button
                          onClick={(e) => { e.stopPropagation(); copyEmail(msgItem.from); }}
                          className="p-1 hover:bg-slate-100 rounded-md transition-colors"
                          title="Copy sender email"
                          aria-label="Copy sender email"
                        >
                          <Copy className="h-3.5 w-3.5 text-slate-400" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Expanded: full body */}
                  {isExpanded && (
                    <div className="px-5 pb-6">
                      {/* Sandboxed email body */}
                      <div
                        className="prose prose-sm max-w-none text-slate-800 leading-relaxed overflow-x-auto"
                        style={{ fontFamily: 'inherit' }}
                        dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msgItem.body) }}
                      />

                      {/* Attachments */}
                      {msgItem.attachments && msgItem.attachments.length > 0 && (
                        <div className="mt-5 pt-4 border-t border-slate-100">
                          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">
                            Attachments ({msgItem.attachments.length})
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {msgItem.attachments.map((att, aidx) => (
                              <a
                                key={aidx}
                                href={att.file_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl bg-slate-50 border border-slate-200 hover:border-blue-300 hover:bg-blue-50 transition-all group max-w-xs"
                              >
                                <div className="w-8 h-8 bg-white rounded-lg border border-slate-200 flex items-center justify-center text-base flex-shrink-0">
                                  📄
                                </div>
                                <div className="flex-1 min-w-0">
                                  <p className="text-xs font-bold text-slate-700 group-hover:text-blue-700 truncate leading-tight">
                                    {att.filename}
                                  </p>
                                  {att.size && (
                                    <p className="text-[10px] text-slate-400 font-medium mt-0.5">
                                      {formatFileSize(att.size)}
                                    </p>
                                  )}
                                </div>
                              </a>
                            ))}
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

        {/* Reply / Forward Box */}
        <div className="sticky bottom-0 bg-white border-t border-slate-200 shadow-lg">
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
                onClick={() => setReplyExpanded(true)}
                className="flex-1 text-left text-sm text-slate-400 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-full px-4 py-2 transition-all"
                aria-label="Click to reply"
              >
                Reply to {msg.from_name || msg.from}…
              </button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setReplyExpanded(true)}
                className="gap-1.5 text-blue-600 hover:bg-blue-50 font-semibold"
                aria-label="Reply"
              >
                <Reply className="h-3.5 w-3.5" /> Reply
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowForward(true)}
                className="gap-1.5 text-slate-500 hover:bg-slate-100 font-medium"
                aria-label="Forward"
              >
                <Forward className="h-3.5 w-3.5" /> Forward
              </Button>
            </div>
          ) : (
            <div className="p-4 space-y-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-bold text-slate-700">Reply</span>
                <button
                  onClick={() => setReplyExpanded(false)}
                  className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1 rounded hover:bg-slate-100 transition-colors"
                  aria-label="Close reply"
                >
                  Discard
                </button>
              </div>
              <QuickReplyTemplates
                onTemplateSelect={() => {}}
                compact={true}
              />
              <EmailComposeReply
                thread={thread}
                account={account}
                onClose={() => { setReplyExpanded(false); latestMessageRef.current?.scrollIntoView({ behavior: 'smooth' }); }}
                onReplyMode={() => {}}
                emailAccounts={emailAccounts}
              />
            </div>
          )}
        </div>

        </div>

      {/* Right Sidebar */}
      <div className="hidden lg:flex flex-col overflow-y-auto max-h-[calc(100vh-64px)] bg-slate-50/40 border-l">
        {/* Sidebar header */}
        <div className="px-4 py-3 border-b border-slate-200 bg-white sticky top-0 z-10">
          <p className="text-xs font-bold text-slate-500 uppercase tracking-wider">Details</p>
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
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Tracking</p>
              </div>
              <div className="p-4 space-y-3">
                <EmailOpenStats messageId={msg.id} />
                <EmailLinkStats messageBody={msg.body} />
              </div>
            </div>

            {/* Activity log */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <p className="text-xs font-bold text-slate-600 uppercase tracking-wider">Activity</p>
              </div>
              <div className="max-h-72 overflow-y-auto">
                <EmailActivityLog messageId={msg.id} />
              </div>
            </div>

            {/* Raw source — collapsed by default, dev tool */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <button
                className="w-full px-4 py-3 flex items-center justify-between text-xs font-bold text-slate-500 uppercase tracking-wider hover:bg-slate-50 transition-colors"
                onClick={() => setShowRaw(v => !v)}
                aria-expanded={showRaw}
                aria-label="Toggle email source"
              >
                <span>Email Source</span>
                {showRaw ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </button>
              {showRaw && (
                <div className="border-t border-slate-100">
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
          email={msg}
          type="forward"
          onClose={() => setShowForward(false)}
          onSent={() => {
            setShowForward(false);
            toast.success('Email forwarded');
          }}
        />
      )}

      <SnoozeDialog
        open={showSnoozeDialog}
        onOpenChange={setShowSnoozeDialog}
        onSnooze={(option) => {
          toast.success(`Email snoozed ${option.label}`);
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
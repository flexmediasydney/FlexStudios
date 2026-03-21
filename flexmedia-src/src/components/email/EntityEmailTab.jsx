import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { Mail, Plus, Search, Reply, Archive, Trash2, Lock, Users, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import EmailComposeDialog from './EmailComposeDialog';
import ProjectLinkDialogForInbox from './ProjectLinkDialogForInbox';
import EmailListContainer from './EmailListContainer';
import { useColumnManager } from './useColumnManager';
import { cn } from '@/lib/utils';

/**
 * EntityEmailTab
 * 
 * Reusable email subtab for Organisation/Team/People detail pages.
 * Filters EmailMessages by entity type/id. Fully wired compose/reply/link/activity integration.
 * 
 * Props:
 *  - entityType: 'agency' | 'team' | 'agent'
 *  - entityId: string
 *  - entityLabel: string (e.g., "Acme Inc", "Sales Team")
 *  - onEmailActivity: (action, data) => void (fires when email state changes for Activity tab sync)
 */
export default function EntityEmailTab({
  entityType,
  entityId,
  entityLabel,
  onEmailActivity,
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMessages, setSelectedMessages] = useState(new Set());
  const [selectedThread, setSelectedThread] = useState(null);
  const [showCompose, setShowCompose] = useState(false);
  const [linkProjectThread, setLinkProjectThread] = useState(null);
  const queryClient = useQueryClient();
  const { columns, fitToScreen } = useColumnManager();

  // Filter EmailMessages by entity
  const buildEmailFilters = useCallback(() => {
    const filters = {};
    if (entityType === 'agency') {
      filters.agency_id = entityId;
    } else if (entityType === 'team') {
      // Team emails: from team members or linked to org
      // For now, filter by shared visibility + search in related projects
      filters.visibility = 'shared';
    } else if (entityType === 'agent') {
      filters.agent_id = entityId;
    }
    return filters;
  }, [entityType, entityId]);

  const { data: messages = [], isLoading: messagesLoading } = useQuery({
    queryKey: ['emails', entityType, entityId],
    queryFn: async () => {
      const filters = buildEmailFilters();
      return await api.entities.EmailMessage.filter(filters, '-received_at', 100);
    },
    staleTime: 2 * 60 * 1000,
  });

  // Group into threads
  const threads = useMemo(() => {
    const threadMap = new Map();
    messages.forEach(msg => {
      const key = `${msg.email_account_id}|||${msg.gmail_thread_id}`;
      if (threadMap.has(key)) {
        const existing = threadMap.get(key);
        existing.messages.push(msg);
        if (msg.is_unread) existing.unreadCount += 1;
      } else {
        threadMap.set(key, {
          threadId: msg.gmail_thread_id,
          email_account_id: msg.email_account_id,
          subject: msg.subject,
          from: msg.from_name || msg.from,
          from_email: msg.from,
          lastMessage: msg.received_at,
          unreadCount: msg.is_unread ? 1 : 0,
          messages: [msg],
          project_id: msg.project_id,
          project_title: msg.project_title,
          agent_id: msg.agent_id,
          agent_name: msg.agent_name,
          agency_id: msg.agency_id,
          agency_name: msg.agency_name,
        });
      }
    });
    return Array.from(threadMap.values());
  }, [messages]);

  // Search filter
  const filteredThreads = useMemo(() => {
    if (!searchQuery.trim()) return threads;
    const q = searchQuery.toLowerCase();
    return threads.filter(t =>
      (t.subject || '').toLowerCase().includes(q) ||
      (t.from || '').toLowerCase().includes(q) ||
      (t.from_email || '').toLowerCase().includes(q)
    );
  }, [threads, searchQuery]);

  // Email stats
  const emailStats = useMemo(() => {
    const total = threads.length;
    const unread = threads.reduce((n, t) => n + (t.unreadCount || 0), 0);
    const sent = threads.filter(t =>
      t.messages.some(m => m.is_sent)
    ).length;

    const latestDate = threads.reduce((latest, t) => {
      const d = t.lastMessage ? new Date(t.lastMessage) : new Date(0);
      return d > latest ? d : latest;
    }, new Date(0));

    const awaitingReply = threads.filter(t => {
      const msgs = [...t.messages].sort(
        (a, b) => new Date(a.received_at) - new Date(b.received_at)
      );
      const last = msgs[msgs.length - 1];
      return last && !last.is_sent;
    }).length;

    return { total, unread, sent, latestDate, awaitingReply };
  }, [threads]);

  // Mutations
  const updateMessageMutation = useMutation({
    mutationFn: (data) => api.entities.EmailMessage.update(data.messageId, data.updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['emails', entityType, entityId] });
    },
  });

  const handleToggleVisibility = async (thread, newVisibility) => {
    const msg = thread.messages[0];
    if (!msg) return;
    try {
      await updateMessageMutation.mutateAsync({
        messageId: msg.id,
        updates: { visibility: newVisibility },
      });
      onEmailActivity?.('visibility_toggled', {
        threadId: thread.threadId,
        visibility: newVisibility,
      });
      toast.success(
        newVisibility === 'shared'
          ? 'Email shared with team'
          : 'Email set to private'
      );
    } catch {
      toast.error('Failed to update visibility');
    }
  };

  const handleLinkProject = async (thread) => {
    setLinkProjectThread(thread);
  };

  const handleCompose = () => {
    setShowCompose(true);
  };

  if (messagesLoading) {
    return (
      <div className="h-full flex items-center justify-center bg-muted/20">
        <div className="space-y-2 text-center">
          <Mail className="h-8 w-8 text-muted-foreground/40 mx-auto" />
          <p className="text-sm text-muted-foreground">Loading emails...</p>
        </div>
      </div>
    );
  }

  if (filteredThreads.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-muted/20 p-6">
        <Mail className="h-12 w-12 text-muted-foreground/30 mb-3" />
        <h3 className="text-sm font-semibold text-muted-foreground mb-1">No emails yet</h3>
        <p className="text-xs text-muted-foreground/70 text-center mb-4">
          Emails from and about {entityLabel} will appear here
        </p>
        <Button size="sm" onClick={handleCompose} className="gap-2">
          <Plus className="h-3.5 w-3.5" />
          Compose Email
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-background">
      {/* Email Stats Header */}
      {threads.length > 0 && (
        <div className="px-4 py-2.5 border-b bg-muted/30 text-xs flex items-center gap-4 flex-wrap shrink-0">
          <div className="flex items-center gap-1">
            <span className="font-semibold">{emailStats.total}</span>
            <span className="text-muted-foreground">thread{emailStats.total !== 1 ? 's' : ''}</span>
          </div>
          {emailStats.unread > 0 && (
            <div className="flex items-center gap-1 text-amber-600">
              <span className="font-medium">{emailStats.unread}</span>
              <span>unread</span>
            </div>
          )}
          {emailStats.awaitingReply > 0 && (
            <div className="flex items-center gap-1 text-blue-600">
              <span className="font-medium">{emailStats.awaitingReply}</span>
              <span>awaiting reply</span>
            </div>
          )}
          {emailStats.sent > 0 && (
            <div className="text-muted-foreground">
              {emailStats.sent} sent
            </div>
          )}
          {emailStats.latestDate.getTime() > 0 && (
            <div className="flex items-center gap-1 text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>Last: {emailStats.latestDate.toLocaleDateString('en-AU', {
                day: 'numeric', month: 'short',
                hour: '2-digit', minute: '2-digit', hour12: true,
              })}</span>
            </div>
          )}
        </div>
      )}

      {/* Header controls */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-card shrink-0">
        <div className="flex-1 relative max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search emails..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-7 pr-3 h-8 text-xs border-input/50 focus-visible:ring-1"
          />
        </div>

        <Button
          size="sm"
          onClick={handleCompose}
          className="gap-1.5"
          title="Compose new email"
        >
          <Plus className="h-3.5 w-3.5" />
          Compose
        </Button>

        <div className="text-xs text-muted-foreground">
          {filteredThreads.length} email{filteredThreads.length !== 1 ? 's' : ''}
        </div>
      </div>

      {/* Email list */}
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
            onEmailActivity?.('opened', { threadId: thread.threadId });
          }}
          messagesLoading={false}
          filterUnread={false}
          searchQuery={searchQuery}
          filterView="inbox"
          onCompose={handleCompose}
          labelData={[]}
          onLinkProject={handleLinkProject}
          onToggleVisibility={handleToggleVisibility}
        />
      </div>

      {/* Dialogs */}
      {showCompose && (
        <EmailComposeDialog
          entityType={entityType}
          entityId={entityId}
          entityLabel={entityLabel}
          onClose={() => setShowCompose(false)}
          onSent={() => {
            setShowCompose(false);
            queryClient.invalidateQueries({ queryKey: ['emails', entityType, entityId] });
            onEmailActivity?.('sent', { entityType, entityId });
          }}
        />
      )}

      {linkProjectThread && (
        <ProjectLinkDialogForInbox
          thread={linkProjectThread}
          open={!!linkProjectThread}
          onOpenChange={(open) => {
            if (!open) setLinkProjectThread(null);
          }}
          onLinked={() => {
            queryClient.invalidateQueries({ queryKey: ['emails', entityType, entityId] });
            onEmailActivity?.('linked', { threadId: linkProjectThread.threadId });
          }}
        />
      )}
    </div>
  );
}
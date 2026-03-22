import React, { useState, useMemo, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import {
  MessageSquare, Mail, Pin,
  ChevronDown, ChevronRight, Lightbulb
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fixTimestamp } from '@/components/utils/dateUtils';
import UnifiedNoteComposer from '@/components/notes/UnifiedNoteComposer';
import EmailComposeDialog from '@/components/email/EmailComposeDialog';
import ProjectActivityFeedItem from './ProjectActivityFeedItem';

const COMPOSE_TABS = [
  { key: 'note', label: 'Note', icon: MessageSquare },
  { key: 'email', label: 'Email', icon: Mail },
];

const FEED_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'notes', label: 'Notes' },
  { key: 'activities', label: 'Activities' },
  { key: 'emails', label: 'Emails' },
  { key: 'changelog', label: 'Changelog' },
];

const ITEMS_PER_PAGE = 30;

export default function ProjectActivityHub({ projectId, project }) {
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();

  const [composeTab, setComposeTab] = useState('note');
  const [composeExpanded, setComposeExpanded] = useState(true);
  const [feedFilter, setFeedFilter] = useState('all');
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [showEmailCompose, setShowEmailCompose] = useState(false);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);

  // ── Data fetching ──

  const { data: myEmailAccounts = [] } = useQuery({
    queryKey: ['my-email-accounts', currentUser?.id],
    queryFn: () => api.entities.EmailAccount.filter({
      assigned_to_user_id: currentUser?.id,
      is_active: true,
    }),
    enabled: !!currentUser?.id,
  });

  const myAccountIds = useMemo(() => new Set(myEmailAccounts.map(a => a.id)), [myEmailAccounts]);

  const { data: notes = [], isLoading: notesLoading } = useQuery({
    queryKey: ['org-notes-project', projectId],
    queryFn: () => api.entities.OrgNote.filter(
      { project_id: projectId },
      '-created_date',
      200
    ),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const { data: activities = [], isLoading: activitiesLoading } = useQuery({
    queryKey: ['project-activities', projectId],
    queryFn: () => api.entities.ProjectActivity.filter(
      { project_id: projectId },
      '-created_date',
      200
    ),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  const { data: allProjectEmails = [], isLoading: emailsLoading } = useQuery({
    queryKey: ['project-emails', projectId],
    queryFn: () => api.entities.EmailMessage.filter(
      { project_id: projectId },
      '-received_at'
    ),
    enabled: !!projectId,
    staleTime: 30 * 1000,
  });

  // Visibility filter: shared emails visible to all, private only to owner
  const emails = useMemo(
    () => allProjectEmails.filter(e =>
      e.visibility === 'shared' || myAccountIds.has(e.email_account_id)
    ),
    [allProjectEmails, myAccountIds]
  );

  const handleNoteSaved = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['org-notes-project', projectId] });
    queryClient.invalidateQueries({ queryKey: ['project-activities', projectId] });
  }, [queryClient, projectId]);

  // ── Pinned notes ──
  const pinnedNotes = useMemo(
    () => notes.filter(n => n.is_pinned && !n.parent_note_id),
    [notes]
  );

  // ── Build unified feed items ──
  const allItems = useMemo(() => {
    const items = [];

    // Only include root notes (not replies)
    const rootNotes = notes.filter(n => !n.parent_note_id && !n.is_pinned);
    for (const n of rootNotes) {
      items.push({
        type: 'note',
        id: `note-${n.id}`,
        timestamp: n.created_date,
        author: n.author_name,
        content: n.content,
        _raw: n,
      });
    }

    for (const a of activities) {
      items.push({
        type: 'activity',
        id: `activity-${a.id}`,
        timestamp: a.created_date,
        author: a.user_name,
        description: a.description,
        action: a.action,
        _raw: a,
      });
    }

    for (const e of emails) {
      items.push({
        type: 'email',
        id: `email-${e.id}`,
        timestamp: e.received_at,
        author: e.from_name || e.from,
        subject: e.subject,
        preview: e.body?.replace(/<[^>]*>/g, '').substring(0, 100),
        _raw: e,
      });
    }

    return items.sort(
      (a, b) => new Date(fixTimestamp(b.timestamp)) - new Date(fixTimestamp(a.timestamp))
    );
  }, [notes, activities, emails]);

  // ── Filtered items ──
  const filteredItems = useMemo(() => {
    switch (feedFilter) {
      case 'notes':
        return allItems.filter(i => i.type === 'note');
      case 'activities':
        return allItems.filter(i => i.type === 'activity');
      case 'emails':
        return allItems.filter(i => i.type === 'email');
      case 'changelog':
        return allItems.filter(i => i.type === 'activity' && i._raw?.changed_fields?.length > 0);
      default:
        return allItems;
    }
  }, [allItems, feedFilter]);

  const visibleItems = filteredItems.slice(0, visibleCount);
  const hasMore = visibleCount < filteredItems.length;

  // ── Counts for filter badges ──
  const counts = useMemo(() => ({
    all: allItems.length,
    notes: allItems.filter(i => i.type === 'note').length,
    activities: allItems.filter(i => i.type === 'activity').length,
    emails: allItems.filter(i => i.type === 'email').length,
    changelog: allItems.filter(i => i.type === 'activity' && i._raw?.changed_fields?.length > 0).length,
  }), [allItems]);

  const isLoading = notesLoading || activitiesLoading || emailsLoading;

  return (
    <div className="space-y-0">
      {/* ── Compose Bar ── */}
      <Card className="overflow-hidden">
        {/* Compose tab bar */}
        <div className="flex items-center border-b bg-muted/30">
          <div className="flex items-center gap-0.5 px-2 py-1.5">
            {COMPOSE_TABS.map(tab => {
              const Icon = tab.icon;
              const isActive = composeTab === tab.key && composeExpanded;
              return (
                <button
                  key={tab.key}
                  onClick={() => {
                    if (tab.key === 'email') {
                      setShowEmailCompose(true);
                      return;
                    }
                    if (composeTab === tab.key) {
                      setComposeExpanded(e => !e);
                    } else {
                      setComposeTab(tab.key);
                      setComposeExpanded(true);
                    }
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/60'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <div className="flex-1" />
          <button
            onClick={() => setComposeExpanded(e => !e)}
            className="p-2 text-muted-foreground hover:text-foreground transition-colors mr-1"
            title={composeExpanded ? 'Collapse composer' : 'Expand composer'}
          >
            {composeExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        </div>

        {/* Compose body */}
        {composeExpanded && (
          <div className="p-3">
            {composeTab === 'note' && (
              <div className="shadow-sm rounded-lg">
                <UnifiedNoteComposer
                  agencyId={project?.agency_id}
                  projectId={projectId}
                  contextType="project"
                  contextLabel={project?.title || project?.property_address || 'Project'}
                  currentUser={currentUser}
                  onSave={handleNoteSaved}
                  onCancel={() => {}}
                />
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── Pinned Section ── */}
      {pinnedNotes.length > 0 && (
        <div className="mt-3">
          <button
            onClick={() => setPinnedExpanded(e => !e)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-amber-700 hover:bg-amber-50/50 transition-colors rounded-t-lg bg-amber-50/30 border border-amber-100/60"
          >
            <span className="flex items-center gap-1.5">
              <Pin className="h-3 w-3 fill-amber-400 text-amber-500" />
              Pinned ({pinnedNotes.length})
            </span>
            {pinnedExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
          {pinnedExpanded && (
            <div className="border border-t-0 border-amber-100/60 rounded-b-lg bg-amber-50/10 px-3 py-2 space-y-1">
              {pinnedNotes.map((note, idx) => (
                <ProjectActivityFeedItem
                  key={note.id}
                  item={{
                    type: 'note',
                    id: `pinned-note-${note.id}`,
                    timestamp: note.created_date,
                    author: note.author_name,
                    content: note.content,
                    _raw: note,
                  }}
                  projectId={projectId}
                  isLast={idx === pinnedNotes.length - 1}
                  onNoteRefresh={handleNoteSaved}
                  currentUser={currentUser}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Filter Tabs ── */}
      <div className="flex items-center gap-1 px-1 py-2 mt-3 overflow-x-auto">
        {FEED_FILTERS.map(tab => {
          const count = counts[tab.key];
          const isActive = feedFilter === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => {
                setFeedFilter(tab.key);
                setVisibleCount(ITEMS_PER_PAGE);
              }}
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {tab.label}
              {count > 0 && (
                <span className={`text-[9px] px-1 py-0.5 rounded-full leading-none ${
                  isActive ? 'bg-white/25 text-white' : 'bg-muted-foreground/15 text-muted-foreground'
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Timeline Feed ── */}
      <div className="mt-1">
        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex gap-3 animate-pulse">
                <div className="w-8 h-8 rounded-full bg-muted flex-shrink-0" />
                <div className="flex-1 space-y-2 pt-1">
                  <div className="h-3 w-32 bg-muted rounded" />
                  <div className="h-16 bg-muted rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : visibleItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Lightbulb className="h-10 w-10 text-yellow-300 mb-3" />
            <p className="text-sm font-medium text-foreground/60">
              {feedFilter === 'all' ? 'No activity yet' : `No ${feedFilter} yet`}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {feedFilter === 'all'
                ? 'Add a note or send an email to get started'
                : `Switch to "All" to see other activity types`
              }
            </p>
          </div>
        ) : (
          <>
            {visibleItems.map((item, idx) => (
              <ProjectActivityFeedItem
                key={item.id}
                item={item}
                projectId={projectId}
                isLast={idx === visibleItems.length - 1 && !hasMore}
                onNoteRefresh={handleNoteSaved}
                currentUser={currentUser}
                isEmailOwner={item.type === 'email' && item._raw ? myAccountIds.has(item._raw.email_account_id) : false}
              />
            ))}
            {hasMore && (
              <div className="flex justify-center py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setVisibleCount(c => c + ITEMS_PER_PAGE)}
                  className="text-xs"
                >
                  Load more ({filteredItems.length - visibleCount} remaining)
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Email compose dialog */}
      {showEmailCompose && (
        <EmailComposeDialog
          onClose={() => setShowEmailCompose(false)}
          onSent={() => {
            queryClient.invalidateQueries({ queryKey: ['project-emails', projectId] });
            setShowEmailCompose(false);
          }}
          projectId={projectId}
          defaultProjectId={projectId}
          defaultProjectTitle={project?.title || project?.property_address}
        />
      )}
    </div>
  );
}

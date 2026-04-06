import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';
import {
  MessageSquare, Mail, Pin,
  ChevronDown, ChevronRight, Lightbulb,
  FileText, Zap, ListChecks, ArrowUpDown
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { fixTimestamp, formatRelative, fmtTimestampCustom } from '@/components/utils/dateUtils';
import UnifiedNoteComposer from '@/components/notes/UnifiedNoteComposer';
import EmailComposeDialog from '@/components/email/EmailComposeDialog';
import ProjectActivityFeedItem from './ProjectActivityFeedItem';

// ── Filter chip definitions ──────────────────────────────────────────────────
// Multi-selectable chips. "All" is a special toggle that clears other selections.
const FILTER_CHIPS = [
  { key: 'all',       label: 'All',            icon: null },
  { key: 'notes',     label: 'Notes',          icon: MessageSquare },
  { key: 'emails',    label: 'Emails',         icon: Mail },
  { key: 'status',    label: 'Status Changes', icon: ArrowUpDown },
  { key: 'tasks',     label: 'Task Updates',   icon: ListChecks },
  { key: 'tonomo',    label: 'Tonomo',         icon: Zap },
];

// Actions that count as "status changes"
const STATUS_ACTIONS = new Set(['status_change', 'outcome_changed', 'payment_changed']);
// Actions that count as "task updates"
const TASK_ACTIONS = new Set(['task_added', 'task_completed', 'task_deleted']);
// Actions from Tonomo
const TONOMO_ACTIONS = new Set([
  'tonomo_booking_created', 'tonomo_booking_updated', 'tonomo_rescheduled',
  'tonomo_changed', 'tonomo_cancelled', 'tonomo_delivered',
]);

// ── Empty state messages per filter ──────────────────────────────────────────
const EMPTY_MESSAGES = {
  all: {
    title: 'No activity yet',
    subtitle: 'Add a note or send an email to get started',
  },
  notes: {
    title: 'No notes yet',
    subtitle: 'Use the composer above to add a note to this project',
  },
  emails: {
    title: 'No emails linked to this project yet',
    subtitle: 'Link emails from your inbox or compose a new one',
  },
  status: {
    title: 'No status changes recorded',
    subtitle: 'Status, outcome, and payment changes will appear here',
  },
  tasks: {
    title: 'No task updates yet',
    subtitle: 'Task additions, completions, and deletions will appear here',
  },
  tonomo: {
    title: 'No Tonomo activity',
    subtitle: 'Bookings synced from Tonomo will appear here',
  },
  field_changes: {
    title: 'No field changes recorded',
    subtitle: 'Edits to project fields like price, address, and dates will appear here',
  },
};

const EMPTY_ICONS = {
  all: Lightbulb,
  notes: MessageSquare,
  emails: Mail,
  status: ArrowUpDown,
  tasks: ListChecks,
  tonomo: Zap,
  field_changes: FileText,
};

const ITEMS_PER_PAGE = 30;

// ── Smart timestamp: relative for recent, absolute for older ─────────────────
function smartTimestamp(ts) {
  if (!ts) return '\u2014';
  const fixed = fixTimestamp(ts);
  const now = new Date();
  const then = new Date(fixed);
  const diffMs = now - then;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  // Within 7 days: use relative time
  if (diffMs < 7 * ONE_DAY && diffMs >= 0) {
    return formatRelative(ts);
  }
  // Older: absolute date
  return fmtTimestampCustom(ts, {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

export default function ProjectActivityHub({ projectId, project }) {
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();

  // Filter state: set of active chip keys. Default is just 'all'.
  const [activeFilters, setActiveFilters] = useState(new Set(['all']));
  const [fieldChangesOnly, setFieldChangesOnly] = useState(false);
  const [pinnedExpanded, setPinnedExpanded] = useState(true);
  const [showEmailCompose, setShowEmailCompose] = useState(false);
  const [visibleCount, setVisibleCount] = useState(ITEMS_PER_PAGE);

  // ── Filter chip toggle logic ──
  const toggleFilter = useCallback((key) => {
    setActiveFilters(prev => {
      if (key === 'all') {
        // "All" always resets to just All
        return new Set(['all']);
      }
      const next = new Set(prev);
      next.delete('all'); // selecting any specific chip de-selects All
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      // If nothing selected, revert to All
      return next.size === 0 ? new Set(['all']) : next;
    });
    setVisibleCount(ITEMS_PER_PAGE);
  }, []);

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

  // ── Real-time subscriptions ──
  const refetchActivities = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['project-activities', projectId] });
  }, [queryClient, projectId]);

  const refetchNotes = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['org-notes-project', projectId] });
  }, [queryClient, projectId]);

  const refetchEmails = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['project-emails', projectId] });
  }, [queryClient, projectId]);

  useEffect(() => {
    if (!projectId) return;
    const unsub = api.entities.ProjectActivity.subscribe((event) => {
      if (event.data?.project_id === projectId) {
        refetchActivities();
      }
    });
    return typeof unsub === 'function' ? unsub : undefined;
  }, [projectId, refetchActivities]);

  useEffect(() => {
    if (!projectId) return;
    const unsub = api.entities.OrgNote.subscribe((event) => {
      if (event.data?.project_id === projectId) {
        refetchNotes();
      }
    });
    return typeof unsub === 'function' ? unsub : undefined;
  }, [projectId, refetchNotes]);

  useEffect(() => {
    if (!projectId) return;
    const unsub = api.entities.EmailMessage.subscribe((event) => {
      if (event.data?.project_id === projectId) {
        refetchEmails();
      }
    });
    return typeof unsub === 'function' ? unsub : undefined;
  }, [projectId, refetchEmails]);

  // ── Pinned notes ──
  const pinnedNotes = useMemo(
    () => notes.filter(n => n.is_pinned && !n.parent_note_id),
    [notes]
  );

  // ── Build reply map for note threading ──
  const replyMap = useMemo(() => {
    const map = {};
    for (const n of notes) {
      if (n.parent_note_id) {
        if (!map[n.parent_note_id]) map[n.parent_note_id] = [];
        map[n.parent_note_id].push(n);
      }
    }
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) =>
        new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date))
      );
    }
    return map;
  }, [notes]);

  // ── Build unified feed items ──
  const allItems = useMemo(() => {
    const items = [];

    // Only include root notes (not replies, not pinned)
    const rootNotes = notes.filter(n => !n.parent_note_id && !n.is_pinned);
    for (const n of rootNotes) {
      items.push({
        type: 'note',
        id: `note-${n.id}`,
        timestamp: n.created_date,
        author: n.author_name,
        content: n.content,
        _raw: n,
        _replies: replyMap[n.id] || [],
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
  }, [notes, activities, emails, replyMap]);

  // ── Filtered items (multi-select chips + field changes toggle) ──
  const filteredItems = useMemo(() => {
    let result = allItems;

    // If not "all", apply multi-select chip filters
    if (!activeFilters.has('all')) {
      result = result.filter(item => {
        if (activeFilters.has('notes') && item.type === 'note') return true;
        if (activeFilters.has('emails') && item.type === 'email') return true;
        if (activeFilters.has('status') && item.type === 'activity' && STATUS_ACTIONS.has(item.action)) return true;
        if (activeFilters.has('tasks') && item.type === 'activity' && TASK_ACTIONS.has(item.action)) return true;
        if (activeFilters.has('tonomo') && item.type === 'activity' && (TONOMO_ACTIONS.has(item.action) || item._raw?.actor_type === 'tonomo')) return true;
        return false;
      });
    }

    // "Show field changes only" toggle narrows activity items to those with changed_fields
    if (fieldChangesOnly) {
      result = result.filter(item =>
        item.type !== 'activity' || (item._raw?.changed_fields?.length > 0)
      );
    }

    return result;
  }, [allItems, activeFilters, fieldChangesOnly]);

  const visibleItems = filteredItems.slice(0, visibleCount);
  const hasMore = visibleCount < filteredItems.length;

  // ── Counts for filter badges ──
  const counts = useMemo(() => ({
    all: allItems.length,
    notes: allItems.filter(i => i.type === 'note').length,
    emails: allItems.filter(i => i.type === 'email').length,
    status: allItems.filter(i => i.type === 'activity' && STATUS_ACTIONS.has(i.action)).length,
    tasks: allItems.filter(i => i.type === 'activity' && TASK_ACTIONS.has(i.action)).length,
    tonomo: allItems.filter(i => i.type === 'activity' && (TONOMO_ACTIONS.has(i.action) || i._raw?.actor_type === 'tonomo')).length,
  }), [allItems]);

  const isLoading = notesLoading || activitiesLoading || emailsLoading;

  // ── Determine which empty state to show ──
  const emptyStateKey = useMemo(() => {
    if (fieldChangesOnly && activeFilters.has('all')) return 'field_changes';
    if (activeFilters.has('all')) return 'all';
    // Pick the first active filter for the empty message
    for (const chip of FILTER_CHIPS) {
      if (chip.key !== 'all' && activeFilters.has(chip.key)) return chip.key;
    }
    return 'all';
  }, [activeFilters, fieldChangesOnly]);

  return (
    <div className="space-y-0" data-activity-hub>
      {/* ── Note Composer (always visible) ── */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-foreground/70">
            <MessageSquare className="h-3.5 w-3.5" />
            Quick Note
          </div>
          <button
            onClick={() => setShowEmailCompose(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          >
            <Mail className="h-3.5 w-3.5" />
            Email
          </button>
        </div>
        <div className="p-3">
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
        </div>
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
                    _replies: replyMap[note.id] || [],
                  }}
                  projectId={projectId}
                  isLast={idx === pinnedNotes.length - 1}
                  onNoteRefresh={handleNoteSaved}
                  currentUser={currentUser}
                  smartTimestamp={smartTimestamp}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Filter Chips (multi-select) + field changes toggle ── */}
      <div className="flex items-center gap-1.5 px-1 py-2 mt-3 overflow-x-auto flex-wrap">
        {FILTER_CHIPS.map(chip => {
          const count = counts[chip.key];
          const isActive = activeFilters.has(chip.key);
          const ChipIcon = chip.icon;
          return (
            <button
              key={chip.key}
              onClick={() => toggleFilter(chip.key)}
              className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors whitespace-nowrap ${
                isActive
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {ChipIcon && <ChipIcon className="h-3 w-3" />}
              {chip.label}
              {count > 0 && (
                <span className={`text-[9px] px-1 py-0.5 rounded-full leading-none ${
                  isActive ? 'bg-card/25 text-white' : 'bg-muted-foreground/15 text-muted-foreground'
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}

        {/* Divider */}
        <div className="w-px h-5 bg-border mx-1" />

        {/* Field changes toggle */}
        <button
          onClick={() => {
            setFieldChangesOnly(v => !v);
            setVisibleCount(ITEMS_PER_PAGE);
          }}
          className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full font-medium transition-colors whitespace-nowrap ${
            fieldChangesOnly
              ? 'bg-amber-100 text-amber-800 border border-amber-300'
              : 'bg-muted text-muted-foreground hover:bg-muted/80'
          }`}
        >
          <FileText className="h-3 w-3" />
          Field changes only
        </button>
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
            {(() => {
              const EmptyIcon = EMPTY_ICONS[emptyStateKey] || Lightbulb;
              const msg = EMPTY_MESSAGES[emptyStateKey] || EMPTY_MESSAGES.all;
              return (
                <>
                  <EmptyIcon className="h-10 w-10 text-muted-foreground/40 mb-3" />
                  <p className="text-sm font-medium text-foreground/60">
                    {msg.title}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {msg.subtitle}
                  </p>
                </>
              );
            })()}
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
                smartTimestamp={smartTimestamp}
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

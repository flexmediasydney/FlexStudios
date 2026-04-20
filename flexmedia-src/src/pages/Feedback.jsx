import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Bug, Columns3, LayoutList, Lightbulb, Plus, Sparkles, User as UserIcon } from 'lucide-react';
import { api } from '@/api/supabaseClient';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser, usePermissions } from '@/components/auth/PermissionGuard';
import { cn } from '@/lib/utils';
import FeedbackKanban from '@/components/feedback/FeedbackKanban';
import FeedbackList from '@/components/feedback/FeedbackList';
import FeedbackSubmitDialog from '@/components/feedback/FeedbackSubmitDialog';
import FeedbackDetailSlideout from '@/components/feedback/FeedbackDetailSlideout';
import { AREA_OPTIONS } from '@/components/feedback/feedbackConstants';

/**
 * /feedback — internal bug & improvement tracker.
 * Kanban-first. List view available via a toggle. Filters are URL-persisted so
 * links round-trip cleanly.
 */

const TYPE_FILTERS = [
  { value: 'all', label: 'All', icon: null },
  { value: 'bug', label: 'Bugs', icon: Bug },
  { value: 'improvement', label: 'Improvements', icon: Lightbulb },
  { value: 'feature_request', label: 'Features', icon: Sparkles },
];

export default function Feedback() {
  const [searchParams, setSearchParams] = useSearchParams();

  const [submitOpen, setSubmitOpen] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const { data: currentUser } = useCurrentUser();
  const { isManagerOrAbove } = usePermissions();

  // URL-persisted state with sensible defaults.
  const view = searchParams.get('view') === 'list' ? 'list' : 'kanban';
  const typeFilter = searchParams.get('type') || 'all';
  const areaFilter = searchParams.get('area') || 'all';
  const myReports = searchParams.get('mine') === '1';
  const myVotes = searchParams.get('voted') === '1';

  const setParam = useCallback((key, value) => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === '' || value === 'all' || value === false) {
      next.delete(key);
    } else {
      next.set(key, typeof value === 'boolean' ? '1' : String(value));
    }
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Data ─────────────────────────────────────────────────────────────────
  const { data: items = [], loading: itemsLoading, error: itemsError, refetch: refetchItems }
    = useEntityList('FeedbackItem', '-created_at', 5000);

  const { data: myVoteRows = [] } = useEntityList(
    currentUser?.id ? 'FeedbackVote' : null,
    null,
    5000,
    currentUser?.id ? { user_id: currentUser.id } : null,
  );

  const { data: allUsers = [] } = useEntityList(
    isManagerOrAbove ? 'User' : null,
    'full_name',
    500,
  );

  const votedIds = useMemo(() => new Set(myVoteRows.map(v => v.feedback_id)), [myVoteRows]);

  // ── Filtering ────────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return items.filter(it => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (areaFilter !== 'all' && (it.area || '') !== areaFilter) return false;
      if (myReports && currentUser?.id && it.created_by !== currentUser.id) return false;
      if (myVotes && !votedIds.has(it.id)) return false;
      return true;
    });
  }, [items, typeFilter, areaFilter, myReports, myVotes, currentUser?.id, votedIds]);

  // Selected item kept in sync with the latest cached version so optimistic
  // updates from the slide-out reflect without a local refetch.
  const selectedItem = useMemo(
    () => (selectedId ? items.find(i => i.id === selectedId) : null),
    [selectedId, items],
  );

  const openDetail = useCallback((item) => setSelectedId(item?.id || null), []);
  const closeDetail = useCallback(() => setSelectedId(null), []);

  // ── Voting (single-vote-per-user; DB has a unique constraint) ───────────
  const toggleVote = useCallback(async (item) => {
    if (!currentUser?.id) {
      toast.error('You must be signed in to vote.');
      return;
    }
    const has = votedIds.has(item.id);
    try {
      if (has) {
        // Remove my vote — find it by (feedback_id, user_id).
        const row = myVoteRows.find(v => v.feedback_id === item.id);
        if (row) await api.entities.FeedbackVote.delete(row.id);
      } else {
        await api.entities.FeedbackVote.create({
          feedback_id: item.id,
          user_id: currentUser.id,
        });
      }
      // Invalidate both lists so vote_count (maintained by backend trigger) and
      // the user's vote set refresh. Running in parallel keeps the UI snappy.
      await Promise.all([
        refetchEntityList('FeedbackVote'),
        refetchEntityList('FeedbackItem'),
      ]);
    } catch (err) {
      // Unique constraint violation = already voted (race condition); swallow.
      const msg = err?.message || 'Vote failed';
      if (/duplicate|unique/i.test(msg)) {
        refetchEntityList('FeedbackVote');
        return;
      }
      toast.error(msg);
    }
  }, [currentUser?.id, votedIds, myVoteRows]);

  // Close slideout if the item disappears (e.g. deleted by another user).
  useEffect(() => {
    if (selectedId && !itemsLoading && !items.find(i => i.id === selectedId)) {
      setSelectedId(null);
    }
  }, [selectedId, items, itemsLoading]);

  const totalCount = items.length;
  const filteredCount = filtered.length;

  return (
    <div className="px-4 sm:px-6 py-4 max-w-[1600px] mx-auto">
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Feedback</h1>
          <p className="text-xs text-muted-foreground">Internal bug & improvement tracker</p>
        </div>
        <Button onClick={() => setSubmitOpen(true)} size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> Report
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {TYPE_FILTERS.map(t => {
          const Icon = t.icon;
          const active = typeFilter === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setParam('type', t.value)}
              className={cn(
                'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
                active ? 'bg-primary text-primary-foreground border-primary' : 'bg-background hover:bg-muted border-border text-muted-foreground'
              )}
            >
              {Icon && <Icon className="h-3 w-3" />}
              {t.label}
            </button>
          );
        })}

        <div className="h-4 w-px bg-border mx-1" />

        <Select value={areaFilter} onValueChange={(v) => setParam('area', v)}>
          <SelectTrigger className="h-8 w-40 text-xs"><SelectValue placeholder="All areas" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {AREA_OPTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={() => setParam('mine', !myReports)}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
            myReports ? 'bg-primary/10 text-primary border-primary/30' : 'bg-background hover:bg-muted border-border text-muted-foreground'
          )}
        >
          <UserIcon className="h-3 w-3" /> My reports
        </button>
        <button
          type="button"
          onClick={() => setParam('voted', !myVotes)}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
            myVotes ? 'bg-primary/10 text-primary border-primary/30' : 'bg-background hover:bg-muted border-border text-muted-foreground'
          )}
        >
          My votes
        </button>

        <div className="ml-auto flex items-center gap-1">
          <Badge variant="secondary" className="text-[10px]">
            {filteredCount === totalCount ? `${totalCount} items` : `${filteredCount} of ${totalCount}`}
          </Badge>
          <div className="h-4 w-px bg-border mx-1" />
          <Button
            variant={view === 'kanban' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => setParam('view', 'kanban')}
          >
            <Columns3 className="h-3.5 w-3.5" /> Kanban
          </Button>
          <Button
            variant={view === 'list' ? 'default' : 'outline'}
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => setParam('view', 'list')}
          >
            <LayoutList className="h-3.5 w-3.5" /> List
          </Button>
        </div>
      </div>

      {itemsError && (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-300 mb-3 flex items-center justify-between">
          <span>Failed to load feedback: {itemsError.message || 'Unknown error'}</span>
          <Button size="sm" variant="outline" onClick={() => refetchItems()}>Retry</Button>
        </div>
      )}

      {view === 'kanban' ? (
        <FeedbackKanban
          items={filtered}
          loading={itemsLoading}
          votedIds={votedIds}
          canEdit={isManagerOrAbove}
          onCardClick={openDetail}
          onToggleVote={toggleVote}
        />
      ) : (
        <FeedbackList
          items={filtered}
          loading={itemsLoading}
          votedIds={votedIds}
          users={allUsers}
          onRowClick={openDetail}
          onToggleVote={toggleVote}
        />
      )}

      <FeedbackSubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />

      <FeedbackDetailSlideout
        open={!!selectedItem}
        onOpenChange={(o) => { if (!o) closeDetail(); }}
        item={selectedItem}
        items={items}
        currentUser={currentUser}
        users={allUsers}
        voted={selectedItem ? votedIds.has(selectedItem.id) : false}
        canEdit={isManagerOrAbove}
        onToggleVote={toggleVote}
      />
    </div>
  );
}

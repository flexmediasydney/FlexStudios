import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import { Bug, Lightbulb, Sparkles, ChevronUp, MessageCircle, Plus, X } from 'lucide-react';
import { api } from '@/api/supabaseClient';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { useCurrentUser, usePermissions } from '@/components/auth/PermissionGuard';
import { cn } from '@/lib/utils';
import FeedbackSubmitDialog from '@/components/feedback/FeedbackSubmitDialog';
import {
  TYPE_META,
  SEVERITY_META,
  STATUS_COLUMNS,
  STATUS_META,
  columnForStatus,
  AREA_OPTIONS,
} from '@/components/feedback/feedbackConstants';

// Rewritten 2026-04-21 as the minimal, defensively-coded v1. Previous
// version split into 5 sub-components + Sheet + ScrollArea + react-markdown
// and something in that chain was crashing the whole React tree on Vercel.
// Everything here is inline, uses primitives the rest of the app already
// depends on, and has no lazy sub-chunks. Good enough for a tiny-team tool.

const TYPE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'bug', label: 'Bugs', icon: Bug },
  { value: 'improvement', label: 'Improvements', icon: Lightbulb },
  { value: 'feature_request', label: 'Features', icon: Sparkles },
];

const ALL_STATUSES = ['new', 'triaging', 'accepted', 'in_progress', 'shipped', 'declined', 'duplicate'];
const SEVERITY_OPTIONS = ['critical', 'high', 'medium', 'low'];

export default function Feedback() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [selected, setSelected] = useState(null);

  const { data: currentUser } = useCurrentUser();
  const { isManagerOrAbove } = usePermissions();

  const typeFilter = searchParams.get('type') || 'all';
  const areaFilter = searchParams.get('area') || 'all';
  const myReports = searchParams.get('mine') === '1';
  const myVotes = searchParams.get('voted') === '1';

  const setParam = useCallback((key, value) => {
    const next = new URLSearchParams(searchParams);
    if (!value || value === 'all' || value === false) next.delete(key);
    else next.set(key, value === true ? '1' : String(value));
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  // ── Data ─────────────────────────────────────────────────────────
  const {
    data: items = [],
    loading: itemsLoading,
    error: itemsError,
    refetch: refetchItems,
  } = useEntityList('FeedbackItem', '-created_at', 500);

  const { data: myVoteRows = [] } = useEntityList(
    currentUser?.id ? 'FeedbackVote' : null,
    null,
    500,
    currentUser?.id ? { user_id: currentUser.id } : null,
  );
  const votedIds = useMemo(
    () => new Set((myVoteRows || []).map((v) => v.feedback_id)),
    [myVoteRows],
  );

  // ── Filtering ────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    return (items || []).filter((it) => {
      if (typeFilter !== 'all' && it.type !== typeFilter) return false;
      if (areaFilter !== 'all' && (it.area || '') !== areaFilter) return false;
      if (myReports && currentUser?.id && it.created_by !== currentUser.id) return false;
      if (myVotes && !votedIds.has(it.id)) return false;
      return true;
    });
  }, [items, typeFilter, areaFilter, myReports, myVotes, currentUser?.id, votedIds]);

  const byColumn = useMemo(() => {
    const map = {};
    STATUS_COLUMNS.forEach((c) => { map[c.id] = []; });
    filtered.forEach((it) => {
      const col = columnForStatus(it.status) || 'new';
      (map[col] || map.new).push(it);
    });
    Object.values(map).forEach((arr) => {
      arr.sort((a, b) => {
        const v = (b.vote_count || 0) - (a.vote_count || 0);
        if (v !== 0) return v;
        const ad = new Date(a.created_at || 0).getTime();
        const bd = new Date(b.created_at || 0).getTime();
        return bd - ad;
      });
    });
    return map;
  }, [filtered]);

  // ── Voting ───────────────────────────────────────────────────────
  const toggleVote = useCallback(async (item) => {
    if (!currentUser?.id) {
      toast.error('You must be signed in to vote.');
      return;
    }
    const has = votedIds.has(item.id);
    try {
      if (has) {
        const row = (myVoteRows || []).find((v) => v.feedback_id === item.id);
        if (row) await api.entities.FeedbackVote.delete(row.id);
      } else {
        await api.entities.FeedbackVote.create({
          feedback_id: item.id,
          user_id: currentUser.id,
        });
      }
      await Promise.all([
        refetchEntityList('FeedbackVote'),
        refetchEntityList('FeedbackItem'),
      ]);
    } catch (err) {
      const msg = err?.message || 'Vote failed';
      if (/duplicate|unique/i.test(msg)) {
        refetchEntityList('FeedbackVote');
        return;
      }
      toast.error(msg);
    }
  }, [currentUser?.id, votedIds, myVoteRows]);

  // ── Status change (admin) ────────────────────────────────────────
  const changeStatus = useCallback(async (item, newStatus) => {
    if (!isManagerOrAbove || item.status === newStatus) return;
    const updates = { status: newStatus };
    const nowIso = new Date().toISOString();
    if (newStatus === 'accepted' && !item.accepted_at) updates.accepted_at = nowIso;
    if (newStatus === 'shipped' && !item.shipped_at) updates.shipped_at = nowIso;
    if (newStatus === 'declined' && !item.declined_at) updates.declined_at = nowIso;
    try {
      await api.entities.FeedbackItem.update(item.id, updates);
      toast.success(`Moved to ${STATUS_META[newStatus]?.label || newStatus}`);
      refetchEntityList('FeedbackItem');
      // Keep the slideout's item in sync if it's currently open.
      setSelected((prev) => (prev && prev.id === item.id ? { ...prev, ...updates } : prev));
    } catch (err) {
      toast.error(err?.message || 'Failed to update status');
      refetchEntityList('FeedbackItem');
    }
  }, [isManagerOrAbove]);

  // Close the detail dialog if the item disappeared (e.g. deleted).
  useEffect(() => {
    if (selected && !(items || []).find((i) => i.id === selected.id)) {
      setSelected(null);
    }
  }, [items, selected]);

  const totalCount = items?.length || 0;
  const filteredCount = filtered.length;

  return (
    <div className="px-4 sm:px-6 py-4 max-w-[1700px] mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Feedback</h1>
          <p className="text-xs text-muted-foreground">Internal bug &amp; improvement tracker</p>
        </div>
        <Button onClick={() => setSubmitOpen(true)} size="sm" className="gap-1">
          <Plus className="h-4 w-4" /> Report
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        {TYPE_FILTERS.map((t) => {
          const Icon = t.icon;
          const active = typeFilter === t.value;
          return (
            <button
              key={t.value}
              type="button"
              onClick={() => setParam('type', t.value)}
              className={cn(
                'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
                active
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted border-border text-muted-foreground',
              )}
            >
              {Icon ? <Icon className="h-3 w-3" /> : null}
              {t.label}
            </button>
          );
        })}

        <div className="h-4 w-px bg-border mx-1" />

        <Select value={areaFilter} onValueChange={(v) => setParam('area', v)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="All areas" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All areas</SelectItem>
            {AREA_OPTIONS.map((a) => (
              <SelectItem key={a} value={a}>{a}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <button
          type="button"
          onClick={() => setParam('mine', !myReports)}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
            myReports
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-background hover:bg-muted border-border text-muted-foreground',
          )}
        >
          My reports
        </button>
        <button
          type="button"
          onClick={() => setParam('voted', !myVotes)}
          className={cn(
            'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors',
            myVotes
              ? 'bg-primary/10 text-primary border-primary/30'
              : 'bg-background hover:bg-muted border-border text-muted-foreground',
          )}
        >
          My votes
        </button>

        <div className="ml-auto">
          <Badge variant="secondary" className="text-[10px]">
            {filteredCount === totalCount ? `${totalCount} items` : `${filteredCount} of ${totalCount}`}
          </Badge>
        </div>
      </div>

      {itemsError ? (
        <div className="rounded-md border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-xs text-red-700 dark:text-red-300 mb-3 flex items-center justify-between">
          <span>Failed to load feedback: {itemsError.message || 'Unknown error'}</span>
          <Button size="sm" variant="outline" onClick={() => refetchItems()}>Retry</Button>
        </div>
      ) : null}

      {/* Kanban grid — plain CSS, no DnD. Admin changes status via detail dialog. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2">
        {STATUS_COLUMNS.map((col) => {
          const colItems = byColumn[col.id] || [];
          return (
            <div key={col.id} className="min-w-0">
              <div className={cn('px-3 py-2 rounded-t-md flex items-center justify-between', col.color)}>
                <h3 className="text-sm font-semibold truncate" title={col.label}>{col.label}</h3>
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-card/60 text-foreground font-medium tabular-nums">
                  {colItems.length}
                </span>
              </div>
              <div className="bg-muted/15 rounded-b-md p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-220px)] overflow-y-auto">
                {itemsLoading && colItems.length === 0 ? (
                  <div className="h-16 rounded bg-muted/40 animate-pulse" />
                ) : null}
                {!itemsLoading && colItems.length === 0 ? (
                  <div className="text-center text-xs text-muted-foreground/60 py-6 italic">No items</div>
                ) : null}
                {colItems.map((it) => (
                  <FeedbackMiniCard
                    key={it.id}
                    item={it}
                    voted={votedIds.has(it.id)}
                    onClick={() => setSelected(it)}
                    onVote={() => toggleVote(it)}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* Detail dialog — simpler than Sheet, less to go wrong */}
      <Dialog
        open={!!selected}
        onOpenChange={(o) => {
          if (!o) setSelected(null);
        }}
      >
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          {selected ? (
            <FeedbackDetail
              item={selected}
              currentUser={currentUser}
              canEdit={isManagerOrAbove}
              voted={votedIds.has(selected.id)}
              onToggleVote={() => toggleVote(selected)}
              onChangeStatus={(s) => changeStatus(selected, s)}
              onClose={() => setSelected(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <FeedbackSubmitDialog open={submitOpen} onOpenChange={setSubmitOpen} />
    </div>
  );
}

// ─── Small card shown in each kanban column ─────────────────────────
function FeedbackMiniCard({ item, voted, onClick, onVote }) {
  const typeMeta = TYPE_META[item.type] || TYPE_META.bug;
  const sevMeta = SEVERITY_META[item.severity] || SEVERITY_META.medium;
  return (
    <Card
      onClick={onClick}
      className="p-2 cursor-pointer hover:shadow-md transition-shadow space-y-1.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium line-clamp-2">{item.title}</div>
        </div>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onVote(); }}
          className={cn(
            'flex flex-col items-center gap-0 px-1.5 py-0.5 rounded border text-[10px] transition-colors',
            voted
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-background border-border text-muted-foreground hover:bg-muted',
          )}
          aria-label={voted ? 'Remove vote' : 'Vote'}
        >
          <ChevronUp className="h-3 w-3" />
          <span className="font-semibold tabular-nums">{item.vote_count || 0}</span>
        </button>
      </div>

      <div className="flex items-center gap-1 flex-wrap">
        <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', typeMeta.badge)}>
          {typeMeta.label}
        </span>
        <span className={cn('w-1.5 h-1.5 rounded-full', sevMeta.dot)} title={sevMeta.label} />
        {item.area ? (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {item.area}
          </span>
        ) : null}
        {item.comment_count > 0 ? (
          <span className="text-[10px] text-muted-foreground inline-flex items-center gap-0.5 ml-auto">
            <MessageCircle className="h-3 w-3" />
            {item.comment_count}
          </span>
        ) : null}
      </div>

      {item.created_by_name ? (
        <div className="text-[10px] text-muted-foreground truncate">
          {item.created_by_name}
        </div>
      ) : null}
    </Card>
  );
}

// ─── Detail view (rendered inside a Dialog) ─────────────────────────
function FeedbackDetail({ item, currentUser, canEdit, voted, onToggleVote, onChangeStatus, onClose }) {
  const typeMeta = TYPE_META[item.type] || TYPE_META.bug;
  const sevMeta = SEVERITY_META[item.severity] || SEVERITY_META.medium;
  const statusMeta = STATUS_META[item.status] || STATUS_META.new;

  const [comments, setComments] = useState([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);

  const loadComments = useCallback(async () => {
    if (!item?.id) return;
    setLoadingComments(true);
    try {
      const data = await api.entities.FeedbackComment.filter({ feedback_id: item.id }, 'created_at', 500);
      setComments(data || []);
    } catch (e) {
      toast.error(e?.message || 'Failed to load comments');
    } finally {
      setLoadingComments(false);
    }
  }, [item?.id]);

  useEffect(() => { loadComments(); }, [loadComments]);

  const postComment = async () => {
    const body = newComment.trim();
    if (!body || !currentUser?.id) return;
    setPosting(true);
    try {
      await api.entities.FeedbackComment.create({
        feedback_id: item.id,
        user_id: currentUser.id,
        user_name: currentUser.full_name || currentUser.email,
        user_email: currentUser.email,
        body,
      });
      setNewComment('');
      await loadComments();
      refetchEntityList('FeedbackItem');
    } catch (e) {
      toast.error(e?.message || 'Failed to post comment');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle className="text-base pr-6 line-clamp-3">{item.title}</DialogTitle>
        <DialogDescription className="flex items-center gap-1.5 flex-wrap">
          <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', typeMeta.badge)}>{typeMeta.label}</span>
          <span className={cn('w-1.5 h-1.5 rounded-full', sevMeta.dot)} title={sevMeta.label} />
          <span className="text-xs text-muted-foreground">Severity: {sevMeta.label}</span>
          <span className="mx-1">·</span>
          <span className="text-xs text-muted-foreground">{statusMeta.label}</span>
          {item.area ? (
            <>
              <span className="mx-1">·</span>
              <span className="text-xs text-muted-foreground">{item.area}</span>
            </>
          ) : null}
        </DialogDescription>
      </DialogHeader>

      <div className="flex items-center gap-3 flex-wrap">
        <button
          type="button"
          onClick={onToggleVote}
          className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-medium transition-colors',
            voted
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'bg-background border-border text-foreground hover:bg-muted',
          )}
        >
          <ChevronUp className="h-3.5 w-3.5" />
          {voted ? 'Voted' : 'Vote'}
          <span className="tabular-nums">({item.vote_count || 0})</span>
        </button>

        {canEdit ? (
          <div className="flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground">Status:</span>
            <Select value={item.status} onValueChange={onChangeStatus}>
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ALL_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>{STATUS_META[s]?.label || s}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <div className="ml-auto text-[11px] text-muted-foreground">
          {item.created_by_name ? `By ${item.created_by_name} · ` : ''}
          {item.created_at ? new Date(item.created_at).toLocaleString() : ''}
        </div>
      </div>

      {item.description ? (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Description</div>
          <div className="text-sm whitespace-pre-wrap break-words">{item.description}</div>
        </div>
      ) : null}

      {Array.isArray(item.screenshots) && item.screenshots.length > 0 ? (
        <div>
          <div className="text-xs text-muted-foreground mb-1">Screenshots</div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {item.screenshots.map((s, i) => {
              const url = typeof s === 'string' ? s : s?.url;
              if (!url) return null;
              return (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="block">
                  <img src={url} alt="" className="w-full h-24 object-cover rounded border hover:opacity-80 transition-opacity" />
                </a>
              );
            })}
          </div>
        </div>
      ) : null}

      {item.page_url ? (
        <div className="text-[11px] text-muted-foreground">
          Reported from: <a href={item.page_url} className="underline" target="_blank" rel="noopener noreferrer">{item.page_url}</a>
        </div>
      ) : null}

      {/* Comments */}
      <div>
        <div className="flex items-center gap-2 mb-2">
          <MessageCircle className="h-4 w-4 text-muted-foreground" />
          <div className="text-sm font-medium">Comments</div>
          <span className="text-xs text-muted-foreground">({comments.length})</span>
        </div>
        <div className="space-y-2 mb-3">
          {loadingComments ? (
            <div className="text-xs text-muted-foreground italic">Loading…</div>
          ) : comments.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No comments yet.</div>
          ) : (
            comments.map((c) => (
              <div key={c.id} className="text-sm">
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <span className="font-medium text-foreground">{c.user_name || c.user_email || 'User'}</span>
                  <span>{c.created_at ? new Date(c.created_at).toLocaleString() : ''}</span>
                </div>
                <div className="whitespace-pre-wrap break-words">{c.body}</div>
              </div>
            ))
          )}
        </div>
        <Textarea
          value={newComment}
          onChange={(e) => setNewComment(e.target.value)}
          placeholder="Add a comment…"
          className="text-sm"
          rows={3}
        />
        <div className="flex justify-end mt-2">
          <Button
            size="sm"
            onClick={postComment}
            disabled={posting || !newComment.trim()}
          >
            {posting ? 'Posting…' : 'Comment'}
          </Button>
        </div>
      </div>

      <div className="flex justify-end pt-2 border-t">
        <Button size="sm" variant="outline" onClick={onClose}>
          <X className="h-3 w-3 mr-1" /> Close
        </Button>
      </div>
    </div>
  );
}

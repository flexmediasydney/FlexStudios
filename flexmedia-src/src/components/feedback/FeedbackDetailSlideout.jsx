import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronUp, ExternalLink, MessageCircle, X } from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import ReactMarkdown from 'react-markdown';
import { toast } from 'sonner';
import { api } from '@/api/supabaseClient';
import { refetchEntityList } from '@/components/hooks/useEntityData';
import { cn } from '@/lib/utils';
import { TYPE_META, SEVERITY_META, STATUS_META, STATUS_COLUMNS, AREA_OPTIONS } from './feedbackConstants';

/**
 * Slide-out detail panel for a single feedback item.
 *
 * The parent passes in the latest `item` snapshot so edits reflected via the
 * shared entity cache propagate here without a local refetch.
 */
export default function FeedbackDetailSlideout({
  open,
  onOpenChange,
  item,
  items, // full list so we can mark duplicates
  currentUser,
  users,
  voted,
  canEdit,
  onToggleVote,
}) {
  const [comments, setComments] = useState([]);
  const [loadingComments, setLoadingComments] = useState(false);
  const [newComment, setNewComment] = useState('');
  const [postingComment, setPostingComment] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const itemId = item?.id;

  const loadComments = useCallback(async () => {
    if (!itemId) return;
    setLoadingComments(true);
    try {
      const data = await api.entities.FeedbackComment.filter({ feedback_id: itemId }, 'created_at', 500);
      setComments(data || []);
    } catch (err) {
      toast.error(err?.message || 'Failed to load comments');
    } finally {
      setLoadingComments(false);
    }
  }, [itemId]);

  useEffect(() => {
    if (open && itemId) {
      loadComments();
    } else {
      setComments([]);
      setNewComment('');
    }
  }, [open, itemId, loadComments]);

  const typeMeta = item ? (TYPE_META[item.type] || TYPE_META.bug) : null;
  const sevMeta = item ? (SEVERITY_META[item.severity] || SEVERITY_META.medium) : null;
  const statusMeta = item ? (STATUS_META[item.status] || { label: item.status }) : null;

  const userList = useMemo(
    () => (users || []).filter(u => u.is_active !== false).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || '')),
    [users]
  );

  const duplicateCandidates = useMemo(() => {
    if (!items || !item) return [];
    return items
      .filter(i => i.id !== item.id && i.status !== 'duplicate')
      .slice(0, 200);
  }, [items, item]);

  // Inline admin update — every save fires immediately.
  const update = async (patch) => {
    if (!item) return;
    try {
      await api.entities.FeedbackItem.update(item.id, patch);
      toast.success('Saved');
      refetchEntityList('FeedbackItem');
    } catch (err) {
      toast.error(err?.message || 'Update failed');
    }
  };

  const postComment = async () => {
    const body = newComment.trim();
    if (!body || !item) return;
    setPostingComment(true);
    try {
      const row = await api.entities.FeedbackComment.create({
        feedback_id: item.id,
        user_id: currentUser?.id || null,
        user_name: currentUser?.full_name || null,
        user_email: currentUser?.email || null,
        body,
        is_internal_note: false,
      });
      setComments(prev => [...prev, row]);
      setNewComment('');
      // comment_count is maintained by DB triggers in a well-behaved backend,
      // but nudge the list to refresh in case it needs to recalculate.
      refetchEntityList('FeedbackItem');
    } catch (err) {
      toast.error(err?.message || 'Failed to post comment');
    } finally {
      setPostingComment(false);
    }
  };

  if (!item) return null;

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-0 flex flex-col">
          {/* Header */}
          <div className="px-6 pt-6 pb-4 border-b">
            <SheetHeader>
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge variant="outline" className={cn('text-[10px] font-medium', typeMeta.badge)}>
                  {typeMeta.label}
                </Badge>
                <Badge variant="secondary" className="text-[10px] font-medium">
                  {statusMeta.label}
                </Badge>
                <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                  <span className={cn('w-2 h-2 rounded-full', sevMeta.dot)} />
                  {sevMeta.label}
                </span>
              </div>
              <SheetTitle className="text-lg leading-snug pr-6">{item.title}</SheetTitle>
              <SheetDescription className="text-xs">
                {item.created_by_name || 'Unknown'} ·{' '}
                {(() => { try { return formatDistanceToNow(new Date(item.created_at || item.created_date), { addSuffix: true }); } catch { return ''; } })()}
              </SheetDescription>
            </SheetHeader>
          </div>

          <ScrollArea className="flex-1">
            <div className="px-6 py-4 space-y-5">
              {/* Meta row */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                {item.area && (
                  <div>
                    <div className="text-muted-foreground">Area</div>
                    <div className="font-medium">{item.area}</div>
                  </div>
                )}
                <div>
                  <div className="text-muted-foreground">Assigned to</div>
                  <div className="font-medium">
                    {item.assigned_to
                      ? (users?.find(u => u.id === item.assigned_to)?.full_name || '—')
                      : 'Unassigned'}
                  </div>
                </div>
              </div>

              {/* Description */}
              {item.description && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1">Description</div>
                  <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown>{item.description}</ReactMarkdown>
                  </div>
                </div>
              )}

              {/* Screenshots */}
              {Array.isArray(item.screenshots) && item.screenshots.length > 0 && (
                <div>
                  <div className="text-xs text-muted-foreground mb-1.5">Screenshots</div>
                  <div className="grid grid-cols-3 gap-2">
                    {item.screenshots.map((s, i) => (
                      <button
                        type="button"
                        key={s.path || s.url || i}
                        onClick={() => setLightbox(s.url)}
                        className="block rounded-md overflow-hidden border hover:ring-2 hover:ring-primary/40 transition-shadow"
                      >
                        <img src={s.url} alt={s.name || `Screenshot ${i + 1}`} className="w-full h-20 object-cover" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Vote bar */}
              <div>
                <Button
                  variant={voted ? 'default' : 'outline'}
                  className="w-full gap-2"
                  onClick={() => onToggleVote?.(item)}
                >
                  <ChevronUp className="h-4 w-4" />
                  {voted ? 'Voted' : 'Upvote'} · <span className="tabular-nums">{item.vote_count || 0}</span>
                </Button>
              </div>

              {/* Admin controls */}
              {canEdit && (
                <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                  <div className="text-xs font-semibold">Admin</div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[11px]">Status</Label>
                      <Select value={item.status} onValueChange={(v) => {
                        const patch = { status: v };
                        const nowIso = new Date().toISOString();
                        if (v === 'accepted' && !item.accepted_at) patch.accepted_at = nowIso;
                        if (v === 'shipped' && !item.shipped_at) patch.shipped_at = nowIso;
                        if (v === 'declined' && !item.declined_at) patch.declined_at = nowIso;
                        update(patch);
                      }}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {STATUS_COLUMNS.map(s => <SelectItem key={s.id} value={s.id}>{s.label}</SelectItem>)}
                          <SelectItem value="duplicate">Duplicate</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1">
                      <Label className="text-[11px]">Severity</Label>
                      <Select value={item.severity || 'medium'} onValueChange={(v) => update({ severity: v })}>
                        <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="critical">Critical</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="low">Low</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1 col-span-2">
                      <Label className="text-[11px]">Assigned to</Label>
                      <Select
                        value={item.assigned_to || '__none__'}
                        onValueChange={(v) => update({ assigned_to: v === '__none__' ? null : v })}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Unassigned" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Unassigned</SelectItem>
                          {userList.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name || u.email}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1 col-span-2">
                      <Label className="text-[11px]">Area</Label>
                      <Select
                        value={item.area || '__none__'}
                        onValueChange={(v) => update({ area: v === '__none__' ? null : v })}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="None" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">None</SelectItem>
                          {AREA_OPTIONS.map(a => <SelectItem key={a} value={a}>{a}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1 col-span-2">
                      <Label className="text-[11px]">Duplicate of</Label>
                      <Select
                        value={item.duplicate_of || '__none__'}
                        onValueChange={(v) => {
                          if (v === '__none__') {
                            update({ duplicate_of: null });
                          } else {
                            update({ duplicate_of: v, status: 'duplicate' });
                          }
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Not a duplicate" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Not a duplicate</SelectItem>
                          {duplicateCandidates.map(d => (
                            <SelectItem key={d.id} value={d.id}>{d.title}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1 col-span-2">
                      <Label className="text-[11px]">Related PR URL</Label>
                      <Input
                        defaultValue={item.related_pr_url || ''}
                        placeholder="https://github.com/…/pull/123"
                        className="h-8 text-xs"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null;
                          if (v !== (item.related_pr_url || null)) update({ related_pr_url: v });
                        }}
                      />
                    </div>

                    <div className="space-y-1 col-span-2">
                      <Label className="text-[11px]">Related commit SHA</Label>
                      <Input
                        defaultValue={item.related_commit_sha || ''}
                        placeholder="abcd1234…"
                        className="h-8 text-xs"
                        onBlur={(e) => {
                          const v = e.target.value.trim() || null;
                          if (v !== (item.related_commit_sha || null)) update({ related_commit_sha: v });
                        }}
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Page context */}
              {(item.page_url || item.user_agent) && (
                <div className="rounded-md border bg-muted/20 p-3 space-y-1 text-xs">
                  {item.page_url && (
                    <div>
                      <span className="text-muted-foreground">Page:</span>{' '}
                      <a href={item.page_url} target="_blank" rel="noreferrer" className="text-primary hover:underline inline-flex items-center gap-1 break-all">
                        {item.page_url}
                        <ExternalLink className="h-3 w-3 flex-shrink-0" />
                      </a>
                    </div>
                  )}
                  {item.user_agent && (
                    <div className="text-muted-foreground text-[10px] break-all">{item.user_agent}</div>
                  )}
                </div>
              )}

              {/* Comments */}
              <div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
                  <MessageCircle className="h-3.5 w-3.5" />
                  <span>Comments ({comments.length})</span>
                </div>
                <div className="space-y-3">
                  {loadingComments && (
                    <>
                      <Skeleton className="h-12" />
                      <Skeleton className="h-12" />
                    </>
                  )}
                  {!loadingComments && comments.length === 0 && (
                    <div className="text-xs text-muted-foreground italic">No comments yet.</div>
                  )}
                  {comments.map(c => (
                    <div key={c.id} className="rounded-md bg-muted/30 p-2.5 text-sm">
                      <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                        <span className="font-medium text-foreground">{c.user_name || c.user_email || 'Unknown'}</span>
                        <span>
                          {(() => { try { return format(new Date(c.created_at || c.created_date), 'MMM d, HH:mm'); } catch { return ''; } })()}
                        </span>
                      </div>
                      <div className="whitespace-pre-wrap text-sm">{c.body}</div>
                    </div>
                  ))}
                </div>

                <div className="mt-3 space-y-2">
                  <Textarea
                    rows={3}
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                    placeholder="Add a comment…"
                    className="resize-y"
                  />
                  <div className="flex justify-end">
                    <Button size="sm" onClick={postComment} disabled={postingComment || !newComment.trim()}>
                      {postingComment ? 'Posting…' : 'Comment'}
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>

      {/* Lightweight lightbox — click outside or the close button to dismiss */}
      {lightbox && (
        <div
          className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightbox(null)}
          role="dialog"
          aria-modal="true"
        >
          <button
            type="button"
            onClick={() => setLightbox(null)}
            className="absolute top-4 right-4 text-white/90 hover:text-white bg-black/40 rounded-full p-1.5"
            aria-label="Close screenshot preview"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={lightbox}
            alt="Screenshot"
            className="max-h-full max-w-full object-contain rounded shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

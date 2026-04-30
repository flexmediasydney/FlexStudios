import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ArrowUp, MessageSquare, Paperclip, Plus, X, Search,
  Bug, Lightbulb, Sparkles, Image as ImageIcon, Trash2,
  Filter as FilterIcon, ChevronRight, Send, Clock,
  CheckCircle2, AlertOctagon, Tag, User as UserIcon,
} from 'lucide-react';
import { api } from '@/api/supabaseClient';
import { useAuth } from '@/lib/AuthContext';

const BUCKET = 'feedback-screenshots';
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const TYPES = [
  { value: 'bug', label: 'Bug', icon: Bug, color: 'text-red-600 bg-red-50 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50' },
  { value: 'improvement', label: 'Improvement', icon: Lightbulb, color: 'text-amber-700 bg-amber-50 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900/50' },
  { value: 'feature_request', label: 'Feature', icon: Sparkles, color: 'text-blue-700 bg-blue-50 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/50' },
];
const SEVERITIES = [
  { value: 'critical', label: 'Critical', color: 'bg-red-600 text-white' },
  { value: 'high',     label: 'High',     color: 'bg-orange-500 text-white' },
  { value: 'medium',   label: 'Medium',   color: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-200' },
  { value: 'low',      label: 'Low',      color: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400' },
];
const STATUSES = [
  { value: 'new',         label: 'New',         color: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300' },
  { value: 'triaging',    label: 'Triaging',    color: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-300' },
  { value: 'accepted',    label: 'Accepted',    color: 'bg-blue-100 text-blue-800 dark:bg-blue-950/50 dark:text-blue-300' },
  { value: 'in_progress', label: 'In progress', color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/50 dark:text-indigo-300' },
  { value: 'shipped',     label: 'Shipped',     color: 'bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-300' },
  { value: 'declined',    label: 'Declined',    color: 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500' },
  { value: 'duplicate',   label: 'Duplicate',   color: 'bg-slate-200 text-slate-500 dark:bg-slate-800 dark:text-slate-500' },
];
const STATUS_BY_VAL = Object.fromEntries(STATUSES.map(s => [s.value, s]));
const TYPE_BY_VAL = Object.fromEntries(TYPES.map(t => [t.value, t]));
const SEV_BY_VAL = Object.fromEntries(SEVERITIES.map(s => [s.value, s]));
const CLOSED_STATUSES = new Set(['shipped', 'declined', 'duplicate']);

function timeAgo(s) {
  if (!s) return '';
  const t = new Date(s).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || '')).toUpperCase();
}

const userDisplayName = (u) => u?.full_name || u?.name || u?.email || '';

export default function Feedback2() {
  const { user } = useAuth();
  const isAdmin = ['master_admin', 'admin', 'manager'].includes(user?.role);
  const supabase = api._supabase;

  const [items, setItems] = useState([]);
  const [votes, setVotes] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [filterStatus, setFilterStatus] = useState('open');
  const [filterType, setFilterType] = useState('all');
  const [mineOnly, setMineOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState('recent'); // recent | top | oldest

  const [showForm, setShowForm] = useState(false);
  const [selectedId, setSelectedId] = useState(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const { data, error: e1 } = await supabase
        .from('feedback_items')
        .select('id,title,description,type,severity,status,area,screenshots,page_url,vote_count,comment_count,created_by,created_by_name,created_by_email,assigned_to,duplicate_of,related_pr_url,related_commit_sha,created_at,updated_at')
        .order('created_at', { ascending: false })
        .limit(500);
      if (e1) throw e1;
      setItems(data || []);

      if (user?.id) {
        const { data: voteRows, error: e2 } = await supabase
          .from('feedback_votes')
          .select('feedback_id')
          .eq('user_id', user.id);
        if (e2) throw e2;
        setVotes(new Set((voteRows || []).map(v => v.feedback_id)));
      }
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [supabase, user?.id]);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime — refresh on any change to feedback_items.
  useEffect(() => {
    if (!user?.id) return;
    const ch = supabase
      .channel(`feedback_items:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feedback_items' }, () => refresh())
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, [supabase, user?.id, refresh]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = items.filter(it => {
      if (filterStatus === 'open' && CLOSED_STATUSES.has(it.status)) return false;
      if (filterStatus !== 'open' && filterStatus !== 'all' && it.status !== filterStatus) return false;
      if (filterType !== 'all' && it.type !== filterType) return false;
      if (mineOnly && it.created_by !== user?.id) return false;
      if (q && !(it.title?.toLowerCase().includes(q) || it.description?.toLowerCase().includes(q) || it.area?.toLowerCase().includes(q))) return false;
      return true;
    });
    if (sort === 'top') arr = [...arr].sort((a, b) => (b.vote_count - a.vote_count) || (new Date(b.created_at) - new Date(a.created_at)));
    else if (sort === 'oldest') arr = [...arr].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    return arr;
  }, [items, filterStatus, filterType, mineOnly, search, sort, user?.id]);

  const counts = useMemo(() => {
    const c = { open: 0, all: items.length };
    for (const s of STATUSES) c[s.value] = 0;
    for (const it of items) {
      c[it.status] = (c[it.status] || 0) + 1;
      if (!CLOSED_STATUSES.has(it.status)) c.open++;
    }
    return c;
  }, [items]);

  const toggleVote = async (item) => {
    if (!user?.id) return;
    const has = votes.has(item.id);
    const nextVotes = new Set(votes);
    if (has) nextVotes.delete(item.id); else nextVotes.add(item.id);
    setVotes(nextVotes);
    setItems(prev => prev.map(p => p.id === item.id ? { ...p, vote_count: p.vote_count + (has ? -1 : 1) } : p));
    try {
      if (has) {
        const { error: e } = await supabase.from('feedback_votes').delete().eq('feedback_id', item.id).eq('user_id', user.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase.from('feedback_votes').insert({ feedback_id: item.id, user_id: user.id });
        if (e) throw e;
      }
    } catch (err) {
      setVotes(votes);
      setItems(prev => prev.map(p => p.id === item.id ? { ...p, vote_count: p.vote_count + (has ? 1 : -1) } : p));
      setError('Vote failed: ' + (err?.message || err));
    }
  };

  const updateItem = async (id, patch) => {
    const prev = items.find(p => p.id === id);
    setItems(arr => arr.map(p => p.id === id ? { ...p, ...patch } : p));
    try {
      const { error: e } = await supabase.from('feedback_items').update(patch).eq('id', id);
      if (e) throw e;
    } catch (err) {
      setItems(arr => arr.map(p => p.id === id ? prev : p));
      setError('Update failed: ' + (err?.message || err));
    }
  };

  const selected = useMemo(() => items.find(i => i.id === selectedId) || null, [items, selectedId]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tracking-tight">Feedback</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
              Bugs, improvements, and feature requests for FlexStudios.
            </p>
          </div>
          <button
            onClick={() => setShowForm(true)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium shadow-sm transition-colors"
          >
            <Plus className="h-4 w-4" /> Submit feedback
          </button>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3 mb-4 shadow-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <FilterChip active={filterStatus === 'open'} onClick={() => setFilterStatus('open')}>
              Open <Count n={counts.open} />
            </FilterChip>
            <FilterChip active={filterStatus === 'all'} onClick={() => setFilterStatus('all')}>
              All <Count n={counts.all} />
            </FilterChip>
            <span className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
            {STATUSES.map(s => (
              <FilterChip key={s.value} active={filterStatus === s.value} onClick={() => setFilterStatus(s.value)}>
                {s.label} <Count n={counts[s.value] || 0} />
              </FilterChip>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 mt-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <FilterIcon className="h-3.5 w-3.5 text-slate-400 ml-0.5" />
            <FilterChip active={filterType === 'all'} onClick={() => setFilterType('all')} compact>All types</FilterChip>
            {TYPES.map(t => {
              const Icon = t.icon;
              return (
                <FilterChip key={t.value} active={filterType === t.value} onClick={() => setFilterType(t.value)} compact>
                  <Icon className="h-3 w-3" /> {t.label}
                </FilterChip>
              );
            })}
            <FilterChip active={mineOnly} onClick={() => setMineOnly(v => !v)} compact>
              <UserIcon className="h-3 w-3" /> Mine only
            </FilterChip>
            <span className="mx-1 h-4 w-px bg-slate-200 dark:bg-slate-700" />
            <select
              value={sort}
              onChange={e => setSort(e.target.value)}
              className="text-xs px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
            >
              <option value="recent">Most recent</option>
              <option value="top">Top voted</option>
              <option value="oldest">Oldest</option>
            </select>
            <div className="ml-auto relative w-full sm:w-56">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 pointer-events-none" />
              <input
                type="search"
                placeholder="Search…"
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1 text-xs rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 mb-3 p-3 rounded-lg border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 text-sm text-red-700 dark:text-red-300">
            <AlertOctagon className="h-4 w-4 flex-shrink-0 mt-0.5" />
            <div className="flex-1">{error}</div>
            <button onClick={() => setError(null)} className="text-red-700/60 hover:text-red-700 dark:text-red-300/60"><X className="h-3.5 w-3.5" /></button>
          </div>
        )}

        {loading && (
          <div className="space-y-2">
            {[0, 1, 2].map(i => <div key={i} className="h-24 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 animate-pulse" />)}
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="text-center py-16 border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
            <CheckCircle2 className="h-10 w-10 text-slate-300 dark:text-slate-700 mx-auto mb-3" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-300">No feedback matches</p>
            <p className="text-xs text-slate-500 mt-1">Try clearing filters or submit something new.</p>
          </div>
        )}

        <div className="space-y-2">
          {filtered.map(item => (
            <FeedbackRow
              key={item.id}
              item={item}
              voted={votes.has(item.id)}
              onVote={() => toggleVote(item)}
              onOpen={() => setSelectedId(item.id)}
              isAdmin={isAdmin}
              onChangeStatus={(status) => updateItem(item.id, { status })}
            />
          ))}
        </div>
      </div>

      {selected && (
        <DetailPanel
          item={selected}
          isAdmin={isAdmin}
          user={user}
          supabase={supabase}
          onClose={() => setSelectedId(null)}
          onPatch={(patch) => updateItem(selected.id, patch)}
          voted={votes.has(selected.id)}
          onVote={() => toggleVote(selected)}
        />
      )}

      {showForm && (
        <SubmitForm
          user={user}
          supabase={supabase}
          onClose={() => setShowForm(false)}
          onSubmitted={() => { setShowForm(false); refresh(); }}
        />
      )}
    </div>
  );
}

// ─── Sub-components ────────────────────────────────────────────────────────

function Count({ n }) {
  return <span className="ml-1 inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] bg-slate-200/80 dark:bg-slate-700 text-slate-700 dark:text-slate-300 font-semibold">{n}</span>;
}

function FilterChip({ active, onClick, children, compact = false }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 ${compact ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs'} rounded-full font-medium transition-all ${
        active
          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900 shadow-sm'
          : 'bg-slate-100 dark:bg-slate-800/60 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-800'
      }`}
    >
      {children}
    </button>
  );
}

function Avatar({ name }) {
  return (
    <div className="w-6 h-6 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-700 dark:to-slate-800 flex items-center justify-center text-[10px] font-bold text-slate-600 dark:text-slate-300 flex-shrink-0">
      {initials(name)}
    </div>
  );
}

function StatusBadge({ status }) {
  const meta = STATUS_BY_VAL[status] || STATUSES[0];
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wide ${meta.color}`}>{meta.label}</span>;
}

function TypeBadge({ type }) {
  const meta = TYPE_BY_VAL[type];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-semibold border ${meta.color}`}>
      <Icon className="h-3 w-3" /> {meta.label}
    </span>
  );
}

function SeverityBadge({ severity }) {
  const meta = SEV_BY_VAL[severity] || SEV_BY_VAL.medium;
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${meta.color}`}>{meta.label}</span>;
}

function FeedbackRow({ item, voted, onVote, onOpen, isAdmin, onChangeStatus }) {
  const screenshots = Array.isArray(item.screenshots) ? item.screenshots : [];

  return (
    <div className="group flex gap-3 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700 transition-all">
      <button
        onClick={(e) => { e.stopPropagation(); onVote(); }}
        className={`flex flex-col items-center justify-center min-w-[48px] py-1.5 px-2 rounded-lg border transition-all flex-shrink-0 ${
          voted
            ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700'
            : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-blue-400 dark:hover:border-blue-600'
        }`}
        title={voted ? 'Remove vote' : 'Upvote'}
      >
        <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
        <span className="text-xs font-bold">{item.vote_count}</span>
      </button>

      <button onClick={onOpen} className="flex-1 min-w-0 text-left">
        <div className="flex flex-wrap items-center gap-1.5 mb-1.5">
          <TypeBadge type={item.type} />
          <SeverityBadge severity={item.severity} />
          {isAdmin ? (
            <select
              value={item.status}
              onChange={e => onChangeStatus(e.target.value)}
              onClick={e => e.stopPropagation()}
              className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border-0 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-500 ${STATUS_BY_VAL[item.status]?.color || ''}`}
            >
              {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          ) : (
            <StatusBadge status={item.status} />
          )}
          {item.area && (
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
              <Tag className="h-2.5 w-2.5" /> {item.area}
            </span>
          )}
        </div>
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug">
          {item.title}
        </h3>
        {item.description && (
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 line-clamp-2">{item.description}</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-[11px] text-slate-500 dark:text-slate-400">
          <div className="flex items-center gap-1.5">
            <Avatar name={item.created_by_name} />
            <span>{item.created_by_name || 'Unknown'}</span>
          </div>
          <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {timeAgo(item.created_at)}</span>
          {item.comment_count > 0 && (
            <span className="flex items-center gap-1"><MessageSquare className="h-3 w-3" /> {item.comment_count}</span>
          )}
          {screenshots.length > 0 && (
            <span className="flex items-center gap-1"><Paperclip className="h-3 w-3" /> {screenshots.length}</span>
          )}
        </div>
      </button>

      <ChevronRight className="h-4 w-4 text-slate-300 dark:text-slate-700 self-center group-hover:text-slate-500 dark:group-hover:text-slate-400 transition-colors flex-shrink-0" />
    </div>
  );
}

// ─── Detail panel ───────────────────────────────────────────────────────────

function DetailPanel({ item, isAdmin, user, supabase, onClose, onPatch, voted, onVote }) {
  const [comments, setComments] = useState([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [newComment, setNewComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title);
  const [editDesc, setEditDesc] = useState(item.description || '');
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    setEditTitle(item.title);
    setEditDesc(item.description || '');
  }, [item.id]);

  const loadComments = useCallback(async () => {
    setCommentsLoading(true);
    try {
      const { data, error } = await supabase
        .from('feedback_comments')
        .select('id,user_id,user_name,user_email,body,is_internal_note,created_at')
        .eq('feedback_id', item.id)
        .order('created_at', { ascending: true });
      if (error) throw error;
      setComments(data || []);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setCommentsLoading(false);
    }
  }, [supabase, item.id]);

  useEffect(() => { loadComments(); }, [loadComments]);

  useEffect(() => {
    const ch = supabase
      .channel(`feedback_comments:${item.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'feedback_comments', filter: `feedback_id=eq.${item.id}` }, () => loadComments())
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, [supabase, item.id, loadComments]);

  const submitComment = async () => {
    const body = newComment.trim();
    if (!body || !user?.id) return;
    setPosting(true);
    setErr(null);
    try {
      const { error } = await supabase.from('feedback_comments').insert({
        feedback_id: item.id,
        user_id: user.id,
        user_name: userDisplayName(user),
        user_email: user.email,
        body,
      });
      if (error) throw error;
      setNewComment('');
      loadComments();
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setPosting(false);
    }
  };

  const saveEdit = async () => {
    await onPatch({ title: editTitle.trim().slice(0, 120) || item.title, description: editDesc.trim() || null });
    setEditing(false);
  };

  const canEdit = isAdmin || item.created_by === user?.id;
  const screenshots = Array.isArray(item.screenshots) ? item.screenshots : [];

  return (
    <div className="fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" onClick={onClose} />
      <div className="relative ml-auto w-full max-w-2xl h-full bg-white dark:bg-slate-900 shadow-2xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-5 py-3 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2 flex-wrap">
            <TypeBadge type={item.type} />
            <SeverityBadge severity={item.severity} />
            {isAdmin ? (
              <select
                value={item.status}
                onChange={e => onPatch({ status: e.target.value })}
                className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase border-0 cursor-pointer ${STATUS_BY_VAL[item.status]?.color || ''}`}
              >
                {STATUSES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            ) : (
              <StatusBadge status={item.status} />
            )}
          </div>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4 text-slate-500 dark:text-slate-400" />
          </button>
        </div>

        <div className="px-5 py-4">
          {editing ? (
            <input
              type="text"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              maxLength={120}
              className="w-full text-xl font-bold text-slate-900 dark:text-slate-100 bg-transparent border-b-2 border-blue-500 outline-none pb-1 mb-3"
            />
          ) : (
            <h2 className="text-xl font-bold text-slate-900 dark:text-slate-100 mb-1">{item.title}</h2>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400 mb-4">
            <div className="flex items-center gap-1.5">
              <Avatar name={item.created_by_name} />
              <span>{item.created_by_name || 'Unknown'}</span>
            </div>
            <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> {timeAgo(item.created_at)}</span>
            {item.area && <span className="flex items-center gap-1"><Tag className="h-3 w-3" /> {item.area}</span>}
            <button
              onClick={onVote}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-md border transition-colors ${
                voted
                  ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-700'
                  : 'border-slate-200 dark:border-slate-700 hover:border-blue-400'
              }`}
            >
              <ArrowUp className="h-3 w-3" strokeWidth={2.5} /> {item.vote_count}
            </button>
          </div>

          <div className="mb-5">
            {editing ? (
              <textarea
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                maxLength={2000}
                rows={6}
                className="w-full px-3 py-2 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-slate-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            ) : item.description ? (
              <div className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed">{item.description}</div>
            ) : (
              <p className="text-xs text-slate-400 italic">No description provided.</p>
            )}
            {canEdit && (
              <div className="flex justify-end gap-2 mt-2">
                {editing ? (
                  <>
                    <button onClick={() => { setEditing(false); setEditTitle(item.title); setEditDesc(item.description || ''); }} className="text-xs px-2.5 py-1 rounded text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">Cancel</button>
                    <button onClick={saveEdit} className="text-xs px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium">Save</button>
                  </>
                ) : (
                  <button onClick={() => setEditing(true)} className="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">Edit</button>
                )}
              </div>
            )}
          </div>

          {screenshots.length > 0 && (
            <div className="mb-5">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                <Paperclip className="h-3 w-3" /> Attachments ({screenshots.length})
              </h3>
              <AttachmentsGrid paths={screenshots} supabase={supabase} onOpen={(url) => setLightbox(url)} />
            </div>
          )}

          {isAdmin && (
            <div className="mb-5 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/50">
              <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2">Admin links</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <LabeledInput
                  label="Related PR URL"
                  value={item.related_pr_url || ''}
                  onSave={(v) => onPatch({ related_pr_url: v.trim() || null })}
                  placeholder="https://github.com/.../pull/123"
                />
                <LabeledInput
                  label="Commit SHA"
                  value={item.related_commit_sha || ''}
                  onSave={(v) => onPatch({ related_commit_sha: v.trim() || null })}
                  placeholder="abc1234"
                />
              </div>
            </div>
          )}

          <div className="mb-5">
            <h3 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
              <MessageSquare className="h-3 w-3" /> Discussion ({comments.length})
            </h3>
            {commentsLoading ? (
              <div className="text-xs text-slate-400">Loading…</div>
            ) : comments.length === 0 ? (
              <p className="text-xs text-slate-400 italic">No comments yet. Start the discussion below.</p>
            ) : (
              <div className="space-y-3">
                {comments.map(c => (
                  <div key={c.id} className="flex gap-2.5">
                    <Avatar name={c.user_name} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 text-[11px]">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">{c.user_name || 'Unknown'}</span>
                        <span className="text-slate-400">{timeAgo(c.created_at)}</span>
                      </div>
                      <div className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap mt-0.5">{c.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {user?.id && (
              <div className="mt-3 flex gap-2">
                <Avatar name={userDisplayName(user)} />
                <div className="flex-1 flex gap-2">
                  <textarea
                    value={newComment}
                    onChange={e => setNewComment(e.target.value)}
                    onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitComment(); } }}
                    placeholder="Add a comment… (Cmd/Ctrl+Enter to post)"
                    rows={2}
                    className="flex-1 px-3 py-2 text-sm rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                  <button
                    onClick={submitComment}
                    disabled={!newComment.trim() || posting}
                    className="self-end px-3 py-2 rounded-md bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {posting ? '…' : <Send className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
            )}
          </div>

          {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">{err}</div>}
        </div>
      </div>

      {lightbox && (
        <div className="absolute inset-0 z-50 bg-black/80 flex items-center justify-center p-6" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="" className="max-w-full max-h-full rounded-lg shadow-2xl" />
          <button className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white"><X className="h-5 w-5" /></button>
        </div>
      )}
    </div>
  );
}

function LabeledInput({ label, value, onSave, placeholder }) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  const dirty = v !== value;
  return (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-0.5">{label}</label>
      <div className="flex gap-1">
        <input
          type="text"
          value={v}
          onChange={e => setV(e.target.value)}
          placeholder={placeholder}
          className="flex-1 min-w-0 px-2 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200"
        />
        {dirty && (
          <button onClick={() => onSave(v)} className="px-2 py-1 text-[10px] rounded bg-blue-600 text-white hover:bg-blue-700 font-medium">Save</button>
        )}
      </div>
    </div>
  );
}

// ─── Attachments rendering (private bucket → signed URLs) ──────────────────

function AttachmentsGrid({ paths, supabase, onOpen }) {
  const [urls, setUrls] = useState({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      await Promise.all(paths.map(async p => {
        try {
          const { data } = await supabase.storage.from(BUCKET).createSignedUrl(p, 60 * 60);
          if (data?.signedUrl) next[p] = data.signedUrl;
        } catch { /* ignore */ }
      }));
      if (!cancelled) setUrls(next);
    })();
    return () => { cancelled = true; };
  }, [paths, supabase]);

  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
      {paths.map(p => (
        <button
          key={p}
          onClick={() => urls[p] && onOpen(urls[p])}
          className="aspect-square rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 hover:ring-2 hover:ring-blue-500 transition-all"
        >
          {urls[p] ? (
            <img src={urls[p]} alt="" className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <ImageIcon className="h-5 w-5 text-slate-400" />
            </div>
          )}
        </button>
      ))}
    </div>
  );
}

// ─── Submit form (with screenshot upload) ──────────────────────────────────

function SubmitForm({ user, supabase, onClose, onSubmitted }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('bug');
  const [severity, setSeverity] = useState('medium');
  const [area, setArea] = useState('');
  const [shots, setShots] = useState([]); // [{ path, url, name, uploading?, error? }]
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);
  const formRef = useRef(null);

  const uploadOne = async (file) => {
    if (!file.type?.startsWith('image/')) return null;
    if (file.size > MAX_IMAGE_BYTES) {
      setErr(`"${file.name}" exceeds 5 MB.`);
      return null;
    }
    const safeName = (file.name || `paste_${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = `${user.id}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${safeName}`;
    const placeholder = { path, name: safeName, uploading: true };
    setShots(prev => [...prev, placeholder]);
    try {
      const { error: e1 } = await supabase.storage
        .from(BUCKET)
        .upload(path, file, { contentType: file.type, upsert: false });
      if (e1) throw e1;
      const { data, error: e2 } = await supabase.storage.from(BUCKET).createSignedUrl(path, 60 * 60);
      if (e2) throw e2;
      const url = data?.signedUrl;
      setShots(prev => prev.map(s => s.path === path ? { path, name: safeName, url } : s));
      return path;
    } catch (e) {
      setShots(prev => prev.filter(s => s.path !== path));
      setErr(`Upload failed: ${e?.message || e}`);
      return null;
    }
  };

  const addFiles = useCallback(async (files) => {
    const list = Array.from(files || []).filter(f => f.type.startsWith('image/'));
    if (!list.length) return;
    const room = MAX_IMAGES - shots.length;
    if (room <= 0) {
      setErr(`Up to ${MAX_IMAGES} images.`);
      return;
    }
    setErr(null);
    for (const f of list.slice(0, room)) {
      await uploadOne(f);
    }
  }, [shots.length, user?.id]);

  const removeShot = async (path) => {
    setShots(prev => prev.filter(s => s.path !== path));
    try { await supabase.storage.from(BUCKET).remove([path]); } catch { /* ignore */ }
  };

  // Paste anywhere in the form pastes screenshots from clipboard.
  useEffect(() => {
    const onPaste = (e) => {
      const files = Array.from(e.clipboardData?.files || []);
      const imgs = files.filter(f => f.type.startsWith('image/'));
      if (imgs.length === 0) return;
      e.preventDefault();
      addFiles(imgs);
    };
    const el = formRef.current;
    if (!el) return;
    el.addEventListener('paste', onPaste);
    return () => el.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setErr('Title is required'); return; }
    if (!user?.id) { setErr('You must be signed in'); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const finalShotPaths = shots.filter(s => !s.uploading).map(s => s.path);
      const { error } = await supabase.from('feedback_items').insert({
        title: title.trim().slice(0, 120),
        description: description.trim() || null,
        type,
        severity,
        area: area.trim() || null,
        screenshots: finalShotPaths,
        page_url: window.location.href,
        user_agent: navigator.userAgent,
        created_by: user.id,
        created_by_name: userDisplayName(user),
        created_by_email: user.email,
      });
      if (error) throw error;
      onSubmitted();
    } catch (e2) {
      setErr(e2?.message || String(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] flex items-center justify-center p-4" onClick={onClose}>
      <form
        ref={formRef}
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl max-w-lg w-full max-h-[92vh] overflow-y-auto"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
          <h2 className="text-lg font-bold text-slate-900 dark:text-slate-100">Submit feedback</h2>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <div className="grid grid-cols-3 gap-2">
            {TYPES.map(t => {
              const Icon = t.icon;
              const active = type === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setType(t.value)}
                  className={`flex flex-col items-center gap-1 px-2 py-2.5 rounded-lg border-2 transition-all ${
                    active ? `${t.color} ring-2 ring-offset-1 ring-current/30` : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-300'
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-[11px] font-semibold">{t.label}</span>
                </button>
              );
            })}
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Title *</label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              maxLength={120}
              placeholder="Short summary of the issue or idea"
              className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="text-[10px] text-slate-400 mt-1 text-right">{title.length} / 120</div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Severity</label>
              <select value={severity} onChange={e => setSeverity(e.target.value)} className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100">
                {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Area (optional)</label>
              <input
                type="text"
                value={area}
                onChange={e => setArea(e.target.value)}
                placeholder="tonomo, pricing, calendar…"
                list="feedback-area-suggestions"
                className="w-full px-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100"
              />
              <datalist id="feedback-area-suggestions">
                <option value="tonomo" />
                <option value="pricing" />
                <option value="calendar" />
                <option value="projects" />
                <option value="media" />
                <option value="tasks" />
                <option value="email" />
                <option value="dashboard" />
                <option value="settings" />
                <option value="mobile" />
                <option value="other" />
              </datalist>
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              maxLength={2000}
              rows={5}
              placeholder="What happened, what did you expect, steps to reproduce…"
              className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="text-[10px] text-slate-400 mt-1 text-right">{description.length} / 2000</div>
          </div>

          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">
              Screenshots (max {MAX_IMAGES}, 5 MB each)
            </label>
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              className={`relative border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-950/30'
                  : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 bg-slate-50 dark:bg-slate-800/40'
              }`}
            >
              <ImageIcon className="h-6 w-6 text-slate-400 mx-auto mb-1.5" />
              <p className="text-xs text-slate-600 dark:text-slate-400">
                <span className="font-semibold text-blue-600 dark:text-blue-400">Click</span>, drag &amp; drop, or paste images here
              </p>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={e => { addFiles(e.target.files); e.target.value = ''; }}
              />
            </div>
            {shots.length > 0 && (
              <div className="grid grid-cols-3 gap-2 mt-2">
                {shots.map(s => (
                  <div key={s.path} className="relative aspect-square rounded-lg overflow-hidden border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 group">
                    {s.url ? (
                      <img src={s.url} alt={s.name} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <div className="h-4 w-4 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => removeShot(s.path)}
                      className="absolute top-1 right-1 p-1 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {err && <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5"><AlertOctagon className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" /><div>{err}</div></div>}
        </div>

        <div className="sticky bottom-0 flex justify-end gap-2 px-6 py-3 bg-white dark:bg-slate-900 border-t border-slate-200 dark:border-slate-800">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
          <button
            type="submit"
            disabled={submitting || !title.trim() || shots.some(s => s.uploading)}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting…' : 'Submit feedback'}
          </button>
        </div>
      </form>
    </div>
  );
}

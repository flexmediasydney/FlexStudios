import React, { useEffect, useMemo, useState } from 'react';
import { api } from '@/api/supabaseClient';
import { useAuth } from '@/lib/AuthContext';

const TYPES = [
  { value: 'bug', label: 'Bug' },
  { value: 'improvement', label: 'Improvement' },
  { value: 'feature_request', label: 'Feature' },
];
const SEVERITIES = [
  { value: 'critical', label: 'Critical' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
];
const STATUSES = [
  'new', 'triaging', 'accepted', 'in_progress', 'shipped', 'declined', 'duplicate',
];
const TYPE_BADGE = {
  bug: 'bg-red-100 text-red-800',
  improvement: 'bg-amber-100 text-amber-800',
  feature_request: 'bg-blue-100 text-blue-800',
};
const SEV_BADGE = {
  critical: 'bg-red-600 text-white',
  high: 'bg-orange-500 text-white',
  medium: 'bg-slate-200 text-slate-700',
  low: 'bg-slate-100 text-slate-500',
};
const STATUS_BADGE = {
  new: 'bg-slate-100 text-slate-700',
  triaging: 'bg-yellow-100 text-yellow-800',
  accepted: 'bg-blue-100 text-blue-800',
  in_progress: 'bg-indigo-100 text-indigo-800',
  shipped: 'bg-green-100 text-green-800',
  declined: 'bg-slate-200 text-slate-500',
  duplicate: 'bg-slate-200 text-slate-500',
};

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export default function Feedback() {
  const { user } = useAuth();
  const isAdmin = ['master_admin', 'admin', 'manager'].includes(user?.role);

  const [items, setItems] = useState([]);
  const [votes, setVotes] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [filterStatus, setFilterStatus] = useState('open');
  const [filterType, setFilterType] = useState('all');
  const [search, setSearch] = useState('');

  const [showForm, setShowForm] = useState(false);

  const supabase = api._supabase;

  const refresh = async () => {
    setError(null);
    try {
      const { data, error: e1 } = await supabase
        .from('feedback_items')
        .select('id,title,description,type,severity,status,area,vote_count,comment_count,created_by,created_by_name,created_at')
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
  };

  useEffect(() => {
    refresh();
  }, [user?.id]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter(it => {
      if (filterStatus === 'open' && (it.status === 'shipped' || it.status === 'declined' || it.status === 'duplicate')) return false;
      if (filterStatus !== 'open' && filterStatus !== 'all' && it.status !== filterStatus) return false;
      if (filterType !== 'all' && it.type !== filterType) return false;
      if (q && !(it.title?.toLowerCase().includes(q) || it.description?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [items, filterStatus, filterType, search]);

  const toggleVote = async (item) => {
    if (!user?.id) return;
    const has = votes.has(item.id);
    const optimistic = new Set(votes);
    if (has) optimistic.delete(item.id); else optimistic.add(item.id);
    setVotes(optimistic);
    setItems(prev => prev.map(p => p.id === item.id ? { ...p, vote_count: p.vote_count + (has ? -1 : 1) } : p));
    try {
      if (has) {
        const { error: e } = await supabase
          .from('feedback_votes')
          .delete()
          .eq('feedback_id', item.id)
          .eq('user_id', user.id);
        if (e) throw e;
      } else {
        const { error: e } = await supabase
          .from('feedback_votes')
          .insert({ feedback_id: item.id, user_id: user.id });
        if (e) throw e;
      }
    } catch (err) {
      // revert
      setVotes(votes);
      setItems(prev => prev.map(p => p.id === item.id ? { ...p, vote_count: p.vote_count + (has ? 1 : -1) } : p));
      alert('Vote failed: ' + (err?.message || err));
    }
  };

  const updateStatus = async (item, newStatus) => {
    if (!isAdmin) return;
    const prevStatus = item.status;
    setItems(prev => prev.map(p => p.id === item.id ? { ...p, status: newStatus } : p));
    try {
      const { error: e } = await supabase
        .from('feedback_items')
        .update({ status: newStatus })
        .eq('id', item.id);
      if (e) throw e;
    } catch (err) {
      setItems(prev => prev.map(p => p.id === item.id ? { ...p, status: prevStatus } : p));
      alert('Update failed: ' + (err?.message || err));
    }
  };

  const counts = useMemo(() => {
    const c = { open: 0, all: items.length };
    for (const s of STATUSES) c[s] = 0;
    for (const it of items) {
      c[it.status] = (c[it.status] || 0) + 1;
      if (it.status !== 'shipped' && it.status !== 'declined' && it.status !== 'duplicate') c.open++;
    }
    return c;
  }, [items]);

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between mb-6 gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 dark:text-slate-100">Feedback</h1>
          <p className="text-sm text-slate-500 mt-1">Bugs, improvements, and feature requests for FlexStudios.</p>
        </div>
        <button
          onClick={() => setShowForm(true)}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          + Submit feedback
        </button>
      </div>

      <div className="flex flex-wrap gap-2 mb-4 items-center">
        <FilterChip active={filterStatus === 'open'} onClick={() => setFilterStatus('open')}>Open ({counts.open})</FilterChip>
        <FilterChip active={filterStatus === 'all'} onClick={() => setFilterStatus('all')}>All ({counts.all})</FilterChip>
        {STATUSES.map(s => (
          <FilterChip key={s} active={filterStatus === s} onClick={() => setFilterStatus(s)}>
            {s.replace('_', ' ')} ({counts[s] || 0})
          </FilterChip>
        ))}
        <span className="mx-2 text-slate-300">|</span>
        <FilterChip active={filterType === 'all'} onClick={() => setFilterType('all')}>All types</FilterChip>
        {TYPES.map(t => (
          <FilterChip key={t.value} active={filterType === t.value} onClick={() => setFilterType(t.value)}>{t.label}</FilterChip>
        ))}
        <input
          type="search"
          placeholder="Search…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="ml-auto px-3 py-1.5 text-sm rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 w-48"
        />
      </div>

      {loading && <div className="text-sm text-slate-500 py-8 text-center">Loading…</div>}
      {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg p-3 mb-4">Error: {error}</div>}

      {!loading && filtered.length === 0 && (
        <div className="text-sm text-slate-500 py-12 text-center border border-dashed border-slate-300 dark:border-slate-700 rounded-lg">
          No feedback yet matches these filters.
        </div>
      )}

      <div className="space-y-2">
        {filtered.map(item => (
          <div key={item.id} className="border border-slate-200 dark:border-slate-700 rounded-lg p-4 bg-white dark:bg-slate-900 hover:shadow-sm transition-shadow">
            <div className="flex items-start gap-3">
              <button
                onClick={() => toggleVote(item)}
                className={`flex flex-col items-center justify-center min-w-[48px] px-2 py-1.5 rounded-md border text-xs font-semibold transition-colors ${
                  votes.has(item.id)
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-400'
                }`}
                title={votes.has(item.id) ? 'Remove vote' : 'Upvote'}
              >
                <span>▲</span>
                <span>{item.vote_count}</span>
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${TYPE_BADGE[item.type] || 'bg-slate-100 text-slate-700'}`}>
                    {TYPES.find(t => t.value === item.type)?.label || item.type}
                  </span>
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${SEV_BADGE[item.severity] || 'bg-slate-100'}`}>
                    {item.severity}
                  </span>
                  {isAdmin ? (
                    <select
                      value={item.status}
                      onChange={e => updateStatus(item, e.target.value)}
                      className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase border-0 cursor-pointer ${STATUS_BADGE[item.status]}`}
                    >
                      {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
                    </select>
                  ) : (
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${STATUS_BADGE[item.status] || 'bg-slate-100'}`}>
                      {item.status.replace('_', ' ')}
                    </span>
                  )}
                  {item.area && <span className="text-[10px] text-slate-500">#{item.area}</span>}
                </div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{item.title}</h3>
                {item.description && (
                  <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 whitespace-pre-wrap line-clamp-3">{item.description}</p>
                )}
                <div className="flex items-center gap-3 mt-2 text-[11px] text-slate-500">
                  <span>{item.created_by_name || 'Unknown'}</span>
                  <span>·</span>
                  <span>{fmtDate(item.created_at)}</span>
                  {item.comment_count > 0 && <><span>·</span><span>{item.comment_count} comment{item.comment_count === 1 ? '' : 's'}</span></>}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {showForm && (
        <SubmitForm
          onClose={() => setShowForm(false)}
          onSubmitted={() => { setShowForm(false); refresh(); }}
          user={user}
        />
      )}
    </div>
  );
}

function FilterChip({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
        active
          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
          : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
      }`}
    >
      {children}
    </button>
  );
}

function SubmitForm({ onClose, onSubmitted, user }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState('bug');
  const [severity, setSeverity] = useState('medium');
  const [area, setArea] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) { setErr('Title is required'); return; }
    if (!user?.id) { setErr('You must be signed in'); return; }
    setSubmitting(true);
    setErr(null);
    try {
      const { error } = await api._supabase
        .from('feedback_items')
        .insert({
          title: title.trim().slice(0, 120),
          description: description.trim() || null,
          type,
          severity,
          area: area.trim() || null,
          page_url: window.location.href,
          user_agent: navigator.userAgent,
          created_by: user.id,
          created_by_name: user.name || user.full_name || user.email,
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
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <form
        onClick={e => e.stopPropagation()}
        onSubmit={submit}
        className="bg-white dark:bg-slate-900 rounded-xl shadow-xl max-w-lg w-full p-6 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100 mb-4">Submit feedback</h2>

        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Title *</label>
        <input
          type="text"
          value={title}
          onChange={e => setTitle(e.target.value)}
          maxLength={120}
          placeholder="Short summary"
          className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
          autoFocus
        />

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Type</label>
            <select value={type} onChange={e => setType(e.target.value)} className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
              {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Severity</label>
            <select value={severity} onChange={e => setSeverity(e.target.value)} className="w-full px-3 py-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm">
              {SEVERITIES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Area (optional)</label>
        <input
          type="text"
          value={area}
          onChange={e => setArea(e.target.value)}
          placeholder="e.g. tonomo, pricing, calendar"
          className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm"
        />

        <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">Description</label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          maxLength={2000}
          rows={5}
          placeholder="What happened, what did you expect, steps to reproduce…"
          className="w-full px-3 py-2 mb-3 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-sm font-mono"
        />

        {err && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2 mb-3">{err}</div>}

        <div className="flex justify-end gap-2 mt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-md text-sm text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">Cancel</button>
          <button type="submit" disabled={submitting} className="px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60">
            {submitting ? 'Submitting…' : 'Submit'}
          </button>
        </div>
      </form>
    </div>
  );
}

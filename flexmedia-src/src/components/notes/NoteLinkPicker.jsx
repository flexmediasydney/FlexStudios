import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Mail, ListChecks, GitPullRequest, Link2, X, Search } from 'lucide-react';

// Tailwind chip styling per link kind. Kept in sync with ProjectActivityFeedItem
// so the picker preview matches the feed render once saved.
export const LINK_KIND_STYLES = {
  email:           { chipBg: 'bg-green-50 text-green-700 border-green-200 dark:bg-green-950/40 dark:text-green-300 dark:border-green-800',  icon: Mail },
  task:            { chipBg: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/40 dark:text-orange-300 dark:border-orange-800', icon: ListChecks },
  revision:        { chipBg: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-800', icon: GitPullRequest },
  change_request:  { chipBg: 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800', icon: GitPullRequest },
};

function emailLabel(e) {
  return (e.subject?.trim() || e.from_name || e.from || 'Untitled email').slice(0, 80);
}
function taskLabel(t) {
  return (t.title?.trim() || 'Untitled task').slice(0, 80);
}
function revisionLabel(r) {
  const num = r.revision_number != null ? `#${r.revision_number} ` : '';
  return `${num}${(r.title || r.description || 'Request').slice(0, 80)}`;
}

export default function NoteLinkPicker({ projectId, value, onChange, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('emails');
  const [query, setQuery] = useState('');

  // Lazily fetch only when the picker opens — keeps composer mount cheap.
  const enabled = open && !!projectId;

  const { data: emails = [] } = useQuery({
    queryKey: ['note-link-picker-emails', projectId],
    queryFn: () => api.entities.EmailMessage.filter({ project_id: projectId, is_deleted: false }, '-received_at', 100),
    enabled,
    staleTime: 30 * 1000,
  });

  const { data: tasks = [] } = useQuery({
    queryKey: ['note-link-picker-tasks', projectId],
    queryFn: () => api.entities.ProjectTask.filter({ project_id: projectId, is_deleted: false }, '-created_at', 200),
    enabled,
    staleTime: 30 * 1000,
  });

  const { data: revisions = [] } = useQuery({
    queryKey: ['note-link-picker-revisions', projectId],
    queryFn: () => api.entities.ProjectRevision.filter({ project_id: projectId }, '-created_at', 100),
    enabled,
    staleTime: 30 * 1000,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (text) => !q || (text || '').toLowerCase().includes(q);
    return {
      emails:    emails.filter(e => match(emailLabel(e)) || match(e.from) || match(e.from_name)),
      tasks:     tasks.filter(t => match(t.title) || match(t.description)),
      revisions: revisions.filter(r => match(r.title) || match(r.description) || match(revisionLabel(r))),
    };
  }, [emails, tasks, revisions, query]);

  const pick = (next) => {
    onChange?.(next);
    setOpen(false);
    setQuery('');
  };

  const TabButton = ({ id, label, count, Icon }) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-md font-medium transition-colors ${
        tab === id
          ? 'bg-primary text-primary-foreground'
          : 'bg-muted text-muted-foreground hover:bg-muted/80'
      }`}
    >
      <Icon className="h-3 w-3" />
      {label}
      {count > 0 && (
        <span className={`text-[9px] leading-none px-1 py-0.5 rounded-full ${
          tab === id ? 'bg-card/25 text-white' : 'bg-muted-foreground/15'
        }`}>{count}</span>
      )}
    </button>
  );

  // Trigger appearance: shows current link state, or a "Link" call-to-action.
  let triggerInner;
  if (value?.kind) {
    const style = LINK_KIND_STYLES[value.kind] || LINK_KIND_STYLES.email;
    const Icon = style.icon;
    triggerInner = (
      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${style.chipBg}`}>
        <Icon className="h-3 w-3" />
        <span className="max-w-[160px] truncate" title={value.label}>{value.label || value.kind}</span>
      </span>
    );
  } else {
    triggerInner = (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
        <Link2 className="h-3.5 w-3.5" />
        Link to…
      </span>
    );
  }

  return (
    <div className="inline-flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            className="p-1 rounded hover:bg-black/5 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {triggerInner}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-0">
          <div className="p-2 border-b">
            <div className="flex items-center gap-1.5 mb-2">
              <TabButton id="emails"    label="Emails"   count={emails.length}    Icon={Mail} />
              <TabButton id="tasks"     label="Tasks"    count={tasks.length}     Icon={ListChecks} />
              <TabButton id="revisions" label="Requests" count={revisions.length} Icon={GitPullRequest} />
            </div>
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={`Search ${tab}…`}
                className="h-7 text-xs pl-7"
                autoFocus
              />
            </div>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {tab === 'emails' && (
              filtered.emails.length === 0
                ? <EmptyRow text="No emails on this project" />
                : filtered.emails.map(e => (
                    <PickerRow
                      key={e.id}
                      title={emailLabel(e)}
                      subtitle={e.from_name || e.from}
                      onClick={() => pick({ kind: 'email', id: e.id, label: emailLabel(e) })}
                    />
                  ))
            )}
            {tab === 'tasks' && (
              filtered.tasks.length === 0
                ? <EmptyRow text="No tasks on this project" />
                : filtered.tasks.map(t => (
                    <PickerRow
                      key={t.id}
                      title={taskLabel(t)}
                      subtitle={t.is_completed ? 'Completed' : (t.assigned_to_name || 'Unassigned')}
                      onClick={() => pick({ kind: 'task', id: t.id, label: taskLabel(t) })}
                    />
                  ))
            )}
            {tab === 'revisions' && (
              filtered.revisions.length === 0
                ? <EmptyRow text="No requests on this project" />
                : filtered.revisions.map(r => {
                    const kind = r.request_kind === 'change_request' ? 'change_request' : 'revision';
                    return (
                      <PickerRow
                        key={r.id}
                        title={revisionLabel(r)}
                        subtitle={kind === 'change_request' ? 'Change request' : 'Revision'}
                        kind={kind}
                        onClick={() => pick({ kind, id: r.id, label: revisionLabel(r) })}
                      />
                    );
                  })
            )}
          </div>

          {value?.kind && (
            <button
              type="button"
              onClick={() => pick(null)}
              className="w-full text-xs px-3 py-2 border-t text-muted-foreground hover:bg-muted/60 flex items-center gap-1.5 justify-center"
            >
              <X className="h-3 w-3" />
              Remove link
            </button>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
}

function PickerRow({ title, subtitle, onClick, kind }) {
  const style = kind ? LINK_KIND_STYLES[kind] : null;
  const Icon = style?.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left px-3 py-1.5 hover:bg-muted/60 transition-colors block border-b last:border-b-0 border-border/50"
    >
      <div className="flex items-center gap-2">
        {Icon && <Icon className="h-3 w-3 text-muted-foreground shrink-0" />}
        <p className="text-xs font-medium truncate">{title}</p>
      </div>
      {subtitle && <p className="text-[10px] text-muted-foreground truncate">{subtitle}</p>}
    </button>
  );
}

function EmptyRow({ text }) {
  return (
    <div className="px-3 py-6 text-center text-xs text-muted-foreground">{text}</div>
  );
}

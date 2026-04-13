import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { useNavigate } from 'react-router-dom';
import { useSmartEntityData } from '@/components/hooks/useSmartEntityData';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import SharedDashboard from '@/components/analytics/SharedDashboard';
import { createPageUrl } from '@/utils';
import { fmtDate, fmtTimestampCustom, fixTimestamp } from '@/components/utils/dateUtils';
import {
  ArrowLeft, ChevronDown, ChevronRight, Mail, Phone, Building2, Calendar,
  DollarSign, MessageSquare, FileText, Activity, Info, AlertCircle, Plus, Trash2, User, Copy, Check,
  Bell, AlertTriangle, Clock, Tag, X, Hash, Star, Users, Paperclip, Pencil
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import UnifiedNotesPanel from '@/components/notes/UnifiedNotesPanel';
import PriceMatrixSummaryTable from '@/components/priceMatrix/PriceMatrixSummaryTable';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import EntityEmailTab from '@/components/email/EntityEmailTab';
import EntityActivitiesTab from '@/components/calendar/EntityActivitiesTab';
import ContactActivityLog from '@/components/contacts/ContactActivityLog';
import ContactFiles from '@/components/contacts/ContactFiles';
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import { usePriceGate } from '@/components/auth/RoleGate';
import { toast } from 'sonner';

const STATE_BADGE = {
  Active: 'bg-green-100 text-green-800 border-green-200',
  Prospecting: 'bg-blue-100 text-blue-800 border-blue-200',
  Dormant: 'bg-amber-100 text-amber-800 border-amber-200',
  'Do Not Contact': 'bg-red-100 text-red-800 border-red-200',
};

const INTEGRITY_LABELS = {
  missing_organisation: 'No organisation linked',
  missing_email: 'Email address missing',
  missing_phone: 'Phone number missing',
};

function computeIntegrityIssues(agent) {
  const issues = [];
  if (!agent.current_agency_id) issues.push('missing_organisation');
  if (!agent.email?.trim()) issues.push('missing_email');
  if (!agent.phone?.trim()) issues.push('missing_phone');
  return issues;
}

const RELATIONSHIP_STATES = ['Active', 'Prospecting', 'Dormant', 'Do Not Contact'];
const VALUE_OPTIONS = ['Low', 'Medium', 'High', 'Enterprise'];
const PROSPECT_STATUSES = ['New Lead', 'Researching', 'Attempted Contact', 'Discovery Call Scheduled', 'Proposal Sent', 'Nurturing', 'Qualified', 'Unqualified', 'Converted to Client', 'Lost'];
const SOURCES = ['Referral', 'LinkedIn', 'Web Search', 'Event', 'Manual Import', 'Networking'];

// ── Inline editable field (Pipedrive side-by-side layout) ──────────────────────
const INTEGRITY_FIELDS = {
  current_agency_id: 'Missing org',
  email: 'Missing email',
  phone: 'Missing phone',
};

// ── SelectCombobox: searchable popover used for type="select" fields ──────────
function SelectCombobox({ value, options, onSave, field, placeholder, prefixIcon: PrefixIcon, onCancel }) {
  const [open, setOpen] = useState(true);
  const [search, setSearch] = useState('');

  const normalise = (o) => typeof o === 'string' ? { value: o, label: o } : o;
  const normOptions = options.map(normalise);

  const filtered = search.trim()
    ? normOptions.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : normOptions;

  const displayValue = normOptions.find(o => o.value === value)?.label ?? value;

  const commit = (val) => {
    setOpen(false);
    if (val !== (value || '')) onSave(field, val);
  };

  // When popover closes without a selection, call onCancel so parent resets editing state
  const handleOpenChange = (next) => {
    setOpen(next);
    if (!next) onCancel();
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {/* Invisible trigger — popover is opened programmatically via open=true */}
        <button
          className={cn(
            "flex items-center gap-1.5 text-sm px-2 py-0.5 rounded-md border border-primary/40 bg-background",
            "focus:outline-none focus:ring-2 focus:ring-primary/25 w-full text-left",
            "transition-colors"
          )}
          aria-haspopup="listbox"
        >
          {PrefixIcon && <PrefixIcon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
          <span className={cn("flex-1 truncate", displayValue ? "text-foreground" : "text-muted-foreground/50")}>
            {displayValue || placeholder || 'Select…'}
          </span>
          <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={4}
        className="w-[220px] p-0 shadow-lg"
        onKeyDown={e => { if (e.key === 'Escape') { setOpen(false); onCancel(); } }}
      >
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty className="py-3 text-center text-xs text-muted-foreground">
              No results
            </CommandEmpty>
            <CommandGroup>
              {filtered.map(o => (
                <CommandItem
                  key={o.value}
                  value={o.value}
                  onSelect={() => commit(o.value)}
                  className={cn(
                    "cursor-pointer text-sm gap-2",
                    o.value === value && "bg-accent font-medium"
                  )}
                >
                  {o.value === value && (
                    <Check className="h-3.5 w-3.5 text-primary shrink-0" />
                  )}
                  <span className={o.value === value ? 'ml-0' : 'ml-5'}>{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── InlineField: unified inline-edit row (Pipedrive side-by-side layout) ──────
function InlineField({ label, value, field, onSave, type = 'text', options, placeholder, icon: Icon, readOnly, actionHref, actionIcon: ActionIcon, actionLabel }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value || ''); }, [value]);

  // Auto-focus text/textarea inputs when entering edit mode
  useEffect(() => {
    if (editing && type !== 'select' && inputRef.current) inputRef.current.focus();
  }, [editing, type]);

  const cancel = () => {
    setDraft(value || '');
    setEditing(false);
  };

  const save = () => {
    setEditing(false);
    if (draft !== (value || '')) onSave(field, draft);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') save();
    if (e.key === 'Escape') cancel();
  };

  // Resolve human-readable display value for select fields
  const displayValue = type === 'select' && options
    ? (options.find(o => (o.value ?? o) === value)?.label ?? value)
    : value;

  // Prefix icon for specific select fields
  const selectPrefixIcon =
    field === 'current_agency_id' ? Building2 :
    field === 'team_id' ? Users :
    undefined;

  // ── Editing state ──────────────────────────────────────────────────────────
  const editingNode = (() => {
    if (type === 'select') {
      return (
        <SelectCombobox
          value={value}
          options={options}
          field={field}
          onSave={onSave}
          placeholder={placeholder}
          prefixIcon={selectPrefixIcon}
          onCancel={cancel}
        />
      );
    }
    if (type === 'textarea') {
      return (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
          rows={3}
          className={cn(
            "w-full text-sm rounded-md border border-input bg-background px-2 py-1",
            "resize-none outline-none transition-shadow",
            "focus:ring-2 focus:ring-primary/25 focus:border-primary"
          )}
        />
      );
    }
    // text / date / number / email / tel
    return (
      <input
        ref={inputRef}
        type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn(
          "w-full text-sm rounded-md border border-input bg-background px-2 py-0.5",
          "outline-none transition-all duration-150",
          "focus:ring-2 focus:ring-primary/25 focus:border-primary"
        )}
      />
    );
  })();

  // ── Display state ──────────────────────────────────────────────────────────
  const emptyNode = INTEGRITY_FIELDS[field]
    ? (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
        {INTEGRITY_FIELDS[field]}
      </span>
    ) : (
      <span className="text-muted-foreground/40 italic text-xs">
        {readOnly ? '—' : (placeholder ? `Click to add ${label.toLowerCase()}…` : '—')}
      </span>
    );

  const DisplayPrefixIcon = selectPrefixIcon;

  const displayNode = (
    <>
      {/* Optional prefix icon for select fields in display mode */}
      {displayValue && DisplayPrefixIcon && (
        <DisplayPrefixIcon className="h-3.5 w-3.5 text-muted-foreground/60 shrink-0 mt-px" />
      )}
      <span className={cn(
        "text-sm flex-1 min-w-0 truncate leading-relaxed",
        displayValue ? "text-foreground" : ""
      )}>
        {displayValue || emptyNode}
      </span>
      {/* Action link (e.g. mailto, tel) */}
      {actionHref && ActionIcon && displayValue && (
        <a
          href={actionHref}
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-primary/10 shrink-0"
          title={actionLabel || label}
          onClick={e => e.stopPropagation()}
        >
          <ActionIcon className="h-3 w-3 text-primary" />
        </a>
      )}
      {/* Pencil affordance */}
      {!readOnly && (
        <span className="opacity-0 group-hover:opacity-60 transition-opacity shrink-0 mt-px">
          <Pencil className="h-3 w-3 text-muted-foreground" />
        </span>
      )}
    </>
  );

  return (
    <div
      className={cn(
        "group flex items-start gap-2 py-1 px-3 rounded-md transition-colors",
        !readOnly && !editing && "cursor-pointer hover:bg-muted/40",
        editing && "bg-muted/20"
      )}
      onClick={!readOnly && !editing ? () => setEditing(true) : undefined}
    >
      <label className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 select-none uppercase tracking-wide leading-relaxed">
        {label}
      </label>
      <div className="flex-1 min-w-0 flex items-start gap-1">
        {editing ? editingNode : displayNode}
      </div>
    </div>
  );
}

// ── Inline editable name (large) ─────────────────────────────────────────────
function InlineName({ value, field, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);

  useEffect(() => { setDraft(value || ''); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);

  const save = () => {
    setEditing(false);
    if (draft.trim() && draft !== (value || '')) onSave(field, draft.trim());
  };

  const cancel = () => { setDraft(value || ''); setEditing(false); };

  if (editing) {
    return (
      <input ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={save} onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        className="text-lg font-bold w-full border-b-2 border-primary bg-transparent outline-none py-0.5 px-0" />
    );
  }

  return (
    <h2 className="text-lg font-bold cursor-pointer hover:text-primary transition-colors leading-tight"
      onClick={() => setEditing(true)} title="Click to edit name">
      {value || 'Unnamed'}
    </h2>
  );
}

// ── Collapsible section (Pipedrive-style) ────────────────────────────────────
function Section({ title, badge, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/50">
      <button
        className="flex items-center gap-1 w-full px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/40 transition-colors"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !open && "-rotate-90")} />
        {title}
        {badge > 0 && (
          <span className="ml-1 bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="px-3 pb-3 animate-in fade-in duration-200">
          {children}
        </div>
      )}
    </div>
  );
}

const STAGES = [
  { key: 'to_be_scheduled', color: 'bg-muted-foreground/40' },
  { key: 'scheduled',       color: 'bg-blue-400' },
  { key: 'onsite',          color: 'bg-orange-400' },
  { key: 'uploaded',        color: 'bg-yellow-400' },
  { key: 'submitted',       color: 'bg-purple-400' },
  { key: 'in_progress',     color: 'bg-amber-400' },
  { key: 'ready_for_partial', color: 'bg-cyan-400' },
  { key: 'in_revision',     color: 'bg-red-400' },
  { key: 'delivered',       color: 'bg-green-500' },
];

const STATUS_BORDER = {
  to_be_scheduled: 'border-l-muted-foreground/30',
  scheduled: 'border-l-blue-400',
  onsite: 'border-l-orange-400',
  uploaded: 'border-l-yellow-400',
  submitted: 'border-l-purple-400',
  in_progress: 'border-l-amber-400',
  ready_for_partial: 'border-l-cyan-400',
  in_revision: 'border-l-red-500',
  delivered: 'border-l-green-500',
};

function fmtMoney(val) {
  if (!val) return null;
  if (val >= 1_000_000) return `A$${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `A$${(val / 1_000).toFixed(1)}k`;
  return `A$${Math.round(val)}`;
}

function PipelineBar({ status }) {
  const currentIdx = STAGES.findIndex(s => s.key === status);
  return (
    <div className="flex gap-0.5 mt-2">
      {STAGES.map((stage, i) => (
        <div
          key={stage.key}
          className={`h-1.5 flex-1 rounded-sm transition-colors ${i <= currentIdx ? stage.color : 'bg-muted'}`}
          title={stage.key.replace(/_/g, ' ')}
        />
      ))}
    </div>
  );
}

function ErrorState({ navigate, title, message }) {
  return (
    <div className="p-8">
      <Button variant="ghost" className="gap-2 mb-4" onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('People'))}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>
      <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-6 flex gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-red-900 dark:text-red-200">{title}</h3>
          <p className="text-red-800 dark:text-red-300 text-sm mt-1">{message}</p>
        </div>
      </div>
    </div>
  );
}

function MiniProjectCard({ project }) {
  const { visible: showPricing } = usePriceGate();
  return (
    <Link
      to={createPageUrl(`ProjectDetails?id=${project.id}`)}
      className="block p-2.5 rounded-lg bg-muted/40 hover:bg-muted/60 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-1.5">
        <div className="flex-1 min-w-0">
          <ProjectStatusBadge status={project.status} />
          <p className="text-xs font-medium text-foreground mt-1 truncate">{project.title}</p>
        </div>
        {project.outcome && (
          <Badge className={`text-[9px] shrink-0 ${project.outcome === 'won' ? 'bg-green-100 text-green-700 border-green-200' : project.outcome === 'lost' ? 'bg-red-100 text-red-700 border-red-200' : 'bg-muted text-muted-foreground'}`}>
            {project.outcome}
          </Badge>
        )}
      </div>
      <PipelineBar status={project.status} />
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5">
        <span>
          {project.shoot_date ? fmtDate(project.shoot_date, 'd MMM') : '—'} →{' '}
          {project.delivery_date ? fmtDate(project.delivery_date, 'd MMM') : '—'}
        </span>
        {showPricing && (project.calculated_price || project.price) ? (
          <span className="font-medium text-foreground">
            ${project.calculated_price || project.price}
          </span>
        ) : null}
      </div>
    </Link>
  );
}

function ActivityFeed({ interactions, projects }) {
  const allEvents = useMemo(() => {
    const items = [];
    interactions.forEach(inter => {
      items.push({
        type: 'interaction',
        data: inter,
        date: inter.date_time || inter.created_date,
      });
    });
    projects.forEach(proj => {
      if (proj.last_status_change) {
        items.push({
          type: 'project_update',
          data: proj,
          date: proj.last_status_change,
        });
      }
    });
    return items.sort((a, b) => new Date(fixTimestamp(b.date)) - new Date(fixTimestamp(a.date)));
  }, [interactions, projects]);

  if (allEvents.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity yet</p>;
  }

  return (
    <div className="space-y-3">
      {allEvents.map((item, idx) => {
        if (item.type === 'interaction') {
          const inter = item.data;
          return (
            <div key={`inter-${inter.id}`} className="flex gap-3 text-sm">
              <MessageSquare className="h-4 w-4 text-blue-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-foreground font-medium">{inter.interaction_type || 'Interaction'}</p>
                {inter.notes && <p className="text-xs text-muted-foreground mt-0.5">{inter.notes}</p>}
                <p className="text-xs text-muted-foreground mt-1">
                  {formatRelative(fixTimestamp(inter.date_time || inter.created_date))}
                </p>
              </div>
            </div>
          );
        } else if (item.type === 'project_update') {
          const proj = item.data;
          return (
            <div key={`proj-${proj.id}`} className="flex gap-3 text-sm">
              <Activity className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="text-foreground font-medium">{proj.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Status changed to <span className="font-medium capitalize">{(proj.status || '').replace(/_/g, ' ')}</span>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatRelative(fixTimestamp(proj.last_status_change))}
                </p>
              </div>
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}

// ── Tab definitions (reduced count, Pipedrive-style) ─────────────────────────
const TABS = [
  { id: 'notes', label: 'Notes', icon: MessageSquare },
  { id: 'emails', label: 'Email', icon: Mail },
  { id: 'files', label: 'Files', icon: Paperclip },
  { id: 'pricing', label: 'Pricing', icon: DollarSign },
  { id: 'calendar', label: 'Activities', icon: Calendar },
];

// ── History sub-filter tabs for Notes unified view ───────────────────────────
const HISTORY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'notes', label: 'Notes' },
  { id: 'activity', label: 'Activities' },
  { id: 'emails', label: 'Emails' },
  { id: 'changelog', label: 'Changelog' },
];

export default function PersonDetails() {
  const { canEdit, canView } = useEntityAccess('agents');
  const { visible: showPricing } = usePriceGate();
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(window.location.search);
  const agentId = urlParams.get('id');

  // Remember last selected tab
  const [activeTab, setActiveTab] = useState(() => {
    const saved = sessionStorage.getItem(`tab-person-${agentId}`);
    // Map old tab values to new ones
    if (saved === 'activity' || saved === 'interactions' || saved === 'timeline' || saved === 'audit') return 'notes';
    if (saved === 'details') return 'notes';
    return saved || 'notes';
  });
  const [historyFilter, setHistoryFilter] = useState('all');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [emailActivities, setEmailActivities] = useState([]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    sessionStorage.setItem(`tab-person-${agentId}`, tab);
  };

  const handleEmailActivity = useCallback((action, data) => {
    setEmailActivities(prev => [
      { action, data, timestamp: new Date().toISOString() },
      ...prev,
    ].slice(0, 50));
  }, []);

  const { data: agent, loading: agentLoading, error: agentError } = useSmartEntityData('Agent', agentId);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const searchInput = document.querySelector('[placeholder*="Search"]');
        if (searchInput) searchInput.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  const { data: agency } = useSmartEntityData('Agency', agent?.current_agency_id);
  const { data: allAgencies = [] } = useEntityList('Agency', 'name');
  const { data: allTeams = [] } = useEntityList('Team', 'name');

  const availableTeams = useMemo(() =>
    allTeams.filter(t => t.agency_id === (agent?.current_agency_id || '')),
    [allTeams, agent?.current_agency_id]
  );

  // Tag management state
  const [newTag, setNewTag] = useState('');

  // ── Auto-save handler (Pipedrive-style) ──────────────────────────────────
  const handleFieldSave = useCallback(async (field, value) => {
    if (!agent) return;
    try {
      const oldValue = agent[field];
      const payload = { [field]: value || null };
      if (field === 'current_agency_id') {
        const ag = allAgencies.find(a => a.id === value);
        payload.current_agency_name = ag?.name || '';
        payload.current_team_id = '';
        payload.current_team_name = '';
      }
      if (field === 'current_team_id') {
        const tm = allTeams.find(t => t.id === value);
        payload.current_team_name = tm?.name || '';
      }
      await api.entities.Agent.update(agent.id, payload);

      const user = await api.auth.me();
      await api.entities.AuditLog.create({
        entity_type: 'agent',
        entity_id: agent.id,
        entity_name: agent.name,
        action: 'update',
        changed_fields: [{ field, old_value: oldValue || '', new_value: value || '' }],
        user_name: user?.full_name || '',
        user_email: user?.email || '',
      }).catch(() => {});

      // Recompute data integrity after save
      const updatedAgent = { ...agent, ...payload };
      const newIssues = computeIntegrityIssues(updatedAgent);
      const issuesChanged = JSON.stringify(newIssues) !== JSON.stringify(agent.data_integrity_issues || []);
      const needsReviewChanged = agent.needs_review !== (newIssues.length > 0);
      if (issuesChanged || needsReviewChanged) {
        await api.entities.Agent.update(agent.id, {
          data_integrity_issues: newIssues,
          needs_review: newIssues.length > 0,
        }).catch(() => {});
      }

      refetchEntityList('Agent');
    } catch (err) {
      toast.error(`Failed to save ${field}`);
    }
  }, [agent, allAgencies, allTeams]);

  const handleAddTag = useCallback(async () => {
    if (!newTag.trim() || !agent) return;
    const oldTags = agent.tags || [];
    const tags = [...oldTags, newTag.trim()];
    try {
      await api.entities.Agent.update(agent.id, { tags });

      const user = await api.auth.me();
      await api.entities.AuditLog.create({
        entity_type: 'agent',
        entity_id: agent.id,
        entity_name: agent.name,
        action: 'update',
        changed_fields: [{ field: 'tags', old_value: oldTags, new_value: tags }],
        user_name: user?.full_name || '',
        user_email: user?.email || '',
      }).catch(() => {});

      refetchEntityList('Agent');
      setNewTag('');
    } catch (err) {
      toast.error('Failed to add tag');
    }
  }, [agent, newTag]);

  const handleRemoveTag = useCallback(async (tagToRemove) => {
    if (!agent) return;
    const oldTags = agent.tags || [];
    const tags = oldTags.filter(t => t !== tagToRemove);
    try {
      await api.entities.Agent.update(agent.id, { tags });

      const user = await api.auth.me();
      await api.entities.AuditLog.create({
        entity_type: 'agent',
        entity_id: agent.id,
        entity_name: agent.name,
        action: 'update',
        changed_fields: [{ field: 'tags', old_value: oldTags, new_value: tags }],
        user_name: user?.full_name || '',
        user_email: user?.email || '',
      }).catch(() => {});

      refetchEntityList('Agent');
    } catch (err) {
      toast.error('Failed to remove tag');
    }
  }, [agent]);

  const interactionFilter = useCallback(e => e.entity_type === 'Agent' && e.entity_id === agentId, [agentId]);
  const projectFilter = useCallback(e => e.agent_id === agentId, [agentId]);
  const noteFilter = useCallback(e => e.agent_id === agentId, [agentId]);

  const { data: interactions = [] } = useEntityList('InteractionLog', '-date_time', 200, interactionFilter);
  const { data: projects = [] } = useEntityList('Project', '-created_date', 200, projectFilter);
  const { data: orgNotes = [] } = useEntityList('OrgNote', '-created_date', null, noteFilter);
  const { data: priceMatrices = [] } = useEntityList('PriceMatrix', null, 100,
    useCallback(pm => pm.entity_type === 'agent' && pm.entity_id === agentId, [agentId])
  );

  // Analytics data
  const revisionFilter = useCallback(p => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(p.project_id);
  }, [projects]);
  const taskFilter = useCallback(t => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(t.project_id);
  }, [projects]);
  const timeLogFilter = useCallback(t => {
    const projIds = new Set(projects.map(pr => pr.id));
    return projIds.has(t.project_id);
  }, [projects]);

  const { data: revisions = [] } = useEntityList("ProjectRevision", "-created_date", 200, projects.length > 0 ? revisionFilter : null);
  const { data: projectTasks = [] } = useEntityList("ProjectTask", "-created_date", null, projects.length > 0 ? taskFilter : null);
  const { data: taskTimeLogs = [] } = useEntityList("TaskTimeLog", "-created_date", null, projects.length > 0 ? timeLogFilter : null);

  const openProjects = useMemo(() => projects.filter(p => !['delivered', 'in_revision'].includes(p.status)), [projects]);
  const wonProjects = useMemo(() => projects.filter(p => p.outcome === 'won'), [projects]);
  const closedCount = useMemo(() => projects.filter(p => p.outcome).length, [projects]);
  const totalRev = useMemo(() => wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0), [wonProjects]);

  const avgBookingValue = useMemo(() => {
    if (wonProjects.length === 0) return null;
    return Math.round(totalRev / wonProjects.length);
  }, [totalRev, wonProjects]);

  const bookingFrequency = useMemo(() => {
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 12);
    const recent = projects.filter(p => {
      const d = p.shoot_date || p.created_date;
      if (!d) return false;
      return new Date(fixTimestamp(d)) >= twelveMonthsAgo;
    });
    return recent.length > 0 ? (recent.length / 12).toFixed(1) : null;
  }, [projects]);

  const lastBookingDate = useMemo(() => {
    const withDates = projects
      .filter(p => p.shoot_date || p.created_date)
      .map(p => new Date(fixTimestamp(p.shoot_date || p.created_date)));
    if (withDates.length === 0) return null;
    return new Date(Math.max(...withDates.map(d => d.getTime())));
  }, [projects]);

  const daysSinceLastBooking = useMemo(() => {
    if (!lastBookingDate) return null;
    return Math.floor((Date.now() - lastBookingDate.getTime()) / (1000 * 60 * 60 * 24));
  }, [lastBookingDate]);

  const contactHealth = useMemo(() => {
    if (!agent?.contact_frequency_days) return null;
    if (daysSinceLastBooking === null) return 'ok';
    if (daysSinceLastBooking > agent.contact_frequency_days * 2) return 'risk';
    if (daysSinceLastBooking > agent.contact_frequency_days) return 'warn';
    return 'ok';
  }, [agent, daysSinceLastBooking]);

  const handleDelete = async () => {
    try {
      const user = await api.auth.me();
      api.entities.AuditLog.create({
        entity_type: 'agent', entity_id: agent?.id, entity_name: agent?.name,
        action: 'delete',
        user_name: user?.full_name || '', user_email: user?.email || '',
      }).catch(() => {});
      await api.entities.Agent.delete(agentId);
      toast.success('Person deleted');
      navigate(createPageUrl('People'));
    } catch (err) {
      toast.error(err?.message || 'Failed to delete person');
    }
  };

  if (!agentId) {
    navigate(createPageUrl('People'));
    return null;
  }

  if (agentLoading) {
    return (
      <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
        <div className="flex items-center gap-3 px-5 py-3 border-b bg-card shrink-0 shadow-sm">
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="w-px h-5 bg-border" />
          <div className="h-8 w-8 rounded-lg bg-muted animate-pulse" />
          <div className="h-5 w-48 rounded bg-muted animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-muted animate-pulse" />
        </div>
        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="w-96 shrink-0 border-r bg-card p-4 space-y-4">
            {[1, 2, 3, 4].map(i => <div key={i} className="h-16 rounded-lg bg-muted animate-pulse" />)}
          </div>
          <div className="flex-1 p-6 space-y-4 animate-in fade-in duration-300">
            <div className="h-8 w-64 rounded bg-muted animate-pulse" />
            <div className="h-48 rounded-xl bg-muted animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (agentError || !agent) {
    return (
      <ErrorState
        navigate={navigate}
        title="Person Not Found"
        message="This person may have been deleted or you don't have access."
      />
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
      {/* ── Header: Back + Name + State Badge ─────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 shadow-sm z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('People'))}
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <span className="text-sm font-bold text-primary-foreground leading-none">
            {(agent.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>

        <h1 className="text-base font-bold truncate leading-tight">{agent.name}</h1>

        {agent.relationship_state && (
          <Badge className={`text-[11px] shrink-0 border font-medium px-2 py-0.5 ${STATE_BADGE[agent.relationship_state] || 'bg-muted text-muted-foreground'}`}>
            {agent.relationship_state.toUpperCase()}
          </Badge>
        )}

        {canView && !canEdit && <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">View only</Badge>}
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            className="gap-1.5 h-8 text-xs font-semibold shadow-sm"
            onClick={() => navigate(createPageUrl('Projects') + `?agent=${agentId}`)}
          >
            <Plus className="h-3.5 w-3.5" />
            New Project
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 h-8 text-xs"
            onClick={() => {
              handleTabChange('notes');
              setTimeout(() => {
                const textarea = document.querySelector('[data-note-textarea]');
                if (textarea) {
                  textarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  textarea.focus();
                }
              }, 150);
            }}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Add Note
          </Button>
        </div>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* ── Left sidebar ─────────────────────────────────────────── */}
        <div className="w-96 shrink-0 border-r overflow-y-auto bg-card">
          {/* Name + Title + State at top */}
          <div className="px-3 pt-4 pb-3 border-b border-border/50">
            <div className="flex items-start gap-3 mb-2">
              <div className="h-11 w-11 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-base font-bold text-primary-foreground leading-none">
                  {(agent.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <InlineName value={agent.name} field="name" onSave={handleFieldSave} />
                {agent.title && (
                  <p className="text-xs text-muted-foreground truncate">{agent.title}</p>
                )}
              </div>
            </div>
            {agent.relationship_state && (
              <Badge className={`text-[10px] border font-semibold px-2 py-0.5 ${STATE_BADGE[agent.relationship_state] || 'bg-muted text-foreground/80'}`}>
                {agent.relationship_state.toUpperCase()}
              </Badge>
            )}
            {agent.auto_created && (
              <Badge className="text-[10px] border font-medium px-2 py-0.5 bg-sky-50 text-sky-700 border-sky-200 ml-1">
                Auto-created from Tonomo
              </Badge>
            )}
          </div>

          {/* Data integrity banner */}
          {agent.needs_review && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 px-3 py-2">
              <div className="flex items-center gap-1.5 mb-1">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">This contact needs review</span>
              </div>
              {(() => {
                const issues = Array.isArray(agent.data_integrity_issues) ? agent.data_integrity_issues : [];
                return issues.length > 0 ? (
                  <ul className="space-y-0.5 ml-5">
                    {issues.map(issue => (
                      <li key={issue} className="text-[10px] text-amber-700 dark:text-amber-400 list-disc">
                        {INTEGRITY_LABELS[issue] || issue}
                      </li>
                    ))}
                  </ul>
                ) : null;
              })()}
            </div>
          )}

          {/* Summary section */}
          <Section title="Summary" defaultOpen>
            <InlineField label="Position" value={agent.title} field="title" onSave={handleFieldSave}
              type="select"
              options={[
                { value: 'Partner', label: 'Partner' },
                { value: 'Senior', label: 'Senior' },
                { value: 'Junior', label: 'Junior' },
                { value: 'Admin', label: 'Admin' },
                { value: 'Payroll', label: 'Payroll' },
                { value: 'Marketing', label: 'Marketing' },
              ]} />
            <InlineField label="Email" value={agent.email} field="email" onSave={handleFieldSave}
              placeholder="Add email..."
              actionHref={agent.email ? `mailto:${agent.email}` : null}
              actionIcon={Mail}
              actionLabel="Send email" />
            <InlineField label="Phone" value={agent.phone} field="phone" onSave={handleFieldSave}
              placeholder="Add phone..."
              actionHref={agent.phone ? `tel:${agent.phone}` : null}
              actionIcon={Phone}
              actionLabel="Call" />
            <InlineField label="Organisation" value={agent.current_agency_id} field="current_agency_id"
              onSave={handleFieldSave} type="select"
              options={allAgencies.map(a => ({ value: a.id, label: a.name }))} />
            <InlineField label="Team" value={agent.current_team_id} field="current_team_id"
              onSave={handleFieldSave} type="select"
              options={[{ value: '', label: 'No team' }, ...availableTeams.map(t => ({ value: t.id, label: t.name }))]} />
            <InlineField label="State" value={agent.relationship_state} field="relationship_state"
              onSave={handleFieldSave} type="select" options={RELATIONSHIP_STATES} />

            {/* Quick stats inline */}
            {(projects.length > 0 || totalRev > 0) && (
              <div className="flex items-start gap-2 py-1 px-3">
                <span className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide">Stats</span>
                <div className="flex flex-wrap gap-1.5">
                  <span className="text-[11px] bg-muted px-2 py-0.5 rounded-full font-medium">
                    {projects.length} projects
                  </span>
                  {showPricing && totalRev > 0 && (
                    <span className="text-[11px] bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium border border-green-100">
                      {fmtMoney(totalRev)} revenue
                    </span>
                  )}
                  {showPricing && avgBookingValue && (
                    <span className="text-[11px] bg-muted px-2 py-0.5 rounded-full font-medium">
                      avg {fmtMoney(avgBookingValue)}
                    </span>
                  )}
                  {bookingFrequency && (
                    <span className="text-[11px] bg-muted px-2 py-0.5 rounded-full font-medium">
                      {bookingFrequency}/mo
                    </span>
                  )}
                </div>
              </div>
            )}
          </Section>

          {/* Details section */}
          <Section title="Details" defaultOpen={false}>
            <InlineField label="Prospect Status" value={agent.status} field="status"
              onSave={handleFieldSave} type="select" options={PROSPECT_STATUSES} />
            <InlineField label="Source" value={agent.source} field="source"
              onSave={handleFieldSave} type="select" options={SOURCES} />
            <InlineField label="Last Contacted" value={agent.last_contacted_at ? String(agent.last_contacted_at).substring(0, 10) : ''}
              field="last_contacted_at" onSave={(field, val) => handleFieldSave(field, val ? new Date(val).toISOString() : null)}
              type="date" placeholder="Not contacted yet" />
            <InlineField label="Frequency (days)" value={agent.contact_frequency_days ? String(agent.contact_frequency_days) : ''}
              field="contact_frequency_days" onSave={(field, val) => handleFieldSave(field, val ? Number(val) : null)}
              type="number" placeholder="e.g. 30" />
            {contactHealth && (
              <div className="flex items-start gap-2 py-1 px-3">
                <span className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide">Health</span>
                <span className={cn(
                  "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                  contactHealth === 'ok'   ? 'bg-green-100 text-green-700' :
                  contactHealth === 'warn' ? 'bg-amber-100 text-amber-700' :
                                              'bg-red-100 text-red-700'
                )}>
                  {contactHealth === 'ok'   ? 'On track' :
                   contactHealth === 'warn' ? 'Due for contact' :
                   `Overdue - ${daysSinceLastBooking}d ago`}
                </span>
              </div>
            )}
            <InlineField label="Next Follow-up" value={agent.next_follow_up_date ? String(agent.next_follow_up_date).substring(0, 10) : ''}
              field="next_follow_up_date" onSave={(field, val) => handleFieldSave(field, val ? new Date(val).toISOString() : null)}
              type="date" placeholder="Set follow-up..." />
            <InlineField label="Value Potential" value={agent.value_potential} field="value_potential"
              onSave={handleFieldSave} type="select"
              options={VALUE_OPTIONS} />
            <div className="flex items-start gap-2 py-1 px-3">
              <span className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide">Club Flex</span>
              <button
                onClick={() => handleFieldSave('club_flex', !agent.club_flex)}
                className={cn(
                  "text-[10px] px-2 py-0.5 rounded-full border font-medium transition-colors",
                  agent.club_flex
                    ? 'bg-purple-100 text-purple-700 border-purple-200 hover:bg-purple-200'
                    : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
                )}
              >
                {agent.club_flex ? 'Enabled' : 'Disabled'}
              </button>
            </div>
            <InlineField label="Became Active" value={agent.became_active_date ? String(agent.became_active_date).substring(0, 10) : ''}
              field="became_active_date" onSave={handleFieldSave} type="date" placeholder="Not set" />
            <InlineField label="Became Dormant" value={agent.became_dormant_date ? String(agent.became_dormant_date).substring(0, 10) : ''}
              field="became_dormant_date" onSave={handleFieldSave} type="date" placeholder="Not set" />
            <InlineField label="Added" value={agent.created_date ? fmtTimestampCustom(agent.created_date, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}
              field="created_date" onSave={() => {}} readOnly />
          </Section>

          {/* Notes section */}
          <Section title="Notes" defaultOpen={!!(agent.notes || agent.discovery_call_notes)}>
            <InlineField label="General" value={agent.notes} field="notes"
              onSave={handleFieldSave} type="textarea" placeholder="Click to add notes..." />
            <InlineField label="Discovery" value={agent.discovery_call_notes} field="discovery_call_notes"
              onSave={handleFieldSave} type="textarea" placeholder="Click to add discovery notes..." />
            <InlineField label="Unqualified" value={agent.reason_unqualified} field="reason_unqualified"
              onSave={handleFieldSave} type="textarea" placeholder="If unqualified, explain why..." />
          </Section>

          {/* Tags section */}
          <Section title="Tags" defaultOpen={!!(agent.tags?.length)}>
            <div className="space-y-2">
              {(agent.tags || []).length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {agent.tags.map((tag, i) => (
                    <span key={i} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {tag}
                      <button onClick={() => handleRemoveTag(tag)} className="hover:text-destructive transition-colors" title="Remove tag">
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="flex gap-1">
                <input
                  value={newTag}
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddTag()}
                  placeholder="Add tag..."
                  className="flex-1 text-xs border rounded px-2 py-1 bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none"
                />
                <button onClick={handleAddTag} disabled={!newTag.trim()}
                  className="text-xs px-2 py-1 rounded bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-30 transition-colors">
                  <Plus className="h-3 w-3" />
                </button>
              </div>
            </div>
          </Section>

          {/* Projects section */}
          {projects.length > 0 && (
            <Section title="Projects" badge={openProjects.length} defaultOpen>
              <div className="space-y-2">
                {projects.slice(0, 10).map(proj => {
                  const price = proj.calculated_price || proj.price;
                  return (
                    <div key={proj.id} className={`rounded-lg border-l-4 border border-l-current bg-background p-2.5 hover:shadow-md hover:bg-muted/20 transition-all duration-200 group ${STATUS_BORDER[proj.status] || 'border-l-gray-300'}`}>
                      <Link
                        to={createPageUrl("ProjectDetails") + `?id=${proj.id}`}
                        className="text-xs font-semibold hover:text-primary line-clamp-2 leading-tight block group-hover:text-primary transition-colors"
                      >
                        {proj.title}
                      </Link>
                      {proj.agent_name && (
                        <p className="text-[10px] text-muted-foreground mt-0.5 flex items-center gap-1">
                          <User className="h-2.5 w-2.5" />{proj.agent_name}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                        <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
                          {proj.status?.replace(/_/g, ' ').toUpperCase()}
                        </span>
                        {showPricing && price != null && <span className="text-[11px] font-bold text-foreground ml-auto">{fmtMoney(price)}</span>}
                      </div>
                      {(proj.shoot_date || proj.delivery_date) && (
                        <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                          <Calendar className="h-2.5 w-2.5 shrink-0" />
                          {proj.shoot_date && <span>{fmtDate(proj.shoot_date, 'd MMM yy')}</span>}
                          {proj.shoot_date && proj.delivery_date && <span>&rarr;</span>}
                          {proj.delivery_date && <span>{fmtDate(proj.delivery_date, 'd MMM yy')}</span>}
                        </div>
                      )}
                      <PipelineBar status={proj.status} />
                    </div>
                  );
                })}
                {projects.length > 10 && (
                  <button
                    onClick={() => navigate(createPageUrl('Projects') + `?agent=${agentId}`)}
                    className="w-full text-center text-xs text-primary hover:text-primary/80 font-medium py-2 mt-1 rounded-md hover:bg-primary/5 transition-colors"
                  >
                    View all {projects.length} projects
                  </button>
                )}
              </div>
            </Section>
          )}

          {/* Analytics */}
          {projects.length > 0 && (
            <div className="border-t pt-2">
              <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-3 py-2">Analytics</div>
              <SharedDashboard
                projects={projects}
                revisions={revisions}
                projectTasks={projectTasks}
                taskTimeLogs={taskTimeLogs}
                entityLabel={agent?.name || 'Person'}
              />
            </div>
          )}

          {/* Delete Contact */}
          <div className="px-3 py-4 border-t border-border/50">
            <button
              onClick={() => setShowDeleteConfirm(true)}
              disabled={!canEdit}
              className="text-xs text-destructive/60 hover:text-destructive transition-colors flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Trash2 className="h-3 w-3" />
              Delete Contact
            </button>
          </div>
        </div>

        {/* ── Right main area ──────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden bg-background flex flex-col">
          {/* Pipedrive-style tab bar */}
          <div className="flex items-center gap-0 border-b px-4 shrink-0">
            {TABS.filter(tab => tab.id !== 'pricing' || showPricing).map(tab => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={cn(
                  "flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                  activeTab === tab.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
                {tab.id === 'notes' && orgNotes.filter(n => !n.parent_note_id).length > 0 && (
                  <span className="bg-primary/10 text-primary text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1">
                    {orgNotes.filter(n => !n.parent_note_id).length}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden">
            {/* ── Notes tab: unified feed with history sub-filters ── */}
            {activeTab === 'notes' && (
              <div className="h-full flex flex-col overflow-hidden">
                {/* Notes composer at top */}
                <div className="border-b shrink-0">
                  <UnifiedNotesPanel
                    agentId={agentId}
                    contextLabel={agent?.name}
                    contextType="agent"
                    relatedProjectIds={projects.map(p => p.id)}
                  />
                </div>

                {/* History — unified activity feed with built-in filters */}
                <div className="flex-1 overflow-y-auto">
                  <ContactActivityLog
                    entityType="agent"
                    entityId={agent.id}
                    entityLabel={agent.name}
                    emailActivities={emailActivities}
                    showChangelog
                  />
                </div>
              </div>
            )}

            {/* ── Email tab ──────────────────────────────────────── */}
            {activeTab === 'emails' && (
              <div className="h-full overflow-hidden">
                <EntityEmailTab
                  entityType="agent"
                  entityId={agentId}
                  entityLabel={agent?.name}
                  onEmailActivity={handleEmailActivity}
                />
              </div>
            )}

            {/* ── Files tab ──────────────────────────────────────── */}
            {activeTab === 'files' && (
              <div className="h-full overflow-hidden">
                <ContactFiles
                  entityType="agent"
                  entityId={agentId}
                  entityLabel={agent?.name}
                />
              </div>
            )}

            {/* ── Pricing tab ────────────────────────────────────── */}
            {activeTab === 'pricing' && showPricing && (
              <div className="h-full overflow-y-auto p-6">
                <div className="max-w-4xl">
                  <h2 className="text-lg font-semibold mb-4">Pricing Matrix</h2>
                  {priceMatrices.length > 0 ? (
                    <PriceMatrixSummaryTable priceMatrices={priceMatrices} />
                  ) : (
                    <div className="bg-muted rounded-lg p-6 text-center">
                      <p className="text-sm text-muted-foreground mb-3">
                        No custom pricing configured for this person yet.
                      </p>
                      {agency && (
                        <p className="text-xs text-muted-foreground">
                          Using <Link to={createPageUrl('OrgDetails') + `?id=${agency.id}`} className="text-primary hover:underline">
                            {agency.name}
                          </Link> agency-level pricing.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Activities/Calendar tab ─────────────────────────── */}
            {activeTab === 'calendar' && (
              <div className="h-full overflow-hidden">
                <EntityActivitiesTab
                  entityType="agent"
                  entityId={agent?.id}
                  entityLabel={agent?.name || 'Person'}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete person?"
        description="This will permanently delete this person and cannot be undone."
        confirmText="Delete"
        onConfirm={() => {
          setShowDeleteConfirm(false);
          handleDelete();
        }}
        onCancel={() => setShowDeleteConfirm(false)}
        danger
      />
    </div>
    </ErrorBoundary>
  );
}

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { useNavigate, Link } from 'react-router-dom';
import { useSmartEntityData } from '@/components/hooks/useSmartEntityData';
import { useEntityList, refetchEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import SharedDashboard from '@/components/analytics/SharedDashboard';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';
import { fmtDate, fixTimestamp, formatRelative } from '@/components/utils/dateUtils';
import {
  ArrowLeft, ChevronDown, Mail, Phone, Building2,
  MessageSquare, Activity, AlertCircle, Plus, Trash2, Calendar, User, Paperclip, Pencil,
  FileText, Users
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import UnifiedNotesPanel from '@/components/notes/UnifiedNotesPanel';
import ProjectStatusBadge from '@/components/dashboard/ProjectStatusBadge';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import EntityEmailTab from '@/components/email/EntityEmailTab';
import ContactActivityLog from '@/components/contacts/ContactActivityLog';
import ContactFiles from '@/components/contacts/ContactFiles';
import EntityActivitiesTab from '@/components/calendar/EntityActivitiesTab';

// ── Tab definitions (Pipedrive-style, matching PersonDetails) ────────────────
const TABS = [
  { id: 'notes', label: 'Notes', icon: FileText },
  { id: 'email', label: 'Email', icon: Mail },
  { id: 'files', label: 'Files', icon: Paperclip },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'activities', label: 'Activities', icon: Calendar },
];

// ── History sub-filter tabs for Notes unified view ───────────────────────────
const HISTORY_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'notes', label: 'Notes' },
  { id: 'activity', label: 'Activities' },
  { id: 'emails', label: 'Emails' },
  { id: 'changelog', label: 'Changelog' },
];

const STATE_BADGE = {
  Active: 'bg-green-100 text-green-800 border-green-200',
  Prospecting: 'bg-blue-100 text-blue-800 border-blue-200',
  Dormant: 'bg-amber-100 text-amber-800 border-amber-200',
  'Do Not Contact': 'bg-red-100 text-red-800 border-red-200',
};

const STAGES = [
  { key: 'to_be_scheduled', color: 'bg-gray-300' },
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
  to_be_scheduled: 'border-l-gray-300',
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

function ErrorState({ navigate, title, message }) {
  return (
    <div className="p-8">
      <Button variant="ghost" className="gap-2 mb-4" onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('Teams'))}>
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

function Section({ title, badge, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-border/50">
      <button
        className="flex items-center gap-2 w-full px-4 py-2.5 text-xs font-semibold text-foreground hover:text-primary hover:bg-muted/40 transition-all duration-200 text-left"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform duration-200 ${!open && '-rotate-90'}`} />
        <span className="uppercase tracking-wide">{title}</span>
        {badge > 0 && (
          <span className="ml-0.5 bg-primary/10 text-primary text-[10px] font-bold px-1.5 py-0.5 rounded-full">
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="px-4 pb-4 animate-in fade-in duration-200">
          {children}
        </div>
      )}
    </div>
  );
}

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

function InlineField({ label, value, field, onSave, type = 'text', options, placeholder, icon: Icon, viewRender }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value || '');
  const inputRef = useRef(null);
  useEffect(() => { setDraft(value || ''); }, [value]);
  useEffect(() => { if (editing && inputRef.current) inputRef.current.focus(); }, [editing]);
  const cancel = () => { setDraft(value || ''); setEditing(false); };
  const save = () => { setEditing(false); if (draft !== (value || '')) onSave(field, draft); };

  const displayValue = type === 'select' && options
    ? (options.find(o => (o.value ?? o) === value)?.label ?? value)
    : value;

  if (type === 'select') {
    if (editing) {
      return (
        <div className="group flex items-start gap-2 py-1 px-3 hover:bg-muted/30">
          {label && <label className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide flex items-center gap-1">{Icon && <Icon className="h-3 w-3" />} {label}</label>}
          <select ref={inputRef} value={draft} onChange={e => {
              const val = e.target.value;
              setDraft(val);
              setEditing(false);
              if (val !== (value || '')) onSave(field, val);
            }} onBlur={save} onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
            className="flex-1 text-sm border rounded px-2 py-1 bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none">
            <option value="">-- Select --</option>
            {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
          </select>
        </div>
      );
    }
    return (
      <div className="group flex items-start gap-2 py-1 px-3 hover:bg-muted/30">
        {label && <label className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide flex items-center gap-1">{Icon && <Icon className="h-3 w-3" />} {label}</label>}
        <div className="flex-1 min-w-0 flex items-start gap-1">
          {viewRender || (
            <span className={cn("text-sm flex-1", displayValue ? "text-foreground" : "text-muted-foreground/40")}>
              {displayValue || '\u2014'}
            </span>
          )}
          <button
            onClick={() => setEditing(true)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted shrink-0"
            title={`Edit ${label}`}
          >
            <Pencil className="h-3 w-3 text-muted-foreground" />
          </button>
        </div>
      </div>
    );
  }
  if (type === 'textarea' && editing) {
    return (
      <div className="group flex items-start gap-2 py-1 px-3 hover:bg-muted/30">
        <label className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide">{label}</label>
        <textarea ref={inputRef} value={draft} onChange={e => setDraft(e.target.value)} onBlur={save}
          onKeyDown={e => { if (e.key === 'Escape') cancel(); }}
          rows={3} className="flex-1 text-sm border rounded px-2 py-1.5 bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none resize-none" />
      </div>
    );
  }
  return (
    <div className="group flex items-start gap-2 py-1 px-3 hover:bg-muted/30">
      <label className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide flex items-center gap-1">
        {Icon && <Icon className="h-3 w-3" />} {label}
      </label>
      <div className="flex-1 min-w-0 flex items-start gap-1">
        {editing ? (
          <input ref={inputRef} type={type === 'date' ? 'date' : type === 'number' ? 'number' : 'text'}
            value={draft} onChange={e => setDraft(e.target.value)} onBlur={save}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
            placeholder={placeholder} className="w-full text-sm border rounded px-2 py-1 bg-background focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none" />
        ) : (
          <>
            <span className={cn("text-sm flex-1", displayValue ? "text-foreground" : "text-muted-foreground/40")}>
              {displayValue || '\u2014'}
            </span>
            <button
              onClick={() => setEditing(true)}
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted shrink-0"
              title={`Edit ${label}`}
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </button>
          </>
        )}
      </div>
    </div>
  );
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

function MiniProjectCard({ project }) {
  const wonProjects = [project].filter(p => p.outcome === 'won');
  const lostProjects = [project].filter(p => p.outcome === 'lost');
  const totalClosed = wonProjects.length + lostProjects.length;
  const winRate = totalClosed > 0 ? Math.round((wonProjects.length / totalClosed) * 100) : null;

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
      </div>
      <PipelineBar status={project.status} />
      <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5">
        <span>
          {project.shoot_date ? fmtDate(project.shoot_date, 'd MMM') : '—'} →{' '}
          {project.delivery_date ? fmtDate(project.delivery_date, 'd MMM') : '—'}
        </span>
        {project.calculated_price || project.price ? (
          <span className="font-medium text-foreground">
            ${project.calculated_price || project.price}
          </span>
        ) : null}
      </div>
      {winRate !== null && (
        <div className="mt-2 pt-2 border-t border-border/30">
          <div className="flex items-center justify-between text-[10px] mb-1">
            <span className="text-muted-foreground">
              {wonProjects.length}W / {lostProjects.length}L
            </span>
            <span className="font-medium text-green-600">{winRate}%</span>
          </div>
          <div className="w-full bg-muted rounded-full h-1">
            {wonProjects.length > 0 && (
              <div
                className="h-1 bg-green-500 rounded-full"
                style={{ width: `${winRate}%` }}
              />
            )}
          </div>
        </div>
      )}
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
                  Status changed to <span className="font-medium capitalize">{(proj.status || 'unknown').replace(/_/g, ' ')}</span>
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {formatRelative(fixTimestamp(proj.last_status_change))}
                </p>
              </div>
            </div>
          );
        }
      })}
    </div>
  );
}

function MemberCard({ member }) {
  const initials = (member.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  return (
    <Link
      to={createPageUrl(`PersonDetails?id=${member.id}`)}
      className="block p-3 rounded-lg bg-muted/40 hover:bg-muted/60 transition-colors"
    >
      <div className="flex items-start gap-3">
        <div className="h-8 w-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center flex-shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-foreground truncate">{member.name}</p>
          {member.title && <p className="text-[10px] text-muted-foreground truncate mt-0.5">{member.title}</p>}
          {member.email && <p className="text-[10px] text-primary hover:underline truncate mt-0.5">{member.email}</p>}
          <div className="mt-2">
            <Badge className={`text-[10px] border ${STATE_BADGE[member.relationship_state] || 'bg-muted text-foreground/80'}`}>
              {member.relationship_state || 'Unknown'}
            </Badge>
          </div>
        </div>
      </div>
    </Link>
  );
}

export default function TeamDetails() {
  const navigate = useNavigate();
  const urlParams = new URLSearchParams(window.location.search);
  const teamId = urlParams.get('id');
  // Remember last selected tab
  const [activeTab, setActiveTab] = useState(() => {
    const saved = sessionStorage.getItem(`tab-team-${teamId}`);
    // Map old tab values to new ones
    if (saved === 'activity' || saved === 'interactions' || saved === 'audit') return 'notes';
    if (saved === 'emails') return 'email';
    const validTabs = TABS.map(t => t.id);
    return validTabs.includes(saved) ? saved : 'notes';
  });
  const [historyFilter, setHistoryFilter] = useState('all');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [emailActivities, setEmailActivities] = useState([]);

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    sessionStorage.setItem(`tab-team-${teamId}`, tab);
  };

  const handleEmailActivity = useCallback((action, data) => {
    setEmailActivities(prev => [
      { action, data, timestamp: new Date().toISOString() },
      ...prev,
    ].slice(0, 50));
  }, []);

  const { data: team, loading: teamLoading, error: teamError } = useSmartEntityData('Team', teamId);

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
  const { data: agency } = useSmartEntityData('Agency', team?.agency_id);
  const { data: agencies = [] } = useEntityList('Agency', 'name');

  const memberFilter = useCallback(a => a.current_team_id === teamId, [teamId]);
  const noteFilter = useCallback(e => e.team_id === teamId, [teamId]);
  const interactionFilter = useCallback(e => e.entity_type === 'Team' && e.entity_id === teamId, [teamId]);

  // members must be declared BEFORE memberIds/projectFilter that depend on it
  const { data: members = [] } = useEntityList('Agent', 'name', null, memberFilter);

  // Project filter: match projects where any assigned staff is a member of this team.
  // Staff ID fields hold agent (person) IDs, not team IDs, so we compare against member IDs.
  const memberIds = useMemo(() => new Set(members.map(m => m.id)), [members]);
  const projectFilter = useCallback(
    p => {
      if (memberIds.size === 0) return false;
      return (
        memberIds.has(p.agent_id) ||
        memberIds.has(p.project_owner_id) ||
        memberIds.has(p.onsite_staff_1_id) ||
        memberIds.has(p.onsite_staff_2_id) ||
        memberIds.has(p.image_editor_id) ||
        memberIds.has(p.video_editor_id) ||
        memberIds.has(p.floorplan_editor_id) ||
        memberIds.has(p.drone_editor_id)
      );
    },
    [memberIds]
  );
  const { data: projects = [] } = useEntityList('Project', '-created_date', 200, projectFilter);
  const { data: orgNotes = [] } = useEntityList('OrgNote', '-created_date', null, noteFilter);
  const { data: interactions = [] } = useEntityList('InteractionLog', '-date_time', 100, interactionFilter);

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
  const totalRev = useMemo(() => wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0), [wonProjects]);

  // Only count root notes (not replies) for the badge
  const rootNoteCount = useMemo(() => orgNotes?.filter(n => !n.parent_note_id).length || 0, [orgNotes]);

  const membersByState = useMemo(() => {
    const states = ['Active', 'Prospecting', 'Dormant', 'Do Not Contact'];
    const grouped = {};
    states.forEach(s => {
      grouped[s] = members.filter(m => m.relationship_state === s);
    });
    return grouped;
  }, [members]);

  const handleDelete = async () => {
    try {
      await api.entities.Team.delete(teamId);
      toast.success('Team deleted');
      navigate(createPageUrl('Teams'));
    } catch (err) {
      toast.error(err?.message || 'Failed to delete team');
    }
  };

  const handleFieldSave = async (field, value) => {
    try {
      const oldValue = team[field];
      const updates = { [field]: value || null };
      if (field === 'agency_id') {
        const newAgency = agencies.find(a => a.id === value);
        updates.agency_name = newAgency?.name || null;
      }
      await api.entities.Team.update(team.id, updates);

      // Propagate team name change to all agents and users with this team
      if (field === 'name' && value !== oldValue) {
        try {
          const teamAgents = members.filter(a => a.current_team_id === team.id);
          await Promise.all(teamAgents.map(a =>
            api.entities.Agent.update(a.id, { current_team_name: value || '' }).catch(() => {})
          ));
        } catch { /* non-fatal propagation */ }
        try {
          const allUsers = await api.entities.User.filter({ internal_team_id: team.id }, null, 200);
          await Promise.all(allUsers.map(u =>
            api.entities.User.update(u.id, { internal_team_name: value || '' }).catch(() => {})
          ));
        } catch { /* non-fatal propagation */ }
      }

      // Write audit log
      const user = await api.auth.me();
      await api.entities.AuditLog.create({
        entity_type: 'team',
        entity_id: team.id,
        entity_name: team.name,
        action: 'update',
        changed_fields: [{ field, old_value: oldValue || '', new_value: value || '' }],
        user_name: user?.full_name || '',
        user_email: user?.email || '',
      }).catch(() => {}); // non-fatal

      refetchEntityList('Team');
    } catch (err) {
      toast.error(`Failed to save ${field}`);
    }
  };

  const agencyOptions = useMemo(() => [
    { value: '', label: 'No agency' },
    ...agencies.map(a => ({ value: a.id, label: a.name }))
  ], [agencies]);

  if (!teamId) {
    navigate(createPageUrl('Teams'));
    return null;
  }

  if (teamLoading) {
    return (
      <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
        <div className="flex items-center gap-3 px-5 py-3 border-b bg-card shrink-0 shadow-sm">
          <div className="h-8 w-8 rounded-md bg-muted animate-pulse" />
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
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map(i => <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />)}
            </div>
            <div className="h-48 rounded-xl bg-muted animate-pulse" />
          </div>
        </div>
      </div>
    );
  }

  if (teamError || !team) {
    return (
      <ErrorState
        navigate={navigate}
        title="Team Not Found"
        message="This team may have been deleted or you don't have access."
      />
    );
  }

  return (
    <ErrorBoundary>
    <div className="flex flex-col h-[calc(100vh-4rem)] lg:h-screen overflow-hidden bg-background">
      {/* ── Header: Back + Avatar + Name + Badge ─────────────────────────── */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 shadow-sm z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => window.history.length > 1 ? navigate(-1) : navigate(createPageUrl('Teams'))}
          aria-label="Go back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <span className="text-sm font-bold text-primary-foreground leading-none">
            {(team.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>

        <h1 className="text-base font-bold truncate leading-tight">{team.name}</h1>

        {agency && (
          <Badge className="text-[11px] shrink-0 border font-medium px-2 py-0.5 bg-blue-100 text-blue-800 border-blue-200">
            {agency.name}
          </Badge>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <Button
            size="sm"
            className="gap-1.5 h-8 text-xs font-semibold shadow-sm"
            onClick={() => navigate(createPageUrl('Projects') + `?team=${teamId}`)}
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

      {/* Body */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* ── Left sidebar ─────────────────────────────────────────── */}
        <div className="w-96 shrink-0 border-r overflow-y-auto bg-card">
          {/* Name + Agency at top */}
          <div className="px-3 pt-4 pb-3 border-b border-border/50">
            <div className="flex items-start gap-3 mb-2">
              <div className="h-11 w-11 rounded-lg bg-primary flex items-center justify-center shrink-0">
                <span className="text-base font-bold text-primary-foreground leading-none">
                  {(team.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <InlineName value={team.name} field="name" onSave={handleFieldSave} />
                {agency && (
                  <Link
                    to={createPageUrl('OrgDetails') + `?id=${agency.id}`}
                    className="text-xs text-primary hover:underline truncate block mt-0.5"
                  >
                    {agency.name}
                  </Link>
                )}
              </div>
            </div>
          </div>

            {/* Team Info — inline editable */}
            <Section title="Team Info" badge={0} defaultOpen>
              <div className="space-y-0.5">
                <InlineField label="Team Name" value={team.name} field="name" onSave={handleFieldSave} placeholder="Team name" />
                <InlineField label="Agency" value={team.agency_id} field="agency_id" onSave={handleFieldSave} type="select" options={agencyOptions} icon={Building2}
                  viewRender={agency ? (
                    <Link to={createPageUrl('OrgDetails') + `?id=${agency.id}`} className="text-sm text-primary hover:underline mt-0.5 block" onClick={e => e.stopPropagation()}>
                      {agency.name}
                    </Link>
                  ) : undefined}
                />
                <InlineField label="Email" value={team.email} field="email" onSave={handleFieldSave} placeholder="Email address" icon={Mail} />
                <InlineField label="Phone" value={team.phone} field="phone" onSave={handleFieldSave} placeholder="Phone number" icon={Phone} />
                <InlineField label="Notes" value={team.notes} field="notes" onSave={handleFieldSave} type="textarea" placeholder="Add notes..." />

                {/* Quick stats inline */}
                {(projects.length > 0 || members.length > 0) && (
                  <div className="flex items-start gap-2 py-1 px-3">
                    <span className="text-[11px] text-muted-foreground text-right w-28 shrink-0 pt-0.5 uppercase tracking-wide">Stats</span>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="text-[11px] bg-muted px-2 py-0.5 rounded-full font-medium">
                        {members.length} members
                      </span>
                      <span className="text-[11px] bg-muted px-2 py-0.5 rounded-full font-medium">
                        {projects.length} projects
                      </span>
                      {totalRev > 0 && (
                        <span className="text-[11px] bg-green-50 text-green-700 px-2 py-0.5 rounded-full font-medium border border-green-100">
                          {fmtMoney(totalRev)} revenue
                        </span>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </Section>

            {/* Members */}
            <Section title="Members" badge={members.length} defaultOpen={true}>
              {members.length === 0 ? (
                <p className="text-xs text-muted-foreground">No members assigned</p>
              ) : (
                <div className="space-y-2">
                  {members.slice(0, 10).map(member => (
                    <Link
                      key={member.id}
                      to={createPageUrl(`PersonDetails?id=${member.id}`)}
                      className="flex items-center gap-2 p-2 rounded-lg bg-muted/30 hover:bg-muted/50 transition-all duration-200 cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
                    >
                      <div className="h-6 w-6 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center flex-shrink-0">
                        {(member.name || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-primary hover:underline block truncate">
                          {member.name}
                        </p>
                        {member.title && <p className="text-[10px] text-muted-foreground truncate">{member.title}</p>}
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </Section>

            {/* Projects */}
            {projects.length > 0 && (
              <Section title="Projects" badge={openProjects.length} defaultOpen={true}>
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
                          {price != null && <span className="text-[11px] font-bold text-foreground ml-auto">{fmtMoney(price)}</span>}
                        </div>
                        {(proj.shoot_date || proj.delivery_date) && (
                          <div className="flex items-center gap-1 mt-1 text-[10px] text-muted-foreground">
                            <Calendar className="h-2.5 w-2.5 shrink-0" />
                            {proj.shoot_date && <span>{fmtDate(proj.shoot_date, 'd MMM yy')}</span>}
                            {proj.shoot_date && proj.delivery_date && <span>→</span>}
                            {proj.delivery_date && <span>{fmtDate(proj.delivery_date, 'd MMM yy')}</span>}
                          </div>
                        )}
                        <PipelineBar status={proj.status} />
                      </div>
                    );
                  })}
                </div>
                </Section>
                )}

                {/* Analytics */}
                {projects.length > 0 && (
                <div className="border-t pt-2">
                <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide px-4 py-2">Analytics</div>
                <SharedDashboard
                 projects={projects}
                 revisions={revisions}
                 projectTasks={projectTasks}
                 taskTimeLogs={taskTimeLogs}
                 entityLabel={team?.name || 'Team'}
                />
                </div>
                )}

                {/* Delete Team */}
                <div className="border-t border-border/50 px-4 py-3">
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="text-xs text-destructive hover:text-destructive/80 hover:underline transition-colors flex items-center gap-1.5"
                  >
                    <Trash2 className="h-3 w-3" />
                    Delete Team
                  </button>
                </div>
                </div>

        {/* ── Right main area ──────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden bg-background flex flex-col">
          {/* Pipedrive-style tab bar */}
          <div className="flex items-center gap-0 border-b px-4 shrink-0">
            {TABS.map(tab => (
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
                {tab.id === 'notes' && rootNoteCount > 0 && (
                  <span className="bg-primary/10 text-primary text-[10px] font-bold min-w-[18px] h-[18px] rounded-full flex items-center justify-center px-1">
                    {rootNoteCount}
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
                    agencyId={team?.agency_id}
                    teamId={teamId}
                    contextLabel={team?.name}
                    contextType="team"
                    relatedProjectIds={projects.map(p => p.id)}
                  />
                </div>

                {/* History — unified activity feed with built-in filters */}
                <div className="flex-1 overflow-y-auto">
                  <ContactActivityLog
                    entityType="team"
                    entityId={teamId}
                    entityLabel={team?.name}
                    emailActivities={emailActivities}
                    showChangelog
                  />
                </div>
              </div>
            )}

            {/* ── Email tab ──────────────────────────────────────── */}
            {activeTab === 'email' && (
              <div className="h-full overflow-hidden">
                <EntityEmailTab
                  entityType="team"
                  entityId={teamId}
                  entityLabel={team?.name}
                  onEmailActivity={handleEmailActivity}
                  teamMemberIds={members.map(m => m.id)}
                />
              </div>
            )}

            {/* ── Files tab ──────────────────────────────────────── */}
            {activeTab === 'files' && (
              <div className="h-full overflow-hidden">
                <ContactFiles
                  entityType="team"
                  entityId={teamId}
                  entityLabel={team?.name}
                />
              </div>
            )}

            {/* ── Members tab ────────────────────────────────────── */}
            {activeTab === 'members' && (
              <div className="h-full overflow-y-auto p-6">
                <div className="max-w-3xl">
                  <h2 className="text-lg font-semibold mb-4">Team Members</h2>
                  {members.length === 0 ? (
                    <div className="bg-muted rounded-lg p-6 text-center">
                      <p className="text-sm text-muted-foreground">No members assigned to this team</p>
                    </div>
                  ) : (
                    <div className="space-y-6">
                      {Object.entries(membersByState).map(([state, stateMembers]) =>
                        stateMembers.length > 0 ? (
                          <div key={state}>
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                              {state}
                            </h3>
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {stateMembers.map(member => (
                                <MemberCard key={member.id} member={member} />
                              ))}
                            </div>
                          </div>
                        ) : null
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* ── Activities/Calendar tab ─────────────────────────── */}
            {activeTab === 'activities' && (
              <div className="h-full overflow-hidden">
                <EntityActivitiesTab
                  entityType="team"
                  entityId={teamId}
                  entityLabel={team?.name || 'Team'}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete team?"
        description="This will permanently delete this team and cannot be undone."
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
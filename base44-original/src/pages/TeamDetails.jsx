import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { useNavigate, Link } from 'react-router-dom';
import { useSmartEntityData } from '@/components/hooks/useSmartEntityData';
import { useEntityList } from '@/components/hooks/useEntityData';
import { base44 } from '@/api/base44Client';
import SharedDashboard from '@/components/analytics/SharedDashboard';
import { createPageUrl } from '@/utils';
import { fmtDate, fmtTimestampCustom, fixTimestamp, formatRelative } from '@/components/utils/dateUtils';
import {
  ArrowLeft, ChevronDown, ChevronRight, Mail, Phone, Building2,
  MessageSquare, Activity, Info, AlertCircle, Plus, Trash2, Calendar, User, Copy, Check
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import UnifiedNotesPanel from '@/components/notes/UnifiedNotesPanel';
import InteractionLogPanel from '@/components/prospecting/InteractionLogPanel';
import TeamDetailsTab from '@/components/agencies/TeamDetailsTab';
import ProjectStatusBadge from '@/components/dashboard/ProjectStatusBadge';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import EntityEmailTab from '@/components/email/EntityEmailTab';
import EmailActivityLog from '@/components/email/EmailActivityLog';

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

function CopyableInfoRow({ label, value, href, Icon, copyValue }) {
  const [copied, setCopied] = React.useState(false);
  if (!value) return null;

  const handleCopy = (e) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(copyValue || value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="flex items-start gap-2 text-xs group">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
      <div className="min-w-0 flex-1">
        <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-0.5">{label}</p>
        <div className="flex items-center gap-1">
          {href ? (
            <a href={href} target="_blank" rel="noopener noreferrer"
              className="text-primary hover:underline flex items-center gap-1 font-medium truncate transition-colors"
              title={value}>
              {value}
            </a>
          ) : (
            <p className="font-medium truncate text-foreground flex-1" title={value}>{value}</p>
          )}
          <button
            onClick={handleCopy}
            className="opacity-0 group-hover:opacity-100 transition-opacity ml-auto shrink-0 p-1 rounded hover:bg-muted active:scale-95"
            title={`Copy ${label}`}
            aria-label={`Copy ${label}`}
          >
            {copied
              ? <Check className="h-3 w-3 text-green-600" />
              : <Copy className="h-3 w-3 text-muted-foreground" />
            }
          </button>
        </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value, href, Icon }) {
  return <CopyableInfoRow label={label} value={value} href={href} Icon={Icon} />;
}

function ErrorState({ navigate, title, message }) {
  return (
    <div className="p-8">
      <Button variant="ghost" className="gap-2 mb-4" onClick={() => navigate(-1)}>
        <ArrowLeft className="h-4 w-4" /> Back
      </Button>
      <div className="bg-red-50 border border-red-200 rounded-xl p-6 flex gap-3">
        <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
        <div>
          <h3 className="font-semibold text-red-900">{title}</h3>
          <p className="text-red-800 text-sm mt-1">{message}</p>
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

function PipelineBar({ status }) {
  const currentIdx = STAGES.findIndex(s => s.key === status);
  return (
    <div className="flex gap-0.5 mt-2">
      {STAGES.map((stage, i) => (
        <div
          key={stage.key}
          className={`h-1.5 flex-1 rounded-sm transition-colors ${i <= currentIdx ? stage.color : 'bg-gray-100'}`}
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
                  Status changed to <span className="font-medium capitalize">{proj.status.replace(/_/g, ' ')}</span>
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
            <Badge className={`text-[10px] border ${STATE_BADGE[member.relationship_state] || 'bg-gray-100 text-gray-700'}`}>
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
  const tabsRef = useRef(null);

  // Remember last selected tab
  const [activeTab, setActiveTab] = useState(() => {
    const saved = sessionStorage.getItem(`tab-team-${teamId}`);
    return saved || 'notes';
  });
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

  const memberFilter = useCallback(a => a.current_team_id === teamId, [teamId]);
  const projectFilter = useCallback(
    p =>
      p.project_owner_id === teamId ||
      p.onsite_staff_1_id === teamId ||
      p.onsite_staff_2_id === teamId ||
      p.image_editor_id === teamId ||
      p.video_editor_id === teamId ||
      p.floorplan_editor_id === teamId ||
      p.drone_editor_id === teamId,
    [teamId]
  );
  const noteFilter = useCallback(e => e.team_id === teamId, [teamId]);
  const interactionFilter = useCallback(e => e.entity_type === 'Team' && e.entity_id === teamId, [teamId]);

  const { data: members = [] } = useEntityList('Agent', 'name', null, memberFilter);
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
      await base44.entities.Team.delete(teamId);
      navigate(createPageUrl('Teams'));
    } catch {
      // error handled by UI
    }
  };

  if (!teamId) {
    window.location.href = createPageUrl('Teams');
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
          <div className="w-80 shrink-0 border-r bg-card p-4 space-y-4">
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
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2.5 border-b bg-card shrink-0 shadow-sm z-10">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="w-px h-5 bg-border shrink-0" />

        <div className="h-9 w-9 rounded-lg bg-primary flex items-center justify-center shrink-0 shadow-sm">
          <span className="text-sm font-bold text-primary-foreground leading-none">
            {(team.name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase()}
          </span>
        </div>

        <div className="min-w-0">
          <h1 className="text-sm font-bold truncate leading-tight">{team.name}</h1>
          {agency && (
            <Link
              to={createPageUrl(`OrgDetails?id=${agency.id}`)}
              className="text-[11px] text-primary hover:underline truncate leading-tight block"
            >
              {agency.name}
            </Link>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 shrink-0">
          {/* Stat pills */}
          <div className="flex items-center gap-1.5 px-1">
            <span className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-[11px] font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-muted/80">
              <span className="font-bold text-foreground">{members.length}</span> members
            </span>
            <span className="inline-flex items-center gap-1 bg-muted text-muted-foreground text-[11px] font-medium px-2.5 py-1 rounded-full transition-all duration-200 hover:bg-muted/80">
              <span className="font-bold text-foreground">{projects.length}</span> projects
            </span>
            {totalRev > 0 && (
              <span className="inline-flex items-center gap-1 bg-green-50 text-green-700 text-[11px] font-semibold px-2 py-0.5 rounded-full border border-green-100">
                ${totalRev >= 1000000 ? `${(totalRev / 1000000).toFixed(1)}M` : totalRev >= 1000 ? `${(totalRev / 1000).toFixed(0)}k` : Math.round(totalRev)}
              </span>
            )}
          </div>
          {(() => {
            const recentActivity = [...interactions, ...projects, ...orgNotes].reduce((latest, item) => {
              const raw = item.created_date || item.date_time || item.last_status_change;
              const date = raw ? new Date(fixTimestamp(raw)) : new Date(0);
              return date > latest ? date : latest;
            }, new Date(0));
            if (recentActivity.getTime() === 0) return null;
            const now = new Date();
            const hoursAgo = Math.floor((now - recentActivity) / (1000 * 60 * 60));
            const daysAgo = Math.floor(hoursAgo / 24);
            let timeStr = 'just now';
            if (hoursAgo > 0) timeStr = `${hoursAgo}h ago`;
            if (daysAgo > 0) timeStr = `${daysAgo}d ago`;
            return (
              <span className="text-[11px] text-muted-foreground hidden sm:inline cursor-help" title={`Last activity: ${recentActivity.toLocaleString()}`}>
                · {timeStr}
              </span>
            );
          })()}
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden min-h-0">
        {/* Left sidebar */}
        <div className="w-80 shrink-0 border-r overflow-y-auto bg-card">
          <div className="space-y-0">
          {/* Quick Actions */}
          <div className="flex gap-2 p-3 border-b">
            <Button
              size="sm"
              className="flex-1 gap-1.5 h-8 text-xs font-semibold shadow-sm transition-all duration-200 hover:shadow-md active:scale-95"
              title="Create new project (Cmd+Shift+P)"
              onClick={() => navigate(createPageUrl('Projects') + `?team=${teamId}`)}
            >
              <Plus className="h-3.5 w-3.5" />
              New Project
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 gap-1.5 h-8 text-xs transition-all duration-200 hover:bg-muted active:scale-95"
              title="Add a note (Cmd+Shift+N)"
              onClick={() => {
                setActiveTab('notes');
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

            {/* Team Info */}
            <Section title="Team Info" badge={0} defaultOpen>
              <div className="space-y-3">
                {agency && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                      <Building2 className="h-3 w-3" /> Agency
                    </p>
                    <Link
                      to={createPageUrl(`OrgDetails?id=${agency.id}`)}
                      className="text-xs text-primary hover:underline"
                    >
                      {agency.name}
                    </Link>
                  </div>
                )}

                <InfoRow label="Email" value={team.email} href={team.email ? `mailto:${team.email}` : null} Icon={Mail} />
                <InfoRow label="Phone" value={team.phone} href={team.phone ? `tel:${team.phone}` : null} Icon={Phone} />

                {team.notes && (
                  <div>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">Notes</p>
                    <p className="text-xs text-muted-foreground leading-relaxed">{team.notes}</p>
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
                          {price && <span className="text-[11px] font-bold text-foreground ml-auto">{fmtMoney(price)}</span>}
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
                </div>
                </div>

                {/* Right tabs */}
        <div ref={tabsRef} className="flex-1 overflow-hidden bg-background">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="h-full flex flex-col">
            <TabsList className="grid w-full shrink-0 rounded-none border-b bg-background h-10" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' }}>
              <TabsTrigger value="notes" className="text-xs rounded-none gap-1 relative">
                Notes
                {orgNotes.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold min-w-[14px] h-[14px] rounded-full flex items-center justify-center px-0.5">
                    {orgNotes.length}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="emails" className="text-xs rounded-none gap-1">Emails</TabsTrigger>
              <TabsTrigger value="activity" className="text-xs rounded-none gap-1">Activity</TabsTrigger>
              <TabsTrigger value="details" className="text-xs rounded-none gap-1">Details</TabsTrigger>
              <TabsTrigger value="members" className="text-xs rounded-none gap-1">Members</TabsTrigger>
              <TabsTrigger value="interactions" className="text-xs rounded-none gap-1 relative">
                Interactions
                {interactions.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-primary text-primary-foreground text-[9px] font-bold min-w-[14px] h-[14px] rounded-full flex items-center justify-center px-0.5">
                    {interactions.length}
                  </span>
                )}
              </TabsTrigger>
            </TabsList>

            <div className="flex-1 overflow-hidden">
              <TabsContent value="notes" className="h-full overflow-hidden m-0 border-0">
                <UnifiedNotesPanel
                  teamId={teamId}
                  contextLabel={team?.name}
                  contextType="team"
                  relatedProjectIds={projects.map(p => p.id)}
                />
              </TabsContent>

              <TabsContent value="emails" className="h-full overflow-hidden m-0 border-0">
                <EntityEmailTab
                  entityType="team"
                  entityId={teamId}
                  entityLabel={team?.name}
                  onEmailActivity={handleEmailActivity}
                />
              </TabsContent>

              <TabsContent value="activity" className="h-full overflow-y-auto m-0 border-0 p-6">
                <div className="max-w-3xl space-y-6">
                  {emailActivities.length > 0 && (
                    <div>
                      <h3 className="text-sm font-semibold mb-3">Email Activity</h3>
                      <EmailActivityLog
                        emailActivities={emailActivities}
                        entityLabel={team?.name}
                      />
                    </div>
                  )}
                  <div>
                    <h3 className="text-sm font-semibold mb-3">All Activity</h3>
                    <ActivityFeed interactions={interactions} projects={projects} />
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="details" className="h-full overflow-y-auto m-0 border-0 p-6">
                <div className="space-y-6 max-w-3xl">
                  <TeamDetailsTab team={team} />

                  {/* Delete zone */}
                  <div className="border-t border-destructive/20 bg-destructive/5 rounded-lg p-4 mt-6">
                    <h3 className="text-sm font-semibold text-destructive mb-2 flex items-center gap-2">
                      <AlertCircle className="h-4 w-4" />
                      Delete Team
                    </h3>
                    <p className="text-xs text-muted-foreground mb-4">
                      This action is permanent and cannot be undone. All associated data will be removed.
                    </p>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setShowDeleteConfirm(true)}
                      className="transition-all duration-200 hover:shadow-md active:scale-95"
                    >
                      <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                      Delete Team
                    </Button>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="members" className="h-full overflow-y-auto m-0 border-0 p-6">
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
              </TabsContent>

              <TabsContent value="interactions" className="h-full overflow-hidden m-0 border-0">
                <InteractionLogPanel
                  prospect={team}
                  interactions={interactions}
                  entityType="Team"
                />
              </TabsContent>
            </div>
          </Tabs>
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
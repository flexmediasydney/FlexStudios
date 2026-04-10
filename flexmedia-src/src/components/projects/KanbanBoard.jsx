import React, { useState, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { retryWithBackoff } from "@/lib/networkResilience";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { toast } from "sonner";
import { scheduleDeadlineSync } from "@/components/projects/taskDeadlineSync";
import { PROJECT_STAGES } from "./projectStatuses";
import { ProjectCardFields } from "./ProjectCardFields";
import { useCardFields } from "./useCardFields";
import {
  DollarSign, CheckCircle2, Clock, AlertCircle, Mail, Calendar,
  Filter, X, ChevronDown, ChevronRight, Columns3, LayoutList, Camera, Building, CalendarRange
} from "lucide-react";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { usePrefetchProjectDetails } from "@/components/lib/prefetchRoutes";

const statusColumns = PROJECT_STAGES.map(s => ({ id: s.value, label: s.label, color: s.color }));

/* ─────────────────────────── CSS-in-JS animation styles ─────────────────────────── */
const animationStyles = `
  @keyframes kanban-card-enter {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes kanban-shimmer {
    0%   { background-position: -200% 0; }
    100% { background-position: 200% 0; }
  }
  .kanban-card-animated {
    animation: kanban-card-enter 0.25s ease-out both;
  }
  .kanban-drop-target {
    transition: background-color 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
  }
  .kanban-dragging {
    transition: box-shadow 0.15s ease, transform 0.15s ease;
    box-shadow: 0 20px 40px rgba(0,0,0,0.15), 0 0 0 3px rgba(59,130,246,0.4);
    transform: rotate(2deg) scale(1.04);
  }
  .urgency-border-overdue  { border-left: 4px solid #ef4444; }
  .urgency-border-today    { border-left: 4px solid #f97316; }
  .urgency-border-ontrack  { border-left: 4px solid #22c55e; }
  .urgency-border-none     { border-left: 4px solid transparent; }
`;

/* ─────────────────────────── Urgency helpers ─────────────────────────── */
function getProjectUrgency(project, projectTasks) {
  // Bug fix: use date-string comparison (YYYY-MM-DD) to avoid UTC-vs-local
  // timezone mismatch when parsing date-only strings like "2026-03-25"
  const todayStr = new Date().toLocaleDateString('en-CA'); // "YYYY-MM-DD"

  // Check project-level dates (slice to handle full ISO timestamps too)
  const shootStr = project.shoot_date ? project.shoot_date.slice(0, 10) : null;
  const deliveryStr = project.delivery_date ? project.delivery_date.slice(0, 10) : null;

  // Bug fix: exclude deleted tasks — the caller passes all tasks from the
  // pre-computed map which does not filter is_deleted
  const hasOverdueTask = projectTasks.some(t => {
    if (t.is_completed || t.is_deleted || !t.due_date) return false;
    return t.due_date.slice(0, 10) < todayStr;
  });

  // Check if project shoot date is past and project not delivered
  const shootOverdue = shootStr && shootStr < todayStr &&
    !['delivered', 'in_revision', 'cancelled'].includes(project.status);

  // Check delivery date overdue
  const deliveryOverdue = deliveryStr && deliveryStr < todayStr &&
    !['delivered', 'cancelled'].includes(project.status);

  if (hasOverdueTask || shootOverdue || deliveryOverdue) {
    return 'overdue';
  }

  // Check for due-today
  const hasTodayTask = projectTasks.some(t => {
    if (t.is_completed || t.is_deleted || !t.due_date) return false;
    return t.due_date.slice(0, 10) === todayStr;
  });
  const shootToday = shootStr === todayStr;
  const deliveryToday = deliveryStr === todayStr;

  if (hasTodayTask || shootToday || deliveryToday) {
    return 'today';
  }

  return 'ontrack';
}

const urgencyBorderClass = {
  overdue: 'urgency-border-overdue',
  today: 'urgency-border-today',
  ontrack: 'urgency-border-ontrack',
};

/* ─────────────────────────── Mini Progress Bar ─────────────────────────── */
function TaskProgressBar({ tasks }) {
  const regularTasks = tasks.filter(t => !t.parent_task_id && !t.is_deleted && !/^\[Revision #\d+\]/.test(t.title || ""));
  if (regularTasks.length === 0) return null;

  const completed = regularTasks.filter(t => t.is_completed).length;
  const total = regularTasks.length;
  const pct = Math.round((completed / total) * 100);

  const barColor = pct === 100 ? 'bg-green-500' : pct >= 50 ? 'bg-blue-500' : pct > 0 ? 'bg-amber-500' : 'bg-gray-300';

  return (
    <div className="flex items-center gap-1.5 mt-1.5">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} rounded-full transition-all duration-500 ease-out`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-[9px] font-semibold tabular-nums ${
        pct === 100 ? 'text-green-600' : 'text-muted-foreground'
      }`}>
        {pct}%
      </span>
    </div>
  );
}

/* ─────────────────────────── Email indicator ─────────────────────────── */
function ProjectEmailIndicator({ emails = [] }) {
  if (emails.length === 0) return null;

  const unreadCount = emails.filter(e => e.is_unread).length;
  const hasUnread = unreadCount > 0;

  return (
    <HoverCard openDelay={300} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          className={`flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            hasUnread
              ? "bg-purple-100 text-purple-700 hover:bg-purple-200"
              : "bg-muted text-muted-foreground hover:bg-muted/80"
          }`}
          onClick={(e) => e.stopPropagation()}
          title={hasUnread ? `${unreadCount} unread email${unreadCount > 1 ? "s" : ""}` : `${emails.length} linked email${emails.length > 1 ? "s" : ""}`}
        >
          <Mail className={`h-2.5 w-2.5 ${hasUnread ? "text-purple-600" : "text-muted-foreground"}`} />
          <span>{emails.length}</span>
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        className="w-80 p-0 overflow-hidden"
        side="right"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-2 bg-muted/50 border-b flex items-center gap-2">
          <Mail className="h-3.5 w-3.5 text-purple-600" />
          <span className="text-xs font-semibold">Recent Emails</span>
          {hasUnread && (
            <span className="ml-auto text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">
              {unreadCount} unread
            </span>
          )}
        </div>
        <div className="divide-y max-h-56 overflow-y-auto">
          {emails.map(email => (
            <div
              key={email.id}
              className={`px-3 py-2 text-xs ${email.is_unread ? "bg-purple-50/40" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <p className={`truncate flex-1 ${email.is_unread ? "font-semibold text-foreground" : "font-medium text-foreground/80"}`}>
                  {email.subject || "(no subject)"}
                </p>
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {fmtTimestampCustom(email.received_at, { dateStyle: "short" })}
                </span>
              </div>
              <p className="text-muted-foreground truncate mt-0.5">
                {email.from_name || email.from}
              </p>
              {email.body && (
                <p className="text-muted-foreground truncate mt-0.5 line-clamp-1 text-[10px]">
                  {email.body.replace(/<[^>]*>/g, "").trim().substring(0, 80)}
                </p>
              )}
            </div>
          ))}
        </div>
        <div className="px-3 py-2 border-t bg-muted/30 text-[10px] text-muted-foreground text-center">
          Click the card to open project • go to History → Emails
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/* ─────────────────────────── Kanban Filter Bar ─────────────────────────── */
function KanbanFilterBar({ filters, onFiltersChange, projects }) {
  // Derive unique photographers and project types from active projects
  const photographers = useMemo(() => {
    const names = new Set();
    projects.forEach(p => {
      if (p.photographer_name) names.add(p.photographer_name);
      (p.assigned_staff || []).forEach(s => {
        if (s.role === 'photographer' && s.name) names.add(s.name);
      });
    });
    return [...names].sort();
  }, [projects]);

  const projectTypes = useMemo(() => {
    const types = new Set();
    projects.forEach(p => {
      if (p.property_type) types.add(p.property_type);
      if (p.project_type) types.add(p.project_type);
    });
    return [...types].sort();
  }, [projects]);

  const hasAnyFilter = filters.photographer || filters.projectType || filters.dateFrom || filters.dateTo;

  return (
    <div className="flex items-center gap-2 flex-wrap mb-3">
      <Filter className="h-4 w-4 text-muted-foreground" />

      {/* Photographer filter */}
      {photographers.length > 0 && (
        <Select
          value={filters.photographer || "__all__"}
          onValueChange={(v) => onFiltersChange({ ...filters, photographer: v === "__all__" ? "" : v })}
        >
          <SelectTrigger className="w-44 h-8 text-xs">
            <Camera className="h-3 w-3 mr-1 text-muted-foreground" />
            <SelectValue placeholder="All photographers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Photographers</SelectItem>
            {photographers.map(name => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Project type filter */}
      {projectTypes.length > 0 && (
        <Select
          value={filters.projectType || "__all__"}
          onValueChange={(v) => onFiltersChange({ ...filters, projectType: v === "__all__" ? "" : v })}
        >
          <SelectTrigger className="w-44 h-8 text-xs">
            <Building className="h-3 w-3 mr-1 text-muted-foreground" />
            <SelectValue placeholder="All types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All Types</SelectItem>
            {projectTypes.map(type => (
              <SelectItem key={type} value={type}>
                {type.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase())}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Date range: From */}
      <div className="flex items-center gap-1">
        <CalendarRange className="h-3 w-3 text-muted-foreground" />
        <Input
          type="date"
          value={filters.dateFrom || ""}
          onChange={(e) => onFiltersChange({ ...filters, dateFrom: e.target.value })}
          className="h-8 w-36 text-xs"
          placeholder="From"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          value={filters.dateTo || ""}
          onChange={(e) => onFiltersChange({ ...filters, dateTo: e.target.value })}
          className="h-8 w-36 text-xs"
          placeholder="To"
        />
      </div>

      {/* Clear filters */}
      {hasAnyFilter && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs gap-1"
          onClick={() => onFiltersChange({ photographer: "", projectType: "", dateFrom: "", dateTo: "" })}
        >
          <X className="h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  );
}

/* ─────────────────────────── Collapsed Column View ─────────────────────────── */
function CollapsedColumnView({ columns, activeProjects, allTasks }) {
  const navigate = useNavigate();

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {columns.map(column => {
        const colProjects = activeProjects.filter(p => p.status === column.id);
        // Bug fix: also exclude revision tasks (matching TaskProgressBar's filter)
        // so the collapsed overview progress bar is consistent with card-level bars.
        const colTasks = allTasks.filter(t =>
          colProjects.some(p => p.id === t.project_id) && !t.parent_task_id && !t.is_deleted
          && !/^\[Revision #\d+\]/.test(t.title || "")
        );
        const tasksDone = colTasks.filter(t => t.is_completed).length;
        const tasksTotal = colTasks.length;
        const revenue = colProjects.reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);

        const todayStr = new Date().toLocaleDateString('en-CA');
        const overdue = colProjects.filter(p => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          const sd = p.shoot_date ? p.shoot_date.slice(0, 10) : null;
          // Bug fix: use string comparison to avoid UTC-vs-local mismatch
          return sd && sd < todayStr;
        }).length;

        return (
          <div
            key={column.id}
            className={`${column.color} rounded-lg p-4 space-y-3 border border-border/30 hover:shadow-md transition-shadow cursor-default`}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-sm truncate">{column.label}</h3>
              <span className={`text-lg font-bold tabular-nums ${
                colProjects.length > 10 ? 'text-red-600' :
                colProjects.length > 6  ? 'text-amber-600' : ''
              }`}>
                {colProjects.length}
              </span>
            </div>

            {/* Mini stats */}
            <div className="space-y-1.5 text-xs text-muted-foreground">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" /> Revenue</span>
                <span className="font-medium text-foreground">
                  {revenue >= 1000 ? `$${(revenue / 1000).toFixed(1)}k` : `$${revenue.toFixed(0)}`}
                </span>
              </div>
              {tasksTotal > 0 && (
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Tasks</span>
                  <span className="font-medium text-foreground">{tasksDone}/{tasksTotal}</span>
                </div>
              )}
              {overdue > 0 && (
                <div className="flex items-center justify-between text-red-600">
                  <span className="flex items-center gap-1"><AlertCircle className="h-3 w-3" /> Overdue</span>
                  <span className="font-bold">{overdue}</span>
                </div>
              )}
            </div>

            {/* Task progress bar */}
            {tasksTotal > 0 && (
              <div className="h-1.5 bg-card/50 rounded-full overflow-hidden">
                <div
                  className="h-full bg-green-500 rounded-full transition-all duration-500"
                  style={{ width: `${(tasksDone / tasksTotal) * 100}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════ Main KanbanBoard ═══════════════════════════ */
export default function KanbanBoard({ projects = [], products, packages, fitToScreen = false, allTasks: parentTasks, allTimeLogs: parentTimeLogs }) {
  const navigate = useNavigate();
  const { enabledFields } = useCardFields();
  // Bug fix: use tasks/timeLogs from parent when available to avoid duplicate entity subscriptions
  const { data: fallbackTasks = [] } = useEntityList(!parentTasks ? "ProjectTask" : null, "-due_date", 500);
  const { data: fallbackTimeLogs = [] } = useEntityList(!parentTimeLogs ? "TaskTimeLog" : null);
  const allTasks = parentTasks || fallbackTasks;
  const allTimeLogs = parentTimeLogs || fallbackTimeLogs;
  const { prefetch: prefetchProject } = usePrefetchProjectDetails();

  // Stable callbacks for card interactions — avoids creating new function refs
  // on every render for potentially hundreds of project cards.
  const handleCardClick = useCallback((projectId) => {
    navigate(createPageUrl("ProjectDetails") + "?id=" + projectId);
  }, [navigate]);

  const handleCardHover = useCallback((projectId) => {
    prefetchProject(projectId);
  }, [prefetchProject]);

  // Filter out archived projects (memoized to avoid recomputing on every render)
  const activeProjects = useMemo(() => projects.filter(p => !p.is_archived), [projects]);

  // ── View mode: 'full' (normal kanban) or 'collapsed' (counts overview) ──
  const [viewMode, setViewMode] = useState(() => {
    try { const v = localStorage.getItem('kanban_view_mode'); if (v === 'full' || v === 'collapsed') return v; } catch {}
    return 'full';
  });
  // Persist kanban sub-view to localStorage
  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem('kanban_view_mode', mode); } catch {}
  }, []);

  // ── Kanban-specific filters ──
  const [kanbanFilters, setKanbanFilters] = useState({
    photographer: "",
    projectType: "",
    dateFrom: "",
    dateTo: "",
  });

  // Apply kanban filters
  const filteredProjects = useMemo(() => {
    let result = activeProjects;

    if (kanbanFilters.photographer) {
      result = result.filter(p => {
        if (p.photographer_name === kanbanFilters.photographer) return true;
        if ((p.assigned_staff || []).some(s => s.role === 'photographer' && s.name === kanbanFilters.photographer)) return true;
        return false;
      });
    }

    if (kanbanFilters.projectType) {
      result = result.filter(p =>
        p.property_type === kanbanFilters.projectType ||
        p.project_type === kanbanFilters.projectType
      );
    }

    if (kanbanFilters.dateFrom) {
      const from = new Date(kanbanFilters.dateFrom);
      from.setHours(0, 0, 0, 0);
      result = result.filter(p => {
        const sd = p.shoot_date ? new Date(p.shoot_date) : null;
        return sd && sd >= from;
      });
    }

    if (kanbanFilters.dateTo) {
      const to = new Date(kanbanFilters.dateTo);
      to.setHours(23, 59, 59, 999);
      result = result.filter(p => {
        const sd = p.shoot_date ? new Date(p.shoot_date) : null;
        return sd && sd <= to;
      });
    }

    return result;
  }, [activeProjects, kanbanFilters]);

  // Batch fetch all shared emails for all visible projects in one query.
  const projectIds = filteredProjects.map(p => p.id);
  const { data: allProjectEmails = [] } = useEntityList(
    "EmailMessage",
    "-received_at",
    2000,
    (e) => e.visibility === "shared" && !e.is_deleted && projectIds.includes(e.project_id)
  );

  // Bug fix: pre-compute email map to avoid O(projects * emails) filtering per card render
  const emailsByProject = useMemo(() => {
    const map = {};
    allProjectEmails.forEach(e => {
      if (!map[e.project_id]) map[e.project_id] = [];
      map[e.project_id].push(e);
    });
    return map;
  }, [allProjectEmails]);

  // Bug fix: pre-compute task map to avoid O(projects * tasks) filtering per card render
  const tasksByProject = useMemo(() => {
    const map = {};
    allTasks.forEach(t => {
      if (!t.parent_task_id) {
        if (!map[t.project_id]) map[t.project_id] = [];
        map[t.project_id].push(t);
      }
    });
    return map;
  }, [allTasks]);

  // Bug fix: pre-compute time logs map
  const timeLogsByProject = useMemo(() => {
    const map = {};
    allTimeLogs.forEach(l => {
      if (!map[l.project_id]) map[l.project_id] = [];
      map[l.project_id].push(l);
    });
    return map;
  }, [allTimeLogs]);

  const updateStatusMutation = useMutation({
    mutationFn: async ({ projectId, newStatus, project }) => {
      const user = await api.auth.me();
      const oldStatus = project.status;

      const updateData = {
        status: newStatus,
        last_status_change: new Date().toISOString(),
      };
      if (newStatus === 'onsite' && !project.shooting_started_at) {
        updateData.shooting_started_at = new Date().toISOString();
      }

      await retryWithBackoff(() => api.entities.Project.update(projectId, updateData), {
        maxRetries: 2,
        onRetry: (err, attempt) => console.warn(`Kanban status update retry ${attempt}:`, err.message),
      });

      api.entities.ProjectActivity.create({
        project_id: projectId,
        project_title: project.title,
        action: 'status_change',
        description: `Status changed from ${oldStatus} to ${newStatus}`,
        changed_fields: [{ field: 'status', old_value: oldStatus, new_value: newStatus }],
        previous_state: project,
        new_state: { ...project, ...updateData },
        user_name: user.full_name,
        user_email: user.email,
      }).catch(err => console.warn('Activity log failed:', err?.message));

      api.functions.invoke('trackProjectStageChange', {
        projectId,
        old_data: { status: oldStatus },
        data: { ...project, status: newStatus },
      }).catch(err => console.warn('trackProjectStageChange failed:', err?.message));

      const triggerMap = {
        'onsite':    'project_onsite',
        'uploaded':  'project_uploaded',
        'submitted': 'project_submitted',
      };
      if (triggerMap[newStatus]) {
        scheduleDeadlineSync(projectId, triggerMap[newStatus], 500);
      }

      const UPLOADED_OR_LATER = ['uploaded', 'submitted', 'in_progress', 'in_production', 'ready_for_partial', 'in_revision', 'delivered'];
      const PRE_UPLOAD = ['to_be_scheduled', 'scheduled', 'onsite', 'pending_review'];
      if (UPLOADED_OR_LATER.includes(newStatus) && PRE_UPLOAD.includes(oldStatus)) {
        api.functions.invoke('logOnsiteEffortOnUpload', {
          project_id: projectId,
          old_status: oldStatus,
        }).catch(err => console.warn('logOnsiteEffortOnUpload failed:', err?.message));
      }
    },
    onSuccess: () => {
      toast.success('Project status updated');
      // Bug fix: invalidate project cache so the parent list and kanban reflect the new status
      refetchEntityList('Project');
    },
    onError: (err) => toast.error(err?.message || "Failed to update project status"),
  });

  const [pendingDrag, setPendingDrag] = useState(null);
  const [draggingId, setDraggingId] = useState(null);

  const onDragEnd = (result) => {
    setDraggingId(null);
    if (!result.destination) return;
    // Race condition fix: block drag while a status update is already in flight
    if (updateStatusMutation.isPending) return;
    const projectId = result.draggableId;
    const newStatus = result.destination.droppableId;
    const project = filteredProjects.find(p => p.id === projectId);
    if (!project || project.status === newStatus) return;

    const stages = PROJECT_STAGES.map(s => s.value);
    const currentIdx = stages.indexOf(project.status);
    const newIdx = stages.indexOf(newStatus);

    if (project.status === 'pending_review') {
      toast.error('Projects in Pending Review must be approved or rejected from the project detail page.');
      return;
    }
    if (newStatus === 'pending_review') {
      toast.error('Projects cannot be manually moved to Pending Review.');
      return;
    }
    if (newStatus === 'in_revision') {
      toast.error('In Revision is managed automatically by the revision system.');
      return;
    }
    if (project.status === 'delivered') {
      toast.error('Delivered projects cannot be moved. Use the Reopen flow from the project detail page.');
      return;
    }

    if (newIdx < currentIdx) {
      setPendingDrag({ projectId, newStatus, project });
      return;
    }

    updateStatusMutation.mutate({ projectId, newStatus, project });
  };

  const onDragStart = (start) => {
    setDraggingId(start.draggableId);
  };

  const confirmBackwardDrag = () => {
    if (pendingDrag) {
      updateStatusMutation.mutate(pendingDrag);
      setPendingDrag(null);
    }
  };

  return (
    <>
      {/* Inject animation styles */}
      <style>{animationStyles}</style>

      {/* ── Toolbar: view toggle + filters ── */}
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <Button
            variant={viewMode === 'full' ? 'default' : 'outline'}
            size="sm"
            className="gap-1.5 h-8 text-xs"
            onClick={() => setViewModePersisted('full')}
          >
            <Columns3 className="h-3.5 w-3.5" />
            Board
          </Button>
          <Button
            variant={viewMode === 'collapsed' ? 'default' : 'outline'}
            size="sm"
            className="gap-1.5 h-8 text-xs"
            onClick={() => setViewModePersisted('collapsed')}
          >
            <LayoutList className="h-3.5 w-3.5" />
            Overview
          </Button>
        </div>

        {/* Active filter count summary */}
        {(kanbanFilters.photographer || kanbanFilters.projectType || kanbanFilters.dateFrom || kanbanFilters.dateTo) && (
          <Badge variant="secondary" className="text-xs">
            <Filter className="h-3 w-3 mr-1" />
            {filteredProjects.length} of {activeProjects.length} projects
          </Badge>
        )}
      </div>

      {/* ── Filter bar ── */}
      <KanbanFilterBar
        filters={kanbanFilters}
        onFiltersChange={setKanbanFilters}
        projects={activeProjects}
      />

      {/* ── Collapsed view ── */}
      {viewMode === 'collapsed' && (
        <CollapsedColumnView
          columns={statusColumns}
          activeProjects={filteredProjects}
          allTasks={allTasks}
        />
      )}

      {/* ── Full kanban view ── */}
      {viewMode === 'full' && (
        <DragDropContext onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div
            className={`flex gap-2 pb-[max(0.5rem,env(safe-area-inset-bottom,0.5rem))] ${fitToScreen ? "overflow-x-hidden" : "overflow-x-auto scroll-smooth"}`}
            style={{ scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch', scrollSnapType: 'x proximity' }}
            onMouseDown={(e) => {
              // Grab-to-scroll: hold and drag horizontally
              const el = e.currentTarget;
              if (e.target.closest('button, a, input, [draggable]')) return;
              let startX = e.pageX, scrollLeft = el.scrollLeft, isDragging = false;
              const onMove = (ev) => { isDragging = true; el.scrollLeft = scrollLeft - (ev.pageX - startX); };
              const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); if (isDragging) el.style.cursor = ''; };
              document.addEventListener('mousemove', onMove);
              document.addEventListener('mouseup', onUp);
              el.style.cursor = 'grabbing';
            }}
          >
            {statusColumns.map(column => {
              const columnProjects = filteredProjects.filter(p => p.status === column.id);

              // Calculate column metrics
              const columnRevenue = columnProjects.reduce((sum, p) => sum + (p.calculated_price || p.price || 0), 0);
              // Bug fix: use pre-computed tasksByProject map instead of O(projects*tasks) filter
              const columnTasks = columnProjects.flatMap(p => (tasksByProject[p.id] || []).filter(t => !t.is_deleted));
              // Bug fix: use string comparison (YYYY-MM-DD) to avoid UTC-vs-local timezone
              // mismatch — new Date("2026-03-25") parses as midnight UTC which is previous
              // day in AEST, causing off-by-one overdue counts vs card-level indicators.
              const todayStr = new Date().toLocaleDateString('en-CA'); // "YYYY-MM-DD"
              const tasksDone = columnTasks.filter(t => t.is_completed).length;
              const tasksInProgress = columnTasks.filter(t => !t.is_completed && !t.is_blocked).length;
              const tasksOverdue = columnTasks.filter(t => {
                if (t.is_completed || !t.due_date) return false;
                return t.due_date.slice(0, 10) < todayStr;
              }).length;

              return (
                <div key={column.id} className={fitToScreen ? "flex-1 min-w-0" : "flex-shrink-0 w-72"} style={{ scrollSnapAlign: 'start' }}>
                  {/* Column Header */}
                  <div className={`${column.color} px-3 py-2.5 rounded-t-md shadow-sm`}>
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="font-semibold text-sm truncate" title={`${column.label} (${columnProjects.length} projects)`}>{column.label}</h3>
                      {/* ── Column count badge (requirement #3) ── */}
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        columnProjects.length > 10
                          ? 'bg-red-100 text-red-700'
                          : columnProjects.length > 6
                          ? 'bg-amber-100 text-amber-700'
                          : 'bg-card/40 text-foreground'
                      }`}>
                        {columnProjects.length}
                      </span>
                    </div>
                    {/* Removed "Last synced" live clock — calling new Date() during
                        render creates a new value every cycle, which can cause
                        unnecessary re-renders and React reconciliation noise. */}

                    {/* Column Metrics */}
                    <div className="grid grid-cols-2 gap-1.5 mt-2">
                      {/* Revenue */}
                      <HoverCard openDelay={200}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1 text-xs bg-card/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-card/40 transition-colors shadow-sm">
                            <DollarSign className="h-3 w-3 flex-shrink-0" />
                            <span className="font-bold tabular-nums">
                              {columnRevenue >= 1000000
                                ? `$${(columnRevenue / 1000000).toFixed(1)}M`
                                : columnRevenue >= 1000
                                ? `$${(columnRevenue / 1000).toFixed(1)}k`
                                : `$${columnRevenue.toFixed(0)}`
                              }
                            </span>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-xs flex items-center gap-1">
                              <DollarSign className="h-3 w-3" />
                              Revenue Breakdown
                            </h4>
                            <div className="max-h-60 overflow-y-auto space-y-1">
                              {columnProjects
                                .filter(p => (p.calculated_price || p.price || 0) > 0)
                                .sort((a, b) => (b.calculated_price || b.price || 0) - (a.calculated_price || a.price || 0))
                                .map(p => (
                                  <button
                                    key={p.id}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(createPageUrl("ProjectDetails") + "?id=" + p.id);
                                    }}
                                    className="flex items-center justify-between text-xs py-1 border-b border-border/50 last:border-0 w-full hover:bg-muted/50 transition-colors rounded px-1"
                                  >
                                    <span className="truncate flex-1 mr-2 text-left" title={p.title}>{p.title}</span>
                                    <span className="font-medium text-green-700">${(p.calculated_price || p.price || 0).toLocaleString()}</span>
                                  </button>
                                ))}
                            </div>
                            <div className="pt-2 border-t flex items-center justify-between font-semibold text-xs">
                              <span>Total</span>
                              <span className="text-green-700">${columnRevenue.toLocaleString()}</span>
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>

                      {/* Tasks Done */}
                      <HoverCard openDelay={200}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1 text-xs bg-card/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-card/40 transition-colors shadow-sm">
                            <CheckCircle2 className="h-3 w-3 text-green-600 flex-shrink-0" />
                            <span className="font-bold tabular-nums">{tasksDone}</span>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-xs flex items-center gap-1 text-green-700">
                              <CheckCircle2 className="h-3 w-3" />
                              Completed Tasks ({tasksDone})
                            </h4>
                            <div className="max-h-60 overflow-y-auto space-y-1">
                              {columnTasks
                                .filter(t => t.is_completed)
                                .map(t => {
                                  const proj = columnProjects.find(p => p.id === t.project_id);
                                  return (
                                    <button
                                      key={t.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                      }}
                                      className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                    >
                                      <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                      <div className="text-muted-foreground text-[10px] truncate" title={proj?.title}>{proj?.title}</div>
                                    </button>
                                  );
                                })}
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>

                      {/* Tasks In Progress */}
                      <HoverCard openDelay={200}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1 text-xs bg-card/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-card/40 transition-colors shadow-sm">
                            <Clock className="h-3 w-3 text-blue-600 flex-shrink-0" />
                            <span className="font-bold tabular-nums">{tasksInProgress}</span>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-xs flex items-center gap-1 text-blue-700">
                              <Clock className="h-3 w-3" />
                              In Progress Tasks ({tasksInProgress})
                            </h4>
                            <div className="max-h-60 overflow-y-auto space-y-1">
                              {columnTasks
                                .filter(t => !t.is_completed && !t.is_blocked)
                                .map(t => {
                                  const proj = columnProjects.find(p => p.id === t.project_id);
                                  return (
                                    <button
                                      key={t.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                      }}
                                      className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                    >
                                      <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                      <div className="text-muted-foreground text-[10px] truncate" title={proj?.title}>{proj?.title}</div>
                                    </button>
                                  );
                                })}
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>

                      {/* Tasks Overdue */}
                      <HoverCard openDelay={200}>
                        <HoverCardTrigger asChild>
                          <div className="flex items-center gap-1 text-xs bg-card/30 backdrop-blur-sm rounded px-2 py-1 cursor-help hover:bg-card/40 transition-colors shadow-sm">
                            <AlertCircle className="h-3 w-3 text-red-600 flex-shrink-0" />
                            <span className="font-bold tabular-nums">{tasksOverdue}</span>
                          </div>
                        </HoverCardTrigger>
                        <HoverCardContent className="w-80 p-3" side="bottom" align="start">
                          <div className="space-y-2">
                            <h4 className="font-semibold text-xs flex items-center gap-1 text-red-700">
                              <AlertCircle className="h-3 w-3" />
                              Overdue Tasks ({tasksOverdue})
                            </h4>
                            <div className="max-h-60 overflow-y-auto space-y-1">
                              {columnTasks
                                .filter(t => {
                                  if (t.is_completed || !t.due_date) return false;
                                  // Bug fix: use string comparison to match the count badge logic
                                  return t.due_date.slice(0, 10) < todayStr;
                                })
                                .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))
                                .map(t => {
                                  const proj = columnProjects.find(p => p.id === t.project_id);
                                  const dueDate = new Date(t.due_date);
                                  return (
                                    <button
                                      key={t.id}
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        navigate(createPageUrl("ProjectDetails") + "?id=" + t.project_id);
                                      }}
                                      className="text-xs py-1 border-b border-border/50 last:border-0 w-full text-left hover:bg-muted/50 transition-colors rounded px-1"
                                    >
                                      <div className="font-medium truncate" title={t.title}>{t.title}</div>
                                      <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-0.5">
                                        <span className="truncate" title={proj?.title}>{proj?.title}</span>
                                        <span className="text-red-600 font-medium ml-2">{dueDate.toLocaleDateString()}</span>
                                      </div>
                                    </button>
                                  );
                                })}
                            </div>
                          </div>
                        </HoverCardContent>
                      </HoverCard>
                    </div>
                  </div>

                  {/* Cards Container */}
                  <Droppable droppableId={column.id}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={`kanban-drop-target min-h-[400px] max-h-[calc(100vh-280px)] overflow-y-auto p-2 space-y-2 ${
                          snapshot.isDraggingOver
                            ? "bg-primary/10 ring-2 ring-primary/20 scale-[1.01]"
                            : "bg-muted/15"
                        } rounded-b-md relative`}
                      >
                        {columnProjects.length === 0 && !snapshot.isDraggingOver && (
                          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground/40 text-xs font-medium pointer-events-none">
                            Drag projects here
                          </div>
                        )}
                        {(() => {
                          const renderCard = (project, index) => {
                          // Bug fix: use pre-computed maps instead of O(n) filter per card
                          const projectTasks = tasksByProject[project.id] || [];
                          const projectTimeLogs = timeLogsByProject[project.id] || [];

                          // Urgency classification
                          const urgency = getProjectUrgency(project, projectTasks);
                          const urgencyClass = urgencyBorderClass[urgency] || 'urgency-border-none';

                          return (
                            <Draggable key={project.id} draggableId={project.id} index={index} isDragDisabled={!!draggingId && draggingId !== project.id}>
                              {(provided, snapshot) => (
                                <Card
                                  ref={provided.innerRef}
                                  {...provided.draggableProps}
                                  {...provided.dragHandleProps}
                                  className={`kanban-card-animated cursor-pointer hover:shadow-lg transition-all duration-200 border-y-0 border-r-0 group/card active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ${urgencyClass} ${
                                    snapshot.isDragging ? "kanban-dragging opacity-90" : ""
                                  }`}
                                  style={{
                                    ...provided.draggableProps.style,
                                    animationDelay: `${index * 30}ms`,
                                  }}
                                  tabIndex={0}
                                  role="button"
                                  aria-label={`${project.title}${project.property_address ? ', ' + project.property_address : ''}`}
                                  onMouseEnter={() => prefetchProject(project.id)}
                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(createPageUrl("ProjectDetails") + "?id=" + project.id); } }}
                                  onClick={() => navigate(createPageUrl("ProjectDetails") + "?id=" + project.id)}
                                >
                                  {/* Card Header */}
                                  <div className="px-3 py-2 border-b border-border/50">
                                    <h4 className="font-semibold truncate text-xs leading-tight group-hover/card:text-primary transition-colors" title={project.title}>{project.title}</h4>
                                    <p className="text-xs text-muted-foreground truncate mt-0.5" title={project.property_address}>{project.property_address}</p>
                                  </div>

                                  {/* Card Content */}
                                  <div className="px-3 pb-2">
                                    <div className="scale-90 origin-top-left">
                                      <ProjectCardFields
                                        project={project}
                                        enabledFields={enabledFields}
                                        products={products}
                                        packages={packages}
                                        tasks={projectTasks}
                                        timeLogs={projectTimeLogs}
                                      />
                                    </div>

                                    {/* ── Mini task progress bar (requirement #5) ── */}
                                    <TaskProgressBar tasks={projectTasks} />

                                    {/* Shoot date with color coding */}
                                    {project.shoot_date && (
                                      <div className={`flex items-center gap-1 text-[10px] mt-1 flex-wrap ${
                                        (() => {
                                          // Bug fix: use string comparison to avoid UTC-vs-local timezone mismatch
                                          const shootStr = project.shoot_date.slice(0, 10);
                                          const todayStr = new Date().toLocaleDateString('en-CA');
                                          const tmrStr = new Date(Date.now() + 86400000).toLocaleDateString('en-CA');
                                          if (shootStr < todayStr) return 'text-red-500 font-semibold';
                                          if (shootStr === todayStr) return 'text-amber-600 font-semibold';
                                          if (shootStr === tmrStr) return 'text-blue-600';
                                          return 'text-muted-foreground';
                                        })()
                                      }`}>
                                        <Calendar className="h-3 w-3" />
                                        {(() => {
                                          // Bug fix: use date-string diff to avoid timezone drift
                                          const shootStr = project.shoot_date.slice(0, 10);
                                          const todayStr = new Date().toLocaleDateString('en-CA');
                                          const d = new Date(project.shoot_date);
                                          const diff = Math.round((new Date(shootStr) - new Date(todayStr)) / 86400000);
                                          if (diff === 0) return 'Today';
                                          if (diff === 1) return 'Tomorrow';
                                          if (diff === -1) return 'Yesterday';
                                          if (diff < 0) return `${Math.abs(diff)}d ago`;
                                          if (diff < 7) return d.toLocaleDateString('en-AU', { weekday: 'short' });
                                          return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
                                        })()}
                                        {project.tonomo_is_twilight && (
                                          <span className="text-purple-500" title="Twilight">🌅</span>
                                        )}
                                      </div>
                                    )}

                                    {/* Pricing tier & overdue chips */}
                                    <div className="flex items-center gap-1 flex-wrap mt-1">
                                      {project.pricing_tier === 'premium' && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-100
                                                         text-amber-700 border border-amber-200 font-medium">
                                          Premium
                                        </span>
                                      )}
                                      {project.shoot_date && (() => {
                                        // Bug fix: use string comparison to avoid UTC-vs-local mismatch
                                        return project.shoot_date.slice(0, 10) < new Date().toLocaleDateString('en-CA');
                                      })() &&
                                       !['delivered', 'in_revision', 'cancelled'].includes(project.status) && (
                                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-100
                                                         text-red-700 border border-red-200 font-medium animate-pulse">
                                          Overdue
                                        </span>
                                      )}
                                    </div>

                                    {/* Email indicator */}
                                    <div className="flex items-center justify-end mt-1.5">
                                      <ProjectEmailIndicator
                                        emails={emailsByProject[project.id] || []}
                                      />
                                    </div>
                                  </div>
                                </Card>
                              )}
                            </Draggable>
                          );
                          };

                          // Twilight lane in scheduled column
                          if (column.id === 'scheduled' && columnProjects.some(p => p.tonomo_is_twilight)) {
                          const dayProjects = columnProjects.filter(p => !p.tonomo_is_twilight);
                          const twilightProjects = columnProjects.filter(p => p.tonomo_is_twilight);
                          return (
                            <React.Fragment key="scheduled-twilight-lane">
                              {dayProjects.map((p, i) => renderCard(p, i))}
                              <div key="twilight-divider" className="flex items-center gap-2 my-2">
                                <div className="flex-1 h-px bg-purple-200" />
                                <span className="text-[9px] text-purple-500 font-medium flex-shrink-0">
                                  Twilight
                                </span>
                                <div className="flex-1 h-px bg-purple-200" />
                              </div>
                              {twilightProjects.map((p, i) => renderCard(p, i + dayProjects.length))}
                            </React.Fragment>
                          );
                          }

                          return columnProjects.map((p, i) => renderCard(p, i));
                          })()}
                        {provided.placeholder}
                      </div>
                    )}
                  </Droppable>
                </div>
              );
            })}
          </div>
        </DragDropContext>
      )}

      {/* Backward drag confirmation */}
      {pendingDrag && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setPendingDrag(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="backward-drag-title"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPendingDrag(null);
            // Bug fix: trap Tab focus within the confirmation dialog
            if (e.key === 'Tab') {
              const focusable = e.currentTarget.querySelectorAll('button');
              if (focusable.length === 0) return;
              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (e.shiftKey && document.activeElement === first) {
                e.preventDefault(); last.focus();
              } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
              }
            }
          }}
        >
          <div className="bg-card dark:bg-card rounded-lg p-6 max-w-sm shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 id="backward-drag-title" className="font-semibold text-base mb-2">Move Project Backward?</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Moving <strong>{pendingDrag.project?.title || 'this project'}</strong> from{' '}
              <strong>{PROJECT_STAGES.find(s => s.value === pendingDrag.project?.status)?.label}</strong> back to{' '}
              <strong>{PROJECT_STAGES.find(s => s.value === pendingDrag.newStatus)?.label}</strong>.
              Stage timer history is preserved.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1.5 text-sm border rounded hover:bg-muted disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                disabled={updateStatusMutation.isPending}
                onClick={() => setPendingDrag(null)}
              >
                Cancel
              </button>
              <button
                className="px-3 py-1.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
                disabled={updateStatusMutation.isPending}
                onClick={confirmBackwardDrag}
                autoFocus
              >
                {updateStatusMutation.isPending ? 'Moving...' : 'Move Backward'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

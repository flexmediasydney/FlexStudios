/**
 * Tasks — Global task view across all projects.
 * Kanban (drag-and-drop) + sortable List view with grouping, filtering, stats strip,
 * bulk actions, and quick-filter pills.
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useActiveTimers } from "@/components/utilization/ActiveTimersContext";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import TaskEffortBadge from "@/components/projects/TaskEffortBadge";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ListChecks, Search, LayoutGrid, List, ChevronDown, ChevronUp, ChevronRight,
  CheckCircle2, Circle, Timer, ShieldAlert, Lock, AlertTriangle,
  Filter, X, Clock, Users, Briefcase, Package, Layers, Wrench, Zap,
  BarChart3, TrendingUp, Activity
} from "lucide-react";

/* ═══════════════════════════ Constants & Helpers ═══════════════════════════ */

const STATUS_ORDER = ["blocked", "not_started", "in_progress", "completed"];

const STATUS_CONFIG = {
  blocked:     { label: "Blocked",     color: "bg-red-500",   textColor: "text-red-700",   bgLight: "bg-red-50",   icon: ShieldAlert,  borderColor: "border-red-300" },
  not_started: { label: "Not Started", color: "bg-gray-400",  textColor: "text-gray-700",  bgLight: "bg-gray-50",  icon: Circle,       borderColor: "border-gray-300" },
  in_progress: { label: "In Progress", color: "bg-blue-500",  textColor: "text-blue-700",  bgLight: "bg-blue-50",  icon: Timer,        borderColor: "border-blue-300" },
  completed:   { label: "Completed",   color: "bg-green-500", textColor: "text-green-700", bgLight: "bg-green-50", icon: CheckCircle2, borderColor: "border-green-300" },
};

const ROLE_LABELS = {
  none: "Unassigned",
  project_owner: "Project Owner",
  photographer: "Photographer",
  videographer: "Videographer",
  image_editor: "Image Editor",
  video_editor: "Video Editor",
  floorplan_editor: "Floorplan Editor",
  drone_editor: "Drone Editor",
};

function getTaskSource(task) {
  const tid = task.template_id;
  if (tid?.startsWith("product:"))      return { type: "product",  label: "Product",  color: "bg-blue-100 text-blue-700" };
  if (tid?.startsWith("package:"))      return { type: "package",  label: "Package",  color: "bg-purple-100 text-purple-700" };
  if (tid?.startsWith("project_type:")) return { type: "project",  label: "Project",  color: "bg-amber-100 text-amber-700" };
  if (tid?.startsWith("onsite:"))       return { type: "onsite",   label: "Onsite",   color: "bg-green-100 text-green-700" };
  if (/^\[Revision #\d+\]/.test(task.title || "")) return { type: "revision", label: "Request", color: "bg-rose-100 text-rose-700" };
  return { type: "manual", label: "Manual", color: "bg-gray-100 text-gray-600" };
}

function getTaskStatus(task, timerSet, effortMap) {
  if (task.is_completed) return "completed";
  if (task.is_blocked) return "blocked";
  if (timerSet.has(task.id) || (effortMap[task.id] > 0)) return "in_progress";
  return "not_started";
}

/** Format seconds to compact "Xh Ym" */
function fmtDuration(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** Return "YYYY-MM-DD" for today in local time */
function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

/** Format a date-string for display: "Apr 14" or "Apr 14, 2025" */
function fmtDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(fixTimestamp(dateStr));
    if (isNaN(d.getTime())) return "";
    const now = new Date();
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString("en-US", opts);
  } catch {
    return "";
  }
}

/** Check if a date-only string is before today */
function isOverdue(dateStr) {
  if (!dateStr) return false;
  return dateStr.slice(0, 10) < todayStr();
}

/** Check if a date-only string is today */
function isDueToday(dateStr) {
  if (!dateStr) return false;
  return dateStr.slice(0, 10) === todayStr();
}

/** First initial for avatar circle */
function initial(name) {
  if (!name) return "?";
  return name.trim().charAt(0).toUpperCase();
}

/* ═══════════════════════════ CSS Keyframes ═══════════════════════════ */

const taskAnimations = `
  @keyframes task-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
  .timer-pulse {
    animation: task-pulse 2s ease-in-out infinite;
  }
  @keyframes task-card-enter {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .task-card-enter {
    animation: task-card-enter 0.2s ease-out both;
  }
`;

/* ═══════════════════════════ Component ═══════════════════════════ */

export default function Tasks() {
  // ──── Data Loading ────
  const { data: allTasks = [], loading: tasksLoading } = useEntityList("ProjectTask", "order", 5000);
  const { data: projects = [] } = useEntityList("Project", "-shoot_date");
  const { data: timeLogs = [] } = useEntityList("TaskTimeLog", "-created_at");
  const { data: products = [] } = useEntityList("Product", "name");
  const { data: user } = useCurrentUser();
  const { activeTimers = [] } = useActiveTimers();

  // ──── State ────
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("tasks-view") || "list");
  const [groupBy, setGroupBy] = useState("none");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimerRef = useRef(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("");
  const [assigneeFilter, setAssigneeFilter] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [quickFilter, setQuickFilter] = useState("");
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortCol, setSortCol] = useState("due");
  const [sortDir, setSortDir] = useState("asc");
  const [collapsedGroups, setCollapsedGroups] = useState(new Set());
  const [kanbanLimits, setKanbanLimits] = useState({});

  // Debounced search
  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearchQuery(value), 200);
  }, []);
  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);
  useEffect(() => { if (searchQuery === "") setSearchInput(""); }, [searchQuery]);

  // Persist view mode
  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem("tasks-view", mode); } catch {}
  }, []);

  // ──── Computed ────
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const activeTimerTaskIds = useMemo(
    () => new Set((activeTimers || []).filter(t => t.is_active && t.status === "running").map(t => t.task_id)),
    [activeTimers]
  );

  const effortByTask = useMemo(() => {
    const m = {};
    (timeLogs || []).forEach(log => {
      if (!log.task_id || log.task_deleted) return;
      m[log.task_id] = (m[log.task_id] || 0) + (log.total_seconds || 0);
    });
    return m;
  }, [timeLogs]);

  const enrichedTasks = useMemo(() => {
    return allTasks
      .filter(t => !t.is_deleted && !t.is_archived)
      .map(t => ({
        ...t,
        _status: getTaskStatus(t, activeTimerTaskIds, effortByTask),
        _source: getTaskSource(t),
        _project: projectMap.get(t.project_id),
        _effortSeconds: effortByTask[t.id] || 0,
        _hasTimer: activeTimerTaskIds.has(t.id),
      }));
  }, [allTasks, activeTimerTaskIds, effortByTask, projectMap]);

  // ──── Stats ────
  const stats = useMemo(() => {
    const today = todayStr();
    const activeTasks = enrichedTasks.filter(t => t._status !== "completed");
    const completedToday = enrichedTasks.filter(t => t.is_completed && t.completed_at?.slice(0, 10) === today);
    const overdue = activeTasks.filter(t => t.due_date && isOverdue(t.due_date));
    const timerCount = enrichedTasks.filter(t => t._hasTimer).length;
    const totalActive = enrichedTasks.length;
    const totalCompleted = enrichedTasks.filter(t => t._status === "completed").length;
    const pct = totalActive > 0 ? Math.round((totalCompleted / totalActive) * 100) : 0;

    // Effort today: sum time logs with created_at today
    let effortToday = 0;
    (timeLogs || []).forEach(log => {
      if (log.task_deleted) return;
      if (log.created_at?.slice(0, 10) === today) {
        effortToday += (log.total_seconds || 0);
      }
    });

    return {
      total: activeTasks.length,
      completedToday: completedToday.length,
      overdue: overdue.length,
      activeTimers: timerCount,
      completionPct: pct,
      effortToday,
    };
  }, [enrichedTasks, timeLogs]);

  // ──── Unique values for filter dropdowns ────
  const uniqueAssignees = useMemo(() => {
    const map = new Map();
    enrichedTasks.forEach(t => {
      if (t.assigned_to_name) map.set(t.assigned_to_name, t.assigned_to);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [enrichedTasks]);

  const uniqueRoles = useMemo(() => {
    const s = new Set();
    enrichedTasks.forEach(t => { if (t.role) s.add(t.role); });
    return [...s].sort();
  }, [enrichedTasks]);

  // ──── Filtering ────
  const filteredTasks = useMemo(() => {
    const today = todayStr();
    const sq = searchQuery.toLowerCase();

    return enrichedTasks.filter(t => {
      // Search
      if (sq) {
        const match =
          t.title?.toLowerCase().includes(sq) ||
          t.assigned_to_name?.toLowerCase().includes(sq) ||
          t._project?.property_address?.toLowerCase().includes(sq) ||
          t._project?.title?.toLowerCase().includes(sq);
        if (!match) return false;
      }

      // Status
      if (statusFilter !== "all" && t._status !== statusFilter) return false;

      // Source
      if (sourceFilter && sourceFilter !== '__all__' && t._source.type !== sourceFilter) return false;

      // Assignee
      if (assigneeFilter && assigneeFilter !== '__all__' && t.assigned_to !== assigneeFilter) return false;

      // Role
      if (roleFilter && roleFilter !== '__all__' && t.role !== roleFilter) return false;

      // Quick filter pills
      if (quickFilter === "overdue") {
        if (t._status === "completed" || !t.due_date || !isOverdue(t.due_date)) return false;
      }
      if (quickFilter === "due_today") {
        if (t._status === "completed" || !isDueToday(t.due_date)) return false;
      }
      if (quickFilter === "my_tasks") {
        if (!user) return false;
        if (t.assigned_to !== user.id && t.assigned_to !== user.email) return false;
      }
      if (quickFilter === "blocked") {
        if (!t.is_blocked) return false;
      }
      if (quickFilter === "timers") {
        if (!t._hasTimer) return false;
      }
      if (quickFilter === "requests") {
        if (t._source.type !== "revision") return false;
      }

      return true;
    });
  }, [enrichedTasks, searchQuery, statusFilter, sourceFilter, assigneeFilter, roleFilter, quickFilter, user]);

  // ──── Sorting (list view) ────
  const sortedTasks = useMemo(() => {
    const copy = [...filteredTasks];
    const dir = sortDir === "asc" ? 1 : -1;
    copy.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "title":
          cmp = (a.title || "").localeCompare(b.title || "");
          break;
        case "project":
          cmp = (a._project?.property_address || "").localeCompare(b._project?.property_address || "");
          break;
        case "assignee":
          cmp = (a.assigned_to_name || "").localeCompare(b.assigned_to_name || "");
          break;
        case "role":
          cmp = (a.role || "").localeCompare(b.role || "");
          break;
        case "source":
          cmp = (a._source.type || "").localeCompare(b._source.type || "");
          break;
        case "due":
          cmp = (a.due_date || "9999").localeCompare(b.due_date || "9999");
          break;
        case "effort":
          cmp = (a._effortSeconds || 0) - (b._effortSeconds || 0);
          break;
        case "status":
          cmp = STATUS_ORDER.indexOf(a._status) - STATUS_ORDER.indexOf(b._status);
          break;
        default:
          cmp = (a.due_date || "9999").localeCompare(b.due_date || "9999");
      }
      return cmp * dir;
    });
    return copy;
  }, [filteredTasks, sortCol, sortDir]);

  // ──── Grouping ────
  const groupedTasks = useMemo(() => {
    if (groupBy === "none") return null;
    const groups = new Map();
    const arr = sortedTasks;

    arr.forEach(t => {
      let key, label;
      switch (groupBy) {
        case "project":
          key = t.project_id || "_none";
          label = t._project?.property_address || t._project?.title || "No Project";
          break;
        case "assignee":
          key = t.assigned_to || "_unassigned";
          label = t.assigned_to_name || "Unassigned";
          break;
        case "role":
          key = t.role || "none";
          label = ROLE_LABELS[t.role] || ROLE_LABELS.none;
          break;
        case "source":
          key = t._source.type;
          label = t._source.label;
          break;
        default:
          key = "_all";
          label = "All";
      }
      if (!groups.has(key)) groups.set(key, { key, label, tasks: [] });
      groups.get(key).tasks.push(t);
    });

    return [...groups.values()];
  }, [sortedTasks, groupBy]);

  // ──── Kanban columns ────
  const kanbanColumns = useMemo(() => {
    const cols = {};
    STATUS_ORDER.forEach(s => { cols[s] = []; });
    filteredTasks.forEach(t => {
      if (cols[t._status]) cols[t._status].push(t);
    });
    return cols;
  }, [filteredTasks]);

  // ──── Actions ────
  const toggleComplete = useCallback(async (task) => {
    const wasCompleted = task.is_completed;
    try {
      await api.entities.ProjectTask.update(task.id, {
        is_completed: !wasCompleted,
        ...(wasCompleted ? { completed_at: null } : { completed_at: new Date().toISOString() }),
      });
      refetchEntityList("ProjectTask");
      toast.success(wasCompleted ? "Task reopened" : "Task completed");
    } catch {
      toast.error("Failed to update task");
    }
  }, []);

  const bulkMarkComplete = useCallback(async () => {
    const ids = [...selectedIds];
    const toComplete = enrichedTasks.filter(t => ids.includes(t.id) && !t.is_completed);
    if (toComplete.length === 0) {
      toast.info("All selected tasks are already completed");
      setSelectedIds(new Set());
      return;
    }
    try {
      await Promise.all(toComplete.map(t =>
        api.entities.ProjectTask.update(t.id, {
          is_completed: true,
          completed_at: new Date().toISOString(),
        })
      ));
      refetchEntityList("ProjectTask");
      toast.success(`${toComplete.length} task${toComplete.length > 1 ? "s" : ""} completed`);
      setSelectedIds(new Set());
    } catch {
      toast.error("Failed to complete some tasks");
    }
  }, [selectedIds, enrichedTasks]);

  const handleDragEnd = useCallback(async (result) => {
    const { draggableId, destination, source } = result;
    if (!destination || destination.droppableId === source.droppableId) return;

    const task = enrichedTasks.find(t => t.id === draggableId);
    if (!task) return;

    const newStatus = destination.droppableId;

    // Only handle complete/uncomplete transitions
    if (newStatus === "completed" && !task.is_completed) {
      await toggleComplete(task);
    } else if (newStatus !== "completed" && task.is_completed) {
      await toggleComplete(task);
    }

    if (newStatus === "blocked" && !task.is_blocked) {
      try {
        await api.entities.ProjectTask.update(task.id, { is_blocked: true });
        refetchEntityList("ProjectTask");
      } catch { /* silent */ }
    } else if (newStatus !== "blocked" && task.is_blocked) {
      try {
        await api.entities.ProjectTask.update(task.id, { is_blocked: false });
        refetchEntityList("ProjectTask");
      } catch { /* silent */ }
    }
  }, [enrichedTasks, toggleComplete]);

  const toggleSort = useCallback((col) => {
    setSortCol(prev => {
      if (prev === col) {
        setSortDir(d => d === "asc" ? "desc" : "asc");
        return col;
      }
      setSortDir("asc");
      return col;
    });
  }, []);

  const toggleGroup = useCallback((key) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    const visible = sortedTasks.map(t => t.id);
    setSelectedIds(prev => {
      const allSelected = visible.every(id => prev.has(id));
      if (allSelected) return new Set();
      return new Set(visible);
    });
  }, [sortedTasks]);

  const clearFilters = useCallback(() => {
    setSearchQuery("");
    setSearchInput("");
    setStatusFilter("all");
    setSourceFilter("");
    setAssigneeFilter("");
    setRoleFilter("");
    setQuickFilter("");
  }, []);

  const hasActiveFilters = searchQuery || statusFilter !== "all" || sourceFilter || assigneeFilter || roleFilter || quickFilter;

  // ──── Loading State ────
  if (tasksLoading) {
    return (
      <div className="px-3 pt-2 pb-3 sm:px-4 lg:px-6 space-y-4">
        <style>{taskAnimations}</style>
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-24" />
          <Skeleton className="h-8 w-64" />
          <div className="ml-auto flex gap-2">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-xl" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  // ──── Quick filter pill definition ────
  const quickFilters = [
    { key: "overdue",   label: "Overdue",       icon: AlertTriangle, count: stats.overdue },
    { key: "due_today", label: "Due Today",      icon: Clock,         count: enrichedTasks.filter(t => t._status !== "completed" && isDueToday(t.due_date)).length },
    { key: "my_tasks",  label: "My Tasks",       icon: Users,         count: user ? enrichedTasks.filter(t => t.assigned_to === user.id || t.assigned_to === user.email).length : 0 },
    { key: "blocked",   label: "Blocked",        icon: ShieldAlert,   count: enrichedTasks.filter(t => t.is_blocked).length },
    { key: "timers",    label: "Active Timers",  icon: Timer,         count: stats.activeTimers },
    { key: "requests",  label: "Requests Only",  icon: Wrench,        count: enrichedTasks.filter(t => t._source.type === "revision").length },
  ];

  return (
    <div className="px-3 pt-2 pb-3 sm:px-4 lg:px-6 space-y-3">
      <style>{taskAnimations}</style>

      {/* ════════ Header Row ════════ */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <ListChecks className="h-4.5 w-4.5 text-primary" />
          <h1 className="text-lg font-semibold tracking-tight">Tasks</h1>
          <Badge variant="secondary" className="text-[10px] font-semibold ml-1">{filteredTasks.length}</Badge>
        </div>

        {/* Search */}
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            className="pl-7 h-8 text-sm"
            placeholder="Search tasks, projects, people..."
            value={searchInput}
            onChange={e => handleSearchChange(e.target.value)}
          />
          {searchInput && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => { setSearchQuery(""); setSearchInput(""); }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2">
          {/* Group By */}
          <Select value={groupBy} onValueChange={setGroupBy}>
            <SelectTrigger className="h-8 w-[130px] text-xs">
              <Layers className="h-3 w-3 mr-1" />
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No Grouping</SelectItem>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="assignee">Assignee</SelectItem>
              <SelectItem value="role">Role</SelectItem>
              <SelectItem value="source">Source</SelectItem>
            </SelectContent>
          </Select>

          {/* View Toggle */}
          <Tabs value={viewMode} onValueChange={setViewModePersisted}>
            <TabsList className="h-8 p-0.5">
              <TabsTrigger value="kanban" className="h-7 px-2.5 text-xs gap-1">
                <LayoutGrid className="h-3.5 w-3.5" />
                Kanban
              </TabsTrigger>
              <TabsTrigger value="list" className="h-7 px-2.5 text-xs gap-1">
                <List className="h-3.5 w-3.5" />
                List
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* ════════ Stats Strip ════════ */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
        <StatCard label="Active" value={stats.total} icon={ListChecks} color="text-foreground" />
        <StatCard label="Done Today" value={stats.completedToday} icon={CheckCircle2} color="text-green-600" />
        <StatCard
          label="Overdue"
          value={stats.overdue}
          icon={AlertTriangle}
          color="text-red-600"
          highlight={stats.overdue > 0}
        />
        <StatCard label="Timers" value={stats.activeTimers} icon={Timer} color="text-blue-600" pulse={stats.activeTimers > 0} />
        <StatCard label="Complete" value={`${stats.completionPct}%`} icon={TrendingUp} color="text-emerald-600" />
        <StatCard label="Effort Today" value={fmtDuration(stats.effortToday)} icon={Activity} color="text-violet-600" />
      </div>

      {/* ════════ Quick Filter Pills ════════ */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground mr-0.5" />
        {quickFilters.map(qf => (
          <button
            key={qf.key}
            onClick={() => setQuickFilter(prev => prev === qf.key ? "" : qf.key)}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-all",
              quickFilter === qf.key
                ? "bg-primary text-primary-foreground shadow-sm"
                : "bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <qf.icon className="h-3 w-3" />
            {qf.label}
            {qf.count > 0 && (
              <span className={cn(
                "text-[10px] font-bold tabular-nums ml-0.5",
                quickFilter === qf.key ? "text-primary-foreground/80" : ""
              )}>
                {qf.count}
              </span>
            )}
          </button>
        ))}

        {/* Filter dropdowns */}
        <div className="flex items-center gap-1.5 ml-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="h-7 w-[110px] text-[11px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {STATUS_ORDER.map(s => (
                <SelectItem key={s} value={s}>{STATUS_CONFIG[s].label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {uniqueAssignees.length > 0 && (
            <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
              <SelectTrigger className="h-7 w-[120px] text-[11px]">
                <SelectValue placeholder="Assignee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Assignees</SelectItem>
                {uniqueAssignees.map(([name, id]) => (
                  <SelectItem key={id} value={id}>{name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {uniqueRoles.length > 0 && (
            <Select value={roleFilter} onValueChange={setRoleFilter}>
              <SelectTrigger className="h-7 w-[120px] text-[11px]">
                <SelectValue placeholder="Role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All Roles</SelectItem>
                {uniqueRoles.map(r => (
                  <SelectItem key={r} value={r}>{ROLE_LABELS[r] || r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="h-7 w-[100px] text-[11px]">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Sources</SelectItem>
              <SelectItem value="product">Product</SelectItem>
              <SelectItem value="package">Package</SelectItem>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="onsite">Onsite</SelectItem>
              <SelectItem value="revision">Request</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
            </SelectContent>
          </Select>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs text-muted-foreground" onClick={clearFilters}>
              <X className="h-3 w-3 mr-1" />
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* ════════ Empty State ════════ */}
      {filteredTasks.length === 0 && !tasksLoading && (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <ListChecks className="h-10 w-10 text-muted-foreground/40 mb-3" />
          {enrichedTasks.length === 0 ? (
            <>
              <p className="text-sm font-medium text-muted-foreground">No tasks yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1">Tasks will appear here as projects are created and synced.</p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-muted-foreground">No tasks match your filters</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={clearFilters}>
                Clear Filters
              </Button>
            </>
          )}
        </div>
      )}

      {/* ════════ Kanban View ════════ */}
      {viewMode === "kanban" && filteredTasks.length > 0 && (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {STATUS_ORDER.map(statusKey => {
              const cfg = STATUS_CONFIG[statusKey];
              const tasks = kanbanColumns[statusKey] || [];
              const limit = kanbanLimits[statusKey] || 100;
              const shown = tasks.slice(0, limit);
              const hasMore = tasks.length > limit;

              return (
                <div key={statusKey} className="flex flex-col min-h-0">
                  {/* Column header */}
                  <div className={cn("flex items-center gap-2 px-3 py-2 rounded-t-lg border", cfg.bgLight, cfg.borderColor)}>
                    <cfg.icon className={cn("h-3.5 w-3.5", cfg.textColor)} />
                    <span className={cn("text-xs font-semibold", cfg.textColor)}>{cfg.label}</span>
                    <Badge variant="secondary" className="text-[10px] ml-auto">{tasks.length}</Badge>
                  </div>

                  {/* Droppable area */}
                  <Droppable droppableId={statusKey}>
                    {(provided, snapshot) => (
                      <div
                        ref={provided.innerRef}
                        {...provided.droppableProps}
                        className={cn(
                          "flex-1 space-y-2 p-2 rounded-b-lg border border-t-0 overflow-y-auto transition-colors",
                          snapshot.isDraggingOver ? "bg-accent/40" : "bg-background",
                          cfg.borderColor
                        )}
                        style={{ maxHeight: "calc(100vh - 320px)", minHeight: "120px" }}
                      >
                        {shown.map((task, index) => (
                          <Draggable key={task.id} draggableId={task.id} index={index}>
                            {(prov, snap) => (
                              <div
                                ref={prov.innerRef}
                                {...prov.draggableProps}
                                {...prov.dragHandleProps}
                                className={cn(
                                  "task-card-enter",
                                  snap.isDragging && "opacity-90"
                                )}
                                style={{ ...prov.draggableProps.style, animationDelay: `${Math.min(index, 10) * 20}ms` }}
                              >
                                <TaskKanbanCard task={task} onToggle={toggleComplete} />
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                        {tasks.length === 0 && (
                          <p className="text-xs text-muted-foreground/50 text-center py-6">No tasks</p>
                        )}
                        {hasMore && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs text-muted-foreground"
                            onClick={() => setKanbanLimits(prev => ({ ...prev, [statusKey]: (prev[statusKey] || 100) + 100 }))}
                          >
                            Show {tasks.length - limit} more
                          </Button>
                        )}
                      </div>
                    )}
                  </Droppable>
                </div>
              );
            })}
          </div>
        </DragDropContext>
      )}

      {/* ════════ List View ════════ */}
      {viewMode === "list" && filteredTasks.length > 0 && (
        <div className="border rounded-lg overflow-hidden bg-background">
          {groupBy !== "none" && groupedTasks ? (
            // Grouped list
            <div>
              {groupedTasks.map(group => {
                const collapsed = collapsedGroups.has(group.key);
                const completedCount = group.tasks.filter(t => t._status === "completed").length;
                const pct = group.tasks.length > 0 ? Math.round((completedCount / group.tasks.length) * 100) : 0;

                return (
                  <div key={group.key}>
                    <button
                      onClick={() => toggleGroup(group.key)}
                      className="w-full flex items-center gap-2 px-3 py-2 bg-muted/40 border-b hover:bg-muted/60 transition-colors text-left"
                    >
                      {collapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                      <span className="text-sm font-medium truncate">{group.label}</span>
                      <Badge variant="secondary" className="text-[10px]">{group.tasks.length}</Badge>
                      <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">{pct}% done</span>
                    </button>
                    {!collapsed && (
                      <TaskTable
                        tasks={group.tasks}
                        selectedIds={selectedIds}
                        toggleSelect={toggleSelect}
                        toggleSelectAll={toggleSelectAll}
                        toggleComplete={toggleComplete}
                        sortCol={sortCol}
                        sortDir={sortDir}
                        toggleSort={toggleSort}
                        showHeader={false}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            // Flat list
            <TaskTable
              tasks={sortedTasks}
              selectedIds={selectedIds}
              toggleSelect={toggleSelect}
              toggleSelectAll={toggleSelectAll}
              toggleComplete={toggleComplete}
              sortCol={sortCol}
              sortDir={sortDir}
              toggleSort={toggleSort}
              showHeader={true}
            />
          )}
        </div>
      )}

      {/* ════════ Bulk Actions Bar ════════ */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-background border rounded-xl shadow-lg px-4 py-2.5">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <Button size="sm" className="h-8 text-xs" onClick={bulkMarkComplete}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            Mark Complete
          </Button>
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={() => setSelectedIds(new Set())}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════ Stat Card ═══════════════════════════ */

function StatCard({ label, value, icon: Icon, color, highlight = false, pulse = false }) {
  return (
    <Card className={cn("rounded-xl border-0 shadow-sm", highlight && "ring-1 ring-red-200")}>
      <CardContent className="p-3 flex items-center gap-3">
        <div className={cn("p-1.5 rounded-lg bg-muted/60", pulse && "timer-pulse")}>
          <Icon className={cn("h-4 w-4", color)} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color)}>{value}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ═══════════════════════════ Kanban Card ═══════════════════════════ */

function TaskKanbanCard({ task, onToggle }) {
  const t = task;
  const overdue = !t.is_completed && t.due_date && isOverdue(t.due_date);
  const dueToday = !t.is_completed && isDueToday(t.due_date);

  return (
    <Card className="rounded-lg border shadow-sm p-3 cursor-grab hover:shadow-md transition-shadow bg-background">
      <div className="space-y-2">
        {/* Row 1: checkbox + title */}
        <div className="flex items-start gap-2">
          <Checkbox
            checked={t.is_completed}
            onCheckedChange={() => onToggle(t)}
            className="mt-0.5 h-4 w-4"
            onClick={e => e.stopPropagation()}
          />
          <span className={cn(
            "text-sm font-medium leading-snug line-clamp-1 flex-1",
            t.is_completed && "line-through text-muted-foreground"
          )}>
            {t.title}
          </span>
          {t._hasTimer && (
            <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
          )}
        </div>

        {/* Row 2: project address */}
        {t._project?.property_address && (
          <Link
            to={createPageUrl("ProjectDetails") + `?id=${t.project_id}`}
            className="block text-[11px] text-muted-foreground hover:text-foreground truncate transition-colors"
            onClick={e => e.stopPropagation()}
          >
            {t._project.property_address}
          </Link>
        )}

        {/* Row 3: badges & meta */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap", t._source.color)}>
            {t._source.label}
          </span>

          {t.assigned_to_name && (
            <span
              className="flex items-center justify-center h-5 w-5 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0"
              title={t.assigned_to_name}
            >
              {initial(t.assigned_to_name)}
            </span>
          )}

          {t.due_date && (
            <span className={cn(
              "text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap",
              overdue ? "bg-red-100 text-red-700" :
              dueToday ? "bg-amber-100 text-amber-700" :
              "text-muted-foreground"
            )}>
              {fmtDate(t.due_date)}
            </span>
          )}
        </div>

        {/* Row 4: effort bar */}
        {(t.estimated_minutes > 0 || t._effortSeconds > 0) && (
          <TaskEffortBadge
            estimatedMinutes={t.estimated_minutes || 0}
            actualSeconds={t._effortSeconds}
            compact
          />
        )}
      </div>
    </Card>
  );
}

/* ═══════════════════════════ Task Table ═══════════════════════════ */

function TaskTable({ tasks, selectedIds, toggleSelect, toggleSelectAll, toggleComplete, sortCol, sortDir, toggleSort, showHeader }) {
  const allSelected = tasks.length > 0 && tasks.every(t => selectedIds.has(t.id));

  const SortHeader = ({ col, label, className: cls }) => {
    const active = sortCol === col;
    return (
      <button
        className={cn("flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors", cls)}
        onClick={() => toggleSort(col)}
      >
        {label}
        {active && (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
      </button>
    );
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        {showHeader && (
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="w-10 px-3 py-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  className="h-3.5 w-3.5"
                />
              </th>
              <th className="w-10 px-2 py-2"><SortHeader col="status" label="Status" /></th>
              <th className="px-2 py-2 text-left"><SortHeader col="title" label="Task" /></th>
              <th className="px-2 py-2 text-left hidden lg:table-cell"><SortHeader col="project" label="Project" /></th>
              <th className="px-2 py-2 text-left hidden md:table-cell"><SortHeader col="assignee" label="Assigned" /></th>
              <th className="px-2 py-2 text-left hidden xl:table-cell"><SortHeader col="role" label="Role" /></th>
              <th className="px-2 py-2 text-left hidden xl:table-cell"><SortHeader col="source" label="Source" /></th>
              <th className="px-2 py-2 text-left"><SortHeader col="due" label="Due" /></th>
              <th className="px-2 py-2 text-left hidden md:table-cell"><SortHeader col="effort" label="Effort" /></th>
              <th className="w-10 px-2 py-2 text-center hidden sm:table-cell">
                <Timer className="h-3 w-3 text-muted-foreground mx-auto" />
              </th>
            </tr>
          </thead>
        )}
        <tbody>
          {tasks.map(t => (
            <TaskRow
              key={t.id}
              task={t}
              selected={selectedIds.has(t.id)}
              toggleSelect={toggleSelect}
              toggleComplete={toggleComplete}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════ Task Row ═══════════════════════════ */

function TaskRow({ task, selected, toggleSelect, toggleComplete }) {
  const t = task;
  const cfg = STATUS_CONFIG[t._status];
  const overdue = !t.is_completed && t.due_date && isOverdue(t.due_date);
  const dueToday = !t.is_completed && isDueToday(t.due_date);

  return (
    <tr className={cn(
      "border-b hover:bg-muted/30 transition-colors",
      selected && "bg-primary/5"
    )}>
      {/* Select */}
      <td className="w-10 px-3 py-2">
        <Checkbox
          checked={selected}
          onCheckedChange={() => toggleSelect(t.id)}
          className="h-3.5 w-3.5"
        />
      </td>

      {/* Status checkbox */}
      <td className="w-10 px-2 py-2">
        <div className="flex items-center gap-1">
          <Checkbox
            checked={t.is_completed}
            onCheckedChange={() => toggleComplete(t)}
            className="h-4 w-4"
          />
          {t.is_blocked && <Lock className="h-3 w-3 text-red-500" />}
        </div>
      </td>

      {/* Task title + source inline */}
      <td className="px-2 py-2 max-w-[300px]">
        <div className="flex items-center gap-1.5">
          <span className={cn(
            "text-sm font-medium truncate",
            t.is_completed && "line-through text-muted-foreground"
          )}>
            {t.title}
          </span>
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap shrink-0", t._source.color)}>
            {t._source.label}
          </span>
        </div>
      </td>

      {/* Project */}
      <td className="px-2 py-2 hidden lg:table-cell max-w-[200px]">
        {t._project?.property_address ? (
          <Link
            to={createPageUrl("ProjectDetails") + `?id=${t.project_id}`}
            className="text-xs text-muted-foreground hover:text-foreground truncate block transition-colors"
          >
            {t._project.property_address}
          </Link>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Assigned */}
      <td className="px-2 py-2 hidden md:table-cell">
        {t.assigned_to_name ? (
          <div className="flex items-center gap-1.5">
            <span className="flex items-center justify-center h-5 w-5 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0">
              {initial(t.assigned_to_name)}
            </span>
            <span className="text-xs truncate max-w-[100px]">{t.assigned_to_name}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Role */}
      <td className="px-2 py-2 hidden xl:table-cell">
        {t.role && t.role !== "none" ? (
          <Badge variant="outline" className="text-[10px] font-medium">{ROLE_LABELS[t.role] || t.role}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Source */}
      <td className="px-2 py-2 hidden xl:table-cell">
        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap", t._source.color)}>
          {t._source.label}
        </span>
      </td>

      {/* Due date */}
      <td className="px-2 py-2">
        {t.due_date ? (
          <span className={cn(
            "text-xs font-medium whitespace-nowrap",
            overdue ? "text-red-600 font-semibold" :
            dueToday ? "text-amber-600 font-semibold" :
            "text-muted-foreground"
          )}>
            {overdue && <AlertTriangle className="h-3 w-3 inline mr-0.5 -mt-0.5" />}
            {fmtDate(t.due_date)}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Effort */}
      <td className="px-2 py-2 hidden md:table-cell">
        <TaskEffortBadge
          estimatedMinutes={t.estimated_minutes || 0}
          actualSeconds={t._effortSeconds}
          compact
        />
      </td>

      {/* Timer */}
      <td className="w-10 px-2 py-2 text-center hidden sm:table-cell">
        {t._hasTimer ? (
          <span className="relative flex h-2.5 w-2.5 mx-auto">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/30">--</span>
        )}
      </td>
    </tr>
  );
}

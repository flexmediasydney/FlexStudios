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
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import { CountdownTimer } from "@/components/projects/TaskManagement";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ListChecks, Search, LayoutGrid, List, ChevronDown, ChevronUp, ChevronRight,
  CheckCircle2, Circle, Timer, ShieldAlert, Lock, AlertTriangle,
  Filter, X, Clock, Users, Package, Layers, Wrench,
  TrendingUp, Activity
} from "lucide-react";

/* ═══════════════════════════ Constants & Helpers ═══════════════════════════ */

/** colSpan must match column count in thead */
const TABLE_COL_COUNT = 10;

const STATUS_ORDER = ["not_started", "in_progress", "completed", "blocked"];

const STATUS_CONFIG = {
  blocked:     { label: "Blocked",     color: "bg-amber-500",  textColor: "text-amber-700",  bgLight: "bg-amber-50 dark:bg-amber-950/30",  icon: ShieldAlert,  borderColor: "border-amber-300 dark:border-amber-800" },
  not_started: { label: "Not Started", color: "bg-gray-400",  textColor: "text-gray-700",  bgLight: "bg-gray-50 dark:bg-gray-900/30",  icon: Circle,       borderColor: "border-gray-300 dark:border-gray-700" },
  in_progress: { label: "In Progress", color: "bg-blue-500",  textColor: "text-blue-700",  bgLight: "bg-blue-50 dark:bg-blue-950/30",  icon: Timer,        borderColor: "border-blue-300 dark:border-blue-800" },
  completed:   { label: "Completed",   color: "bg-green-500", textColor: "text-green-700", bgLight: "bg-green-50 dark:bg-green-950/30", icon: CheckCircle2, borderColor: "border-green-300 dark:border-green-800" },
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

function getTaskSource(task, productMap, packageMap) {
  const tid = task.template_id;
  if (tid?.startsWith("product:")) {
    const prodId = task.product_id || tid.split(":")[1];
    const prod = productMap?.get(prodId);
    return { type: "product", label: prod?.name || "Product", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
  }
  if (tid?.startsWith("package:")) {
    const pkgId = task.package_id || tid.split(":")[1];
    const pkg = packageMap?.get(pkgId);
    return { type: "package", label: pkg?.name || "Package", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
  }
  if (tid?.startsWith("project_type:")) return { type: "project", label: "Project Level", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
  if (tid?.startsWith("onsite:"))       return { type: "onsite",  label: "Onsite",        color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" };
  if (/^\[Revision #\d+\]/.test(task.title || "")) return { type: "revision", label: "Request", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" };
  return { type: "manual", label: "Manual", color: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400" };
}

function getTaskStatus(task, timerSet) {
  if (task.is_completed) return "completed";
  if (task.is_blocked) return "blocked";
  if (timerSet.has(task.id)) return "in_progress";
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
  const { data: packages = [] } = useEntityList("Package", "name");
  const { data: user } = useCurrentUser();
  const { activeTimers = [] } = useActiveTimers();

  // ──── Permission ────
  const canEdit = user && ['master_admin', 'admin', 'manager', 'employee'].includes(user.role);

  // ──── Real-time subscription (Fix #1) ────
  useEffect(() => {
    try {
      const unsub = api.entities.ProjectTask.subscribe(() => refetchEntityList("ProjectTask"));
      return typeof unsub === 'function' ? () => unsub() : undefined;
    } catch { return undefined; }
  }, []);

  // ──── State ────
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [viewMode, setViewMode] = useState(() => localStorage.getItem("tasks-view") || "list");
  const [groupBy, setGroupBy] = useState(() => localStorage.getItem("tasks-group-by") || "none");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const searchTimerRef = useRef(null);
  const togglingRef = useRef(new Set());
  const [statusFilter, setStatusFilter] = useState(() => localStorage.getItem("tasks-status-filter") || "all");
  const [sourceFilter, setSourceFilter] = useState(() => localStorage.getItem("tasks-source-filter") || "");
  const [assigneeFilter, setAssigneeFilter] = useState(() => localStorage.getItem("tasks-assignee-filter") || "");
  const [roleFilter, setRoleFilter] = useState(() => localStorage.getItem("tasks-role-filter") || "");
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

  // Persist filters to localStorage (Fix #5)
  useEffect(() => { localStorage.setItem("tasks-status-filter", statusFilter); }, [statusFilter]);
  useEffect(() => { localStorage.setItem("tasks-source-filter", sourceFilter); }, [sourceFilter]);
  useEffect(() => { localStorage.setItem("tasks-assignee-filter", assigneeFilter); }, [assigneeFilter]);
  useEffect(() => { localStorage.setItem("tasks-role-filter", roleFilter); }, [roleFilter]);
  useEffect(() => { localStorage.setItem("tasks-group-by", groupBy); }, [groupBy]);

  // Persist view mode
  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem("tasks-view", mode); } catch {}
  }, []);

  // ──── Computed ────
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const productMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const packageMap = useMemo(() => new Map(packages.map(p => [p.id, p])), [packages]);
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
      .filter(t => !t.is_deleted && !t.is_archived && (!t.project_id || projectMap.get(t.project_id)?.status !== 'cancelled'))
      .map(t => ({
        ...t,
        _status: getTaskStatus(t, activeTimerTaskIds),
        _source: getTaskSource(t, productMap, packageMap),
        _project: projectMap.get(t.project_id),
        _effortSeconds: effortByTask[t.id] || 0,
        _hasTimer: activeTimerTaskIds.has(t.id),
      }));
  }, [allTasks, activeTimerTaskIds, effortByTask, projectMap, productMap, packageMap]);

  // O(1) task lookup map for drag-and-drop (Fix #8)
  const taskMap = useMemo(() => new Map(enrichedTasks.map(t => [t.id, t])), [enrichedTasks]);

  // ──── Contractor visibility filter ────
  const visibleTasks = useMemo(() => {
    if (user?.role === 'contractor') {
      return enrichedTasks.filter(t => t.assigned_to === user.id);
    }
    return enrichedTasks;
  }, [enrichedTasks, user]);

  // ──── Stats ────
  const stats = useMemo(() => {
    const today = todayStr();
    const activeTasks = visibleTasks.filter(t => t._status !== "completed");
    const completedToday = visibleTasks.filter(t => t.is_completed && t.completed_at?.slice(0, 10) === today);
    const overdue = activeTasks.filter(t => t.due_date && isOverdue(t.due_date));
    const timerCount = visibleTasks.filter(t => t._hasTimer).length;
    const totalActive = visibleTasks.length;
    const totalCompleted = visibleTasks.filter(t => t._status === "completed").length;
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
  }, [visibleTasks, timeLogs]);

  // ──── Unique values for filter dropdowns ────
  const uniqueAssignees = useMemo(() => {
    const map = new Map();
    visibleTasks.forEach(t => {
      if (t.assigned_to_name) map.set(t.assigned_to_name, t.assigned_to);
    });
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [visibleTasks]);

  const uniqueRoles = useMemo(() => {
    const s = new Set();
    visibleTasks.forEach(t => { if (t.auto_assign_role) s.add(t.auto_assign_role); });
    return [...s].sort();
  }, [visibleTasks]);

  // ──── Filtering ────
  const filteredTasks = useMemo(() => {
    const today = todayStr();
    const sq = searchQuery.toLowerCase();

    return visibleTasks.filter(t => {
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
      if (roleFilter && roleFilter !== '__all__' && t.auto_assign_role !== roleFilter) return false;

      // Quick filter pills
      if (quickFilter === "overdue") {
        if (t._status === "completed" || !t.due_date || !isOverdue(t.due_date)) return false;
      }
      if (quickFilter === "due_today") {
        if (t._status === "completed" || !isDueToday(t.due_date)) return false;
      }
      if (quickFilter === "my_tasks") {
        if (!user) return false;
        if (t.assigned_to !== user.id && t.assigned_to !== user.email && t.assigned_to_team_id !== user?.internal_team_id) return false;
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
  }, [visibleTasks, searchQuery, statusFilter, sourceFilter, assigneeFilter, roleFilter, quickFilter, user]);

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
          cmp = (a.auto_assign_role || "").localeCompare(b.auto_assign_role || "");
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
          key = t.auto_assign_role || "none";
          label = ROLE_LABELS[t.auto_assign_role] || ROLE_LABELS.none;
          break;
        case "source":
          key = `${t._source.type}:${t._source.label}`;
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

  // Reset kanban limits on filter change
  useEffect(() => setKanbanLimits({}), [statusFilter, sourceFilter, assigneeFilter, roleFilter, searchQuery, quickFilter]);

  // Collapse all groups except the first by default — also reset on filter change
  const prevGroupByRef = useRef(groupBy);
  useEffect(() => {
    if (groupedTasks && groupedTasks.length > 1) {
      const allKeys = groupedTasks.map(g => g.key);
      setCollapsedGroups(new Set(allKeys.slice(1)));
    }
    prevGroupByRef.current = groupBy;
  }, [groupBy, groupedTasks, statusFilter, sourceFilter, assigneeFilter, roleFilter, searchQuery, quickFilter]);

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
    if (!canEdit) { toast.error("You do not have permission to edit tasks"); return; }
    if (task.is_locked) { toast.info(`"${task.title}" is locked and cannot be toggled`); return; }
    if (task.is_blocked) { toast.info(`"${task.title}" is blocked — complete dependency tasks first`); return; }
    // Double-submit prevention — per-task Set
    if (togglingRef.current.has(task.id)) return;
    togglingRef.current.add(task.id);
    const wasCompleted = task.is_completed;
    try {
      // Onsite task warning
      if (task.task_type === 'onsite' && !wasCompleted) {
        toast.info('Onsite tasks are normally auto-completed when photos are uploaded');
      }
      await api.entities.ProjectTask.update(task.id, {
        is_completed: !wasCompleted,
        ...(wasCompleted ? { completed_at: null } : { completed_at: new Date().toISOString() }),
      });
      refetchEntityList("ProjectTask");
      toast.success(wasCompleted ? "Task reopened" : "Task completed");
      // Deadline sync
      if (task.project_id) {
        api.functions.invoke('calculateProjectTaskDeadlines', { project_id: task.project_id, trigger_event: 'task_toggle' }).catch(() => {});
      }
      // Audit trail
      api.entities.ProjectActivity.create({
        project_id: task.project_id,
        project_title: task._project?.title || task._project?.property_address || '',
        action: 'task_completed',
        activity_type: 'status_change',
        description: `Task "${task.title}" ${wasCompleted ? 'reopened' : 'completed'} from Tasks page`,
        user_id: user?.id,
        user_name: user?.full_name || user?.email,
      }).catch(() => {});
    } catch {
      toast.error("Failed to update task");
    } finally {
      togglingRef.current.delete(task.id);
    }
  }, [canEdit, user]);

  const bulkMarkComplete = useCallback(async () => {
    if (!canEdit) { toast.error("You do not have permission to edit tasks"); return; }
    const ids = [...selectedIds];
    const eligible = visibleTasks.filter(t => ids.includes(t.id) && !t.is_completed && !t.is_locked && !t.is_blocked);
    const skipped = visibleTasks.filter(t => ids.includes(t.id) && !t.is_completed && (t.is_locked || t.is_blocked));
    if (eligible.length === 0) {
      toast.info(skipped.length > 0 ? "All eligible tasks are locked or blocked" : "All selected tasks are already completed");
      setSelectedIds(new Set());
      return;
    }
    const results = await Promise.allSettled(eligible.map(t =>
      api.entities.ProjectTask.update(t.id, {
        is_completed: true,
        completed_at: new Date().toISOString(),
      })
    ));
    const successes = results.filter(r => r.status === "fulfilled").length;
    const failures = results.filter(r => r.status === "rejected").length;
    refetchEntityList("ProjectTask");
    // Deadline sync for affected projects
    const uniqueProjectIds = [...new Set(eligible.map(t => t.project_id).filter(Boolean))];
    uniqueProjectIds.forEach(pid => {
      api.functions.invoke('calculateProjectTaskDeadlines', { project_id: pid, trigger_event: 'task_toggle' }).catch(() => {});
    });
    if (failures > 0) {
      toast.warning(`${successes} completed, ${failures} failed`);
    } else {
      const msg = [`${successes} task${successes > 1 ? "s" : ""} completed`];
      if (skipped.length > 0) msg.push(`${skipped.length} skipped (locked/blocked)`);
      toast.success(msg.join(". "));
    }
    setSelectedIds(new Set());
  }, [selectedIds, visibleTasks, canEdit]);

  const handleDragEnd = useCallback(async (result) => {
    if (!canEdit) { toast.error("You do not have permission to edit tasks"); return; }
    const { draggableId, destination, source } = result;
    if (!destination || destination.droppableId === source.droppableId) return;

    const task = taskMap.get(draggableId);
    if (!task) return;

    const newStatus = destination.droppableId;

    // Prevent dragging locked or blocked tasks to completed
    if (task.is_locked) { toast.info("This task is locked and cannot be moved"); return; }
    if (task.is_blocked && newStatus === "completed") { toast.info("Complete dependency tasks first"); return; }

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
      } catch (err) { toast.error("Failed to update task"); }
    } else if (newStatus !== "blocked" && task.is_blocked) {
      try {
        await api.entities.ProjectTask.update(task.id, { is_blocked: false });
        refetchEntityList("ProjectTask");
      } catch (err) { toast.error("Failed to update task"); }
    }
  }, [taskMap, toggleComplete, canEdit]);

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
    // Clear persisted filters too
    try {
      localStorage.removeItem("tasks-status-filter");
      localStorage.removeItem("tasks-source-filter");
      localStorage.removeItem("tasks-assignee-filter");
      localStorage.removeItem("tasks-role-filter");
    } catch {}
  }, []);

  const hasActiveFilters = searchQuery || statusFilter !== "all" || sourceFilter || assigneeFilter || roleFilter || quickFilter;

  // ──── Loading State ────
  if (tasksLoading) {
    return (
      <div className="px-3 pt-2 pb-3 sm:px-4 sm:pt-2 sm:pb-4 lg:px-6 space-y-4" role="status" aria-busy="true">
        <style>{taskAnimations}</style>
        <div className="flex items-center gap-2">
          <div className="h-6 w-24 rounded bg-muted animate-pulse" />
          <div className="h-8 w-64 rounded bg-muted animate-pulse" />
          <div className="ml-auto flex gap-2">
            <div className="h-8 w-20 rounded bg-muted animate-pulse" />
            <div className="h-8 w-20 rounded bg-muted animate-pulse" />
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-20 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-muted animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  // ──── Quick filter pill counts (memoized) ────
  const quickFilterCounts = useMemo(() => ({
    overdue:   stats.overdue,
    due_today: visibleTasks.filter(t => t._status !== "completed" && isDueToday(t.due_date)).length,
    my_tasks:  user ? visibleTasks.filter(t => t.assigned_to === user.id || t.assigned_to === user.email || t.assigned_to_team_id === user?.internal_team_id).length : 0,
    blocked:   visibleTasks.filter(t => t.is_blocked).length,
    timers:    stats.activeTimers,
    requests:  visibleTasks.filter(t => t._source.type === "revision").length,
  }), [visibleTasks, stats, user]);

  const quickFilters = [
    { key: "overdue",   label: "Overdue",       icon: AlertTriangle, count: quickFilterCounts.overdue },
    { key: "due_today", label: "Due Today",      icon: Clock,         count: quickFilterCounts.due_today },
    { key: "my_tasks",  label: "My Tasks",       icon: Users,         count: quickFilterCounts.my_tasks },
    { key: "blocked",   label: "Blocked",        icon: ShieldAlert,   count: quickFilterCounts.blocked },
    { key: "timers",    label: "Active Timers",  icon: Timer,         count: quickFilterCounts.timers },
    { key: "requests",  label: "Requests Only",  icon: Wrench,        count: quickFilterCounts.requests },
  ];

  return (
    <div className="px-3 pt-2 pb-3 sm:px-4 sm:pt-2 sm:pb-4 lg:px-6 space-y-2">
      <style>{taskAnimations}</style>

      {/* ════════ Header Row ════════ */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <ListChecks className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Tasks</h1>
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
              aria-label="Clear search"
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
            <SelectTrigger className="h-7 w-[130px] text-xs" aria-label="Group by">
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
          <div className="flex items-center h-7 rounded-md bg-muted p-0.5">
            <button
              onClick={() => setViewModePersisted("kanban")}
              className={cn("h-6 px-2.5 text-xs rounded-sm inline-flex items-center gap-1 transition-colors", viewMode === "kanban" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              <LayoutGrid className="h-3.5 w-3.5" />
              Kanban
            </button>
            <button
              onClick={() => setViewModePersisted("list")}
              className={cn("h-6 px-2.5 text-xs rounded-sm inline-flex items-center gap-1 transition-colors", viewMode === "list" ? "bg-background shadow-sm font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              <List className="h-3.5 w-3.5" />
              List
            </button>
          </div>
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

      {/* ════════ 5000 Task Limit Warning (Fix #2) ════════ */}
      {allTasks.length >= 5000 && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-400 text-xs">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          <span>Showing first 5,000 tasks. Some tasks may not be visible.</span>
        </div>
      )}

      {/* ════════ Quick Filter Pills ════════ */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Filter className="h-3.5 w-3.5 text-muted-foreground mr-0.5" />
        {quickFilters.map(qf => (
          <button
            key={qf.key}
            aria-label={qf.label}
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
            <SelectTrigger className="h-7 w-[110px] text-[11px]" aria-label="Filter by status">
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
              <SelectTrigger className="h-7 w-[120px] text-[11px]" aria-label="Filter by assignee">
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
              <SelectTrigger className="h-7 w-[120px] text-[11px]" aria-label="Filter by role">
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
            <SelectTrigger className="h-7 w-[100px] text-[11px]" aria-label="Filter by source">
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

      {/* ════════ Empty State (Fix #7, #13 — Card pattern) ════════ */}
      {filteredTasks.length === 0 && !tasksLoading && (
        <Card className="border-dashed border-2">
          <CardContent className="py-16 text-center">
            <div className="flex flex-col items-center justify-center">
              <ListChecks className="h-10 w-10 text-muted-foreground/40 mb-3" />
              {visibleTasks.length === 0 ? (
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
          </CardContent>
        </Card>
      )}

      {/* ════════ Kanban View ════════ */}
      {viewMode === "kanban" && filteredTasks.length > 0 && (
        <ErrorBoundary fallbackLabel="Kanban">
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0 sm:overflow-x-visible">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 min-w-[800px] sm:min-w-0">
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
                                <TaskKanbanCard task={task} onToggle={toggleComplete} user={user} />
                              </div>
                            )}
                          </Draggable>
                        ))}
                        {provided.placeholder}
                        {tasks.length === 0 && (
                          <p className="text-xs text-muted-foreground/50 text-center py-6">No tasks</p>
                        )}
                        {hasMore && (
                          limit < 500 ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-full text-xs text-muted-foreground"
                              onClick={() => setKanbanLimits(prev => ({ ...prev, [statusKey]: Math.min((prev[statusKey] || 100) + 100, 500) }))}
                            >
                              Show {Math.min(tasks.length - limit, 100)} more
                            </Button>
                          ) : (
                            <p className="text-xs text-muted-foreground/60 text-center py-2">
                              Open project to see all {tasks.length} tasks
                            </p>
                          )
                        )}
                      </div>
                    )}
                  </Droppable>
                </div>
              );
            })}
          </div>
          </div>
        </DragDropContext>
        </ErrorBoundary>
      )}

      {/* ════════ List View ════════ */}
      {viewMode === "list" && filteredTasks.length > 0 && (
        <ErrorBoundary fallbackLabel="Task List">
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
                      aria-expanded={!collapsed}
                      aria-label={group.label}
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
                        expandedTaskId={expandedTaskId}
                        setExpandedTaskId={setExpandedTaskId}
                        canEdit={canEdit}
                        user={user}
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
              expandedTaskId={expandedTaskId}
              setExpandedTaskId={setExpandedTaskId}
              canEdit={canEdit}
              user={user}
            />
          )}
        </div>
        </ErrorBoundary>
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
    <Card className={cn("rounded-xl border-0 shadow-sm", highlight && "ring-1 ring-red-200 dark:ring-red-800")}>
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

const TaskKanbanCard = React.memo(function TaskKanbanCard({ task, onToggle, user }) {
  const t = task;
  const overdue = !t.is_completed && t.due_date && isOverdue(t.due_date);
  const dueToday = !t.is_completed && isDueToday(t.due_date);

  return (
    <Card className={cn(
      "rounded-lg border shadow-sm p-3 cursor-grab hover:shadow-lg transition-all duration-200 bg-background",
      overdue && "border-l-4 border-l-red-500"
    )}>
      <div className="space-y-2">
        {/* Row 1: checkbox + title */}
        <div className="flex items-start gap-2">
          {t.is_locked ? (
            <Lock className="mt-0.5 h-4 w-4 text-red-500 shrink-0" title="Locked — auto-completed onsite task" />
          ) : t.is_blocked ? (
            <ShieldAlert className="mt-0.5 h-4 w-4 text-amber-500 shrink-0" title="Blocked by dependencies" />
          ) : (
            <Checkbox
              checked={t.is_completed}
              onCheckedChange={() => onToggle(t)}
              className="mt-0.5 h-4 w-4"
              disabled={t.is_blocked}
              title={t.is_blocked ? "Complete dependencies first" : undefined}
              onClick={e => e.stopPropagation()}
            />
          )}
          <span className={cn(
            "text-sm font-medium leading-snug line-clamp-1 flex-1",
            t.is_completed && "line-through text-muted-foreground"
          )}>
            {t.title}
          </span>
          {overdue && (
            <Badge className="text-[9px] px-1 py-0 bg-red-600 text-white shrink-0">OVERDUE</Badge>
          )}
          {t._hasTimer && (
            <span className="relative flex h-2.5 w-2.5 shrink-0 mt-1" title="Active timer running">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
          )}
        </div>

        {/* Row 2: project address */}
        {t._project?.property_address && (
          <Link
            to={createPageUrl("ProjectDetails") + `?id=${t.project_id}&tab=tasks`}
            className="block text-[11px] text-muted-foreground hover:text-foreground truncate transition-colors"
            onClick={e => e.stopPropagation()}
          >
            {t._project.property_address}
          </Link>
        )}

        {/* Row 3: badges & meta (Fix #14 — Badge component for source) */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge className={cn("text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap border-0", t._source.color)}>
            {t._source.label}
          </Badge>

          {(() => {
            const assigneeName = t.assigned_to_name || t.assigned_to_team_name;
            const isTeam = !t.assigned_to_name && !!t.assigned_to_team_name;
            if (!assigneeName) return null;
            return isTeam ? (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0" title={assigneeName}>
                <Users className="h-3.5 w-3.5" />
                <span className="truncate max-w-[60px]">{assigneeName}</span>
              </span>
            ) : (
              <span
                className="flex items-center justify-center h-5 w-5 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0"
                title={assigneeName}
              >
                {initial(assigneeName)}
              </span>
            );
          })()}

          {t.due_date ? (
            <CountdownTimer dueDate={t.due_date} compact thresholds={{ warn: 4, danger: 1 }} />
          ) : t.is_blocked ? (
            <span className="text-xs text-amber-600">Awaiting dependencies</span>
          ) : null}
        </div>

        {/* Row 4: effort bar (Fix #17 — hidden for contractors) */}
        {user?.role !== 'contractor' && (t.estimated_minutes > 0 || t._effortSeconds > 0) && (
          <TaskEffortBadge
            estimatedMinutes={t.estimated_minutes || 0}
            actualSeconds={t._effortSeconds}
            compact
          />
        )}
      </div>
    </Card>
  );
});

/* ═══════════════════════════ Task Table ═══════════════════════════ */

function TaskTable({ tasks, selectedIds, toggleSelect, toggleSelectAll, toggleComplete, sortCol, sortDir, toggleSort, showHeader, expandedTaskId, setExpandedTaskId, canEdit, user }) {
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
            <tr className="border-b bg-muted/30 dark:bg-muted/10">
              <th scope="col" className="w-10 px-3 py-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleSelectAll}
                  className="h-3.5 w-3.5"
                />
              </th>
              <th scope="col" className="w-10 px-2 py-2"><SortHeader col="status" label="Status" /></th>
              <th scope="col" className="px-2 py-2 text-left"><SortHeader col="title" label="Task" /></th>
              <th scope="col" className="px-2 py-2 text-left hidden lg:table-cell"><SortHeader col="project" label="Project" /></th>
              <th scope="col" className="px-2 py-2 text-left hidden md:table-cell"><SortHeader col="assignee" label="Assigned" /></th>
              <th scope="col" className="px-2 py-2 text-left hidden xl:table-cell"><SortHeader col="role" label="Role" /></th>
              <th scope="col" className="px-2 py-2 text-left hidden xl:table-cell"><SortHeader col="source" label="Source" /></th>
              <th scope="col" className="px-2 py-2 text-left"><SortHeader col="due" label="Due" /></th>
              <th scope="col" className="px-2 py-2 text-left hidden md:table-cell"><SortHeader col="effort" label="Effort" /></th>
              <th scope="col" className="w-10 px-2 py-2 text-center hidden sm:table-cell">
                <Timer className="h-3 w-3 text-muted-foreground mx-auto" />
              </th>
            </tr>
          </thead>
        )}
        <tbody>
          {tasks.map(t => (
            <React.Fragment key={t.id}>
              <TaskRow
                task={t}
                selected={selectedIds.has(t.id)}
                toggleSelect={toggleSelect}
                toggleComplete={toggleComplete}
                expanded={expandedTaskId === t.id}
                onToggleExpand={() => setExpandedTaskId(expandedTaskId === t.id ? null : t.id)}
                user={user}
              />
              {expandedTaskId === t.id && (
                <tr><td colSpan={TABLE_COL_COUNT} className="p-0 border-t-0">
                  <TaskDetailPanel
                    task={t}
                    canEdit={canEdit}
                    onEdit={() => {}}
                    onDelete={() => {}}
                    onUpdateDeadline={(id, data) => {
                      api.entities.ProjectTask.update(id, data).then(() => refetchEntityList("ProjectTask"));
                    }}
                    thresholds={{ warn: 4, danger: 1 }}
                    projectId={t.project_id}
                    project={t._project}
                    user={user}
                    onClose={() => setExpandedTaskId(null)}
                  />
                </td></tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ═══════════════════════════ Task Row ═══════════════════════════ */

const TaskRow = React.memo(function TaskRow({ task, selected, toggleSelect, toggleComplete, expanded, onToggleExpand, user }) {
  const t = task;
  const cfg = STATUS_CONFIG[t._status];
  const overdue = !t.is_completed && t.due_date && isOverdue(t.due_date);
  const dueToday = !t.is_completed && isDueToday(t.due_date);

  return (
    <tr
      onClick={onToggleExpand}
      className={cn(
        "border-b hover:bg-muted/30 transition-colors cursor-pointer",
        selected && "bg-primary/5",
        expanded && "bg-accent/30",
        overdue && "bg-red-50/50 dark:bg-red-950/20"
      )}
    >
      {/* Select */}
      <td className="w-10 px-3 py-2" onClick={e => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={() => toggleSelect(t.id)}
          className="h-3.5 w-3.5"
        />
      </td>

      {/* Status checkbox */}
      <td className="w-10 px-2 py-2" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-1">
          {t.is_locked ? (
            <Lock className="h-4 w-4 text-red-500" title="Locked — auto-completed onsite task" />
          ) : t.is_blocked ? (
            <ShieldAlert className="h-4 w-4 text-amber-500" title="Blocked by dependencies" />
          ) : (
            <Checkbox
              checked={t.is_completed}
              onCheckedChange={() => toggleComplete(t)}
              className="h-4 w-4"
            />
          )}
        </div>
      </td>

      {/* Task title + source inline (Fix #14 — Badge component) */}
      <td className="px-2 py-2 max-w-[300px]">
        <div className="flex items-center gap-1.5">
          <span className={cn(
            "text-sm font-medium truncate",
            t.is_completed && "line-through text-muted-foreground"
          )}>
            {t.title}
          </span>
          <Badge className={cn("text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap shrink-0 border-0", t._source.color)}>
            {t._source.label}
          </Badge>
        </div>
      </td>

      {/* Project (Fix #3 — shoot_date subtitle) */}
      <td className="px-2 py-2 hidden lg:table-cell max-w-[200px]" onClick={e => e.stopPropagation()}>
        {t._project?.property_address ? (
          <div>
            <Link
              to={createPageUrl("ProjectDetails") + `?id=${t.project_id}&tab=tasks`}
              className="text-xs text-muted-foreground hover:text-foreground truncate block transition-colors"
            >
              {t._project.property_address}
            </Link>
            {t._project?.shoot_date && (
              <span className="text-[10px] text-muted-foreground">Shoot: {fmtDate(t._project.shoot_date)}</span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Assigned */}
      <td className="px-2 py-2 hidden md:table-cell">
        {(() => {
          const assigneeName = t.assigned_to_name || t.assigned_to_team_name;
          const isTeam = !t.assigned_to_name && !!t.assigned_to_team_name;
          if (!assigneeName) return <span className="text-xs text-muted-foreground/50">--</span>;
          return (
            <div className="flex items-center gap-1.5">
              {isTeam ? (
                <Users className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <span className="flex items-center justify-center h-5 w-5 rounded-full bg-muted text-[10px] font-bold text-muted-foreground shrink-0">
                  {initial(assigneeName)}
                </span>
              )}
              <span className="text-xs truncate max-w-[100px]">{assigneeName}</span>
            </div>
          );
        })()}
      </td>

      {/* Role */}
      <td className="px-2 py-2 hidden xl:table-cell">
        {t.auto_assign_role && t.auto_assign_role !== "none" ? (
          <Badge variant="outline" className="text-[10px] font-medium">{ROLE_LABELS[t.auto_assign_role] || t.auto_assign_role}</Badge>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Source */}
      <td className="px-2 py-2 hidden xl:table-cell">
        <Badge className={cn("text-[10px] font-semibold px-1.5 py-0.5 whitespace-nowrap border-0", t._source.color)}>
          {t._source.label}
        </Badge>
      </td>

      {/* Due date (Fix #12 — amber for blocked) */}
      <td className="px-2 py-2">
        {t.due_date ? (
          <CountdownTimer dueDate={t.due_date} compact thresholds={{ warn: 4, danger: 1 }} />
        ) : t.is_blocked ? (
          <Badge variant="outline" className="text-[10px] text-amber-600 border-amber-200 dark:text-amber-400 dark:border-amber-800">Blocked</Badge>
        ) : (
          <span className="text-xs text-muted-foreground/50">--</span>
        )}
      </td>

      {/* Effort (Fix #17 — hidden for contractors) */}
      <td className="px-2 py-2 hidden md:table-cell">
        {user?.role !== 'contractor' ? (
          <TaskEffortBadge
            estimatedMinutes={t.estimated_minutes || 0}
            actualSeconds={t._effortSeconds}
            compact
          />
        ) : (
          <span className="text-xs text-muted-foreground/30">--</span>
        )}
      </td>

      {/* Timer */}
      <td className="w-10 px-2 py-2 text-center hidden sm:table-cell">
        {t._hasTimer ? (
          <span className="relative flex h-2.5 w-2.5 mx-auto" title="Active timer running">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
          </span>
        ) : (
          <span className="text-xs text-muted-foreground/30">--</span>
        )}
      </td>
    </tr>
  );
});

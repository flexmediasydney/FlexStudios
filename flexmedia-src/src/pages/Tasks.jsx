/**
 * Tasks — Global task view across all projects.
 * Simple list view with filters, stats, and inline detail expansion.
 */
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useActiveTimers } from "@/components/utilization/ActiveTimersContext";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import { CountdownTimer } from "@/components/projects/TaskManagement";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  ListChecks, Search, CheckCircle2, Circle, Timer, ShieldAlert, Lock,
  AlertTriangle, X, Clock, Users, ChevronDown, ChevronUp, Activity, TrendingUp, List as ListIcon
} from "lucide-react";

// ── Helpers ──────────────────────────────────────────────────────────────────

const ROLE_LABELS = {
  none: "Unassigned", project_owner: "Project Owner", photographer: "Photographer",
  videographer: "Videographer", image_editor: "Image Editor", video_editor: "Video Editor",
  floorplan_editor: "Floorplan Editor", drone_editor: "Drone Editor",
};

function getTaskSource(task, productMap, packageMap) {
  const tid = task.template_id || "";
  if (tid.startsWith("product:")) {
    const prod = productMap?.get(task.product_id) || productMap?.get(tid.split(":")[1]);
    return { label: prod?.name || "Product", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
  }
  if (tid.startsWith("package:")) {
    const pkg = packageMap?.get(task.package_id) || packageMap?.get(tid.split(":")[1]);
    return { label: pkg?.name || "Package", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
  }
  if (tid.startsWith("project_type:")) return { label: "Project Level", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
  if (tid.startsWith("onsite:")) return { label: "Onsite", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" };
  if (/^\[Revision #\d+\]/.test(task.title || "")) return { label: "Request", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" };
  return { label: "Manual", color: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400" };
}

function getTaskStatus(task, timerSet) {
  if (task.is_completed) return "completed";
  if (task.is_blocked) return "blocked";
  if (timerSet.has(task.id)) return "in_progress";
  return "not_started";
}

function todayStr() { return new Date().toLocaleDateString("en-CA"); }
function isOverdue(dueDate) {
  if (!dueDate) return false;
  try { return new Date(fixTimestamp(dueDate)) < new Date(); } catch { return false; }
}

function fmtDuration(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function Tasks() {
  // Data
  const { data: allTasks = [], loading: tasksLoading } = useEntityList("ProjectTask", "order", 5000);
  const { data: projects = [] } = useEntityList("Project", "-shoot_date");
  const { data: timeLogs = [] } = useEntityList("TaskTimeLog", "-created_at");
  const { data: products = [] } = useEntityList("Product", "name");
  const { data: packages = [] } = useEntityList("Package", "name");
  const { data: user } = useCurrentUser();
  const { activeTimers = [] } = useActiveTimers();

  // State
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [quickFilter, setQuickFilter] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortCol, setSortCol] = useState("status");
  const [sortDir, setSortDir] = useState("asc");
  const searchTimer = useRef(null);

  // Permission
  const canEdit = user && ["master_admin", "admin", "manager", "employee"].includes(user.role);

  // Search debounce
  const handleSearch = useCallback((val) => {
    setSearchInput(val);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearchQuery(val), 200);
  }, []);
  useEffect(() => () => { if (searchTimer.current) clearTimeout(searchTimer.current); }, []);

  // Real-time subscription
  useEffect(() => {
    try {
      const unsub = api.entities.ProjectTask.subscribe(() => refetchEntityList("ProjectTask"));
      return typeof unsub === "function" ? () => unsub() : undefined;
    } catch { return undefined; }
  }, []);

  // Lookup maps
  const projectMap = useMemo(() => new Map(projects.map(p => [p.id, p])), [projects]);
  const productMap = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);
  const packageMap = useMemo(() => new Map(packages.map(p => [p.id, p])), [packages]);
  const timerSet = useMemo(() => new Set((activeTimers || []).filter(t => t.is_active && t.status === "running").map(t => t.task_id)), [activeTimers]);

  // Effort by task
  const effortByTask = useMemo(() => {
    const m = {};
    (timeLogs || []).forEach(log => {
      if (!log.task_id || log.task_deleted) return;
      m[log.task_id] = (m[log.task_id] || 0) + (log.total_seconds || 0);
    });
    return m;
  }, [timeLogs]);

  // Enriched tasks
  const enrichedTasks = useMemo(() => {
    return allTasks
      .filter(t => !t.is_deleted && !t.is_archived)
      .map(t => ({
        ...t,
        _status: getTaskStatus(t, timerSet),
        _source: getTaskSource(t, productMap, packageMap),
        _project: projectMap.get(t.project_id),
        _effortSeconds: effortByTask[t.id] || 0,
        _hasTimer: timerSet.has(t.id),
        _assigneeName: t.assigned_to_name || t.assigned_to_team_name || "",
        _isTeam: !t.assigned_to_name && !!t.assigned_to_team_name,
        _overdue: !t.is_completed && !t.is_blocked && isOverdue(t.due_date),
      }));
  }, [allTasks, timerSet, effortByTask, projectMap, productMap, packageMap]);

  // Visible tasks (contractor filter)
  const visibleTasks = useMemo(() => {
    if (user?.role === "contractor") return enrichedTasks.filter(t => t.assigned_to === user.id);
    return enrichedTasks;
  }, [enrichedTasks, user]);

  // Stats
  const stats = useMemo(() => {
    const today = todayStr();
    const total = visibleTasks.length;
    const completed = visibleTasks.filter(t => t._status === "completed").length;
    const completedToday = visibleTasks.filter(t => t.is_completed && t.completed_at?.slice(0, 10) === today).length;
    const overdue = visibleTasks.filter(t => t._overdue).length;
    const timers = visibleTasks.filter(t => t._hasTimer).length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    let effortToday = 0;
    (timeLogs || []).forEach(log => {
      if (!log.task_deleted && log.created_at?.slice(0, 10) === today) effortToday += (log.total_seconds || 0);
    });
    return { total, completed, completedToday, overdue, timers, pct, effortToday };
  }, [visibleTasks, timeLogs]);

  // Filtered tasks
  const filteredTasks = useMemo(() => {
    return visibleTasks.filter(t => {
      if (statusFilter !== "all" && t._status !== statusFilter) return false;
      if (quickFilter === "overdue" && !t._overdue) return false;
      if (quickFilter === "blocked" && !t.is_blocked) return false;
      if (quickFilter === "timers" && !t._hasTimer) return false;
      if (quickFilter === "my_tasks" && t.assigned_to !== user?.id) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        const matches = (t.title || "").toLowerCase().includes(q) ||
          (t._assigneeName || "").toLowerCase().includes(q) ||
          (t._project?.property_address || "").toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  }, [visibleTasks, statusFilter, quickFilter, searchQuery, user]);

  // Sorted tasks
  const sortedTasks = useMemo(() => {
    const arr = [...filteredTasks];
    arr.sort((a, b) => {
      let cmp = 0;
      switch (sortCol) {
        case "status": cmp = (a._status || "").localeCompare(b._status || ""); break;
        case "title": cmp = (a.title || "").localeCompare(b.title || ""); break;
        case "project": cmp = (a._project?.property_address || "").localeCompare(b._project?.property_address || ""); break;
        case "assignee": cmp = (a._assigneeName || "").localeCompare(b._assigneeName || ""); break;
        case "due": cmp = (a.due_date || "9999").localeCompare(b.due_date || "9999"); break;
        default: cmp = 0;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return arr;
  }, [filteredTasks, sortCol, sortDir]);

  // Toggle complete
  const togglingRef = useRef(new Set());
  const toggleComplete = useCallback(async (task) => {
    if (!canEdit) { toast.error("No permission to edit tasks"); return; }
    if (task.is_locked) { toast.info(`"${String(task.title)}" is locked`); return; }
    if (task.is_blocked) { toast.info(`"${String(task.title)}" is blocked — complete dependencies first`); return; }
    if (togglingRef.current.has(task.id)) return;
    togglingRef.current.add(task.id);
    try {
      const wasCompleted = task.is_completed;
      await api.entities.ProjectTask.update(task.id, {
        is_completed: !wasCompleted,
        ...(wasCompleted ? { completed_at: null } : { completed_at: new Date().toISOString() }),
      });
      refetchEntityList("ProjectTask");
      toast.success(wasCompleted ? "Task reopened" : "Task completed");
      // Audit + deadline sync
      api.entities.ProjectActivity.create({
        project_id: task.project_id,
        action: "task_completed",
        activity_type: "status_change",
        description: `Task "${String(task.title)}" ${wasCompleted ? "reopened" : "completed"} from Tasks page`,
        user_id: user?.id,
        user_name: user?.full_name || user?.email,
        project_title: task._project?.title || task._project?.property_address || "",
      }).catch(() => {});
      if (task.project_id) {
        api.functions.invoke("calculateProjectTaskDeadlines", { project_id: task.project_id, trigger_event: "task_toggle" }).catch(() => {});
      }
    } catch { toast.error("Failed to update task"); }
    finally { togglingRef.current.delete(task.id); }
  }, [canEdit, user]);

  // Bulk select
  const toggleSelect = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const bulkComplete = useCallback(async () => {
    if (!canEdit) return;
    const tasks = sortedTasks.filter(t => selectedIds.has(t.id) && !t.is_completed && !t.is_locked && !t.is_blocked);
    if (tasks.length === 0) { toast.info("No completable tasks selected"); return; }
    const results = await Promise.allSettled(tasks.map(t =>
      api.entities.ProjectTask.update(t.id, { is_completed: true, completed_at: new Date().toISOString() })
    ));
    const ok = results.filter(r => r.status === "fulfilled").length;
    refetchEntityList("ProjectTask");
    setSelectedIds(new Set());
    toast.success(`${ok} task${ok !== 1 ? "s" : ""} completed`);
  }, [canEdit, sortedTasks, selectedIds]);

  // Sort toggle
  const toggleSort = useCallback((col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }, [sortCol]);

  // Loading
  if (tasksLoading) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6 space-y-4">
        <div className="h-8 w-40 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={`s${i}`} className="h-16 bg-muted rounded-xl animate-pulse" />)}
        </div>
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => <div key={`r${i}`} className="h-12 bg-muted rounded animate-pulse" />)}
        </div>
      </div>
    );
  }

  // Quick filter pills
  const pills = [
    { key: "overdue", label: "Overdue", count: stats.overdue, icon: AlertTriangle },
    { key: "blocked", label: "Blocked", count: visibleTasks.filter(t => t.is_blocked).length, icon: ShieldAlert },
    { key: "timers", label: "Active Timers", count: stats.timers, icon: Timer },
    { key: "my_tasks", label: "My Tasks", count: user ? visibleTasks.filter(t => t.assigned_to === user.id).length : 0, icon: Users },
  ];

  const hasFilters = searchQuery || statusFilter !== "all" || quickFilter;

  const SortHeader = ({ col, label }) => (
    <button
      className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => toggleSort(col)}
    >
      {label}
      {sortCol === col && (sortDir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </button>
  );

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Tasks</h1>
          <Badge variant="secondary" className="text-xs">{String(filteredTasks.length)}</Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7 h-8 w-48 text-sm"
              placeholder="Search..."
              value={searchInput}
              onChange={e => handleSearch(e.target.value)}
            />
            {searchInput && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => { handleSearch(""); }} aria-label="Clear search">
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
          {/* Status filter */}
          <select
            className="h-8 px-2 text-xs border rounded-md bg-background"
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
          >
            <option value="all">All Status</option>
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
      </div>

      {/* Stats strip */}
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard label="Active" value={String(stats.total - stats.completed)} icon={ListChecks} />
        <StatCard label="Done Today" value={String(stats.completedToday)} icon={CheckCircle2} color="text-green-600" />
        <StatCard label="Overdue" value={String(stats.overdue)} icon={AlertTriangle} color={stats.overdue > 0 ? "text-red-600" : undefined} />
        <StatCard label="Timers" value={String(stats.timers)} icon={Timer} color="text-blue-600" />
        <StatCard label="Complete" value={`${stats.pct}%`} icon={TrendingUp} color="text-emerald-600" />
        <StatCard label="Effort Today" value={fmtDuration(stats.effortToday)} icon={Activity} />
      </div>

      {/* Quick filter pills */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {pills.map(p => (
          <button
            key={p.key}
            onClick={() => setQuickFilter(quickFilter === p.key ? "" : p.key)}
            className={cn(
              "inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium transition-colors border",
              quickFilter === p.key ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
            )}
          >
            <p.icon className="h-3 w-3" />
            {p.label}
            {p.count > 0 && <span className="ml-0.5 tabular-nums">{String(p.count)}</span>}
          </button>
        ))}
        {hasFilters && (
          <button
            className="text-xs text-muted-foreground hover:text-foreground underline ml-1"
            onClick={() => { setSearchQuery(""); setSearchInput(""); setStatusFilter("all"); setQuickFilter(""); }}
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Task limit warning */}
      {allTasks.length >= 5000 && (
        <div className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-3 py-1.5">
          Showing first 5,000 tasks. Some tasks may not be visible.
        </div>
      )}

      {/* Table */}
      <ErrorBoundary fallbackLabel="Tasks Table">
        {sortedTasks.length === 0 ? (
          <Card className="border-dashed border-2">
            <CardContent className="py-16 text-center">
              <ListChecks className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
              <p className="text-sm font-medium text-muted-foreground">
                {hasFilters ? "No tasks match your filters" : "No tasks yet"}
              </p>
              {hasFilters && (
                <button className="text-xs text-primary mt-2 hover:underline" onClick={() => { setSearchQuery(""); setSearchInput(""); setStatusFilter("all"); setQuickFilter(""); }}>
                  Clear all filters
                </button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="overflow-x-auto border rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 dark:bg-muted/10">
                <tr>
                  <th className="w-8 px-2 py-2">
                    <Checkbox
                      checked={selectedIds.size === sortedTasks.length && sortedTasks.length > 0}
                      onCheckedChange={() => {
                        if (selectedIds.size === sortedTasks.length) setSelectedIds(new Set());
                        else setSelectedIds(new Set(sortedTasks.map(t => t.id)));
                      }}
                    />
                  </th>
                  <th scope="col" className="w-10 px-2 py-2"><SortHeader col="status" label="" /></th>
                  <th scope="col" className="px-2 py-2 text-left"><SortHeader col="title" label="Task" /></th>
                  <th scope="col" className="px-2 py-2 text-left hidden lg:table-cell"><SortHeader col="project" label="Project" /></th>
                  <th scope="col" className="px-2 py-2 text-left hidden md:table-cell"><SortHeader col="assignee" label="Assigned" /></th>
                  <th scope="col" className="px-2 py-2 text-left"><SortHeader col="due" label="Due" /></th>
                  <th scope="col" className="px-2 py-2 text-left hidden md:table-cell">Effort</th>
                  <th scope="col" className="w-8 px-2 py-2 hidden sm:table-cell">
                    <Timer className="h-3 w-3 text-muted-foreground mx-auto" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedTasks.map(t => (
                  <React.Fragment key={t.id}>
                    <tr
                      className={cn(
                        "hover:bg-muted/30 transition-colors cursor-pointer border-t",
                        t._overdue && "bg-red-50/50 dark:bg-red-950/20",
                        expandedTaskId === t.id && "bg-accent/30"
                      )}
                      onClick={() => setExpandedTaskId(expandedTaskId === t.id ? null : t.id)}
                    >
                      {/* Select */}
                      <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                        <Checkbox
                          checked={selectedIds.has(t.id)}
                          onCheckedChange={() => toggleSelect(t.id)}
                        />
                      </td>

                      {/* Status checkbox */}
                      <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                        {t.is_locked ? (
                          <Lock className="h-4 w-4 text-red-500" title="Locked — auto-completed onsite task" />
                        ) : t.is_blocked ? (
                          <ShieldAlert className="h-4 w-4 text-amber-500" title="Blocked by dependencies" />
                        ) : (
                          <Checkbox
                            checked={t.is_completed}
                            onCheckedChange={() => toggleComplete(t)}
                            className={cn(t.is_completed && "data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600")}
                          />
                        )}
                      </td>

                      {/* Title + source */}
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className={cn("text-sm truncate", t.is_completed && "line-through text-muted-foreground")}>
                            {String(t.title || "Untitled")}
                          </span>
                          <Badge className={cn("text-[9px] px-1.5 py-0 shrink-0 border-0 whitespace-nowrap", t._source.color)}>
                            {String(t._source.label)}
                          </Badge>
                          {t._overdue && <Badge className="text-[9px] px-1 py-0 bg-red-600 text-white border-0 shrink-0">OVERDUE</Badge>}
                        </div>
                      </td>

                      {/* Project */}
                      <td className="px-2 py-2 hidden lg:table-cell" onClick={e => e.stopPropagation()}>
                        {t._project ? (
                          <Link
                            to={createPageUrl("ProjectDetails") + `?id=${t.project_id}&tab=tasks`}
                            className="text-xs text-muted-foreground hover:text-primary hover:underline truncate block max-w-[180px]"
                          >
                            {String(t._project.property_address || t._project.title || "—")}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted-foreground/40">—</span>
                        )}
                      </td>

                      {/* Assignee */}
                      <td className="px-2 py-2 hidden md:table-cell">
                        {t._assigneeName ? (
                          <div className="flex items-center gap-1.5">
                            {t._isTeam ? (
                              <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            ) : (
                              <span className="w-5 h-5 rounded-full bg-muted text-[10px] font-bold flex items-center justify-center text-muted-foreground shrink-0">
                                {String(t._assigneeName).charAt(0).toUpperCase()}
                              </span>
                            )}
                            <span className="text-xs truncate max-w-[100px]">{String(t._assigneeName)}</span>
                          </div>
                        ) : (
                          <span className="text-xs text-muted-foreground/40">—</span>
                        )}
                      </td>

                      {/* Due */}
                      <td className="px-2 py-2">
                        {t.is_blocked && !t.due_date ? (
                          <span className="text-[10px] text-amber-600">Awaiting deps</span>
                        ) : t.due_date ? (
                          <CountdownTimer dueDate={t.due_date} compact thresholds={{ yellow_start: 12, yellow_end: 6, red_threshold: 4 }} />
                        ) : (
                          <span className="text-xs text-muted-foreground/30">—</span>
                        )}
                      </td>

                      {/* Effort */}
                      <td className="px-2 py-2 hidden md:table-cell">
                        {(t.estimated_minutes > 0 || t._effortSeconds > 0) ? (
                          <span className="text-[10px] text-muted-foreground tabular-nums">
                            {fmtDuration(t._effortSeconds)} / {t.estimated_minutes ? fmtDuration(t.estimated_minutes * 60) : "—"}
                          </span>
                        ) : (
                          <span className="text-xs text-muted-foreground/30">—</span>
                        )}
                      </td>

                      {/* Timer */}
                      <td className="px-2 py-2 text-center hidden sm:table-cell">
                        {t._hasTimer && (
                          <span className="relative flex h-2.5 w-2.5 mx-auto" title="Active timer running">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                          </span>
                        )}
                      </td>
                    </tr>

                    {/* Expanded detail panel */}
                    {expandedTaskId === t.id && (
                      <tr>
                        <td colSpan={8} className="p-0 border-t-0">
                          <ErrorBoundary fallbackLabel="Task Detail">
                            <TaskDetailPanel
                              task={t}
                              canEdit={canEdit}
                              onEdit={() => {}}
                              onDelete={() => {}}
                              onUpdateDeadline={(id, data) => {
                                api.entities.ProjectTask.update(id, data).then(() => refetchEntityList("ProjectTask")).catch(() => toast.error("Failed"));
                              }}
                              thresholds={{ yellow_start: 12, yellow_end: 6, red_threshold: 4 }}
                              projectId={t.project_id}
                              project={t._project}
                              user={user}
                              onClose={() => setExpandedTaskId(null)}
                            />
                          </ErrorBoundary>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </ErrorBoundary>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-background border shadow-lg rounded-lg px-4 py-2 flex items-center gap-3">
          <span className="text-sm font-medium">{String(selectedIds.size)} selected</span>
          <Button size="sm" onClick={bulkComplete}>Mark Complete</Button>
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>Clear</Button>
        </div>
      )}
    </div>
  );
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>{value}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

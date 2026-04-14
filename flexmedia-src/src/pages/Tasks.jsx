/**
 * Tasks — Global task view across all projects.
 * Kanban board (default) + List view with filters, stats, DnD, grouping & sorting.
 *
 * CRITICAL: All dropdowns MUST use native <select> — Radix Select causes React #310 crashes.
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
import TaskDetailPanel from "@/components/projects/TaskDetailPanel";
import TaskEffortBadge from "@/components/projects/TaskEffortBadge";
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
  AlertTriangle, X, Clock, Users, ChevronDown, ChevronUp, ChevronRight,
  Activity, TrendingUp, List as ListIcon, Columns3, GripVertical
} from "lucide-react";

// ── Constants ───────────────────────────────────────────────────────────────

const ROLE_LABELS = {
  none: "Unassigned", project_owner: "Project Owner", photographer: "Photographer",
  videographer: "Videographer", image_editor: "Image Editor", video_editor: "Video Editor",
  floorplan_editor: "Floorplan Editor", drone_editor: "Drone Editor",
};

const KANBAN_STATUSES = [
  { id: "blocked", label: "Blocked", color: "bg-red-50/70 dark:bg-red-950/20", headerBg: "bg-red-100 dark:bg-red-900/40", headerText: "text-red-800 dark:text-red-300", icon: ShieldAlert },
  { id: "not_started", label: "Not Started", color: "bg-gray-50/70 dark:bg-gray-900/20", headerBg: "bg-gray-100 dark:bg-gray-800/40", headerText: "text-gray-700 dark:text-gray-300", icon: Circle },
  { id: "in_progress", label: "In Progress", color: "bg-blue-50/70 dark:bg-blue-950/20", headerBg: "bg-blue-100 dark:bg-blue-900/40", headerText: "text-blue-800 dark:text-blue-300", icon: Timer },
  { id: "completed", label: "Completed", color: "bg-green-50/70 dark:bg-green-950/20", headerBg: "bg-green-100 dark:bg-green-900/40", headerText: "text-green-800 dark:text-green-300", icon: CheckCircle2 },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTaskSource(task, productMap, packageMap) {
  const tid = task.template_id || "";
  if (tid.startsWith("product:")) {
    const prod = productMap?.get(task.product_id) || productMap?.get(tid.split(":")[1]);
    return { key: "product", label: prod?.name || "Product", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" };
  }
  if (tid.startsWith("package:")) {
    const pkg = packageMap?.get(task.package_id) || packageMap?.get(tid.split(":")[1]);
    return { key: "package", label: pkg?.name || "Package", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" };
  }
  if (tid.startsWith("project_type:")) return { key: "project", label: "Project Level", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" };
  if (tid.startsWith("onsite:")) return { key: "onsite", label: "Onsite", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" };
  if (/^\[Revision #\d+\]/.test(task.title || "")) return { key: "request", label: "Request", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" };
  return { key: "manual", label: "Manual", color: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400" };
}

function getTaskStatus(task, timerSet, effortByTask) {
  if (task.is_completed) return "completed";
  if (task.is_blocked) return "blocked";
  if (timerSet.has(task.id)) return "in_progress";
  if ((effortByTask?.[task.id] || 0) > 0) return "in_progress";
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

function parseDroppableId(id) {
  const parts = (id || "").split("::");
  return parts.length === 2 ? parts[1] : parts[0];
}

// ── Kanban Animation CSS ────────────────────────────────────────────────────

const kanbanStyles = `
@keyframes kanban-card-enter { from { opacity:0; transform:translateY(6px) scale(0.98); } to { opacity:1; transform:none; } }
.kanban-card-animated { animation: kanban-card-enter 0.2s ease-out both; }
.kanban-dragging { box-shadow: 0 16px 32px rgba(0,0,0,0.12), 0 0 0 2px rgba(59,130,246,0.35) !important; transform: rotate(1.5deg) scale(1.03) !important; z-index: 999; }
`;

// ── DueDateBadge ────────────────────────────────────────────────────────────

function DueDateBadge({ dueDate, isCompleted }) {
  if (!dueDate) return null;
  const today = todayStr();
  const dateStr = String(dueDate).slice(0, 10);
  const overdue = !isCompleted && dateStr < today;
  const isToday = dateStr === today;
  const color = overdue
    ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400"
    : isToday
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
      : "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400";
  let label;
  if (overdue) label = "Overdue";
  else if (isToday) label = "Today";
  else {
    try { label = new Date(fixTimestamp(dueDate)).toLocaleDateString("en-AU", { month: "short", day: "numeric" }); }
    catch { label = dateStr; }
  }
  return <span className={cn("text-[10px] rounded px-1.5 py-0.5 font-medium whitespace-nowrap", color)}>{label}</span>;
}

// ── TaskCard (Draggable) ────────────────────────────────────────────────────

const TaskCard = React.memo(function TaskCard({ task, index, isExpanded, onToggleExpand, draggingId }) {
  const isDragDisabled = task.is_locked || task.is_blocked || (!!draggingId && draggingId !== task.id);

  return (
    <Draggable draggableId={task.id} index={index} isDragDisabled={isDragDisabled}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          className={cn(
            "kanban-card-animated bg-card rounded-lg border shadow-sm p-2.5 space-y-1.5 cursor-pointer transition-all select-none",
            snapshot.isDragging && "kanban-dragging",
            task.is_locked && "opacity-50 cursor-not-allowed",
            task._overdue && !task.is_completed && "border-l-[3px] border-l-red-500",
            task.is_completed && "opacity-60",
            isExpanded && "ring-2 ring-primary/30",
          )}
          style={{ ...provided.draggableProps.style, animationDelay: `${Math.min(index, 15) * 25}ms` }}
          onClick={() => onToggleExpand(task.id)}
        >
          {/* Row 1: Title + timer dot */}
          <div className="flex items-start gap-1.5">
            <span className={cn("text-[13px] font-medium truncate flex-1 leading-tight", task.is_completed && "line-through text-muted-foreground")}>
              {String(task.title || "Untitled")}
            </span>
            {task._hasTimer && (
              <span className="relative flex h-2 w-2 shrink-0 mt-1">
                <span className="animate-ping absolute h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative rounded-full h-2 w-2 bg-green-500" />
              </span>
            )}
          </div>

          {/* Row 2: Project link */}
          {task._project && (
            <Link
              to={createPageUrl("ProjectDetails") + `?id=${task.project_id}&tab=tasks`}
              className="text-[11px] text-muted-foreground hover:text-primary hover:underline truncate block leading-tight"
              onClick={e => e.stopPropagation()}
            >
              {String(task._project.property_address || task._project.title || "—")}
            </Link>
          )}

          {/* Row 3: Metadata chips */}
          <div className="flex items-center gap-1.5 flex-wrap">
            {task._assigneeName ? (
              <span className="w-5 h-5 rounded-full bg-muted text-[9px] font-bold flex items-center justify-center shrink-0" title={String(task._assigneeName)}>
                {task._isTeam ? <Users className="h-3 w-3 text-muted-foreground" /> : String(task._assigneeName).charAt(0).toUpperCase()}
              </span>
            ) : null}

            {task.is_blocked && !task.due_date ? (
              <span className="text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-950/30 rounded px-1.5 py-0.5 whitespace-nowrap">Awaiting deps</span>
            ) : task.due_date ? (
              <DueDateBadge dueDate={task.due_date} isCompleted={task.is_completed} />
            ) : null}

            <Badge className={cn("text-[9px] px-1.5 py-0 border-0 whitespace-nowrap", task._source.color)}>
              {String(task._source.label)}
            </Badge>
          </div>

          {/* Row 4: Effort mini-bar */}
          {(task.estimated_minutes > 0 || task._effortSeconds > 0) && (
            <div className="pt-0.5">
              <TaskEffortBadge
                estimatedMinutes={task.estimated_minutes || 0}
                actualSeconds={task._effortSeconds}
                compact
              />
            </div>
          )}
        </div>
      )}
    </Draggable>
  );
});

// ── StatusColumn (Droppable) ────────────────────────────────────────────────

function StatusColumn({ statusDef, tasks, droppableId, expandedKanbanId, onToggleExpand, canEdit, user }) {
  return (
    <div className="flex-1 min-w-[230px]">
      {/* Column header */}
      <div className={cn("px-3 py-1.5 rounded-t-lg flex items-center justify-between", statusDef.headerBg)}>
        <div className="flex items-center gap-1.5">
          <statusDef.icon className={cn("h-3.5 w-3.5", statusDef.headerText)} />
          <span className={cn("text-xs font-semibold", statusDef.headerText)}>{statusDef.label}</span>
        </div>
        <span className={cn("text-xs font-bold tabular-nums", statusDef.headerText)}>{tasks.length}</span>
      </div>

      {/* Droppable area */}
      <Droppable droppableId={droppableId} isDropDisabled={statusDef.id === "blocked"}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "min-h-[100px] max-h-[calc(100vh-340px)] overflow-y-auto p-1.5 space-y-1.5 rounded-b-lg transition-colors border-x border-b",
              snapshot.isDraggingOver && statusDef.id !== "blocked"
                ? "bg-primary/10 ring-2 ring-primary/20"
                : statusDef.color,
              statusDef.id === "blocked" && snapshot.isDraggingOver && "ring-2 ring-red-300/50"
            )}
          >
            {tasks.map((task, i) => (
              <React.Fragment key={task.id}>
                <TaskCard
                  task={task}
                  index={i}
                  isExpanded={expandedKanbanId === task.id}
                  onToggleExpand={onToggleExpand}
                  draggingId={null}
                />
                {/* Inline expanded detail */}
                {expandedKanbanId === task.id && (
                  <div className="rounded-lg border border-primary/20 bg-card shadow-sm">
                    <ErrorBoundary fallbackLabel="Task Detail">
                      <TaskDetailPanel
                        task={task}
                        canEdit={canEdit}
                        onEdit={() => {}}
                        onDelete={() => {}}
                        onUpdateDeadline={(id, data) => {
                          api.entities.ProjectTask.update(id, data).then(() => refetchEntityList("ProjectTask")).catch(() => toast.error("Failed"));
                        }}
                        thresholds={{ yellow_start: 12, yellow_end: 6, red_threshold: 4 }}
                        projectId={task.project_id}
                        project={task._project}
                        user={user}
                        onClose={() => onToggleExpand(null)}
                      />
                    </ErrorBoundary>
                  </div>
                )}
              </React.Fragment>
            ))}
            {provided.placeholder}
            {tasks.length === 0 && !snapshot.isDraggingOver && (
              <div className="text-center text-[11px] text-muted-foreground/40 py-10">No tasks</div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

// ── SwimLane ─────────────────────────────────────────────────────────────────

function SwimLane({ laneKey, laneIndex, tasksByStatus, isCollapsed, onToggleCollapse, expandedKanbanId, onToggleExpand, canEdit, user }) {
  const totalCount = Object.values(tasksByStatus).reduce((sum, arr) => sum + arr.length, 0);

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Sticky header */}
      <button
        className="w-full flex items-center justify-between px-4 py-2 bg-muted/40 hover:bg-muted/60 transition-colors"
        onClick={() => onToggleCollapse(laneKey)}
      >
        <div className="flex items-center gap-2">
          {isCollapsed ? <ChevronRight className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          <span className="text-sm font-semibold">{String(laneKey)}</span>
          <Badge variant="secondary" className="text-[10px]">{totalCount}</Badge>
        </div>
        {/* Mini status breakdown */}
        <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
          {KANBAN_STATUSES.map(s => {
            const count = (tasksByStatus[s.id] || []).length;
            if (count === 0) return null;
            return (
              <span key={s.id} className="flex items-center gap-1 tabular-nums">
                <s.icon className={cn("h-3 w-3", s.headerText)} />
                {count}
              </span>
            );
          })}
        </div>
      </button>

      {/* Kanban columns within lane */}
      {!isCollapsed && (
        <div className="flex gap-1.5 p-2 overflow-x-auto">
          {KANBAN_STATUSES.map(statusDef => (
            <StatusColumn
              key={statusDef.id}
              statusDef={statusDef}
              tasks={tasksByStatus[statusDef.id] || []}
              droppableId={`${laneIndex}::${statusDef.id}`}
              expandedKanbanId={expandedKanbanId}
              onToggleExpand={onToggleExpand}
              canEdit={canEdit}
              user={user}
            />
          ))}
        </div>
      )}
    </div>
  );
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

  // State — shared
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [quickFilter, setQuickFilter] = useState("");
  const searchTimer = useRef(null);

  // State — view mode
  const [viewMode, setViewMode] = useState(() => {
    try { const v = localStorage.getItem("tasks_view_mode"); if (v === "kanban" || v === "list") return v; } catch {}
    return "kanban";
  });
  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem("tasks_view_mode", mode); } catch {}
  }, []);

  // State — kanban
  const [groupBy, setGroupBy] = useState("none");
  const [kanbanSort, setKanbanSort] = useState("due_date");
  const [expandedKanbanId, setExpandedKanbanId] = useState(null);
  const [collapsedLanes, setCollapsedLanes] = useState(new Set());
  const [draggingId, setDraggingId] = useState(null);

  // State — list view
  const [expandedTaskId, setExpandedTaskId] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [sortCol, setSortCol] = useState("status");
  const [sortDir, setSortDir] = useState("asc");

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
        _status: getTaskStatus(t, timerSet, effortByTask),
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

  // Filtered tasks (shared by both views)
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

  // ── Kanban: sort + group ────────────────────────────────────────────────

  const kanbanSortFn = useMemo(() => {
    const today = todayStr();
    return (a, b) => {
      switch (kanbanSort) {
        case "due_date":
          return (a.due_date || "9999").localeCompare(b.due_date || "9999");
        case "priority": {
          const rank = (t) => {
            if (!t.is_completed && t.due_date && t.due_date.slice(0, 10) < today) return 0;
            if (t.due_date && t.due_date.slice(0, 10) === today) return 1;
            if (t.due_date) return 2;
            return 3;
          };
          return rank(a) - rank(b);
        }
        case "effort": {
          const rem = (t) => (t.estimated_minutes || 0) * 60 - (t._effortSeconds || 0);
          return rem(b) - rem(a);
        }
        case "project":
          return (a._project?.property_address || "").localeCompare(b._project?.property_address || "");
        case "created":
          return (b.created_date || "").localeCompare(a.created_date || "");
        default: return 0;
      }
    };
  }, [kanbanSort]);

  // Tasks grouped by status (flat kanban)
  const tasksByStatus = useMemo(() => {
    const map = { blocked: [], not_started: [], in_progress: [], completed: [] };
    filteredTasks.forEach(t => {
      (map[t._status] || map.not_started).push(t);
    });
    Object.values(map).forEach(arr => arr.sort(kanbanSortFn));
    return map;
  }, [filteredTasks, kanbanSortFn]);

  // Swimlanes (when groupBy !== "none")
  const swimLanes = useMemo(() => {
    if (groupBy === "none") return null;

    const getGroupKey = (task) => {
      switch (groupBy) {
        case "assignee": return task._assigneeName || "Unassigned";
        case "project": return task._project?.property_address || task._project?.title || "No Project";
        case "role": return ROLE_LABELS[task.auto_assign_role] || ROLE_LABELS.none;
        case "source": return task._source.label;
        default: return "Other";
      }
    };

    const lanes = new Map();
    filteredTasks.forEach(t => {
      const key = getGroupKey(t);
      if (!lanes.has(key)) lanes.set(key, { blocked: [], not_started: [], in_progress: [], completed: [] });
      const lane = lanes.get(key);
      (lane[t._status] || lane.not_started).push(t);
    });

    for (const lane of lanes.values()) {
      Object.values(lane).forEach(arr => arr.sort(kanbanSortFn));
    }

    return [...lanes.entries()].sort(([a], [b]) => {
      if (a === "Unassigned" || a === "No Project") return 1;
      if (b === "Unassigned" || b === "No Project") return -1;
      return a.localeCompare(b);
    });
  }, [filteredTasks, groupBy, kanbanSortFn]);

  // ── List view: sort ─────────────────────────────────────────────────────

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

  // ── Drag & Drop ─────────────────────────────────────────────────────────

  const togglingRef = useRef(new Set());

  const onDragEnd = useCallback(async (result) => {
    setDraggingId(null);
    if (!result.destination) return;
    if (!canEdit) { toast.error("No permission to edit tasks"); return; }

    const taskId = result.draggableId;
    const task = filteredTasks.find(t => t.id === taskId);
    if (!task) return;

    const sourceStatus = parseDroppableId(result.source.droppableId);
    const destStatus = parseDroppableId(result.destination.droppableId);

    if (sourceStatus === destStatus) return;

    // Blocked column is read-only
    if (destStatus === "blocked") {
      toast.info("Blocked state is computed from dependencies — can't drag into Blocked.");
      return;
    }
    if (sourceStatus === "blocked") {
      toast.info("Clear dependencies first to unblock this task.");
      return;
    }

    // Locked tasks
    if (task.is_locked) {
      toast.info(`"${String(task.title)}" is locked.`);
      return;
    }

    // Prevent double-toggle
    if (togglingRef.current.has(taskId)) return;
    togglingRef.current.add(taskId);

    try {
      if (destStatus === "completed") {
        // Mark completed
        await api.entities.ProjectTask.update(taskId, {
          is_completed: true,
          completed_at: new Date().toISOString(),
        });
        refetchEntityList("ProjectTask");
        toast.success("Task completed");
        api.entities.ProjectActivity.create({
          project_id: task.project_id,
          action: "task_completed",
          activity_type: "status_change",
          description: `Task "${String(task.title)}" completed via Kanban`,
          user_id: user?.id,
          user_name: user?.full_name || user?.email,
          project_title: task._project?.title || task._project?.property_address || "",
        }).catch(() => {});
        if (task.project_id) {
          api.functions.invoke("calculateProjectTaskDeadlines", { project_id: task.project_id, trigger_event: "task_completed" }).catch(() => {});
        }
      } else if (sourceStatus === "completed" && destStatus !== "completed") {
        // Reopen task
        await api.entities.ProjectTask.update(taskId, {
          is_completed: false,
          completed_at: null,
        });
        refetchEntityList("ProjectTask");
        toast.success("Task reopened");
        api.entities.ProjectActivity.create({
          project_id: task.project_id,
          action: "task_completed",
          activity_type: "status_change",
          description: `Task "${String(task.title)}" reopened via Kanban`,
          user_id: user?.id,
          user_name: user?.full_name || user?.email,
          project_title: task._project?.title || task._project?.property_address || "",
        }).catch(() => {});
        if (task.project_id) {
          api.functions.invoke("calculateProjectTaskDeadlines", { project_id: task.project_id, trigger_event: "task_reopened" }).catch(() => {});
        }
      } else {
        // Not Started <-> In Progress: status is derived, no DB field to flip
        toast.info("Task status is computed from effort & timers. Start a timer or log effort to move to In Progress.", { duration: 4000 });
      }
    } catch {
      toast.error("Failed to update task");
    } finally {
      togglingRef.current.delete(taskId);
    }
  }, [canEdit, filteredTasks, user]);

  // ── Toggle complete (list view) ─────────────────────────────────────────

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

  // Sort toggle (list view)
  const toggleSort = useCallback((col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }, [sortCol]);

  // Kanban expand toggle
  const toggleKanbanExpand = useCallback((id) => {
    setExpandedKanbanId(prev => prev === id ? null : id);
  }, []);

  // Collapse/expand lane
  const toggleLaneCollapse = useCallback((key) => {
    setCollapsedLanes(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // ── Loading ─────────────────────────────────────────────────────────────

  if (tasksLoading) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6 space-y-4">
        <div className="h-8 w-40 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
          {Array.from({ length: 6 }).map((_, i) => <div key={`s${i}`} className="h-16 bg-muted rounded-xl animate-pulse" />)}
        </div>
        <div className="flex gap-2">
          {Array.from({ length: 4 }).map((_, i) => <div key={`k${i}`} className="flex-1 h-[400px] bg-muted rounded-lg animate-pulse" />)}
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
      <style>{kanbanStyles}</style>

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Tasks</h1>
          <Badge variant="secondary" className="text-xs">{String(filteredTasks.length)}</Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              className="pl-7 h-8 w-48 text-sm"
              placeholder="Search..."
              value={searchInput}
              onChange={e => handleSearch(e.target.value)}
            />
            {searchInput && (
              <button className="absolute right-2 top-1/2 -translate-y-1/2" onClick={() => handleSearch("")} aria-label="Clear search">
                <X className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>

          {/* Status filter — native select */}
          <select className="h-8 px-2 text-xs border rounded-md bg-background" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="not_started">Not Started</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
            <option value="blocked">Blocked</option>
          </select>

          {/* View toggle */}
          <div className="flex items-center border rounded-md overflow-hidden">
            <button
              className={cn("px-2.5 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors",
                viewMode === "kanban" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted text-muted-foreground")}
              onClick={() => setViewModePersisted("kanban")}
            >
              <Columns3 className="h-3.5 w-3.5" />
              Kanban
            </button>
            <button
              className={cn("px-2.5 py-1.5 text-xs font-medium flex items-center gap-1 transition-colors",
                viewMode === "list" ? "bg-primary text-primary-foreground" : "bg-background hover:bg-muted text-muted-foreground")}
              onClick={() => setViewModePersisted("list")}
            >
              <ListIcon className="h-3.5 w-3.5" />
              List
            </button>
          </div>

          {/* Kanban controls */}
          {viewMode === "kanban" && (
            <>
              <select className="h-8 px-2 text-xs border rounded-md bg-background" value={groupBy} onChange={e => { setGroupBy(e.target.value); setCollapsedLanes(new Set()); }}>
                <option value="none">No Grouping</option>
                <option value="assignee">Group: Assignee</option>
                <option value="project">Group: Project</option>
                <option value="role">Group: Role</option>
                <option value="source">Group: Source</option>
              </select>
              <select className="h-8 px-2 text-xs border rounded-md bg-background" value={kanbanSort} onChange={e => setKanbanSort(e.target.value)}>
                <option value="due_date">Sort: Due Date</option>
                <option value="priority">Sort: Priority</option>
                <option value="effort">Sort: Effort Left</option>
                <option value="project">Sort: Project</option>
                <option value="created">Sort: Newest</option>
              </select>
            </>
          )}
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

      {/* ═══════════════ KANBAN VIEW ═══════════════ */}
      {viewMode === "kanban" && (
        <ErrorBoundary fallbackLabel="Kanban Board">
          {filteredTasks.length === 0 ? (
            <Card className="border-dashed border-2">
              <CardContent className="py-16 text-center">
                <Columns3 className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
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
            <DragDropContext
              onDragStart={(start) => setDraggingId(start.draggableId)}
              onDragEnd={onDragEnd}
            >
              {groupBy === "none" ? (
                /* ─── Flat Kanban: 4 columns ─── */
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {KANBAN_STATUSES.map(statusDef => (
                    <StatusColumn
                      key={statusDef.id}
                      statusDef={statusDef}
                      tasks={tasksByStatus[statusDef.id] || []}
                      droppableId={statusDef.id}
                      expandedKanbanId={expandedKanbanId}
                      onToggleExpand={toggleKanbanExpand}
                      canEdit={canEdit}
                      user={user}
                    />
                  ))}
                </div>
              ) : (
                /* ─── Grouped Kanban: Swimlanes ─── */
                <div className="space-y-2">
                  {/* Collapse all / Expand all */}
                  {swimLanes && swimLanes.length > 3 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <button className="hover:text-foreground underline" onClick={() => setCollapsedLanes(new Set(swimLanes.map(([k]) => k)))}>Collapse all</button>
                      <span>·</span>
                      <button className="hover:text-foreground underline" onClick={() => setCollapsedLanes(new Set())}>Expand all</button>
                    </div>
                  )}
                  {(swimLanes || []).map(([laneKey, laneData], laneIndex) => (
                    <SwimLane
                      key={laneKey}
                      laneKey={laneKey}
                      laneIndex={laneIndex}
                      tasksByStatus={laneData}
                      isCollapsed={collapsedLanes.has(laneKey)}
                      onToggleCollapse={toggleLaneCollapse}
                      expandedKanbanId={expandedKanbanId}
                      onToggleExpand={toggleKanbanExpand}
                      canEdit={canEdit}
                      user={user}
                    />
                  ))}
                </div>
              )}
            </DragDropContext>
          )}
        </ErrorBoundary>
      )}

      {/* ═══════════════ LIST VIEW ═══════════════ */}
      {viewMode === "list" && (
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
                        <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                          <Checkbox checked={selectedIds.has(t.id)} onCheckedChange={() => toggleSelect(t.id)} />
                        </td>
                        <td className="px-2 py-2" onClick={e => e.stopPropagation()}>
                          {t.is_locked ? (
                            <Lock className="h-4 w-4 text-red-500" title="Locked" />
                          ) : t.is_blocked ? (
                            <ShieldAlert className="h-4 w-4 text-amber-500" title="Blocked" />
                          ) : (
                            <Checkbox
                              checked={t.is_completed}
                              onCheckedChange={() => toggleComplete(t)}
                              className={cn(t.is_completed && "data-[state=checked]:bg-green-600 data-[state=checked]:border-green-600")}
                            />
                          )}
                        </td>
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
                        <td className="px-2 py-2 hidden lg:table-cell" onClick={e => e.stopPropagation()}>
                          {t._project ? (
                            <Link
                              to={createPageUrl("ProjectDetails") + `?id=${t.project_id}&tab=tasks`}
                              className="text-xs text-muted-foreground hover:text-primary hover:underline truncate block max-w-[180px]"
                            >
                              {String(t._project.property_address || t._project.title || "—")}
                            </Link>
                          ) : <span className="text-xs text-muted-foreground/40">—</span>}
                        </td>
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
                          ) : <span className="text-xs text-muted-foreground/40">—</span>}
                        </td>
                        <td className="px-2 py-2">
                          {t.is_blocked && !t.due_date ? (
                            <span className="text-[10px] text-amber-600">Awaiting deps</span>
                          ) : t.due_date ? (
                            <CountdownTimer dueDate={t.due_date} compact thresholds={{ yellow_start: 12, yellow_end: 6, red_threshold: 4 }} />
                          ) : <span className="text-xs text-muted-foreground/30">—</span>}
                        </td>
                        <td className="px-2 py-2 hidden md:table-cell">
                          {(t.estimated_minutes > 0 || t._effortSeconds > 0) ? (
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {fmtDuration(t._effortSeconds)} / {t.estimated_minutes ? fmtDuration(t.estimated_minutes * 60) : "—"}
                            </span>
                          ) : <span className="text-xs text-muted-foreground/30">—</span>}
                        </td>
                        <td className="px-2 py-2 text-center hidden sm:table-cell">
                          {t._hasTimer && (
                            <span className="relative flex h-2.5 w-2.5 mx-auto" title="Active timer running">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
                            </span>
                          )}
                        </td>
                      </tr>
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
      )}

      {/* Bulk action bar (list view) */}
      {selectedIds.size > 0 && viewMode === "list" && (
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

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { usePermissions } from "@/components/auth/PermissionGuard";
import {
  GOAL_STAGES,
  GOAL_CATEGORIES,
  GOAL_QUARTERS,
  goalStageConfig,
} from "@/components/goals/goalStatuses";
import { GoalStatusBadge } from "@/components/goals/GoalStatusPipeline";
import GoalForm from "@/components/goals/GoalForm";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Target,
  Plus,
  Search,
  List,
  Columns3,
  Calendar,
  Flag,
  ChevronUp,
  ChevronDown,
  X,
  Layers,
  MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";
import { api } from "@/api/supabaseClient";

// ── Priority config ────────────────────────────────────────────────────────────

const PRIORITY_CONFIG = {
  1: { label: "Low", dotClass: "bg-slate-400", textClass: "text-slate-500", badgeClass: "bg-slate-100 text-slate-600 border-slate-200" },
  2: { label: "Below Avg", dotClass: "bg-blue-400", textClass: "text-blue-500", badgeClass: "bg-blue-50 text-blue-600 border-blue-200" },
  3: { label: "Normal", dotClass: "bg-amber-400", textClass: "text-amber-600", badgeClass: "bg-amber-50 text-amber-600 border-amber-200" },
  4: { label: "High", dotClass: "bg-orange-500", textClass: "text-orange-600", badgeClass: "bg-orange-100 text-orange-700 border-orange-200" },
  5: { label: "Critical", dotClass: "bg-red-500", textClass: "text-red-600", badgeClass: "bg-red-100 text-red-700 border-red-200" },
};

function PriorityDot({ priority, showLabel = false }) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG[3];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("h-2.5 w-2.5 rounded-full shrink-0", config.dotClass)} />
      {showLabel && (
        <span className={cn("text-xs font-medium", config.textClass)}>{config.label}</span>
      )}
    </span>
  );
}

function PriorityBadge({ priority }) {
  const config = PRIORITY_CONFIG[priority] || PRIORITY_CONFIG[3];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium border",
        config.badgeClass
      )}
    >
      <Flag className="h-2.5 w-2.5" />
      {config.label}
    </span>
  );
}

// ── Category badge ─────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  "Business Development": "bg-violet-100 text-violet-700 border-violet-200",
  "Operations": "bg-cyan-100 text-cyan-700 border-cyan-200",
  "Marketing & Branding": "bg-pink-100 text-pink-700 border-pink-200",
  "Technology & Tools": "bg-indigo-100 text-indigo-700 border-indigo-200",
  "Learning & Development": "bg-teal-100 text-teal-700 border-teal-200",
  "Client Experience": "bg-orange-100 text-orange-700 border-orange-200",
};

function CategoryBadge({ category }) {
  if (!category) return null;
  const colorClass = CATEGORY_COLORS[category] || "bg-muted text-muted-foreground border-border";
  return (
    <span className={cn("inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border truncate max-w-[140px]", colorClass)}>
      {category}
    </span>
  );
}

// ── Progress helpers ───────────────────────────────────────────────────────────

function calcProgress(goalId, tasksByGoal) {
  const tasks = tasksByGoal[goalId] || [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.is_completed && !t.is_deleted).length;
  return { total, done, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
}

// ── Owner name helper ──────────────────────────────────────────────────────────

function ownerName(ownerId, users) {
  if (!ownerId) return null;
  const u = users.find((u) => u.id === ownerId);
  if (!u) return null;
  return u.full_name || u.email || null;
}

function ownerInitials(name) {
  if (!name) return "?";
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

// ── Loading skeleton ───────────────────────────────────────────────────────────

function GoalsListSkeleton() {
  return (
    <div className="space-y-3 mt-4">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-16 w-full rounded-xl" />
      ))}
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────────

function EmptyState({ filtered, onClear, canCreate, onNew }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 gap-4 text-center">
      <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center">
        <Target className="h-8 w-8 text-muted-foreground" />
      </div>
      <div>
        <p className="text-base font-semibold text-foreground">
          {filtered ? "No goals match your filters" : "No goals yet"}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {filtered
            ? "Try adjusting the search or filters."
            : "Create your first goal to start tracking company progress."}
        </p>
      </div>
      {filtered ? (
        <Button variant="outline" size="sm" onClick={onClear}>
          <X className="h-4 w-4 mr-1.5" />
          Clear filters
        </Button>
      ) : canCreate ? (
        <Button size="sm" onClick={onNew}>
          <Plus className="h-4 w-4 mr-1.5" />
          New Goal
        </Button>
      ) : null}
    </div>
  );
}

// ── Goal card (shared between Board and compact List) ─────────────────────────

function GoalCard({ goal, tasksByGoal, users, isDragging = false, compact = false }) {
  const { total, done, pct } = calcProgress(goal.id, tasksByGoal);
  const name = ownerName(goal.project_owner_id, users);
  const initials = ownerInitials(name);

  return (
    <div
      className={cn(
        "rounded-xl border bg-card p-3 shadow-sm transition-all",
        isDragging && "shadow-2xl rotate-1 scale-[1.02] ring-2 ring-primary/30",
        !isDragging && "hover:shadow-md"
      )}
    >
      {/* Top row: status + priority */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <GoalStatusBadge status={goal.status} />
        {goal.goal_priority && <PriorityDot priority={goal.goal_priority} />}
      </div>

      {/* Title */}
      <Link
        to={createPageUrl(`GoalDetails?id=${goal.id}`)}
        className="block font-semibold text-sm text-foreground hover:text-primary transition-colors leading-snug line-clamp-2 mb-2"
      >
        {goal.title}
      </Link>

      {/* Category */}
      {goal.goal_category && (
        <div className="mb-2">
          <CategoryBadge category={goal.goal_category} />
        </div>
      )}

      {/* Quarter + Owner row */}
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground mb-2.5">
        {goal.goal_target_quarter && (
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            {goal.goal_target_quarter}
          </span>
        )}
        {name && (
          <span className="flex items-center gap-1 ml-auto">
            <span className="h-5 w-5 rounded-full bg-primary/10 text-primary text-[9px] font-bold flex items-center justify-center shrink-0">
              {initials}
            </span>
            <span className="truncate max-w-[80px]">{name}</span>
          </span>
        )}
      </div>

      {/* Progress */}
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{done} of {total} tasks</span>
          <span className="font-medium">{pct}%</span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>
    </div>
  );
}

// ── List row ───────────────────────────────────────────────────────────────────

function GoalListRow({ goal, tasksByGoal, users, childCounts }) {
  const { total, done, pct } = calcProgress(goal.id, tasksByGoal);
  const name = ownerName(goal.project_owner_id, users);
  const initials = ownerInitials(name);
  const childCount = childCounts[goal.id] || 0;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl border bg-card hover:bg-accent/40 transition-colors group">
      {/* Status */}
      <div className="shrink-0 w-28 hidden sm:flex">
        <GoalStatusBadge status={goal.status} />
      </div>

      {/* Title */}
      <div className="flex-1 min-w-0">
        <Link
          to={createPageUrl(`GoalDetails?id=${goal.id}`)}
          className="font-medium text-sm text-foreground hover:text-primary transition-colors truncate block"
        >
          {goal.title}
        </Link>
        {/* Mobile: show status under title */}
        <div className="flex items-center gap-1.5 mt-0.5 sm:hidden">
          <GoalStatusBadge status={goal.status} />
        </div>
      </div>

      {/* Category */}
      <div className="shrink-0 hidden md:flex">
        <CategoryBadge category={goal.goal_category} />
      </div>

      {/* Quarter */}
      <div className="shrink-0 w-20 text-xs text-muted-foreground hidden lg:block truncate">
        {goal.goal_target_quarter || "—"}
      </div>

      {/* Owner */}
      <div className="shrink-0 hidden lg:flex items-center gap-1.5 w-28">
        {name ? (
          <>
            <span className="h-6 w-6 rounded-full bg-primary/10 text-primary text-[10px] font-bold flex items-center justify-center shrink-0">
              {initials}
            </span>
            <span className="text-xs text-muted-foreground truncate">{name}</span>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </div>

      {/* Progress */}
      <div className="shrink-0 w-28 hidden sm:block">
        <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
          <span>{done}/{total}</span>
          <span className="font-medium">{pct}%</span>
        </div>
        <Progress value={pct} className="h-1.5" />
      </div>

      {/* Priority */}
      <div className="shrink-0 hidden md:flex items-center">
        <PriorityDot priority={goal.goal_priority} showLabel />
      </div>

      {/* Child count */}
      {childCount > 0 && (
        <div className="shrink-0 hidden lg:flex items-center gap-1 text-xs text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          <span>{childCount}</span>
        </div>
      )}
    </div>
  );
}

// ── Board column ───────────────────────────────────────────────────────────────

function BoardColumn({ stage, goals, tasksByGoal, users }) {
  const config = goalStageConfig(stage.value);
  return (
    <div className="flex flex-col min-w-[260px] max-w-[300px] w-full">
      {/* Column header */}
      <div
        className={cn(
          "flex items-center justify-between px-3 py-2.5 rounded-t-xl border border-b-0 font-semibold text-sm",
          config.color,
          config.textColor,
          config.borderColor
        )}
      >
        <span>{stage.label}</span>
        <span
          className={cn(
            "text-xs font-bold px-1.5 py-0.5 rounded-full",
            config.color,
            config.textColor
          )}
        >
          {goals.length}
        </span>
      </div>

      {/* Droppable area */}
      <Droppable droppableId={stage.value}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex-1 rounded-b-xl border p-2 space-y-2 min-h-[200px] transition-colors",
              config.borderColor,
              snapshot.isDraggingOver
                ? cn(config.color, "opacity-80")
                : "bg-muted/30"
            )}
          >
            {goals.map((goal, idx) => (
              <Draggable key={goal.id} draggableId={goal.id} index={idx}>
                {(prov, snap) => (
                  <div
                    ref={prov.innerRef}
                    {...prov.draggableProps}
                    {...prov.dragHandleProps}
                  >
                    <GoalCard
                      goal={goal}
                      tasksByGoal={tasksByGoal}
                      users={users}
                      isDragging={snap.isDragging}
                    />
                  </div>
                )}
              </Draggable>
            ))}
            {provided.placeholder}
            {goals.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
                No goals
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}

// ── Roadmap quarter group ──────────────────────────────────────────────────────

function RoadmapQuarterGroup({ quarter, goals, tasksByGoal, users }) {
  const [collapsed, setCollapsed] = useState(false);
  const activeGoals = goals.filter((g) => g.status === "goal_active");
  const completedGoals = goals.filter((g) => g.status === "goal_completed");

  return (
    <div className="border rounded-2xl overflow-hidden shadow-sm">
      {/* Header */}
      <button
        onClick={() => setCollapsed((v) => !v)}
        className="w-full flex items-center justify-between px-5 py-3.5 bg-muted/50 hover:bg-muted/80 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <span className="font-semibold text-base">{quarter}</span>
          <span className="text-sm text-muted-foreground">
            {goals.length} goal{goals.length !== 1 ? "s" : ""}
          </span>
          {activeGoals.length > 0 && (
            <span className="text-xs bg-blue-100 text-blue-700 border border-blue-200 rounded-full px-2 py-0.5 font-medium">
              {activeGoals.length} active
            </span>
          )}
          {completedGoals.length > 0 && (
            <span className="text-xs bg-emerald-100 text-emerald-700 border border-emerald-200 rounded-full px-2 py-0.5 font-medium">
              {completedGoals.length} done
            </span>
          )}
        </div>
        {collapsed ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        )}
      </button>

      {/* Goals grid */}
      {!collapsed && (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {goals.map((goal) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              tasksByGoal={tasksByGoal}
              users={users}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Sortable column header ─────────────────────────────────────────────────────

function SortableHeader({ label, field, sortBy, sortDir, onSort, className }) {
  const isActive = sortBy === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors",
        isActive && "text-foreground",
        className
      )}
    >
      {label}
      {isActive ? (
        sortDir === "asc" ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <MoreHorizontal className="h-3 w-3 opacity-30" />
      )}
    </button>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

const VIEW_MODES = [
  { id: "list", label: "List", Icon: List },
  { id: "board", label: "Board", Icon: Columns3 },
  { id: "roadmap", label: "Roadmap", Icon: Calendar },
];

const BUSINESS_AREAS = [
  "FlexMedia",
  "FlexStudios",
  "FlexAgency",
  "Shared",
];

export default function Goals() {
  const queryClient = useQueryClient();
  const { isManagerOrAbove } = usePermissions();

  // ── Data ────────────────────────────────────────────────────────────────────

  const { data: allGoalsRaw = [], loading: isLoading } = useEntityList("Project", "-created_at", 500);
  const goals = useMemo(
    () => allGoalsRaw.filter((p) => p.source === "goal"),
    [allGoalsRaw]
  );

  const { data: allTasks = [] } = useEntityList("ProjectTask", null, 2000);
  const { data: users = [] } = useEntityList("User", "full_name", 100);

  // Pre-compute tasks keyed by project/goal id for O(1) lookup
  const tasksByGoal = useMemo(() => {
    const map = {};
    for (const t of allTasks) {
      if (!t.project_id || t.is_deleted) continue;
      if (!map[t.project_id]) map[t.project_id] = [];
      map[t.project_id].push(t);
    }
    return map;
  }, [allTasks]);

  // Pre-compute child-goal counts
  const childCounts = useMemo(() => {
    const map = {};
    for (const g of goals) {
      if (g.parent_goal_id) {
        map[g.parent_goal_id] = (map[g.parent_goal_id] || 0) + 1;
      }
    }
    return map;
  }, [goals]);

  // ── UI state ────────────────────────────────────────────────────────────────

  const [viewMode, setViewMode] = useState(() => {
    try {
      const v = localStorage.getItem("goals_view_mode");
      if (["list", "board", "roadmap"].includes(v)) return v;
    } catch {}
    return "list";
  });

  const setViewModePersisted = useCallback((mode) => {
    setViewMode(mode);
    try { localStorage.setItem("goals_view_mode", mode); } catch {}
  }, []);

  const [searchInput, setSearchInput] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const searchTimerRef = useRef(null);

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearchQuery(value), 250);
  }, []);

  useEffect(() => () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current); }, []);
  useEffect(() => { if (searchQuery === "") setSearchInput(""); }, [searchQuery]);

  // Filters
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterCategory, setFilterCategory] = useState("all");
  const [filterArea, setFilterArea] = useState("all");
  const [filterOwner, setFilterOwner] = useState("all");
  const [filterQuarter, setFilterQuarter] = useState("all");

  // Sort
  const [sortBy, setSortBy] = useState("created_at");
  const [sortDir, setSortDir] = useState("desc");

  const handleSort = useCallback((field) => {
    setSortBy((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir("asc");
      return field;
    });
  }, []);

  // Goal form
  const [showForm, setShowForm] = useState(false);
  const [editingGoal, setEditingGoal] = useState(null);

  const handleNewGoal = useCallback(() => {
    setEditingGoal(null);
    setShowForm(true);
  }, []);

  const handleFormClose = useCallback(() => {
    setShowForm(false);
    setEditingGoal(null);
  }, []);

  const handleFormSave = useCallback(() => {
    refetchEntityList("Project");
  }, []);

  // ── Filtered + sorted goals ─────────────────────────────────────────────────

  const filteredGoals = useMemo(() => {
    let list = [...goals];

    // Search
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (g) =>
          g.title?.toLowerCase().includes(q) ||
          g.title_desc?.toLowerCase().includes(q) ||
          g.goal_category?.toLowerCase().includes(q) ||
          g.goal_target_quarter?.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (filterStatus !== "all") {
      list = list.filter((g) => g.status === filterStatus);
    }

    // Category filter
    if (filterCategory !== "all") {
      list = list.filter((g) => g.goal_category === filterCategory);
    }

    // Business area filter
    if (filterArea !== "all") {
      list = list.filter((g) => g.goal_business_area === filterArea);
    }

    // Owner filter
    if (filterOwner !== "all") {
      list = list.filter((g) => g.project_owner_id === filterOwner);
    }

    // Quarter filter
    if (filterQuarter !== "all") {
      list = list.filter((g) => g.goal_target_quarter === filterQuarter);
    }

    // Sort
    list.sort((a, b) => {
      let va, vb;
      switch (sortBy) {
        case "title":
          va = (a.title || "").toLowerCase();
          vb = (b.title || "").toLowerCase();
          break;
        case "status":
          va = a.status || "";
          vb = b.status || "";
          break;
        case "category":
          va = a.goal_category || "";
          vb = b.goal_category || "";
          break;
        case "quarter":
          va = a.goal_target_quarter || "";
          vb = b.goal_target_quarter || "";
          break;
        case "priority":
          va = a.goal_priority || 3;
          vb = b.goal_priority || 3;
          break;
        case "progress":
          va = calcProgress(a.id, tasksByGoal).pct;
          vb = calcProgress(b.id, tasksByGoal).pct;
          break;
        case "created_at":
        default:
          va = a.created_at || "";
          vb = b.created_at || "";
          break;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return list;
  }, [goals, searchQuery, filterStatus, filterCategory, filterArea, filterOwner, filterQuarter, sortBy, sortDir, tasksByGoal]);

  // ── Stats ───────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = goals.length;
    const active = goals.filter((g) => g.status === "goal_active").length;
    const currentQ = GOAL_QUARTERS[0]; // First in the dynamically generated list
    const completedThisQ = goals.filter(
      (g) => g.status === "goal_completed" && g.goal_target_quarter === currentQ
    ).length;
    return { total, active, completedThisQ, currentQ };
  }, [goals]);

  // ── Board: goals by status ──────────────────────────────────────────────────

  const goalsByStatus = useMemo(() => {
    const map = {};
    for (const s of GOAL_STAGES) {
      map[s.value] = filteredGoals.filter((g) => g.status === s.value);
    }
    return map;
  }, [filteredGoals]);

  // ── Roadmap: goals by quarter ───────────────────────────────────────────────

  const goalsByQuarter = useMemo(() => {
    const map = {};
    for (const g of filteredGoals) {
      const q = g.goal_target_quarter || "Unscheduled";
      if (!map[q]) map[q] = [];
      map[q].push(g);
    }
    // Sort goals within each quarter by priority desc
    for (const q of Object.keys(map)) {
      map[q].sort((a, b) => (b.goal_priority || 3) - (a.goal_priority || 3));
    }
    return map;
  }, [filteredGoals]);

  // Quarter order: known quarters first (in order), then "Unscheduled"
  const orderedQuarters = useMemo(() => {
    const known = GOAL_QUARTERS.filter((q) => goalsByQuarter[q]);
    const unscheduled = goalsByQuarter["Unscheduled"] ? ["Unscheduled"] : [];
    return [...known, ...unscheduled];
  }, [goalsByQuarter]);

  // ── Drag-and-drop (Board view) ──────────────────────────────────────────────

  const updateMutation = useMutation({
    mutationFn: async ({ id, status }) => {
      await api.entities.Project.update(id, { status });
    },
    onSuccess: () => {
      refetchEntityList("Project");
    },
    onError: () => {
      toast.error("Failed to update goal status.");
      refetchEntityList("Project");
    },
  });

  const handleDragEnd = useCallback(
    (result) => {
      const { draggableId, destination, source } = result;
      if (!destination) return;
      if (destination.droppableId === source.droppableId) return;

      const newStatus = destination.droppableId;
      updateMutation.mutate({ id: draggableId, status: newStatus });
    },
    [updateMutation]
  );

  // ── Filter active check ─────────────────────────────────────────────────────

  const hasActiveFilters =
    filterStatus !== "all" ||
    filterCategory !== "all" ||
    filterArea !== "all" ||
    filterOwner !== "all" ||
    filterQuarter !== "all" ||
    searchQuery !== "";

  const clearFilters = useCallback(() => {
    setFilterStatus("all");
    setFilterCategory("all");
    setFilterArea("all");
    setFilterOwner("all");
    setFilterQuarter("all");
    setSearchQuery("");
    setSearchInput("");
  }, []);

  // ── Owner options (from goals that have owners) ─────────────────────────────

  const ownerOptions = useMemo(() => {
    const ids = [...new Set(goals.map((g) => g.project_owner_id).filter(Boolean))];
    return ids
      .map((id) => {
        const u = users.find((u) => u.id === id);
        return u ? { id, name: u.full_name || u.email || id } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [goals, users]);

  // ── Quarters that actually appear in goals data ─────────────────────────────

  const activeQuarters = useMemo(() => {
    return [...new Set(goals.map((g) => g.goal_target_quarter).filter(Boolean))].sort();
  }, [goals]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-[1600px] mx-auto">
      {/* ── Page header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center">
            <Target className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground leading-none">Goals & Roadmap</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isLoading ? "Loading…" : `${stats.total} goal${stats.total !== 1 ? "s" : ""}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* View mode toggle */}
          <div className="flex items-center rounded-lg border bg-muted/50 p-0.5 gap-0.5">
            {VIEW_MODES.map(({ id, label, Icon }) => (
              <button
                key={id}
                onClick={() => setViewModePersisted(id)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all",
                  viewMode === id
                    ? "bg-background shadow text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* New Goal */}
          {isManagerOrAbove && (
            <Button size="sm" onClick={handleNewGoal} className="gap-1.5">
              <Plus className="h-4 w-4" />
              <span className="hidden sm:inline">New Goal</span>
            </Button>
          )}
        </div>
      </div>

      {/* ── Stats strip ── */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border shadow-sm">
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground font-medium">Total Goals</p>
            <p className="text-2xl font-bold mt-0.5">{stats.total}</p>
          </CardContent>
        </Card>
        <Card className="border shadow-sm">
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground font-medium">Active</p>
            <p className="text-2xl font-bold mt-0.5 text-blue-600">{stats.active}</p>
          </CardContent>
        </Card>
        <Card className="border shadow-sm">
          <CardContent className="py-3 px-4">
            <p className="text-xs text-muted-foreground font-medium truncate">Completed {stats.currentQ}</p>
            <p className="text-2xl font-bold mt-0.5 text-emerald-600">{stats.completedThisQ}</p>
          </CardContent>
        </Card>
      </div>

      {/* ── Search + filters ── */}
      <div className="space-y-2">
        {/* Search row */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search goals…"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9 h-9"
            />
            {searchInput && (
              <button
                onClick={() => handleSearchChange("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="gap-1.5 text-muted-foreground">
              <X className="h-3.5 w-3.5" />
              Clear
            </Button>
          )}
        </div>

        {/* Filters row */}
        <div className="flex flex-wrap gap-2">
          {/* Status */}
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="h-8 text-xs w-36">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {GOAL_STAGES.map((s) => (
                <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Category */}
          <Select value={filterCategory} onValueChange={setFilterCategory}>
            <SelectTrigger className="h-8 text-xs w-44">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {GOAL_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{c}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Business area */}
          <Select value={filterArea} onValueChange={setFilterArea}>
            <SelectTrigger className="h-8 text-xs w-40">
              <SelectValue placeholder="Business area" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All areas</SelectItem>
              {BUSINESS_AREAS.map((a) => (
                <SelectItem key={a} value={a}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Owner */}
          {ownerOptions.length > 0 && (
            <Select value={filterOwner} onValueChange={setFilterOwner}>
              <SelectTrigger className="h-8 text-xs w-36">
                <SelectValue placeholder="Owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All owners</SelectItem>
                {ownerOptions.map((o) => (
                  <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {/* Quarter */}
          {activeQuarters.length > 0 && (
            <Select value={filterQuarter} onValueChange={setFilterQuarter}>
              <SelectTrigger className="h-8 text-xs w-32">
                <SelectValue placeholder="Quarter" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All quarters</SelectItem>
                {activeQuarters.map((q) => (
                  <SelectItem key={q} value={q}>{q}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      {/* ── Loading ── */}
      {isLoading && <GoalsListSkeleton />}

      {/* ── Content ── */}
      {!isLoading && (
        <>
          {/* LIST VIEW */}
          {viewMode === "list" && (
            <div className="space-y-2">
              {/* Column headers */}
              {filteredGoals.length > 0 && (
                <div className="flex items-center gap-3 px-4 py-2 text-xs">
                  <div className="shrink-0 w-28 hidden sm:flex">
                    <SortableHeader label="Status" field="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="flex-1">
                    <SortableHeader label="Title" field="title" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="shrink-0 hidden md:flex">
                    <SortableHeader label="Category" field="category" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="shrink-0 w-20 hidden lg:block">
                    <SortableHeader label="Quarter" field="quarter" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="shrink-0 w-28 hidden lg:block">
                    <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Owner</span>
                  </div>
                  <div className="shrink-0 w-28 hidden sm:block">
                    <SortableHeader label="Progress" field="progress" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="shrink-0 hidden md:block">
                    <SortableHeader label="Priority" field="priority" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </div>
                  <div className="shrink-0 w-10 hidden lg:block" />
                </div>
              )}

              {/* Rows */}
              {filteredGoals.map((goal) => (
                <GoalListRow
                  key={goal.id}
                  goal={goal}
                  tasksByGoal={tasksByGoal}
                  users={users}
                  childCounts={childCounts}
                />
              ))}

              {filteredGoals.length === 0 && (
                <EmptyState
                  filtered={hasActiveFilters}
                  onClear={clearFilters}
                  canCreate={isManagerOrAbove}
                  onNew={handleNewGoal}
                />
              )}
            </div>
          )}

          {/* BOARD VIEW */}
          {viewMode === "board" && (
            <DragDropContext onDragEnd={handleDragEnd}>
              <div className="flex gap-3 overflow-x-auto pb-4 -mx-1 px-1">
                {GOAL_STAGES.map((stage) => (
                  <BoardColumn
                    key={stage.value}
                    stage={stage}
                    goals={goalsByStatus[stage.value] || []}
                    tasksByGoal={tasksByGoal}
                    users={users}
                  />
                ))}
              </div>
              {filteredGoals.length === 0 && (
                <EmptyState
                  filtered={hasActiveFilters}
                  onClear={clearFilters}
                  canCreate={isManagerOrAbove}
                  onNew={handleNewGoal}
                />
              )}
            </DragDropContext>
          )}

          {/* ROADMAP VIEW */}
          {viewMode === "roadmap" && (
            <div className="space-y-4">
              {orderedQuarters.map((quarter) => (
                <RoadmapQuarterGroup
                  key={quarter}
                  quarter={quarter}
                  goals={goalsByQuarter[quarter] || []}
                  tasksByGoal={tasksByGoal}
                  users={users}
                />
              ))}
              {orderedQuarters.length === 0 && (
                <EmptyState
                  filtered={hasActiveFilters}
                  onClear={clearFilters}
                  canCreate={isManagerOrAbove}
                  onNew={handleNewGoal}
                />
              )}
            </div>
          )}
        </>
      )}

      {/* ── Goal form dialog ── */}
      {showForm && (
        <GoalForm
          goal={editingGoal}
          open={showForm}
          onClose={handleFormClose}
          onSave={handleFormSave}
        />
      )}
    </div>
  );
}

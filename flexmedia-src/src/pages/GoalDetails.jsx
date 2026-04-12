import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useSearchParams, Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useSmartEntityData, useSmartEntityList } from "@/components/hooks/useSmartEntityData";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { usePermissions } from "@/components/auth/PermissionGuard";
import {
  goalStageLabel,
  goalStageConfig,
} from "@/components/goals/goalStatuses";
import GoalStatusPipeline, { GoalStatusBadge } from "@/components/goals/GoalStatusPipeline";
import GoalForm from "@/components/goals/GoalForm";
import TaskManagement from "@/components/projects/TaskManagement";
import EffortLoggingTab from "@/components/projects/EffortLoggingTab";
import ProjectActivityHub from "@/components/projects/ProjectActivityHub";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Target,
  Edit,
  ChevronRight,
  Calendar,
  Users,
  Flag,
  Layers,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

// ── Priority helpers ──────────────────────────────────────────────────────────

const PRIORITY_LABELS = {
  1: "Low",
  2: "Below Average",
  3: "Normal",
  4: "High",
  5: "Critical",
};

const PRIORITY_COLORS = {
  1: "bg-slate-100 text-slate-600 border-slate-200",
  2: "bg-blue-50 text-blue-600 border-blue-200",
  3: "bg-amber-50 text-amber-600 border-amber-200",
  4: "bg-orange-100 text-orange-700 border-orange-200",
  5: "bg-red-100 text-red-700 border-red-200",
};

// ── Loading skeleton ──────────────────────────────────────────────────────────

function GoalDetailsSkeleton() {
  return (
    <div className="p-4 lg:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Back link */}
      <Skeleton className="h-5 w-32" />
      {/* Header */}
      <div className="space-y-3">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-10 w-full" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
        <Skeleton className="h-4 w-full" />
      </div>
      {/* Tabs */}
      <Skeleton className="h-9 w-72 rounded-md" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

// ── Metadata tile ─────────────────────────────────────────────────────────────

function MetaTile({ icon: Icon, label, value, className }) {
  if (!value) return null;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border bg-card px-4 py-3 shadow-sm",
        className
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        {label}
      </div>
      <div className="text-sm font-semibold text-foreground truncate">{value}</div>
    </div>
  );
}

// ── Child goal card ───────────────────────────────────────────────────────────

function ChildGoalCard({ goal }) {
  const cfg = goalStageConfig(goal.status);
  return (
    <Link
      to={createPageUrl(`GoalDetails?id=${goal.id}`)}
      className={cn(
        "flex items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm",
        "hover:bg-accent hover:border-primary/30 transition-colors group"
      )}
    >
      <div
        className={cn(
          "flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center",
          cfg.color,
          cfg.darkColor
        )}
      >
        <Target className={cn("h-3.5 w-3.5", cfg.textColor, cfg.darkText)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-foreground truncate group-hover:text-primary transition-colors">
          {goal.title}
        </div>
        {goal.goal_target_quarter && (
          <div className="text-xs text-muted-foreground">{goal.goal_target_quarter}</div>
        )}
      </div>
      <GoalStatusBadge status={goal.status} />
      <ChevronRight className="h-4 w-4 text-muted-foreground/50 group-hover:text-primary transition-colors shrink-0" />
    </Link>
  );
}

// ── Vision block ─────────────────────────────────────────────────────────────

function VisionBlock({ text }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;

  const isLong = text.length > 300;
  const displayText = isLong && !expanded ? text.slice(0, 300) + "…" : text;

  return (
    <div className="rounded-xl border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground font-medium mb-2">
        <Eye className="h-3.5 w-3.5" />
        Vision Statement
      </div>
      <p className="text-sm text-foreground/80 leading-relaxed whitespace-pre-line">
        {displayText}
      </p>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-2 text-xs text-primary hover:underline flex items-center gap-1"
        >
          {expanded ? (
            <>
              <EyeOff className="h-3 w-3" /> Show less
            </>
          ) : (
            <>
              <Eye className="h-3 w-3" /> Show more
            </>
          )}
        </button>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

const VALID_TABS = new Set(["tasks", "effort", "activity"]);

export default function GoalDetails() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const goalId = searchParams.get("id");

  const queryClient = useQueryClient();
  const { isManagerOrAbove } = usePermissions();

  const [showEditForm, setShowEditForm] = useState(false);

  // Tab state — persisted in URL ?tab= so reload preserves it
  const [activeTab, setActiveTab] = useState(() => {
    const tab = searchParams.get("tab");
    return tab && VALID_TABS.has(tab) ? tab : "tasks";
  });

  // Mount-on-first-visit pattern (lazy-load heavy tabs)
  const [mountedTabs, setMountedTabs] = useState(
    new Set([searchParams.get("tab") || "tasks"])
  );

  const handleTabChange = (tab) => {
    setActiveTab(tab);
    setMountedTabs((prev) => {
      if (prev.has(tab)) return prev;
      return new Set([...prev, tab]);
    });
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}?${params.toString()}`
    );
  };

  // ── Data loading ────────────────────────────────────────────────────────────

  const { data: goalRaw, loading: isLoading, error: goalError } = useSmartEntityData(
    "Project",
    goalId,
    { priority: 10 }
  );

  // Stable ref — prevents flash of "not found" during cache refresh
  const goalStableRef = useRef(null);
  if (goalRaw) goalStableRef.current = goalRaw;
  const goal = goalRaw || goalStableRef.current;

  // Parent goal (for breadcrumb)
  const { data: parentGoal } = useSmartEntityData(
    "Project",
    goal?.parent_goal_id || null
  );

  // Child goals
  const filterChildren = useCallback(
    (p) => p.parent_goal_id === goalId && p.source === "goal" && !p.is_deleted,
    [goalId]
  );
  const { data: childGoals = [] } = useSmartEntityList(
    "Project",
    null,
    null,
    filterChildren
  );

  // Users list for owner name resolution
  const { data: users = [] } = useSmartEntityList("User");

  // Tasks — for progress computation
  const filterTasks = useCallback(
    (t) => t.project_id === goalId,
    [goalId]
  );
  const { data: tasks = [] } = useSmartEntityList(
    "ProjectTask",
    null,
    null,
    filterTasks
  );

  const { completedTasks, totalTasks, progressPct } = useMemo(() => {
    const active = tasks.filter((t) => !t.is_deleted);
    const completed = active.filter((t) => t.is_completed).length;
    const total = active.length;
    const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
    return { completedTasks: completed, totalTasks: total, progressPct: pct };
  }, [tasks]);

  const ownerName = useMemo(() => {
    if (!goal?.project_owner_id) return null;
    const u = users.find((u) => u.id === goal.project_owner_id);
    return u?.full_name || u?.email || null;
  }, [goal?.project_owner_id, users]);

  const canEdit = isManagerOrAbove;

  // ── Status mutation ─────────────────────────────────────────────────────────

  const statusMutation = useMutation({
    mutationFn: (newStatus) =>
      api.entities.Project.update(goalId, { status: newStatus }),
    onSuccess: (_, newStatus) => {
      refetchEntityList("Project");
      queryClient.invalidateQueries({ queryKey: ["project", goalId] });
      toast.success(`Status updated to ${goalStageLabel(newStatus)}`);
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to update status");
    },
  });

  // ── Redirect if no ID ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!goalId) navigate(createPageUrl("Goals"));
  }, [goalId, navigate]);

  if (!goalId) return null;

  // ── Loading state ───────────────────────────────────────────────────────────

  if (isLoading && !goal) {
    return <GoalDetailsSkeleton />;
  }

  // ── Error / not found state ─────────────────────────────────────────────────

  if (goalError || (!isLoading && !goal)) {
    return (
      <div className="p-6 lg:p-8">
        <Card className="p-12 text-center max-w-md mx-auto">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">
            {goalError ? "Failed to load goal" : "Goal not found"}
          </h3>
          <p className="text-sm text-muted-foreground mb-6">
            {goalError?.message ||
              "This goal may have been deleted or you don't have access."}
          </p>
          <Link to={createPageUrl("Goals")}>
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Goals
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  // Guard — soft-deleted goals must not be viewable via direct URL
  if (goal.is_deleted) {
    return (
      <div className="p-8 flex items-center justify-center min-h-[60vh]">
        <Card className="p-8 max-w-md text-center">
          <Target className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <h2 className="text-lg font-semibold mb-1">Goal Deleted</h2>
          <p className="text-sm text-muted-foreground mb-4">This goal has been removed.</p>
          <Link to="/Goals"><Button>Back to Goals</Button></Link>
        </Card>
      </div>
    );
  }

  // Sanity check — goal must be source=goal
  if (goal.source !== "goal") {
    return (
      <div className="p-6 lg:p-8">
        <Card className="p-12 text-center max-w-md mx-auto">
          <AlertCircle className="h-10 w-10 text-amber-500 mx-auto mb-4" />
          <h3 className="text-lg font-semibold mb-2">Not a goal</h3>
          <p className="text-sm text-muted-foreground mb-6">
            This record is not a goal.
          </p>
          <Link to={createPageUrl("Goals")}>
            <Button variant="outline">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Goals
            </Button>
          </Link>
        </Card>
      </div>
    );
  }

  const stageCfg = goalStageConfig(goal.status);
  const priorityNum = Number(goal.goal_priority) || 3;

  return (
    <div className="p-4 lg:p-8 space-y-5 max-w-5xl mx-auto">

      {/* ── Back navigation + breadcrumb ──────────────────────────────────── */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
        <Link
          to={createPageUrl("Goals")}
          className="flex items-center gap-1 hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Goals
        </Link>

        {parentGoal && (
          <>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
            <Link
              to={createPageUrl(`GoalDetails?id=${parentGoal.id}`)}
              className="hover:text-foreground transition-colors max-w-[200px] truncate"
              title={parentGoal.title}
            >
              {parentGoal.title}
            </Link>
          </>
        )}

        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        <span className="text-foreground font-medium max-w-[240px] truncate" title={goal.title}>
          {goal.title}
        </span>
      </div>

      {/* ── Header card ───────────────────────────────────────────────────── */}
      <Card className="overflow-hidden">
        <CardContent className="p-5 sm:p-6 space-y-5">

          {/* Title row */}
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "flex-shrink-0 w-10 h-10 rounded-xl flex items-center justify-center mt-0.5",
                stageCfg.color,
                stageCfg.darkColor
              )}
            >
              <Target className={cn("h-5 w-5", stageCfg.textColor, stageCfg.darkText)} />
            </div>

            <div className="flex-1 min-w-0">
              <h1 className="text-xl sm:text-2xl font-bold text-foreground leading-tight break-words">
                {goal.title}
              </h1>
              {goal.title_desc && (
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  {goal.title_desc}
                </p>
              )}
            </div>

            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowEditForm(true)}
                className="shrink-0 gap-1.5"
              >
                <Edit className="h-3.5 w-3.5" />
                Edit
              </Button>
            )}
          </div>

          {/* Status pipeline */}
          <div className="overflow-x-auto -mx-1 px-1">
            <GoalStatusPipeline
              currentStatus={goal.status}
              onStatusChange={(newStatus) => statusMutation.mutate(newStatus)}
              canEdit={canEdit && !statusMutation.isPending}
            />
          </div>

          {/* Metadata grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {goal.goal_category && (
              <MetaTile
                icon={Layers}
                label="Category"
                value={goal.goal_category}
              />
            )}
            {goal.goal_business_area && (
              <MetaTile
                icon={Flag}
                label="Business Area"
                value={goal.goal_business_area}
              />
            )}
            {goal.goal_target_quarter && (
              <MetaTile
                icon={Calendar}
                label="Target Quarter"
                value={goal.goal_target_quarter}
              />
            )}
            {ownerName && (
              <MetaTile
                icon={Users}
                label="Owner"
                value={ownerName}
              />
            )}
            {/* Priority badge tile */}
            <div
              className={cn(
                "flex flex-col gap-1 rounded-xl border px-4 py-3 shadow-sm",
                PRIORITY_COLORS[priorityNum] || PRIORITY_COLORS[3]
              )}
            >
              <div className="flex items-center gap-1.5 text-xs font-medium opacity-70">
                <Flag className="h-3.5 w-3.5 shrink-0" />
                Priority
              </div>
              <div className="text-sm font-semibold">
                {priorityNum} — {PRIORITY_LABELS[priorityNum] || "Normal"}
              </div>
            </div>
          </div>

          {/* Vision */}
          <VisionBlock text={goal.goal_vision} />

          {/* Progress bar */}
          {totalTasks > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  <span>Task Progress</span>
                </div>
                <span className="font-medium text-foreground">
                  {completedTasks}/{totalTasks} complete{" "}
                  <span className="text-muted-foreground">({progressPct}%)</span>
                </span>
              </div>
              <Progress
                value={progressPct}
                className={cn(
                  "h-2 transition-all",
                  progressPct === 100 && "bg-emerald-100"
                )}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Hierarchy section ─────────────────────────────────────────────── */}
      {childGoals.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide px-0.5">
            Sub-Goals ({childGoals.length})
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {childGoals.map((child) => (
              <ChildGoalCard key={child.id} goal={child} />
            ))}
          </div>
        </div>
      )}

      {/* ── Tabs ──────────────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="effort">Effort</TabsTrigger>
          <TabsTrigger value="activity">Notes & Activity</TabsTrigger>
        </TabsList>

        {/* Tasks tab */}
        <TabsContent value="tasks" className="mt-4">
          {mountedTabs.has("tasks") && (
            <TaskManagement
              projectId={goalId}
              project={goal}
              canEdit={canEdit}
            />
          )}
        </TabsContent>

        {/* Effort tab */}
        <TabsContent value="effort" className="mt-4">
          {mountedTabs.has("effort") && (
            <EffortLoggingTab projectId={goalId} project={goal} />
          )}
        </TabsContent>

        {/* Notes & Activity tab */}
        <TabsContent value="activity" className="mt-4">
          {mountedTabs.has("activity") && (
            <ProjectActivityHub projectId={goalId} project={goal} />
          )}
        </TabsContent>
      </Tabs>

      {/* ── Edit form modal ────────────────────────────────────────────────── */}
      <GoalForm
        goal={goal}
        open={showEditForm}
        onClose={() => setShowEditForm(false)}
        onSave={() => {
          refetchEntityList("Project");
          queryClient.invalidateQueries({ queryKey: ["project", goalId] });
        }}
      />
    </div>
  );
}

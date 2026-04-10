/**
 * FieldMode.jsx — Mobile-first "Field Mode" for onsite photography staff.
 *
 * Full-screen, no sidebar/desktop chrome. Self-contained with its own
 * ActiveTimersProvider (since it bypasses the Layout wrapper).
 *
 * Three sections via bottom tab nav:
 *   1. Today's Shoots (default)
 *   2. Project Quick View (tasks, timer, notes)
 *   3. Compass / Location
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { ActiveTimersProvider, useActiveTimers } from "@/components/utilization/ActiveTimersContext";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import {
  Calendar, CheckSquare, Compass, MapPin, Clock, Play, Square,
  ChevronLeft, Plus, Navigation, Loader2, RefreshCw, Timer, Check, Circle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fixTimestamp } from "@/components/utils/dateUtils";
import AIChat from "@/components/ai/AIChat";

// ─── Constants ──────────────────────────────────────────────────────────────

const SYDNEY_TZ = "Australia/Sydney";

const STATUS_COLORS = {
  pending_review: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  scheduled:      "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  onsite:         "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  production:     "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  delivered:      "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

const TABS = [
  { id: "shoots",  label: "Shoots",  icon: Calendar },
  { id: "tasks",   label: "Tasks",   icon: CheckSquare },
  { id: "compass", label: "Compass", icon: Compass },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get today's date string in Sydney timezone as YYYY-MM-DD */
function sydneyToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: SYDNEY_TZ });
}

/** Get a date string N days from now in Sydney timezone */
function sydneyDateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toLocaleDateString("en-CA", { timeZone: SYDNEY_TZ });
}

/** Format a shoot_date for display */
function formatShootDate(dateStr) {
  if (!dateStr) return "";
  try {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return dateStr;
  }
}

/** Format seconds as HH:MM:SS */
function formatElapsed(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Parse "HH:MM" time string to minutes for sorting */
function parseTimeToMinutes(timeStr) {
  if (!timeStr) return 999;
  const parts = timeStr.match(/(\d+):(\d+)/);
  if (!parts) return 999;
  return parseInt(parts[1], 10) * 60 + parseInt(parts[2], 10);
}

/** Status badge component */
function StatusBadge({ status }) {
  const label = (status || "unknown").replace(/_/g, " ");
  return (
    <Badge className={cn("text-[10px] font-medium capitalize", STATUS_COLORS[status] || "bg-gray-100 text-gray-700")}>
      {label}
    </Badge>
  );
}

// ─── Main Component (wraps in ActiveTimersProvider) ─────────────────────────

export default function FieldMode() {
  const { data: user } = useCurrentUser();

  return (
    <ActiveTimersProvider currentUser={user || null}>
      <FieldModeInner user={user} />
    </ActiveTimersProvider>
  );
}

// ─── Inner Component ────────────────────────────────────────────────────────

function FieldModeInner({ user }) {
  const queryClient = useQueryClient();
  const { activeTimers } = useActiveTimers();

  const [activeTab, setActiveTab] = useState("shoots");
  const [selectedProject, setSelectedProject] = useState(null);

  // When a project is selected, switch to tasks tab
  const selectProject = useCallback((project) => {
    setSelectedProject(project);
    setActiveTab("tasks");
  }, []);

  const goBackToShoots = useCallback(() => {
    setSelectedProject(null);
    setActiveTab("shoots");
  }, []);

  // ── Data Fetching ───────────────────────────────────────────────────────

  const today = useMemo(() => sydneyToday(), []);
  const upcomingEnd = useMemo(() => sydneyDateOffset(3), []);

  // Fetch all projects (limited set for field staff)
  const { data: allProjects = [], isLoading: projectsLoading, refetch: refetchProjects } = useQuery({
    queryKey: ["field-mode-projects"],
    queryFn: () => api.entities.Project.list("-shoot_date", 200),
    staleTime: 2 * 60 * 1000,
    enabled: !!user?.id,
  });

  // Filter to projects assigned to current user
  const myProjects = useMemo(() => {
    if (!user?.id) return [];
    return allProjects.filter((p) => {
      const assignedIds = [
        p.photographer_id,
        p.videographer_id,
        p.onsite_staff_1_id,
        p.onsite_staff_2_id,
      ];
      return assignedIds.includes(user.id);
    });
  }, [allProjects, user?.id]);

  // Today's shoots
  const todayShoots = useMemo(() => {
    return myProjects
      .filter((p) => p.shoot_date === today && p.status !== "delivered")
      .sort((a, b) => parseTimeToMinutes(a.shoot_time) - parseTimeToMinutes(b.shoot_time));
  }, [myProjects, today]);

  // Upcoming shoots (next 3 days, excluding today)
  const upcomingShoots = useMemo(() => {
    return myProjects
      .filter((p) => p.shoot_date > today && p.shoot_date <= upcomingEnd && p.status !== "delivered")
      .sort((a, b) => {
        if (a.shoot_date !== b.shoot_date) return a.shoot_date < b.shoot_date ? -1 : 1;
        return parseTimeToMinutes(a.shoot_time) - parseTimeToMinutes(b.shoot_time);
      });
  }, [myProjects, today, upcomingEnd]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="h-dvh flex flex-col bg-background text-foreground overflow-hidden">
      {/* Header */}
      <header className="bg-slate-900 dark:bg-slate-950 text-white px-4 py-3 shrink-0">
        {selectedProject ? (
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="text-white hover:bg-white/10 h-10 w-10"
              onClick={goBackToShoots}
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <div className="flex-1 min-w-0">
              <h1 className="text-sm font-semibold truncate">
                {selectedProject.property_address || selectedProject.project_name || "Project"}
              </h1>
              <div className="flex items-center gap-2 mt-0.5">
                <StatusBadge status={selectedProject.status} />
                {selectedProject.shoot_date && (
                  <span className="text-xs text-slate-300">
                    {formatShootDate(selectedProject.shoot_date)}
                    {selectedProject.shoot_time && ` at ${selectedProject.shoot_time}`}
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-bold">Field Mode</h1>
              <p className="text-xs text-slate-300">
                {new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", timeZone: SYDNEY_TZ })}
              </p>
            </div>
            {activeTimers.length > 0 && (
              <Badge className="bg-green-500 text-white animate-pulse text-xs">
                <Timer className="h-3 w-3 mr-1" />
                {activeTimers.length} timer{activeTimers.length !== 1 ? "s" : ""}
              </Badge>
            )}
          </div>
        )}
      </header>

      {/* Content Area */}
      <main className="flex-1 overflow-y-auto overscroll-contain">
        {activeTab === "shoots" && (
          <ShootsTab
            todayShoots={todayShoots}
            upcomingShoots={upcomingShoots}
            loading={projectsLoading}
            onSelectProject={selectProject}
            onRefresh={refetchProjects}
          />
        )}
        {activeTab === "tasks" && (
          <TasksTab
            project={selectedProject}
            user={user}
            onSelectProject={selectProject}
            todayShoots={todayShoots}
          />
        )}
        {activeTab === "compass" && (
          <CompassTab project={selectedProject} user={user} />
        )}
      </main>

      {/* Bottom Tab Bar */}
      <nav className="bg-background border-t border-border shrink-0 safe-area-bottom">
        <div className="flex">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex-1 flex flex-col items-center gap-0.5 py-2 px-1 min-h-[52px] transition-colors",
                  isActive
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="h-5 w-5" />
                <span className="text-[10px] font-medium">{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* AI Assistant — visible when a project is selected */}
      {selectedProject && (
        <AIChat
          projectId={selectedProject.id}
          projectTitle={selectedProject.property_address || selectedProject.project_name}
        />
      )}
    </div>
  );
}

// ─── Section 1: Today's Shoots ──────────────────────────────────────────────

function ShootsTab({ todayShoots, upcomingShoots, loading, onSelectProject, onRefresh }) {
  return (
    <div className="p-4 pb-2 space-y-6">
      {/* Refresh */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={onRefresh} className="gap-1.5 text-xs">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Today's Shoots */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Today's Shoots
        </h2>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : todayShoots.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground text-sm">
              <Calendar className="h-8 w-8 mx-auto mb-2 opacity-30" />
              No shoots scheduled for today
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {todayShoots.map((project) => (
              <ShootCard key={project.id} project={project} onTap={onSelectProject} />
            ))}
          </div>
        )}
      </section>

      {/* Upcoming */}
      {upcomingShoots.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Upcoming (Next 3 Days)
          </h2>
          <div className="space-y-3">
            {upcomingShoots.map((project) => (
              <ShootCard key={project.id} project={project} onTap={onSelectProject} showDate />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function ShootCard({ project, onTap, showDate }) {
  return (
    <Card
      className="cursor-pointer active:scale-[0.98] transition-transform"
      onClick={() => onTap(project)}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sm truncate">
              {project.property_address || project.project_name || "Untitled"}
            </h3>
            <div className="flex items-center gap-2 mt-1.5 flex-wrap">
              {(showDate ? project.shoot_date : project.shoot_time) && (
                <span className="text-xs text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {showDate ? formatShootDate(project.shoot_date) : null}
                  {showDate && project.shoot_time ? " at " : null}
                  {project.shoot_time || null}
                </span>
              )}
              {(project.client_name || project.agent_name) && (
                <span className="text-xs text-muted-foreground">
                  {project.client_name || project.agent_name}
                </span>
              )}
            </div>
            {project.property_address && project.suburb && (
              <span className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <MapPin className="h-3 w-3" />
                {project.suburb}
              </span>
            )}
          </div>
          <StatusBadge status={project.status} />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Section 2: Project Quick View (Tasks) ──────────────────────────────────

function TasksTab({ project, user, onSelectProject, todayShoots }) {
  const queryClient = useQueryClient();

  // If no project selected, show a prompt to pick one
  if (!project) {
    return (
      <div className="p-4 space-y-4">
        <div className="text-center py-8 text-muted-foreground text-sm">
          <CheckSquare className="h-8 w-8 mx-auto mb-2 opacity-30" />
          <p>Select a project to view tasks</p>
        </div>
        {todayShoots.length > 0 && (
          <section>
            <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
              Quick Select
            </h2>
            <div className="space-y-2">
              {todayShoots.map((p) => (
                <Button
                  key={p.id}
                  variant="outline"
                  className="w-full justify-start text-left h-auto py-3 px-4"
                  onClick={() => onSelectProject(p)}
                >
                  <div className="truncate">
                    <span className="text-sm font-medium">
                      {p.property_address || p.project_name || "Project"}
                    </span>
                    {p.shoot_time && (
                      <span className="text-xs text-muted-foreground ml-2">{p.shoot_time}</span>
                    )}
                  </div>
                </Button>
              ))}
            </div>
          </section>
        )}
      </div>
    );
  }

  return <ProjectQuickView project={project} user={user} />;
}

function ProjectQuickView({ project, user }) {
  const queryClient = useQueryClient();
  const { activeTimers } = useActiveTimers();

  // Fetch tasks for this project
  const { data: allTasks = [], isLoading: tasksLoading, refetch: refetchTasks } = useQuery({
    queryKey: ["field-mode-tasks", project.id],
    queryFn: () => api.entities.ProjectTask.filter({ project_id: project.id }),
    staleTime: 60 * 1000,
    enabled: !!project?.id,
  });

  // Filter to tasks assigned to user or their team (or unassigned)
  const myTasks = useMemo(() => {
    if (!user?.id) return allTasks;
    return allTasks.filter((t) => {
      if (t.assigned_to === user.id) return true;
      if (!t.assigned_to && !t.assigned_to_team_id) return true; // unassigned
      return false;
    });
  }, [allTasks, user?.id]);

  // Sort: incomplete first, then by due_date
  const sortedTasks = useMemo(() => {
    return [...myTasks].sort((a, b) => {
      if (a.is_completed !== b.is_completed) return a.is_completed ? 1 : -1;
      const da = a.due_date || "9999";
      const db = b.due_date || "9999";
      return da < db ? -1 : da > db ? 1 : 0;
    });
  }, [myTasks]);

  // ── Toggle Complete Mutation ─────────────────────────────────────────────
  const toggleComplete = useMutation({
    mutationFn: async ({ taskId, currentState }) => {
      if (currentState) {
        // Un-complete
        return api.entities.ProjectTask.update(taskId, {
          is_completed: false,
          completed_at: null,
        });
      }
      // Complete
      return api.entities.ProjectTask.update(taskId, {
        is_completed: true,
        completed_at: new Date().toISOString(),
      });
    },
    onSuccess: () => {
      refetchTasks();
      refetchEntityList("ProjectTask");
    },
    onError: (err) => {
      toast.error("Failed to update task: " + (err.message || "Unknown error"));
    },
  });

  return (
    <div className="p-4 pb-2 space-y-5">
      {/* Refresh */}
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => refetchTasks()} className="gap-1.5 text-xs">
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </Button>
      </div>

      {/* Task Checklist */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Tasks ({sortedTasks.filter((t) => !t.is_completed).length} remaining)
        </h2>
        {tasksLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sortedTasks.length === 0 ? (
          <Card>
            <CardContent className="py-6 text-center text-muted-foreground text-sm">
              No tasks assigned
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {sortedTasks.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                project={project}
                user={user}
                activeTimers={activeTimers}
                onToggleComplete={() =>
                  toggleComplete.mutate({ taskId: task.id, currentState: task.is_completed })
                }
              />
            ))}
          </div>
        )}
      </section>

      {/* Quick Note */}
      <QuickNote project={project} user={user} />
    </div>
  );
}

// ── Task Row with Timer ────────────────────────────────────────────────────

function TaskRow({ task, project, user, activeTimers, onToggleComplete }) {
  const queryClient = useQueryClient();

  // Find if there's an active timer for this task by this user
  const myTimer = activeTimers.find(
    (t) => t.task_id === task.id && t.user_id === user?.id && t.is_active && t.status === "running"
  );

  // Elapsed seconds for running timer
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!myTimer?.start_time) {
      setElapsed(0);
      return;
    }

    const calcElapsed = () => {
      const start = new Date(fixTimestamp(myTimer.start_time)).getTime();
      const now = Date.now();
      const pausedDuration = myTimer.paused_duration || 0;
      return Math.max(0, Math.floor((now - start) / 1000) - pausedDuration);
    };

    setElapsed(calcElapsed());
    const interval = setInterval(() => setElapsed(calcElapsed()), 1000);
    return () => clearInterval(interval);
  }, [myTimer?.id, myTimer?.start_time, myTimer?.paused_duration]);

  // Start timer
  const startTimer = useMutation({
    mutationFn: () =>
      api.entities.TaskTimeLog.create({
        task_id: task.id,
        project_id: project.id,
        user_id: user.id,
        user_name: user.full_name || user.email,
        start_time: new Date().toISOString(),
        status: "running",
        is_active: true,
        total_seconds: 0,
        paused_duration: 0,
      }),
    onSuccess: () => {
      toast.success("Timer started");
      refetchEntityList("TaskTimeLog");
    },
    onError: (err) => {
      toast.error("Failed to start timer: " + (err.message || "Unknown error"));
    },
  });

  // Stop timer
  const stopTimer = useMutation({
    mutationFn: () => {
      if (!myTimer) return Promise.reject(new Error("No active timer"));
      const start = new Date(fixTimestamp(myTimer.start_time)).getTime();
      const pausedDuration = myTimer.paused_duration || 0;
      const totalSeconds = Math.max(0, Math.floor((Date.now() - start) / 1000) - pausedDuration);
      return api.entities.TaskTimeLog.update(myTimer.id, {
        end_time: new Date().toISOString(),
        status: "completed",
        is_active: false,
        total_seconds: totalSeconds,
      });
    },
    onSuccess: () => {
      toast.success("Timer stopped");
      refetchEntityList("TaskTimeLog");
    },
    onError: (err) => {
      toast.error("Failed to stop timer: " + (err.message || "Unknown error"));
    },
  });

  const isRunning = !!myTimer;

  return (
    <Card className={cn(task.is_completed && "opacity-60")}>
      <CardContent className="p-3">
        <div className="flex items-start gap-3">
          {/* Checkbox */}
          <button
            onClick={onToggleComplete}
            className="mt-0.5 shrink-0 h-6 w-6 rounded-full border-2 flex items-center justify-center transition-colors"
            style={{ minWidth: 24, minHeight: 24 }}
          >
            {task.is_completed ? (
              <Check className="h-4 w-4 text-green-600" />
            ) : (
              <Circle className="h-4 w-4 text-muted-foreground/30" />
            )}
          </button>

          {/* Task info */}
          <div className="flex-1 min-w-0">
            <p className={cn("text-sm font-medium", task.is_completed && "line-through text-muted-foreground")}>
              {task.title || task.task_name || "Untitled Task"}
            </p>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              {task.due_date && (
                <span className="text-xs text-muted-foreground">
                  Due: {formatShootDate(task.due_date)}
                </span>
              )}
              {isRunning && (
                <Badge className="bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300 text-[10px] animate-pulse">
                  <Timer className="h-3 w-3 mr-0.5" />
                  {formatElapsed(elapsed)}
                </Badge>
              )}
            </div>
          </div>

          {/* Timer button */}
          {!task.is_completed && (
            <Button
              variant={isRunning ? "destructive" : "outline"}
              size="icon"
              className="h-10 w-10 shrink-0"
              onClick={() => (isRunning ? stopTimer.mutate() : startTimer.mutate())}
              disabled={startTimer.isPending || stopTimer.isPending}
            >
              {startTimer.isPending || stopTimer.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : isRunning ? (
                <Square className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Quick Note ──────────────────────────────────────────────────────────────

function QuickNote({ project, user }) {
  const [noteText, setNoteText] = useState("");

  const addNote = useMutation({
    mutationFn: () =>
      api.entities.ProjectNote.create({
        project_id: project.id,
        note_content: noteText.trim(),
        created_by_id: user.id,
        created_by_name: user.full_name || user.email || "Unknown",
        created_by_email: user.email || "",
        contextType: "project",
      }),
    onSuccess: () => {
      toast.success("Note added");
      setNoteText("");
      refetchEntityList("ProjectNote");
    },
    onError: (err) => {
      toast.error("Failed to add note: " + (err.message || "Unknown error"));
    },
  });

  return (
    <section>
      <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        Quick Note
      </h2>
      <Card>
        <CardContent className="p-3 space-y-2">
          <Textarea
            placeholder="Add a note about this project..."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            className="resize-none text-sm"
          />
          <Button
            size="sm"
            className="w-full gap-1.5"
            onClick={() => addNote.mutate()}
            disabled={!noteText.trim() || addNote.isPending}
          >
            {addNote.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Add Note
          </Button>
        </CardContent>
      </Card>
    </section>
  );
}

// ─── Section 3: Compass / Location ──────────────────────────────────────────

function CompassTab({ project, user }) {
  const [location, setLocation] = useState(null);
  const [heading, setHeading] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [locationError, setLocationError] = useState(null);
  const [compassError, setCompassError] = useState(null);
  const [loadingLocation, setLoadingLocation] = useState(false);
  const [saving, setSaving] = useState(false);
  const watchIdRef = useRef(null);

  // ── GPS ──────────────────────────────────────────────────────────────────
  const getLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation not supported");
      return;
    }

    setLoadingLocation(true);
    setLocationError(null);

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setAccuracy(pos.coords.accuracy);
        setLoadingLocation(false);
      },
      (err) => {
        setLocationError(err.message || "Failed to get location");
        setLoadingLocation(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }, []);

  // Get location on mount
  useEffect(() => {
    getLocation();
  }, [getLocation]);

  // ── Compass ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cleanup = () => {};

    const startCompass = () => {
      const handleOrientation = (event) => {
        // iOS provides webkitCompassHeading; others use alpha
        if (event.webkitCompassHeading != null) {
          setHeading(Math.round(event.webkitCompassHeading));
        } else if (event.alpha != null) {
          // alpha is 0-360 but rotated; approximate compass heading
          setHeading(Math.round(360 - event.alpha));
        }
      };

      window.addEventListener("deviceorientation", handleOrientation, true);
      cleanup = () => window.removeEventListener("deviceorientation", handleOrientation, true);
    };

    // iOS 13+ requires permission
    if (typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function") {
      DeviceOrientationEvent.requestPermission()
        .then((state) => {
          if (state === "granted") {
            startCompass();
          } else {
            setCompassError("Compass permission denied");
          }
        })
        .catch(() => {
          setCompassError("Could not request compass permission");
        });
    } else if (typeof DeviceOrientationEvent !== "undefined") {
      startCompass();
    } else {
      setCompassError("Compass not available on this device");
    }

    return () => cleanup();
  }, []);

  // ── Save GPS to Project ─────────────────────────────────────────────────
  const saveToProject = useCallback(async () => {
    if (!project || !location) {
      toast.error("No project selected or location unavailable");
      return;
    }

    setSaving(true);
    try {
      const existingMeta = project.metadata || {};
      await api.entities.Project.update(project.id, {
        metadata: {
          ...existingMeta,
          gps_latitude: location.lat,
          gps_longitude: location.lng,
          gps_accuracy: accuracy,
          gps_heading: heading,
          gps_saved_at: new Date().toISOString(),
          gps_saved_by: user?.id,
        },
      });
      toast.success("GPS saved to project");
      refetchEntityList("Project");
    } catch (err) {
      toast.error("Failed to save GPS: " + (err.message || "Unknown error"));
    } finally {
      setSaving(false);
    }
  }, [project, location, accuracy, heading, user?.id]);

  // ── Compass Direction Label ─────────────────────────────────────────────
  const compassDirection = useMemo(() => {
    if (heading == null) return "--";
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const idx = Math.round(heading / 45) % 8;
    return dirs[idx];
  }, [heading]);

  // Map tile URL (OpenStreetMap static image)
  const mapUrl = useMemo(() => {
    if (!location) return null;
    const { lat, lng } = location;
    const zoom = 16;
    // Use OpenStreetMap tile as a simple map preview
    return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.005},${lat - 0.003},${lng + 0.005},${lat + 0.003}&layer=mapnik&marker=${lat},${lng}`;
  }, [location]);

  return (
    <div className="p-4 pb-2 space-y-5">
      {/* Compass Display */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Compass
        </h2>
        <Card>
          <CardContent className="p-6 flex flex-col items-center">
            {/* Compass Rose */}
            <div className="relative w-40 h-40 mb-4">
              <div className="absolute inset-0 rounded-full border-4 border-slate-200 dark:border-slate-700" />
              {/* Cardinal labels */}
              <span className="absolute top-1 left-1/2 -translate-x-1/2 text-xs font-bold text-red-500">N</span>
              <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-xs font-bold text-muted-foreground">S</span>
              <span className="absolute top-1/2 right-1 -translate-y-1/2 text-xs font-bold text-muted-foreground">E</span>
              <span className="absolute top-1/2 left-1 -translate-y-1/2 text-xs font-bold text-muted-foreground">W</span>
              {/* Needle */}
              <div
                className="absolute inset-0 flex items-center justify-center transition-transform duration-300"
                style={{ transform: `rotate(${heading || 0}deg)` }}
              >
                <Navigation className="h-12 w-12 text-red-500 -rotate-0" style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.2))" }} />
              </div>
            </div>
            {/* Heading text */}
            <div className="text-center">
              <p className="text-3xl font-bold tabular-nums">
                {heading != null ? `${heading}°` : "--"}
              </p>
              <p className="text-sm text-muted-foreground font-medium">{compassDirection}</p>
            </div>
            {compassError && (
              <p className="text-xs text-amber-600 mt-2">{compassError}</p>
            )}
          </CardContent>
        </Card>
      </section>

      {/* GPS Location */}
      <section>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          GPS Location
        </h2>
        <Card>
          <CardContent className="p-4 space-y-3">
            {loadingLocation ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground mr-2" />
                <span className="text-sm text-muted-foreground">Getting location...</span>
              </div>
            ) : locationError ? (
              <div className="text-center py-4">
                <p className="text-sm text-red-500 mb-2">{locationError}</p>
                <Button variant="outline" size="sm" onClick={getLocation}>
                  Retry
                </Button>
              </div>
            ) : location ? (
              <>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Latitude</p>
                    <p className="font-mono font-medium tabular-nums">{location.lat.toFixed(6)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Longitude</p>
                    <p className="font-mono font-medium tabular-nums">{location.lng.toFixed(6)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Accuracy</p>
                    <p className="font-mono font-medium tabular-nums">{accuracy ? `${Math.round(accuracy)}m` : "--"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Heading</p>
                    <p className="font-mono font-medium tabular-nums">
                      {heading != null ? `${heading}° ${compassDirection}` : "--"}
                    </p>
                  </div>
                </div>

                <div className="flex gap-2">
                  <Button variant="outline" size="sm" className="flex-1 gap-1.5" onClick={getLocation}>
                    <RefreshCw className="h-3.5 w-3.5" />
                    Update
                  </Button>
                  {project && (
                    <Button
                      size="sm"
                      className="flex-1 gap-1.5"
                      onClick={saveToProject}
                      disabled={saving}
                    >
                      {saving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MapPin className="h-3.5 w-3.5" />
                      )}
                      Save to Project
                    </Button>
                  )}
                </div>
              </>
            ) : null}
          </CardContent>
        </Card>
      </section>

      {/* Map Preview */}
      {location && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            Map
          </h2>
          <Card className="overflow-hidden">
            <iframe
              title="Map Preview"
              src={mapUrl}
              className="w-full h-48 border-0"
              loading="lazy"
              referrerPolicy="no-referrer"
            />
          </Card>
        </section>
      )}
    </div>
  );
}

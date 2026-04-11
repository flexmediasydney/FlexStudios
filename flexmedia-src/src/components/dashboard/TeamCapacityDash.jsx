import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  Camera,
  Video,
  ImageIcon,
  Film,
  PenTool,
  Compass,
  Crown,
  Activity,
  AlertTriangle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const ROLE_ICONS = {
  photographer: Camera,
  videographer: Video,
  image_editor: ImageIcon,
  video_editor: Film,
  floorplan_editor: PenTool,
  drone_editor: Compass,
  project_owner: Crown,
};

function roleIcon(role) {
  return ROLE_ICONS[role] || Activity;
}

const fh = (n) => n?.toFixed(1) ?? "0.0";

function pctRound(p) {
  return Math.round(p ?? 0);
}

/* Load colors: green(<80%) amber(80-100%) red(>100%) */
function loadColor(pct) {
  if (pct > 100) return "red";
  if (pct >= 80) return "amber";
  return "emerald";
}

/* Progress colors: green(>80%) amber(50-80%) red(<50%) */
function progressColor(pct) {
  if (pct >= 80) return "emerald";
  if (pct >= 50) return "amber";
  return "red";
}

function barClass(color) {
  return color === "red"
    ? "bg-red-500"
    : color === "amber"
    ? "bg-amber-500"
    : "bg-emerald-500";
}

function textCls(color) {
  return color === "red"
    ? "text-red-600 dark:text-red-400"
    : color === "amber"
    ? "text-amber-600 dark:text-amber-400"
    : "text-emerald-600 dark:text-emerald-400";
}

function borderCls(color) {
  return color === "red"
    ? "border-red-500"
    : color === "amber"
    ? "border-amber-500"
    : "border-emerald-500";
}

function badgeCls(color) {
  return color === "red"
    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : color === "amber"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
}

function loadLabel(pct) {
  if (pct > 100) return "overloaded";
  if (pct > 90) return "at capacity";
  if (pct > 80) return "busy";
  if (pct >= 60) return "moderate";
  return "light";
}

function progressLabel(pct) {
  if (pct > 90) return "nearly done";
  if (pct >= 70) return "on track";
  if (pct >= 50) return "slightly behind";
  return "behind schedule";
}

/* ------------------------------------------------------------------ */
/*  HoverDetail tooltip                                                */
/* ------------------------------------------------------------------ */

function HoverDetail({ children, content, align = "left" }) {
  const [show, setShow] = useState(false);
  return (
    <div
      className="relative"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div
          className={cn(
            "absolute z-50 top-full mt-1 bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 min-w-[280px] max-w-[340px] animate-in fade-in duration-150 text-xs",
            align === "right" ? "right-0" : "left-0"
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Thin bar component (reused everywhere)                             */
/* ------------------------------------------------------------------ */

function ThinBar({ pct, colorFn, height = "h-2" }) {
  const c = colorFn(pct ?? 0);
  return (
    <div className={cn("bg-muted rounded-full min-w-0", height)}>
      <div
        className={cn("rounded-full transition-all", height, barClass(c))}
        style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 1 - Team Summary                                           */
/* ------------------------------------------------------------------ */

function TeamSummaryCard({ team }) {
  const lc = loadColor(team.load_pct ?? 0);
  const isOverloaded = (team.load_pct ?? 0) > 100 || (team.overdue_task_count ?? 0) > 0;

  return (
    <Card
      className={cn(
        "p-4",
        isOverloaded && "border-l-4 border-l-red-500"
      )}
    >
      <p className="text-sm font-bold mb-1">{team.team_name}</p>
      <p className="text-xs text-muted-foreground mb-3">
        {team.summary || `${team.member_count} staff, ${pctRound(team.load_pct)}% loaded, ${pctRound(team.progress_pct)}% on track`}
      </p>
      <div className="flex gap-3">
        <div className="flex-1 space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Load</p>
          <ThinBar pct={team.load_pct} colorFn={loadColor} />
        </div>
        <div className="flex-1 space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Progress</p>
          <ThinBar pct={team.progress_pct} colorFn={progressColor} />
        </div>
      </div>
    </Card>
  );
}

function TeamSummarySection({ teams }) {
  if (!teams?.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Users className="h-4 w-4" /> Team Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {teams.map((t) => (
            <TeamSummaryCard key={t.team_name} team={t} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 2 - Staff Grid                                             */
/* ------------------------------------------------------------------ */

function StaffHoverContent({ u }) {
  const overdue = u.overdue_task_count ?? 0;
  const dueWeek = u.tasks_due_this_week_count ?? 0;
  const hoursDueWeek = u.hours_due_this_week ?? 0;
  const hoursOverdue = u.hours_overdue ?? 0;
  const logged = u.hours_logged ?? 0;
  const free = u.free_capacity_hours ?? 0;
  const unsched = u.hours_unscheduled ?? 0;

  return (
    <div className="space-y-2">
      <div>
        <p className="font-semibold text-sm">{u.user_name}</p>
        <p className="text-muted-foreground capitalize">{u.role?.replace(/_/g, " ")}</p>
      </div>
      <div className="border-t border-border" />

      {/* Load */}
      <div>
        <p className="font-medium">
          LOAD: {pctRound(u.load_pct)}%{" "}
          <span className="text-muted-foreground">({loadLabel(u.load_pct ?? 0)})</span>
        </p>
        <div className="flex items-center gap-2 mt-1">
          <ThinBar pct={u.load_pct} colorFn={loadColor} height="h-2.5" />
        </div>
        <p className="text-muted-foreground mt-0.5">
          {fh(u.committed_hours)}h committed / {fh(u.weekly_target_hours)}h target
        </p>
      </div>

      {/* Progress */}
      <div>
        <p className="font-medium">
          PROGRESS: {pctRound(u.progress_pct)}%{" "}
          <span className="text-muted-foreground">({progressLabel(u.progress_pct ?? 0)})</span>
        </p>
        <div className="flex items-center gap-2 mt-1">
          <ThinBar pct={u.progress_pct} colorFn={progressColor} height="h-2.5" />
        </div>
        <p className="text-muted-foreground mt-0.5">
          {fh(u.hours_logged)}h done / {fh(u.committed_hours)}h due
        </p>
      </div>

      <div className="border-t border-border" />

      {/* Breakdown */}
      <div className="space-y-0.5">
        <p className="font-medium mb-1">Breakdown:</p>
        <p>
          {dueWeek} task{dueWeek !== 1 ? "s" : ""} due this week ({fh(hoursDueWeek)}h)
        </p>
        {overdue > 0 && (
          <p className="text-red-600 dark:text-red-400">
            {overdue} overdue from past weeks ({fh(hoursOverdue)}h)
          </p>
        )}
        <p>{fh(logged)}h logged so far</p>
        <p>{fh(free)}h free capacity</p>
      </div>

      {unsched > 0 && (
        <>
          <div className="border-t border-border" />
          <p className="text-muted-foreground">
            Unscheduled: {fh(unsched)}h in tasks with no due date
          </p>
        </>
      )}
    </div>
  );
}

function StaffRow({ user }) {
  const lc = loadColor(user.load_pct ?? 0);
  const pc = progressColor(user.progress_pct ?? 0);
  const RIcon = roleIcon(user.role);
  const overdue = user.overdue_task_count ?? 0;

  return (
    <HoverDetail content={<StaffHoverContent u={user} />}>
      <div className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 rounded-lg transition-colors">
        {/* Avatar */}
        <div
          className={cn(
            "w-9 h-9 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 bg-muted",
            borderCls(lc)
          )}
        >
          {user.user_name?.charAt(0)?.toUpperCase() ?? "?"}
        </div>

        {/* Name + role */}
        <div className="w-36 shrink-0 min-w-0">
          <p className="text-sm font-medium truncate">{user.user_name}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <RIcon className="h-3 w-3 text-muted-foreground" />
            <span className="text-[10px] text-muted-foreground capitalize truncate">
              {user.role?.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        {/* Load bar */}
        <div className="flex-[2] min-w-0 space-y-0.5">
          <div className="flex items-center justify-between">
            <span className={cn("text-[10px] font-semibold uppercase", textCls(lc))}>
              Load {pctRound(user.load_pct)}%
            </span>
          </div>
          <ThinBar pct={user.load_pct} colorFn={loadColor} height="h-2.5" />
        </div>

        {/* Progress bar */}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center justify-between">
            <span className={cn("text-[10px] font-semibold uppercase", textCls(pc))}>
              Progress {pctRound(user.progress_pct)}%
            </span>
          </div>
          <ThinBar pct={user.progress_pct} colorFn={progressColor} height="h-2" />
        </div>

        {/* Overdue badge */}
        <div className="w-20 shrink-0 text-right">
          {overdue > 0 && (
            <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] rounded-full">
              {overdue} overdue
            </Badge>
          )}
        </div>

        {/* Hours text */}
        <span className="text-[10px] text-muted-foreground w-32 text-right shrink-0 hidden md:inline">
          {fh(user.committed_hours)}h committed / {fh(user.weekly_target_hours)}h target
        </span>
      </div>
    </HoverDetail>
  );
}

function StaffGrid({ users }) {
  const sorted = [...(users ?? [])].sort(
    (a, b) => (b.load_pct ?? 0) - (a.load_pct ?? 0)
  );

  if (!sorted.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4" /> Staff Load &amp; Progress
          </CardTitle>
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> On track
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> Caution
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> Alert
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-0.5">
        {sorted.map((u) => (
          <StaffRow key={u.user_name} user={u} />
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 4 - Role Capacity Grid                                     */
/* ------------------------------------------------------------------ */

function RoleCard({ role }) {
  const RIcon = roleIcon(role.role);
  const completionPct = role.completion_rate_pct ?? 0;
  const avgLoad = role.avg_utilization ?? 0;
  const lc = loadColor(avgLoad);

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="p-1.5 rounded-md bg-muted">
          <RIcon className="h-4 w-4" />
        </div>
        <p className="text-sm font-semibold capitalize">
          {role.role?.replace(/_/g, " ")}
        </p>
      </div>

      {/* Task completion */}
      <p className="text-xs text-muted-foreground mb-1">
        {role.completed}/{role.total} complete ({pctRound(completionPct)}%)
      </p>
      <ThinBar pct={completionPct} colorFn={progressColor} />

      {/* Staff count + avg load */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-[10px] text-muted-foreground">
          {role.member_count} staff
        </span>
        <Badge className={cn("text-[10px]", badgeCls(lc))}>
          Avg load: {pctRound(avgLoad)}%
        </Badge>
      </div>
    </Card>
  );
}

function RoleCapacityGrid({ roles }) {
  if (!roles?.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" /> Role Capacity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {roles.map((r) => (
            <RoleCard key={r.role} role={r} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Loading skeleton                                                   */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-lg" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Empty state                                                        */
/* ------------------------------------------------------------------ */

function EmptyState() {
  return (
    <Card className="p-8 text-center">
      <Users className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
      <p className="text-sm font-medium">No capacity data available</p>
      <p className="text-xs text-muted-foreground mt-1">
        Staff utilization data will appear once tasks are assigned and tracked.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main export                                                        */
/* ------------------------------------------------------------------ */

export default function TeamCapacityDash() {
  const { utilization, tasks, loading } = useDashboardStats();

  if (loading) return <LoadingSkeleton />;

  const byUser = utilization?.by_user ?? [];
  const byTeam = utilization?.by_team ?? [];
  const byRole = tasks?.by_role ?? [];

  if (!byUser.length && !byTeam.length) return <EmptyState />;

  return (
    <div className="space-y-4">
      <TeamSummarySection teams={byTeam} />
      <StaffGrid users={byUser} />
      <RoleCapacityGrid roles={byRole} />
    </div>
  );
}

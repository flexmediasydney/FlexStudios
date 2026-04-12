import { useState, useMemo, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
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
  TrendingUp,
  ShieldAlert,
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  Clock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useDashboardStats } from "@/components/hooks/useDashboardStats";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const ROLE_ICONS = {
  photographer: Camera,
  videographer: Video,
  image_editor: ImageIcon,
  video_editor: Film,
  floorplan_editor: PenTool,
  drone_editor: Compass,
  project_owner: Crown,
  admin: ShieldAlert,
};

const ROLE_ABBREV = {
  photographer: "PHOTO",
  videographer: "VIDEO",
  image_editor: "IMG",
  video_editor: "VID",
  floorplan_editor: "FLOOR",
  drone_editor: "DRONE",
  project_owner: "PM",
  admin: "ADMIN",
  unknown: "STAFF",
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function roleIcon(role) {
  return ROLE_ICONS[role] || Activity;
}

function roleAbbrev(role) {
  return ROLE_ABBREV[role] || ROLE_ABBREV[role?.toLowerCase()] || "STAFF";
}

const fh = (n) => (n?.toFixed(1) ?? "0.0") + "h";
const fhRaw = (n) => n?.toFixed(1) ?? "0.0";
const pctRound = (n) => Math.round(n ?? 0);

/* Load colors: emerald(<80%) amber(80-100%) red(>100%) */
function loadColor(pct) {
  if (pct > 100) return "red";
  if (pct >= 80) return "amber";
  return "emerald";
}

/* Progress colors: emerald(>80%) amber(50-80%) red(<50%) */
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

function badgeCls(color) {
  return color === "red"
    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : color === "amber"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
}

function bgCls(color) {
  return color === "red"
    ? "bg-red-500"
    : color === "amber"
    ? "bg-amber-500"
    : "bg-emerald-500";
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

/** Format week_start/week_end strings as "Apr 7-13" */
function formatWeekRange(weekStart, weekEnd) {
  if (!weekStart || !weekEnd) return "This week";
  try {
    const s = new Date(weekStart + "T00:00:00");
    const e = new Date(weekEnd + "T00:00:00");
    e.setDate(e.getDate() - 1); // week_end is exclusive (Mon next week)
    const monthShort = s.toLocaleString("en-US", { month: "short" });
    if (s.getMonth() === e.getMonth()) {
      return `${monthShort} ${s.getDate()}\u2013${e.getDate()}`;
    }
    const endMonth = e.toLocaleString("en-US", { month: "short" });
    return `${monthShort} ${s.getDate()}\u2013${endMonth} ${e.getDate()}`;
  } catch {
    return "This week";
  }
}

/* ------------------------------------------------------------------ */
/*  HoverDetail tooltip (state-driven, onMouseEnter/Leave)             */
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
            "absolute z-50 top-full mt-1 bg-popover text-popover-foreground border rounded-lg shadow-lg p-4 min-w-[280px] max-w-[360px] animate-in fade-in duration-150 text-xs",
            align === "right" ? "right-0" : "left-0",
          )}
        >
          {content}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ThinBar                                                            */
/* ------------------------------------------------------------------ */

function ThinBar({ pct, colorFn, height = "h-2", className: extraCn }) {
  const c = colorFn(pct ?? 0);
  return (
    <div className={cn("bg-muted rounded-full min-w-0", height, extraCn)}>
      <div
        className={cn(
          "rounded-full transition-all duration-500",
          height,
          barClass(c),
        )}
        style={{ width: `${Math.min(pct ?? 0, 100)}%` }}
      />
    </div>
  );
}

/* ================================================================== */
/*  SECTION 1 — Health Banner Strip                                    */
/* ================================================================== */

function KpiPill({ label, value, color, barPct, barColorFn }) {
  return (
    <div className="flex flex-col items-center gap-0.5 min-w-[100px] px-3 py-2">
      <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">
        {label}
      </span>
      <span className={cn("text-lg font-bold tabular-nums", textCls(color))}>
        {value}
      </span>
      {barPct != null && barColorFn && (
        <ThinBar
          pct={barPct}
          colorFn={barColorFn}
          height="h-1"
          className="w-full max-w-[80px]"
        />
      )}
    </div>
  );
}

function HealthBanner({ utilization, byUser }) {
  const overallLoad = utilization?.overall_load_pct ?? 0;
  const overallProgress = utilization?.overall_progress_pct ?? 0;

  const totalFree = (byUser ?? []).reduce(
    (sum, u) => sum + (u.free_capacity_hours ?? 0),
    0,
  );
  const totalTarget = (byUser ?? []).reduce(
    (sum, u) => sum + (u.weekly_target_hours ?? 0),
    0,
  );
  const totalOverdue = (byUser ?? []).reduce(
    (sum, u) => sum + (u.overdue_task_count ?? 0),
    0,
  );

  const weekLabel = formatWeekRange(
    utilization?.week_start,
    utilization?.week_end,
  );

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-center gap-1 divide-x divide-border py-1">
        <KpiPill
          label="Overall Load"
          value={`${pctRound(overallLoad)}%`}
          color={loadColor(overallLoad)}
          barPct={overallLoad}
          barColorFn={loadColor}
        />
        <KpiPill
          label="Overall Progress"
          value={`${pctRound(overallProgress)}%`}
          color={progressColor(overallProgress)}
          barPct={overallProgress}
          barColorFn={progressColor}
        />
        <KpiPill
          label="Free Capacity"
          value={`${fhRaw(totalFree)} of ${fhRaw(totalTarget)}h`}
          color={totalFree > 0 ? "emerald" : "red"}
          barPct={totalTarget > 0 ? (totalFree / totalTarget) * 100 : 0}
          barColorFn={() => (totalFree > 0 ? "emerald" : "red")}
        />
        <KpiPill
          label="Overdue Tasks"
          value={totalOverdue}
          color={totalOverdue > 0 ? "red" : "emerald"}
        />
        <KpiPill
          label="Week"
          value={weekLabel}
          color="emerald"
        />
      </div>
    </Card>
  );
}

/* ================================================================== */
/*  SECTION 2 — Attention Flags                                        */
/* ================================================================== */

function AttentionCard({ user, concern }) {
  const lc = loadColor(user.load_pct ?? 0);
  return (
    <div className="flex items-center gap-2 border-l-4 border-l-red-500 bg-red-50/50 dark:bg-red-950/20 rounded-r-lg px-3 py-2 min-w-[200px]">
      <div
        className={cn(
          "w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0",
          bgCls(lc),
        )}
      >
        {user.user_name?.charAt(0)?.toUpperCase() ?? "?"}
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold truncate">{user.user_name}</p>
        <p className="text-[10px] text-muted-foreground capitalize truncate">
          {user.role?.replace(/_/g, " ")}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span
            className={cn(
              "text-[10px] font-bold tabular-nums",
              textCls(lc),
            )}
          >
            {pctRound(user.load_pct)}% load
          </span>
          <span className="text-[10px] text-red-600 dark:text-red-400 font-medium">
            {concern}
          </span>
        </div>
      </div>
    </div>
  );
}

function AttentionFlags({ byUser }) {
  const flags = useMemo(() => {
    if (!byUser?.length) return [];
    const result = [];
    for (const u of byUser) {
      if ((u.load_pct ?? 0) > 100) {
        result.push({ user: u, concern: "overloaded" });
      } else if ((u.progress_pct ?? 0) < 50 && (u.committed_hours ?? 0) > 2) {
        result.push({ user: u, concern: "behind" });
      } else if ((u.overdue_task_count ?? 0) >= 2) {
        result.push({ user: u, concern: `${u.overdue_task_count} overdue` });
      }
    }
    return result.slice(0, 5);
  }, [byUser]);

  if (!flags.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-red-500" /> Needs Attention
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-2">
          {flags.map((f) => (
            <AttentionCard
              key={f.user.user_name}
              user={f.user}
              concern={f.concern}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  SECTION 3 — Team Summary Cards                                     */
/* ================================================================== */

function TeamHoverContent({ team }) {
  const members = team.members ?? [];
  return (
    <div className="space-y-2">
      <div>
        <p className="font-semibold text-sm">
          {team.team_name} &mdash; {team.member_count ?? members.length} members
        </p>
      </div>
      <div>
        <p className="font-medium">
          Load:{" "}
          <span className={textCls(loadColor(team.load_pct ?? 0))}>
            {pctRound(team.load_pct)}%
          </span>{" "}
          <span className="text-muted-foreground tabular-nums">
            ({fhRaw(team.total_committed_hours)} committed /{" "}
            {fhRaw(team.total_target_hours)} target)
          </span>
        </p>
        <p className="font-medium mt-1">
          Progress:{" "}
          <span className={textCls(progressColor(team.progress_pct ?? 0))}>
            {pctRound(team.progress_pct)}%
          </span>{" "}
          <span className="text-muted-foreground tabular-nums">
            ({fhRaw(team.total_logged_hours)} logged /{" "}
            {fhRaw(team.total_committed_hours)} committed)
          </span>
        </p>
      </div>

      {members.length > 0 && (
        <>
          <div className="border-t border-border pt-1">
            <p className="font-medium mb-1">Members:</p>
            {members.map((m) => (
              <p key={m.user_name} className="text-muted-foreground">
                &middot; {m.user_name}
                <span className="tabular-nums ml-2">
                  load {pctRound(m.load_pct)}%
                </span>
                <span className="tabular-nums ml-2">
                  progress {pctRound(m.progress_pct)}%
                </span>
              </p>
            ))}
          </div>
        </>
      )}

      <div className="border-t border-border pt-1 text-muted-foreground">
        <p>
          Overdue: {team.overdue_task_count ?? 0} tasks across team
        </p>
        <p>
          Free capacity: {fh(team.total_free_capacity)} total
        </p>
      </div>
    </div>
  );
}

function TeamSummaryCard({ team, onClick }) {
  const isOverloaded =
    (team.load_pct ?? 0) > 100 || (team.overdue_task_count ?? 0) > 0;
  const overdue = team.overdue_task_count ?? 0;
  const loadPct = team.load_pct ?? 0;
  const progPct = team.progress_pct ?? 0;

  return (
    <HoverDetail content={<TeamHoverContent team={team} />}>
      <Card
        onClick={() => onClick?.(team)}
        className={cn(
          "p-4 cursor-pointer",
          isOverloaded && "border-l-4 border-l-red-500",
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <p className="text-sm font-bold">{team.team_name}</p>
          <Badge
            variant="secondary"
            className="text-[10px] px-1.5 py-0 h-4 rounded-full"
          >
            {team.member_count ?? 0}
          </Badge>
        </div>

        {/* Summary sentence */}
        <p className="text-[11px] text-muted-foreground mb-3 line-clamp-2">
          {team.summary}
        </p>

        {/* Load bar */}
        <div className="space-y-0.5 mb-2">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
              Load
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold tabular-nums",
                textCls(loadColor(loadPct)),
              )}
            >
              {pctRound(loadPct)}%
            </span>
          </div>
          <ThinBar pct={loadPct} colorFn={loadColor} height="h-2" />
        </div>

        {/* Progress bar */}
        <div className="space-y-0.5 mb-3">
          <div className="flex items-center justify-between">
            <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
              Progress
            </span>
            <span
              className={cn(
                "text-[10px] font-semibold tabular-nums",
                textCls(progressColor(progPct)),
              )}
            >
              {pctRound(progPct)}%
            </span>
          </div>
          <ThinBar pct={progPct} colorFn={progressColor} height="h-1.5" />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span className="tabular-nums">
            {fh(team.total_free_capacity)} free
          </span>
          <span
            className={cn(
              "tabular-nums",
              overdue > 0 && "text-red-600 dark:text-red-400 font-medium",
            )}
          >
            {overdue} overdue
          </span>
        </div>
      </Card>
    </HoverDetail>
  );
}

function TeamSummarySection({ teams, onTeamClick }) {
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
            <TeamSummaryCard key={t.team_name} team={t} onClick={onTeamClick} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  SECTION 4 — Staff Grid (THE MAIN VISUAL)                           */
/* ================================================================== */

function StaffHoverContent({ u }) {
  const overdue = u.overdue_task_count ?? 0;
  const dueWeek = u.tasks_due_this_week_count ?? 0;
  const hoursDueWeek = u.hours_due_this_week ?? 0;
  const hoursOverdue = u.hours_overdue ?? 0;
  const logged = u.hours_logged ?? 0;
  const free = u.free_capacity_hours ?? 0;
  const unsched = u.hours_unscheduled ?? 0;
  const future = u.hours_future ?? 0;
  const loadPct = u.load_pct ?? 0;
  const progPct = u.progress_pct ?? 0;

  return (
    <div className="space-y-2">
      {/* Identity */}
      <div>
        <p className="font-semibold text-sm">
          {u.user_name} &mdash;{" "}
          <span className="capitalize font-normal">
            {u.role?.replace(/_/g, " ")}
          </span>
        </p>
        {u.team_name && (
          <p className="text-muted-foreground">{u.team_name}</p>
        )}
      </div>

      <div className="border-t border-border" />

      {/* Load */}
      <div>
        <p className="font-medium">
          LOAD:{" "}
          <span className={textCls(loadColor(loadPct))}>
            {pctRound(loadPct)}%
          </span>{" "}
          <span className="text-muted-foreground">
            ({loadLabel(loadPct)})
          </span>
        </p>
        <div className="mt-1">
          <ThinBar pct={loadPct} colorFn={loadColor} height="h-2.5" />
        </div>
        <p className="text-muted-foreground mt-0.5 tabular-nums">
          {fhRaw(u.committed_hours)} committed / {fhRaw(u.weekly_target_hours)}
          h target
        </p>
      </div>

      {/* Progress */}
      <div>
        <p className="font-medium">
          PROGRESS:{" "}
          <span className={textCls(progressColor(progPct))}>
            {pctRound(progPct)}%
          </span>{" "}
          <span className="text-muted-foreground">
            ({progressLabel(progPct)})
          </span>
        </p>
        <div className="mt-1">
          <ThinBar pct={progPct} colorFn={progressColor} height="h-2.5" />
        </div>
        <p className="text-muted-foreground mt-0.5 tabular-nums">
          {fhRaw(u.hours_logged)}h done / {fhRaw(u.committed_hours)}h committed
        </p>
      </div>

      <div className="border-t border-border" />

      {/* This Week */}
      <div className="space-y-0.5">
        <p className="font-medium mb-1">This Week:</p>
        <p className="tabular-nums">
          {dueWeek} task{dueWeek !== 1 ? "s" : ""} due ({fh(hoursDueWeek)}{" "}
          estimated)
        </p>
        {overdue > 0 && (
          <p className="text-red-600 dark:text-red-400 tabular-nums">
            {overdue} overdue from past ({fh(hoursOverdue)})
          </p>
        )}
        <p className="tabular-nums">{fh(logged)} logged so far</p>
        <p className="tabular-nums">{fh(free)} free capacity</p>
      </div>

      {/* Backlog */}
      {(unsched > 0 || future > 0) && (
        <>
          <div className="border-t border-border" />
          <div className="space-y-0.5">
            <p className="font-medium mb-1">Backlog:</p>
            {unsched > 0 && (
              <p className="text-muted-foreground tabular-nums">
                {fh(unsched)} in unscheduled tasks
              </p>
            )}
            {future > 0 && (
              <p className="text-muted-foreground tabular-nums">
                {fh(future)} in future weeks
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function StaffRow({ user, onClick }) {
  const lc = loadColor(user.load_pct ?? 0);
  const pc = progressColor(user.progress_pct ?? 0);
  const RIcon = roleIcon(user.role);
  const overdue = user.overdue_task_count ?? 0;
  const loadPct = user.load_pct ?? 0;
  const progPct = user.progress_pct ?? 0;
  const isEmpty = loadPct === 0 && (user.committed_hours ?? 0) === 0;
  const isOverloaded = loadPct > 100;

  return (
    <HoverDetail content={<StaffHoverContent u={user} />}>
      <div
        onClick={() => onClick?.(user)}
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors cursor-pointer",
          isOverloaded
            ? "bg-red-50/40 dark:bg-red-950/20 border border-red-200/50"
            : "hover:bg-muted/40",
          isEmpty && "opacity-50",
        )}
      >
        {/* Avatar — 36px circle, bg = load color, white initial */}
        <div
          className={cn(
            "w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0",
            bgCls(lc),
            isOverloaded && "animate-pulse-shadow",
          )}
        >
          {user.user_name?.charAt(0)?.toUpperCase() ?? "?"}
        </div>

        {/* Name block — w-40 */}
        <div className="w-40 shrink-0 min-w-0">
          <div className="flex items-center gap-1.5">
            <p className="text-sm font-semibold truncate">{user.user_name}</p>
            <span className="inline-flex items-center gap-0.5 rounded-full bg-muted px-1.5 py-0 text-[9px] font-medium text-muted-foreground shrink-0">
              <RIcon className="h-2.5 w-2.5" />
              {roleAbbrev(user.role)}
            </span>
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[11px] text-muted-foreground truncate">
              {user.team_name || "No team"}
            </span>
            {overdue > 0 && (
              <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[9px] rounded-full px-1.5 py-0 h-3.5 shrink-0">
                {overdue} overdue
              </Badge>
            )}
          </div>
        </div>

        {/* Bars area — flex-1 */}
        <div className="flex-1 min-w-0 space-y-1">
          {isEmpty ? (
            <p className="text-[11px] text-muted-foreground italic">
              No tasks due this week
            </p>
          ) : (
            <>
              {/* Load bar (taller) */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Load
                  </span>
                  <span
                    className={cn(
                      "text-[10px] font-bold tabular-nums",
                      textCls(lc),
                    )}
                  >
                    {pctRound(loadPct)}%
                  </span>
                </div>
                <ThinBar pct={loadPct} colorFn={loadColor} height="h-2.5" />
              </div>

              {/* Progress bar (thinner) */}
              <div className="space-y-0.5">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Progress
                  </span>
                  <span
                    className={cn(
                      "text-[10px] font-bold tabular-nums",
                      textCls(pc),
                    )}
                  >
                    {pctRound(progPct)}%
                  </span>
                </div>
                <ThinBar
                  pct={progPct}
                  colorFn={progressColor}
                  height="h-1.5"
                />
              </div>
            </>
          )}
        </div>

        {/* Hours context — w-36, hidden on mobile */}
        <div className="w-36 shrink-0 text-right hidden md:block">
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {fhRaw(user.committed_hours)}h / {fhRaw(user.weekly_target_hours)}h
            target
          </p>
          <p className="text-[10px] text-muted-foreground tabular-nums">
            {fhRaw(user.hours_logged)}h logged
          </p>
        </div>
      </div>
    </HoverDetail>
  );
}

function StaffGrid({ users, onStaffClick }) {
  const sorted = useMemo(
    () =>
      [...(users ?? [])].sort(
        (a, b) => (b.load_pct ?? 0) - (a.load_pct ?? 0),
      ),
    [users],
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
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" />{" "}
              On track
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />{" "}
              Caution
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-red-500" />{" "}
              Alert
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-0.5">
        {sorted.map((u) => (
          <StaffRow key={u.user_name} user={u} onClick={onStaffClick} />
        ))}
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  SECTION 5 — Role Capacity Grid                                     */
/* ================================================================== */

function RoleHoverContent({ role, roleName, memberCount, avgLoad, tasksPerPerson }) {
  return (
    <div className="space-y-1.5">
      <p className="font-semibold text-sm capitalize">
        {roleName.replace(/_/g, " ")}
      </p>
      <div className="border-t border-border" />
      <p className="tabular-nums">
        Tasks: {role.completed ?? 0} done / {role.total ?? 0} total (
        {pctRound(role.completion_rate_pct)}%)
      </p>
      <p className="tabular-nums">Staff: {memberCount} assigned</p>
      <p className="tabular-nums">Avg load: {pctRound(avgLoad)}%</p>
      <p className="tabular-nums">
        Tasks per person: {tasksPerPerson.toFixed(1)}
      </p>
    </div>
  );
}

function RoleCard({ roleName, role, memberCount, avgLoad, onClick }) {
  const RIcon = roleIcon(roleName);
  const completionPct = role.completion_rate_pct ?? 0;
  const lc = loadColor(avgLoad);
  const tasksPerPerson = memberCount > 0 ? (role.total ?? 0) / memberCount : 0;

  return (
    <HoverDetail
      content={
        <RoleHoverContent
          role={role}
          roleName={roleName}
          memberCount={memberCount}
          avgLoad={avgLoad}
          tasksPerPerson={tasksPerPerson}
        />
      }
    >
      <Card className="p-4 cursor-pointer" onClick={() => onClick?.({ role: roleName, name: roleName, data: role, memberCount, avgLoad })}>
        <div className="flex items-center gap-2 mb-3">
          <div className="p-1.5 rounded-md bg-muted">
            <RIcon className="h-4 w-4" />
          </div>
          <p className="text-sm font-semibold capitalize">
            {roleName.replace(/_/g, " ")}
          </p>
        </div>

        {/* Task completion */}
        <p className="text-xs text-muted-foreground mb-1 tabular-nums">
          {role.completed ?? 0}/{role.total ?? 0} complete (
          {pctRound(completionPct)}%)
        </p>
        <ThinBar pct={completionPct} colorFn={progressColor} />

        {/* Staff count + avg load */}
        <div className="flex items-center justify-between mt-3">
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {memberCount} staff
          </span>
          <Badge className={cn("text-[10px]", badgeCls(lc))}>
            Avg load: {pctRound(avgLoad)}%
          </Badge>
        </div>
      </Card>
    </HoverDetail>
  );
}

function RoleCapacityGrid({ rolesMap, byUser, onRoleClick }) {
  // Compute member count and avg load per role from byUser
  const roleStats = useMemo(() => {
    const stats = {};
    for (const u of byUser ?? []) {
      const r = u.role || "unknown";
      if (!stats[r]) stats[r] = { count: 0, loads: [] };
      stats[r].count += 1;
      stats[r].loads.push(u.load_pct ?? 0);
    }
    return stats;
  }, [byUser]);

  const roleEntries = useMemo(() => {
    if (!rolesMap || typeof rolesMap !== "object") return [];
    return Object.entries(rolesMap)
      .filter(([name]) => name !== "none")
      .map(([name, data]) => {
        const s = roleStats[name] || { count: 0, loads: [] };
        const avgLoad =
          s.loads.length > 0
            ? s.loads.reduce((a, b) => a + b, 0) / s.loads.length
            : 0;
        return { name, data, memberCount: s.count, avgLoad };
      })
      .sort((a, b) => (b.data.total ?? 0) - (a.data.total ?? 0));
  }, [rolesMap, roleStats]);

  if (!roleEntries.length) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <TrendingUp className="h-4 w-4" /> Role Capacity
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {roleEntries.map((r) => (
            <RoleCard
              key={r.name}
              roleName={r.name}
              role={r.data}
              memberCount={r.memberCount}
              avgLoad={r.avgLoad}
              onClick={onRoleClick}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/* ================================================================== */
/*  SECTION 6 — Drill-Down Modal                                       */
/* ================================================================== */

/** Days overdue helper */
function daysOverdue(dueDate) {
  const due = new Date(dueDate);
  const now = new Date();
  const diff = Math.floor((now - due) / (1000 * 60 * 60 * 24));
  return diff > 0 ? diff : 0;
}

/** Check if a date falls within the current week (Mon-Sun) */
function isThisWeek(dateStr) {
  if (!dateStr) return false;
  const d = new Date(dateStr);
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return d >= monday && d <= sunday;
}

/** Categorize tasks into groups */
function categorizeTasks(tasks) {
  const now = new Date();
  const completed = [];
  const dueThisWeek = [];
  const overdue = [];
  const unscheduled = [];
  const future = [];

  for (const t of tasks) {
    if (t.is_deleted) continue;
    if (t.is_completed) { completed.push(t); continue; }
    const due = t.due_date ? new Date(t.due_date) : null;
    if (!due) { unscheduled.push(t); continue; }
    if (due < now) { overdue.push(t); continue; }
    if (isThisWeek(t.due_date)) { dueThisWeek.push(t); continue; }
    future.push(t);
  }
  return { completed, dueThisWeek, overdue, unscheduled, future };
}

/** A single task row in the drill-down modal */
function DrillDownTaskRow({ task, showAssignee = false, projectMap }) {
  const isOverdue = !task.is_completed && task.due_date && new Date(task.due_date) < new Date();
  const isDone = task.is_completed;
  const projectName = task.project_title || projectMap?.[task.project_id] || "";

  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-2 text-xs",
      isOverdue && "bg-red-50/50 dark:bg-red-950/10",
    )}>
      {/* Status icon */}
      {isDone ? (
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 shrink-0" />
      ) : isOverdue ? (
        <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0" />
      ) : (
        <Circle className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      )}

      {/* Task title */}
      <span className={cn("flex-1 truncate", isDone && "line-through text-muted-foreground")} title={task.title}>
        {task.title || "Untitled task"}
      </span>

      {/* Project name */}
      {projectName && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[120px] hidden sm:inline" title={projectName}>
          {projectName}
        </span>
      )}

      {/* Assignee (for team/role views) */}
      {showAssignee && task.assigned_to_name && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[80px]">
          {task.assigned_to_name}
        </span>
      )}

      {/* Status text */}
      {isDone ? (
        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[9px] px-1.5 py-0 h-4 shrink-0">
          done
        </Badge>
      ) : isOverdue ? (
        <span className="text-[10px] font-medium text-red-600 dark:text-red-400 shrink-0 tabular-nums">
          {daysOverdue(task.due_date)}d overdue
        </span>
      ) : task.due_date ? (
        <span className="text-[10px] text-muted-foreground shrink-0">
          due {new Date(task.due_date).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
        </span>
      ) : (
        <span className="text-[10px] text-muted-foreground shrink-0">no date</span>
      )}
    </div>
  );
}

/** Section header inside the modal */
function DrillDownSection({ title, count, variant = "default", children }) {
  return (
    <div className={cn(
      "rounded-lg border",
      variant === "overdue" && "border-red-200 dark:border-red-900/50",
    )}>
      <div className={cn(
        "px-3 py-2 rounded-t-lg",
        variant === "overdue" ? "bg-red-50 dark:bg-red-950/30" : "bg-muted/50",
      )}>
        <p className="text-xs font-semibold uppercase tracking-wide">
          {title}
          {count != null && (
            <span className="ml-1.5 font-normal text-muted-foreground">
              ({count} task{count !== 1 ? "s" : ""})
            </span>
          )}
        </p>
      </div>
      <div className="divide-y divide-border">
        {children}
      </div>
    </div>
  );
}

/** Member row inside team/role drill-down */
function MemberRow({ member, taskCount }) {
  const lc = loadColor(member.load_pct ?? 0);
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className={cn("w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0", bgCls(lc))}>
        {member.user_name?.charAt(0)?.toUpperCase() ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold truncate">{member.user_name}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-20">
          <ThinBar pct={member.load_pct ?? 0} colorFn={loadColor} height="h-1.5" />
        </div>
        <span className={cn("text-[10px] font-bold tabular-nums w-8 text-right", textCls(lc))}>
          {pctRound(member.load_pct)}%
        </span>
        {taskCount != null && (
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {taskCount} tasks
          </span>
        )}
      </div>
    </div>
  );
}

/* ------- Staff Drill-Down Content ------- */
function StaffDrillContent({ user, projectMap }) {
  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["drill-staff-tasks", user.user_id],
    queryFn: () => api.entities.ProjectTask.filter({ assigned_to: user.user_id }, null, 200),
    enabled: !!user.user_id,
    staleTime: 60_000,
  });

  const cats = useMemo(() => categorizeTasks(tasks), [tasks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading tasks...</span>
      </div>
    );
  }

  const activeTasks = tasks.filter(t => !t.is_deleted);

  return (
    <div className="space-y-4">
      {/* Summary line */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>Load: <strong className={textCls(loadColor(user.load_pct ?? 0))}>{pctRound(user.load_pct)}%</strong></span>
        <span>Progress: <strong className={textCls(progressColor(user.progress_pct ?? 0))}>{pctRound(user.progress_pct)}%</strong></span>
        <span>{fhRaw(user.weekly_target_hours)}h target</span>
        <span>{activeTasks.length} total tasks</span>
      </div>

      {/* Overdue */}
      {cats.overdue.length > 0 && (
        <DrillDownSection title="Overdue" count={cats.overdue.length} variant="overdue">
          {cats.overdue.map(t => <DrillDownTaskRow key={t.id} task={t} projectMap={projectMap} />)}
        </DrillDownSection>
      )}

      {/* Due this week */}
      {cats.dueThisWeek.length > 0 && (
        <DrillDownSection title="Due This Week" count={cats.dueThisWeek.length}>
          {cats.dueThisWeek.map(t => <DrillDownTaskRow key={t.id} task={t} projectMap={projectMap} />)}
        </DrillDownSection>
      )}

      {/* Future */}
      {cats.future.length > 0 && (
        <DrillDownSection title="Upcoming" count={cats.future.length}>
          {cats.future.map(t => <DrillDownTaskRow key={t.id} task={t} projectMap={projectMap} />)}
        </DrillDownSection>
      )}

      {/* Completed this week */}
      {cats.completed.length > 0 && (
        <DrillDownSection title="Completed" count={cats.completed.length}>
          {cats.completed.slice(0, 10).map(t => <DrillDownTaskRow key={t.id} task={t} projectMap={projectMap} />)}
          {cats.completed.length > 10 && (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              + {cats.completed.length - 10} more completed tasks
            </p>
          )}
        </DrillDownSection>
      )}

      {/* Unscheduled */}
      {cats.unscheduled.length > 0 && (
        <DrillDownSection title="Unscheduled Backlog" count={cats.unscheduled.length}>
          {cats.unscheduled.slice(0, 10).map(t => <DrillDownTaskRow key={t.id} task={t} projectMap={projectMap} />)}
          {cats.unscheduled.length > 10 && (
            <p className="px-3 py-2 text-[10px] text-muted-foreground">
              + {cats.unscheduled.length - 10} more unscheduled tasks
            </p>
          )}
        </DrillDownSection>
      )}

      {activeTasks.length === 0 && (
        <p className="text-center py-8 text-sm text-muted-foreground">No tasks assigned</p>
      )}
    </div>
  );
}

/* ------- Team Drill-Down Content ------- */
function TeamDrillContent({ team, byUser, projectMap }) {
  const teamMembers = useMemo(
    () => (byUser ?? []).filter(u => u.team_name === team.team_name),
    [byUser, team.team_name],
  );

  const memberIds = useMemo(() => teamMembers.map(m => m.user_id).filter(Boolean), [teamMembers]);

  const { data: allTasks = [], isLoading } = useQuery({
    queryKey: ["drill-team-tasks", team.team_name, memberIds],
    queryFn: async () => {
      if (!memberIds.length) return [];
      const results = await Promise.all(
        memberIds.map(uid => api.entities.ProjectTask.filter({ assigned_to: uid }, null, 200)),
      );
      return results.flat();
    },
    enabled: memberIds.length > 0,
    staleTime: 60_000,
  });

  const activeTasks = useMemo(() => allTasks.filter(t => !t.is_deleted && !t.is_completed), [allTasks]);

  // Group active tasks by project
  const byProject = useMemo(() => {
    const map = {};
    for (const t of activeTasks) {
      const key = t.project_id || "unassigned";
      const name = t.project_title || projectMap?.[t.project_id] || "No Project";
      if (!map[key]) map[key] = { name, tasks: [] };
      map[key].tasks.push(t);
    }
    return Object.values(map).sort((a, b) => b.tasks.length - a.tasks.length);
  }, [activeTasks, projectMap]);

  // Per-member task counts
  const memberTaskCounts = useMemo(() => {
    const counts = {};
    for (const t of activeTasks) {
      if (t.assigned_to) counts[t.assigned_to] = (counts[t.assigned_to] || 0) + 1;
    }
    return counts;
  }, [activeTasks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading tasks...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary line */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>{teamMembers.length} members</span>
        <span>Load: <strong className={textCls(loadColor(team.load_pct ?? 0))}>{pctRound(team.load_pct)}%</strong></span>
        <span>Progress: <strong className={textCls(progressColor(team.progress_pct ?? 0))}>{pctRound(team.progress_pct)}%</strong></span>
      </div>

      {/* Members */}
      <DrillDownSection title="Members" count={teamMembers.length}>
        {teamMembers.map(m => (
          <MemberRow key={m.user_name} member={m} taskCount={memberTaskCounts[m.user_id] ?? 0} />
        ))}
      </DrillDownSection>

      {/* Tasks grouped by project */}
      {byProject.length > 0 && (
        <DrillDownSection title="Active Tasks by Project" count={activeTasks.length}>
          {byProject.map(group => (
            <div key={group.name}>
              <div className="px-3 py-1.5 bg-muted/30">
                <p className="text-[11px] font-semibold truncate">{group.name}</p>
              </div>
              {group.tasks.map(t => (
                <DrillDownTaskRow key={t.id} task={t} showAssignee projectMap={projectMap} />
              ))}
            </div>
          ))}
        </DrillDownSection>
      )}

      {activeTasks.length === 0 && (
        <p className="text-center py-8 text-sm text-muted-foreground">No active tasks for this team</p>
      )}
    </div>
  );
}

/* ------- Role Drill-Down Content ------- */
function RoleDrillContent({ roleName, roleData, byUser, projectMap }) {
  const roleMembers = useMemo(
    () => (byUser ?? []).filter(u => u.role === roleName),
    [byUser, roleName],
  );

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["drill-role-tasks", roleName],
    queryFn: () => api.entities.ProjectTask.filter({ auto_assign_role: roleName }, null, 300),
    enabled: !!roleName,
    staleTime: 60_000,
  });

  const cats = useMemo(() => categorizeTasks(tasks), [tasks]);
  const activeTasks = useMemo(() => tasks.filter(t => !t.is_deleted), [tasks]);

  // Per-member task counts from role tasks
  const memberTaskCounts = useMemo(() => {
    const counts = {};
    for (const t of activeTasks) {
      if (t.assigned_to) counts[t.assigned_to] = (counts[t.assigned_to] || 0) + 1;
    }
    return counts;
  }, [activeTasks]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        <span className="ml-2 text-sm text-muted-foreground">Loading tasks...</span>
      </div>
    );
  }

  const totalComplete = roleData?.completed ?? cats.completed.length;
  const totalTasks = roleData?.total ?? activeTasks.length;
  const avgLoad = roleMembers.length > 0
    ? roleMembers.reduce((s, m) => s + (m.load_pct ?? 0), 0) / roleMembers.length
    : 0;

  return (
    <div className="space-y-4">
      {/* Summary line */}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        <span>Tasks: <strong>{totalComplete}/{totalTasks}</strong> complete</span>
        <span>{roleMembers.length} staff</span>
        <span>Avg load: <strong className={textCls(loadColor(avgLoad))}>{pctRound(avgLoad)}%</strong></span>
      </div>

      {/* Staff in this role */}
      {roleMembers.length > 0 && (
        <DrillDownSection title="Staff in This Role" count={roleMembers.length}>
          {roleMembers.map(m => (
            <MemberRow key={m.user_name} member={m} taskCount={memberTaskCounts[m.user_id] ?? 0} />
          ))}
        </DrillDownSection>
      )}

      {/* Task breakdown summary */}
      <div className="rounded-lg border">
        <div className="px-3 py-2 bg-muted/50 rounded-t-lg">
          <p className="text-xs font-semibold uppercase tracking-wide">Task Breakdown</p>
        </div>
        <div className="px-3 py-2 space-y-1 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
            <span>{cats.completed.length} completed</span>
          </div>
          <div className="flex items-center gap-2">
            <Circle className="h-3.5 w-3.5 text-muted-foreground" />
            <span>{cats.dueThisWeek.length + cats.future.length + cats.unscheduled.length} pending</span>
          </div>
          {cats.overdue.length > 0 && (
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
              <span className="text-red-600 dark:text-red-400">{cats.overdue.length} overdue</span>
            </div>
          )}
        </div>
      </div>

      {/* Overdue tasks */}
      {cats.overdue.length > 0 && (
        <DrillDownSection title="Overdue Tasks" count={cats.overdue.length} variant="overdue">
          {cats.overdue.map(t => <DrillDownTaskRow key={t.id} task={t} showAssignee projectMap={projectMap} />)}
        </DrillDownSection>
      )}

      {activeTasks.length === 0 && (
        <p className="text-center py-8 text-sm text-muted-foreground">No tasks for this role</p>
      )}
    </div>
  );
}

/* ------- Main DrillDown Modal ------- */
function DrillDownModal({ drillDown, onClose, byUser, projectMap }) {
  if (!drillDown) return null;

  const { type, data } = drillDown;

  let title = "";
  let subtitle = "";
  const RIcon = type === "role" ? roleIcon(data.role || data.name) : null;

  if (type === "staff") {
    title = data.user_name || "Staff Member";
    subtitle = (data.role?.replace(/_/g, " ") || "Staff") + (data.team_name ? ` \u00B7 ${data.team_name}` : "");
  } else if (type === "team") {
    title = data.team_name || "Team";
    subtitle = `${data.member_count ?? 0} members`;
  } else if (type === "role") {
    const roleName = data.role || data.name || "";
    title = roleName.replace(/_/g, " ");
    subtitle = `${data.memberCount ?? 0} staff`;
  }

  return (
    <Dialog open={!!drillDown} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 capitalize">
            {RIcon && <RIcon className="h-5 w-5" />}
            {title}
          </DialogTitle>
          <DialogDescription className="capitalize">{subtitle}</DialogDescription>
        </DialogHeader>

        {type === "staff" && (
          <StaffDrillContent user={data} projectMap={projectMap} />
        )}
        {type === "team" && (
          <TeamDrillContent team={data} byUser={byUser} projectMap={projectMap} />
        )}
        {type === "role" && (
          <RoleDrillContent
            roleName={data.role || data.name}
            roleData={data.data || data}
            byUser={byUser}
            projectMap={projectMap}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== */
/*  Loading skeleton                                                   */
/* ================================================================== */

function LoadingSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-16 rounded-lg" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-36 rounded-lg" />
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

/* ================================================================== */
/*  Empty state                                                        */
/* ================================================================== */

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

/* ================================================================== */
/*  Pulse shadow animation (inline style tag for overloaded avatars)   */
/* ================================================================== */

const PULSE_SHADOW_CSS = `
@keyframes pulse-shadow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4); }
  50% { box-shadow: 0 0 8px 3px rgba(239, 68, 68, 0.25); }
}
.animate-pulse-shadow {
  animation: pulse-shadow 2s ease-in-out infinite;
}
`;

/* ================================================================== */
/*  Main export                                                        */
/* ================================================================== */

export default function TeamCapacityDash() {
  const { data, isLoading, computed_at } = useDashboardStats();
  const [drillDown, setDrillDown] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const queryClient = useQueryClient();

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await api.functions.invoke('calculateDashboardStats', {});
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    } catch { /* fallback: just re-read cache */
      queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
    } finally {
      setTimeout(() => setRefreshing(false), 1000);
    }
  }, [queryClient]);

  // Fetch a lightweight project map for showing project names in drill-downs
  const { data: projectMap = {} } = useQuery({
    queryKey: ["drill-project-map"],
    queryFn: async () => {
      const projects = await api.entities.Project.list(null, 500);
      const map = {};
      for (const p of projects) {
        map[p.id] = p.property_address || p.title || p.project_name || "Untitled";
      }
      return map;
    },
    staleTime: 5 * 60_000,
    enabled: !!drillDown, // only fetch when a drill-down is open
  });

  if (isLoading) return <LoadingSkeleton />;

  const utilization = data?.utilization;
  const tasks = data?.tasks;
  const byUser = utilization?.by_user ?? [];
  const byTeam = utilization?.by_team ?? [];
  const byRole = tasks?.by_role ?? {};

  if (!byUser.length && !byTeam.length) return <EmptyState />;

  const handleStaffClick = (user) => setDrillDown({ type: "staff", data: user });
  const handleTeamClick = (team) => setDrillDown({ type: "team", data: team });
  const handleRoleClick = (roleObj) => setDrillDown({ type: "role", data: roleObj });

  return (
    <>
      <style>{PULSE_SHADOW_CSS}</style>
      <div className="space-y-4">
        {/* Refresh bar */}
        <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>Stats computed {computed_at ? new Date(computed_at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' }) : '—'}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={refreshing}
            onClick={handleRefresh}
          >
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
            {refreshing ? 'Recomputing...' : 'Refresh'}
          </Button>
        </div>

        {/* Section 1: Health Banner Strip */}
        <HealthBanner utilization={utilization} byUser={byUser} />

        {/* Section 2: Attention Flags (conditional) */}
        <AttentionFlags byUser={byUser} />

        {/* Section 3: Team Summary Cards */}
        <TeamSummarySection teams={byTeam} onTeamClick={handleTeamClick} />

        {/* Section 4: Staff Grid (main visual) */}
        <StaffGrid users={byUser} onStaffClick={handleStaffClick} />

        {/* Section 5: Role Capacity Grid */}
        <RoleCapacityGrid rolesMap={byRole} byUser={byUser} onRoleClick={handleRoleClick} />
      </div>

      {/* Section 6: Drill-Down Modal */}
      <DrillDownModal
        drillDown={drillDown}
        onClose={() => setDrillDown(null)}
        byUser={byUser}
        projectMap={projectMap}
      />
    </>
  );
}

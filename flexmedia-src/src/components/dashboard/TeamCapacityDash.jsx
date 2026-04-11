import { useState, useMemo } from "react";
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
  TrendingUp,
  ShieldAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
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

function TeamSummaryCard({ team }) {
  const isOverloaded =
    (team.load_pct ?? 0) > 100 || (team.overdue_task_count ?? 0) > 0;
  const overdue = team.overdue_task_count ?? 0;
  const loadPct = team.load_pct ?? 0;
  const progPct = team.progress_pct ?? 0;

  return (
    <HoverDetail content={<TeamHoverContent team={team} />}>
      <Card
        className={cn(
          "p-4 cursor-default",
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

function StaffRow({ user }) {
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
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-colors",
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

function StaffGrid({ users }) {
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
          <StaffRow key={u.user_name} user={u} />
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

function RoleCard({ roleName, role, memberCount, avgLoad }) {
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
      <Card className="p-4 cursor-default">
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

function RoleCapacityGrid({ rolesMap, byUser }) {
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
            />
          ))}
        </div>
      </CardContent>
    </Card>
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
  const { data, isLoading } = useDashboardStats();

  if (isLoading) return <LoadingSkeleton />;

  const utilization = data?.utilization;
  const tasks = data?.tasks;
  const byUser = utilization?.by_user ?? [];
  const byTeam = utilization?.by_team ?? [];
  const byRole = tasks?.by_role ?? {};

  if (!byUser.length && !byTeam.length) return <EmptyState />;

  return (
    <>
      <style>{PULSE_SHADOW_CSS}</style>
      <div className="space-y-4">
        {/* Section 1: Health Banner Strip */}
        <HealthBanner utilization={utilization} byUser={byUser} />

        {/* Section 2: Attention Flags (conditional) */}
        <AttentionFlags byUser={byUser} />

        {/* Section 3: Team Summary Cards */}
        <TeamSummarySection teams={byTeam} />

        {/* Section 4: Staff Grid (main visual) */}
        <StaffGrid users={byUser} />

        {/* Section 5: Role Capacity Grid */}
        <RoleCapacityGrid rolesMap={byRole} byUser={byUser} />
      </div>
    </>
  );
}

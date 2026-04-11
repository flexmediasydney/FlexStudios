import { useState, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users,
  AlertTriangle,
  TrendingDown,
  ChevronDown,
  Clock,
  Camera,
  Video,
  ImageIcon,
  Film,
  PenTool,
  Compass,
  Crown,
  Activity,
  Zap,
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

function fmtHours(h) {
  return (h ?? 0).toFixed(1);
}

function fmtPct(p) {
  return Math.round(p ?? 0);
}

function pctColor(pct) {
  if (pct > 90) return "red";
  if (pct > 70) return "amber";
  return "emerald";
}

function barBg(pct) {
  const c = pctColor(pct);
  return c === "red" ? "bg-red-500" : c === "amber" ? "bg-amber-500" : "bg-emerald-500";
}

function textColor(pct) {
  const c = pctColor(pct);
  return c === "red" ? "text-red-600" : c === "amber" ? "text-amber-600" : "text-emerald-600";
}

function badgeBg(pct) {
  const c = pctColor(pct);
  return c === "red"
    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
    : c === "amber"
    ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
    : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400";
}

function statusLabel(pct) {
  if (pct > 100) return "Over capacity";
  if (pct > 90) return "At capacity";
  if (pct > 70) return "Healthy load";
  if (pct > 40) return "Normal";
  return "Underloaded";
}

function statusEmoji(pct) {
  if (pct > 100) return "\u{1F6A8}";
  if (pct > 90) return "\u26A0\uFE0F";
  if (pct > 70) return "\u{1F7E1}";
  if (pct > 40) return "\u2705";
  return "\u{1F535}";
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
            "absolute z-50 top-full mt-1 bg-popover text-popover-foreground border rounded-lg shadow-lg p-3 min-w-[260px] max-w-[320px] animate-in fade-in duration-150 text-xs",
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
/*  Color legend strip                                                 */
/* ------------------------------------------------------------------ */

function ColorLegend() {
  return (
    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-emerald-500" /> &lt;70%
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-amber-500" /> 70-90%
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block w-2 h-2 rounded-full bg-red-500" /> &gt;90%
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 1 - Summary Strip                                          */
/* ------------------------------------------------------------------ */

function SummaryStrip({ overallPct, totalLogged, totalEstimated, totalCapacity, overloadedCount, underloadedCount, onScrollOverloaded, onScrollUnderloaded }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
      {/* Overall Utilization */}
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg", badgeBg(overallPct))}>
            <Activity className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Overall Utilization
            </p>
            <p className={cn("text-2xl font-bold", textColor(overallPct))}>
              {fmtPct(overallPct)}%
            </p>
          </div>
        </div>
      </Card>

      {/* Hours Logged vs Estimated */}
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            <Clock className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Hours Tracked
            </p>
            <p className="text-2xl font-bold">
              {fmtHours(totalLogged)}h{" "}
              <span className="text-sm font-normal text-muted-foreground">
                / {fmtHours(totalEstimated)}h
              </span>
            </p>
          </div>
        </div>
      </Card>

      {/* Available Capacity */}
      <Card className="p-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
            <Zap className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Available Capacity
            </p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-400">
              {fmtHours(totalCapacity)}h
            </p>
          </div>
        </div>
      </Card>

      {/* Overloaded */}
      <Card
        className={cn("p-4 cursor-pointer transition-colors", overloadedCount > 0 && "hover:border-red-300")}
        onClick={onScrollOverloaded}
      >
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg", overloadedCount > 0 ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" : "bg-muted text-muted-foreground")}>
            <AlertTriangle className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Overloaded Staff
            </p>
            <div className="flex items-center gap-2">
              <p className="text-2xl font-bold">{overloadedCount}</p>
              {overloadedCount > 0 && (
                <Badge variant="destructive" className="text-[10px]">
                  &gt;90%
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Underloaded */}
      <Card
        className={cn("p-4 cursor-pointer transition-colors", underloadedCount > 0 && "hover:border-amber-300")}
        onClick={onScrollUnderloaded}
      >
        <div className="flex items-center gap-3">
          <div className={cn("p-2 rounded-lg", underloadedCount > 0 ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" : "bg-muted text-muted-foreground")}>
            <TrendingDown className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
              Underloaded Staff
            </p>
            <div className="flex items-center gap-2">
              <p className="text-2xl font-bold">{underloadedCount}</p>
              {underloadedCount > 0 && (
                <Badge className="text-[10px] bg-amber-500 hover:bg-amber-600">
                  &lt;40%
                </Badge>
              )}
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 2 - Team Overview                                          */
/* ------------------------------------------------------------------ */

function TeamRow({ team }) {
  const [expanded, setExpanded] = useState(false);
  const pct = team.utilization_pct ?? 0;
  const logged = team.hours_logged ?? 0;
  const estimated = team.hours_estimated ?? 0;
  const members = team.members ?? [];

  const sortedMembers = [...members].sort(
    (a, b) => (b.utilization_pct ?? 0) - (a.utilization_pct ?? 0)
  );
  const mostLoaded = sortedMembers[0];
  const leastLoaded = sortedMembers[sortedMembers.length - 1];

  const totalTarget = team.total_target_hours ?? (members.length * 40);
  const teamFree = team.team_free_capacity ?? Math.max(0, totalTarget - logged);
  const targetPct = team.target_utilization_pct ?? (totalTarget > 0 ? Math.round((logged / totalTarget) * 100) : 0);

  const popoverContent = (
    <div className="space-y-1.5">
      <p className="font-semibold text-sm">{team.team_name}</p>
      <div className="border-t border-border my-1" />
      <p>
        <span className="text-muted-foreground">Members: </span>
        {members.map((m) => m.user_name).join(", ") || "None"}
      </p>
      <div className="border-t border-border my-1" />
      <p>
        <span className="text-muted-foreground">Team target: </span>
        {fmtHours(totalTarget)}h ({members.length} x {members.length > 0 ? fmtHours(totalTarget / members.length) : "40.0"}h)
      </p>
      <p>
        <span className="text-muted-foreground">Team logged: </span>
        {fmtHours(logged)}h
      </p>
      <p>
        <span className="text-muted-foreground">Team free: </span>
        {fmtHours(teamFree)}h
      </p>
      <p>
        <span className="text-muted-foreground">Committed (estimated): </span>
        {fmtHours(estimated)}h
      </p>
      <div className="border-t border-border my-1" />
      <p>
        <span className="text-muted-foreground">Utilization (vs estimate): </span>
        {fmtPct(pct)}%
      </p>
      <p>
        <span className="text-muted-foreground">Utilization (vs target): </span>
        {fmtPct(targetPct)}%
      </p>
      <div className="border-t border-border my-1" />
      {mostLoaded && (
        <p>
          <span className="text-muted-foreground">Most loaded: </span>
          {mostLoaded.user_name} ({fmtPct(mostLoaded.utilization_pct)}%)
        </p>
      )}
      {leastLoaded && leastLoaded !== mostLoaded && (
        <p>
          <span className="text-muted-foreground">Least loaded: </span>
          {leastLoaded.user_name} ({fmtPct(leastLoaded.utilization_pct)}%)
        </p>
      )}
    </div>
  );

  return (
    <div>
      <HoverDetail content={popoverContent}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center gap-3 hover:bg-muted/40 rounded-md px-2 py-2 transition-colors"
        >
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
              !expanded && "-rotate-90"
            )}
          />
          <div className="w-36 text-left shrink-0">
            <p className="text-sm font-medium truncate">{team.team_name}</p>
            <Badge variant="secondary" className="text-[10px] mt-0.5">
              {team.member_count} member{team.member_count !== 1 ? "s" : ""}
            </Badge>
          </div>
          <div className="flex-1 bg-muted rounded-full h-3 min-w-0">
            <div
              className={cn("h-3 rounded-full transition-all", barBg(pct))}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
          <span className="text-[10px] text-muted-foreground w-28 text-right shrink-0 hidden sm:inline">
            {fmtHours(logged)}h / {fmtHours(estimated)}h
          </span>
          <span className={cn("text-xs font-bold w-12 text-right shrink-0", textColor(pct))}>
            {fmtPct(pct)}%
          </span>
        </button>
      </HoverDetail>

      {expanded && members.length > 0 && (
        <div className="ml-9 mt-1 mb-2 space-y-1 border-l-2 border-muted pl-3">
          {sortedMembers.map((m) => {
            const mPct = m.utilization_pct ?? 0;
            return (
              <div key={m.user_name} className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold shrink-0">
                  {m.user_name?.charAt(0)?.toUpperCase()}
                </div>
                <p className="w-28 text-xs text-muted-foreground truncate">{m.user_name}</p>
                <div className="flex-1 bg-muted rounded-full h-2 min-w-0">
                  <div
                    className={cn("h-2 rounded-full transition-all", barBg(mPct))}
                    style={{ width: `${Math.min(mPct, 100)}%` }}
                  />
                </div>
                <span className={cn("text-[10px] font-bold w-10 text-right shrink-0", textColor(mPct))}>
                  {fmtPct(mPct)}%
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TeamOverview({ teams }) {
  if (!teams.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">Team Overview</CardTitle>
          <ColorLegend />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {teams.map((t) => (
          <TeamRow key={t.team_id} team={t} />
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 3 - Individual Staff                                       */
/* ------------------------------------------------------------------ */

function StaffBar({ user }) {
  const pct = user.utilization_pct ?? 0;
  const logged = user.hours_logged ?? 0;
  const estimated = user.hours_estimated ?? 0;
  const weeklyTarget = user.weekly_target_hours ?? 40;
  const freeCapacity = user.available_capacity ?? Math.max(0, weeklyTarget - logged);
  const targetPct = user.target_utilization_pct ?? (weeklyTarget > 0 ? Math.round((logged / weeklyTarget) * 100) : 0);
  const diff = logged - estimated;
  const RIcon = roleIcon(user.role);

  const popoverContent = (
    <div className="space-y-1.5">
      <p className="font-semibold text-sm">{user.user_name}</p>
      <p className="text-muted-foreground capitalize">{user.role?.replace(/_/g, " ")}</p>
      <div className="border-t border-border my-1" />
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground">Target:</span>
        <span>{fmtHours(weeklyTarget)}h / week</span>
        <span className="text-muted-foreground">Logged this week:</span>
        <span className="font-medium">{fmtHours(logged)}h</span>
        <span className="text-muted-foreground">Free capacity:</span>
        <span>{fmtHours(freeCapacity)}h</span>
        <span className="text-muted-foreground">Due this week:</span>
        <span>{fmtHours(estimated)}h estimated</span>
        {user.hours_estimated_total != null && user.hours_estimated_total !== estimated && (
          <>
            <span className="text-muted-foreground">Total backlog:</span>
            <span className="text-xs">{fmtHours(user.hours_estimated_total)}h across all tasks</span>
          </>
        )}
        <span className="text-muted-foreground">Difference:</span>
        <span>
          {diff >= 0 ? "+" : ""}
          {fmtHours(diff)}h{" "}
          {diff > 0 ? "(ahead)" : diff < 0 ? "(catching up)" : "(on track)"}
        </span>
        <span className="text-muted-foreground">Utilization (vs estimate):</span>
        <span>{fmtPct(pct)}%</span>
        <span className="text-muted-foreground">Utilization (vs target):</span>
        <span>{fmtPct(targetPct)}%</span>
        <span className="text-muted-foreground">Status:</span>
        <span>
          {statusEmoji(pct)} {statusLabel(pct)}
        </span>
        {user.team_name && (
          <>
            <span className="text-muted-foreground">Team:</span>
            <span>{user.team_name}</span>
          </>
        )}
      </div>
    </div>
  );

  return (
    <HoverDetail content={popoverContent}>
      <div className="flex items-center gap-3 px-1 py-1.5 rounded-md hover:bg-muted/30 transition-colors">
        {/* Avatar initial */}
        <div
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0 border-2",
            pct > 90
              ? "bg-red-100 text-red-700 border-red-300 dark:bg-red-900/30 dark:border-red-700"
              : pct > 70
              ? "bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/30 dark:border-amber-700"
              : "bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/30 dark:border-emerald-700"
          )}
        >
          {user.user_name?.charAt(0)?.toUpperCase()}
        </div>

        {/* Name + role */}
        <div className="w-36 shrink-0">
          <p className="text-sm font-medium truncate">{user.user_name}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <RIcon className="h-3 w-3 text-muted-foreground" />
            <Badge variant="outline" className="text-[10px] py-0 capitalize">
              {user.role?.replace(/_/g, " ")}
            </Badge>
          </div>
        </div>

        {/* Bar */}
        <div className="flex-1 bg-muted rounded-full h-3 min-w-0">
          <div
            className={cn("h-3 rounded-full transition-all", barBg(pct))}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>

        {/* Hours */}
        <span className="text-[10px] text-muted-foreground w-24 text-right shrink-0 hidden sm:inline">
          {fmtHours(logged)}h / {fmtHours(estimated)}h
        </span>

        {/* Percentage */}
        <span className={cn("text-xs font-bold w-12 text-right shrink-0", textColor(pct))}>
          {fmtPct(pct)}%
        </span>
      </div>
    </HoverDetail>
  );
}

function IndividualStaff({ users }) {
  const sorted = [...users].sort(
    (a, b) => (b.utilization_pct ?? 0) - (a.utilization_pct ?? 0)
  );
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold">
            Individual Staff
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              ({users.length})
            </span>
          </CardTitle>
          <ColorLegend />
        </div>
      </CardHeader>
      <CardContent className="space-y-1">
        {sorted.map((u) => (
          <StaffBar key={u.user_id ?? u.user_name} user={u} />
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 4 - Overloaded Alert                                       */
/* ------------------------------------------------------------------ */

function OverloadedAlert({ users }) {
  const overloaded = (users ?? []).filter((u) => (u.utilization_pct ?? 0) > 90);
  if (!overloaded.length) return null;

  return (
    <Card className="border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4" />
          Overloaded Staff ({overloaded.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {overloaded
          .sort((a, b) => (b.utilization_pct ?? 0) - (a.utilization_pct ?? 0))
          .map((u) => {
            const pct = u.utilization_pct ?? 0;
            const over = (u.hours_logged ?? 0) - (u.hours_estimated ?? 0);
            const severity = pct > 120 ? "Critical" : pct > 100 ? "High" : "Warning";
            const sevColor =
              pct > 120
                ? "bg-red-600 text-white"
                : pct > 100
                ? "bg-red-500 text-white"
                : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400";
            return (
              <div
                key={u.user_id ?? u.user_name}
                className="flex items-center gap-3 p-2 rounded-md bg-red-100/50 dark:bg-red-950/30"
              >
                <div className="w-7 h-7 rounded-full bg-red-200 text-red-800 dark:bg-red-900 dark:text-red-300 flex items-center justify-center text-[10px] font-bold shrink-0">
                  {u.user_name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{u.user_name}</p>
                  <p className="text-[10px] text-muted-foreground capitalize">
                    {u.role?.replace(/_/g, " ")}
                  </p>
                </div>
                <Badge className={cn("text-[10px] shrink-0", sevColor)}>{severity}</Badge>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-red-700 dark:text-red-400">{fmtPct(pct)}%</p>
                  {over > 0 && (
                    <p className="text-[10px] text-red-600 dark:text-red-500">
                      +{fmtHours(over)}h over
                    </p>
                  )}
                </div>
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 5 - Underloaded Opportunities                              */
/* ------------------------------------------------------------------ */

function UnderloadedOpportunities({ users }) {
  const under = (users ?? []).filter((u) => (u.utilization_pct ?? 0) < 40);
  if (!under.length) return null;

  return (
    <Card className="border-blue-200 bg-blue-50/50 dark:border-blue-900 dark:bg-blue-950/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold text-blue-700 dark:text-blue-400 flex items-center gap-2">
          <Zap className="h-4 w-4" />
          Underloaded Opportunities ({under.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {under
          .sort((a, b) => (a.utilization_pct ?? 0) - (b.utilization_pct ?? 0))
          .map((u) => {
            const pct = u.utilization_pct ?? 0;
            const available = (u.hours_estimated ?? 0) - (u.hours_logged ?? 0);
            return (
              <div
                key={u.user_id ?? u.user_name}
                className="flex items-center gap-3 p-2 rounded-md bg-blue-100/50 dark:bg-blue-950/30"
              >
                <div className="w-7 h-7 rounded-full bg-blue-200 text-blue-800 dark:bg-blue-900 dark:text-blue-300 flex items-center justify-center text-[10px] font-bold shrink-0">
                  {u.user_name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{u.user_name}</p>
                  <p className="text-[10px] text-muted-foreground capitalize">
                    {u.role?.replace(/_/g, " ")}
                  </p>
                </div>
                <Badge
                  className="text-[10px] shrink-0 bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400"
                >
                  {fmtPct(pct)}%
                </Badge>
                {available > 0 && (
                  <div className="text-right shrink-0">
                    <p className="text-sm font-bold text-blue-700 dark:text-blue-400">
                      {fmtHours(available)}h
                    </p>
                    <p className="text-[10px] text-blue-600 dark:text-blue-500">remaining</p>
                  </div>
                )}
              </div>
            );
          })}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Section 6 - Role Capacity Grid                                     */
/* ------------------------------------------------------------------ */

function RoleCard({ role }) {
  const RIcon = roleIcon(role.role);
  const completed = role.completed ?? 0;
  const total = role.total ?? 0;
  const completionPct = total > 0 ? Math.round((completed / total) * 100) : 0;
  const avgUtil = role.avg_utilization ?? 0;
  const memberCount = role.member_count ?? 0;
  const tasksPerPerson = memberCount > 0 ? (total / memberCount).toFixed(1) : "0.0";

  const popoverContent = (
    <div className="space-y-1.5">
      <p className="font-semibold text-sm capitalize">{role.role?.replace(/_/g, " ")}</p>
      <div className="border-t border-border my-1" />
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="text-muted-foreground">Tasks:</span>
        <span>
          {completed} done / {total} total
        </span>
        <span className="text-muted-foreground">Completion:</span>
        <span>{completionPct}%</span>
        <span className="text-muted-foreground">Staff:</span>
        <span>{memberCount} people</span>
        <span className="text-muted-foreground">Avg utilization:</span>
        <span>{fmtPct(avgUtil)}%</span>
        <span className="text-muted-foreground">Tasks/person:</span>
        <span>{tasksPerPerson}</span>
      </div>
    </div>
  );

  return (
    <HoverDetail content={popoverContent}>
      <div className="p-3 rounded-lg bg-muted/50 border border-border/40 hover:border-border transition-colors cursor-default h-full">
        {/* Header */}
        <div className="flex items-center gap-2 mb-2">
          <div className={cn("p-1.5 rounded-md", badgeBg(avgUtil))}>
            <RIcon className="h-3.5 w-3.5" />
          </div>
          <p className="text-xs font-semibold capitalize truncate">
            {role.role?.replace(/_/g, " ")}
          </p>
        </div>

        {/* Task progress */}
        <p className="text-[10px] text-muted-foreground mb-1">
          {completed}/{total} complete ({completionPct}%)
        </p>
        <div className="bg-muted rounded-full h-1.5 mb-2">
          <div
            className="h-1.5 rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(completionPct, 100)}%` }}
          />
        </div>

        {/* Stats */}
        <div className="flex items-center justify-between">
          <Badge variant="secondary" className={cn("text-[10px]", badgeBg(avgUtil))}>
            {fmtPct(avgUtil)}% avg
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {memberCount} staff
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {tasksPerPerson} tasks/person
        </p>
      </div>
    </HoverDetail>
  );
}

function RoleCapacityGrid({ roles }) {
  if (!roles.length) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Role Capacity</CardTitle>
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
/*  Loading + Empty states                                             */
/* ------------------------------------------------------------------ */

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-48 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="p-8 text-center">
      <Users className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">No capacity data yet</p>
      <p className="text-xs text-muted-foreground mt-1">
        Staff utilization will appear once team members have assigned tasks.
      </p>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export default function TeamCapacityDash() {
  const { data: stats, isLoading } = useDashboardStats();
  const overloadedRef = useRef(null);
  const underloadedRef = useRef(null);

  if (isLoading) return <LoadingSkeleton />;

  const utilization = stats?.utilization;
  const byUser = utilization?.by_user ?? [];
  const byTeam = utilization?.by_team ?? [];
  const byRole = stats?.tasks?.by_role ?? [];

  if (byUser.length === 0) return <EmptyState />;

  const overallPct = utilization?.overall_utilization_pct ?? 0;
  const totalLogged = byUser.reduce((s, u) => s + (u.hours_logged ?? 0), 0);
  const totalEstimated = byUser.reduce((s, u) => s + (u.hours_estimated ?? 0), 0);
  const totalCapacity = byUser.reduce((s, u) => s + (u.available_capacity ?? Math.max(0, (u.weekly_target_hours ?? 40) - (u.hours_logged ?? 0))), 0);
  const overloadedCount = byUser.filter((u) => (u.utilization_pct ?? 0) > 90).length;
  const underloadedCount = byUser.filter((u) => (u.utilization_pct ?? 0) < 40).length;

  return (
    <div className="space-y-6">
      {/* 1. Summary Strip */}
      <SummaryStrip
        overallPct={overallPct}
        totalLogged={totalLogged}
        totalEstimated={totalEstimated}
        totalCapacity={totalCapacity}
        overloadedCount={overloadedCount}
        underloadedCount={underloadedCount}
        onScrollOverloaded={() => overloadedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
        onScrollUnderloaded={() => underloadedRef.current?.scrollIntoView({ behavior: "smooth", block: "center" })}
      />

      {/* 2. Team Overview */}
      <TeamOverview teams={byTeam} />

      {/* 3. Individual Staff */}
      <IndividualStaff users={byUser} />

      {/* 4. Overloaded Alert */}
      <div ref={overloadedRef}>
        <OverloadedAlert users={byUser} />
      </div>

      {/* 5. Underloaded Opportunities */}
      <div ref={underloadedRef}>
        <UnderloadedOpportunities users={byUser} />
      </div>

      {/* 6. Role Capacity Grid */}
      <RoleCapacityGrid roles={byRole} />
    </div>
  );
}

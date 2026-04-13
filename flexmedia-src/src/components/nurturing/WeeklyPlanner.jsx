import { useState, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { fixTimestamp, todaySydney, fmtDate } from "@/components/utils/dateUtils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import {
  Calendar, ChevronLeft, ChevronRight, Plus, Zap, Users, Clock,
  Phone, Mail, Footprints, Gift, Briefcase, Home, MessageCircle, Presentation,
  Instagram, Linkedin, Sparkles, CheckCircle2, AlertTriangle,
} from "lucide-react";

// ─── Type-to-icon mapping ────────────────────────────────────────────────────

const TYPE_ICON_MAP = {
  "Phone Call Out": Phone,
  "Phone Call In": Phone,
  Email: Mail,
  "Drop-In Visit": Footprints,
  "Walk-In": Home,
  "Sales Meeting": Briefcase,
  "Pitch Meeting": Presentation,
  "Gift / Swag": Gift,
  LinkedIn: Linkedin,
  Instagram: Instagram,
  SMS: MessageCircle,
  "Discovery Call": Phone,
};

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// ─── Date helpers ────────────────────────────────────────────────────────────

function getWeekDates(weekOffset = 0) {
  const today = new Date();
  const dayOfWeek = today.getDay(); // 0=Sun, 1=Mon ...
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday + weekOffset * 7);
  // Zero out time
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 5 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function formatDayHeader(dateStr) {
  const d = new Date(dateStr + "T12:00:00"); // noon to avoid timezone issues
  const dayIdx = d.getDay(); // 0=Sun .. 6=Sat
  const dayName = dayIdx === 0 ? "Sun" : dayIdx === 6 ? "Sat" : DAY_NAMES[dayIdx - 1];
  const day = d.getDate();
  const month = d.toLocaleString("en-AU", { month: "short" });
  return `${dayName} ${day} ${month}`;
}

function isToday(dateStr) {
  return dateStr === todaySydney();
}

function isPast(dateStr) {
  return dateStr < todaySydney();
}

// ─── Priority scoring for smart fill ─────────────────────────────────────────

function getPriorityScore(agent) {
  let score = 0;
  const health = agent.cadence_health;
  if (health === "critical") score += 100;
  else if (health === "overdue") score += 70;
  else if (health === "due_soon") score += 40;

  // Higher value agents get bumped up
  const val = agent.value_potential;
  if (val === "Enterprise" || val >= 4) score += 30;
  else if (val === "High" || val >= 3) score += 20;
  else if (val === "Medium" || val >= 2) score += 10;

  // Warmth score factor: colder agents need more attention
  const warmth = agent.warmth_score ?? 50;
  if (warmth < 30) score += 15;
  else if (warmth < 50) score += 5;

  return score;
}

// ─── Average duration by type ────────────────────────────────────────────────

const AVG_DURATION = {
  "Phone Call Out": 10,
  "Phone Call In": 10,
  Email: 5,
  "Drop-In Visit": 20,
  "Walk-In": 20,
  "Sales Meeting": 45,
  "Pitch Meeting": 60,
  "Gift / Swag": 10,
  LinkedIn: 5,
  Instagram: 5,
  SMS: 3,
  "Discovery Call": 30,
};

const DEFAULT_DURATION = 15;

// ─── Component ───────────────────────────────────────────────────────────────

/**
 * WeeklyPlanner - 5-day outreach planning board.
 *
 * Shows a Mon-Fri grid with planned touchpoints per day, plus smart-fill
 * to auto-distribute overdue agents across the week.
 *
 * Props:
 *   onLogTouchpoint  - callback(agentId?) to open QuickLogTouchpoint
 */
export default function WeeklyPlanner({ onLogTouchpoint }) {
  const { data: agents = [], loading: loadingAgents } = useEntityList("Agent", "name");
  const { data: agencies = [] } = useEntityList("Agency", "name");
  const { data: allTouchpoints = [], loading: loadingTp } = useEntityList("Touchpoint", "-logged_at");
  const { data: touchpointTypes = [] } = useEntityList("TouchpointType", "sort_order");
  const { data: user } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  const [weekOffset, setWeekOffset] = useState(0);
  const [filling, setFilling] = useState(false);

  const loading = loadingAgents || loadingTp;
  const weekDates = useMemo(() => getWeekDates(weekOffset), [weekOffset]);
  const weekStart = weekDates[0];
  const weekEnd = weekDates[4];

  // ── Build lookup maps ────────────────────────────────────────────────────

  const agentMap = useMemo(() => {
    const m = {};
    agents.forEach((a) => { m[a.id] = a; });
    return m;
  }, [agents]);

  const agencyMap = useMemo(() => {
    const m = {};
    agencies.forEach((a) => { m[a.id] = a; });
    return m;
  }, [agencies]);

  const typeMap = useMemo(() => {
    const m = {};
    touchpointTypes.forEach((t) => { m[t.id] = t; });
    return m;
  }, [touchpointTypes]);

  // ── Get planned touchpoints for this week ──────────────────────────────

  const weekTouchpoints = useMemo(() => {
    return allTouchpoints.filter((tp) => {
      if (!tp.is_planned || tp.completed_at) return false;
      if (!tp.follow_up_date) return false;
      const d = tp.follow_up_date.substring(0, 10);
      return d >= weekStart && d <= weekEnd;
    });
  }, [allTouchpoints, weekStart, weekEnd]);

  // Group touchpoints by day
  const touchpointsByDay = useMemo(() => {
    const byDay = {};
    for (const d of weekDates) {
      byDay[d] = [];
    }
    for (const tp of weekTouchpoints) {
      const d = tp.follow_up_date.substring(0, 10);
      if (byDay[d]) {
        byDay[d].push(tp);
      }
    }
    // Sort each day by priority
    for (const d of weekDates) {
      byDay[d].sort((a, b) => {
        const agA = agentMap[a.agent_id];
        const agB = agentMap[b.agent_id];
        return (getPriorityScore(agB || {}) - getPriorityScore(agA || {}));
      });
    }
    return byDay;
  }, [weekTouchpoints, weekDates, agentMap]);

  // ── Summary stats ──────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const totalPlanned = weekTouchpoints.length;
    const agentIds = new Set(weekTouchpoints.map((t) => t.agent_id).filter(Boolean));
    const totalAgents = agentIds.size;

    // Calculate overdue agents not yet in the plan
    const overdueAgents = agents.filter(
      (a) => (a.cadence_health === "critical" || a.cadence_health === "overdue") && !agentIds.has(a.id)
    );

    // Estimate total time
    let totalMinutes = 0;
    for (const tp of weekTouchpoints) {
      const typeName = tp.touchpoint_type_name || typeMap[tp.touchpoint_type_id]?.name || "";
      totalMinutes += AVG_DURATION[typeName] || DEFAULT_DURATION;
    }
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;

    return {
      totalPlanned,
      totalAgents,
      overdueNotCovered: overdueAgents.length,
      timeEstimate: hours > 0 ? `${hours}h ${mins}m` : `${mins}m`,
    };
  }, [weekTouchpoints, agents, typeMap]);

  // ── Smart Fill handler ─────────────────────────────────────────────────

  const handleAutoFill = async () => {
    if (filling) return;
    setFilling(true);

    try {
      // Get agents that need attention and are not already planned this week
      const plannedAgentIds = new Set(weekTouchpoints.map((t) => t.agent_id).filter(Boolean));
      const needsAttention = agents
        .filter(
          (a) =>
            (a.cadence_health === "critical" ||
              a.cadence_health === "overdue" ||
              a.cadence_health === "due_soon") &&
            !plannedAgentIds.has(a.id)
        )
        .sort((a, b) => getPriorityScore(b) - getPriorityScore(a));

      if (needsAttention.length === 0) {
        toast.info("All agents are covered this week");
        setFilling(false);
        return;
      }

      // Group by agency (proxy for geography — same office = same day)
      const byAgency = {};
      for (const agent of needsAttention) {
        const key = agent.current_agency_id || "__no_agency__";
        if (!byAgency[key]) byAgency[key] = [];
        byAgency[key].push(agent);
      }

      // Flatten groups, keeping agency clusters together
      const clustered = [];
      const sortedGroups = Object.values(byAgency).sort(
        (a, b) => getPriorityScore(b[0]) - getPriorityScore(a[0])
      );
      for (const group of sortedGroups) {
        clustered.push(...group);
      }

      // Distribute across 5 days, max 5 per day
      const MAX_PER_DAY = 5;
      const dayQueues = weekDates.map((d) => ({
        date: d,
        existing: touchpointsByDay[d]?.length || 0,
        items: [],
      }));

      for (const agent of clustered) {
        // Find the day with fewest items that is not yet full
        const available = dayQueues
          .filter((dq) => dq.existing + dq.items.length < MAX_PER_DAY)
          .sort((a, b) => (a.existing + a.items.length) - (b.existing + b.items.length));

        if (available.length === 0) break; // all days full
        available[0].items.push(agent);
      }

      // Create planned touchpoints
      let created = 0;
      const suggestType = (agent) => {
        // Suggest a channel type — cycle through common ones
        const recent = allTouchpoints
          .filter((t) => t.agent_id === agent.id)
          .slice(0, 3)
          .map((t) => t.touchpoint_type_name);
        const rotation = ["Phone Call Out", "Email", "Drop-In Visit", "Phone Call Out", "LinkedIn"];
        const recentSet = new Set(recent);
        return rotation.find((r) => !recentSet.has(r)) || "Phone Call Out";
      };

      for (const dq of dayQueues) {
        for (const agent of dq.items) {
          const typeName = suggestType(agent);
          const typeMatch = touchpointTypes.find(
            (t) => t.name === typeName || t.name.toLowerCase() === typeName.toLowerCase()
          );
          await api.entities.Touchpoint.create({
            agent_id: agent.id,
            agency_id: agent.current_agency_id || null,
            touchpoint_type_name: typeName,
            touchpoint_type_id: typeMatch?.id || null,
            is_planned: true,
            follow_up_date: dq.date,
            follow_up_notes: `Auto-planned: ${agent.cadence_health || "needs contact"}`,
            notes: "Weekly planner auto-fill",
            logged_by: user?.id,
            logged_by_name: user?.full_name || user?.email,
            logged_at: new Date().toISOString(),
          });
          created++;
        }
      }

      await refetchEntityList("Touchpoint");
      toast.success(`Auto-filled ${created} touchpoints across the week`);
    } catch (err) {
      toast.error(err?.message || "Failed to auto-fill week");
    } finally {
      setFilling(false);
    }
  };

  // ── Add planned touchpoint for a specific day ──────────────────────────

  const handleAddToDay = (dateStr) => {
    if (onLogTouchpoint) {
      // Call the parent handler; the parent is responsible for creating a planned touchpoint
      onLogTouchpoint(null, dateStr);
    }
  };

  // ── Complete a planned touchpoint ──────────────────────────────────────

  const handleComplete = async (tp) => {
    try {
      const now = new Date().toISOString();
      await api.entities.Touchpoint.update(tp.id, {
        is_planned: false,
        completed_at: now,
        logged_at: now,
        outcome: "positive",
      });

      // Update agent denormalized fields
      const agent = agentMap[tp.agent_id];
      if (agent) {
        await api.entities.Agent.update(tp.agent_id, {
          last_touchpoint_at: now,
          last_contacted_at: now,
          touchpoint_count: (agent.touchpoint_count || 0) + 1,
        });
      }

      await refetchEntityList("Touchpoint");
      toast.success("Touchpoint completed");
    } catch (err) {
      toast.error(err?.message || "Failed to complete touchpoint");
    }
  };

  // ── Loading state ──────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="h-5 w-40 bg-muted rounded animate-pulse" />
          <div className="h-8 w-28 bg-muted rounded animate-pulse" />
        </div>
        <div className="grid grid-cols-5 gap-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-48 bg-muted rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  // ── Week label ─────────────────────────────────────────────────────────

  const weekLabel =
    weekOffset === 0
      ? "This Week"
      : weekOffset === 1
        ? "Next Week"
        : weekOffset === -1
          ? "Last Week"
          : `Week of ${fmtDate(weekStart, "d MMM")}`;

  return (
    <div className="rounded-xl border bg-card p-4 space-y-4">
      {/* ── Header ── */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2.5">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">{weekLabel}'s Plan</h3>
            <p className="text-[10px] text-muted-foreground">
              {fmtDate(weekStart, "d MMM")} - {fmtDate(weekEnd, "d MMM yyyy")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => setWeekOffset((w) => w - 1)}
            title="Previous week"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          {weekOffset !== 0 && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-xs px-2"
              onClick={() => setWeekOffset(0)}
            >
              Today
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 w-7 p-0"
            onClick={() => setWeekOffset((w) => w + 1)}
            title="Next week"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>

          <div className="w-px h-5 bg-border mx-1" />

          <Button
            size="sm"
            variant="default"
            className="h-7 text-xs px-2.5 gap-1"
            onClick={handleAutoFill}
            disabled={filling}
            title="Distribute overdue agents across the week"
          >
            {filling ? (
              <>
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                Filling...
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3" />
                Auto-Fill Week
              </>
            )}
          </Button>
        </div>
      </div>

      {/* ── Day columns ── */}
      <div className="grid grid-cols-5 gap-2">
        {weekDates.map((dateStr) => {
          const dayTps = touchpointsByDay[dateStr] || [];
          const today = isToday(dateStr);
          const past = isPast(dateStr);

          return (
            <div
              key={dateStr}
              className={cn(
                "rounded-lg border p-2 min-h-[180px] flex flex-col",
                today && "border-blue-300 bg-blue-50/30 ring-1 ring-blue-200",
                past && !today && "opacity-70"
              )}
            >
              {/* Day header */}
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    "text-xs font-semibold",
                    today && "text-blue-700"
                  )}>
                    {formatDayHeader(dateStr)}
                  </span>
                  {today && (
                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" />
                  )}
                </div>
                {dayTps.length > 0 && (
                  <Badge
                    variant="secondary"
                    className="text-[9px] px-1 py-0 h-4"
                  >
                    {dayTps.length}
                  </Badge>
                )}
              </div>

              {/* Touchpoint items */}
              <div className="flex-1 space-y-1.5">
                {dayTps.length === 0 && (
                  <div className="flex-1 flex items-center justify-center py-6">
                    <p className="text-[10px] text-muted-foreground/70 text-center">
                      Nothing planned -- tap Add below
                    </p>
                  </div>
                )}

                {dayTps.map((tp) => {
                  const agent = agentMap[tp.agent_id];
                  const agency = agent?.current_agency_id
                    ? agencyMap[agent.current_agency_id]
                    : null;
                  const typeName = tp.touchpoint_type_name || typeMap[tp.touchpoint_type_id]?.name || "Touchpoint";
                  const Icon = TYPE_ICON_MAP[typeName] || Phone;

                  return (
                    <div
                      key={tp.id}
                      className={cn(
                        "rounded-md border p-1.5 group transition-all",
                        "hover:shadow-sm hover:border-blue-200 cursor-default"
                      )}
                    >
                      <div className="flex items-start gap-1.5">
                        <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                          <Icon className="h-2.5 w-2.5 text-muted-foreground" />
                        </div>
                        <div className="flex-1 min-w-0">
                          {agent ? (
                            <Link
                              to={createPageUrl(`AgentDetails?id=${agent.id}`)}
                              className="text-[10px] font-medium truncate block hover:underline leading-tight"
                            >
                              {agent.name || "Unknown"}
                            </Link>
                          ) : (
                            <span className="text-[10px] font-medium truncate block leading-tight">
                              Unknown Agent
                            </span>
                          )}
                          {agency && (
                            <p className="text-[9px] text-muted-foreground truncate leading-tight">
                              {agency.name}
                            </p>
                          )}
                          <p className="text-[9px] text-muted-foreground truncate mt-0.5">
                            {tp.follow_up_notes || typeName}
                          </p>
                        </div>
                      </div>

                      {/* Hover action row */}
                      <div className="flex items-center gap-1 mt-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button
                          size="sm"
                          className="h-5 text-[9px] px-1.5 gap-0.5 flex-1"
                          onClick={() => handleComplete(tp)}
                          title="Mark this touchpoint as completed"
                        >
                          <CheckCircle2 className="h-2.5 w-2.5" />
                          Done
                        </Button>
                        {onLogTouchpoint && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-5 text-[9px] px-1.5 gap-0.5 flex-1"
                            onClick={() => onLogTouchpoint(tp.agent_id)}
                            title="Log a full touchpoint with details"
                          >
                            <Zap className="h-2.5 w-2.5" />
                            Log
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Add button */}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-[10px] px-2 gap-1 w-full mt-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => handleAddToDay(dateStr)}
                title="Plan a touchpoint for this day"
              >
                <Plus className="h-3 w-3" />
                Add
              </Button>
            </div>
          );
        })}
      </div>

      {/* ── Summary bar ── */}
      <div className="flex items-center justify-between flex-wrap gap-2 rounded-lg bg-muted/50 px-3 py-2">
        <div className="flex items-center gap-4">
          <SummaryPill icon={Calendar} label="Planned" value={`${stats.totalPlanned} touches`} />
          <SummaryPill icon={Users} label="Agents" value={stats.totalAgents} />
          <SummaryPill icon={Clock} label="Est. time" value={stats.timeEstimate} />
        </div>

        {stats.overdueNotCovered > 0 && (
          <div className="flex items-center gap-1.5 text-amber-700 bg-amber-50 rounded-md px-2.5 py-1">
            <AlertTriangle className="h-3 w-3" />
            <span className="text-[10px] font-medium">
              {stats.overdueNotCovered} overdue agent{stats.overdueNotCovered === 1 ? "" : "s"} not covered
            </span>
          </div>
        )}

        {stats.overdueNotCovered === 0 && stats.totalPlanned > 0 && (
          <div className="flex items-center gap-1.5 text-green-700 bg-green-50 rounded-md px-2.5 py-1">
            <CheckCircle2 className="h-3 w-3" />
            <span className="text-[10px] font-medium">
              All overdue agents covered
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-component ────────────────────────────────────────────────────────────

function SummaryPill({ icon: Icon, label, value }) {
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-3 w-3 text-muted-foreground" />
      <span className="text-[10px] text-muted-foreground">{label}:</span>
      <span className="text-xs font-semibold">{value}</span>
    </div>
  );
}

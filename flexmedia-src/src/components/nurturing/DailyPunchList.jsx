import { useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import WarmthScoreBadge from "./WarmthScoreBadge";
import { fixTimestamp, todaySydney, fmtDate } from "@/components/utils/dateUtils";
import {
  Phone,
  Mail,
  MapPin,
  MessageCircle,
  Briefcase,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Video,
  Gift,
  FileText,
  Zap,
  Inbox,
} from "lucide-react";

const CHANNEL_ICONS = {
  PhoneOutgoing: Phone,
  PhoneIncoming: Phone,
  Phone: Phone,
  Mail: Mail,
  MessageCircle: MessageCircle,
  MessageSquare: MessageCircle,
  Video: Video,
  Footprints: MapPin,
  Home: MapPin,
  Gift: Gift,
  Briefcase: Briefcase,
  FileText: FileText,
  Presentation: Briefcase,
  MapPin: MapPin,
};

const PRIORITY_CONFIG = {
  critical: {
    dot: "bg-red-500",
    label: "Critical",
    ring: "ring-red-100",
  },
  overdue: {
    dot: "bg-orange-500",
    label: "Overdue",
    ring: "ring-orange-100",
  },
  due_soon: {
    dot: "bg-yellow-500",
    label: "Due Soon",
    ring: "ring-yellow-100",
  },
  planned: {
    dot: "bg-blue-500",
    label: "Follow-up",
    ring: "ring-blue-100",
  },
  signal: {
    dot: "bg-purple-500",
    label: "Signal",
    ring: "ring-purple-100",
  },
};

function daysBetween(dateA, dateB) {
  if (!dateA || !dateB) return 0;
  const a = new Date(fixTimestamp(dateA));
  const b = new Date(fixTimestamp(dateB));
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function daysSinceNow(dateStr) {
  if (!dateStr) return Infinity;
  const d = new Date(fixTimestamp(dateStr));
  return Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
}

function formatDaysAgo(dateStr) {
  if (!dateStr) return "--";
  const days = daysSinceNow(dateStr);
  if (days <= 0) return "today";
  if (days === 1) return "1d ago";
  return `${days}d ago`;
}

/**
 * Suggest a channel that differs from recent touchpoint types.
 * Cycles through common channels to avoid repetition.
 */
function suggestNextChannel(recentTypeIds) {
  const rotation = ["Mail", "PhoneOutgoing", "MessageCircle", "Video", "Footprints"];
  const recentSet = new Set(recentTypeIds.filter(Boolean));
  const unused = rotation.find(c => !recentSet.has(c));
  return unused || rotation[0];
}

/**
 * DailyPunchList - prioritized "who to contact today" list.
 *
 * Props:
 *   onLogTouchpoint — callback(agentId: string) to open log dialog for a specific agent
 */
export default function DailyPunchList({ onLogTouchpoint }) {
  const { data: agents = [], loading: loadingAgents } = useEntityList("Agent", "name");
  const { data: agencies = [], loading: loadingAgencies } = useEntityList("Agency", "name");
  const { data: touchpoints = [], loading: loadingTp } = useEntityList("Touchpoint", "-logged_at");
  const { data: pulseSignals = [], loading: loadingSig } = useEntityList("PulseSignal", "-created_at");
  const { data: cadenceRules = [] } = useEntityList("CadenceRule", "priority_level");

  const loading = loadingAgents || loadingTp;
  const today = todaySydney();

  // Build agency lookup
  const agencyMap = useMemo(() => {
    const m = {};
    agencies.forEach(a => { m[a.id] = a; });
    return m;
  }, [agencies]);

  // Build touchpoint history per agent
  const tpByAgent = useMemo(() => {
    const m = {};
    touchpoints.forEach(tp => {
      if (!tp.agent_id) return;
      if (!m[tp.agent_id]) m[tp.agent_id] = [];
      m[tp.agent_id].push(tp);
    });
    // Sort each agent's touchpoints newest first
    Object.values(m).forEach(arr =>
      arr.sort((a, b) =>
        new Date(fixTimestamp(b.logged_at || b.created_date)) -
        new Date(fixTimestamp(a.logged_at || a.created_date))
      )
    );
    return m;
  }, [touchpoints]);

  // Build the prioritized punch list
  const punchList = useMemo(() => {
    const items = [];

    // ── 1-3: Agents by cadence health ──
    const critical = [];
    const overdue = [];
    const dueSoon = [];

    agents.forEach(agent => {
      const health = agent.cadence_health;
      const agentTps = tpByAgent[agent.id] || [];
      const lastTp = agentTps[0];
      const lastDate = lastTp?.logged_at || lastTp?.created_date || agent.last_contacted_at;
      const daysSince = daysSinceNow(lastDate);
      const recentTypeIds = agentTps.slice(0, 3).map(t => t.touchpoint_type_name || t.touchpoint_type_id);
      const suggestedChannel = suggestNextChannel(recentTypeIds);
      const agencyName = agent.current_agency_id ? agencyMap[agent.current_agency_id]?.name : null;

      const row = {
        type: "agent",
        agent,
        agentId: agent.id,
        agentName: agent.name || "Unknown",
        agencyName,
        warmthScore: agent.warmth_score ?? 0,
        warmthTrend: agent.warmth_trend,
        daysSince,
        lastDate,
        nextDue: agent.next_touchpoint_due,
        suggestedChannel,
        valuePotential: agent.value_potential ?? 0,
      };

      if (health === "critical") {
        critical.push({ ...row, priority: "critical" });
      } else if (health === "overdue") {
        overdue.push({ ...row, priority: "overdue" });
      } else if (health === "due_soon") {
        dueSoon.push({ ...row, priority: "due_soon" });
      }
    });

    // Sort critical by days overdue (most overdue first)
    critical.sort((a, b) => b.daysSince - a.daysSince);
    // Sort overdue by value_potential desc, then days overdue desc
    overdue.sort((a, b) => (b.valuePotential - a.valuePotential) || (b.daysSince - a.daysSince));
    // Sort due_soon by next_touchpoint_due ascending
    dueSoon.sort((a, b) => {
      if (!a.nextDue) return 1;
      if (!b.nextDue) return -1;
      return new Date(fixTimestamp(a.nextDue)) - new Date(fixTimestamp(b.nextDue));
    });

    items.push(...critical, ...overdue, ...dueSoon);

    // ── 4: Planned follow-ups due today ──
    const plannedToday = touchpoints.filter(tp => {
      if (!tp.is_planned || tp.completed_at) return false;
      if (!tp.follow_up_date) return false;
      const fDate = tp.follow_up_date.substring(0, 10);
      return fDate <= today;
    });

    const agentIds = new Set(items.map(i => i.agentId));
    plannedToday.forEach(tp => {
      if (tp.agent_id && agentIds.has(tp.agent_id)) return; // already listed
      const agent = agents.find(a => a.id === tp.agent_id);
      if (!agent) return;
      agentIds.add(agent.id);
      const agencyName = agent.current_agency_id ? agencyMap[agent.current_agency_id]?.name : null;
      items.push({
        type: "planned",
        priority: "planned",
        agent,
        agentId: agent.id,
        agentName: agent.name || "Unknown",
        agencyName,
        warmthScore: agent.warmth_score ?? 0,
        warmthTrend: agent.warmth_trend,
        daysSince: daysSinceNow(tp.logged_at || tp.created_date),
        lastDate: tp.logged_at || tp.created_date,
        followUpLabel: "Follow-up today",
        suggestedChannel: null,
      });
    });

    // ── 5: New actionable pulse signals ──
    const actionableSignals = pulseSignals.filter(s => s.status === "new" && s.is_actionable);
    actionableSignals.forEach(sig => {
      if (sig.agent_id && agentIds.has(sig.agent_id)) return;
      const agent = sig.agent_id ? agents.find(a => a.id === sig.agent_id) : null;
      if (sig.agent_id && !agent) return;
      items.push({
        type: "signal",
        priority: "signal",
        agent,
        agentId: sig.agent_id,
        agentName: agent?.name || sig.entity_label || "Unknown",
        agencyName: agent?.agency_id ? agencyMap[agent.current_agency_id]?.name : null,
        warmthScore: agent?.warmth_score ?? 0,
        warmthTrend: agent?.warmth_trend,
        daysSince: null,
        lastDate: null,
        signalLabel: sig.signal_type || "New signal",
        suggestedChannel: null,
      });
      if (sig.agent_id) agentIds.add(sig.agent_id);
    });

    return items;
  }, [agents, agencies, touchpoints, pulseSignals, tpByAgent, agencyMap, today]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-4 space-y-3">
        <Skeleton className="h-5 w-44" />
        {[1, 2, 3, 4].map(i => (
          <Skeleton key={i} className="h-12 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  // ── Empty state ──
  if (punchList.length === 0) {
    return (
      <div className="rounded-xl border bg-card p-6 text-center">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold">Today's Reach-Outs</h3>
        </div>
        <div className="py-8">
          <CheckCircle2 className="h-8 w-8 mx-auto text-green-500/60 mb-3" />
          <p className="text-sm text-muted-foreground">
            All caught up -- no one needs a reach-out today.
          </p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Check back tomorrow or add agents to your cadence.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-4 space-y-3">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">Today's Reach-Outs</h3>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5 whitespace-nowrap">
            {punchList.length}
          </Badge>
        </div>
      </div>

      {/* ── List ── */}
      <div className="space-y-1">
        {punchList.map((item, idx) => {
          const cfg = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG.planned;
          const ChannelIcon = item.suggestedChannel
            ? (CHANNEL_ICONS[item.suggestedChannel] || Phone)
            : null;

          return (
            <div
              key={item.agentId || `sig-${idx}`}
              className={cn(
                "flex items-center gap-2.5 px-2.5 py-2 rounded-lg",
                "hover:bg-muted/50 transition-colors group"
              )}
            >
              {/* Priority dot */}
              <div className={cn("h-2 w-2 rounded-full shrink-0", cfg.dot)} title={cfg.label} />

              {/* Agent info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {item.agentId ? (
                    <Link
                      to={createPageUrl(`AgentDetails?id=${item.agentId}`)}
                      className="text-xs font-medium truncate hover:underline cursor-pointer"
                    >
                      {item.agentName}
                    </Link>
                  ) : (
                    <span className="text-xs font-medium truncate">{item.agentName}</span>
                  )}
                </div>
                {item.agencyName && (
                  <p className="text-[10px] text-muted-foreground truncate">{item.agencyName}</p>
                )}
              </div>

              {/* Warmth score */}
              <WarmthScoreBadge
                score={item.warmthScore}
                trend={item.warmthTrend}
                size="sm"
              />

              {/* Days since / follow-up label */}
              <span className="text-[10px] text-muted-foreground whitespace-nowrap w-16 text-right shrink-0">
                {item.followUpLabel
                  ? item.followUpLabel
                  : item.signalLabel
                    ? item.signalLabel
                    : item.lastDate
                      ? formatDaysAgo(item.lastDate)
                      : "--"
                }
              </span>

              {/* Suggested channel */}
              {ChannelIcon && (
                <Badge
                  variant="outline"
                  className="text-[9px] px-1.5 py-0 h-5 gap-0.5 shrink-0 whitespace-nowrap"
                >
                  <ChannelIcon className="h-2.5 w-2.5" aria-hidden="true" />
                  <span className="hidden sm:inline">
                    {item.suggestedChannel?.replace("Outgoing", "").replace("Incoming", "")}
                  </span>
                </Badge>
              )}

              {/* Log button */}
              {item.agentId && onLogTouchpoint && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                  onClick={() => onLogTouchpoint(item.agentId)}
                  title="Log a touchpoint for this agent"
                >
                  <Zap className="h-3 w-3" />
                  Log Touch
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

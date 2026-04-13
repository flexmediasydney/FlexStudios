import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import WarmthScoreBadge from "@/components/nurturing/WarmthScoreBadge";
import DailyPunchList from "@/components/nurturing/DailyPunchList";
import QuickLogTouchpoint from "@/components/nurturing/QuickLogTouchpoint";
import WeeklyPlanner from "@/components/nurturing/WeeklyPlanner";
import {
  Crosshair, Users, AlertTriangle, TrendingUp, Shield, ShieldAlert,
  Phone, Mail, MessageCircle, Video, Footprints, MapPin, Gift, Briefcase,
  PhoneOutgoing, PhoneIncoming, Voicemail, MessageSquare, Image, Home, FileText,
  Facebook, Instagram, Linkedin, Presentation, PhoneCall,
  Plus, RefreshCw, Loader2, Search, ChevronDown, ChevronUp, ArrowUpRight,
  Zap, Clock, Calendar, BarChart3, Target, Building2, User, Rss,
  CheckCircle2, XCircle, Eye, Flag, Activity,
  Lightbulb, Brain, Shuffle, ThermometerSnowflake, Star, Route, GitBranch, Archive,
  CalendarClock, AlarmClock, SkipForward, Check, X,
} from "lucide-react";

// ─── Icon map (mirrors QuickLogTouchpoint) ──────────────────────────────────

const ICON_MAP = {
  PhoneOutgoing, PhoneIncoming, Voicemail, Mail, MessageCircle, MessageSquare,
  Image, Video, Footprints, Home, FileText, Gift, Facebook, Instagram,
  Linkedin, Briefcase, Presentation, MapPin, PhoneCall, Phone,
};

// ─── Category colours (mirrors QuickLogTouchpoint) ──────────────────────────

const CATEGORY_COLORS = {
  outbound: { bg: "bg-blue-500",    light: "bg-blue-100",  text: "text-blue-700" },
  inbound:  { bg: "bg-green-500",   light: "bg-green-100", text: "text-green-700" },
  meeting:  { bg: "bg-purple-500",  light: "bg-purple-100",text: "text-purple-700" },
  content:  { bg: "bg-amber-500",   light: "bg-amber-100", text: "text-amber-700" },
  event:    { bg: "bg-rose-500",    light: "bg-rose-100",  text: "text-rose-700" },
  trigger:  { bg: "bg-cyan-500",    light: "bg-cyan-100",  text: "text-cyan-700" },
  gift:     { bg: "bg-pink-500",    light: "bg-pink-100",  text: "text-pink-700" },
};
const DEFAULT_CAT_COLOR = { bg: "bg-muted-foreground", light: "bg-muted", text: "text-muted-foreground" };
function getCatColor(cat) { return CATEGORY_COLORS[(cat || "").toLowerCase()] || DEFAULT_CAT_COLOR; }

// ─── State style maps ───────────────────────────────────────────────────────

const STATE_COLORS = {
  Prospecting:      { bg: "bg-blue-500",   light: "bg-blue-50",   text: "text-blue-700",   border: "border-blue-200" },
  Active:           { bg: "bg-green-500",  light: "bg-green-50",  text: "text-green-700",  border: "border-green-200" },
  Dormant:          { bg: "bg-amber-500",  light: "bg-amber-50",  text: "text-amber-700",  border: "border-amber-200" },
  "Do Not Contact": { bg: "bg-red-500",    light: "bg-red-50",    text: "text-red-700",    border: "border-red-200" },
};

const STATUS_STYLES = {
  "New Lead":                   "bg-blue-50 text-blue-600",
  "Researching":                "bg-indigo-50 text-indigo-600",
  "Attempted Contact":          "bg-amber-50 text-amber-600",
  "Discovery Call Scheduled":   "bg-purple-50 text-purple-600",
  "Proposal Sent":              "bg-cyan-50 text-cyan-600",
  "Nurturing":                  "bg-teal-50 text-teal-600",
  "Qualified":                  "bg-green-50 text-green-700",
  "Unqualified":                "bg-red-50 text-red-600",
  "Converted to Client":        "bg-emerald-50 text-emerald-700",
  "Lost":                       "bg-muted text-muted-foreground",
};

const CADENCE_BADGE = {
  on_track: { label: "On Track", cls: "bg-green-50 text-green-700 border-green-200" },
  due_soon: { label: "Due Soon", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  overdue:  { label: "Overdue",  cls: "bg-orange-50 text-orange-700 border-orange-200" },
  critical: { label: "Critical", cls: "bg-red-50 text-red-700 border-red-200" },
};

const VALUE_BADGE = {
  Low:        { cls: "bg-muted text-muted-foreground border-border" },
  Medium:     { cls: "bg-blue-50 text-blue-700 border-blue-200" },
  High:       { cls: "bg-green-50 text-green-700 border-green-200" },
  Enterprise: { cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

const OUTCOME_COLOR = {
  positive:    "text-green-600",
  neutral:     "text-amber-500",
  negative:    "text-red-500",
  no_response: "text-muted-foreground",
};

const LEVEL_BADGE = {
  industry:     "bg-purple-100 text-purple-700",
  organisation: "bg-blue-100 text-blue-700",
  person:       "bg-green-100 text-green-700",
};

// ─── Cadence defaults (for next-due calculation) ────────────────────────────

const CADENCE_DEFAULTS = { Partner: 14, Senior: 21, Junior: 45, Admin: 60, Payroll: 90, Marketing: 45 };
function getEffectiveCadence(agent) {
  return agent.cadence_interval_days || CADENCE_DEFAULTS[agent.title] || 30;
}

// ─── Relative time helper ───────────────────────────────────────────────────

function relativeTime(dateStr) {
  if (!dateStr) return null;
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

function fmtDate(dateStr) {
  if (!dateStr) return "--";
  return new Date(dateStr).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
}

// ─── Sortable column header ─────────────────────────────────────────────────

function SortHeader({ label, field, tableSort, setTableSort }) {
  const active = tableSort.field === field;
  return (
    <button
      type="button"
      className={cn(
        "flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wider whitespace-nowrap select-none",
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      )}
      onClick={() =>
        setTableSort(prev =>
          prev.field === field
            ? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
            : { field, dir: "desc" }
        )
      }
    >
      {label}
      {active && (tableSort.dir === "asc" ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />)}
    </button>
  );
}

// ─── Insight type config ────────────────────────────────────────────────────

const INSIGHT_CONFIG = {
  channel_imbalance:  { icon: Shuffle,                color: "text-blue-600",   bg: "bg-blue-50",   border: "border-blue-200" },
  warmth_cliff:       { icon: ThermometerSnowflake,   color: "text-cyan-600",   bg: "bg-cyan-50",   border: "border-cyan-200" },
  hot_neglected:      { icon: Star,                   color: "text-amber-600",  bg: "bg-amber-50",  border: "border-amber-200" },
  territory:          { icon: Route,                  color: "text-green-600",  bg: "bg-green-50",  border: "border-green-200" },
  conversion_pattern: { icon: GitBranch,              color: "text-purple-600", bg: "bg-purple-50", border: "border-purple-200" },
  stale_pipeline:     { icon: Archive,                color: "text-gray-600",   bg: "bg-gray-50",   border: "border-gray-200" },
  pulse_triggered:    { icon: Rss,                    color: "text-rose-600",   bg: "bg-rose-50",   border: "border-rose-200" },
  gift_roi:           { icon: Gift,                   color: "text-pink-600",   bg: "bg-pink-50",   border: "border-pink-200" },
};

// ─── Suburb parser helper ───────────────────────────────────────────────────

function parseSuburb(address) {
  if (!address) return null;
  // Try to parse suburb from Australian addresses: "123 Street, Suburb NSW 2000" or "Suburb, NSW"
  const parts = address.split(",").map(s => s.trim());
  if (parts.length >= 2) {
    // Second-to-last part often has suburb + state + postcode
    const candidate = parts[parts.length - 2] || parts[parts.length - 1];
    // Strip postcode and state abbreviation
    return candidate.replace(/\s+(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\s*\d{0,4}\s*$/i, "").trim();
  }
  // Fallback: first part before comma
  return parts[0].replace(/^\d+\s+/, "").trim();
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  SalesCommand Component
// ═════════════════════════════════════════════════════════════════════════════

export default function SalesCommand() {
  // ── Data loading ──────────────────────────────────────────────────────────
  const { data: agents = [], loading: loadingAgents } = useEntityList("Agent", "name");
  const { data: agencies = [] } = useEntityList("Agency", "name");
  const { data: touchpoints = [], loading: loadingTp } = useEntityList("Touchpoint", "-logged_at");
  const { data: touchpointTypes = [] } = useEntityList("TouchpointType", "sort_order");
  const { data: pulseSignals = [] } = useEntityList("PulseSignal", "-created_at");
  const { data: retentionAlerts = [] } = useEntityList("RetentionAlert", "-first_detected_at");
  const { data: user } = useQuery({ queryKey: ["currentUser"], queryFn: () => api.auth.me() });

  // ── State ─────────────────────────────────────────────────────────────────
  const [showLogTouchpoint, setShowLogTouchpoint] = useState(false);
  const [logTouchpointAgentId, setLogTouchpointAgentId] = useState(null);
  const [pipelineFilter, setPipelineFilter] = useState(null);
  const [tableSearch, setTableSearch] = useState("");
  const [tableSort, setTableSort] = useState({ field: "cadence_urgency", dir: "desc" });
  const [showFullTable, setShowFullTable] = useState(false);
  const [cadenceFilter, setCadenceFilter] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dismissedInsights, setDismissedInsights] = useState(new Set());
  const [completingTouchpointId, setCompletingTouchpointId] = useState(null);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const openLogForAgent = useCallback((agentId) => {
    setLogTouchpointAgentId(agentId || null);
    setShowLogTouchpoint(true);
  }, []);

  const agencyMap = useMemo(() => {
    const m = {};
    agencies.forEach(a => { m[a.id] = a; });
    return m;
  }, [agencies]);

  const tpTypeMap = useMemo(() => {
    const m = {};
    touchpointTypes.forEach(t => { m[t.id] = t; m[t.name] = t; });
    return m;
  }, [touchpointTypes]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      refetchEntityList("Agent"),
      refetchEntityList("Touchpoint"),
      refetchEntityList("PulseSignal"),
      refetchEntityList("RetentionAlert"),
    ]);
    setRefreshing(false);
    toast.success("Data refreshed");
  }, []);

  // ── Computed: monitored agents ────────────────────────────────────────────
  const monitored = useMemo(
    () => agents.filter(a => a.relationship_state === "Prospecting" || a.relationship_state === "Active"),
    [agents]
  );

  // ── Computed: agent map for lookups ───────────────────────────────────────
  const agentMap = useMemo(() => {
    const m = {};
    agents.forEach(a => { m[a.id] = a; });
    return m;
  }, [agents]);

  // ── Computed: touchpoints grouped by agent ────────────────────────────────
  const tpByAgent = useMemo(() => {
    const m = {};
    touchpoints.forEach(tp => {
      if (!tp.agent_id) return;
      if (!m[tp.agent_id]) m[tp.agent_id] = [];
      m[tp.agent_id].push(tp);
    });
    return m;
  }, [touchpoints]);

  // ── KPI computations ─────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const activeAlerts = retentionAlerts.filter(a => a.is_active);
    const inPipeline = agents.filter(a => a.relationship_state === "Prospecting");
    const avgWarmth = monitored.length > 0
      ? Math.round(monitored.reduce((sum, a) => sum + (a.warmth_score || 0), 0) / monitored.length)
      : 0;
    const atRisk = agents.filter(a => a.is_at_risk || a.cadence_health === "critical");
    const hasCriticalAlert = activeAlerts.some(a => a.risk_level === "critical");

    return {
      monitored: monitored.length,
      activeAlerts: activeAlerts.length,
      hasCriticalAlert,
      inPipeline: inPipeline.length,
      avgWarmth,
      atRisk: atRisk.length,
    };
  }, [agents, monitored, retentionAlerts]);

  // ── Pipeline state breakdown ──────────────────────────────────────────────
  const pipelineStats = useMemo(() => {
    const states = ["Prospecting", "Active", "Dormant", "Do Not Contact"];
    const total = agents.length || 1;
    return states.map(state => {
      const group = agents.filter(a => a.relationship_state === state);
      const avg = group.length > 0
        ? Math.round(group.reduce((s, a) => s + (a.warmth_score || 0), 0) / group.length)
        : 0;
      // Sub-stages for Prospecting
      let subStages = null;
      if (state === "Prospecting") {
        const stageNames = ["New Lead", "Researching", "Attempted Contact", "Discovery Call Scheduled", "Proposal Sent", "Nurturing", "Qualified", "Unqualified"];
        subStages = stageNames.map(sn => ({
          name: sn,
          count: group.filter(a => a.status === sn).length,
        })).filter(s => s.count > 0);
      }
      return { state, count: group.length, pct: (group.length / total * 100), avgWarmth: avg, subStages };
    });
  }, [agents]);

  // ── Recent activity (last 10 touchpoints) ─────────────────────────────────
  const recentActivity = useMemo(() => {
    return touchpoints.slice(0, 10).map(tp => {
      const agent = tp.agent_id ? agentMap[tp.agent_id] : null;
      const tpType = tp.touchpoint_type_id ? tpTypeMap[tp.touchpoint_type_id] : tpTypeMap[tp.touchpoint_type_name];
      const IconComp = tpType?.icon_name ? (ICON_MAP[tpType.icon_name] || Phone) : Phone;
      return { ...tp, agent, tpType, IconComp };
    });
  }, [touchpoints, agentMap, tpTypeMap]);

  // ── Pulse signals (new & actionable) ──────────────────────────────────────
  const actionableSignals = useMemo(
    () => pulseSignals.filter(s => s.status === "new" && s.is_actionable),
    [pulseSignals]
  );

  // ═════════════════════════════════════════════════════════════════════════
  // ██  FEATURE 1: Intelligent Insights Engine
  // ═════════════════════════════════════════════════════════════════════════

  const smartInsights = useMemo(() => {
    const insights = [];
    const now = Date.now();
    const DAY = 86400000;

    // Helper: days since a date string
    const daysSince = (dateStr) => dateStr ? Math.round((now - new Date(dateStr).getTime()) / DAY) : null;

    // ─── 1. Channel Imbalance ───────────────────────────────────────────
    monitored.forEach(agent => {
      const agentTps = tpByAgent[agent.id] || [];
      if (agentTps.length < 4) return;
      // Count by touchpoint type name
      const typeCounts = {};
      agentTps.forEach(tp => {
        const name = tp.touchpoint_type_name || "Other";
        typeCounts[name] = (typeCounts[name] || 0) + 1;
      });
      const types = Object.entries(typeCounts);
      // Check if any single type has 4+ and represents >80% of all touchpoints
      types.forEach(([typeName, count]) => {
        if (count >= 4 && types.length <= 2 && count / agentTps.length >= 0.75) {
          insights.push({
            id: `channel_${agent.id}_${typeName}`,
            type: "channel_imbalance",
            title: "Channel imbalance detected",
            description: `You've ${typeName.toLowerCase()}'d ${agent.name} ${count} times with little variety. Mix it up \u2014 phone calls convert 3x better after email-only sequences.`,
            agentIds: [agent.id],
            action: `Try a different channel for ${agent.name}`,
            priority: 3,
          });
        }
      });
    });

    // ─── 2. Warmth Cliff ────────────────────────────────────────────────
    agents.forEach(agent => {
      if (agent.warmth_trend === "declining" && (agent.warmth_score || 0) < 50) {
        const prevScore = (agent.warmth_score || 0) + 20; // Estimate previous
        insights.push({
          id: `warmth_cliff_${agent.id}`,
          type: "warmth_cliff",
          title: "Warmth dropping fast",
          description: `${agent.name} has dropped to ${agent.warmth_score || 0} warmth and is declining. They may be going cold. Priority reach-out recommended.`,
          agentIds: [agent.id],
          action: `Urgent: reach out to ${agent.name} before they go cold`,
          priority: 1,
        });
      }
    });

    // ─── 3. Hot Prospect Neglected ──────────────────────────────────────
    monitored.forEach(agent => {
      const agentTps = tpByAgent[agent.id] || [];
      // Count "high-signal" touchpoints (meetings, events, walk-ins, positive outcomes)
      const highSignalCount = agentTps.filter(tp => {
        const tpType = tp.touchpoint_type_id ? tpTypeMap[tp.touchpoint_type_id] : tpTypeMap[tp.touchpoint_type_name];
        const cat = tpType?.category || "";
        return cat === "meeting" || cat === "event" || tp.outcome === "positive" ||
               tp.touchpoint_type_name === "Walk-in Visit" || tp.touchpoint_type_name === "Office Visit";
      }).length;

      if (highSignalCount >= 2) {
        const dSince = daysSince(agent.last_touchpoint_at);
        const cadence = getEffectiveCadence(agent);
        if (dSince && dSince > cadence) {
          insights.push({
            id: `hot_neglected_${agent.id}`,
            type: "hot_neglected",
            title: "Hot prospect going quiet",
            description: `${agent.name} has ${highSignalCount} high-signal interactions but hasn't been contacted in ${dSince} days. Don't let this one slip.`,
            agentIds: [agent.id],
            action: `Re-engage ${agent.name} immediately`,
            priority: 1,
          });
        }
      }
    });

    // ─── 4. Territory Opportunity ───────────────────────────────────────
    const overdueAgents = monitored.filter(a =>
      a.cadence_health === "overdue" || a.cadence_health === "critical"
    );
    // Group overdue agents by suburb (via their agency address)
    const suburbGroups = {};
    overdueAgents.forEach(agent => {
      const agency = agent.current_agency_id ? agencyMap[agent.current_agency_id] : null;
      if (!agency?.address) return;
      const suburb = parseSuburb(agency.address);
      if (!suburb) return;
      const key = suburb.toLowerCase();
      if (!suburbGroups[key]) suburbGroups[key] = { suburb, agents: [] };
      suburbGroups[key].agents.push(agent);
    });
    Object.values(suburbGroups).forEach(group => {
      if (group.agents.length >= 3) {
        insights.push({
          id: `territory_${group.suburb}`,
          type: "territory",
          title: `Walk-in run: ${group.suburb}`,
          description: `You have ${group.agents.length} overdue agents near each other in ${group.suburb}. Plan a walk-in run to hit them all.`,
          agentIds: group.agents.map(a => a.id),
          action: `Plan walk-in visits in ${group.suburb}`,
          priority: 2,
        });
      }
    });

    // ─── 5. Conversion Pattern ──────────────────────────────────────────
    // Find recently converted agents (Active state with decent touchpoint history)
    const converted = agents.filter(a => a.relationship_state === "Active" && (a.touchpoint_count || 0) >= 5);
    if (converted.length >= 2) {
      // Calculate average touchpoints and walk-in count for converted agents
      const convertedStats = converted.map(a => {
        const agentTps = tpByAgent[a.id] || [];
        const walkIns = agentTps.filter(tp =>
          tp.touchpoint_type_name === "Walk-in Visit" || tp.touchpoint_type_name === "Office Visit"
        ).length;
        return { count: a.touchpoint_count || agentTps.length, walkIns };
      });
      const avgTpCount = Math.round(convertedStats.reduce((s, c) => s + c.count, 0) / convertedStats.length);
      const avgWalkIns = Math.round(convertedStats.reduce((s, c) => s + c.walkIns, 0) / convertedStats.length);

      // Find prospects close to conversion pattern
      monitored.filter(a => a.relationship_state === "Prospecting").forEach(agent => {
        const agentTps = tpByAgent[agent.id] || [];
        const tpCount = agent.touchpoint_count || agentTps.length;
        const walkIns = agentTps.filter(tp =>
          tp.touchpoint_type_name === "Walk-in Visit" || tp.touchpoint_type_name === "Office Visit"
        ).length;

        if (tpCount >= avgTpCount * 0.6 && walkIns >= 1 && tpCount < avgTpCount) {
          insights.push({
            id: `conversion_${agent.id}`,
            type: "conversion_pattern",
            title: "Close to conversion pattern",
            description: `Your conversions average ${avgTpCount} touches with ${avgWalkIns}+ walk-ins. ${agent.name} has ${tpCount} touches and ${walkIns} walk-in${walkIns !== 1 ? "s" : ""} \u2014 they're close.`,
            agentIds: [agent.id],
            action: `Push ${agent.name} over the line with another walk-in`,
            priority: 2,
          });
        }
      });
    }

    // ─── 6. Stale Pipeline ──────────────────────────────────────────────
    const staleAgents = agents.filter(a => {
      if (a.relationship_state !== "Prospecting") return false;
      const ageMs = a.created_date ? now - new Date(a.created_date).getTime() : 0;
      const ageMonths = ageMs / (30 * DAY);
      return ageMonths >= 6 && (a.touchpoint_count || 0) < 3;
    });
    if (staleAgents.length >= 2) {
      insights.push({
        id: "stale_pipeline",
        type: "stale_pipeline",
        title: "Stale pipeline clogging your view",
        description: `${staleAgents.length} agents have been in Prospecting for 6+ months with fewer than 3 touchpoints. Consider re-engaging or archiving them.`,
        agentIds: staleAgents.slice(0, 5).map(a => a.id),
        action: "Review and clean up stale prospects",
        priority: 4,
      });
    }

    // ─── 7. Pulse-Triggered ─────────────────────────────────────────────
    actionableSignals.forEach(sig => {
      const linkedAgentIds = sig.linked_agent_ids || [];
      // Find linked agents that are in the pipeline (Prospecting/Active)
      const pipelineLinked = linkedAgentIds.filter(id => {
        const a = agentMap[id];
        return a && (a.relationship_state === "Prospecting" || a.relationship_state === "Active");
      });
      if (pipelineLinked.length > 0 && sig.title) {
        const eventDate = sig.event_date ? ` on ${fmtDate(sig.event_date)}` : "";
        insights.push({
          id: `pulse_${sig.id}`,
          type: "pulse_triggered",
          title: `Pulse: ${sig.title}`,
          description: `${sig.title}${eventDate}. ${pipelineLinked.length} of your prospect${pipelineLinked.length !== 1 ? "s" : ""} ${pipelineLinked.length !== 1 ? "are" : "is"} linked \u2014 attend and log touchpoints.`,
          agentIds: pipelineLinked,
          action: "Attend the event and log touchpoints",
          priority: 2,
        });
      }
    });

    // ─── 8. Gift ROI ────────────────────────────────────────────────────
    const agentsWithGifts = [];
    const agentsWithoutGifts = [];
    monitored.forEach(agent => {
      const agentTps = tpByAgent[agent.id] || [];
      const hasGift = agentTps.some(tp => {
        const tpType = tp.touchpoint_type_id ? tpTypeMap[tp.touchpoint_type_id] : tpTypeMap[tp.touchpoint_type_name];
        return tpType?.category === "gift" || tp.touchpoint_type_name === "Gift Drop-off";
      });
      if (hasGift) agentsWithGifts.push(agent);
      else agentsWithoutGifts.push(agent);
    });

    if (agentsWithGifts.length >= 3 && agentsWithoutGifts.length >= 3) {
      const avgGift = Math.round(agentsWithGifts.reduce((s, a) => s + (a.warmth_score || 0), 0) / agentsWithGifts.length);
      const avgNoGift = Math.round(agentsWithoutGifts.reduce((s, a) => s + (a.warmth_score || 0), 0) / agentsWithoutGifts.length);
      if (avgGift > avgNoGift) {
        const liftPct = avgNoGift > 0 ? Math.round(((avgGift - avgNoGift) / avgNoGift) * 100) : 0;
        // Suggest gifting to top prospects without gifts
        const topProspects = agentsWithoutGifts
          .filter(a => a.relationship_state === "Prospecting" && (a.warmth_score || 0) >= 30)
          .sort((a, b) => (b.warmth_score || 0) - (a.warmth_score || 0))
          .slice(0, 5);
        if (topProspects.length > 0) {
          insights.push({
            id: "gift_roi",
            type: "gift_roi",
            title: "Gifts are working",
            description: `Agents who received gifts average ${avgGift} warmth vs ${avgNoGift} without (${liftPct}% lift). Consider a gift touchpoint for your top ${topProspects.length} prospect${topProspects.length !== 1 ? "s" : ""}.`,
            agentIds: topProspects.map(a => a.id),
            action: "Send gifts to top ungifted prospects",
            priority: 3,
          });
        }
      }
    }

    // ── Sort by priority, then take top 5 ──
    insights.sort((a, b) => a.priority - b.priority);
    return insights;
  }, [agents, monitored, touchpoints, tpByAgent, tpTypeMap, agentMap, agencyMap, actionableSignals]);

  // Visible insights (not dismissed)
  const visibleInsights = useMemo(
    () => smartInsights.filter(i => !dismissedInsights.has(i.id)).slice(0, 5),
    [smartInsights, dismissedInsights]
  );

  const dismissInsight = useCallback((insightId) => {
    setDismissedInsights(prev => new Set([...prev, insightId]));
  }, []);

  // ═════════════════════════════════════════════════════════════════════════
  // ██  FEATURE 2: Upcoming Follow-Ups
  // ═════════════════════════════════════════════════════════════════════════

  const plannedFollowUps = useMemo(() => {
    return touchpoints.filter(tp => tp.is_planned && !tp.completed_at && tp.follow_up_date);
  }, [touchpoints]);

  const followUpGroups = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const endOfWeek = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const endOfNextWeek = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

    const overdue = [];
    const todayItems = [];
    const tomorrowItems = [];
    const thisWeek = [];
    const nextWeek = [];
    const later = [];

    plannedFollowUps.forEach(tp => {
      const d = tp.follow_up_date?.slice(0, 10);
      if (!d) return;
      const enriched = {
        ...tp,
        agent: tp.agent_id ? agentMap[tp.agent_id] : null,
        tpType: tp.touchpoint_type_id ? tpTypeMap[tp.touchpoint_type_id] : tpTypeMap[tp.touchpoint_type_name],
        daysUntil: Math.round((new Date(d).getTime() - new Date(today).getTime()) / 86400000),
      };
      if (d < today) overdue.push(enriched);
      else if (d === today) todayItems.push(enriched);
      else if (d === tomorrow) tomorrowItems.push(enriched);
      else if (d <= endOfWeek) thisWeek.push(enriched);
      else if (d <= endOfNextWeek) nextWeek.push(enriched);
      else later.push(enriched);
    });

    // Sort each group by date
    const sortByDate = (a, b) => (a.follow_up_date || "").localeCompare(b.follow_up_date || "");
    overdue.sort(sortByDate);
    todayItems.sort(sortByDate);
    tomorrowItems.sort(sortByDate);
    thisWeek.sort(sortByDate);
    nextWeek.sort(sortByDate);
    later.sort(sortByDate);

    return { overdue, today: todayItems, tomorrow: tomorrowItems, thisWeek, nextWeek, later };
  }, [plannedFollowUps, agentMap, tpTypeMap]);

  const totalFollowUps = plannedFollowUps.length;

  const handleSnooze = useCallback(async (touchpointId) => {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    try {
      await api.entities.Touchpoint.update(touchpointId, { follow_up_date: tomorrow });
      refetchEntityList("Touchpoint");
      toast.success("Snoozed to tomorrow");
    } catch {
      toast.error("Failed to snooze");
    }
  }, []);

  const handleCompleteFollowUp = useCallback((touchpoint) => {
    setLogTouchpointAgentId(touchpoint.agent_id);
    setCompletingTouchpointId(touchpoint.id);
    setShowLogTouchpoint(true);
  }, []);

  // ── Agents at risk ────────────────────────────────────────────────────────
  const atRiskAgents = useMemo(() => {
    const alertAgentIds = new Set();
    retentionAlerts.filter(a => a.is_active && a.investigation_status === "red_flag").forEach(a => {
      if (a.agent_id) alertAgentIds.add(a.agent_id);
    });
    return agents.filter(a =>
      a.cadence_health === "critical" ||
      a.cadence_health === "overdue" ||
      (a.warmth_trend === "declining" && (a.warmth_score || 0) < 40) ||
      a.is_at_risk ||
      alertAgentIds.has(a.id)
    ).map(a => {
      let reason = "";
      if (a.cadence_health === "critical") {
        const daysSince = a.last_touchpoint_at
          ? Math.round((Date.now() - new Date(a.last_touchpoint_at).getTime()) / 86400000)
          : null;
        reason = daysSince ? `Overdue ${daysSince}d` : "Critical cadence";
      } else if (a.cadence_health === "overdue") {
        reason = "Overdue";
      } else if (a.warmth_trend === "declining" && (a.warmth_score || 0) < 40) {
        reason = "Declining warmth";
      } else if (alertAgentIds.has(a.id)) {
        reason = "Retention red flag";
      } else {
        reason = "At risk";
      }
      return { ...a, riskReason: reason };
    }).slice(0, 10);
  }, [agents, retentionAlerts]);

  // ── Channel mix (last 30 days) ────────────────────────────────────────────
  const channelMix = useMemo(() => {
    const cutoff = Date.now() - 30 * 86400000;
    const recent = touchpoints.filter(tp => {
      const d = tp.logged_at || tp.created_date;
      return d && new Date(d).getTime() > cutoff;
    });
    const counts = {};
    recent.forEach(tp => {
      const name = tp.touchpoint_type_name || "Other";
      counts[name] = (counts[name] || 0) + 1;
    });
    const total = recent.length || 1;
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return { total: recent.length, entries: entries.map(([name, count]) => {
      const tpType = tpTypeMap[name];
      const cat = tpType?.category || "outbound";
      return { name, count, pct: Math.round(count / total * 100), category: cat };
    }) };
  }, [touchpoints, tpTypeMap]);

  // ── Pipeline table: filtered, searched, sorted ────────────────────────────
  const pipelineAgents = useMemo(() => {
    let list = agents.filter(a =>
      a.relationship_state === "Prospecting" ||
      a.relationship_state === "Active" ||
      a.relationship_state === "Dormant"
    );
    if (pipelineFilter) list = list.filter(a => a.relationship_state === pipelineFilter);
    if (cadenceFilter) list = list.filter(a => a.cadence_health === cadenceFilter);
    if (tableSearch) {
      const q = tableSearch.toLowerCase();
      list = list.filter(a => {
        const agencyName = a.current_agency_id ? agencyMap[a.current_agency_id]?.name : "";
        return (a.name || "").toLowerCase().includes(q)
          || (agencyName || "").toLowerCase().includes(q)
          || (a.relationship_state || "").toLowerCase().includes(q);
      });
    }
    // Compute cadence urgency for sorting
    const URGENCY_MAP = { critical: 4, overdue: 3, due_soon: 2, on_track: 1 };
    list = list.map(a => ({
      ...a,
      cadence_urgency: URGENCY_MAP[a.cadence_health] || 0,
      _agencyName: a.current_agency_id ? agencyMap[a.current_agency_id]?.name : "",
    }));
    // Sort
    const { field, dir } = tableSort;
    const mult = dir === "asc" ? 1 : -1;
    list.sort((a, b) => {
      let va, vb;
      switch (field) {
        case "name":           va = (a.name || "").toLowerCase(); vb = (b.name || "").toLowerCase(); break;
        case "warmth_score":   va = a.warmth_score || 0; vb = b.warmth_score || 0; break;
        case "cadence_urgency":va = a.cadence_urgency; vb = b.cadence_urgency; break;
        case "last_touch":     va = a.last_touchpoint_at || ""; vb = b.last_touchpoint_at || ""; break;
        case "touchpoint_count":va = a.touchpoint_count || 0; vb = b.touchpoint_count || 0; break;
        case "relationship_state": va = a.relationship_state || ""; vb = b.relationship_state || ""; break;
        case "value_potential": {
          const rank = { Low: 1, Medium: 2, High: 3, Enterprise: 4 };
          va = rank[a.value_potential] || 0; vb = rank[b.value_potential] || 0; break;
        }
        default: va = a.cadence_urgency; vb = b.cadence_urgency;
      }
      if (va < vb) return -1 * mult;
      if (va > vb) return 1 * mult;
      return 0;
    });
    return list;
  }, [agents, pipelineFilter, cadenceFilter, tableSearch, tableSort, agencyMap]);

  const visibleAgents = showFullTable ? pipelineAgents : pipelineAgents.slice(0, 20);

  // ── Warmth tier color helper ──────────────────────────────────────────────
  function warmthColor(score) {
    if (score <= 20) return "text-blue-600";
    if (score <= 40) return "text-sky-600";
    if (score <= 60) return "text-amber-600";
    if (score <= 80) return "text-orange-600";
    return "text-red-600";
  }
  function warmthBg(score) {
    if (score <= 20) return "bg-blue-50";
    if (score <= 40) return "bg-sky-50";
    if (score <= 60) return "bg-amber-50";
    if (score <= 80) return "bg-orange-50";
    return "bg-red-50";
  }

  // ── Loading state ─────────────────────────────────────────────────────────
  const loading = loadingAgents || loadingTp;

  // ═══════════════════════════════════════════════════════════════════════════
  // ██  RENDER
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-6 py-3 border-b bg-card shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-primary/10">
            <Crosshair className="h-4.5 w-4.5 text-primary" />
          </div>
          <div>
            <h1 className="text-base font-bold leading-tight select-none">Sales Command</h1>
            <p className="text-[11px] text-muted-foreground">Nurturing & pipeline at a glance</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh data"
            aria-label="Refresh data"
          >
            <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          </Button>
          <Button size="sm" className="h-8 gap-1.5" onClick={() => openLogForAgent(null)}>
            <Plus className="h-3.5 w-3.5" />
            Log Touchpoint
          </Button>
        </div>
      </div>

      {/* ── Two-column body ────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left Sidebar: Punch List ─────────────────────────────────────── */}
        <div className="w-80 shrink-0 border-r bg-card/50 overflow-y-auto p-4">
          <DailyPunchList onLogTouchpoint={openLogForAgent} />
        </div>

        {/* ── Right Content ────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto p-6 space-y-5">

          {/* ─── Row 1: KPI Strip ──────────────────────────────────────────── */}
          <div className="grid grid-cols-5 gap-3">
            {/* Monitored */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider select-none">Monitored</span>
              </div>
              <p className="text-2xl font-bold">{kpis.monitored}</p>
              <p className="text-[11px] text-muted-foreground">active + prospecting</p>
            </div>

            {/* Active Alerts */}
            <div className={cn("rounded-xl border p-4 shadow-sm", kpis.hasCriticalAlert ? "bg-red-50/60 border-red-200" : "bg-card")}>
              <div className="flex items-center gap-2 mb-2">
                <AlertTriangle className={cn("h-4 w-4", kpis.hasCriticalAlert ? "text-red-500" : "text-muted-foreground")} />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider select-none">Alerts</span>
              </div>
              <p className={cn("text-2xl font-bold", kpis.activeAlerts > 0 && "text-red-600")}>{kpis.activeAlerts}</p>
              <p className="text-[11px] text-muted-foreground">active retention</p>
            </div>

            {/* In Pipeline */}
            <div className="rounded-xl border bg-blue-50/40 border-blue-100 p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-2">
                <Target className="h-4 w-4 text-blue-500" />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider select-none">Pipeline</span>
              </div>
              <p className="text-2xl font-bold text-blue-700">{kpis.inPipeline}</p>
              <p className="text-[11px] text-muted-foreground">prospecting</p>
            </div>

            {/* Avg Warmth */}
            <div className={cn("rounded-xl border p-4 shadow-sm", warmthBg(kpis.avgWarmth))}>
              <div className="flex items-center gap-2 mb-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider select-none">Avg Warmth</span>
              </div>
              <p className={cn("text-2xl font-bold", warmthColor(kpis.avgWarmth))}>{kpis.avgWarmth}</p>
              <p className="text-[11px] text-muted-foreground">across monitored</p>
            </div>

            {/* At Risk */}
            <div className={cn("rounded-xl border p-4 shadow-sm", kpis.atRisk > 0 ? "bg-red-50/60 border-red-200" : "bg-card")}>
              <div className="flex items-center gap-2 mb-2">
                <ShieldAlert className={cn("h-4 w-4", kpis.atRisk > 0 ? "text-red-500" : "text-muted-foreground")} />
                <span className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider select-none">At Risk</span>
              </div>
              <p className={cn("text-2xl font-bold", kpis.atRisk > 0 && "text-red-600")}>{kpis.atRisk}</p>
              <p className="text-[11px] text-muted-foreground">need attention</p>
            </div>
          </div>

          {/* ─── Row 2: Pipeline Health ────────────────────────────────────── */}
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Pipeline Health
              </h3>
              {pipelineFilter && (
                <Button variant="ghost" size="sm" className="h-6 text-[11px] px-2 gap-1" onClick={() => setPipelineFilter(null)}>
                  <XCircle className="h-3 w-3" />
                  Clear filter
                </Button>
              )}
            </div>
            <div className="space-y-2">
              {pipelineStats.map(ps => {
                const sc = STATE_COLORS[ps.state] || STATE_COLORS.Dormant;
                const isActive = pipelineFilter === ps.state;
                return (
                  <button
                    key={ps.state}
                    type="button"
                    className={cn(
                      "w-full text-left rounded-lg px-3 py-2 transition-all",
                      isActive ? cn(sc.light, "ring-2", sc.border.replace("border-", "ring-")) : "hover:bg-muted/50"
                    )}
                    onClick={() => setPipelineFilter(isActive ? null : ps.state)}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className={cn("text-xs font-semibold", sc.text)}>{ps.state}</span>
                        <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{ps.count}</Badge>
                      </div>
                      <WarmthScoreBadge score={ps.avgWarmth} size="sm" />
                    </div>
                    {/* Main bar */}
                    <div className="h-2.5 w-full bg-muted rounded-full overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", sc.bg)}
                        style={{ width: `${Math.max(ps.pct, ps.count > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                    {/* Sub-stages for Prospecting */}
                    {ps.subStages && ps.subStages.length > 0 && (
                      <div className="flex gap-0.5 mt-1.5 h-1.5 rounded-full overflow-hidden bg-muted">
                        {ps.subStages.map(sub => (
                          <div
                            key={sub.name}
                            className={cn("h-full transition-all rounded-full", STATUS_STYLES[sub.name]?.split(" ")[0] || "bg-blue-200")}
                            style={{ width: `${Math.max((sub.count / (ps.count || 1)) * 100, 4)}%` }}
                            title={`${sub.name}: ${sub.count}`}
                          />
                        ))}
                      </div>
                    )}
                    {/* Sub-stage labels */}
                    {ps.subStages && ps.subStages.length > 0 && (
                      <div className="flex gap-2 mt-1 flex-wrap">
                        {ps.subStages.map(sub => (
                          <span key={sub.name} className="text-[10px] text-muted-foreground">
                            {sub.name}: {sub.count}
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ─── NEW: Smart Insights Widget ───────────────────────────────── */}
          {visibleInsights.length > 0 && (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Lightbulb className="h-4 w-4 text-amber-500" />
                  Smart Insights
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">
                    {smartInsights.filter(i => !dismissedInsights.has(i.id)).length}
                  </Badge>
                </h3>
                {dismissedInsights.size > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] px-2 gap-1"
                    onClick={() => setDismissedInsights(new Set())}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Show dismissed
                  </Button>
                )}
              </div>
              <div className="space-y-2">
                {visibleInsights.map(insight => {
                  const cfg = INSIGHT_CONFIG[insight.type] || INSIGHT_CONFIG.stale_pipeline;
                  const IconComp = cfg.icon;
                  return (
                    <div
                      key={insight.id}
                      className={cn(
                        "flex items-start gap-3 px-3 py-2.5 rounded-lg border transition-all",
                        cfg.bg, cfg.border
                      )}
                    >
                      <div className={cn("mt-0.5 shrink-0")}>
                        <IconComp className={cn("h-4 w-4", cfg.color)} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <p className="text-xs font-semibold truncate">{insight.title}</p>
                          <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                            P{insight.priority}
                          </Badge>
                        </div>
                        <p className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed">
                          {insight.description}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {insight.agentIds.length > 0 && (
                          <Button
                            size="sm"
                            variant="default"
                            className="h-6 text-[10px] px-2 gap-1"
                            onClick={() => openLogForAgent(insight.agentIds[0])}
                          >
                            <Zap className="h-3 w-3" />
                            Take Action
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground transition-colors"
                          onClick={() => dismissInsight(insight.id)}
                          title="Dismiss this insight"
                          aria-label="Dismiss insight"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── Row 3: Recent Activity + Pulse Signals ────────────────────── */}
          <div className="grid grid-cols-2 gap-4">
            {/* Recent Activity */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                Recent Activity
              </h3>
              {recentActivity.length === 0 ? (
                <div className="py-6 text-center">
                  <Phone className="h-6 w-6 mx-auto text-muted-foreground/40 mb-2" />
                  <p className="text-xs text-muted-foreground">No touchpoints recorded yet. Log your first interaction to see activity here.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {recentActivity.map(tp => (
                    <div key={tp.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors">
                      <tp.IconComp className={cn("h-4 w-4 shrink-0", OUTCOME_COLOR[tp.outcome] || "text-muted-foreground")} />
                      <div className="flex-1 min-w-0">
                        {tp.agent ? (
                          <Link
                            to={createPageUrl(`PersonDetails?id=${tp.agent_id}`)}
                            className="text-xs font-medium hover:underline truncate block"
                          >
                            {tp.agent.name || "Unknown"}
                          </Link>
                        ) : (
                          <span className="text-xs font-medium text-muted-foreground truncate block">Unknown</span>
                        )}
                        {tp.notes && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {tp.notes.length > 40 ? tp.notes.slice(0, 40) + "..." : tp.notes}
                          </p>
                        )}
                      </div>
                      <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                        {relativeTime(tp.logged_at || tp.created_date)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Pulse Signals */}
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Rss className="h-4 w-4 text-muted-foreground" />
                  Pulse Signals
                  {actionableSignals.length > 0 && (
                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{actionableSignals.length}</Badge>
                  )}
                </h3>
                <Link
                  to={createPageUrl("IndustryPulse")}
                  className="text-[11px] text-primary hover:underline flex items-center gap-0.5"
                >
                  View All <ArrowUpRight className="h-3 w-3" />
                </Link>
              </div>
              {actionableSignals.length === 0 ? (
                <div className="py-6 text-center">
                  <Rss className="h-6 w-6 mx-auto text-muted-foreground/40 mb-2" />
                  <p className="text-xs text-muted-foreground">No actionable signals yet. Head to Industry Pulse to capture your first piece of intel.</p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {actionableSignals.slice(0, 5).map(sig => (
                    <div key={sig.id} className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg hover:bg-muted/50 transition-colors group">
                      <Badge className={cn("text-[9px] px-1.5 py-0 h-5 shrink-0", LEVEL_BADGE[(sig.level || "").toLowerCase()] || "bg-muted text-muted-foreground")}>
                        {sig.level || "Signal"}
                      </Badge>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{sig.title || "Untitled signal"}</p>
                        {sig.event_date && (
                          <p className="text-[10px] text-muted-foreground">{fmtDate(sig.event_date)}</p>
                        )}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        onClick={() => openLogForAgent(sig.agent_id)}
                      >
                        <Zap className="h-3 w-3" />
                        Action
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ─── NEW: Upcoming Follow-Ups Widget ──────────────────────────── */}
          {totalFollowUps > 0 && (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  Upcoming Follow-Ups
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{totalFollowUps}</Badge>
                  {followUpGroups.overdue.length > 0 && (
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-5">
                      {followUpGroups.overdue.length} overdue
                    </Badge>
                  )}
                </h3>
              </div>

              <div className="space-y-3">
                {/* Overdue group */}
                {followUpGroups.overdue.length > 0 && (
                  <FollowUpGroup
                    label="Overdue"
                    items={followUpGroups.overdue}
                    isOverdue
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
                {/* Today */}
                {followUpGroups.today.length > 0 && (
                  <FollowUpGroup
                    label="Today"
                    items={followUpGroups.today}
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
                {/* Tomorrow */}
                {followUpGroups.tomorrow.length > 0 && (
                  <FollowUpGroup
                    label="Tomorrow"
                    items={followUpGroups.tomorrow}
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
                {/* This Week */}
                {followUpGroups.thisWeek.length > 0 && (
                  <FollowUpGroup
                    label="This Week"
                    items={followUpGroups.thisWeek}
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
                {/* Next Week */}
                {followUpGroups.nextWeek.length > 0 && (
                  <FollowUpGroup
                    label="Next Week"
                    items={followUpGroups.nextWeek}
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
                {/* Later */}
                {followUpGroups.later.length > 0 && (
                  <FollowUpGroup
                    label="Later"
                    items={followUpGroups.later}
                    onComplete={handleCompleteFollowUp}
                    onSnooze={handleSnooze}
                    agencyMap={agencyMap}
                  />
                )}
              </div>
            </div>
          )}

          {/* ─── Row 4: Agents At Risk ─────────────────────────────────────── */}
          {atRiskAgents.length > 0 && (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <ShieldAlert className="h-4 w-4 text-red-500" />
                Agents At Risk
                <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-5">{atRiskAgents.length}</Badge>
              </h3>
              <div className="space-y-1">
                {atRiskAgents.map(a => (
                  <div key={a.id} className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-muted/50 transition-colors group">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          to={createPageUrl(`PersonDetails?id=${a.id}`)}
                          className="text-xs font-medium hover:underline truncate"
                        >
                          {a.name || "Unknown"}
                        </Link>
                        {a._agencyName || (a.current_agency_id && agencyMap[a.current_agency_id]?.name) ? (
                          <span className="text-[10px] text-muted-foreground truncate">
                            {a._agencyName || agencyMap[a.current_agency_id]?.name}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <WarmthScoreBadge score={a.warmth_score} trend={a.warmth_trend} size="sm" />
                    <span className="text-[10px] text-red-600 font-medium whitespace-nowrap shrink-0">{a.riskReason}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] px-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                      onClick={() => openLogForAgent(a.id)}
                    >
                      <PhoneOutgoing className="h-3 w-3" />
                      Reach Out
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ─── Row 5: Channel Mix (last 30 days) ─────────────────────────── */}
          {channelMix.total > 0 && (
            <div className="rounded-xl border bg-card p-4 shadow-sm">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
                <BarChart3 className="h-4 w-4 text-muted-foreground" />
                Channel Mix
                <span className="text-[11px] text-muted-foreground font-normal">last 30 days</span>
              </h3>
              {/* Stacked bar */}
              <div className="h-8 w-full rounded-lg overflow-hidden flex bg-muted">
                {channelMix.entries.map((e, i) => {
                  const cc = getCatColor(e.category);
                  return (
                    <div
                      key={e.name}
                      className={cn("h-full transition-all", cc.bg)}
                      style={{ width: `${Math.max(e.pct, 2)}%` }}
                      title={`${e.name}: ${e.count} (${e.pct}%)`}
                    />
                  );
                })}
              </div>
              {/* Legend */}
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-x-4 gap-y-1.5 mt-3">
                {channelMix.entries.map(e => {
                  const cc = getCatColor(e.category);
                  return (
                    <div key={e.name} className="flex items-center gap-1.5">
                      <div className={cn("h-2 w-2 rounded-full shrink-0", cc.bg)} />
                      <span className="text-[10px] text-muted-foreground truncate">{e.name}</span>
                      <span className="text-[10px] font-medium ml-auto">{e.count}</span>
                      <span className="text-[10px] text-muted-foreground">({e.pct}%)</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ─── Row 5b: Weekly Planner ────────────────────────────────────── */}
          <WeeklyPlanner onLogTouchpoint={openLogForAgent} />

          {/* ─── Row 6: Full Pipeline Table ────────────────────────────────── */}
          <div className="rounded-xl border bg-card p-4 shadow-sm">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                Pipeline
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-5">{pipelineAgents.length}</Badge>
              </h3>
              <div className="flex items-center gap-2">
                {/* Filter chips: state */}
                <div className="flex gap-1">
                  {["Prospecting", "Active", "Dormant"].map(state => {
                    const sc = STATE_COLORS[state];
                    const isOn = pipelineFilter === state;
                    return (
                      <button
                        key={state}
                        type="button"
                        className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full border transition-all",
                          isOn ? cn(sc.light, sc.text, sc.border, "font-semibold") : "border-border text-muted-foreground hover:bg-muted/50"
                        )}
                        onClick={() => setPipelineFilter(isOn ? null : state)}
                      >
                        {state}
                      </button>
                    );
                  })}
                </div>
                {/* Filter chips: cadence */}
                <div className="flex gap-1">
                  {Object.entries(CADENCE_BADGE).map(([key, cfg]) => {
                    const isOn = cadenceFilter === key;
                    return (
                      <button
                        key={key}
                        type="button"
                        className={cn(
                          "text-[10px] px-2 py-0.5 rounded-full border transition-all",
                          isOn ? cn(cfg.cls, "font-semibold") : "border-border text-muted-foreground hover:bg-muted/50"
                        )}
                        onClick={() => setCadenceFilter(isOn ? null : key)}
                      >
                        {cfg.label}
                      </button>
                    );
                  })}
                </div>
                {/* Search */}
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                  <Input
                    value={tableSearch}
                    onChange={e => setTableSearch(e.target.value)}
                    placeholder="Search pipeline..."
                    className="h-7 text-xs pl-8 w-44"
                  />
                </div>
              </div>
            </div>

            {pipelineAgents.length === 0 ? (
              <div className="py-8 text-center">
                <Users className="h-8 w-8 mx-auto text-muted-foreground/40 mb-2" />
                <p className="text-sm text-muted-foreground">No contacts in your pipeline yet. Add your first prospect from the People page to see them here.</p>
              </div>
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b">
                        <th className="pb-2 pr-3"><SortHeader label="Agent" field="name" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3"><SortHeader label="Warmth" field="warmth_score" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3"><SortHeader label="Cadence" field="cadence_urgency" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3"><SortHeader label="Last Touch" field="last_touch" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap select-none">Next Due</th>
                        <th className="pb-2 pr-3"><SortHeader label="Touches" field="touchpoint_count" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3"><SortHeader label="Stage" field="relationship_state" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3"><SortHeader label="Value" field="value_potential" tableSort={tableSort} setTableSort={setTableSort} /></th>
                        <th className="pb-2 pr-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground whitespace-nowrap select-none">Engagement</th>
                        <th className="pb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground select-none">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleAgents.map(a => {
                        const agencyName = a._agencyName || (a.current_agency_id ? agencyMap[a.current_agency_id]?.name : "");
                        const cadenceCfg = CADENCE_BADGE[a.cadence_health] || { label: a.cadence_health || "--", cls: "bg-muted text-muted-foreground border-border" };
                        const valueCfg = VALUE_BADGE[a.value_potential] || VALUE_BADGE.Low;
                        // Compute next due
                        const cadenceDays = getEffectiveCadence(a);
                        let nextDueStr = "--";
                        if (a.last_touchpoint_at) {
                          const nextMs = new Date(a.last_touchpoint_at).getTime() + cadenceDays * 86400000;
                          const daysUntil = Math.round((nextMs - Date.now()) / 86400000);
                          nextDueStr = daysUntil <= 0 ? `${Math.abs(daysUntil)}d overdue` : `in ${daysUntil}d`;
                        }
                        // Find last touchpoint for type icon
                        const lastTp = touchpoints.find(tp => tp.agent_id === a.id);
                        const lastTpType = lastTp ? (tpTypeMap[lastTp.touchpoint_type_id] || tpTypeMap[lastTp.touchpoint_type_name]) : null;
                        const LastTpIcon = lastTpType?.icon_name ? (ICON_MAP[lastTpType.icon_name] || null) : null;

                        return (
                          <tr key={a.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors group">
                            <td className="py-2 pr-3">
                              <Link
                                to={createPageUrl(`PersonDetails?id=${a.id}`)}
                                className="text-xs font-medium hover:underline"
                              >
                                {a.name || "Unknown"}
                              </Link>
                              {agencyName && (
                                <p className="text-[10px] text-muted-foreground truncate max-w-[140px]">{agencyName}</p>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              <WarmthScoreBadge score={a.warmth_score} trend={a.warmth_trend} size="sm" />
                            </td>
                            <td className="py-2 pr-3">
                              <Badge className={cn("text-[10px] px-1.5 py-0 border whitespace-nowrap", cadenceCfg.cls)}>
                                {cadenceCfg.label}
                              </Badge>
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1.5">
                                {LastTpIcon && <LastTpIcon className="h-3 w-3 text-muted-foreground" />}
                                <span className="text-xs text-muted-foreground whitespace-nowrap">
                                  {fmtDate(a.last_touchpoint_at)}
                                </span>
                              </div>
                            </td>
                            <td className="py-2 pr-3">
                              <span className={cn(
                                "text-xs whitespace-nowrap",
                                nextDueStr.includes("overdue") ? "text-red-600 font-medium" : "text-muted-foreground"
                              )}>
                                {nextDueStr}
                              </span>
                            </td>
                            <td className="py-2 pr-3">
                              <span className="text-xs font-medium">{a.touchpoint_count || 0}</span>
                            </td>
                            <td className="py-2 pr-3">
                              <div className="flex items-center gap-1 flex-wrap">
                                {a.relationship_state && (
                                  <Badge className={cn("text-[10px] px-1.5 py-0 border whitespace-nowrap", STATE_COLORS[a.relationship_state]?.light, STATE_COLORS[a.relationship_state]?.text, STATE_COLORS[a.relationship_state]?.border)}>
                                    {a.relationship_state}
                                  </Badge>
                                )}
                                {a.status && a.relationship_state === "Prospecting" && (
                                  <Badge variant="outline" className={cn("text-[9px] px-1 py-0", STATUS_STYLES[a.status] || "")}>
                                    {a.status}
                                  </Badge>
                                )}
                              </div>
                            </td>
                            <td className="py-2 pr-3">
                              {a.value_potential && (
                                <Badge className={cn("text-[10px] px-1.5 py-0 border whitespace-nowrap", valueCfg.cls)}>
                                  {a.value_potential}
                                </Badge>
                              )}
                            </td>
                            <td className="py-2 pr-3">
                              {a.engagement_type && (
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-[10px] px-1.5 py-0 whitespace-nowrap",
                                    a.engagement_type === "exclusive" ? "border-red-300 text-red-600" : "text-muted-foreground"
                                  )}
                                >
                                  {a.engagement_type === "exclusive" ? "Exclusive" : "Non-Excl"}
                                </Badge>
                              )}
                            </td>
                            <td className="py-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-6 text-[10px] px-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => openLogForAgent(a.id)}
                              >
                                <Zap className="h-3 w-3" />
                                Log
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Show more / less toggle */}
                {pipelineAgents.length > 20 && (
                  <div className="flex justify-center pt-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[11px] gap-1"
                      onClick={() => setShowFullTable(!showFullTable)}
                    >
                      {showFullTable ? (
                        <>Show less <ChevronUp className="h-3 w-3" /></>
                      ) : (
                        <>Show all {pipelineAgents.length} agents <ChevronDown className="h-3 w-3" /></>
                      )}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

        </div>
      </div>

      {/* ── QuickLogTouchpoint Modal ───────────────────────────────────────── */}
      <QuickLogTouchpoint
        open={showLogTouchpoint}
        onClose={() => {
          if (completingTouchpointId) {
            api.entities.Touchpoint.update(completingTouchpointId, {
              completed_at: new Date().toISOString(),
            }).then(() => {
              refetchEntityList("Touchpoint");
            });
            setCompletingTouchpointId(null);
          }
          setShowLogTouchpoint(false);
          setLogTouchpointAgentId(null);
        }}
        preselectedAgentId={logTouchpointAgentId}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// ██  FollowUpGroup — sub-component for Upcoming Follow-Ups
// ═════════════════════════════════════════════════════════════════════════════

function FollowUpGroup({ label, items, isOverdue, onComplete, onSnooze, agencyMap }) {
  if (!items || items.length === 0) return null;

  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <span className={cn(
          "text-[11px] font-semibold uppercase tracking-wider",
          isOverdue ? "text-red-600" : "text-muted-foreground"
        )}>
          {label}
        </span>
        <Badge
          variant={isOverdue ? "destructive" : "secondary"}
          className="text-[9px] px-1.5 py-0 h-4"
        >
          {items.length}
        </Badge>
      </div>
      <div className="space-y-1">
        {items.map(tp => {
          const agent = tp.agent;
          const agencyName = agent?.agency_id ? agencyMap[agent.current_agency_id]?.name : "";
          const tpType = tp.tpType;
          const IconComp = tpType?.icon_name ? (ICON_MAP[tpType.icon_name] || CalendarClock) : CalendarClock;
          const daysLabel = tp.daysUntil < 0
            ? `${Math.abs(tp.daysUntil)}d overdue`
            : tp.daysUntil === 0
              ? "Today"
              : `in ${tp.daysUntil}d`;

          return (
            <div
              key={tp.id}
              className={cn(
                "flex items-center gap-2.5 px-2 py-2 rounded-lg transition-colors group",
                isOverdue ? "bg-red-50/60 hover:bg-red-50" : "hover:bg-muted/50"
              )}
            >
              <IconComp className={cn("h-4 w-4 shrink-0", isOverdue ? "text-red-500" : "text-muted-foreground")} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  {agent ? (
                    <Link
                      to={createPageUrl(`PersonDetails?id=${tp.agent_id}`)}
                      className="text-xs font-medium hover:underline truncate"
                    >
                      {agent.name || "Unknown"}
                    </Link>
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">Unknown agent</span>
                  )}
                  {agencyName && (
                    <span className="text-[10px] text-muted-foreground truncate">{agencyName}</span>
                  )}
                </div>
                {(tp.follow_up_notes || tp.notes) && (
                  <p className="text-[10px] text-muted-foreground truncate">
                    {(tp.follow_up_notes || tp.notes || "").slice(0, 60)}
                  </p>
                )}
              </div>
              {tpType?.name && (
                <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                  {tpType.name}
                </Badge>
              )}
              <span className={cn(
                "text-[10px] font-medium whitespace-nowrap shrink-0",
                isOverdue ? "text-red-600" : "text-muted-foreground"
              )}>
                {daysLabel}
              </span>
              <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  size="sm"
                  variant="default"
                  className="h-6 text-[10px] px-2 gap-1"
                  onClick={() => onComplete(tp)}
                >
                  <Check className="h-3 w-3" />
                  Complete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 text-[10px] px-2 gap-1"
                  onClick={() => onSnooze(tp.id)}
                  title="Snooze to tomorrow"
                >
                  <SkipForward className="h-3 w-3" />
                  Snooze
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

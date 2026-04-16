/**
 * Industry Pulse — Command Center
 * Agent intelligence, event tracking, listings market data, and pulse signals.
 * 5-tab layout: Command Center | Agent Intelligence | Events | Market Data | Signals
 */
import React, { useState, useMemo, useCallback } from "react";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import PulseSignalCard from "@/components/nurturing/PulseSignalCard";
import PulseSignalQuickAdd from "@/components/nurturing/PulseSignalQuickAdd";
import PulseTimeline from "@/components/pulse/PulseTimeline";
import { BarChart, Bar, AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Rss, Plus, Search, TrendingUp, Users, Building2, MapPin, Calendar, Star, Globe,
  ExternalLink, ChevronLeft, ChevronRight, UserPlus, ArrowRight, Activity, AlertTriangle,
  CheckCircle2, Eye, Sparkles, Briefcase, BarChart3, Phone, Mail, X, Filter,
  Clock, Award, Zap, Target, Hash, Home, DollarSign, Link2, Loader2,
  ChevronDown, ChevronUp, Settings2, Trash2, Save, ToggleLeft, ToggleRight, Database
} from "lucide-react";

// ── Constants ───────────────────────────────────────────────────────────────

const EVENT_SOURCES = {
  reinsw: { label: "REINSW", color: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" },
  reb: { label: "REB", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" },
  arec: { label: "AREC", color: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" },
  eventbrite: { label: "Eventbrite", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  manual: { label: "Manual", color: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400" },
};

const EVENT_CATEGORIES = {
  conference: { label: "Conference", color: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400" },
  networking: { label: "Networking", color: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400" },
  training: { label: "Training", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" },
  cpd: { label: "CPD", color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400" },
  awards: { label: "Awards", color: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400" },
  other: { label: "Other", color: "bg-gray-100 text-gray-600 dark:bg-gray-800/30 dark:text-gray-400" },
};

const CHART_COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ec4899", "#06b6d4", "#ef4444", "#84cc16"];

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }); } catch { return "—"; }
}
function fmtShortDate(d) {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "short" }); } catch { return "—"; }
}
function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  return v >= 1000000 ? `$${(v / 1000000).toFixed(1)}M` : v >= 1000 ? `$${Math.round(v / 1000)}K` : `$${v}`;
}

// ── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color, subtitle }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>{value}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
          {subtitle && <p className="text-[9px] text-muted-foreground/60">{subtitle}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Main Component ───────────────────────────────────────────────────────────

export default function IndustryPulse() {
  // Data
  const { data: pulseSignals = [] } = useEntityList("PulseSignal", "-created_at");
  const { data: pulseAgents = [], loading: agentsLoading } = useEntityList("PulseAgent", "-total_listings_active", 5000);
  const { data: pulseEvents = [] } = useEntityList("PulseEvent", "event_date", 200);
  const { data: pulseListings = [] } = useEntityList("PulseListing", "-listed_date", 5000);
  const { data: pulseAgencies = [] } = useEntityList("PulseAgency", "-active_listings", 500);
  const { data: crmAgents = [] } = useEntityList("Agent", "name");
  const { data: crmAgencies = [] } = useEntityList("Agency", "name");
  const { data: projects = [] } = useEntityList("Project", "-shoot_date");
  const { data: pulseMappings = [] } = useEntityList("PulseCrmMapping", "-created_at");
  const { data: pulseTimelineEntries = [] } = useEntityList("PulseTimeline", "-created_at", 500);
  const { data: syncLogs = [] } = useEntityList("PulseSyncLog", "-started_at", 100);
  const { data: sourceConfigs = [] } = useEntityList("PulseSourceConfig", "label");
  const { data: targetSuburbs = [] } = useEntityList("PulseTargetSuburb", "-priority", 500);
  const { data: user } = useCurrentUser();

  const [tab, setTab] = useState("command");
  const [search, setSearch] = useState("");
  const [showAddAgent, setShowAddAgent] = useState(false);
  const [showAddEvent, setShowAddEvent] = useState(false);
  const [showAddListing, setShowAddListing] = useState(false);
  const [showAddSignal, setShowAddSignal] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState(null);
  const [agentFilter, setAgentFilter] = useState("all"); // all, not_in_crm, in_crm, reinsw
  const [agentSort, setAgentSort] = useState({ col: "sales_as_lead", dir: "desc" });
  const [agentColFilters, setAgentColFilters] = useState({ agency: "", suburb: "" });
  const [addToCrmCandidate, setAddToCrmCandidate] = useState(null); // for double-confirm dialog
  const [addToCrmStep, setAddToCrmStep] = useState(1); // 1=preview, 2=confirm
  const [selectedAgency, setSelectedAgency] = useState(null);
  const [agencyFilter, setAgencyFilter] = useState("all");
  const [agencySort, setAgencySort] = useState({ col: "live_agent_count", dir: "desc" });
  const [agencyColFilter, setAgencyColFilter] = useState("");
  const [runningSources, setRunningSources] = useState(new Set());
  const [expandedSource, setExpandedSource] = useState(null);
  const [drillLog, setDrillLog] = useState(null); // sync log for payload modal
  const [drillPayloadTab, setDrillPayloadTab] = useState("rea_agents");
  const [drillPage, setDrillPage] = useState(0);
  const [editingSource, setEditingSource] = useState(null); // source_id being edited
  const [editDraft, setEditDraft] = useState({}); // { max_results: N }
  const [savingConfig, setSavingConfig] = useState(false);
  const [newSuburb, setNewSuburb] = useState("");
  const [suburbSearch, setSuburbSearch] = useState("");
  const [expandedRegions, setExpandedRegions] = useState(new Set());
  const [addingSuburb, setAddingSuburb] = useState(false);
  const [eventStatus, setEventStatus] = useState("all");
  const [marketTimeRange, setMarketTimeRange] = useState("30");
  const [signalLevel, setSignalLevel] = useState("all");
  const [signalStatus, setSignalStatus] = useState("all");

  // ── Stats ───────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 86400000);
    const totalAgents = pulseAgents.length;
    const notInCrm = pulseAgents.filter(a => !a.is_in_crm).length;
    const activeListings = pulseListings.filter(l => l.listing_type === "for_sale").length;
    const avgDom = (() => {
      const withDom = pulseListings.filter(l => l.days_on_market > 0);
      return withDom.length > 0 ? Math.round(withDom.reduce((s, l) => s + l.days_on_market, 0) / withDom.length) : 0;
    })();
    const upcomingEvents = pulseEvents.filter(e => e.event_date && new Date(e.event_date) > now && e.status !== "skipped").length;
    const newSignals = pulseSignals.filter(s => s.status === "new").length;
    const agentMovements = pulseAgents.filter(a => a.agency_changed_at && new Date(a.agency_changed_at) > d30).length;
    // Market share: your projects in last 30d / total listings in last 30d
    const recentProjects = projects.filter(p => p.created_at && new Date(p.created_at) > d30).length;
    const recentListings = pulseListings.filter(l => l.listed_date && new Date(l.listed_date) > d30).length;
    const marketShare = recentListings > 0 ? Math.round((recentProjects / recentListings) * 100) : 0;

    const totalAgencies = pulseAgencies.length;
    const agenciesNotInCrm = pulseAgencies.filter(a => !a.is_in_crm).length;

    return { totalAgents, notInCrm, activeListings, avgDom, upcomingEvents, newSignals, agentMovements, marketShare, recentProjects, recentListings, totalAgencies, agenciesNotInCrm };
  }, [pulseAgents, pulseAgencies, pulseListings, pulseEvents, pulseSignals, projects]);

  // ── Derived data ────────────────────────────────────────────────────────

  // Top agents not in CRM
  const topAgentsNotInCrm = useMemo(() => {
    return pulseAgents.filter(a => !a.is_in_crm).sort((a, b) => (b.total_listings_active || 0) - (a.total_listings_active || 0)).slice(0, 10);
  }, [pulseAgents]);

  // Agent movements (last 30 days)
  const recentMovements = useMemo(() => {
    const d30 = new Date(Date.now() - 30 * 86400000);
    return pulseAgents.filter(a => a.agency_changed_at && new Date(a.agency_changed_at) > d30)
      .sort((a, b) => new Date(b.agency_changed_at) - new Date(a.agency_changed_at)).slice(0, 10);
  }, [pulseAgents]);

  // Upcoming events (next 30 days)
  const upcomingEventsList = useMemo(() => {
    const now = new Date();
    return pulseEvents.filter(e => e.event_date && new Date(e.event_date) > now && e.status !== "skipped")
      .sort((a, b) => new Date(a.event_date) - new Date(b.event_date)).slice(0, 5);
  }, [pulseEvents]);

  // Suburb listing distribution
  const suburbData = useMemo(() => {
    const counts = {};
    pulseListings.filter(l => l.listing_type === "for_sale" && l.suburb).forEach(l => {
      counts[l.suburb] = (counts[l.suburb] || 0) + 1;
    });
    return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([suburb, count]) => ({ suburb, count }));
  }, [pulseListings]);

  // Listings by week (last 12 weeks)
  const weeklyListings = useMemo(() => {
    const weeks = [];
    for (let i = 11; i >= 0; i--) {
      const start = new Date(Date.now() - (i + 1) * 7 * 86400000);
      const end = new Date(Date.now() - i * 7 * 86400000);
      const count = pulseListings.filter(l => l.listed_date && new Date(l.listed_date) >= start && new Date(l.listed_date) < end).length;
      weeks.push({ week: `W${12 - i}`, count });
    }
    return weeks;
  }, [pulseListings]);

  // Conversion funnel
  const funnelData = useMemo(() => {
    const activeClients = crmAgents.filter(a => a.relationship_state === "Active").length;
    const d30 = new Date(Date.now() - 30 * 86400000);
    const bookedThisMonth = projects.filter(p => p.created_at && new Date(p.created_at) > d30).length;
    return [
      { stage: "Territory", count: stats.totalAgents, color: "#94a3b8" },
      { stage: "In CRM", count: crmAgents.length, color: "#3b82f6" },
      { stage: "Active", count: activeClients, color: "#10b981" },
      { stage: "Booked (30d)", count: bookedThisMonth, color: "#8b5cf6" },
    ];
  }, [stats.totalAgents, crmAgents, projects]);

  // Filtered + sorted agents for Agent Intelligence tab
  const filteredAgents = useMemo(() => {
    let result = pulseAgents.filter(a => {
      if (agentFilter === "not_in_crm" && a.is_in_crm) return false;
      if (agentFilter === "in_crm" && !a.is_in_crm) return false;
      if (agentFilter === "reinsw" && !a.reinsw_member) return false;
      if (agentColFilters.agency && !(a.agency_name || "").toLowerCase().includes(agentColFilters.agency.toLowerCase())) return false;
      if (agentColFilters.suburb && !(a.agency_suburb || "").toLowerCase().includes(agentColFilters.suburb.toLowerCase())) return false;
      if (search) {
        const q = search.toLowerCase();
        return (a.full_name || "").toLowerCase().includes(q) ||
               (a.agency_name || "").toLowerCase().includes(q) ||
               (a.email || "").toLowerCase().includes(q) ||
               (a.mobile || "").includes(q) ||
               (a.agency_suburb || "").toLowerCase().includes(q);
      }
      return true;
    });
    // Sort
    const { col, dir } = agentSort;
    result.sort((a, b) => {
      let va = a[col], vb = b[col];
      if (typeof va === "number" && typeof vb === "number") return dir === "desc" ? vb - va : va - vb;
      va = String(va || ""); vb = String(vb || "");
      return dir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
    });
    return result;
  }, [pulseAgents, agentFilter, agentColFilters, search, agentSort]);

  // Filtered + sorted agencies for Agency Intelligence tab
  const filteredAgencies = useMemo(() => {
    // Build a live agent count map (agency name → count) for accurate aggregation
    const agentCountMap = {};
    const agentsByAgency = {};
    for (const a of pulseAgents) {
      const key = (a.agency_name || "").toLowerCase().trim();
      if (!key) continue;
      agentCountMap[key] = (agentCountMap[key] || 0) + 1;
      if (!agentsByAgency[key]) agentsByAgency[key] = [];
      agentsByAgency[key].push(a);
    }

    let result = pulseAgencies.map(ag => {
      const key = (ag.name || "").toLowerCase().trim();
      return { ...ag, live_agent_count: agentCountMap[key] || ag.agent_count || 0, _agents: agentsByAgency[key] || [] };
    });

    result = result.filter(ag => {
      if (agencyFilter === "not_in_crm" && ag.is_in_crm) return false;
      if (agencyFilter === "in_crm" && !ag.is_in_crm) return false;
      if (agencyColFilter && !(ag.suburb || "").toLowerCase().includes(agencyColFilter.toLowerCase())) return false;
      if (search) {
        const q = search.toLowerCase();
        return (ag.name || "").toLowerCase().includes(q) || (ag.suburb || "").toLowerCase().includes(q);
      }
      return true;
    });

    const { col, dir } = agencySort;
    result.sort((a, b) => {
      let va = a[col], vb = b[col];
      if (typeof va === "number" && typeof vb === "number") return dir === "desc" ? vb - va : va - vb;
      va = String(va || ""); vb = String(vb || "");
      return dir === "desc" ? vb.localeCompare(va) : va.localeCompare(vb);
    });
    return result;
  }, [pulseAgencies, pulseAgents, agencyFilter, agencyColFilter, search, agencySort]);

  // Filtered events
  const filteredEvents = useMemo(() => {
    return pulseEvents.filter(e => {
      if (eventStatus !== "all" && e.status !== eventStatus) return false;
      if (search) {
        const q = search.toLowerCase();
        return (e.title || "").toLowerCase().includes(q) || (e.organiser || "").toLowerCase().includes(q);
      }
      return true;
    }).sort((a, b) => new Date(a.event_date || 0) - new Date(b.event_date || 0));
  }, [pulseEvents, eventStatus, search]);

  // Filtered signals
  const filteredSignals = useMemo(() => {
    return pulseSignals.filter(s => {
      if (signalLevel !== "all" && s.level !== signalLevel) return false;
      if (signalStatus !== "all" && s.status !== signalStatus) return false;
      if (search) {
        const q = search.toLowerCase();
        return (s.title || "").toLowerCase().includes(q);
      }
      return true;
    });
  }, [pulseSignals, signalLevel, signalStatus, search]);

  // Top listing agents for Market Data
  const topListingAgents = useMemo(() => {
    const counts = {};
    pulseListings.filter(l => l.listing_type === "for_sale" && l.agent_name).forEach(l => {
      if (!counts[l.agent_name]) counts[l.agent_name] = { name: l.agent_name, agency: l.agency_name, count: 0, isClient: false };
      counts[l.agent_name].count++;
    });
    // Check if agent is in CRM
    const crmNames = new Set(crmAgents.map(a => (a.name || "").toLowerCase()));
    Object.values(counts).forEach(a => { a.isClient = crmNames.has(a.name.toLowerCase()); });
    return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 15);
  }, [pulseListings, crmAgents]);

  // ── CRUD ────────────────────────────────────────────────────────────────

  const addAgent = useCallback(async (data) => {
    await api.entities.PulseAgent.create(data);
    refetchEntityList("PulseAgent");
    toast.success("Agent added to intelligence");
    setShowAddAgent(false);
  }, []);

  const addEvent = useCallback(async (data) => {
    await api.entities.PulseEvent.create(data);
    refetchEntityList("PulseEvent");
    toast.success("Event added");
    setShowAddEvent(false);
  }, []);

  const addListing = useCallback(async (data) => {
    await api.entities.PulseListing.create(data);
    refetchEntityList("PulseListing");
    toast.success("Listing added");
    setShowAddListing(false);
  }, []);

  const updateEvent = useCallback(async (id, data) => {
    await api.entities.PulseEvent.update(id, data);
    refetchEntityList("PulseEvent");
  }, []);

  // Smart dedup: check for existing agent/agency before adding
  const getDeduplicationPreview = useCallback((pulseAgent) => {
    const agentName = (pulseAgent.full_name || "").toLowerCase().trim();
    const agencyName = (pulseAgent.agency_name || "").toLowerCase().trim();
    const mobile = (pulseAgent.mobile || "").replace(/\D/g, "");

    // Check for existing agents (fuzzy name + exact mobile)
    const existingAgentByName = crmAgents.filter(a => {
      const n = (a.name || "").toLowerCase().trim();
      if (n === agentName) return true;
      const pa = agentName.split(/\s+/), pb = n.split(/\s+/);
      return pa.length >= 2 && pb.length >= 2 && pa[0] === pb[0] && pa[pa.length - 1] === pb[pb.length - 1];
    });
    const existingAgentByMobile = mobile ? crmAgents.filter(a => (a.phone || "").replace(/\D/g, "") === mobile) : [];

    // Check for existing agency
    const existingAgency = crmAgencies.find(a => {
      const n = (a.name || "").toLowerCase().trim();
      return n === agencyName || n.includes(agencyName) || agencyName.includes(n);
    });

    // Check pulse_agencies for richer data
    const pulseAgencyData = pulseAgents.length > 0 ? null : null; // TODO: use pulse_agencies when loaded

    return {
      agent: pulseAgent,
      existingAgentByName,
      existingAgentByMobile,
      existingAgency,
      isDuplicate: existingAgentByName.length > 0 || existingAgentByMobile.length > 0,
      agencyExists: !!existingAgency,
    };
  }, [crmAgents, crmAgencies, pulseAgents]);

  const confirmAddToCrm = useCallback(async (pulseAgent, preview) => {
    try {
      // 1. Create or find agency
      let agencyId = null;
      if (pulseAgent.agency_name) {
        if (preview.existingAgency) {
          agencyId = preview.existingAgency.id;
        } else {
          // Create new agency from pulse data with platform IDs
          const newAgency = await api.entities.Agency.create({
            name: pulseAgent.agency_name,
            relationship_state: "Prospecting",
            source: "industry_pulse",
            rea_agency_id: pulseAgent.agency_rea_id || null,
            domain_agency_id: pulseAgent.agency_domain_id || null,
          });
          agencyId = newAgency.id;
        }
      }

      // 2. Create agent with platform IDs
      await api.entities.Agent.create({
        name: pulseAgent.full_name,
        email: pulseAgent.email || null,
        phone: pulseAgent.mobile || pulseAgent.business_phone || null,
        source: "industry_pulse",
        relationship_state: "Prospecting",
        current_agency_id: agencyId,
        rea_agent_id: pulseAgent.rea_agent_id || null,
        domain_agent_id: pulseAgent.domain_agent_id || null,
        notes: [
          pulseAgent.job_title ? `Title: ${pulseAgent.job_title}` : null,
          pulseAgent.years_experience ? `Experience: ${pulseAgent.years_experience} years` : null,
          pulseAgent.sales_as_lead ? `Sales as lead: ${pulseAgent.sales_as_lead}` : null,
          pulseAgent.awards ? `Awards: ${pulseAgent.awards.split("\n")[0]}` : null,
          pulseAgent.rea_profile_url ? `REA: ${pulseAgent.rea_profile_url}` : null,
          pulseAgent.domain_profile_url ? `Domain: ${pulseAgent.domain_profile_url}` : null,
        ].filter(Boolean).join("\n"),
      });

      // 3. Mark pulse agent as in CRM
      await api.entities.PulseAgent.update(pulseAgent.id, { is_in_crm: true, is_prospect: true });

      refetchEntityList("Agent");
      refetchEntityList("Agency");
      refetchEntityList("PulseAgent");
      toast.success(`${pulseAgent.full_name} added to CRM${agencyId && !preview.agencyExists ? ` + ${pulseAgent.agency_name} created` : ""}`);
      setAddToCrmCandidate(null);
      setAddToCrmStep(1);
    } catch (err) {
      toast.error("Failed to add to CRM: " + (err?.message || "unknown"));
    }
  }, []);

  // ── Loading ─────────────────────────────────────────────────────────────

  if (agentsLoading) {
    return (
      <div className="px-4 pt-3 pb-4 lg:px-6 space-y-4">
        <div className="h-8 w-48 bg-muted rounded animate-pulse" />
        <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
          {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-16 bg-muted rounded-xl animate-pulse" />)}
        </div>
        <div className="grid grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-64 bg-muted rounded-lg animate-pulse" />)}
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Rss className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Industry Pulse</h1>
          <Badge variant="outline" className="text-[10px]">Command Center</Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input className="pl-7 h-8 w-48 text-sm" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      </div>

      {/* Stats Strip */}
      <div className="grid grid-cols-4 lg:grid-cols-8 gap-2">
        <StatCard label="Agents Tracked" value={String(stats.totalAgents)} icon={Users} />
        <StatCard label="Not In CRM" value={String(stats.notInCrm)} icon={UserPlus} color={stats.notInCrm > 0 ? "text-amber-600" : undefined} />
        <StatCard label="Active Listings" value={String(stats.activeListings)} icon={Home} color="text-blue-600" />
        <StatCard label="Avg DOM" value={stats.avgDom > 0 ? `${stats.avgDom}d` : "—"} icon={Clock} />
        <StatCard label="Events" value={String(stats.upcomingEvents)} icon={Calendar} color="text-purple-600" />
        <StatCard label="New Signals" value={String(stats.newSignals)} icon={Zap} color={stats.newSignals > 0 ? "text-red-600" : undefined} />
        <StatCard label="Movements" value={String(stats.agentMovements)} icon={ArrowRight} color="text-emerald-600" />
        <StatCard label="Market Share" value={`${stats.marketShare}%`} icon={Target} color="text-primary" subtitle={`${stats.recentProjects}/${stats.recentListings}`} />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="bg-muted/40">
          <TabsTrigger value="command">Command Center</TabsTrigger>
          <TabsTrigger value="agents">Agent Intelligence{stats.notInCrm > 0 && <Badge className="ml-1.5 text-[9px] bg-amber-500 text-white border-0 px-1.5 py-0 rounded-full">{stats.notInCrm}</Badge>}</TabsTrigger>
          <TabsTrigger value="agencies">Agency Intelligence{stats.agenciesNotInCrm > 0 && <Badge className="ml-1.5 text-[9px] bg-blue-500 text-white border-0 px-1.5 py-0 rounded-full">{stats.agenciesNotInCrm}</Badge>}</TabsTrigger>
          <TabsTrigger value="events">Events{stats.upcomingEvents > 0 && <Badge className="ml-1.5 text-[9px] bg-purple-500 text-white border-0 px-1.5 py-0 rounded-full">{stats.upcomingEvents}</Badge>}</TabsTrigger>
          <TabsTrigger value="market">Market Data</TabsTrigger>
          <TabsTrigger value="datasources">Data Sources</TabsTrigger>
          <TabsTrigger value="mappings">Mappings{pulseMappings.filter(m => m.confidence === "suggested").length > 0 && <Badge className="ml-1.5 text-[9px] bg-indigo-500 text-white border-0 px-1.5 py-0 rounded-full">{pulseMappings.filter(m => m.confidence === "suggested").length}</Badge>}</TabsTrigger>
          <TabsTrigger value="signals">Signals{stats.newSignals > 0 && <Badge className="ml-1.5 text-[9px] bg-red-500 text-white border-0 px-1.5 py-0 rounded-full">{stats.newSignals}</Badge>}</TabsTrigger>
        </TabsList>

        {/* ═══ TAB 1: COMMAND CENTER ═══ */}
        <TabsContent value="command" className="mt-3">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Market Pulse — Weekly Listings Trend */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><TrendingUp className="h-4 w-4 text-blue-500" />Market Pulse — Listings/Week</CardTitle>
              </CardHeader>
              <CardContent>
                {weeklyListings.some(w => w.count > 0) ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <AreaChart data={weeklyListings} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="week" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                      <Area type="monotone" dataKey="count" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.15} strokeWidth={2} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground/50">No listing data yet — add listings or connect Apify</div>
                )}
              </CardContent>
            </Card>

            {/* Suburb Distribution */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><MapPin className="h-4 w-4 text-emerald-500" />Listings by Suburb</CardTitle>
              </CardHeader>
              <CardContent>
                {suburbData.length > 0 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={suburbData} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis type="category" dataKey="suburb" tick={{ fontSize: 9 }} width={100} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {suburbData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} fillOpacity={0.7} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground/50">No suburb data</div>
                )}
              </CardContent>
            </Card>

            {/* Top Agents NOT in CRM */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><UserPlus className="h-4 w-4 text-amber-500" />Top Agents Not In Your CRM</CardTitle>
                  {topAgentsNotInCrm.length > 0 && <Badge variant="outline" className="text-[10px]">{stats.notInCrm} total</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                {topAgentsNotInCrm.length > 0 ? (
                  <div className="space-y-1.5 max-h-[250px] overflow-y-auto">
                    {topAgentsNotInCrm.map(a => (
                      <div key={a.id} className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 transition-colors">
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium truncate">{a.full_name}</p>
                          <p className="text-[10px] text-muted-foreground">{a.agency_name || "—"} · {a.agency_suburb || "—"}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-xs tabular-nums text-muted-foreground">{a.total_listings_active || 0} listings</span>
                          <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => addToCrm(a)}>
                            <Plus className="h-3 w-3 mr-0.5" />Add
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground/50">
                    {pulseAgents.length === 0 ? "Add agents from Fair Trading or Apify" : "All tracked agents are in your CRM!"}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Upcoming Events */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><Calendar className="h-4 w-4 text-purple-500" />Upcoming Events</CardTitle>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setShowAddEvent(true)}><Plus className="h-3 w-3 mr-0.5" />Add</Button>
                </div>
              </CardHeader>
              <CardContent>
                {upcomingEventsList.length > 0 ? (
                  <div className="space-y-2">
                    {upcomingEventsList.map(e => (
                      <div key={e.id} className="flex items-start justify-between gap-2 p-2 rounded-md hover:bg-muted/30 transition-colors">
                        <div className="min-w-0">
                          <p className="text-sm font-medium">{e.title}</p>
                          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-muted-foreground">
                            <span>{fmtDate(e.event_date)}</span>
                            {e.venue && <span>· {e.venue}</span>}
                          </div>
                          <div className="flex gap-1 mt-1">
                            {e.source && EVENT_SOURCES[e.source] && <Badge className={cn("text-[8px] px-1 py-0 border-0", EVENT_SOURCES[e.source].color)}>{EVENT_SOURCES[e.source].label}</Badge>}
                            {e.category && EVENT_CATEGORIES[e.category] && <Badge className={cn("text-[8px] px-1 py-0 border-0", EVENT_CATEGORIES[e.category].color)}>{EVENT_CATEGORIES[e.category].label}</Badge>}
                          </div>
                        </div>
                        <Button size="sm" variant={e.status === "attending" ? "default" : "outline"} className="h-6 px-2 text-[10px] shrink-0"
                          onClick={() => updateEvent(e.id, { status: e.status === "attending" ? "upcoming" : "attending" })}>
                          {e.status === "attending" ? "✓ Attending" : "Attend"}
                        </Button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground/50">No upcoming events</div>
                )}
              </CardContent>
            </Card>

            {/* Conversion Funnel — Full Width */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><Target className="h-4 w-4 text-primary" />Your Conversion Funnel</CardTitle>
              </CardHeader>
              <CardContent>
                <ResponsiveContainer width="100%" height={120}>
                  <BarChart data={funnelData} margin={{ top: 5, right: 20, left: 20, bottom: 5 }}>
                    <XAxis dataKey="stage" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {funnelData.map((entry, i) => <Cell key={i} fill={entry.color} fillOpacity={0.8} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            {/* Agent Movements */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><ArrowRight className="h-4 w-4 text-emerald-500" />Agent Movements (30d)</CardTitle>
              </CardHeader>
              <CardContent>
                {recentMovements.length > 0 ? (
                  <div className="space-y-2 max-h-[200px] overflow-y-auto">
                    {recentMovements.map(a => (
                      <div key={a.id} className="text-xs p-2 rounded-md bg-muted/30">
                        <p className="font-medium">{a.full_name}</p>
                        <p className="text-muted-foreground mt-0.5">
                          {a.previous_agency_name || "Unknown"} → <span className="text-foreground font-medium">{a.agency_name}</span>
                        </p>
                        <p className="text-muted-foreground/60 text-[10px]">{fmtDate(a.agency_changed_at)}</p>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-[150px] flex items-center justify-center text-sm text-muted-foreground/50">No movements detected</div>
                )}
              </CardContent>
            </Card>

            {/* Recent Signals */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><Zap className="h-4 w-4 text-red-500" />Recent Signals</CardTitle>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setShowAddSignal(true)}><Plus className="h-3 w-3 mr-0.5" />Add</Button>
                </div>
              </CardHeader>
              <CardContent>
                {pulseSignals.filter(s => s.status === "new").length > 0 ? (
                  <div className="space-y-2 max-h-[200px] overflow-y-auto">
                    {pulseSignals.filter(s => s.status === "new").slice(0, 5).map(s => (
                      <div key={s.id} className="text-xs p-2 rounded-md bg-muted/30">
                        <p className="font-medium">{s.title}</p>
                        <p className="text-muted-foreground mt-0.5 line-clamp-2">{s.description}</p>
                        <div className="flex gap-1 mt-1">
                          <Badge variant="outline" className="text-[8px] px-1 py-0">{s.level}</Badge>
                          <Badge variant="outline" className="text-[8px] px-1 py-0">{s.category}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="h-[150px] flex items-center justify-center text-sm text-muted-foreground/50">No new signals</div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ═══ TAB 2: AGENT INTELLIGENCE ═══ */}
        <TabsContent value="agents" className="mt-3">
          <div className="space-y-3">
            {/* Insight banner */}
            {stats.notInCrm > 0 && (
              <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3 flex items-center gap-3">
                <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
                <p className="text-sm"><span className="font-semibold text-amber-700 dark:text-amber-400">{stats.notInCrm} agents</span> in your territory you don't work with — {filteredAgents.length} showing</p>
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { key: "all", label: "All", count: pulseAgents.length },
                { key: "not_in_crm", label: "Not In CRM", count: stats.notInCrm },
                { key: "in_crm", label: "In CRM", count: pulseAgents.filter(a => a.is_in_crm).length },
                { key: "reinsw", label: "REINSW Members", count: pulseAgents.filter(a => a.reinsw_member).length },
              ].map(f => (
                <button key={f.key} onClick={() => setAgentFilter(f.key)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    agentFilter === f.key ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  {f.label} <span className="tabular-nums">{f.count}</span>
                </button>
              ))}
              {/* Column filters */}
              <Input placeholder="Filter agency..." className="h-7 w-32 text-xs" value={agentColFilters.agency} onChange={e => setAgentColFilters(p => ({ ...p, agency: e.target.value }))} />
              <Input placeholder="Filter suburb..." className="h-7 w-28 text-xs" value={agentColFilters.suburb} onChange={e => setAgentColFilters(p => ({ ...p, suburb: e.target.value }))} />
              {(agentColFilters.agency || agentColFilters.suburb) && (
                <button className="text-[10px] text-muted-foreground hover:text-foreground underline" onClick={() => setAgentColFilters({ agency: "", suburb: "" })}>Clear</button>
              )}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setShowAddAgent(true)}>
                <UserPlus className="h-3.5 w-3.5 mr-1.5" />Add Agent
              </Button>
            </div>

            {/* Sortable agent table */}
            {(() => {
              const SortHeader = ({ col, label, className: cls }) => (
                <th className={cn("px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground cursor-pointer hover:text-foreground select-none", cls)}
                    onClick={() => setAgentSort(prev => prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" })}>
                  <span className="flex items-center gap-1">
                    {label}
                    {agentSort.col === col && <span className="text-primary">{agentSort.dir === "asc" ? "↑" : "↓"}</span>}
                  </span>
                </th>
              );
              return (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <SortHeader col="full_name" label="Agent" />
                        <SortHeader col="agency_name" label="Agency" />
                        <SortHeader col="agency_suburb" label="Suburb" className="hidden md:table-cell" />
                        <SortHeader col="mobile" label="Mobile" className="hidden lg:table-cell" />
                        <SortHeader col="sales_as_lead" label="Sold (12m)" />
                        <SortHeader col="avg_sold_price" label="Avg Price" className="hidden lg:table-cell" />
                        <SortHeader col="reviews_avg" label="Rating" className="hidden md:table-cell" />
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Status</th>
                        <th className="px-3 py-2 w-24"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAgents.length === 0 ? (
                        <tr><td colSpan={10} className="py-12 text-center text-muted-foreground/50">
                          <Users className="h-8 w-8 mx-auto mb-2 opacity-30" />
                          {pulseAgents.length === 0 ? "No agents tracked yet — run a data sync from the Data Sources tab" : "No agents match filters"}
                        </td></tr>
                      ) : filteredAgents.slice(0, 150).map(a => (
                        <tr key={a.id} className="hover:bg-muted/30 border-t cursor-pointer" onClick={() => setSelectedAgent(a)}>
                          <td className="px-3 py-2">
                            <p className="font-medium text-sm">{a.full_name}</p>
                            {a.job_title && <p className="text-[10px] text-muted-foreground">{a.job_title}</p>}
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground">{a.agency_name || "—"}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell">{a.agency_suburb || "—"}</td>
                          <td className="px-3 py-2 text-xs tabular-nums hidden lg:table-cell">{a.mobile || "—"}</td>
                          {/* Sold (12m) with recent sales popover */}
                          <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                            {(() => {
                              const soldCount = a.sales_as_lead || a.total_sold_12m || 0;
                              const recentIds = (() => { try { return typeof a.recent_listing_ids === "string" ? JSON.parse(a.recent_listing_ids) : (a.recent_listing_ids || []); } catch { return []; } })();
                              if (soldCount === 0 && recentIds.length === 0) return <span className="text-xs text-muted-foreground/30">0</span>;
                              return (
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button className="text-xs font-medium tabular-nums text-primary hover:underline cursor-pointer">{soldCount}</button>
                                  </PopoverTrigger>
                                  <PopoverContent side="bottom" align="start" className="w-80 p-3">
                                    <p className="text-xs font-semibold mb-2">{a.full_name} — {soldCount} Sales (12m)</p>
                                    {recentIds.length > 0 && (
                                      <>
                                        <p className="text-[10px] text-muted-foreground mb-1.5">Recent sold properties:</p>
                                        <div className="space-y-1 max-h-48 overflow-y-auto">
                                          {recentIds.map((id, i) => (
                                            <a key={i} href={`https://www.realestate.com.au/property--nsw--${id}`} target="_blank" rel="noopener noreferrer"
                                              className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-muted/50 transition-colors">
                                              <span className="font-mono text-muted-foreground">Listing #{id}</span>
                                              <ExternalLink className="h-3 w-3 text-primary" />
                                            </a>
                                          ))}
                                        </div>
                                      </>
                                    )}
                                    {a.avg_sold_price > 0 && <p className="text-[10px] text-muted-foreground mt-2">Median sold: {fmtPrice(a.avg_sold_price)}</p>}
                                    {a.avg_days_on_market > 0 && <p className="text-[10px] text-muted-foreground">Avg days on market: {a.avg_days_on_market}</p>}
                                    {a.rea_profile_url && (
                                      <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary hover:underline mt-2 block">View full profile on realestate.com.au →</a>
                                    )}
                                  </PopoverContent>
                                </Popover>
                              );
                            })()}
                          </td>
                          <td className="px-3 py-2 text-xs tabular-nums hidden lg:table-cell">{fmtPrice(a.avg_sold_price)}</td>
                          <td className="px-3 py-2 hidden md:table-cell">
                            {(a.reviews_avg || a.rea_rating) > 0 ? (
                              <div className="flex items-center gap-0.5">
                                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                                <span className="text-xs tabular-nums">{Number(a.reviews_avg || a.rea_rating).toFixed(1)}</span>
                                {a.reviews_count > 0 && <span className="text-[9px] text-muted-foreground">({a.reviews_count})</span>}
                              </div>
                            ) : <span className="text-xs text-muted-foreground/30">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            {a.is_in_crm ? (
                              <Badge className="text-[9px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400">In CRM</Badge>
                            ) : (
                              <Badge className="text-[9px] bg-amber-100 text-amber-700 border-0 dark:bg-amber-900/30 dark:text-amber-400">Prospect</Badge>
                            )}
                          </td>
                          <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                            {!a.is_in_crm && (
                              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={() => { setAddToCrmCandidate(a); setAddToCrmStep(1); }}>
                                <Plus className="h-3 w-3 mr-0.5" />Add to CRM
                              </Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredAgents.length > 150 && <div className="text-center text-xs text-muted-foreground py-2 border-t">Showing 150 of {filteredAgents.length} — use filters to narrow</div>}
                </div>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ AGENCY INTELLIGENCE TAB ═══ */}
        <TabsContent value="agencies" className="mt-3">
          <div className="space-y-3">
            {/* Insight banner */}
            {stats.agenciesNotInCrm > 0 && (
              <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3 flex items-center gap-3">
                <Building2 className="h-5 w-5 text-blue-600 shrink-0" />
                <p className="text-sm"><span className="font-semibold text-blue-700 dark:text-blue-400">{stats.agenciesNotInCrm} agencies</span> in your territory you don't work with — {filteredAgencies.length} showing</p>
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              {[
                { key: "all", label: "All", count: pulseAgencies.length },
                { key: "not_in_crm", label: "Not In CRM", count: stats.agenciesNotInCrm },
                { key: "in_crm", label: "In CRM", count: pulseAgencies.filter(a => a.is_in_crm).length },
              ].map(f => (
                <button key={f.key} onClick={() => setAgencyFilter(f.key)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    agencyFilter === f.key ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  {f.label} <span className="tabular-nums">{f.count}</span>
                </button>
              ))}
              <Input placeholder="Filter suburb..." className="h-7 w-32 text-xs" value={agencyColFilter} onChange={e => setAgencyColFilter(e.target.value)} />
              {agencyColFilter && (
                <button className="text-[10px] text-muted-foreground hover:text-foreground underline" onClick={() => setAgencyColFilter("")}>Clear</button>
              )}
            </div>

            {/* Sortable agency table */}
            {(() => {
              const SortHeader = ({ col, label, className: cls }) => (
                <th className={cn("px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground cursor-pointer hover:text-foreground select-none", cls)}
                    onClick={() => setAgencySort(prev => prev.col === col ? { col, dir: prev.dir === "asc" ? "desc" : "asc" } : { col, dir: "desc" })}>
                  <span className="flex items-center gap-1">
                    {label}
                    {agencySort.col === col && <span className="text-primary">{agencySort.dir === "asc" ? "↑" : "↓"}</span>}
                  </span>
                </th>
              );
              return (
                <div className="overflow-x-auto border rounded-lg">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <SortHeader col="name" label="Agency" />
                        <SortHeader col="suburb" label="Suburb" className="hidden md:table-cell" />
                        <SortHeader col="live_agent_count" label="Agents" />
                        <SortHeader col="total_sold_12m" label="Sold (12m)" />
                        <SortHeader col="active_listings" label="Listings" className="hidden md:table-cell" />
                        <SortHeader col="avg_sold_price" label="Avg Sold" className="hidden lg:table-cell" />
                        <SortHeader col="avg_agent_rating" label="Rating" className="hidden lg:table-cell" />
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAgencies.length === 0 ? (
                        <tr><td colSpan={8} className="py-12 text-center text-muted-foreground/50">
                          <Building2 className="h-8 w-8 mx-auto mb-2 opacity-30" />
                          {pulseAgencies.length === 0 ? "No agencies tracked yet — run a listings sync from Data Sources" : "No agencies match filters"}
                        </td></tr>
                      ) : filteredAgencies.slice(0, 150).map(ag => (
                        <tr key={ag.id} className="hover:bg-muted/30 border-t cursor-pointer" onClick={() => setSelectedAgency(ag)}>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-2.5">
                              {ag.logo_url ? (
                                <img src={ag.logo_url} alt="" className="h-7 w-7 rounded object-contain bg-white border shrink-0" />
                              ) : (
                                <div className="h-7 w-7 rounded bg-muted/60 flex items-center justify-center shrink-0"><Building2 className="h-3.5 w-3.5 text-muted-foreground" /></div>
                              )}
                              <div className="min-w-0">
                                <p className="font-medium text-sm truncate">{ag.name}</p>
                                {ag.phone && <p className="text-[10px] text-muted-foreground">{ag.phone}</p>}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell">{ag.suburb || "—"}</td>
                          <td className="px-3 py-2">
                            <span className="text-xs font-medium tabular-nums">{ag.live_agent_count}</span>
                          </td>
                          <td className="px-3 py-2">
                            <span className="text-xs font-medium tabular-nums">{ag.total_sold_12m || (ag._agents || []).reduce((s, a) => s + (a.sales_as_lead || 0), 0) || 0}</span>
                          </td>
                          <td className="px-3 py-2 hidden md:table-cell">
                            <span className="text-xs font-medium tabular-nums">{ag.active_listings || 0}</span>
                          </td>
                          <td className="px-3 py-2 text-xs tabular-nums hidden lg:table-cell">{fmtPrice(ag.avg_sold_price || ag.avg_listing_price)}</td>
                          <td className="px-3 py-2 hidden lg:table-cell">
                            {(ag.avg_agent_rating || (() => { const r = (ag._agents || []).filter(a => a.reviews_avg > 0 || a.rea_rating > 0); return r.length > 0 ? (r.reduce((s, a) => s + (a.reviews_avg || a.rea_rating || 0), 0) / r.length) : 0; })()) > 0 ? (
                              <div className="flex items-center gap-0.5">
                                <Star className="h-3 w-3 fill-amber-400 text-amber-400" />
                                <span className="text-xs tabular-nums">{Number(ag.avg_agent_rating || (() => { const r = (ag._agents || []).filter(a => a.reviews_avg > 0 || a.rea_rating > 0); return r.length > 0 ? (r.reduce((s, a) => s + (a.reviews_avg || a.rea_rating || 0), 0) / r.length) : 0; })()).toFixed(1)}</span>
                              </div>
                            ) : <span className="text-xs text-muted-foreground/30">—</span>}
                          </td>
                          <td className="px-3 py-2">
                            {ag.is_in_crm ? (
                              <Badge className="text-[9px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400">In CRM</Badge>
                            ) : (
                              <Badge className="text-[9px] bg-blue-100 text-blue-700 border-0 dark:bg-blue-900/30 dark:text-blue-400">Prospect</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filteredAgencies.length > 150 && <div className="text-center text-xs text-muted-foreground py-2 border-t">Showing 150 of {filteredAgencies.length} — use filters to narrow</div>}
                </div>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB 3: EVENTS ═══ */}
        <TabsContent value="events" className="mt-3">
          <div className="space-y-3">
            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              {["all", "upcoming", "attending", "attended", "skipped"].map(s => (
                <button key={s} onClick={() => setEventStatus(s)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    eventStatus === s ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  {s === "all" ? "All" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setShowAddEvent(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Add Event
              </Button>
            </div>

            {/* Event list */}
            <div className="space-y-2">
              {filteredEvents.length === 0 ? (
                <Card className="border-dashed border-2"><CardContent className="py-12 text-center">
                  <Calendar className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                  <p className="text-sm text-muted-foreground">No events yet — add REINSW, REB, or AREC events</p>
                </CardContent></Card>
              ) : filteredEvents.map(e => (
                <Card key={e.id} className="hover:shadow-md transition-shadow">
                  <CardContent className="p-4 flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="text-sm font-semibold">{e.title}</h3>
                        {e.source && EVENT_SOURCES[e.source] && <Badge className={cn("text-[9px] px-1.5 py-0 border-0", EVENT_SOURCES[e.source].color)}>{EVENT_SOURCES[e.source].label}</Badge>}
                        {e.category && EVENT_CATEGORIES[e.category] && <Badge className={cn("text-[9px] px-1.5 py-0 border-0", EVENT_CATEGORIES[e.category].color)}>{EVENT_CATEGORIES[e.category].label}</Badge>}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1"><Calendar className="h-3 w-3" />{fmtDate(e.event_date)}</span>
                        {e.venue && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{e.venue}</span>}
                        {e.organiser && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{e.organiser}</span>}
                      </div>
                      {e.description && <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{e.description}</p>}
                      {e.source_url && <a href={e.source_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline mt-1 inline-flex items-center gap-1"><ExternalLink className="h-3 w-3" />Event page</a>}
                    </div>
                    <div className="flex flex-col gap-1.5 shrink-0">
                      {["upcoming", "attending", "attended", "skipped"].map(s => (
                        <Button key={s} size="sm" variant={e.status === s ? "default" : "ghost"} className="h-6 px-2 text-[10px] justify-start"
                          onClick={() => updateEvent(e.id, { status: s })}>
                          {s === "attending" ? "✓ Attending" : s === "attended" ? "✓ Attended" : s === "skipped" ? "✗ Skip" : "Upcoming"}
                        </Button>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        </TabsContent>

        {/* ═══ TAB 4: MARKET DATA ═══ */}
        <TabsContent value="market" className="mt-3">
          <div className="space-y-4">
            {/* Top Listing Agents */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2"><BarChart3 className="h-4 w-4 text-blue-500" />Top Listing Agents</CardTitle>
              </CardHeader>
              <CardContent>
                {topListingAgents.length > 0 ? (
                  <ResponsiveContainer width="100%" height={Math.max(200, topListingAgents.length * 28)}>
                    <BarChart data={topListingAgents} layout="vertical" margin={{ top: 0, right: 30, left: 0, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 9 }} width={130} stroke="hsl(var(--muted-foreground))" />
                      <Tooltip contentStyle={{ backgroundColor: "hsl(var(--popover))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }} />
                      <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                        {topListingAgents.map((a, i) => <Cell key={i} fill={a.isClient ? "#10b981" : "#94a3b8"} fillOpacity={0.7} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-[200px] flex items-center justify-center text-sm text-muted-foreground/50">No listing data — add listings or connect Apify</div>
                )}
                {topListingAgents.length > 0 && (
                  <div className="flex items-center gap-4 mt-2 text-[10px] text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-emerald-500/70" /> Your client</span>
                    <span className="flex items-center gap-1"><span className="w-3 h-3 rounded-sm bg-gray-400/70" /> Not a client</span>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Listings Table */}
            <Card>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2"><Home className="h-4 w-4 text-primary" />Recent Listings</CardTitle>
                  <Button size="sm" variant="outline" onClick={() => setShowAddListing(true)}><Plus className="h-3.5 w-3.5 mr-1" />Add Listing</Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Address</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Suburb</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Price</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden md:table-cell">Agent</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden lg:table-cell">Agency</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden md:table-cell">Listed</th>
                        <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground hidden lg:table-cell">DOM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pulseListings.length === 0 ? (
                        <tr><td colSpan={7} className="py-12 text-center text-muted-foreground/50">
                          <Home className="h-8 w-8 mx-auto mb-2 opacity-30" />
                          No listings yet — add manually or connect Apify
                        </td></tr>
                      ) : pulseListings.slice(0, 50).map(l => {
                        const agentInCrm = crmAgents.some(a => (a.name || "").toLowerCase() === (l.agent_name || "").toLowerCase());
                        return (
                          <tr key={l.id} className={cn("border-t hover:bg-muted/30", agentInCrm && "bg-green-50/30 dark:bg-green-950/10")}>
                            <td className="px-3 py-2 text-xs">{l.address || "—"}</td>
                            <td className="px-3 py-2 text-xs">{l.suburb || "—"}</td>
                            <td className="px-3 py-2 text-xs font-medium tabular-nums">{fmtPrice(l.asking_price || l.sold_price)}</td>
                            <td className="px-3 py-2 text-xs hidden md:table-cell">
                              {l.agent_name || "—"}
                              {agentInCrm && <Badge className="ml-1 text-[8px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400 px-1 py-0">Client</Badge>}
                            </td>
                            <td className="px-3 py-2 text-xs text-muted-foreground hidden lg:table-cell">{l.agency_name || "—"}</td>
                            <td className="px-3 py-2 text-xs text-muted-foreground hidden md:table-cell">{fmtShortDate(l.listed_date)}</td>
                            <td className="px-3 py-2 text-xs tabular-nums hidden lg:table-cell">{l.days_on_market || "—"}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ═══ DATA SOURCES TAB ═══ */}
        <TabsContent value="datasources" className="mt-3">
          <div className="space-y-4">
            {(() => {
              // ── Shared suburb pool ──
              const activeSuburbs = targetSuburbs.filter(s => s.is_active);
              const activeSuburbNames = activeSuburbs.map(s => s.name);
              const regionGroups = {};
              for (const s of targetSuburbs) {
                const r = s.region || "Other";
                if (!regionGroups[r]) regionGroups[r] = [];
                regionGroups[r].push(s);
              }
              const sortedRegions = Object.keys(regionGroups).sort();
              const filteredSuburbs = suburbSearch
                ? targetSuburbs.filter(s => s.name.toLowerCase().includes(suburbSearch.toLowerCase()) || (s.region || "").toLowerCase().includes(suburbSearch.toLowerCase()))
                : null;

              // ── Source definitions (pull suburbs from shared pool) ──
              const SOURCES = [
                { source_id: "rea_agents", label: "REA Agent Intelligence", description: "websift/realestateau — Agent profiles, sales data, reviews, awards from realestate.com.au", icon: Users, color: "text-blue-600",
                  defaultMax: 30, schedule: "Weekly (Mon 4am)", scheduleDetail: "All suburbs",
                  runParams: (subs, max) => ({ suburbs: subs, state: "NSW", maxAgentsPerSuburb: max, maxListingsPerSuburb: 0, skipDomain: true, skipDomainAgencies: true, skipListings: true }) },
                { source_id: "domain_agents", label: "Domain Agent Data", description: "scrapestorm — Agent profiles, sold data, ratings, agency IDs from domain.com.au", icon: Globe, color: "text-purple-600",
                  defaultMax: 30, schedule: "Weekly (Wed 4am)", scheduleDetail: "All suburbs",
                  runParams: (subs, max) => ({ suburbs: subs, state: "NSW", maxAgentsPerSuburb: max, maxListingsPerSuburb: 0, skipDomain: false, skipDomainAgencies: true, skipListings: true }) },
                { source_id: "domain_agencies", label: "Domain Agency Intelligence", description: "scrapestorm — Agency profiles, agent rosters, listings counts from domain.com.au", icon: Building2, color: "text-indigo-600",
                  defaultMax: 50, schedule: "Bi-weekly (1st & 15th)", scheduleDetail: "All suburbs",
                  runParams: (subs, max) => ({ suburbs: subs, state: "NSW", maxAgentsPerSuburb: 0, maxAgenciesPerSuburb: max, maxListingsPerSuburb: 0, skipDomain: true, skipDomainAgencies: false, skipListings: true }) },
                { source_id: "rea_listings", label: "REA Listings Market Data", description: "azzouzana — Active listings with agent/agency details from realestate.com.au", icon: Home, color: "text-green-600",
                  defaultMax: 20, schedule: "2x daily (6am, 2pm)", scheduleDetail: "High-priority suburbs + weekly full sweep",
                  runParams: (subs, max) => ({ suburbs: subs, state: "NSW", maxAgentsPerSuburb: 0, maxListingsPerSuburb: max, skipDomain: true, skipDomainAgencies: true, skipListings: false }) },
              ].map(s => {
                const db = sourceConfigs.find(c => c.source_id === s.source_id);
                return { ...s,
                  max_results_per_suburb: db?.max_results_per_suburb ?? s.defaultMax,
                  is_enabled: db?.is_enabled ?? true,
                  _dbId: db?.id || null,
                };
              });

              // Batch suburbs into chunks to avoid edge function timeouts.
              // Each chunk runs as a separate invocation (~10 suburbs per batch).
              const SUBURB_BATCH_SIZE = 10;

              const runSource = async (source) => {
                if (!source.is_enabled || activeSuburbNames.length === 0) return;
                setRunningSources(prev => new Set([...prev, source.source_id]));
                try {
                  const batches = [];
                  for (let i = 0; i < activeSuburbNames.length; i += SUBURB_BATCH_SIZE) {
                    batches.push(activeSuburbNames.slice(i, i + SUBURB_BATCH_SIZE));
                  }
                  toast.info(`Running ${source.label} — ${batches.length} batch${batches.length > 1 ? "es" : ""} (${activeSuburbNames.length} suburbs)...`);

                  let totalAgents = 0, totalAgencies = 0, totalListings = 0;
                  for (let b = 0; b < batches.length; b++) {
                    const batch = batches[b];
                    if (batches.length > 1) toast.info(`${source.label}: batch ${b + 1}/${batches.length} (${batch.join(", ").substring(0, 60)}...)`);
                    const params = {
                      ...source.runParams(batch, source.max_results_per_suburb),
                      source_id: source.source_id,
                      source_label: source.label,
                      triggered_by: user?.id || null,
                      triggered_by_name: user?.full_name || null,
                    };
                    const result = await api.functions.invoke("pulseDataSync", params);
                    const d = result.data || {};
                    totalAgents += d.agents_merged || 0;
                    totalAgencies += d.agencies_extracted || 0;
                    totalListings += d.listings_stored || 0;
                  }
                  refetchEntityList("PulseAgent"); refetchEntityList("PulseListing"); refetchEntityList("PulseAgency");
                  refetchEntityList("PulseSyncLog"); refetchEntityList("PulseTimeline"); refetchEntityList("PulseCrmMapping");
                  toast.success(`${source.label}: ${totalAgents} agents, ${totalAgencies} agencies, ${totalListings} listings`);
                } catch (err) {
                  toast.error(`${source.label} failed: ${err?.message || "unknown"}`);
                } finally {
                  setRunningSources(prev => { const next = new Set(prev); next.delete(source.source_id); return next; });
                }
              };

              const saveSourceConfig = async (source) => {
                setSavingConfig(true);
                try {
                  const payload = {
                    source_id: source.source_id,
                    label: source.label,
                    max_results_per_suburb: editDraft.max_results ?? source.max_results_per_suburb,
                    is_enabled: editDraft.is_enabled ?? source.is_enabled,
                  };
                  if (source._dbId) {
                    await api.entities.PulseSourceConfig.update(source._dbId, payload);
                  } else {
                    await api.entities.PulseSourceConfig.create(payload);
                  }
                  refetchEntityList("PulseSourceConfig");
                  toast.success(`${source.label} config saved`);
                  setEditingSource(null); setEditDraft({});
                } catch (err) { toast.error(`Save failed: ${err?.message || "unknown"}`); }
                finally { setSavingConfig(false); }
              };

              const toggleSuburb = async (suburb) => {
                try {
                  await api.entities.PulseTargetSuburb.update(suburb.id, { is_active: !suburb.is_active });
                  refetchEntityList("PulseTargetSuburb");
                } catch (err) { toast.error(`Toggle failed: ${err?.message}`); }
              };

              const toggleRegion = async (region, active) => {
                try {
                  const subs = regionGroups[region] || [];
                  for (const s of subs) {
                    if (s.is_active !== active) await api.entities.PulseTargetSuburb.update(s.id, { is_active: active });
                  }
                  refetchEntityList("PulseTargetSuburb");
                  toast.success(`${region}: ${active ? "enabled" : "disabled"} ${subs.length} suburbs`);
                } catch (err) { toast.error(`Toggle failed: ${err?.message}`); }
              };

              const addSuburb = async () => {
                const name = newSuburb.trim();
                if (!name) return;
                setAddingSuburb(true);
                try {
                  await api.entities.PulseTargetSuburb.create({ name, state: "NSW", is_active: true, priority: 5 });
                  refetchEntityList("PulseTargetSuburb");
                  setNewSuburb("");
                  toast.success(`Added ${name}`);
                } catch (err) { toast.error(`Add failed: ${err?.message}`); }
                finally { setAddingSuburb(false); }
              };

              const removeSuburb = async (suburb) => {
                try {
                  await api.entities.PulseTargetSuburb.delete(suburb.id);
                  refetchEntityList("PulseTargetSuburb");
                } catch (err) { toast.error(`Remove failed: ${err?.message}`); }
              };

              // Sync logs grouped by source
              const logsBySource = {};
              for (const log of syncLogs) {
                const sid = log.source_id || log.sync_type || "full_sweep";
                if (!logsBySource[sid]) logsBySource[sid] = [];
                logsBySource[sid].push(log);
              }

              return (
                <div className="space-y-3">
                  {/* ═══ TARGET SUBURBS POOL ═══ */}
                  <Card>
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                          <MapPin className="h-4 w-4 text-primary" />Target Suburbs
                          <Badge variant="outline" className="text-[9px] ml-1">{activeSuburbs.length} active / {targetSuburbs.length} total</Badge>
                        </h3>
                        <div className="flex items-center gap-2">
                          <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                            <Input className="h-7 w-40 text-xs pl-7" placeholder="Search suburbs..." value={suburbSearch} onChange={e => setSuburbSearch(e.target.value)} />
                          </div>
                        </div>
                      </div>

                      {/* Add suburb */}
                      <form className="flex items-center gap-2 mb-3" onSubmit={e => { e.preventDefault(); addSuburb(); }}>
                        <Input className="h-7 text-xs flex-1" placeholder="Add suburb (e.g. Rhodes, Wolli Creek...)" value={newSuburb} onChange={e => setNewSuburb(e.target.value)} />
                        <Button type="submit" size="sm" variant="outline" className="h-7 text-xs" disabled={!newSuburb.trim() || addingSuburb}>
                          {addingSuburb ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3 mr-1" />}Add
                        </Button>
                      </form>

                      {/* Search results */}
                      {filteredSuburbs ? (
                        <div className="flex items-center gap-1.5 flex-wrap max-h-[200px] overflow-y-auto">
                          {filteredSuburbs.length === 0 && <p className="text-xs text-muted-foreground/50 py-2">No suburbs match "{suburbSearch}"</p>}
                          {filteredSuburbs.map(s => (
                            <Badge key={s.id} variant={s.is_active ? "default" : "outline"}
                              className={cn("text-[10px] px-1.5 py-0.5 cursor-pointer gap-1 select-none transition-colors",
                                s.is_active ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20" : "text-muted-foreground hover:bg-muted")}
                              onClick={() => toggleSuburb(s)}>
                              {s.name}
                              <span className="text-[8px] opacity-50">{s.region}</span>
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        /* Region groups */
                        <div className="space-y-1">
                          {sortedRegions.map(region => {
                            const subs = regionGroups[region];
                            const activeCount = subs.filter(s => s.is_active).length;
                            const isOpen = expandedRegions.has(region);
                            return (
                              <div key={region} className="border rounded-lg">
                                <button className="w-full flex items-center justify-between px-3 py-1.5 hover:bg-muted/30 text-left"
                                  onClick={() => setExpandedRegions(prev => { const next = new Set(prev); next.has(region) ? next.delete(region) : next.add(region); return next; })}>
                                  <div className="flex items-center gap-2">
                                    {isOpen ? <ChevronDown className="h-3 w-3 text-muted-foreground" /> : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
                                    <span className="text-xs font-medium">{region}</span>
                                    <Badge variant="outline" className={cn("text-[9px] py-0", activeCount === subs.length ? "text-green-600 border-green-200" : activeCount === 0 ? "text-muted-foreground" : "text-amber-600 border-amber-200")}>
                                      {activeCount}/{subs.length}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    {activeCount < subs.length && (
                                      <button className="text-[9px] text-primary hover:underline px-1" onClick={e => { e.stopPropagation(); toggleRegion(region, true); }}>Enable all</button>
                                    )}
                                    {activeCount > 0 && (
                                      <button className="text-[9px] text-muted-foreground hover:underline px-1" onClick={e => { e.stopPropagation(); toggleRegion(region, false); }}>Disable all</button>
                                    )}
                                  </div>
                                </button>
                                {isOpen && (
                                  <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
                                    {subs.sort((a, b) => (b.priority || 0) - (a.priority || 0)).map(s => (
                                      <Badge key={s.id} variant={s.is_active ? "default" : "outline"}
                                        className={cn("text-[10px] px-1.5 py-0.5 cursor-pointer gap-1 select-none transition-colors group",
                                          s.is_active ? "bg-primary/10 text-primary border-primary/20 hover:bg-primary/20" : "text-muted-foreground hover:bg-muted")}
                                        onClick={() => toggleSuburb(s)}>
                                        {s.name}
                                        <button className="opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity" onClick={e => { e.stopPropagation(); removeSuburb(s); }}>
                                          <X className="h-2.5 w-2.5" />
                                        </button>
                                      </Badge>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </CardContent>
                  </Card>

                  {/* ═══ SOURCE CARDS ═══ */}
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold flex items-center gap-2"><Database className="h-4 w-4 text-primary" />Scrapers</h3>
                    <Button size="sm" variant="outline" onClick={async () => {
                      for (const s of SOURCES.filter(s => s.is_enabled)) await runSource(s);
                    }} disabled={runningSources.size > 0 || activeSuburbNames.length === 0}>
                      {runningSources.size > 0 ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Running...</> : <><Zap className="h-3.5 w-3.5 mr-1.5" />Run All ({activeSuburbs.length} suburbs)</>}
                    </Button>
                  </div>

                  {SOURCES.map(source => {
                    const isRunning = runningSources.has(source.source_id);
                    const isExpanded = expandedSource === source.source_id;
                    const isEditing = editingSource === source.source_id;
                    const Icon = source.icon;
                    const sourceLogs = logsBySource[source.source_id] || logsBySource.full_sweep || [];
                    const lastSync = sourceLogs[0];
                    const currentMax = isEditing ? (editDraft.max_results ?? source.max_results_per_suburb) : source.max_results_per_suburb;
                    const currentEnabled = isEditing ? (editDraft.is_enabled ?? source.is_enabled) : source.is_enabled;

                    return (
                      <Card key={source.source_id} className={cn(!currentEnabled && "opacity-60")}>
                        <CardContent className="p-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex items-start gap-3 min-w-0 flex-1">
                              <div className="p-2 rounded-lg bg-muted/60 shrink-0">
                                <Icon className={cn("h-5 w-5", source.color)} />
                              </div>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <h4 className="text-sm font-semibold">{source.label}</h4>
                                  {!currentEnabled && <Badge variant="outline" className="text-[9px] text-muted-foreground border-muted">Disabled</Badge>}
                                </div>
                                <p className="text-xs text-muted-foreground mt-0.5">{source.description}</p>
                                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                  <Badge variant="outline" className="text-[9px] px-1.5 py-0"><MapPin className="h-2.5 w-2.5 mr-0.5" />{activeSuburbs.length} suburbs</Badge>
                                  {isEditing ? (
                                    <div className="flex items-center gap-2">
                                      <label className="text-[10px] text-muted-foreground">Max/suburb:</label>
                                      <Input type="number" min={1} max={100} className="h-5 w-14 text-[10px] px-1.5" value={currentMax} onChange={e => setEditDraft(d => ({ ...d, max_results: parseInt(e.target.value) || 1 }))} />
                                      <button className="flex items-center gap-1 text-[10px]" onClick={() => setEditDraft(d => ({ ...d, is_enabled: !currentEnabled }))}>
                                        {currentEnabled ? <ToggleRight className="h-3.5 w-3.5 text-green-500" /> : <ToggleLeft className="h-3.5 w-3.5 text-muted-foreground" />}
                                      </button>
                                    </div>
                                  ) : (
                                    <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">Max {source.max_results_per_suburb}/suburb</Badge>
                                  )}
                                  {source.schedule && <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-emerald-600 border-emerald-200 dark:text-emerald-400 dark:border-emerald-800"><Clock className="h-2.5 w-2.5 mr-0.5" />{source.schedule}</Badge>}
                                </div>
                                {source.scheduleDetail && <p className="text-[9px] text-muted-foreground/60 mt-0.5">Auto: {source.scheduleDetail}</p>}
                              </div>
                            </div>
                            <div className="flex flex-col items-end gap-1.5 shrink-0">
                              <div className="flex items-center gap-1">
                                {isEditing ? (
                                  <>
                                    <Button size="sm" variant="default" className="h-7 text-xs" onClick={() => saveSourceConfig(source)} disabled={savingConfig}>
                                      {savingConfig ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : <Save className="h-3 w-3 mr-1" />}Save
                                    </Button>
                                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => { setEditingSource(null); setEditDraft({}); }}>
                                      <X className="h-3 w-3" />
                                    </Button>
                                  </>
                                ) : (
                                  <>
                                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setEditingSource(source.source_id); setEditDraft({ max_results: source.max_results_per_suburb, is_enabled: source.is_enabled }); }}>
                                      <Settings2 className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button size="sm" variant={isRunning ? "default" : "outline"} className="h-7" onClick={() => runSource(source)} disabled={isRunning || !currentEnabled || activeSuburbNames.length === 0}>
                                      {isRunning ? <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Running</> : <><Zap className="h-3 w-3 mr-1" />Run Now</>}
                                    </Button>
                                  </>
                                )}
                              </div>
                              {lastSync && (
                                <span className="text-[9px] text-muted-foreground">
                                  Last: {new Date(lastSync.started_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                                </span>
                              )}
                              {sourceLogs.length > 0 && (
                                <button className="text-[9px] text-primary flex items-center gap-0.5 hover:underline" onClick={() => setExpandedSource(isExpanded ? null : source.source_id)}>
                                  {isExpanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                                  {sourceLogs.length} run{sourceLogs.length !== 1 ? "s" : ""}
                                </button>
                              )}
                            </div>
                          </div>

                          {/* Expandable run history */}
                          {isExpanded && sourceLogs.length > 0 && (
                            <div className="mt-3 pt-3 border-t">
                              <div className="overflow-x-auto">
                                <table className="w-full text-xs">
                                  <thead className="bg-muted/30">
                                    <tr>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">Status</th>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">Records</th>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">Config</th>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">Started</th>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">Duration</th>
                                      <th className="px-2 py-1 text-left font-semibold text-muted-foreground">By</th>
                                      <th className="px-2 py-1 w-16"></th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {sourceLogs.slice(0, 10).map(log => {
                                      const duration = log.completed_at && log.started_at
                                        ? Math.round((new Date(log.completed_at) - new Date(log.started_at)) / 1000)
                                        : null;
                                      const cfg = log.input_config;
                                      const hasPayload = log.raw_payload && (log.raw_payload.rea_agents?.length || log.raw_payload.domain_agents?.length || log.raw_payload.listings?.length);
                                      return (
                                        <tr key={log.id} className="border-t hover:bg-muted/20">
                                          <td className="px-2 py-1.5">
                                            <Badge variant="outline" className={cn("text-[9px]",
                                              log.status === "completed" ? "text-green-600 border-green-200" :
                                              log.status === "running" ? "text-blue-600 border-blue-200" :
                                              "text-red-600 border-red-200"
                                            )}>{log.status}</Badge>
                                          </td>
                                          <td className="px-2 py-1.5 tabular-nums">{log.records_new || 0} new / {log.records_fetched || 0}</td>
                                          <td className="px-2 py-1.5 text-muted-foreground">
                                            {cfg ? <span className="text-[9px]">{(cfg.suburbs || []).length} suburbs, max {cfg.maxAgentsPerSuburb || cfg.maxListingsPerSuburb || "?"}</span> : "—"}
                                          </td>
                                          <td className="px-2 py-1.5">{new Date(log.started_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                                          <td className="px-2 py-1.5 tabular-nums">{duration != null ? `${duration}s` : "—"}</td>
                                          <td className="px-2 py-1.5 text-muted-foreground">{log.triggered_by_name || "—"}</td>
                                          <td className="px-2 py-1.5">
                                            {hasPayload && (
                                              <Button size="sm" variant="ghost" className="h-5 text-[9px] px-1.5" onClick={() => { setDrillLog(log); setDrillPayloadTab("rea_agents"); setDrillPage(0); }}>
                                                <Eye className="h-3 w-3 mr-0.5" />Data
                                              </Button>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}

                  {/* ── Full Sync History ── */}
                  <Card>
                    <CardContent className="p-4">
                      <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Clock className="h-4 w-4 text-primary" />Sync History</h3>
                      {syncLogs.length === 0 ? (
                        <p className="text-xs text-muted-foreground/50 text-center py-6">No syncs recorded yet</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="bg-muted/30">
                              <tr>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Source</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Status</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Records</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Started</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">Duration</th>
                                <th className="px-3 py-1.5 text-left font-semibold text-muted-foreground">By</th>
                                <th className="px-3 py-1.5 w-16"></th>
                              </tr>
                            </thead>
                            <tbody>
                              {syncLogs.slice(0, 30).map(log => {
                                const duration = log.completed_at && log.started_at
                                  ? Math.round((new Date(log.completed_at) - new Date(log.started_at)) / 1000)
                                  : null;
                                const hasPayload = log.raw_payload && (log.raw_payload.rea_agents?.length || log.raw_payload.domain_agents?.length || log.raw_payload.listings?.length);
                                return (
                                  <tr key={log.id} className="border-t hover:bg-muted/20">
                                    <td className="px-3 py-1.5"><span className="font-medium">{log.source_label || log.sync_type || "full_sweep"}</span></td>
                                    <td className="px-3 py-1.5">
                                      <Badge variant="outline" className={cn("text-[9px]",
                                        log.status === "completed" ? "text-green-600 border-green-200" :
                                        log.status === "running" ? "text-blue-600 border-blue-200" :
                                        "text-red-600 border-red-200"
                                      )}>{log.status}</Badge>
                                    </td>
                                    <td className="px-3 py-1.5 tabular-nums">{log.records_new || 0} new / {log.records_fetched || 0}</td>
                                    <td className="px-3 py-1.5">{new Date(log.started_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                                    <td className="px-3 py-1.5 tabular-nums">{duration != null ? `${duration}s` : "—"}</td>
                                    <td className="px-3 py-1.5 text-muted-foreground">{log.triggered_by_name || "—"}</td>
                                    <td className="px-3 py-1.5">
                                      {hasPayload && (
                                        <Button size="sm" variant="ghost" className="h-5 text-[9px] px-1.5" onClick={() => { setDrillLog(log); setDrillPayloadTab("rea_agents"); setDrillPage(0); }}>
                                          <Eye className="h-3 w-3 mr-0.5" />View
                                        </Button>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </div>
              );
            })()}

            {/* ═══ RAW PAYLOAD DRILL-THROUGH MODAL ═══ */}
            {drillLog && (() => {
              const payload = drillLog.raw_payload || {};
              const tabs = [
                { key: "rea_agents", label: "REA Agents", data: payload.rea_agents || [] },
                { key: "domain_agents", label: "Domain Agents", data: payload.domain_agents || [] },
                { key: "domain_agencies", label: "Domain Agencies", data: payload.domain_agencies || [] },
                { key: "listings", label: "Listings", data: payload.listings || [] },
              ].filter(t => t.data.length > 0);
              const activeTab = tabs.find(t => t.key === drillPayloadTab) || tabs[0];
              const pageData = activeTab ? activeTab.data.slice(drillPage * 25, (drillPage + 1) * 25) : [];
              const totalPages = activeTab ? Math.ceil(activeTab.data.length / 25) : 0;

              // Extract column keys from first few records (union of all keys)
              const allKeys = new Set();
              (activeTab?.data || []).slice(0, 10).forEach(r => Object.keys(r).forEach(k => allKeys.add(k)));
              // Prioritize useful columns, filter out internal ones
              const SKIP_KEYS = new Set(["_suburb", "_source"]);
              const PRIORITY_KEYS = ["name", "full_name", "agency", "agency_name", "agencyName", "mobile", "phone", "suburb", "address", "email", "rating", "reviewCount", "propertiesForSale", "propertiesSold", "averageSoldPrice", "price", "propertyType", "bedrooms"];
              const cols = [...PRIORITY_KEYS.filter(k => allKeys.has(k)), ...[...allKeys].filter(k => !PRIORITY_KEYS.includes(k) && !SKIP_KEYS.has(k)).sort()];

              const cfg = drillLog.input_config;
              const summary = drillLog.result_summary;
              const duration = drillLog.completed_at && drillLog.started_at
                ? Math.round((new Date(drillLog.completed_at) - new Date(drillLog.started_at)) / 1000)
                : null;

              return (
                <Dialog open onOpenChange={() => setDrillLog(null)}>
                  <DialogContent className="max-w-5xl max-h-[85vh] flex flex-col">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2 text-sm">
                        <Database className="h-4 w-4 text-primary" />
                        {drillLog.source_label || drillLog.sync_type} — Raw Data
                        <Badge variant="outline" className={cn("text-[9px] ml-2",
                          drillLog.status === "completed" ? "text-green-600 border-green-200" : "text-red-600 border-red-200"
                        )}>{drillLog.status}</Badge>
                      </DialogTitle>
                    </DialogHeader>

                    {/* Summary row */}
                    <div className="flex items-center gap-4 text-xs border rounded-lg px-3 py-2 bg-muted/20">
                      <span><strong>{drillLog.records_fetched || 0}</strong> fetched</span>
                      <span><strong>{drillLog.records_new || 0}</strong> new</span>
                      {duration != null && <span>{duration}s</span>}
                      {drillLog.triggered_by_name && <span className="text-muted-foreground">by {drillLog.triggered_by_name}</span>}
                      <span className="text-muted-foreground">{new Date(drillLog.started_at).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                      {drillLog.apify_run_id && <span className="text-muted-foreground text-[9px] ml-auto font-mono">Run: {drillLog.apify_run_id.substring(0, 20)}{drillLog.apify_run_id.length > 20 ? "..." : ""}</span>}
                    </div>

                    {/* Input config */}
                    {cfg && (
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                        <span className="font-medium">Input:</span>
                        <span>Suburbs: {(cfg.suburbs || []).join(", ")}</span>
                        {cfg.maxAgentsPerSuburb > 0 && <span>| Max agents: {cfg.maxAgentsPerSuburb}</span>}
                        {cfg.maxListingsPerSuburb > 0 && <span>| Max listings: {cfg.maxListingsPerSuburb}</span>}
                        <span>| State: {cfg.state || "NSW"}</span>
                      </div>
                    )}

                    {/* Result summary */}
                    {summary && (
                      <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
                        <span className="font-medium">Results:</span>
                        {summary.agents_merged > 0 && <Badge variant="outline" className="text-[9px] py-0">{summary.agents_merged} agents</Badge>}
                        {summary.agencies_extracted > 0 && <Badge variant="outline" className="text-[9px] py-0">{summary.agencies_extracted} agencies</Badge>}
                        {summary.listings_stored > 0 && <Badge variant="outline" className="text-[9px] py-0">{summary.listings_stored} listings</Badge>}
                        {summary.movements_detected > 0 && <Badge variant="outline" className="text-[9px] py-0 text-amber-600">{summary.movements_detected} movements</Badge>}
                        {summary.mappings_created > 0 && <Badge variant="outline" className="text-[9px] py-0 text-blue-600">{summary.mappings_created} mappings</Badge>}
                      </div>
                    )}

                    {/* Dataset tabs */}
                    {tabs.length > 0 && (
                      <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex items-center gap-1 border-b pb-1 mb-2">
                          {tabs.map(t => (
                            <button key={t.key} className={cn("px-2 py-1 text-xs rounded-t", drillPayloadTab === t.key ? "bg-primary text-primary-foreground font-medium" : "text-muted-foreground hover:bg-muted/50")}
                              onClick={() => { setDrillPayloadTab(t.key); setDrillPage(0); }}>
                              {t.label} ({t.data.length})
                            </button>
                          ))}
                        </div>

                        {/* Data table */}
                        <div className="flex-1 overflow-auto border rounded">
                          <table className="w-full text-[10px]">
                            <thead className="bg-muted/30 sticky top-0">
                              <tr>
                                <th className="px-1.5 py-1 text-left font-semibold text-muted-foreground w-8">#</th>
                                {cols.slice(0, 12).map(k => (
                                  <th key={k} className="px-1.5 py-1 text-left font-semibold text-muted-foreground whitespace-nowrap">{k}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {pageData.map((row, i) => (
                                <tr key={i} className="border-t hover:bg-muted/10">
                                  <td className="px-1.5 py-1 tabular-nums text-muted-foreground">{drillPage * 25 + i + 1}</td>
                                  {cols.slice(0, 12).map(k => {
                                    let val = row[k];
                                    if (val == null) val = "";
                                    if (typeof val === "object") val = JSON.stringify(val).substring(0, 60);
                                    if (typeof val === "string" && val.length > 50) val = val.substring(0, 50) + "...";
                                    return <td key={k} className="px-1.5 py-1 whitespace-nowrap max-w-[150px] truncate">{String(val)}</td>;
                                  })}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                            <span>Page {drillPage + 1} of {totalPages} ({activeTab.data.length} records)</span>
                            <div className="flex gap-1">
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={drillPage === 0} onClick={() => setDrillPage(p => p - 1)}>
                                <ChevronLeft className="h-3 w-3" />Prev
                              </Button>
                              <Button size="sm" variant="outline" className="h-6 text-[10px]" disabled={drillPage >= totalPages - 1} onClick={() => setDrillPage(p => p + 1)}>
                                Next<ChevronRight className="h-3 w-3" />
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </DialogContent>
                </Dialog>
              );
            })()}
          </div>
        </TabsContent>

        {/* ═══ TAB 6: MAPPINGS ═══ */}
        <TabsContent value="mappings" className="mt-3">
          <div className="space-y-4">
            {/* Mapping stats */}
            {(() => {
              const agentMappings = pulseMappings.filter(m => m.entity_type !== "agency");
              const agencyMappings = pulseMappings.filter(m => m.entity_type === "agency");
              return (
                <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                  <span className="flex items-center gap-1"><CheckCircle2 className="h-3 w-3 text-green-500" />{pulseMappings.filter(m => m.confidence === "confirmed").length} confirmed</span>
                  <span className="flex items-center gap-1"><AlertTriangle className="h-3 w-3 text-amber-500" />{pulseMappings.filter(m => m.confidence === "suggested").length} suggested</span>
                  <span className="flex items-center gap-1"><Users className="h-3 w-3 text-muted-foreground" />{agentMappings.length} agent links</span>
                  <span className="flex items-center gap-1"><Building2 className="h-3 w-3 text-muted-foreground" />{agencyMappings.length} agency links</span>
                </div>
              );
            })()}

            {/* Mappings list — agents and agencies */}
            {pulseMappings.length === 0 ? (
              <Card className="border-dashed border-2"><CardContent className="py-12 text-center">
                <Link2 className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">No mappings yet. Run a data sync — the engine auto-detects matches by platform IDs, phone number, and name.</p>
              </CardContent></Card>
            ) : (
              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/30">
                    <tr>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground w-14">Type</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Pulse Record</th>
                      <th className="px-3 py-2 text-center text-[11px] font-semibold uppercase text-muted-foreground w-16">Link</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">CRM Record</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Match</th>
                      <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase text-muted-foreground">Status</th>
                      <th className="px-3 py-2 w-32"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pulseMappings.map(m => {
                      const isAgency = m.entity_type === "agency";
                      const pulseRecord = isAgency
                        ? pulseAgencies.find(a => (a.rea_agency_id && a.rea_agency_id === m.rea_id) || (a.domain_agency_id && a.domain_agency_id === m.domain_id))
                        : pulseAgents.find(a => a.rea_agent_id === m.rea_id || (m.domain_id && a.domain_agent_id === m.domain_id));
                      const crmRecord = isAgency
                        ? crmAgencies.find(a => a.id === m.crm_entity_id)
                        : crmAgents.find(a => a.id === m.crm_entity_id);
                      const pulseName = isAgency ? (pulseRecord?.name || `Agency ${m.rea_id || m.domain_id}`) : (pulseRecord?.full_name || `Agent ${m.rea_id || m.domain_id}`);
                      const pulseDetail = isAgency ? (pulseRecord?.suburb || "—") : `${pulseRecord?.agency_name || "—"} · ${pulseRecord?.mobile || "—"}`;
                      const crmName = crmRecord?.name || `CRM ${String(m.crm_entity_id).slice(0, 8)}...`;
                      const crmDetail = isAgency ? (crmRecord?.suburb || crmRecord?.location || "—") : `${crmRecord?.current_agency_name || "—"} · ${crmRecord?.phone || "—"}`;

                      return (
                        <tr key={m.id} className="border-t hover:bg-muted/20">
                          <td className="px-3 py-2">
                            {isAgency ? <Badge variant="outline" className="text-[9px]"><Building2 className="h-2.5 w-2.5 mr-0.5" />Agency</Badge>
                             : <Badge variant="outline" className="text-[9px]"><Users className="h-2.5 w-2.5 mr-0.5" />Agent</Badge>}
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium text-sm">{pulseName}</p>
                            <p className="text-[10px] text-muted-foreground">{pulseDetail}</p>
                          </td>
                          <td className="px-3 py-2 text-center">
                            {m.confidence === "confirmed" ? <CheckCircle2 className="h-5 w-5 text-green-500 mx-auto" />
                             : m.confidence === "suggested" ? <AlertTriangle className="h-5 w-5 text-amber-500 mx-auto" />
                             : <X className="h-5 w-5 text-red-400 mx-auto" />}
                          </td>
                          <td className="px-3 py-2">
                            <p className="font-medium text-sm">{crmName}</p>
                            <p className="text-[10px] text-muted-foreground">{crmDetail}</p>
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className="text-[9px]">{m.match_type}</Badge>
                          </td>
                          <td className="px-3 py-2">
                            {m.confidence === "confirmed" ? <Badge className="text-[9px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400">Confirmed</Badge>
                             : m.confidence === "suggested" ? <Badge className="text-[9px] bg-amber-100 text-amber-700 border-0 dark:bg-amber-900/30 dark:text-amber-400">Suggested</Badge>
                             : <Badge className="text-[9px] bg-red-100 text-red-700 border-0 dark:bg-red-900/30 dark:text-red-400">Rejected</Badge>}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex gap-1">
                              {m.confidence === "suggested" && (
                                <>
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-green-600" onClick={async () => {
                                    await api.entities.PulseCrmMapping.update(m.id, { confidence: "confirmed", confirmed_at: new Date().toISOString(), confirmed_by_name: user?.full_name });
                                    if (!isAgency && pulseRecord) await api.entities.PulseAgent.update(pulseRecord.id, { is_in_crm: true, linked_agent_id: m.crm_entity_id });
                                    api.entities.PulseTimeline.create({ entity_type: m.entity_type || "agent", rea_id: m.rea_id, crm_entity_id: m.crm_entity_id, event_type: "crm_mapped", event_category: "system", title: `${pulseName} mapping confirmed`, description: `Manually confirmed by ${user?.full_name}. Match type: ${m.match_type}.`, source: "manual" }).catch(() => {});
                                    refetchEntityList("PulseCrmMapping"); refetchEntityList("PulseAgent"); refetchEntityList("PulseAgency"); refetchEntityList("PulseTimeline");
                                    toast.success("Mapping confirmed");
                                  }}>Confirm</Button>
                                  <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] text-red-600" onClick={async () => {
                                    await api.entities.PulseCrmMapping.update(m.id, { confidence: "rejected" });
                                    api.entities.PulseTimeline.create({ entity_type: m.entity_type || "agent", rea_id: m.rea_id, event_type: "crm_mapped", event_category: "system", title: `${pulseName} mapping rejected`, description: `Rejected by ${user?.full_name}. Was matched via ${m.match_type}.`, source: "manual" }).catch(() => {});
                                    refetchEntityList("PulseCrmMapping"); refetchEntityList("PulseTimeline");
                                    toast.success("Mapping rejected");
                                  }}>Reject</Button>
                                </>
                              )}
                              {m.confidence === "confirmed" && (
                                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-muted-foreground" onClick={async () => {
                                  await api.entities.PulseCrmMapping.update(m.id, { confidence: "suggested", confirmed_at: null, confirmed_by: null });
                                  refetchEntityList("PulseCrmMapping");
                                  toast.success("Mapping unlinked");
                                }}>Unlink</Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Timeline */}
            <Card>
              <CardContent className="p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-2"><Clock className="h-4 w-4 text-primary" />Intelligence Timeline</h3>
                <PulseTimeline entries={pulseTimelineEntries} showEntityName maxHeight="max-h-[400px]" />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ═══ TAB 5: SIGNALS (existing) ═══ */}
        <TabsContent value="signals" className="mt-3">
          <div className="space-y-3">
            {/* Filters */}
            <div className="flex items-center gap-2 flex-wrap">
              {["all", "industry", "organisation", "person"].map(l => (
                <button key={l} onClick={() => setSignalLevel(l)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    signalLevel === l ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  {l === "all" ? "All Levels" : l.charAt(0).toUpperCase() + l.slice(1)}
                </button>
              ))}
              <span className="text-muted-foreground/30 mx-1">|</span>
              {["all", "new", "acknowledged", "actioned", "dismissed"].map(s => (
                <button key={s} onClick={() => setSignalStatus(s)}
                  className={cn("inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    signalStatus === s ? "bg-primary text-primary-foreground border-primary" : "bg-muted/60 text-muted-foreground border-transparent hover:bg-muted"
                  )}>
                  {s === "all" ? "All Status" : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setShowAddSignal(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Add Signal
              </Button>
            </div>

            {/* Signal feed */}
            {filteredSignals.length === 0 ? (
              <Card className="border-dashed border-2"><CardContent className="py-12 text-center">
                <Zap className="h-8 w-8 mx-auto mb-2 text-muted-foreground/30" />
                <p className="text-sm text-muted-foreground">{pulseSignals.length === 0 ? "No signals yet" : "No signals match filters"}</p>
              </CardContent></Card>
            ) : (
              <div className="space-y-2">
                {filteredSignals.map(signal => (
                  <PulseSignalCard key={signal.id} signal={signal} agents={crmAgents} agencies={crmAgencies} />
                ))}
              </div>
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* ═══ DIALOGS ═══ */}

      {/* Add Agent Dialog */}
      <AddDialog title="Add Agent to Intelligence" open={showAddAgent} onClose={() => setShowAddAgent(false)}
        fields={[
          { key: "full_name", label: "Full Name *", required: true },
          { key: "email", label: "Email" },
          { key: "phone", label: "Phone" },
          { key: "agency_name", label: "Agency" },
          { key: "agency_suburb", label: "Suburb" },
          { key: "licence_number", label: "Licence Number" },
          { key: "source", label: "Source", type: "select", options: [["fair_trading","Fair Trading"],["domain_apify","Domain"],["rea_apify","REA"],["reinsw","REINSW"],["manual","Manual"]] },
        ]}
        defaults={{ source: "manual" }}
        onSave={addAgent}
      />

      {/* Add Event Dialog */}
      <AddDialog title="Add Event" open={showAddEvent} onClose={() => setShowAddEvent(false)}
        fields={[
          { key: "title", label: "Event Name *", required: true },
          { key: "event_date", label: "Date", type: "datetime-local" },
          { key: "venue", label: "Venue" },
          { key: "location", label: "Location" },
          { key: "organiser", label: "Organiser" },
          { key: "source", label: "Source", type: "select", options: [["reinsw","REINSW"],["reb","REB"],["arec","AREC"],["eventbrite","Eventbrite"],["manual","Manual"]] },
          { key: "category", label: "Category", type: "select", options: [["conference","Conference"],["networking","Networking"],["training","Training"],["cpd","CPD"],["awards","Awards"],["other","Other"]] },
          { key: "source_url", label: "Event URL" },
          { key: "description", label: "Description", type: "textarea" },
        ]}
        defaults={{ source: "manual", category: "networking" }}
        onSave={addEvent}
      />

      {/* Add Listing Dialog */}
      <AddDialog title="Add Listing" open={showAddListing} onClose={() => setShowAddListing(false)}
        fields={[
          { key: "address", label: "Address *", required: true },
          { key: "suburb", label: "Suburb" },
          { key: "asking_price", label: "Asking Price", type: "number" },
          { key: "agent_name", label: "Agent Name" },
          { key: "agency_name", label: "Agency" },
          { key: "property_type", label: "Type", type: "select", options: [["house","House"],["apartment","Apartment"],["townhouse","Townhouse"],["land","Land"]] },
          { key: "listing_type", label: "Listing Type", type: "select", options: [["for_sale","For Sale"],["sold","Sold"],["auction","Auction"]] },
          { key: "source", label: "Source", type: "select", options: [["domain","Domain"],["rea","REA"],["manual","Manual"]] },
          { key: "source_url", label: "Listing URL" },
        ]}
        defaults={{ listing_type: "for_sale", source: "manual" }}
        onSave={addListing}
      />

      {/* Add Signal Dialog */}
      {showAddSignal && (
        <PulseSignalQuickAdd
          agents={crmAgents}
          agencies={crmAgencies}
          onClose={() => setShowAddSignal(false)}
        />
      )}

      {/* Agency Detail Slide-out */}
      {selectedAgency && (() => {
        const ag = selectedAgency;
        const suburbsActive = (() => { try { return typeof ag.suburbs_active === "string" ? JSON.parse(ag.suburbs_active) : (ag.suburbs_active || []); } catch { return []; } })();
        const rosterAgents = (ag._agents || []).sort((a, b) => (b.sales_as_lead || b.total_sold_12m || 0) - (a.sales_as_lead || a.total_sold_12m || 0));
        const rosterInCrm = rosterAgents.filter(a => a.is_in_crm).length;
        const totalSold = rosterAgents.reduce((s, a) => s + (a.sales_as_lead || a.total_sold_12m || 0), 0);

        return (
          <div className="fixed inset-y-0 right-0 w-[440px] bg-background border-l shadow-2xl z-50 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b bg-muted/30">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-3 min-w-0 flex-1">
                  {ag.logo_url ? (
                    <img src={ag.logo_url} alt="" className="h-10 w-10 rounded object-contain bg-white border shrink-0" />
                  ) : (
                    <div className="h-10 w-10 rounded bg-muted/60 flex items-center justify-center shrink-0"><Building2 className="h-5 w-5 text-muted-foreground" /></div>
                  )}
                  <div className="min-w-0">
                    <h3 className="font-bold text-lg truncate">{ag.name}</h3>
                    {ag.suburb && <p className="text-xs text-muted-foreground mt-0.5">{ag.suburb}{ag.state ? `, ${ag.state}` : ""}{ag.postcode ? ` ${ag.postcode}` : ""}</p>}
                    <div className="flex items-center gap-2 mt-1.5">
                      {ag.is_in_crm ? <Badge className="text-[9px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400">In CRM</Badge>
                       : <Badge className="text-[9px] bg-blue-100 text-blue-700 border-0 dark:bg-blue-900/30 dark:text-blue-400">Prospect</Badge>}
                      <Badge variant="outline" className="text-[9px]">{ag.live_agent_count} agents tracked</Badge>
                    </div>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedAgency(null)}><X className="h-4 w-4" /></Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
              {/* Source badges */}
              {(() => {
                const Src = ({ s }) => <span className={cn("text-[7px] font-bold uppercase px-1 py-0 rounded ml-1 inline-block leading-relaxed",
                  s === "REA" ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" :
                  s === "Domain" ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400" :
                  "bg-gray-100 text-gray-500")}>{s}</span>;
                const hasDomain = !!ag.domain_agency_id;
                const hasRea = !!ag.rea_agency_id;
                return (<>

              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase">Sources:</span>
                {hasRea && <Badge variant="outline" className="text-[8px] px-1.5 py-0 bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">REA</Badge>}
                {hasDomain && <Badge variant="outline" className="text-[8px] px-1.5 py-0 bg-violet-50 dark:bg-violet-950/20 border-violet-200 text-violet-600">Domain</Badge>}
                {ag.profile_tier && <Badge variant="outline" className="text-[8px]">Tier: {ag.profile_tier}</Badge>}
              </div>

              {/* Contact */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Contact</p>
                {ag.phone && <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={`tel:${ag.phone}`} className="text-primary hover:underline">{ag.phone}</a><Src s={hasDomain ? "Domain" : "REA"} /></div>}
                {ag.email && <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={`mailto:${ag.email}`} className="text-primary hover:underline">{ag.email}</a><Src s="Domain" /></div>}
                {ag.website && <div className="flex items-center gap-2"><Globe className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={ag.website.startsWith("http") ? ag.website : `https://${ag.website}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline truncate">{ag.website}</a><Src s="REA" /></div>}
              </div>

              {/* Location */}
              {ag.address && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Location</p>
                  <div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span>{ag.address}</span><Src s={hasDomain ? "Domain" : "REA"} /></div>
                </div>
              )}

              {/* Key Stats */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Key Metrics</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{ag.live_agent_count}</p><p className="text-[9px] text-muted-foreground">Agents</p><Src s="REA" /></div>
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{ag.active_listings || 0}</p><p className="text-[9px] text-muted-foreground">Active Listings</p><Src s={ag.total_sold_and_auctioned ? "Domain" : "REA"} /></div>
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{fmtPrice(ag.avg_listing_price || ag.avg_sold_price)}</p><p className="text-[9px] text-muted-foreground">Avg Price</p><Src s={ag.avg_listing_price ? "REA" : "REA"} /></div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{ag.total_sold_and_auctioned || totalSold || 0}</p><p className="text-[9px] text-muted-foreground">Total Sold</p><Src s={ag.total_sold_and_auctioned ? "Domain" : "REA"} /></div>
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center"><p className="text-lg font-bold">{rosterInCrm}/{rosterAgents.length}</p><p className="text-[9px] text-muted-foreground">In Your CRM</p></div>
                </div>
              </div>

              {/* Active Suburbs */}
              {suburbsActive.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><MapPin className="h-3 w-3" />Active Suburbs</p>
                  <div className="flex flex-wrap gap-1">
                    {suburbsActive.map(s => <Badge key={s} variant="outline" className="text-[9px] px-1.5 py-0">{s}</Badge>)}
                  </div>
                </div>
              )}

              {/* Profile Link */}
              {ag.rea_profile_url && (
                <div className="space-y-1.5 pt-2 border-t">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Profile</p>
                  <a href={ag.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />realestate.com.au</a>
                </div>
              )}

              {/* Agent Roster */}
              <div className="space-y-2 pt-2 border-t">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><Users className="h-3 w-3" />Agent Roster ({rosterAgents.length})</p>
                {rosterAgents.length === 0 ? (
                  <p className="text-xs text-muted-foreground/50 py-3 text-center">No agents tracked at this agency</p>
                ) : (
                  <div className="border rounded-lg overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Agent</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Sold</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Avg Price</th>
                          <th className="px-2 py-1.5 text-left font-semibold text-muted-foreground">Rating</th>
                          <th className="px-2 py-1.5 w-14"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rosterAgents.slice(0, 50).map(a => (
                          <tr key={a.id} className="border-t hover:bg-muted/20 cursor-pointer" onClick={() => { setSelectedAgency(null); setSelectedAgent(a); }}>
                            <td className="px-2 py-1.5">
                              <p className="font-medium">{a.full_name}</p>
                              {a.job_title && <p className="text-[9px] text-muted-foreground">{a.job_title}</p>}
                            </td>
                            <td className="px-2 py-1.5 tabular-nums">{a.sales_as_lead || a.total_sold_12m || 0}</td>
                            <td className="px-2 py-1.5 tabular-nums">{fmtPrice(a.avg_sold_price)}</td>
                            <td className="px-2 py-1.5">
                              {(a.reviews_avg || a.rea_rating) > 0 ? (
                                <div className="flex items-center gap-0.5">
                                  <Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />
                                  <span className="tabular-nums">{Number(a.reviews_avg || a.rea_rating).toFixed(1)}</span>
                                </div>
                              ) : <span className="text-muted-foreground/30">—</span>}
                            </td>
                            <td className="px-2 py-1.5">
                              {a.is_in_crm ? (
                                <Badge className="text-[8px] bg-green-100 text-green-700 border-0 px-1 py-0">CRM</Badge>
                              ) : (
                                <span className="text-[8px] text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rosterAgents.length > 50 && <div className="text-center text-[10px] text-muted-foreground py-1 border-t">Showing 50 of {rosterAgents.length}</div>}
                  </div>
                )}
              </div>

              {/* Profile Links */}
              {(ag.rea_profile_url || ag.domain_profile_url) && (
                <div className="space-y-1.5 pt-2 border-t">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Platform Profiles</p>
                  <div className="flex gap-3">
                    {ag.rea_profile_url && <a href={ag.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />realestate.com.au<Src s="REA" /></a>}
                    {ag.domain_profile_url && <a href={ag.domain_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />domain.com.au<Src s="Domain" /></a>}
                  </div>
                </div>
              )}

              {/* Platform IDs + Sync */}
              <div className="space-y-1 pt-2 border-t text-[10px] text-muted-foreground">
                <p>Source: {ag.source || "rea_listings"} · Synced: {fmtDate(ag.last_synced_at)}</p>
                {ag.rea_agency_id && <p><Src s="REA" /> Agency ID: {ag.rea_agency_id}</p>}
                {ag.domain_agency_id && <p><Src s="Domain" /> Agency ID: {ag.domain_agency_id}</p>}
              </div>
                </>); /* end Src IIFE */
              })()}
            </div>
          </div>
        );
      })()}

      {/* Agent Detail Slide-out — Rich Intelligence Panel */}
      {selectedAgent && (() => {
        const a = selectedAgent;
        const salesBreakdown = (() => { try { return typeof a.sales_breakdown === "string" ? JSON.parse(a.sales_breakdown) : a.sales_breakdown; } catch { return null; } })();
        const recentListings = (() => { try { return typeof a.recent_listing_ids === "string" ? JSON.parse(a.recent_listing_ids) : a.recent_listing_ids; } catch { return []; } })();
        return (
          <div className="fixed inset-y-0 right-0 w-[420px] bg-background border-l shadow-2xl z-50 flex flex-col overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b bg-muted/30">
              <div className="flex items-start justify-between">
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold text-lg truncate">{a.full_name}</h3>
                  {a.job_title && <p className="text-xs text-muted-foreground mt-0.5">{a.job_title}</p>}
                  <div className="flex items-center gap-2 mt-1.5">
                    {a.is_in_crm ? <Badge className="text-[9px] bg-green-100 text-green-700 border-0 dark:bg-green-900/30 dark:text-green-400">In CRM</Badge>
                     : <Badge className="text-[9px] bg-amber-100 text-amber-700 border-0 dark:bg-amber-900/30 dark:text-amber-400">Prospect</Badge>}
                    {a.years_experience && <Badge variant="outline" className="text-[9px]">{a.years_experience} yrs exp</Badge>}
                    {a.data_integrity_score > 0 && <Badge variant="outline" className="text-[9px]">Quality: {a.data_integrity_score}%</Badge>}
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedAgent(null)}><X className="h-4 w-4" /></Button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
              {/* Source badge helper */}
              {(() => {
                const Src = ({ s }) => <span className={cn("text-[7px] font-bold uppercase px-1 py-0 rounded ml-1 inline-block leading-relaxed",
                  s === "REA" ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400" :
                  s === "Domain" ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400" :
                  "bg-gray-100 text-gray-500")}>{s}</span>;
                const hasDual = (a.source || "").includes("+") || (a.rea_agent_id && a.domain_agent_id);
                return (<>

              {/* Data Sources */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[10px] font-semibold text-muted-foreground uppercase">Sources:</span>
                {a.rea_agent_id && <Badge variant="outline" className="text-[8px] px-1.5 py-0 bg-red-50 dark:bg-red-950/20 border-red-200 text-red-600">REA</Badge>}
                {a.domain_agent_id && <Badge variant="outline" className="text-[8px] px-1.5 py-0 bg-violet-50 dark:bg-violet-950/20 border-violet-200 text-violet-600">Domain</Badge>}
                {a.data_integrity_score > 0 && <Badge variant="outline" className="text-[8px]">Quality: {a.data_integrity_score}%</Badge>}
                {hasDual && <Badge variant="outline" className="text-[8px] text-green-600 border-green-200">Dual-verified</Badge>}
              </div>

              {/* Contact */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Contact</p>
                {a.mobile && <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={`tel:${a.mobile}`} className="text-primary hover:underline">{a.mobile}</a>{a.mobile_validated && <Badge className="text-[8px] bg-green-100 text-green-700 border-0 px-1 py-0">Dual-verified</Badge>}<Src s="REA" /></div>}
                {a.business_phone && a.business_phone !== a.mobile && <div className="flex items-center gap-2"><Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />{a.business_phone} <span className="text-[10px] text-muted-foreground">(office)</span><Src s={a.domain_agent_id ? "Domain" : "REA"} /></div>}
                {a.email && <div className="flex items-center gap-2"><Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><a href={`mailto:${a.email}`} className="text-primary hover:underline">{a.email}</a></div>}
              </div>

              {/* Agency */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Agency</p>
                {a.agency_name && <div className="flex items-center gap-2"><Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" /><span className="font-medium">{a.agency_name}</span>{a.agency_validated && <Badge className="text-[8px] bg-green-100 text-green-700 border-0 px-1 py-0">Dual-verified</Badge>}</div>}
                {a.agency_suburb && <div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />{a.agency_suburb}</div>}
                {(a.agency_rea_id || a.agency_domain_id) && (
                  <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground">
                    {a.agency_rea_id && <span>REA agency #{a.agency_rea_id}</span>}
                    {a.agency_domain_id && <span>Domain agency #{a.agency_domain_id}</span>}
                  </div>
                )}
              </div>

              {/* Performance — side-by-side source comparison */}
              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Performance</p>
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold">{a.sales_as_lead || a.total_sold_12m || 0}</p>
                    <p className="text-[9px] text-muted-foreground">Sales (Lead)</p>
                    <Src s={a.sales_as_lead ? "REA" : a.total_sold_12m ? "Domain" : "REA"} />
                  </div>
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold">{fmtPrice(a.avg_sold_price)}</p>
                    <p className="text-[9px] text-muted-foreground">Median Sold</p>
                    <Src s={a.rea_median_sold_price ? "REA" : "Domain"} />
                  </div>
                  <div className="bg-muted/40 rounded-lg p-2.5 text-center">
                    <p className="text-lg font-bold">{a.avg_days_on_market || "—"}</p>
                    <p className="text-[9px] text-muted-foreground">Avg DOM</p>
                    <Src s={a.rea_median_dom ? "REA" : "Domain"} />
                  </div>
                </div>
                {/* Dual source comparison table */}
                {hasDual && (a.rea_median_sold_price || a.domain_avg_sold_price || a.rea_median_dom || a.domain_avg_dom) && (
                  <div className="border rounded-lg overflow-hidden mt-1">
                    <table className="w-full text-[10px]">
                      <thead className="bg-muted/30">
                        <tr>
                          <th className="px-2 py-1 text-left text-muted-foreground">Metric</th>
                          <th className="px-2 py-1 text-center"><span className="text-red-600">REA</span></th>
                          <th className="px-2 py-1 text-center"><span className="text-violet-600">Domain</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {(a.rea_median_sold_price || a.domain_avg_sold_price) && <tr className="border-t"><td className="px-2 py-1">Sold Price</td><td className="px-2 py-1 text-center tabular-nums">{fmtPrice(a.rea_median_sold_price) || "—"}</td><td className="px-2 py-1 text-center tabular-nums">{fmtPrice(a.domain_avg_sold_price) || "—"}</td></tr>}
                        {(a.rea_median_dom || a.domain_avg_dom) && <tr className="border-t"><td className="px-2 py-1">Days on Market</td><td className="px-2 py-1 text-center tabular-nums">{a.rea_median_dom || "—"}</td><td className="px-2 py-1 text-center tabular-nums">{a.domain_avg_dom || "—"}</td></tr>}
                        {(a.rea_rating || a.domain_rating) && <tr className="border-t"><td className="px-2 py-1">Rating</td><td className="px-2 py-1 text-center tabular-nums">{a.rea_rating ? `${a.rea_rating} (${a.rea_review_count || 0})` : "—"}</td><td className="px-2 py-1 text-center tabular-nums">{a.domain_rating ? `${a.domain_rating} (${a.domain_review_count || 0})` : "—"}</td></tr>}
                        <tr className="border-t"><td className="px-2 py-1">Active Listings</td><td className="px-2 py-1 text-center tabular-nums">{a.total_listings_active || "—"}</td><td className="px-2 py-1 text-center tabular-nums">{a.total_sold_12m || "—"}</td></tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* Reviews */}
              {(a.reviews_count > 0 || a.rea_rating > 0) && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Reviews</p>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <Star className="h-5 w-5 fill-amber-400 text-amber-400" />
                      <span className="text-xl font-bold">{Number(a.reviews_avg || a.rea_rating).toFixed(1)}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{a.reviews_count || 0} reviews</span>
                  </div>
                  {(a.rea_rating || a.domain_rating) && (
                    <div className="flex items-center gap-3 text-[10px]">
                      {a.rea_rating > 0 && <span className="flex items-center gap-1"><Src s="REA" /><Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />{a.rea_rating} ({a.rea_review_count || 0})</span>}
                      {a.domain_rating > 0 && <span className="flex items-center gap-1"><Src s="Domain" /><Star className="h-2.5 w-2.5 fill-amber-400 text-amber-400" />{a.domain_rating} ({a.domain_review_count || 0})</span>}
                    </div>
                  )}
                </div>
              )}

              {/* Sales Breakdown by Property Type */}
              {salesBreakdown && Object.keys(salesBreakdown).length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1">Sales by Property Type<Src s="REA" /></p>
                  <div className="space-y-1">
                    {Object.entries(salesBreakdown).map(([type, data]) => (
                      <div key={type} className="flex items-center justify-between text-xs bg-muted/30 rounded px-2.5 py-1.5">
                        <span className="capitalize font-medium">{type}</span>
                        <span className="text-muted-foreground tabular-nums">{data.count} sold · {fmtPrice(data.medianSoldPrice)} median · {data.medianDaysOnSite}d DOM</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Awards */}
              {a.awards && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><Award className="h-3 w-3" />Awards<Src s="REA" /></p>
                  <div className="text-xs text-muted-foreground whitespace-pre-line bg-amber-50/50 dark:bg-amber-950/10 rounded-lg p-2.5 border border-amber-200/50 dark:border-amber-800/30">{a.awards}</div>
                </div>
              )}

              {/* Speciality Suburbs */}
              {a.speciality_suburbs && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1"><MapPin className="h-3 w-3" />Speciality Areas<Src s="REA" /></p>
                  <p className="text-xs text-muted-foreground">{a.speciality_suburbs}</p>
                </div>
              )}

              {/* Community Involvement */}
              {a.community_involvement && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1">Community<Src s="REA" /></p>
                  <p className="text-xs text-muted-foreground whitespace-pre-line">{a.community_involvement}</p>
                </div>
              )}

              {/* Social Links */}
              {(a.social_facebook || a.social_instagram || a.social_linkedin) && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1">Social<Src s="REA" /></p>
                  <div className="flex gap-3">
                    {a.social_facebook && <a href={a.social_facebook} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Facebook</a>}
                    {a.social_instagram && <a href={`https://instagram.com/${a.social_instagram.replace("@","")}`} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">Instagram</a>}
                    {a.social_linkedin && <a href={a.social_linkedin} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">LinkedIn</a>}
                  </div>
                </div>
              )}

              {/* Profile Links */}
              <div className="space-y-1.5 pt-2 border-t">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase">Platform Profiles</p>
                <div className="flex gap-3">
                  {a.rea_profile_url && <a href={a.rea_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />realestate.com.au<Src s="REA" /></a>}
                  {a.domain_profile_url && <a href={a.domain_profile_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline flex items-center gap-1"><ExternalLink className="h-3 w-3" />domain.com.au<Src s="Domain" /></a>}
                </div>
              </div>

              {/* Recent Listings */}
              {recentListings && recentListings.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase flex items-center gap-1">Recent Listings ({recentListings.length})<Src s="REA" /></p>
                  <div className="flex flex-wrap gap-1">
                    {recentListings.slice(0, 5).map((id, i) => (
                      <a key={i} href={`https://www.realestate.com.au/property--nsw--${id}`} target="_blank" rel="noopener noreferrer"
                        className="text-[10px] px-2 py-0.5 rounded bg-muted hover:bg-muted/80 text-primary">#{id}</a>
                    ))}
                  </div>
                </div>
              )}

              {/* Platform IDs + Integrity */}
              <div className="space-y-1 pt-2 border-t text-[10px] text-muted-foreground">
                <p>Source: {a.source || "manual"} · Synced: {fmtDate(a.last_synced_at)}</p>
                {a.rea_agent_id && <p><Src s="REA" /> Agent ID: {a.rea_agent_id}</p>}
                {a.domain_agent_id && <p><Src s="Domain" /> Agent ID: {a.domain_agent_id}</p>}
              </div>

              {/* Add to CRM button */}
              {!a.is_in_crm && (
                <Button className="w-full" onClick={() => { setAddToCrmCandidate(a); setAddToCrmStep(1); setSelectedAgent(null); }}>
                  <UserPlus className="h-4 w-4 mr-2" />Add to CRM Pipeline
                </Button>
              )}
                </>); /* end Src IIFE */
              })()}
            </div>
          </div>
        );
      })()}

      {/* ═══ ADD TO CRM — Double Confirmation Dialog ═══ */}
      {addToCrmCandidate && (() => {
        const preview = getDeduplicationPreview(addToCrmCandidate);
        const agent = addToCrmCandidate;
        return (
          <Dialog open={true} onOpenChange={() => { setAddToCrmCandidate(null); setAddToCrmStep(1); }}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>{addToCrmStep === 1 ? "Add Agent to CRM — Review" : "Confirm — Are you sure?"}</DialogTitle>
              </DialogHeader>

              {addToCrmStep === 1 ? (
                /* Step 1: Preview what will be created */
                <div className="space-y-4">
                  {/* Dedup warnings */}
                  {preview.isDuplicate && (
                    <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                      <p className="text-sm font-semibold text-red-700 dark:text-red-400 flex items-center gap-1.5"><AlertTriangle className="h-4 w-4" />Potential duplicate detected!</p>
                      {preview.existingAgentByName.map(a => <p key={a.id} className="text-xs text-red-600 dark:text-red-400 mt-1">Name match: <strong>{a.name}</strong> already in CRM</p>)}
                      {preview.existingAgentByMobile.map(a => <p key={a.id} className="text-xs text-red-600 dark:text-red-400 mt-1">Mobile match: <strong>{a.name}</strong> ({a.phone})</p>)}
                    </div>
                  )}

                  {/* What will be created */}
                  <div className="border rounded-lg p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase">New Agent Record</p>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div><span className="text-muted-foreground">Name:</span> <strong>{agent.full_name}</strong></div>
                      <div><span className="text-muted-foreground">Mobile:</span> <strong>{agent.mobile || "—"}</strong></div>
                      <div><span className="text-muted-foreground">Phone:</span> {agent.business_phone || "—"}</div>
                      <div><span className="text-muted-foreground">Email:</span> {agent.email || "Not available"}</div>
                      <div><span className="text-muted-foreground">Source:</span> Industry Pulse</div>
                      <div><span className="text-muted-foreground">Status:</span> Prospecting</div>
                    </div>
                    {(agent.job_title || agent.awards || agent.rea_profile_url) && (
                      <div className="text-[10px] text-muted-foreground mt-2 border-t pt-2">
                        <p className="font-medium mb-1">Notes that will be attached:</p>
                        {agent.job_title && <p>• Title: {agent.job_title}</p>}
                        {agent.years_experience && <p>• Experience: {agent.years_experience} years</p>}
                        {agent.sales_as_lead && <p>• Sales as lead: {agent.sales_as_lead}</p>}
                        {agent.awards && <p>• Awards: {agent.awards.split("\n")[0]}</p>}
                        {agent.rea_profile_url && <p>• REA: {agent.rea_profile_url}</p>}
                      </div>
                    )}
                  </div>

                  {/* Agency handling */}
                  <div className="border rounded-lg p-3 space-y-2">
                    <p className="text-xs font-semibold text-muted-foreground uppercase">Agency / Organisation</p>
                    {preview.agencyExists ? (
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4 text-green-500 shrink-0" />
                        <div className="text-xs">
                          <p><strong>{preview.existingAgency.name}</strong> already exists in CRM</p>
                          <p className="text-muted-foreground">Agent will be linked to this agency</p>
                        </div>
                      </div>
                    ) : agent.agency_name ? (
                      <div className="flex items-center gap-2">
                        <Plus className="h-4 w-4 text-amber-500 shrink-0" />
                        <div className="text-xs">
                          <p><strong>{agent.agency_name}</strong> will be created as a new agency</p>
                          <p className="text-muted-foreground">Agent will be linked to the new agency</p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">No agency — agent will be unlinked</p>
                    )}
                  </div>

                  <DialogFooter>
                    <Button variant="outline" onClick={() => { setAddToCrmCandidate(null); setAddToCrmStep(1); }}>Cancel</Button>
                    <Button onClick={() => setAddToCrmStep(2)} disabled={preview.isDuplicate}>
                      {preview.isDuplicate ? "Cannot add — duplicate exists" : "Next: Confirm"}
                    </Button>
                  </DialogFooter>
                </div>
              ) : (
                /* Step 2: Final confirmation */
                <div className="space-y-4">
                  <div className="bg-blue-50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 text-center">
                    <UserPlus className="h-8 w-8 text-blue-500 mx-auto mb-2" />
                    <p className="text-sm font-semibold">Add <strong>{agent.full_name}</strong> to your CRM?</p>
                    {agent.agency_name && !preview.agencyExists && (
                      <p className="text-xs text-muted-foreground mt-1">This will also create <strong>{agent.agency_name}</strong> as a new agency</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-2">The agent will be set to <strong>Prospecting</strong> status</p>
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAddToCrmStep(1)}>Back</Button>
                    <Button onClick={() => confirmAddToCrm(agent, preview)}>
                      Confirm — Add to CRM
                    </Button>
                  </DialogFooter>
                </div>
              )}
            </DialogContent>
          </Dialog>
        );
      })()}
    </div>
  );
}

// ── Generic Add Dialog ──────────────────────────────────────────────────────

function AddDialog({ title, open, onClose, fields, defaults = {}, onSave }) {
  const [form, setForm] = useState({ ...defaults });
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const required = fields.filter(f => f.required);
    for (const f of required) {
      if (!form[f.key]?.trim()) { toast.error(`${f.label.replace(" *", "")} is required`); return; }
    }
    setSaving(true);
    try {
      const data = { ...form };
      fields.forEach(f => { if (f.type === "number" && data[f.key]) data[f.key] = parseFloat(data[f.key]); });
      await onSave(data);
      setForm({ ...defaults });
    } catch (e) { toast.error(e?.message || "Failed to save"); }
    finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-2">
          {fields.map(f => (
            <div key={f.key}>
              <label className="text-xs font-medium text-muted-foreground">{f.label}</label>
              {f.type === "textarea" ? (
                <Textarea placeholder={f.label} value={form[f.key] || ""} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} rows={3} className="mt-1" />
              ) : f.type === "select" ? (
                <select className="h-9 w-full px-3 text-sm border rounded-md bg-background mt-1" value={form[f.key] || ""} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))}>
                  <option value="">Select...</option>
                  {(f.options || []).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              ) : (
                <Input type={f.type || "text"} placeholder={f.label} value={form[f.key] || ""} onChange={e => setForm(p => ({ ...p, [f.key]: e.target.value }))} className="mt-1" />
              )}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Industry Pulse — Main Shell
 * Thin container: loads all data hooks, computes shared stats,
 * renders header / stats strip / tab bar, delegates to tab components.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import {
  Rss, Search, TrendingUp, Users, UserPlus, Home, Clock, Calendar, Zap,
  ArrowRight, Target, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Tab components ────────────────────────────────────────────────────────────

import PulseCommandCenter from "@/components/pulse/tabs/PulseCommandCenter";
import PulseAgentIntel, { AgentSlideout } from "@/components/pulse/tabs/PulseAgentIntel";
import PulseAgencyIntel, { AgencySlideout } from "@/components/pulse/tabs/PulseAgencyIntel";
import PulseListingsTab, { ListingSlideout } from "@/components/pulse/tabs/PulseListings";
import PulseEventsTab from "@/components/pulse/tabs/PulseEvents";
import PulseMarketData from "@/components/pulse/tabs/PulseMarketData";
import PulseDataSources from "@/components/pulse/tabs/PulseDataSources";
import PulseSuburbs from "@/components/pulse/tabs/PulseSuburbs";
import PulseMappings from "@/components/pulse/tabs/PulseMappings";
import PulseSignals from "@/components/pulse/tabs/PulseSignals";
import PulseTimelineTab from "@/components/pulse/tabs/PulseTimelineTab";

// ── Exported helpers (re-used by tab components) ──────────────────────────────

export function fmtDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

export function fmtShortDate(d) {
  if (!d) return "—";
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return "—";
    return dt.toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
    });
  } catch {
    return "—";
  }
}

export function fmtPrice(v) {
  if (!v || v <= 0) return "—";
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${Math.round(v / 1_000)}K`;
  return `$${v}`;
}

export function normAgencyKey(s) {
  return (s || "").replace(/\s*-\s*/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

// ── StatCard ──────────────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, color, subtitle }) {
  return (
    <Card className="rounded-xl border-0 shadow-sm">
      <CardContent className="p-3 flex items-center gap-3">
        <div className="p-1.5 rounded-lg bg-muted/60">
          <Icon className={cn("h-4 w-4", color || "text-muted-foreground")} />
        </div>
        <div className="min-w-0">
          <p className={cn("text-lg font-bold tabular-nums leading-none", color || "text-foreground")}>
            {value}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{label}</p>
          {subtitle && (
            <p className="text-[9px] text-muted-foreground/60">{subtitle}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function LoadingSkeleton() {
  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3 animate-pulse">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded bg-muted" />
          <div className="h-6 w-36 rounded bg-muted" />
        </div>
        <div className="h-8 w-56 rounded-lg bg-muted" />
      </div>
      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="rounded-xl h-16 bg-muted" />
        ))}
      </div>
      {/* Tab bar */}
      <div className="h-9 rounded-lg bg-muted w-full" />
      {/* Content area */}
      <div className="rounded-xl h-64 bg-muted" />
    </div>
  );
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = [
  { value: "command",  label: "Command",  badgeKey: null },
  { value: "agents",   label: "Agents",   badgeKey: "notInCrm" },
  { value: "agencies", label: "Agencies", badgeKey: "agenciesNotInCrm" },
  { value: "listings", label: "Listings", badgeKey: "totalListings" },
  { value: "events",   label: "Events",   badgeKey: "upcomingEvents" },
  { value: "market",   label: "Market",   badgeKey: null },
  { value: "sources",  label: "Sources",  badgeKey: null },
  { value: "suburbs",  label: "Suburbs",  badgeKey: null },
  { value: "mappings", label: "Mappings", badgeKey: "suggestedMappings" },
  { value: "signals",  label: "Signals",  badgeKey: "newSignals" },
  { value: "timeline", label: "Timeline", badgeKey: null },
];

// Tabs that the URL `?tab=` query param is allowed to deep-link into.
// Limits surface area for typos/links from old emails; defaults to "command".
const VALID_TAB_VALUES = new Set(TABS.map(t => t.value));

// ── Main component ────────────────────────────────────────────────────────────

export default function IndustryPulse() {
  // ── Data hooks (this is the ONLY place useEntityList is called for Pulse) ──
  const { data: pulseAgents = [], loading: agentsLoading } = useEntityList(
    "PulseAgent", "-total_listings_active", 5000
  );
  const { data: pulseAgencies = [], loading: agenciesLoading } = useEntityList("PulseAgency", "-active_listings", 500);
  const { data: pulseListings = [], loading: listingsLoading } = useEntityList("PulseListing", "-created_at", 5000);
  const { data: pulseEvents = [] } = useEntityList("PulseEvent", "event_date", 200);
  const { data: pulseSignals = [] } = useEntityList("PulseSignal", "-created_at");
  const { data: crmAgents = [], loading: crmAgentsLoading } = useEntityList("Agent", "name");
  const { data: crmAgencies = [] } = useEntityList("Agency", "name");
  const { data: projects = [] } = useEntityList("Project", "-shoot_date");
  const { data: pulseMappings = [] } = useEntityList("PulseCrmMapping", "-created_at");
  const { data: pulseTimeline = [] } = useEntityList("PulseTimeline", "-created_at", 500);
  const { data: syncLogs = [] } = useEntityList("PulseSyncLog", "-started_at", 100);
  const { data: sourceConfigs = [] } = useEntityList("PulseSourceConfig", "label");
  const { data: targetSuburbs = [] } = useEntityList("PulseTargetSuburb", "-priority", 500);
  const { data: user } = useCurrentUser();

  // True when any primary data set is still loading
  const isLoading = agentsLoading || agenciesLoading || listingsLoading || crmAgentsLoading;

  // ── UI state ────────────────────────────────────────────────────────────────
  // Tab state is mirrored into the URL's `?tab=` query param so deep-links
  // (e.g. "View full timeline" from the Command Center, bookmarks, support
  // links shared in chat) navigate straight to the intended tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get("tab");
    return t && VALID_TAB_VALUES.has(t) ? t : "command";
  })();
  const [tab, setTabState] = useState(initialTab);

  // Wrapper that updates both local state and the URL (replaceState — no history spam)
  const setTab = useCallback((next) => {
    setTabState(next);
    setSearchParams(prev => {
      const np = new URLSearchParams(prev);
      if (next === "command") np.delete("tab"); // clean URL on default tab
      else np.set("tab", next);
      return np;
    }, { replace: true });
  }, [setSearchParams]);

  // If the user uses browser back/forward, sync tab state with the URL
  useEffect(() => {
    const t = searchParams.get("tab");
    const want = t && VALID_TAB_VALUES.has(t) ? t : "command";
    if (want !== tab) setTabState(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const [search, setSearch] = useState("");
  const [addToCrmFromCommand, setAddToCrmFromCommand] = useState(null);

  // ── Cross-tab drill-through stack ───────────────────────────────────────────
  // Each entry: { type: 'agent' | 'agency' | 'listing', id: string }
  const [entityStack, setEntityStack] = useState([]);
  const currentEntity = entityStack[entityStack.length - 1] || null;

  const openEntity = useCallback((entity) => {
    if (!entity || !entity.type || !entity.id) return;
    // Don't push a duplicate of the current top
    setEntityStack((s) => {
      const top = s[s.length - 1];
      if (top && top.type === entity.type && top.id === entity.id) return s;
      return [...s, entity];
    });
  }, []);

  const popEntity = useCallback(() => {
    setEntityStack((s) => s.slice(0, -1));
  }, []);

  const closeAllEntities = useCallback(() => {
    setEntityStack([]);
  }, []);

  // Handler: CommandCenter "Add" button switches to agents tab and triggers dialog
  const handleAddToCrmFromCommand = useCallback((agent) => {
    setTab("agents");
    setAddToCrmFromCommand(agent);
  }, []);

  // Clear handler so the effect in AgentIntel doesn't re-fire
  const handleClearAddToCrmFromCommand = useCallback(() => {
    setAddToCrmFromCommand(null);
  }, []);

  // Refresh all entity data
  const [refreshing, setRefreshing] = useState(false);
  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([
        refetchEntityList("PulseAgent"),
        refetchEntityList("PulseAgency"),
        refetchEntityList("PulseListing"),
        refetchEntityList("PulseEvent"),
        refetchEntityList("PulseSignal"),
        refetchEntityList("Agent"),
        refetchEntityList("Agency"),
        refetchEntityList("Project"),
        refetchEntityList("PulseCrmMapping"),
        refetchEntityList("PulseTimeline"),
        refetchEntityList("PulseSyncLog"),
        refetchEntityList("PulseSourceConfig"),
        refetchEntityList("PulseTargetSuburb"),
      ]);
    } finally {
      setRefreshing(false);
    }
  }, []);

  // ── Computed stats ───────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 86400000);

    const recentListings = pulseListings.filter(
      (l) => l.listed_date && new Date(l.listed_date) > d30
    ).length;
    const recentProjects = projects.filter(
      (p) => p.created_at && new Date(p.created_at) > d30
    ).length;

    return {
      totalAgents: pulseAgents.length,
      notInCrm: pulseAgents.filter((a) => !a.is_in_crm).length,
      totalAgencies: pulseAgencies.length,
      agenciesNotInCrm: pulseAgencies.filter((a) => !a.is_in_crm).length,
      totalListings: pulseListings.length,
      activeListings: pulseListings.filter((l) => l.listing_type === "for_sale").length,
      rentals: pulseListings.filter((l) => l.listing_type === "for_rent").length,
      sold: pulseListings.filter((l) => l.listing_type === "sold").length,
      avgDom: (() => {
        const w = pulseListings.filter((l) => l.days_on_market > 0);
        return w.length > 0
          ? Math.round(w.reduce((s, l) => s + l.days_on_market, 0) / w.length)
          : 0;
      })(),
      upcomingEvents: pulseEvents.filter(
        (e) => e.event_date && new Date(e.event_date) > now && e.status !== "skipped"
      ).length,
      newSignals: pulseSignals.filter((s) => s.status === "new").length,
      agentMovements: pulseAgents.filter(
        (a) => a.agency_changed_at && new Date(a.agency_changed_at) > d30
      ).length,
      recentProjects,
      recentListings,
      marketShare:
        recentListings > 0 ? Math.round((recentProjects / recentListings) * 100) : 0,
      suggestedMappings: pulseMappings.filter(m => m.confidence === "suggested").length,
    };
  }, [pulseAgents, pulseAgencies, pulseListings, pulseEvents, pulseSignals, projects, pulseMappings]);

  // Deep-link handler — Command Center → Timeline tab
  const handleViewFullTimeline = useCallback(() => {
    setTab("timeline");
  }, [setTab]);

  // ── Shared props spread into every tab ──────────────────────────────────────
  const sharedProps = {
    pulseAgents,
    pulseAgencies,
    pulseListings,
    pulseEvents,
    pulseSignals,
    crmAgents,
    crmAgencies,
    projects,
    pulseMappings,
    pulseTimeline,
    syncLogs,
    sourceConfigs,
    targetSuburbs,
    search,
    stats,
    user,
    onAddToCrm: handleAddToCrmFromCommand,
    addToCrmFromCommand,
    onClearAddToCrmFromCommand: handleClearAddToCrmFromCommand,
    onOpenEntity: openEntity,
    onViewFullTimeline: handleViewFullTimeline,
  };

  // ── Resolve current entity from stack to actual record ────────────────────
  const currentEntityRecord = useMemo(() => {
    if (!currentEntity) return null;
    if (currentEntity.type === "listing")
      return pulseListings.find((l) => l.id === currentEntity.id) || null;
    if (currentEntity.type === "agent")
      return pulseAgents.find((a) => a.id === currentEntity.id) || null;
    if (currentEntity.type === "agency")
      return pulseAgencies.find((a) => a.id === currentEntity.id) || null;
    return null;
  }, [currentEntity, pulseListings, pulseAgents, pulseAgencies]);

  const hasEntityHistory = entityStack.length > 1;

  // ── Early return: loading skeleton ───────────────────────────────────────────
  if (isLoading) return <LoadingSkeleton />;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="px-4 pt-3 pb-4 lg:px-6 space-y-3">

      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div className="flex items-center gap-2">
          <Rss className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold tracking-tight">Industry Pulse</h1>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">
            REA
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search agents, agencies…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs gap-1.5"
            onClick={handleRefreshAll}
            disabled={refreshing}
            title="Refresh all data"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* ── Stats strip ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
        <StatCard
          label="Agents"
          value={stats.totalAgents.toLocaleString()}
          icon={Users}
          color="text-blue-500"
          subtitle={`${stats.notInCrm} not in CRM`}
        />
        <StatCard
          label="Agencies"
          value={stats.totalAgencies.toLocaleString()}
          icon={Target}
          color="text-violet-500"
          subtitle={`${stats.agenciesNotInCrm} not in CRM`}
        />
        <StatCard
          label="For Sale"
          value={stats.activeListings.toLocaleString()}
          icon={Home}
          color="text-emerald-500"
          subtitle={`${stats.sold} sold`}
        />
        <StatCard
          label="Rentals"
          value={stats.rentals.toLocaleString()}
          icon={ArrowRight}
          color="text-cyan-500"
        />
        <StatCard
          label="Avg DOM"
          value={stats.avgDom > 0 ? `${stats.avgDom}d` : "—"}
          icon={Clock}
          color="text-amber-500"
        />
        <StatCard
          label="Events"
          value={stats.upcomingEvents}
          icon={Calendar}
          color="text-rose-500"
          subtitle="upcoming"
        />
        <StatCard
          label="Signals"
          value={stats.newSignals}
          icon={Zap}
          color="text-orange-500"
          subtitle="new"
        />
        <StatCard
          label="Market Share"
          value={stats.marketShare > 0 ? `${stats.marketShare}%` : "—"}
          icon={TrendingUp}
          color="text-green-500"
          subtitle="30-day"
        />
      </div>

      {/* ── Tab bar + content ── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex flex-wrap h-auto gap-0.5 w-full rounded-lg bg-muted p-1">
          {TABS.map(({ value, label, badgeKey }) => {
            const count = badgeKey && stats[badgeKey] > 0 ? stats[badgeKey] : null;
            return (
              <TabsTrigger
                key={value}
                value={value}
                className="relative flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                {label}
                {count !== null && (
                  <Badge
                    variant="secondary"
                    className="h-4 min-w-[1rem] px-1 text-[9px] tabular-nums rounded-full"
                  >
                    {count > 999 ? "999+" : count}
                  </Badge>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="command" className="mt-2">
          <ErrorBoundary>
            <PulseCommandCenter {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="agents" className="mt-2">
          <ErrorBoundary>
            <PulseAgentIntel {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="agencies" className="mt-2">
          <ErrorBoundary>
            <PulseAgencyIntel {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="listings" className="mt-2">
          <ErrorBoundary>
            <PulseListingsTab {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="events" className="mt-2">
          <ErrorBoundary>
            <PulseEventsTab {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="market" className="mt-2">
          <ErrorBoundary>
            <PulseMarketData {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="sources" className="mt-2">
          <ErrorBoundary>
            <PulseDataSources {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="suburbs" className="mt-2">
          <ErrorBoundary>
            <PulseSuburbs />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="mappings" className="mt-2">
          <ErrorBoundary>
            <PulseMappings {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="signals" className="mt-2">
          <ErrorBoundary>
            <PulseSignals {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="timeline" className="mt-2">
          <ErrorBoundary>
            <PulseTimelineTab />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>

      {/* ── Central drill-through dispatcher ── */}
      {currentEntity && currentEntityRecord && (
        <ErrorBoundary>
          {currentEntity.type === "listing" && (
            <ListingSlideout
              listing={currentEntityRecord}
              pulseAgents={pulseAgents}
              pulseAgencies={pulseAgencies}
              onClose={closeAllEntities}
              onOpenEntity={openEntity}
              hasHistory={hasEntityHistory}
              onBack={popEntity}
            />
          )}
          {currentEntity.type === "agent" && (
            <AgentSlideout
              agent={currentEntityRecord}
              pulseAgencies={pulseAgencies}
              pulseListings={pulseListings}
              pulseTimeline={pulseTimeline}
              crmAgents={crmAgents}
              crmAgencies={crmAgencies}
              pulseMappings={pulseMappings}
              onClose={closeAllEntities}
              onAddToCrm={(a) => {
                // Close stack + switch to agents tab + trigger add-to-CRM
                closeAllEntities();
                setTab("agents");
                setAddToCrmFromCommand(a);
              }}
              onOpenEntity={openEntity}
              hasHistory={hasEntityHistory}
              onBack={popEntity}
            />
          )}
          {currentEntity.type === "agency" && (
            <AgencySlideout
              agency={currentEntityRecord}
              pulseAgents={pulseAgents}
              pulseListings={pulseListings}
              pulseTimeline={pulseTimeline}
              crmAgencies={crmAgencies}
              pulseMappings={pulseMappings}
              onClose={closeAllEntities}
              onOpenEntity={openEntity}
              hasHistory={hasEntityHistory}
              onBack={popEntity}
            />
          )}
        </ErrorBoundary>
      )}
    </div>
  );
}

/**
 * Industry Pulse — Main Shell
 * Thin container: loads all data hooks, computes shared stats,
 * renders header / stats strip / tab bar, delegates to tab components.
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import {
  Rss, Search, RefreshCw, Command as CmdIcon, Keyboard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import PulseHeaderStats, { getHomepageDefault } from "@/components/pulse/PulseHeaderStats";
import PulseCommandPalette from "@/components/pulse/PulseCommandPalette";
import PulseShortcutHelp from "@/components/pulse/PulseShortcutHelp";
import {
  useKeyboardShortcuts, useDensity, DensityToggle,
  LoadingSkeleton as ShellLoadingSkeleton, densityWrapperCls,
  PulseShellProvider,
} from "@/components/pulse/pulseShell";
import { useToast } from "@/components/ui/use-toast";

// ── Tab components ────────────────────────────────────────────────────────────

// Stable empty array reference — used by props that previously carried heavy
// lazy-loaded collections. Module-scoped so useMemo deps stay stable and tabs
// don't re-render when the IndustryPulse shell does.
const EMPTY_ARRAY = Object.freeze([]);

import PulseCommandCenter from "@/components/pulse/tabs/PulseCommandCenter";
import PulseAgentIntel, { AgentSlideout } from "@/components/pulse/tabs/PulseAgentIntel";
import PulseAgencyIntel, { AgencySlideout } from "@/components/pulse/tabs/PulseAgencyIntel";
import PulseListingsTab, { ListingSlideout } from "@/components/pulse/tabs/PulseListings";
import PulseEventsTab from "@/components/pulse/tabs/PulseEvents";
import PulseMarketData from "@/components/pulse/tabs/PulseMarketData";
import PulseMarketShare from "@/components/pulse/tabs/PulseMarketShare";
import PulseRetention from "@/components/pulse/tabs/PulseRetention";
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

// ── formatCountShort — QoL #3 ────────────────────────────────────────────────
// Compact number formatting for tab badges + tight UI slots. Under 1000 stays
// as-is ("42"); 1000–9999 uses one decimal ("1.2k"); 10k+ rounds to the nearest
// thousand ("12k"). Mirrors the convention used on GitHub/Twitter badges.
export function formatCountShort(n) {
  if (n === null || n === undefined) return "—";
  const num = Number(n);
  if (!isFinite(num)) return "—";
  if (num < 1000) return String(num);
  if (num < 10000) {
    // One decimal, trim trailing .0 ("1.0k" → "1k")
    const v = (num / 1000).toFixed(1);
    return v.endsWith(".0") ? `${v.slice(0, -2)}k` : `${v}k`;
  }
  if (num < 1_000_000) return `${Math.round(num / 1000)}k`;
  return `${(num / 1_000_000).toFixed(1)}M`;
}

// ── Relative time helper — QoL #4 ────────────────────────────────────────────
function formatRelativeTime(then) {
  if (!then) return "";
  const ms = Date.now() - new Date(then).getTime();
  if (isNaN(ms)) return "";
  const s = Math.round(ms / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

// ── Loading skeleton ──────────────────────────────────────────────────────────
// Delegated to pulseShell.LoadingSkeleton so the skeleton shapes match the
// real strip + KPI card dimensions exactly. Re-exported locally for back-compat
// with any call-site that imported it from this module.
const LoadingSkeleton = ShellLoadingSkeleton;

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = [
  { value: "command",  label: "Command",  badgeKey: null,               letter: "c" },
  { value: "agents",   label: "Agents",   badgeKey: "notInCrm",         letter: "a" },
  { value: "agencies", label: "Agencies", badgeKey: "agenciesNotInCrm", letter: "y" },
  { value: "listings", label: "Listings", badgeKey: "totalListings",    letter: "l" },
  { value: "events",   label: "Events",   badgeKey: "upcomingEvents",   letter: "e" },
  { value: "market",   label: "Market",   badgeKey: null,               letter: "m" },
  { value: "market_share", label: "Market Share", badgeKey: null,       letter: "s" },
  { value: "retention", label: "Retention", badgeKey: null,             letter: "r" },
  { value: "sources",  label: "Sources",  badgeKey: null,               letter: "d" },
  { value: "suburbs",  label: "Suburbs",  badgeKey: null,               letter: "u" },
  { value: "mappings", label: "Mappings", badgeKey: "suggestedMappings",letter: "i" },
  { value: "signals",  label: "Signals",  badgeKey: "newSignals",       letter: "x" },
  { value: "timeline", label: "Timeline", badgeKey: null,               letter: "t" },
];

// Tabs that the URL `?tab=` query param is allowed to deep-link into.
// Limits surface area for typos/links from old emails; defaults to "command".
const VALID_TAB_VALUES = new Set(TABS.map(t => t.value));

// Letter → tab value map consumed by the g-chord keyboard shortcut.
const TAB_LETTER_MAP = Object.fromEntries(TABS.map((t) => [t.letter, t.value]));

// ── Main component ────────────────────────────────────────────────────────────

export default function IndustryPulse() {
  // ── Data hooks ────────────────────────────────────────────────────────────
  // Post big-refactor: the top-level page no longer pulls down the full
  // pulse_agents / pulse_agencies / pulse_listings / pulse_events arrays (10k+
  // rows each). A single aggregate RPC (pulse_get_dashboard_stats, migration
  // 137) returns every count + top-N list the shell / Command Center /
  // stat-strip need. Heavy tabs (Agents, Agencies, Listings, Events, Market)
  // manage their own server-paginated data queries so the browser never has
  // to hydrate the full dataset.
  const { data: dashboardStats, isLoading: statsLoading, refetch: refetchStats } = useQuery({
    queryKey: ["pulse_dashboard_stats"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_dashboard_stats");
      if (error) throw error;
      return data;
    },
    // Stats aggregate query takes ~200ms and changes slowly — cache aggressively
    // so tab-switching + back-nav doesn't re-hammer the DB.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

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

  // Heavy entity arrays are NO LONGER loaded at the page level. Tabs fetch
  // what they need. Empty arrays are passed through sharedProps so downstream
  // tabs that still reference the props (for ancillary features) fall through
  // to their own data fetches gracefully.
  const pulseAgents = EMPTY_ARRAY;
  const pulseAgencies = EMPTY_ARRAY;
  const pulseListings = EMPTY_ARRAY;
  const pulseEvents = EMPTY_ARRAY;

  // Consider page ready once the stats RPC + CRM lookup resolve. Everything
  // else loads below the fold or inside a tab and can progressive-render.
  const isLoading = statsLoading || crmAgentsLoading;

  // Shared query client — used by the refresh handler to invalidate every
  // tab's server-paginated query key in one sweep, and by prefetchEntity
  // further down the file for row-hover prefetches.
  const queryClient = useQueryClient();

  // ── UI state ────────────────────────────────────────────────────────────────
  // Tab state is mirrored into the URL's `?tab=` query param so deep-links
  // (e.g. "View full timeline" from the Command Center, bookmarks, support
  // links shared in chat) navigate straight to the intended tab.
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = (() => {
    const t = searchParams.get("tab");
    if (t && VALID_TAB_VALUES.has(t)) return t;
    // No URL tab override → honour the user's persisted homepage default
    // (set from the stat-card right-click context menu). Falls back to
    // Command Center for brand-new users.
    const homepage = getHomepageDefault();
    if (homepage?.tab && VALID_TAB_VALUES.has(homepage.tab)) return homepage.tab;
    return "command";
  })();
  const [tab, setTabState] = useState(initialTab);

  // Toast + density + palette/help state
  const { toast } = useToast();
  const { density, setDensity, className: densityClass } = useDensity();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

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

  // ── Tier 4: URL-driven source payload deep-link ────────────────────────
  // Timeline entries (and EntitySyncHistoryDialog rows) link with
  // `?tab=sources&sync_log_id=<id>` (legacy) or the newer
  // `?tab=sources&drill_log=<id>&drill_tab=<new|changes>`. Either form
  // surfaces to PulseDataSources as a prop; that component watches the id
  // and opens its DrillDialog preselected to the requested tab. Once
  // consumed the params are stripped so refreshes / back-nav don't re-open.
  const syncLogIdParam = searchParams.get("drill_log") || searchParams.get("sync_log_id");
  const drillTabParam  = searchParams.get("drill_tab") || null;
  const clearSyncLogIdParam = useCallback(() => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      np.delete("sync_log_id");
      np.delete("drill_log");
      np.delete("drill_tab");
      return np;
    }, { replace: true });
  }, [setSearchParams]);

  // ── URL-driven entity opening (Tier 3 drill-through) ──────────────────────
  // PulseMappings, PulseTimeline and other sources link with
  // `?pulse_id=<id>&entity_type=<agent|agency|listing>`. We keep the params
  // in the URL so the back/forward buttons + bookmarks round-trip the full
  // drill state. The effect is idempotent: it checks the stack top before
  // pushing, so re-consumes from rerenders are safe.
  const pulseIdParam = searchParams.get("pulse_id");
  const entityTypeParam = searchParams.get("entity_type");
  useEffect(() => {
    if (!pulseIdParam) return;
    // Prefer explicit ?entity_type=; fall back to deriving from ?tab= for
    // backwards-compat with older links.
    const tParam = searchParams.get("tab");
    const entityType = entityTypeParam
      || (tParam === "agencies" ? "agency"
        : tParam === "listings" ? "listing"
        : tParam === "agents" ? "agent"
        : null);
    if (!entityType) return;
    // Previously we also required the id to exist in the cached list before
    // pushing to the stack. That silently blocked deep-links for any row
    // past the 5k useEntityList cap (there are 6.5k+ listings in prod). The
    // dispatcher now fetches-on-miss, so it's safe to push the stack entry
    // even without a cache hit — currentEntityRecord will be populated by
    // the effect above as soon as the single-row fetch resolves. We still
    // deduplicate to avoid stacking the same entry repeatedly on rerender.
    setEntityStack((s) => {
      const top = s[s.length - 1];
      if (top && top.type === entityType && top.id === pulseIdParam) return s;
      return [...s, { type: entityType, id: pulseIdParam }];
    });
    // URL stays as-is. If the user navigates back or bookmarks the page, the
    // same ?pulse_id= + ?entity_type= will reopen the slideout idempotently.
  }, [pulseIdParam, entityTypeParam, searchParams]);

  // ── QoL #81: search persisted in `?q=` URL param ─────────────────────────
  const initialSearch = searchParams.get("q") || "";
  const [search, setSearchState] = useState(initialSearch);
  const setSearch = useCallback((next) => {
    setSearchState(next);
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (next && next.trim()) np.set("q", next);
      else np.delete("q");
      return np;
    }, { replace: true });
  }, [setSearchParams]);
  // Keep state in sync on back/forward
  useEffect(() => {
    const q = searchParams.get("q") || "";
    if (q !== search) setSearchState(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── QoL #82: shared filter state — suburb, agency — persisted in URL ──────
  // The tab components read `sharedSuburb` / `sharedAgency` from sharedProps;
  // when either is non-empty, the tab scopes its existing list filters to
  // that value. Typing in Agents' suburb filter sets `?suburb=X`, switching
  // to Listings keeps the same scope in effect.
  const initialSharedSuburb = searchParams.get("suburb") || "";
  const initialSharedAgency = searchParams.get("agency") || "";
  const [sharedSuburb, setSharedSuburbState] = useState(initialSharedSuburb);
  const [sharedAgency, setSharedAgencyState] = useState(initialSharedAgency);
  const setSharedSuburb = useCallback((next) => {
    setSharedSuburbState(next || "");
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (next) np.set("suburb", next); else np.delete("suburb");
      return np;
    }, { replace: true });
  }, [setSearchParams]);
  const setSharedAgency = useCallback((next) => {
    setSharedAgencyState(next || "");
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (next) np.set("agency", next); else np.delete("agency");
      return np;
    }, { replace: true });
  }, [setSearchParams]);
  useEffect(() => {
    const s = searchParams.get("suburb") || "";
    const a = searchParams.get("agency") || "";
    if (s !== sharedSuburb) setSharedSuburbState(s);
    if (a !== sharedAgency) setSharedAgencyState(a);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // ── QoL #83: per-tab page + sort round-tripped through URL ──────────────
  const urlPage = searchParams.get("page");
  const urlSort = searchParams.get("sort");
  const setUrlPageSort = useCallback((page, sort) => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (page === null || page === undefined || page === 0) np.delete("page");
      else np.set("page", String(page));
      if (!sort) np.delete("sort"); else np.set("sort", sort);
      return np;
    }, { replace: true });
  }, [setSearchParams]);

  // ── QoL #84: slideout deep-link tab (e.g. `?slideout_tab=timeline`) ──────
  const slideoutTabParam = searchParams.get("slideout_tab") || "overview";

  const [addToCrmFromCommand, setAddToCrmFromCommand] = useState(null);

  // ── Cross-tab drill-through stack ───────────────────────────────────────────
  // Each entry: { type: 'agent' | 'agency' | 'listing', id: string }
  // The *top* of the stack is mirrored into the URL as ?pulse_id=&entity_type=
  // so browser back/forward + bookmarks round-trip drill state.
  const [entityStack, setEntityStack] = useState([]);
  const currentEntity = entityStack[entityStack.length - 1] || null;

  // Sync the URL params with a target entity (or clear them when null).
  const syncEntityParams = useCallback((entity) => {
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (entity) {
        np.set("pulse_id", entity.id);
        np.set("entity_type", entity.type);
      } else {
        np.delete("pulse_id");
        np.delete("entity_type");
      }
      return np;
    }, { replace: true });
  }, [setSearchParams]);

  const openEntity = useCallback((entity) => {
    if (!entity || !entity.type || !entity.id) return;
    // Don't push a duplicate of the current top
    setEntityStack((s) => {
      const top = s[s.length - 1];
      if (top && top.type === entity.type && top.id === entity.id) return s;
      return [...s, entity];
    });
    syncEntityParams(entity);
  }, [syncEntityParams]);

  const popEntity = useCallback(() => {
    setEntityStack((s) => {
      const next = s.slice(0, -1);
      const top = next[next.length - 1] || null;
      syncEntityParams(top);
      return next;
    });
  }, [syncEntityParams]);

  const closeAllEntities = useCallback(() => {
    setEntityStack([]);
    syncEntityParams(null);
  }, [syncEntityParams]);

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
  // QoL #4: track when a refresh last completed so "Refreshed Xm ago" can
  // render a relative-time hint next to the Refresh button. Initialised on
  // first successful mount via the effect below.
  const [lastFetched, setLastFetched] = useState(() => Date.now());
  const handleRefreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      // Refresh the stats RPC + any supplemental entity caches. Tabs that
      // server-paginate their own data (Agents/Agencies/Listings/Events)
      // invalidate themselves via their own refetchInterval / useQuery keys;
      // bumping the stats cache + react-query pulse_dashboard_stats key also
      // refreshes everything the shell renders (stat strip, tab chip counts,
      // Command Center cards).
      await Promise.all([
        refetchStats(),
        queryClient.invalidateQueries({ queryKey: ["pulse-listings-page"] }),
        queryClient.invalidateQueries({ queryKey: ["pulse-agents-page"] }),
        queryClient.invalidateQueries({ queryKey: ["pulse-agencies-page"] }),
        queryClient.invalidateQueries({ queryKey: ["pulse-events-list"] }),
        queryClient.invalidateQueries({ queryKey: ["pulse-market-data"] }),
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
      setLastFetched(Date.now());
    } finally {
      setRefreshing(false);
    }
  }, [refetchStats]);

  // Tick every 30s so the relative-time label ("Refreshed 2m ago") updates
  // without needing a user action. Cheap: single interval, no network.
  const [, _forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => _forceTick(t => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── QoL #85: row-hover prefetch helper ──────────────────────────────────
  // Tabs receive this via sharedProps and call it in `onMouseEnter` on each
  // row. Uses a 200ms debounce per-row so rapid mouse drags over a list
  // don't trigger a storm of prefetches. When the user finally hovers for
  // long enough (intent), we ask react-query to populate the dossier cache —
  // so by the time they click, the slideout opens instantly.
  const prefetchTimers = useRef(new Map());
  const prefetchEntity = useCallback((entityType, id) => {
    if (!entityType || !id) return;
    const key = `${entityType}:${id}`;
    // Already queued or already cached? Skip.
    if (prefetchTimers.current.has(key)) return;
    const existing = queryClient.getQueryData(["pulse_dossier_slideout", entityType, id]);
    if (existing) return;
    const t = setTimeout(() => {
      prefetchTimers.current.delete(key);
      queryClient.prefetchQuery({
        queryKey: ["pulse_dossier_slideout", entityType, id],
        queryFn: async () => {
          const { data, error } = await api._supabase.rpc("pulse_get_dossier", {
            p_entity_type: entityType,
            p_entity_id: id,
          });
          if (error) throw error;
          return data;
        },
        staleTime: 30_000,
      }).catch(() => {
        // Swallow prefetch errors — the real click will retry and surface
        // any error through the normal UI.
      });
    }, 200);
    prefetchTimers.current.set(key, t);
  }, [queryClient]);
  const cancelPrefetch = useCallback((entityType, id) => {
    if (!entityType || !id) return;
    const key = `${entityType}:${id}`;
    const t = prefetchTimers.current.get(key);
    if (t) {
      clearTimeout(t);
      prefetchTimers.current.delete(key);
    }
  }, []);
  // Cleanup on unmount
  useEffect(() => {
    const timers = prefetchTimers.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // ── Computed stats ───────────────────────────────────────────────────────
  // All totals come straight from the stats RPC. We still expose the same
  // keys the tabs reference (totalAgents, notInCrm, activeListings, etc.) so
  // downstream consumers don't need to change shape.
  const stats = useMemo(() => {
    const t = dashboardStats?.totals;
    const f = dashboardStats?.funnel;
    if (!t) {
      // First render before the RPC resolves — zeros instead of undefined
      // so the stat strip + tab badges don't flicker NaN / undefined.
      return {
        totalAgents: 0, notInCrm: 0, agentsInCrm: 0,
        totalAgencies: 0, agenciesNotInCrm: 0, agenciesInCrm: 0,
        totalListings: 0, activeListings: 0, rentals: 0, sold: 0, underContract: 0, withdrawn: 0,
        avgDom: 0, upcomingEvents: 0, newSignals: 0, agentMovements: 0,
        recentProjects: 0, recentListings: 0, marketShare: 0, suggestedMappings: 0,
      };
    }
    const recentListings = t.recent_listings_30d ?? 0;
    const recentProjects = t.recent_projects_30d ?? 0;
    return {
      totalAgents: t.agents ?? 0,
      notInCrm: t.agents_not_in_crm ?? 0,
      agentsInCrm: t.agents_in_crm ?? 0,
      totalAgencies: t.agencies ?? 0,
      agenciesNotInCrm: t.agencies_not_in_crm ?? 0,
      agenciesInCrm: t.agencies_in_crm ?? 0,
      totalListings: t.listings ?? 0,
      activeListings: t.for_sale ?? 0,
      rentals: t.for_rent ?? 0,
      sold: t.sold ?? 0,
      underContract: t.under_contract ?? 0,
      withdrawn: t.withdrawn ?? 0,
      avgDom: dashboardStats.avg_dom ?? 0,
      upcomingEvents: t.upcoming_events ?? 0,
      newSignals: t.new_signals ?? 0,
      agentMovements: t.agent_movements_30d ?? 0,
      recentProjects,
      recentListings,
      marketShare: recentListings > 0 ? Math.round((recentProjects / recentListings) * 100) : 0,
      suggestedMappings: t.suggested_mappings ?? 0,
      // Pass through the funnel inputs so PulseCommandCenter can render its
      // Territory → Booked chart off-RPC.
      _funnel: f || null,
    };
  }, [dashboardStats]);

  // Deep-link handler — Command Center → Timeline tab
  const handleViewFullTimeline = useCallback(() => {
    setTab("timeline");
  }, [setTab]);

  // Trend % computation + 7-day baselines are now owned by PulseHeaderStats
  // (which pulls its own payload from pulse_get_header_stats_with_trends).
  // The shell keeps `stats` as the authoritative "current value" source so
  // the strip's numbers match the tab chip counts exactly.

  // ── Shared props spread into every tab ──────────────────────────────────────
  const sharedProps = {
    // Heavy entity arrays are now empty — tabs fetch what they need. The
    // props are kept in the shape for backwards-compat with the many tab
    // components that still destructure them; the arrays just start empty
    // and the tabs' own useQuery hooks populate the visible data.
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
    // Dashboard stats RPC payload — Command Center + anywhere else that used
    // to reduce over the full entity arrays now reads from here.
    dashboardStats,
    user,
    onAddToCrm: handleAddToCrmFromCommand,
    addToCrmFromCommand,
    onClearAddToCrmFromCommand: handleClearAddToCrmFromCommand,
    onOpenEntity: openEntity,
    onViewFullTimeline: handleViewFullTimeline,
    // QoL #82 — shared filter state lifted to parent, tabs can opt in
    sharedSuburb,
    sharedAgency,
    onChangeSharedSuburb: setSharedSuburb,
    onChangeSharedAgency: setSharedAgency,
    // QoL #83 — URL-driven page + sort (opt-in on tabs that already use useQuery)
    urlPage: urlPage ? Number(urlPage) : null,
    urlSort,
    onChangeUrlPageSort: setUrlPageSort,
    // QoL #85 — row-hover prefetch helpers
    onRowHover: prefetchEntity,
    onRowHoverLeave: cancelPrefetch,
  };

  // ── Resolve current entity from stack to actual record ────────────────────
  //
  // First try the cached list (fast path, covers ~99% of clicks). If the row
  // isn't cached — which happens for the 1500+ oldest listings past the 5k
  // useEntityList cap — fall back to a one-shot Supabase fetch keyed on id
  // so the slideout still renders. Without this, clicking a row outside the
  // cached window silently fails: lookup returns null → currentEntityRecord
  // null → slideout never mounts. Seen in prod with 16 MacArthur Avenue,
  // Strathfield (rank #6096 & #6290 in created_at DESC order).
  const cachedEntityRecord = useMemo(() => {
    if (!currentEntity) return null;
    if (currentEntity.type === "listing")
      return pulseListings.find((l) => l.id === currentEntity.id) || null;
    if (currentEntity.type === "agent")
      return pulseAgents.find((a) => a.id === currentEntity.id) || null;
    if (currentEntity.type === "agency")
      return pulseAgencies.find((a) => a.id === currentEntity.id) || null;
    return null;
  }, [currentEntity, pulseListings, pulseAgents, pulseAgencies]);

  // Fetched-on-miss record for entities not in the cache (cap-beyond rows or
  // URL deep-links that arrive before the list has loaded). Cleared when
  // currentEntity changes.
  const [fetchedEntityRecord, setFetchedEntityRecord] = useState(null);
  const [fetchingEntity, setFetchingEntity] = useState(false);
  useEffect(() => {
    if (!currentEntity) {
      setFetchedEntityRecord(null);
      setFetchingEntity(false);
      return;
    }
    // Cache hit? Nothing to fetch.
    if (cachedEntityRecord) {
      setFetchedEntityRecord(null);
      setFetchingEntity(false);
      return;
    }
    // Cache miss — fetch the single row directly. Uses the same PostgREST
    // clients the rest of Pulse uses so RLS/column aliases match.
    const table = currentEntity.type === "listing" ? "pulse_listings"
      : currentEntity.type === "agent" ? "pulse_agents"
      : currentEntity.type === "agency" ? "pulse_agencies"
      : null;
    if (!table) return;
    let cancelled = false;
    setFetchingEntity(true);
    (async () => {
      try {
        const { data, error } = await api._supabase
          .from(table)
          .select("*")
          .eq("id", currentEntity.id)
          .maybeSingle();
        if (cancelled) return;
        if (error) {
          console.warn(`[IndustryPulse] fetch-on-miss ${table} failed:`, error);
          setFetchedEntityRecord(null);
        } else {
          setFetchedEntityRecord(data || null);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn(`[IndustryPulse] fetch-on-miss ${table} threw:`, err);
          setFetchedEntityRecord(null);
        }
      } finally {
        if (!cancelled) setFetchingEntity(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentEntity, cachedEntityRecord]);

  const currentEntityRecord = cachedEntityRecord || fetchedEntityRecord;

  const hasEntityHistory = entityStack.length > 1;

  // ── Stat-card click-through → tab + optional URL preset ─────────────────
  // Accepts either a legacy string (`"for_sale"`) or a preset object
  // (`{ listingType, crm, window }`). Each key lands in the right URL
  // param so downstream tabs pick them up on mount without extra plumbing.
  const navigateToTab = useCallback((nextTab, presetOrType = null) => {
    setTab(nextTab);
    const preset = typeof presetOrType === "string"
      ? { listingType: presetOrType }
      : (presetOrType || {});
    setSearchParams((prev) => {
      const np = new URLSearchParams(prev);
      if (preset.listingType) np.set("type", preset.listingType); else np.delete("type");
      // "not_in_crm" → PulseAgentIntel reads ?agents_view=not_in_crm etc.
      if (preset.crm === "not_in_crm" && nextTab === "agents")   np.set("agents_view",   "not_in_crm");
      if (preset.crm === "not_in_crm" && nextTab === "agencies") np.set("agencies_view", "not_in_crm");
      if (preset.window) np.set("market_window", preset.window);
      return np;
    }, { replace: true });
  }, [setTab, setSearchParams]);

  // ── Keyboard shortcut layer (⌘K, /, ?, g-chord, n/p, 1-9/0/-) ──────────
  const searchInputRef = useRef(null);
  const focusSearch = useCallback(() => {
    const el = searchInputRef.current;
    if (!el) return false;
    el.focus();
    el.select?.();
    return true;
  }, []);
  const closeOverlays = useCallback(() => {
    if (paletteOpen) { setPaletteOpen(false); return; }
    if (helpOpen)    { setHelpOpen(false);    return; }
    if (entityStack.length > 0) closeAllEntities();
  }, [paletteOpen, helpOpen, entityStack.length, closeAllEntities]);
  useKeyboardShortcuts({
    tabs: TABS,
    tabLetterMap: TAB_LETTER_MAP,
    currentTab: tab,
    onChangeTab: setTab,
    onOpenPalette: () => setPaletteOpen(true),
    onFocusSearch: focusSearch,
    onShowHelp: () => setHelpOpen(true),
    onCloseOverlays: closeOverlays,
  });

  // ── Palette: local commands ────────────────────────────────────────────
  // These are the actions that appear under the "Commands" group. Each
  // entry is closed over the shell state so the palette component stays
  // stateless.
  const paletteCommands = useMemo(() => ([
    { id: "refresh",  label: "Refresh all data",           sub: "Action",    keywords: "reload",        onRun: () => handleRefreshAll() },
    { id: "help",     label: "Show keyboard shortcuts",    sub: "Help",      keywords: "keys",          onRun: () => setHelpOpen(true) },
    { id: "den-c",    label: "Density: Comfortable",       sub: "Density",   keywords: "spacing",       onRun: () => setDensity("comfortable") },
    { id: "den-m",    label: "Density: Compact",           sub: "Density",   keywords: "spacing tight", onRun: () => setDensity("compact") },
    { id: "den-d",    label: "Density: Dense",             sub: "Density",   keywords: "spacing tight", onRun: () => setDensity("dense") },
    { id: "hp-cur",   label: "Set current tab as homepage default",
      sub: "Homepage", keywords: "default start",
      onRun: () => {
        try { localStorage.setItem("industryPulse.homepageDefault", JSON.stringify({ tab, listingType: null })); } catch { /* noop */ }
        toast?.({ title: "Homepage default set", description: `Industry Pulse will open on "${tab}" next time.` });
      },
    },
    { id: "hp-clr",   label: "Clear homepage default",     sub: "Homepage",  keywords: "reset",
      onRun: () => {
        try { localStorage.removeItem("industryPulse.homepageDefault"); } catch { /* noop */ }
        toast?.({ title: "Homepage default cleared" });
      },
    },
  ]), [tab, setDensity, toast, handleRefreshAll]);

  // ── Early return: loading skeleton ───────────────────────────────────────────
  if (isLoading) return <LoadingSkeleton />;

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <PulseShellProvider value={{ density, setDensity, openPalette: () => setPaletteOpen(true) }}>
    <div className={cn("px-4 pt-3 pb-4 lg:px-6 space-y-3", densityClass, densityWrapperCls(density))} data-pulse-density={density}>

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
              ref={searchInputRef}
              placeholder="Search agents, agencies… (/)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs"
              aria-label="Search Industry Pulse"
            />
          </div>
          {/* Quick launcher button for the ⌘K palette — keyboard-first users
              have the shortcut; mouse-first users click this chip. */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2 text-xs gap-1.5"
            onClick={() => setPaletteOpen(true)}
            title="Open command palette (⌘K)"
            aria-label="Open command palette"
          >
            <CmdIcon className="h-3.5 w-3.5" />
            <span className="hidden lg:inline">Palette</span>
            <kbd className="hidden lg:inline-flex ml-1 items-center gap-0.5 px-1 py-0 rounded border bg-muted/60 text-[9px] text-muted-foreground">⌘K</kbd>
          </Button>
          {/* Density toggle */}
          <DensityToggle density={density} onChange={setDensity} />
          {/* Help sheet launcher */}
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={() => setHelpOpen(true)}
            title="Keyboard shortcuts (?)"
            aria-label="Show keyboard shortcuts"
          >
            <Keyboard className="h-3.5 w-3.5" />
          </Button>
          {/* Relative time since last refresh — updates every 30s */}
          {lastFetched && (
            <span
              className="hidden md:inline text-[10px] text-muted-foreground tabular-nums whitespace-nowrap"
              title={new Date(lastFetched).toLocaleString()}
            >
              Refreshed {formatRelativeTime(lastFetched)}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-2.5 text-xs gap-1.5"
            onClick={handleRefreshAll}
            disabled={refreshing}
            title="Refresh all data"
            aria-label="Refresh all Industry Pulse data"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* ── Stats strip — trend-aware, sparkline-backed, right-click menu ── */}
      <PulseHeaderStats stats={stats} onNavigate={navigateToTab} toast={toast} />

      {/* ── Tab bar + content ── */}
      {/* QoL #89: on mobile (<md) render as horizontal-scroll strip with */}
      {/* snap-x; on >=md keep the flex-wrap layout. Active tab auto-scrolls */}
      {/* into view via scrollIntoView below. */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList
          className="flex md:flex-wrap h-auto gap-0.5 w-full rounded-lg bg-muted p-1 overflow-x-auto md:overflow-visible snap-x md:snap-none scroll-smooth"
        >
          {TABS.map(({ value, label, badgeKey }) => {
            const rawCount = badgeKey ? (stats[badgeKey] || 0) : 0;
            const count = badgeKey && rawCount > 0 ? rawCount : null;
            return (
              <TabsTrigger
                key={value}
                value={value}
                ref={(el) => {
                  // QoL #89: when a tab becomes active on mobile, scroll it
                  // into view so it's not clipped off the edge of the strip.
                  if (el && value === tab && typeof el.scrollIntoView === "function") {
                    try {
                      el.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
                    } catch { /* older browsers */ }
                  }
                }}
                className="relative flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-md snap-start shrink-0 md:shrink data-[state=active]:bg-background data-[state=active]:shadow-sm"
              >
                {label}
                {count !== null && (
                  <Badge
                    variant="secondary"
                    className="h-4 min-w-[1rem] px-1 text-[9px] tabular-nums rounded-full"
                    title={count.toLocaleString()}
                  >
                    {/* QoL #3: compact formatting (5000 → 5k) */}
                    {formatCountShort(count)}
                  </Badge>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>

        {/* QoL #88: each ErrorBoundary gets `resetKey={tab}` so switching */}
        {/* tabs clears any caught error; switching back remounts the tab. */}
        <TabsContent value="command" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Command">
            <PulseCommandCenter {...sharedProps} onNavigateTab={navigateToTab} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="agents" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Agents">
            <PulseAgentIntel {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="agencies" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Agencies">
            <PulseAgencyIntel {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="listings" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Listings">
            <PulseListingsTab {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="events" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Events">
            <PulseEventsTab {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="market" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Market">
            <PulseMarketData {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="market_share" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Market Share">
            <PulseMarketShare onOpenEntity={openEntity} onNavigateTab={navigateToTab} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="retention" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Retention">
            <PulseRetention onOpenEntity={openEntity} onNavigateTab={navigateToTab} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="sources" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Sources">
            <PulseDataSources
              {...sharedProps}
              deepLinkSyncLogId={syncLogIdParam}
              deepLinkDrillTab={drillTabParam}
              onConsumeDeepLinkSyncLogId={clearSyncLogIdParam}
            />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="suburbs" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Suburbs">
            <PulseSuburbs />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="mappings" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Mappings">
            <PulseMappings {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="signals" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Signals">
            <PulseSignals {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>

        <TabsContent value="timeline" className="mt-2">
          <ErrorBoundary resetKey={tab} fallbackLabel="Timeline">
            <PulseTimelineTab {...sharedProps} />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>

      {/* ── Central drill-through dispatcher ── */}
      {/* When the cache misses and we're fetching the row on-demand, show a
          transient loading dialog so the user doesn't experience a "dead
          click". Without this, a cap-beyond row produces no visible effect. */}
      {currentEntity && !currentEntityRecord && fetchingEntity && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center">
          <div className="bg-background rounded-lg px-5 py-4 shadow-lg flex items-center gap-3">
            <RefreshCw className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm text-muted-foreground">Loading {currentEntity.type}…</span>
          </div>
        </div>
      )}
      {/* Cache miss AND fetch failed / returned null — tell the user rather
          than silently doing nothing. */}
      {currentEntity && !currentEntityRecord && !fetchingEntity && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={closeAllEntities}>
          <div className="bg-background rounded-lg px-5 py-4 shadow-lg max-w-sm mx-4" onClick={(e) => e.stopPropagation()}>
            <p className="text-sm font-medium mb-1">Couldn't load {currentEntity.type}</p>
            <p className="text-xs text-muted-foreground mb-3">
              This record may have been deleted or is no longer accessible.
            </p>
            <Button size="sm" variant="outline" onClick={closeAllEntities} aria-label="Close dialog">Close</Button>
          </div>
        </div>
      )}
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
              initialTab={slideoutTabParam}
            />
          )}
          {currentEntity.type === "agent" && (
            <AgentSlideout
              agent={currentEntityRecord}
              pulseAgents={pulseAgents}
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
              initialTab={slideoutTabParam}
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
              initialTab={slideoutTabParam}
            />
          )}
        </ErrorBoundary>
      )}

      {/* ── Global ⌘K command palette ── */}
      <PulseCommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenEntity={openEntity}
        onNavigateTab={(v) => navigateToTab(v)}
        tabs={TABS}
        commands={paletteCommands}
      />

      {/* ── Keyboard shortcut help sheet ── */}
      <PulseShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
    </PulseShellProvider>
  );
}

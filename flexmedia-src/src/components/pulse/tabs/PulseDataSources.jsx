/**
 * PulseDataSources — Industry Pulse "Sources" tab.
 * Manages REA scraper runs, cron schedule display, sync history,
 * suburb pool, and raw payload drill-through.
 */
import React, { useState, useMemo, useCallback, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Database, Users, Home, DollarSign, Clock, CheckCircle2,
  AlertTriangle, Loader2, Plus, Trash2, Settings2,
  ChevronDown, ChevronUp, Eye, MapPin, ToggleLeft, ToggleRight,
  ExternalLink, Repeat, Globe, Calendar, Coins, FileCode2,
  User, XCircle, Activity,
} from "lucide-react";

// ── Source definitions ────────────────────────────────────────────────────────
// Shared bounding box for Greater Sydney — covers all 5 regions
const SYDNEY_BB = "-33.524668718554146,150.02828594437534,-34.14521322911264,151.78609844437534";

const SOURCES = [
  {
    source_id: "rea_agents",
    label: "REA Agent Profiles",
    actor_slug: "websift/realestateau",
    apify_url: "https://apify.com/websift/realestateau",
    description: "Agent profiles, stats, reviews, awards from realestate.com.au",
    icon: Users,
    color: "text-red-600",
    accentClass: "from-red-500/10 to-red-600/5 border-red-200/60 dark:border-red-800/40",
    defaultMax: 30,
    approach: "per_suburb",
    approachLabel: "Per-suburb iteration",
    approachExplain: "167 active suburbs x 30 agents each ~= 5,010 agents per run",
    perSuburb: 30,
    schedule: "Weekly (Sunday)",
    scheduleHint: "Sun 4am AEST",
    cost_note: "~$0.005 per suburb x 167 ~= $0.85 per run",
    input_params: [
      { key: "location", value: '"{suburb} NSW"', note: "iterates 167 suburbs" },
      { key: "maxPages", value: "3", note: "~30 agents per suburb" },
      { key: "fullScrape", value: "true" },
      { key: "sortBy", value: '"SUBURB_SALES_PERFORMANCE"' },
    ],
    runParams: (subs, max) => ({
      suburbs: subs,
      state: "NSW",
      maxAgentsPerSuburb: max,
      maxListingsPerSuburb: 0,
      skipListings: true,
    }),
  },
  {
    source_id: "rea_listings",
    label: "REA Listings (per suburb)",
    actor_slug: "azzouzana/real-estate-au-scraper-pro",
    apify_url: "https://apify.com/azzouzana/real-estate-au-scraper-pro",
    description: "Listings with agent emails, photos, IDs from realestate.com.au",
    icon: Home,
    color: "text-blue-600",
    accentClass: "from-blue-500/10 to-blue-600/5 border-blue-200/60 dark:border-blue-800/40",
    defaultMax: 20,
    approach: "per_suburb",
    approachLabel: "Per-suburb iteration",
    approachExplain: "167 active suburbs x 20 listings each ~= 3,340 listings per run",
    perSuburb: 20,
    schedule: "On-demand / Weekly",
    scheduleHint: "No active cron",
    cost_note: "~$0.01 per suburb x 167 ~= $1.70 per run",
    input_params: [
      { key: "startUrl", value: '"…/buy/in-{suburb-slug},+nsw/list-1"', note: "iterates 167 suburbs" },
      { key: "maxItems", value: "20", note: "per suburb" },
    ],
    runParams: (subs, max) => ({
      suburbs: subs,
      state: "NSW",
      maxAgentsPerSuburb: 0,
      maxListingsPerSuburb: max,
      skipListings: false,
    }),
  },
  {
    source_id: "rea_listings_bb_buy",
    label: "REA Sales (Greater Sydney)",
    actor_slug: "azzouzana/real-estate-au-scraper-pro",
    apify_url: "https://apify.com/azzouzana/real-estate-au-scraper-pro",
    description: "Bounding box buy listings, sorted by newest",
    icon: DollarSign,
    color: "text-green-600",
    accentClass: "from-emerald-500/10 to-green-600/5 border-emerald-200/60 dark:border-emerald-800/40",
    defaultMax: 500,
    approach: "bounding_box",
    approachLabel: "Bounding box",
    approachExplain: "Single URL covers all of Greater Sydney - up to 500 listings per run",
    schedule: "Daily 6am",
    scheduleHint: "6am AEST",
    cost_note: "~$0.05 per run (single call)",
    bboxRegion: "Greater Sydney",
    bboxCoords: { nw: { lat: -33.5247, lng: 150.0283 }, se: { lat: -34.1452, lng: 151.7861 } },
    input_params: [
      { key: "startUrl", value: `"…/buy/list-1?boundingBox=${SYDNEY_BB}…"` },
      { key: "maxItems", value: "500" },
      { key: "activeSort", value: "list-date" },
    ],
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/buy/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date",
      maxListingsTotal: max,
    }),
  },
  {
    source_id: "rea_listings_bb_rent",
    label: "REA Rentals (Greater Sydney)",
    actor_slug: "azzouzana/real-estate-au-scraper-pro",
    apify_url: "https://apify.com/azzouzana/real-estate-au-scraper-pro",
    description: "Bounding box rental listings",
    icon: Home,
    color: "text-teal-600",
    accentClass: "from-teal-500/10 to-teal-600/5 border-teal-200/60 dark:border-teal-800/40",
    defaultMax: 500,
    approach: "bounding_box",
    approachLabel: "Bounding box",
    approachExplain: "Single URL covers all of Greater Sydney - up to 500 listings per run",
    schedule: "Daily 7am",
    scheduleHint: "7am AEST",
    cost_note: "~$0.05 per run (single call)",
    bboxRegion: "Greater Sydney",
    bboxCoords: { nw: { lat: -33.5247, lng: 150.0283 }, se: { lat: -34.1452, lng: 151.7861 } },
    input_params: [
      { key: "startUrl", value: `"…/rent/list-1?boundingBox=${SYDNEY_BB}…"` },
      { key: "maxItems", value: "500" },
      { key: "activeSort", value: "list-date" },
    ],
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/rent/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534&activeSort=list-date",
      maxListingsTotal: max,
    }),
  },
  {
    source_id: "rea_listings_bb_sold",
    label: "REA Sold (Greater Sydney)",
    actor_slug: "azzouzana/real-estate-au-scraper-pro",
    apify_url: "https://apify.com/azzouzana/real-estate-au-scraper-pro",
    description: "Bounding box recently sold",
    icon: DollarSign,
    color: "text-orange-600",
    accentClass: "from-orange-500/10 to-orange-600/5 border-orange-200/60 dark:border-orange-800/40",
    defaultMax: 500,
    approach: "bounding_box",
    approachLabel: "Bounding box",
    approachExplain: "Single URL covers all of Greater Sydney - up to 500 listings per run",
    schedule: "Daily 8am",
    scheduleHint: "8am AEST",
    cost_note: "~$0.05 per run (single call)",
    bboxRegion: "Greater Sydney",
    bboxCoords: { nw: { lat: -33.5247, lng: 150.0283 }, se: { lat: -34.1452, lng: 151.7861 } },
    input_params: [
      { key: "startUrl", value: `"…/sold/list-1?boundingBox=${SYDNEY_BB}"` },
      { key: "maxItems", value: "500" },
    ],
    runParams: (_, max) => ({
      suburbs: [],
      state: "NSW",
      listingsStartUrl:
        "https://www.realestate.com.au/sold/list-1?boundingBox=-33.524668718554146%2C150.02828594437534%2C-34.14521322911264%2C151.78609844437534",
      maxListingsTotal: max,
    }),
  },
];

// ── Cron schedule ─────────────────────────────────────────────────────────────

const CRON_SCHEDULE = [
  { label: "REA Agents",      schedule: "Weekly (Sunday)",  source_id: "rea_agents" },
  { label: "REA Sales BB",    schedule: "Daily 6am",        source_id: "rea_listings_bb_buy" },
  { label: "REA Rentals BB",  schedule: "Daily 7am",        source_id: "rea_listings_bb_rent" },
  { label: "REA Sold BB",     schedule: "Daily 8am",        source_id: "rea_listings_bb_sold" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTs(d) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString("en-AU", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

function fmtRelativeTs(d) {
  if (!d) return "Never run";
  try {
    const diff = Date.now() - new Date(d).getTime();
    if (diff < 0) return fmtTs(d);
    const mins = Math.round(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    if (days < 14) return `${days}d ago`;
    return fmtTs(d);
  } catch {
    return "—";
  }
}

function fmtDuration(start, end) {
  if (!start || !end) return "—";
  const ms = new Date(end) - new Date(start);
  if (isNaN(ms) || ms < 0) return "—";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)}m`;
}

function nextCronLabel(schedule) {
  const now = new Date();
  if (schedule === "Weekly (Sunday)") {
    const daysUntilSun = (7 - now.getDay()) % 7 || 7;
    const next = new Date(now.getTime() + daysUntilSun * 86400000);
    next.setHours(0, 0, 0, 0);
    return next.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" });
  }
  const match = schedule.match(/Daily (\d+)(am|pm)?/i);
  if (match) {
    let hr = parseInt(match[1], 10);
    if (match[2] === "pm" && hr !== 12) hr += 12;
    const next = new Date(now);
    next.setHours(hr, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  return "—";
}

function recordsSummary(log) {
  if (!log?.result_summary) return "—";
  const s = log.result_summary;
  const parts = [];
  if (s.agents_processed != null)   parts.push(`${s.agents_processed} agents`);
  if (s.listings_stored != null) parts.push(`${s.listings_stored} listings`);
  if (s.records_saved != null && !parts.length) parts.push(`${s.records_saved} records`);
  return parts.join(", ") || "—";
}

function StatusBadge({ status }) {
  if (status === "completed")
    return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-[10px] px-1.5 py-0">Completed</Badge>;
  if (status === "running")
    return <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] px-1.5 py-0 animate-pulse">Running</Badge>;
  if (status === "failed")
    return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 text-[10px] px-1.5 py-0">Failed</Badge>;
  return <Badge variant="outline" className="text-[10px] px-1.5 py-0">{status || "—"}</Badge>;
}

// ── Approach diagrams ─────────────────────────────────────────────────────────

function PerSuburbDiagram({ suburbCount, perSuburb }) {
  const total = (suburbCount || 0) * (perSuburb || 0);
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/70 border">
        <MapPin className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono font-semibold">{suburbCount || "—"}</span>
        <span className="text-muted-foreground">suburbs</span>
      </span>
      <Repeat className="h-3 w-3 text-muted-foreground" />
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/70 border">
        <span className="font-mono font-semibold">{perSuburb}</span>
        <span className="text-muted-foreground">each</span>
      </span>
      <span className="text-muted-foreground">=</span>
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 border border-primary/20 text-primary">
        <span className="font-mono font-semibold">~{total.toLocaleString()}</span>
      </span>
    </div>
  );
}

function BoundingBoxDiagram({ region = "Greater Sydney", maxItems = 500 }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap text-[10px]">
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/70 border">
        <Globe className="h-3 w-3 text-muted-foreground" />
        <span className="font-mono font-semibold">1 URL</span>
      </span>
      <span className="text-muted-foreground">-&gt;</span>
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-muted/70 border">
        <span className="text-muted-foreground">{region}</span>
      </span>
      <span className="text-muted-foreground">-&gt;</span>
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-primary/10 border border-primary/20 text-primary">
        <span className="font-mono font-semibold">up to {maxItems}</span>
      </span>
    </div>
  );
}

// ── pulse_sync_runs data hook ─────────────────────────────────────────────────

/**
 * Fetch aggregated sync runs for a specific source_id from the pulse_sync_runs
 * view (see migration 069_pulse_sync_runs_view.sql). Each "run" is 1-N
 * pulseDataSync dispatches bucketed into a 15-minute window.
 *
 * Auto-refreshes every 15s while any run has in_progress dispatches. Drops to
 * 60s polling once everything terminal (completed/failed). This keeps the UI
 * live during a cron fan-out without hammering the DB when nothing's happening.
 */
function usePulseSyncRuns(sourceId, limit = 10) {
  const [runs, setRuns] = useState([]);
  const [loading, setLoading] = useState(true);

  const hasActive = useMemo(() => runs.some((r) => (r.in_progress || 0) > 0), [runs]);

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;

    const fetchRuns = async () => {
      try {
        const { data, error } = await api._supabase
          .from("pulse_sync_runs")
          .select("*")
          .eq("source_id", sourceId)
          .order("run_started_at", { ascending: false })
          .limit(limit);
        if (error) throw error;
        if (!cancelled) setRuns(data || []);
      } catch (err) {
        // Silent — view may not yet be deployed. Card still renders from lastLog.
        console.warn("pulse_sync_runs fetch failed:", err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchRuns();
    // Faster polling while in-progress; slower when idle.
    const intervalMs = hasActive ? 15000 : 60000;
    const id = setInterval(fetchRuns, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [sourceId, limit, hasActive]);

  return { runs, loading };
}

// ── Sub-components ────────────────────────────────────────────────────────────

// --- Triggered-by badge ---

function TriggeredByBadge({ names }) {
  if (!names || names.length === 0) {
    return (
      <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
        <User className="h-2.5 w-2.5" />
        Unknown
      </Badge>
    );
  }
  const isCron = names.length === 1 && names[0] === "Cron";
  return (
    <Badge
      className={cn(
        "text-[10px] px-1.5 py-0 gap-1",
        isCron
          ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
          : "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
      )}
    >
      {isCron ? <Clock className="h-2.5 w-2.5" /> : <User className="h-2.5 w-2.5" />}
      {names.join(", ")}
    </Badge>
  );
}

// --- Progress bar (green/blue-pulsing/red segments) ---

function RunProgressBar({ run }) {
  const total = run.total_dispatches || 0;
  if (total === 0) return null;
  const succeeded = run.succeeded || 0;
  const failed = run.failed || 0;
  const inProgress = run.in_progress || 0;
  const pct = (n) => (total > 0 ? (n / total) * 100 : 0);

  return (
    <div className="w-full h-2 rounded-full bg-muted overflow-hidden flex">
      {succeeded > 0 && (
        <div className="h-full bg-emerald-500" style={{ width: `${pct(succeeded)}%` }} />
      )}
      {inProgress > 0 && (
        <div
          className="h-full bg-blue-500 animate-pulse"
          style={{ width: `${pct(inProgress)}%` }}
        />
      )}
      {failed > 0 && <div className="h-full bg-red-500" style={{ width: `${pct(failed)}%` }} />}
    </div>
  );
}

// --- Format duration in compact form ---

function fmtDurationSec(sec) {
  if (sec == null || isNaN(sec)) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

// --- Per-dispatch (per-suburb) table shown when a run is expanded ---

function DispatchTable({ dispatches = [], onDrill }) {
  if (!dispatches.length) {
    return <p className="text-[10px] text-muted-foreground py-2 italic">No dispatches.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="border-b border-border/50 text-muted-foreground">
            <th className="text-left pb-1 font-medium">Suburb</th>
            <th className="text-left pb-1 font-medium">Status</th>
            <th className="text-right pb-1 font-medium">Duration</th>
            <th className="text-right pb-1 font-medium">Fetched</th>
            <th className="text-right pb-1 font-medium">New</th>
            <th className="pb-1" />
          </tr>
        </thead>
        <tbody>
          {dispatches.map((d) => {
            const suburbs = Array.isArray(d.suburbs) && d.suburbs.length > 0 ? d.suburbs : null;
            const suburbLabel = suburbs ? suburbs.join(", ") : "—";
            let statusEl;
            if (d.status === "completed") {
              statusEl = (
                <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  done
                </span>
              );
            } else if (d.status === "running") {
              statusEl = (
                <span className="inline-flex items-center gap-0.5 text-blue-600 dark:text-blue-400 animate-pulse">
                  <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  running
                </span>
              );
            } else if (d.status === "failed") {
              statusEl = (
                <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
                  <XCircle className="h-2.5 w-2.5" />
                  failed
                </span>
              );
            } else {
              statusEl = <span className="text-muted-foreground">{d.status || "—"}</span>;
            }
            return (
              <tr
                key={d.id}
                className={cn(
                  "border-b border-border/30 last:border-0",
                  onDrill && "hover:bg-muted/30 cursor-pointer transition-colors"
                )}
                onClick={onDrill ? () => onDrill(d.id) : undefined}
              >
                <td className="py-1 pr-2 font-medium max-w-[140px] truncate" title={suburbLabel}>
                  {suburbLabel}
                </td>
                <td className="py-1 pr-2">{statusEl}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">
                  {fmtDurationSec(d.duration_sec)}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {d.status === "running" ? "—" : (d.records_fetched ?? 0)}
                </td>
                <td className="py-1 pr-2 text-right tabular-nums">
                  {d.status === "running" ? "—" : (d.records_new ?? 0)}
                </td>
                <td className="py-1">
                  {d.error_message && (
                    <span
                      className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400 text-[9px]"
                      title={d.error_message}
                    >
                      <AlertTriangle className="h-2.5 w-2.5" />
                      {String(d.error_message).slice(0, 40)}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// --- Single run summary block (latest run or historical entry) ---

function RunSummary({ run, isBoundingBox, expanded, onToggle, onDrillDispatch }) {
  const total = run.total_dispatches || 0;
  const succeeded = run.succeeded || 0;
  const failed = run.failed || 0;
  const inProgress = run.in_progress || 0;
  const allFailed = total > 0 && failed === total;
  const hasPartialFail = failed > 0 && failed < total;
  const runDurationSec = Math.max(
    0,
    Math.floor(
      (new Date(run.run_last_activity || run.run_started_at).getTime() -
        new Date(run.run_started_at).getTime()) /
        1000
    )
  );
  const isLongRunning = inProgress > 0 && runDurationSec > 600;

  // Tint based on state
  let tintClass = "";
  if (allFailed) tintClass = "border-red-400/60 bg-red-50/60 dark:bg-red-950/20";
  else if (hasPartialFail) tintClass = "border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20";
  else if (inProgress > 0) tintClass = "border-blue-400/60 bg-blue-50/60 dark:bg-blue-950/20";

  // Bounding-box special case: no progress bar, just status
  if (isBoundingBox) {
    const d = run.dispatches?.[0] || {};
    return (
      <div className={cn("rounded-md border px-2.5 py-2 text-[10px] space-y-1", tintClass)}>
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1 text-muted-foreground uppercase tracking-wide font-semibold">
            <Clock className="h-3 w-3" />
            Last run · {fmtRelativeTs(run.run_started_at)}
          </span>
          <TriggeredByBadge names={run.triggered_by_names} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {d.status === "completed" && (
            <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400 font-medium">
              <CheckCircle2 className="h-3 w-3" />
              completed
            </span>
          )}
          {d.status === "running" && (
            <span className="inline-flex items-center gap-1 text-blue-700 dark:text-blue-400 font-medium animate-pulse">
              <Loader2 className="h-3 w-3 animate-spin" />
              running…
            </span>
          )}
          {d.status === "failed" && (
            <span className="inline-flex items-center gap-1 text-red-700 dark:text-red-400 font-medium">
              <XCircle className="h-3 w-3" />
              failed
            </span>
          )}
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">
            {run.total_records_fetched?.toLocaleString() || 0} fetched
          </span>
          <span className="text-muted-foreground">·</span>
          <span className="tabular-nums">
            {run.total_records_new?.toLocaleString() || 0} new
          </span>
          <span className="text-muted-foreground">·</span>
          <span>{fmtDurationSec(d.duration_sec ?? runDurationSec)}</span>
        </div>
        {d.error_message && (
          <div className="pt-1 mt-1 border-t border-red-500/30 text-red-700 dark:text-red-400 font-mono break-all">
            {String(d.error_message).slice(0, 200)}
          </div>
        )}
      </div>
    );
  }

  // Per-suburb run
  return (
    <div className={cn("rounded-md border px-2.5 py-2 text-[10px] space-y-1.5", tintClass)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-muted-foreground uppercase tracking-wide font-semibold">
          <Clock className="h-3 w-3" />
          Last run · {fmtRelativeTs(run.run_started_at)}
          {isLongRunning && (
            <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400 ml-1 normal-case tracking-normal">
              <Clock className="h-2.5 w-2.5" />
              long-running
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5">
          <TriggeredByBadge names={run.triggered_by_names} />
          {onToggle && (
            <button
              type="button"
              onClick={onToggle}
              className="text-muted-foreground hover:text-foreground transition-colors"
              aria-label={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <RunProgressBar run={run} />

      {/* Status counters */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-medium">
          {succeeded + failed}/{total} suburbs
          {inProgress > 0 && (
            <span className="text-blue-600 dark:text-blue-400"> · {inProgress} in progress</span>
          )}
        </span>
        {allFailed && (
          <span className="text-red-700 dark:text-red-400 font-semibold">
            All {failed} dispatches failed
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 flex-wrap text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <CheckCircle2 className="h-3 w-3 text-emerald-500" />
          <span className="tabular-nums">{succeeded}</span> succeeded
        </span>
        {inProgress > 0 && (
          <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
            <Activity className="h-3 w-3 animate-pulse" />
            <span className="tabular-nums">{inProgress}</span> running
          </span>
        )}
        <span
          className={cn(
            "inline-flex items-center gap-1",
            failed > 0 && "text-red-600 dark:text-red-400 font-medium"
          )}
        >
          <XCircle className="h-3 w-3" />
          <span className="tabular-nums">{failed}</span> failed
        </span>
      </div>

      {/* Records + duration */}
      <div className="flex items-center gap-3 flex-wrap text-muted-foreground">
        <span>
          Records:{" "}
          <span className="font-medium text-foreground tabular-nums">
            {run.total_records_fetched?.toLocaleString() || 0}
          </span>{" "}
          fetched ·{" "}
          <span className="font-medium text-foreground tabular-nums">
            {run.total_records_new?.toLocaleString() || 0}
          </span>{" "}
          new
        </span>
        <span>·</span>
        <span>Duration: {fmtDurationSec(runDurationSec)}</span>
      </div>

      {/* Failed-suburbs list on partial fail */}
      {hasPartialFail && !expanded && (
        <div className="text-[10px] text-red-700 dark:text-red-400 border-t border-red-500/20 pt-1 mt-1">
          Failed:{" "}
          {run.dispatches
            ?.filter((d) => d.status === "failed")
            .flatMap((d) => d.suburbs || [])
            .slice(0, 5)
            .join(", ") || "(see detail)"}
        </div>
      )}

      {/* Expanded per-suburb detail */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/50">
          <DispatchTable dispatches={run.dispatches || []} onDrill={onDrillDispatch} />
        </div>
      )}
    </div>
  );
}

// --- Multi-run history list (compact single-line summaries) ---

function RunHistoryList({ runs, isBoundingBox, onDrillDispatch }) {
  const [expandedRunId, setExpandedRunId] = useState(null);
  if (!runs.length) return null;

  return (
    <div className="space-y-1">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Activity className="h-3 w-3" />
        Run history · {runs.length}
      </div>
      <div className="rounded-md border bg-background/60 divide-y divide-border/50">
        {runs.map((r) => {
          const key = `${r.source_id}__${r.run_bucket}`;
          const isOpen = expandedRunId === key;
          const total = r.total_dispatches || 0;
          const succeeded = r.succeeded || 0;
          const failed = r.failed || 0;
          const inProgress = r.in_progress || 0;
          const triggeredByName = r.triggered_by_names?.[0] || "—";

          return (
            <div key={key}>
              <button
                type="button"
                onClick={() => setExpandedRunId(isOpen ? null : key)}
                className="w-full px-2 py-1.5 text-[10px] text-left hover:bg-muted/30 transition-colors flex items-center gap-2"
              >
                <span className="text-muted-foreground tabular-nums w-[84px] shrink-0">
                  {fmtTs(r.run_started_at)}
                </span>
                {isBoundingBox ? (
                  <span className="tabular-nums">
                    {succeeded > 0 && (
                      <span className="text-emerald-600 dark:text-emerald-400">✓</span>
                    )}
                    {failed > 0 && <span className="text-red-600 dark:text-red-400">✗</span>}
                    {inProgress > 0 && (
                      <span className="text-blue-600 dark:text-blue-400 animate-pulse">●</span>
                    )}
                  </span>
                ) : (
                  <span className="tabular-nums font-medium">
                    <span className="text-emerald-600 dark:text-emerald-400">{succeeded}</span>/
                    <span>{total}</span>
                    {failed > 0 && (
                      <span className="text-red-600 dark:text-red-400"> · {failed}✗</span>
                    )}
                    {inProgress > 0 && (
                      <span className="text-blue-600 dark:text-blue-400 animate-pulse">
                        {" "}· {inProgress}●
                      </span>
                    )}
                  </span>
                )}
                <span className="text-muted-foreground tabular-nums">
                  {(r.total_records_fetched || 0).toLocaleString()} rec
                  {r.total_records_new > 0 && (
                    <span className="text-foreground"> ({r.total_records_new.toLocaleString()} new)</span>
                  )}
                </span>
                <span className="ml-auto text-muted-foreground truncate max-w-[90px]" title={triggeredByName}>
                  by {triggeredByName}
                </span>
                {isOpen ? (
                  <ChevronUp className="h-3 w-3 shrink-0" />
                ) : (
                  <ChevronDown className="h-3 w-3 shrink-0" />
                )}
              </button>
              {isOpen && (
                <div className="px-2 py-2 bg-muted/20">
                  <DispatchTable dispatches={r.dispatches || []} onDrill={onDrillDispatch} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// --- Empty-state: no runs yet ---

function NoRunsYet() {
  return (
    <div className="rounded-md border border-dashed px-2.5 py-3 text-center text-[10px] text-muted-foreground">
      No runs yet — click <span className="font-semibold">Run Now</span> to trigger.
    </div>
  );
}

// --- "Dispatched but no logs" placeholder ---

function DispatchedNoLogs() {
  return (
    <div className="rounded-md border px-2.5 py-2 text-[10px] space-y-1 border-blue-400/60 bg-blue-50/60 dark:bg-blue-950/20">
      <div className="flex items-center gap-1 font-medium text-blue-700 dark:text-blue-400">
        <Loader2 className="h-3 w-3 animate-spin" />
        Dispatched but no sync logs yet — syncs may be queuing
      </div>
    </div>
  );
}

// --- Source Card (enhanced) ---

function SourceCard({ source, lastLog, sourceConfig, pulseTimeline, activeSuburbCount, isRunning, onRun, onOpenPayload, onOpenSchedule, onDrillDispatch }) {
  const Icon = source.icon;
  const lastStatus = lastLog?.status;
  const [showInput, setShowInput] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);

  // Pull aggregated runs from the view. First run is the "latest"; rest are history.
  const { runs: syncRuns } = usePulseSyncRuns(source.source_id, 10);
  const latestRun = syncRuns[0] || null;
  const historyRuns = syncRuns.slice(1);
  const isBoundingBox =
    source.approach === "bounding_box" || source.source_id.startsWith("rea_listings_bb");

  // Detect "cron_dispatched" event without a matching sync_log (queuing state)
  const hasRecentDispatchWithoutLog = useMemo(() => {
    if (latestRun || !Array.isArray(pulseTimeline)) return false;
    const now = Date.now();
    return pulseTimeline.some((ev) => {
      if (ev.event_type !== "cron_dispatched") return false;
      const newVal = ev.new_value;
      if (newVal?.source_id && newVal.source_id !== source.source_id) return false;
      // For bounding-box, match on title containing the source label
      if (!newVal?.source_id && !(ev.title || "").includes(source.label.split(" ")[1] || "")) {
        return false;
      }
      const ageMs = now - new Date(ev.created_at).getTime();
      return ageMs < 10 * 60 * 1000; // within 10 minutes
    });
  }, [pulseTimeline, latestRun, source]);

  // Use last_run_at from source_configs if available, else fallback to last log timestamp
  const lastRunAt =
    latestRun?.run_started_at ||
    sourceConfig?.last_run_at ||
    lastLog?.completed_at ||
    lastLog?.started_at ||
    null;

  // Status traffic light
  let statusDot = "bg-gray-300";
  if (latestRun) {
    if (latestRun.in_progress > 0) statusDot = "bg-blue-500 animate-pulse";
    else if (latestRun.failed === latestRun.total_dispatches) statusDot = "bg-red-500";
    else if (latestRun.failed > 0) statusDot = "bg-amber-500";
    else if (latestRun.succeeded > 0) statusDot = "bg-emerald-500";
  } else if (lastStatus === "completed") statusDot = "bg-emerald-500";
  else if (lastStatus === "running") statusDot = "bg-blue-500 animate-pulse";
  else if (lastStatus === "failed") statusDot = "bg-red-500";

  // Red if >2 days old for daily sources, >9 days for weekly
  if (lastRunAt && statusDot !== "bg-blue-500 animate-pulse") {
    const ageMs = Date.now() - new Date(lastRunAt).getTime();
    const ageDays = ageMs / 86400000;
    const limit = source.schedule?.includes("Weekly") ? 9 : 2;
    if (ageDays > limit && lastStatus !== "failed") statusDot = "bg-amber-500";
  }

  const perRunEstimate = source.approach === "per_suburb"
    ? (activeSuburbCount || 0) * (source.perSuburb || 0)
    : source.defaultMax;

  return (
    <Card className={cn(
      "rounded-xl border shadow-sm hover:shadow-md transition-shadow bg-gradient-to-br",
      source.accentClass,
    )}>
      <CardContent className="p-4 flex flex-col gap-3">
        {/* Header row: icon + label + Apify link */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="p-2 rounded-lg bg-background/80 shrink-0 border shadow-sm">
              <Icon className={cn("h-4 w-4", source.color)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm font-semibold leading-tight truncate">{source.label}</p>
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusDot)} title={lastStatus || "never run"} />
              </div>
              <a
                href={source.apify_url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors mt-0.5 font-mono"
              >
                {source.actor_slug}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </div>
          </div>
        </div>

        {/* Approach section */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] px-1.5 py-0 uppercase tracking-wide font-semibold",
                source.approach === "per_suburb"
                  ? "border-indigo-400/50 text-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-cyan-400/50 text-cyan-700 bg-cyan-50 dark:bg-cyan-900/30 dark:text-cyan-300",
              )}
            >
              {source.approach === "per_suburb" ? <Repeat className="h-2.5 w-2.5 mr-1" /> : <Globe className="h-2.5 w-2.5 mr-1" />}
              {source.approachLabel}
            </Badge>
          </div>
          {source.approach === "per_suburb" ? (
            <PerSuburbDiagram suburbCount={activeSuburbCount} perSuburb={source.perSuburb} />
          ) : (
            <BoundingBoxDiagram region={source.bboxRegion} maxItems={source.defaultMax} />
          )}
        </div>

        {/* Collapsible Input block */}
        <div className="space-y-1">
          <button
            type="button"
            onClick={() => setShowInput((v) => !v)}
            className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
          >
            <FileCode2 className="h-3 w-3" />
            <span>Input</span>
            {showInput ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
          {showInput && (
            <div className="rounded-md bg-background/80 border p-2 space-y-0.5 font-mono text-[10px]">
              {source.input_params.map((p) => (
                <div key={p.key} className="flex items-start gap-2 leading-tight">
                  <span className="text-primary/80 shrink-0">{p.key}:</span>
                  <span className="text-foreground break-all">{p.value}</span>
                  {p.note && (
                    <span className="text-muted-foreground text-[9px] shrink-0 ml-auto italic">{p.note}</span>
                  )}
                </div>
              ))}
              {source.approach === "bounding_box" && source.bboxCoords && (
                <div className="pt-1 mt-1 border-t text-[9px] text-muted-foreground">
                  BBox NW {source.bboxCoords.nw.lat}, {source.bboxCoords.nw.lng} · SE {source.bboxCoords.se.lat}, {source.bboxCoords.se.lng}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Last run summary — uses pulse_sync_runs view (multi-dispatch aware) */}
        {latestRun ? (
          <RunSummary
            run={latestRun}
            isBoundingBox={isBoundingBox}
            expanded={runExpanded}
            onToggle={isBoundingBox ? null : () => setRunExpanded((v) => !v)}
            onDrillDispatch={onDrillDispatch}
          />
        ) : hasRecentDispatchWithoutLog ? (
          <DispatchedNoLogs />
        ) : (
          <NoRunsYet />
        )}

        {/* Next run + cost, small line */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Next: <span className="font-medium text-foreground">{nextCronLabel(source.schedule)}</span>
          </span>
          <span className="flex items-center gap-1">
            <Coins className="h-3 w-3" />
            <span className="font-medium text-foreground">{source.cost_note}</span>
          </span>
        </div>

        {/* Multi-run history (collapsed list) */}
        {historyRuns.length > 0 && (
          <RunHistoryList
            runs={historyRuns.slice(0, 5)}
            isBoundingBox={isBoundingBox}
            onDrillDispatch={onDrillDispatch}
          />
        )}

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => onRun(source)}
            disabled={isRunning}
          >
            {isRunning ? (
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                Running...
              </>
            ) : (
              "Run Now"
            )}
          </Button>
          {lastLog && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px]"
              onClick={() => onOpenPayload(lastLog)}
              title="View last payload"
            >
              <Eye className="h-3 w-3" />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => onOpenSchedule(source)}
            title="View schedule details"
          >
            <Calendar className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Cron Schedule Table ---

function CronScheduleTable({ runningSources, lastLogBySource, sourceConfigByIdMap }) {
  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          Scheduled Runs
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b">
              <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Schedule</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Last Run</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Next Run</th>
              <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
            </tr>
          </thead>
          <tbody>
            {CRON_SCHEDULE.map((row) => {
              const config = sourceConfigByIdMap?.[row.source_id];
              const lastRun = config?.last_run_at || lastLogBySource?.[row.source_id]?.started_at;
              return (
                <tr key={row.source_id} className="border-b last:border-0">
                  <td className="py-2 pr-3 font-medium">{row.label}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{row.schedule}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{fmtRelativeTs(lastRun)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{nextCronLabel(row.schedule)}</td>
                  <td className="py-2">
                    {runningSources.has(row.source_id) ? (
                      <Badge className="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 text-[10px] px-1.5 py-0 animate-pulse">
                        Running
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">Scheduled</Badge>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

// --- Sync History Table ---

function SyncHistory({ syncLogs, onDrill }) {
  const recent = useMemo(() => syncLogs.slice(0, 20), [syncLogs]);

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Database className="h-4 w-4 text-muted-foreground" />
          Sync History
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{recent.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 overflow-x-auto">
        {recent.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">No sync logs yet.</p>
        ) : (
          <table className="w-full text-xs min-w-[560px]">
            <thead>
              <tr className="border-b">
                <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Started</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Duration</th>
                <th className="text-left pb-2 font-medium text-muted-foreground">Records</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {recent.map((log) => (
                <tr key={log.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                  <td className="py-2 pr-3 font-medium max-w-[180px] truncate">{log.source_label || log.source_id || "—"}</td>
                  <td className="py-2 pr-3"><StatusBadge status={log.status} /></td>
                  <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{fmtTs(log.started_at)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{fmtDuration(log.started_at, log.completed_at)}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{recordsSummary(log)}</td>
                  <td className="py-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => onDrill(log)}
                      title="View raw payload"
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

// --- Suburb Pool ---

function SuburbPool({ targetSuburbs }) {
  const [newSuburb, setNewSuburb] = useState("");

  const handleAdd = useCallback(async () => {
    const name = newSuburb.trim();
    if (!name) return;
    try {
      await api.entities.PulseTargetSuburb.create({ name, is_active: true, region: "Greater Sydney", priority: 5 });
      await refetchEntityList("PulseTargetSuburb");
      setNewSuburb("");
      toast.success(`Added suburb: ${name}`);
    } catch (err) {
      toast.error(`Failed to add suburb: ${err.message}`);
    }
  }, [newSuburb]);

  const handleToggle = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.update(suburb.id, { is_active: !suburb.is_active });
      await refetchEntityList("PulseTargetSuburb");
    } catch (err) {
      toast.error(`Failed to update: ${err.message}`);
    }
  }, []);

  const handleDelete = useCallback(async (suburb) => {
    try {
      await api.entities.PulseTargetSuburb.delete(suburb.id);
      await refetchEntityList("PulseTargetSuburb");
      toast.success(`Removed ${suburb.name}`);
    } catch (err) {
      toast.error(`Failed to remove: ${err.message}`);
    }
  }, []);

  const sorted = useMemo(
    () => [...targetSuburbs].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)),
    [targetSuburbs]
  );

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <MapPin className="h-4 w-4 text-muted-foreground" />
          Suburb Pool
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {targetSuburbs.filter((s) => s.is_active).length} active
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {/* Add row */}
        <div className="flex items-center gap-2">
          <Input
            placeholder="Add suburb..."
            value={newSuburb}
            onChange={(e) => setNewSuburb(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            className="h-7 text-xs flex-1"
          />
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={handleAdd}>
            <Plus className="h-3 w-3" />
          </Button>
        </div>

        {/* Suburb list */}
        {sorted.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-2">No suburbs configured.</p>
        ) : (
          <div className="space-y-1 max-h-64 overflow-y-auto pr-1">
            {sorted.map((s) => (
              <div
                key={s.id}
                className={cn(
                  "flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs transition-colors",
                  s.is_active ? "bg-muted/40" : "bg-muted/10 opacity-60"
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium truncate">{s.name}</span>
                  {s.region && (
                    <span className="text-[10px] text-muted-foreground shrink-0">{s.region}</span>
                  )}
                  {s.priority != null && (
                    <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">
                      P{s.priority}
                    </Badge>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    className="text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => handleToggle(s)}
                    title={s.is_active ? "Deactivate" : "Activate"}
                  >
                    {s.is_active ? (
                      <ToggleRight className="h-4 w-4 text-emerald-500" />
                    ) : (
                      <ToggleLeft className="h-4 w-4" />
                    )}
                  </button>
                  <button
                    className="text-muted-foreground hover:text-red-500 transition-colors"
                    onClick={() => handleDelete(s)}
                    title="Remove suburb"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// --- Schedule Dialog ---

function ScheduleDialog({ source, onClose }) {
  if (!source) return null;
  return (
    <Dialog open={!!source} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Calendar className="h-4 w-4" />
            Schedule: {source.label}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1 text-muted-foreground">Cadence</div>
            <div className="col-span-2 font-medium">{source.schedule}</div>
            <div className="col-span-1 text-muted-foreground">Time</div>
            <div className="col-span-2 font-medium">{source.scheduleHint}</div>
            <div className="col-span-1 text-muted-foreground">Next run</div>
            <div className="col-span-2 font-medium">{nextCronLabel(source.schedule)}</div>
            <div className="col-span-1 text-muted-foreground">Approach</div>
            <div className="col-span-2 font-medium">{source.approachLabel}</div>
            <div className="col-span-1 text-muted-foreground">Actor</div>
            <div className="col-span-2">
              <a href={source.apify_url} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline inline-flex items-center gap-1">
                {source.actor_slug}
                <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <div className="col-span-1 text-muted-foreground">Cost estimate</div>
            <div className="col-span-2 font-medium">{source.cost_note}</div>
          </div>
          <div className="rounded-md bg-muted/40 border p-2 text-[10px] text-muted-foreground">
            <strong>Note:</strong> Cost estimates are approximate based on typical Apify pay-per-result pricing. Actual cost depends on current actor pricing and may vary.
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// --- Drill-through Dialog ---

const DRILL_PAGE_SIZE = 50;

function DrillPayloadRow({ item, index }) {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    if (!item) return "—";
    const name = item.name || item.agent_name || item.address || item.listing_id || `Item ${index + 1}`;
    const sub = item.suburb || item.agency_name || item.agent_id || "";
    return sub ? `${name} — ${sub}` : name;
  }, [item, index]);

  return (
    <div className="border-b last:border-0">
      <button
        className="w-full flex items-center justify-between px-3 py-2 text-xs text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium truncate pr-2">{preview}</span>
        {expanded ? <ChevronUp className="h-3 w-3 shrink-0" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
      </button>
      {expanded && (
        <pre className="bg-muted/30 text-[10px] px-3 py-2 overflow-x-auto rounded-b-md whitespace-pre-wrap break-all">
          {JSON.stringify(item, null, 2)}
        </pre>
      )}
    </div>
  );
}

function DrillDialog({ log, onClose }) {
  const [agentsPage, setAgentsPage] = useState(0);
  const [listingsPage, setListingsPage] = useState(0);

  const payload = log?.raw_payload ?? {};
  const agents   = useMemo(() => Array.isArray(payload?.rea_agents) ? payload.rea_agents : Array.isArray(payload?.agents) ? payload.agents : [], [payload]);
  const listings = useMemo(() => Array.isArray(payload?.listings) ? payload.listings : [], [payload]);
  const hasAgents   = agents.length > 0;
  const hasListings = listings.length > 0;

  const defaultTab = hasAgents ? "agents" : hasListings ? "listings" : "raw";

  return (
    <Dialog open={!!log} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="text-sm">
            Raw Payload — {log?.source_label || log?.source_id || "Sync Log"}
            <span className="text-muted-foreground font-normal ml-2 text-xs">{fmtTs(log?.started_at)}</span>
          </DialogTitle>
        </DialogHeader>
        <Tabs defaultValue={defaultTab} className="flex-1 flex flex-col overflow-hidden">
          <TabsList className="shrink-0 h-8 text-xs">
            {hasAgents   && <TabsTrigger value="agents"   className="text-xs h-7">{`Agents (${agents.length})`}</TabsTrigger>}
            {hasListings && <TabsTrigger value="listings" className="text-xs h-7">{`Listings (${listings.length})`}</TabsTrigger>}
            <TabsTrigger value="raw" className="text-xs h-7">Raw JSON</TabsTrigger>
          </TabsList>

          {hasAgents && (
            <TabsContent value="agents" className="flex-1 overflow-y-auto mt-2">
              <DrillPaginatedList items={agents} page={agentsPage} setPage={setAgentsPage} />
            </TabsContent>
          )}
          {hasListings && (
            <TabsContent value="listings" className="flex-1 overflow-y-auto mt-2">
              <DrillPaginatedList items={listings} page={listingsPage} setPage={setListingsPage} />
            </TabsContent>
          )}
          <TabsContent value="raw" className="flex-1 overflow-y-auto mt-2">
            <pre className="text-[10px] bg-muted/30 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(payload, null, 2)}
            </pre>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function DrillPaginatedList({ items, page, setPage }) {
  const totalPages = Math.ceil(items.length / DRILL_PAGE_SIZE);
  const slice = items.slice(page * DRILL_PAGE_SIZE, (page + 1) * DRILL_PAGE_SIZE);

  return (
    <div className="space-y-0 border rounded-lg overflow-hidden">
      {/* Pagination header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/40 border-b text-[10px] text-muted-foreground">
        <span>{items.length} items</span>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost" size="sm" className="h-5 w-5 p-0"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >&lsaquo;</Button>
          <span>Page {page + 1} / {totalPages || 1}</span>
          <Button
            variant="ghost" size="sm" className="h-5 w-5 p-0"
            disabled={page >= totalPages - 1}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
          >&rsaquo;</Button>
        </div>
      </div>
      {/* Rows */}
      {slice.map((item, i) => (
        <DrillPayloadRow key={page * DRILL_PAGE_SIZE + i} item={item} index={page * DRILL_PAGE_SIZE + i} />
      ))}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function PulseDataSources({ syncLogs = [], sourceConfigs = [], targetSuburbs = [], pulseTimeline = [], stats = {}, user }) {
  const [runningSources, setRunningSources] = useState(new Set());
  const [drillLog, setDrillLog] = useState(null);
  const [scheduleSource, setScheduleSource] = useState(null);

  const activeSuburbCount = useMemo(() => targetSuburbs.filter((s) => s.is_active).length, [targetSuburbs]);

  // Open the drill dialog for a given sync_log id (looked up in the list first,
  // else fetched directly). Used by the per-suburb DispatchTable row clicks —
  // we only have IDs in the pulse_sync_runs view, not full payloads.
  const handleDrillDispatch = useCallback(
    async (syncLogId) => {
      if (!syncLogId) return;
      const existing = syncLogs.find((l) => l.id === syncLogId);
      if (existing) {
        setDrillLog(existing);
        return;
      }
      try {
        const log = await api.entities.PulseSyncLog.get(syncLogId);
        if (log) setDrillLog(log);
      } catch (err) {
        toast.error(`Could not load payload: ${err.message}`);
      }
    },
    [syncLogs]
  );

  // Last log per source
  const lastLogBySource = useMemo(() => {
    const map = {};
    for (const log of syncLogs) {
      const sid = log.source_id;
      if (!sid) continue;
      if (!map[sid] || new Date(log.started_at) > new Date(map[sid].started_at)) {
        map[sid] = log;
      }
    }
    return map;
  }, [syncLogs]);

  // Source config by source_id
  const sourceConfigByIdMap = useMemo(() => {
    const map = {};
    for (const c of sourceConfigs) {
      if (c.source_id) map[c.source_id] = c;
    }
    return map;
  }, [sourceConfigs]);

  const runSource = useCallback(async (source) => {
    setRunningSources((prev) => new Set([...prev, source.source_id]));
    try {
      // Route through pulseFireScrapes (lightweight dispatcher) instead of
      // pulseDataSync directly. pulseDataSync for per-suburb sources would
      // iterate through 148+ active suburbs synchronously, far exceeding the
      // ~150s edge function CPU budget. pulseFireScrapes:
      //   - per-suburb: fires individual fire-and-forget pulseDataSync calls
      //     (staggered 2s apart, capped via max_suburbs)
      //   - bounding-box: fires a single pulseDataSync call
      // It also logs cron_dispatched timeline events and updates last_run_at.
      const isBoundingBox = source.approach === "bounding_box" ||
                            source.source_id.startsWith("rea_listings_bb");
      const fireParams = isBoundingBox
        ? { source_id: source.source_id }
        : {
            source_id: source.source_id,
            min_priority: 0,
            // Cap at 20 suburbs per manual run. 20 staggered Apify calls take
            // ~40s total to dispatch; any more risks hitting the function wall
            // clock. Users can rerun for the next batch.
            max_suburbs: 20,
          };
      const { data } = await api.functions.invoke("pulseFireScrapes", fireParams);
      const dispatched = data?.dispatched ?? 0;
      if (data?.success === false) {
        toast.warning(data?.message || `${source.label}: already running`);
      } else if (isBoundingBox) {
        toast.success(`${source.label} dispatched — sync log will appear shortly`);
      } else {
        toast.success(`${source.label}: ${dispatched} suburb${dispatched === 1 ? "" : "s"} dispatched`);
      }
      setTimeout(() => {
        refetchEntityList("PulseSyncLog");
        refetchEntityList("PulseTimeline");
        refetchEntityList("PulseSourceConfig");
      }, 5000);
    } catch (err) {
      toast.error(`Failed: ${err.message}`);
    } finally {
      setRunningSources((prev) => {
        const n = new Set(prev);
        n.delete(source.source_id);
        return n;
      });
    }
  }, [targetSuburbs, user]);

  // Totals for header summary
  const perSuburbSources = SOURCES.filter((s) => s.approach === "per_suburb");
  const boundingBoxSources = SOURCES.filter((s) => s.approach === "bounding_box");

  return (
    <div className="space-y-5">
      {/* ── Header summary ── */}
      <Card className="rounded-xl border shadow-sm bg-gradient-to-br from-primary/5 via-background to-background">
        <CardContent className="p-4 flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">{SOURCES.length} data sources</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Repeat className="h-3.5 w-3.5" />
            <span>{perSuburbSources.length} per-suburb (iterates {activeSuburbCount} suburbs)</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            <span>{boundingBoxSources.length} bounding-box (single call, Greater Sydney)</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <MapPin className="h-3.5 w-3.5" />
            <span>{activeSuburbCount} active suburbs in pool</span>
          </div>
        </CardContent>
      </Card>

      {/* ── Source cards grid ── */}
      <div>
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
          Data Sources
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {SOURCES.map((source) => (
            <SourceCard
              key={source.source_id}
              source={source}
              lastLog={lastLogBySource[source.source_id]}
              sourceConfig={sourceConfigByIdMap[source.source_id]}
              pulseTimeline={pulseTimeline}
              activeSuburbCount={activeSuburbCount}
              isRunning={runningSources.has(source.source_id)}
              onRun={runSource}
              onOpenPayload={setDrillLog}
              onOpenSchedule={setScheduleSource}
              onDrillDispatch={handleDrillDispatch}
            />
          ))}
        </div>
      </div>

      {/* ── Cron schedule + Suburb pool side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CronScheduleTable
          runningSources={runningSources}
          lastLogBySource={lastLogBySource}
          sourceConfigByIdMap={sourceConfigByIdMap}
        />
        <SuburbPool targetSuburbs={targetSuburbs} />
      </div>

      {/* ── Sync history ── */}
      <SyncHistory syncLogs={syncLogs} onDrill={setDrillLog} />

      {/* ── Dialogs ── */}
      {drillLog && (
        <DrillDialog log={drillLog} onClose={() => setDrillLog(null)} />
      )}
      {scheduleSource && (
        <ScheduleDialog source={scheduleSource} onClose={() => setScheduleSource(null)} />
      )}
    </div>
  );
}

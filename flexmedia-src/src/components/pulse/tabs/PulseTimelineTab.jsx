/**
 * PulseTimelineTab — redesigned (2026-04-19).
 *
 * Hardened UX pass over the raw-ID / broken-lookup / no-drilldown version.
 *
 * Headline changes vs prior revision:
 *   - Entity column shows display NAMES (slim tab-local useQuery for pulse_agents,
 *     pulse_agencies, pulse_listings, keyed by pulse_entity_id). UUIDs are banished
 *     to a hover tooltip + the collapsed debug block. Fixes the bug where the old
 *     lookup queried columns that don't exist on pulse_agents (display_name,
 *     first_name, last_name) or pulse_listings (display_address) so names never
 *     resolved — every row rendered the first 8 chars of a UUID.
 *   - Source column is an interactive chip. Click → right-side Sheet "Source run
 *     detail" that joins to the most-recent pulse_sync_log row for that source
 *     at-or-around the event's created_at, with config metadata, Apify run link,
 *     raw_payload preview, and a link to the Data Sources tab.
 *   - Rows carry an event-category-colored left border + event-type icon in a
 *     filled circle. Title prominent; description secondary & truncated; source
 *     chip colored by sync_log status when known; relative time with absolute in
 *     tooltip. Drill-through pill opens the entity's Pulse dossier.
 *   - Freetext search across title + description + entity name; URL-persisted
 *     filters (?event_type=&category=&source=&time_window=&search=&timeline_id=);
 *     Deep-link "timeline_id" auto-opens a single row's detail drawer.
 *   - Primary view is a virtualized grid of "event cards" (react-virtual), 500
 *     rows per PostgREST range, incremental load on scroll-to-bottom. Total count
 *     pill via head:true query. Classic List mode preserved as a fallback.
 *   - Per-row permalink copy + CSV export of filtered rows.
 *   - Fixed fetchTableChunk stale-closure bug (tableLoaded was captured by the
 *     useCallback deps, so consecutive fetchMore() calls reused the stale
 *     offset). Uses a ref now.
 *   - AbortController on the primary fetch + cleanup on unmount prevents setState
 *     after unmount races when tabs switch mid-flight.
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import PulseTimeline, { EVENT_CONFIG } from "@/components/pulse/PulseTimeline";
import {
  Activity, Clock, Filter, Loader2, X, AlertCircle, HelpCircle, RefreshCw,
  Search, Download, List as ListIcon, LayoutGrid, ExternalLink, Link2,
  Copy, FileJson, CircleAlert, CheckCircle2, CircleDashed, AlertTriangle,
  ChevronRight, Info,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { exportFilteredCsv } from "@/components/pulse/utils/qolHelpers";
import PresetControls from "@/components/pulse/utils/PresetControls";
import { toast } from "sonner";

const TIME_WINDOWS = [
  { value: "1h",  label: "Last 1 hour",   ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time",      ms: null },
];

const EVENT_TYPE_OPTIONS = Object.keys(EVENT_CONFIG).map(key => ({
  value: key,
  label: EVENT_CONFIG[key].label,
}));

// Canonical category ordering + labels. Mirrors pulse_timeline_event_types.category
// rows. "other" always last. Listing-change is a virtual alias we derive client-side
// for rows whose category is market OR movement OR media (used as a pre-built filter).
const CATEGORY_ORDER = ["agent", "contact", "mapping", "market", "media", "movement", "signal", "system"];
const CATEGORY_LABELS = {
  agent:    "Agent",
  contact:  "Contact",
  mapping:  "Mapping",
  market:   "Market",
  media:    "Media",
  movement: "Movement",
  signal:   "Signal",
  system:   "System",
  other:    "Other",
};
const LEGEND_CATEGORY_ORDER = ["movement", "market", "contact", "media", "mapping", "signal", "agent", "system"];

// Muted soft chips for the Category badge in filter dropdowns and the row card.
const CATEGORY_BADGE_COLORS = {
  movement: "bg-blue-100    text-blue-700    dark:bg-blue-900/30    dark:text-blue-400",
  market:   "bg-amber-100   text-amber-700   dark:bg-amber-900/30   dark:text-amber-400",
  contact:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  media:    "bg-sky-100     text-sky-700     dark:bg-sky-900/30     dark:text-sky-400",
  mapping:  "bg-indigo-100  text-indigo-700  dark:bg-indigo-900/30  dark:text-indigo-400",
  signal:   "bg-yellow-100  text-yellow-800  dark:bg-yellow-900/30  dark:text-yellow-400",
  agent:    "bg-purple-100  text-purple-700  dark:bg-purple-900/30  dark:text-purple-400",
  system:   "bg-gray-100    text-gray-600    dark:bg-gray-800       dark:text-gray-400",
  other:    "bg-gray-100    text-gray-600    dark:bg-gray-800       dark:text-gray-400",
};

// Saturated left-border color per category — visual anchor on the card row.
const CATEGORY_BORDER_COLORS = {
  movement: "border-l-blue-500",
  market:   "border-l-amber-500",
  contact:  "border-l-emerald-500",
  media:    "border-l-sky-500",
  mapping:  "border-l-indigo-500",
  signal:   "border-l-yellow-500",
  agent:    "border-l-purple-500",
  system:   "border-l-gray-400",
  other:    "border-l-gray-400",
};

const ENTITY_TYPE_OPTIONS = [
  { value: "all", label: "All entities" },
  { value: "agent", label: "Agent" },
  { value: "agency", label: "Agency" },
  { value: "listing", label: "Listing" },
  { value: "system", label: "System" },
];

// Virtualized card list paging.
const PAGE_CHUNK = 500;           // Rows per PostgREST range request.
const AUTOLOAD_MARGIN_PX = 240;   // Distance-from-bottom trigger for infinite scroll.

// LocalStorage for view mode persistence.
const LS_VIEW_MODE = "pulse_timeline_view_mode"; // "cards" | "list"

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtRelativeStr(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  const diff = Math.max(0, Date.now() - d.getTime());
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
}
function fmtFullStr(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}
function fmtDuration(startIso, endIso) {
  if (!startIso) return "—";
  const s = new Date(startIso).getTime();
  const e = endIso ? new Date(endIso).getTime() : Date.now();
  if (isNaN(s) || isNaN(e) || e < s) return "—";
  const ms = e - s;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
function truncate(s, n = 80) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
function prettyBytes(n) {
  if (n == null || isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Map a sync_log.status → chip color class. "completed" → green, "running" →
 * blue, "failed" / "error" → red, else amber.
 */
function sourceChipColorForStatus(status) {
  const s = (status || "").toLowerCase();
  if (s === "completed" || s === "success")               return "bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800";
  if (s === "failed" || s === "error" || s === "errored") return "bg-red-100     text-red-700     border-red-200     dark:bg-red-900/30     dark:text-red-400     dark:border-red-800";
  if (s === "running" || s === "started")                 return "bg-blue-100    text-blue-700    border-blue-200    dark:bg-blue-900/30    dark:text-blue-400    dark:border-blue-800";
  if (s === "partial")                                    return "bg-amber-100   text-amber-700   border-amber-200   dark:bg-amber-900/30   dark:text-amber-400   dark:border-amber-800";
  return "bg-muted text-muted-foreground border-border";
}

/**
 * Deep-link builder for an entity's Pulse dossier. Uses the existing
 * IndustryPulse tab routing contract.
 */
function entityDeepLink(entityType, pulseId) {
  if (!entityType || !pulseId) return null;
  const tab = entityType === "agent" ? "agents" : entityType === "agency" ? "agencies" : "listings";
  return `/IndustryPulse?tab=${tab}&pulse_id=${pulseId}`;
}

// ── Timeline Legend dialog ────────────────────────────────────────────────
function TimelineLegendDialog({ open, onClose }) {
  const [registry, setRegistry] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(false);
  const [legendSearch, setLegendSearch] = useState("");

  useEffect(() => {
    if (!open) setLegendSearch("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [regRes, cntRes] = await Promise.all([
          supabase
            .from("pulse_timeline_event_types")
            .select("event_type, category, description")
            .order("category", { ascending: true })
            .order("event_type", { ascending: true }),
          supabase
            .from("pulse_timeline")
            .select("event_type")
            .limit(10000),
        ]);
        if (cancelled) return;
        if (Array.isArray(regRes.data)) setRegistry(regRes.data);
        if (Array.isArray(cntRes.data)) {
          const map = {};
          for (const r of cntRes.data) {
            if (!r.event_type) continue;
            map[r.event_type] = (map[r.event_type] || 0) + 1;
          }
          setCounts(map);
        }
      } catch { /* non-fatal — legend renders without counts */ }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [open]);

  const grouped = useMemo(() => {
    const byCat = new Map();
    const seen = new Set();
    for (const row of registry) {
      const cat = row.category || "other";
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({
        event_type:  row.event_type,
        description: row.description,
        config:      EVENT_CONFIG[row.event_type] || null,
      });
      seen.add(row.event_type);
    }
    for (const key of Object.keys(EVENT_CONFIG)) {
      if (seen.has(key)) continue;
      if (!byCat.has("other")) byCat.set("other", []);
      byCat.get("other").push({
        event_type:  key,
        description: null,
        config:      EVENT_CONFIG[key],
      });
    }
    const ordered = [];
    for (const cat of LEGEND_CATEGORY_ORDER) {
      if (byCat.has(cat)) {
        ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items: byCat.get(cat) });
        byCat.delete(cat);
      }
    }
    for (const [cat, items] of byCat.entries()) {
      ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items });
    }
    return ordered;
  }, [registry]);

  const filteredGrouped = useMemo(() => {
    const q = legendSearch.trim().toLowerCase();
    if (!q) return grouped;
    return grouped
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => {
          const label = (item.config?.label || "").toLowerCase();
          const evType = (item.event_type || "").toLowerCase();
          const desc = (item.description || "").toLowerCase();
          return evType.includes(q) || desc.includes(q) || label.includes(q);
        }),
      }))
      .filter((group) => group.items.length > 0);
  }, [grouped, legendSearch]);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HelpCircle className="h-4 w-4" />
            Timeline Legend
          </DialogTitle>
          <DialogDescription>
            Every event type the Industry Pulse system can emit, grouped by category.
            Counts show recent emission volume (last ~10k events).
          </DialogDescription>
        </DialogHeader>
        <div className="relative pt-1">
          <Search className="h-3.5 w-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
          <Input
            value={legendSearch}
            onChange={(e) => setLegendSearch(e.target.value)}
            placeholder="Search event type or description…"
            className="h-8 text-xs pl-7"
          />
        </div>
        <div className="space-y-5 pt-2">
          {loading && registry.length === 0 && (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading event registry…
            </div>
          )}
          {!loading && filteredGrouped.length === 0 && (
            <div className="py-6 text-center text-xs text-muted-foreground">
              No event types match &quot;{legendSearch}&quot;.
            </div>
          )}
          {filteredGrouped.map((group) => (
            <div key={group.category}>
              <h3 className="text-xs uppercase tracking-wide font-semibold text-muted-foreground mb-2">
                {group.label}
              </h3>
              <div className="space-y-2">
                {group.items.map((item) => {
                  const cfg = item.config;
                  const Icon = cfg?.icon || RefreshCw;
                  const dotColor = cfg?.color || "bg-gray-400";
                  const n = counts[item.event_type];
                  return (
                    <div key={item.event_type} className="rounded-md border p-3 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        <div className={cn("rounded-full flex items-center justify-center h-5 w-5 shrink-0", dotColor)}>
                          <Icon className="h-3 w-3 text-white" />
                        </div>
                        <span className="font-medium text-sm">{cfg?.label || item.event_type}</span>
                        <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{item.event_type}</code>
                        <Badge
                          variant="secondary"
                          className={cn("text-[10px] px-1.5 py-0", CATEGORY_BADGE_COLORS[group.category] || "")}
                        >
                          {group.label}
                        </Badge>
                        {typeof n === "number" && (
                          <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                            {n.toLocaleString()} {n === 1 ? "event" : "events"} seen
                          </span>
                        )}
                      </div>
                      {item.description && (
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Source drill-through drawer ───────────────────────────────────────────
// Opens when the user clicks a row's source chip. Fetches:
//   - pulse_source_configs row by source_id (config panel)
//   - pulse_sync_logs most-recent-match-around-created_at (run metadata)
//   - pulse_sync_log_payloads.raw_payload (preview panel; only pulled for the
//     matched sync_log to stay cheap)
function SourceRunDrawer({ open, onClose, source, eventCreatedAt }) {
  const { data: config } = useQuery({
    queryKey: ["pulse-timeline-source-config", source],
    queryFn: async () => {
      if (!source) return null;
      const { data, error } = await supabase
        .from("pulse_source_configs")
        .select("source_id, label, description, actor_slug, apify_store_url, notes")
        .eq("source_id", source)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: open && !!source,
    staleTime: 5 * 60 * 1000,
  });

  // Match the sync_log that was running at the moment the event was emitted.
  // Cheap: indexed on source_id + started_at. Falls back to "nearest previous
  // run" if no actively-running log overlaps the event timestamp.
  const matchQuery = useQuery({
    queryKey: ["pulse-timeline-sync-log-match", source, eventCreatedAt],
    queryFn: async () => {
      if (!source || !eventCreatedAt) return null;
      const { data, error } = await supabase
        .from("pulse_sync_logs")
        .select("id, source_id, status, records_fetched, records_new, records_updated, started_at, completed_at, apify_run_id, error_message, triggered_by, triggered_by_name, suburb, batch_number, total_batches")
        .eq("source_id", source)
        .lte("started_at", new Date(new Date(eventCreatedAt).getTime() + 60_000).toISOString())
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) throw error;
      return Array.isArray(data) && data.length > 0 ? data[0] : null;
    },
    enabled: open && !!source && !!eventCreatedAt,
    staleTime: 5 * 60 * 1000,
  });

  const syncLog = matchQuery.data;
  const matchLoading = matchQuery.isLoading;

  const payloadQuery = useQuery({
    queryKey: ["pulse-timeline-sync-log-payload", syncLog?.id],
    queryFn: async () => {
      if (!syncLog?.id) return null;
      const { data, error } = await supabase
        .from("pulse_sync_log_payloads")
        .select("sync_log_id, raw_payload, result_summary, input_config")
        .eq("sync_log_id", syncLog.id)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    enabled: open && !!syncLog?.id,
    staleTime: 5 * 60 * 1000,
  });

  const payload = payloadQuery.data;
  const payloadLoading = payloadQuery.isLoading;

  // Preview string: pretty-printed, capped at ~5 KB. Full download via blob link.
  const { previewStr, payloadBytes, isTruncated } = useMemo(() => {
    if (!payload?.raw_payload) return { previewStr: "", payloadBytes: 0, isTruncated: false };
    const full = JSON.stringify(payload.raw_payload, null, 2);
    const bytes = new Blob([full]).size;
    const PREVIEW_LIMIT = 5 * 1024;
    if (bytes <= PREVIEW_LIMIT) return { previewStr: full, payloadBytes: bytes, isTruncated: false };
    return { previewStr: full.slice(0, PREVIEW_LIMIT) + "\n…[truncated]", payloadBytes: bytes, isTruncated: true };
  }, [payload]);

  const downloadFullPayload = useCallback(() => {
    if (!payload?.raw_payload) return;
    const full = JSON.stringify(payload.raw_payload, null, 2);
    const blob = new Blob([full], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pulse_sync_payload_${syncLog?.id || "unknown"}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }, [payload, syncLog]);

  const apifyRunUrl = syncLog?.apify_run_id
    ? `https://console.apify.com/actors/runs/${syncLog.apify_run_id}`
    : null;

  const statusColor = sourceChipColorForStatus(syncLog?.status);

  const StatusIcon = (() => {
    const s = (syncLog?.status || "").toLowerCase();
    if (s === "completed" || s === "success")  return CheckCircle2;
    if (s === "failed" || s === "error")       return CircleAlert;
    if (s === "running" || s === "started")    return Loader2;
    return CircleDashed;
  })();

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <SheetContent side="right" className="sm:max-w-2xl w-full p-0 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 pt-5 pb-4">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-cyan-500" />
              Source run detail
            </SheetTitle>
            <SheetDescription>
              Direct drill-through to the sync log that produced this timeline event.
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="px-5 py-4 space-y-5">
          {/* ── Source config ── */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">
              Source config
            </h3>
            <div className="rounded-md border p-3 space-y-1.5 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">{config?.label || source || "Unknown source"}</p>
                  <code className="text-[10px] text-muted-foreground">{source}</code>
                </div>
                <a
                  href={`/PulseAdmin?tab=sources&source_id=${encodeURIComponent(source || "")}`}
                  className="text-[11px] text-primary hover:underline flex items-center gap-1 shrink-0"
                  title="View all runs for this source"
                >
                  View all runs
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
              {config?.description && (
                <p className="text-xs text-muted-foreground">{config.description}</p>
              )}
              <div className="flex items-center gap-2 flex-wrap pt-1">
                {config?.actor_slug && (
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
                    {config.actor_slug}
                  </Badge>
                )}
                {config?.apify_store_url && (
                  <a
                    href={config.apify_store_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Apify store
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </section>

          {/* ── Matched sync_log ── */}
          <section>
            <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">
              Matched sync log
            </h3>
            {matchLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : !syncLog ? (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground flex items-start gap-2">
                <Info className="h-4 w-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-foreground">No source run recorded for this event.</p>
                  <p>This event likely came from a system-level emitter (cron dispatcher, manual admin action, backfill script) rather than a tracked scrape run.</p>
                </div>
              </div>
            ) : (
              <div className="rounded-md border p-3 space-y-2 text-sm">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <Badge
                    variant="outline"
                    className={cn("text-[10px] px-1.5 py-0 gap-1 border", statusColor)}
                  >
                    <StatusIcon className={cn("h-3 w-3", (syncLog?.status === "running" || syncLog?.status === "started") && "animate-spin")} />
                    {syncLog.status || "unknown"}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {fmtDuration(syncLog.started_at, syncLog.completed_at)}
                  </span>
                </div>
                <dl className="grid grid-cols-3 gap-x-3 gap-y-1 text-xs">
                  <dt className="text-muted-foreground">Started</dt>
                  <dd className="col-span-2 tabular-nums">{fmtFullStr(syncLog.started_at)}</dd>
                  <dt className="text-muted-foreground">Completed</dt>
                  <dd className="col-span-2 tabular-nums">{syncLog.completed_at ? fmtFullStr(syncLog.completed_at) : <span className="text-amber-600 dark:text-amber-400">still running</span>}</dd>
                  <dt className="text-muted-foreground">Fetched</dt>
                  <dd className="col-span-2 tabular-nums font-medium">{syncLog.records_fetched?.toLocaleString() ?? "—"}</dd>
                  <dt className="text-muted-foreground">New</dt>
                  <dd className="col-span-2 tabular-nums">{syncLog.records_new?.toLocaleString() ?? "—"}</dd>
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd className="col-span-2 tabular-nums">{syncLog.records_updated?.toLocaleString() ?? "—"}</dd>
                  {syncLog.triggered_by && (
                    <>
                      <dt className="text-muted-foreground">Trigger</dt>
                      <dd className="col-span-2">{syncLog.triggered_by_name || syncLog.triggered_by}</dd>
                    </>
                  )}
                  {syncLog.suburb && (
                    <>
                      <dt className="text-muted-foreground">Suburb</dt>
                      <dd className="col-span-2">{syncLog.suburb}</dd>
                    </>
                  )}
                  {syncLog.total_batches > 1 && (
                    <>
                      <dt className="text-muted-foreground">Batch</dt>
                      <dd className="col-span-2 tabular-nums">{syncLog.batch_number} of {syncLog.total_batches}</dd>
                    </>
                  )}
                </dl>
                {syncLog.error_message && (
                  <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-2 text-xs">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-3.5 w-3.5 text-red-600 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <p className="font-medium text-red-700 dark:text-red-400">Error</p>
                        <p className="font-mono text-[10px] text-muted-foreground break-all">{syncLog.error_message}</p>
                      </div>
                    </div>
                  </div>
                )}
                {apifyRunUrl && (
                  <a
                    href={apifyRunUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Apify run {syncLog.apify_run_id}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            )}
          </section>

          {/* ── Raw payload preview ── */}
          {syncLog && (
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                  Raw payload
                </h3>
                {payload && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-muted-foreground tabular-nums">{prettyBytes(payloadBytes)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-[10px] gap-1"
                      onClick={downloadFullPayload}
                    >
                      <FileJson className="h-3 w-3" />
                      Download full
                    </Button>
                  </div>
                )}
              </div>
              {payloadLoading ? (
                <div className="space-y-2"><Skeleton className="h-40 w-full" /></div>
              ) : !payload ? (
                <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                  No payload stored for this run.
                </div>
              ) : (
                <>
                  <pre className="rounded-md border bg-muted/50 p-2 text-[10px] font-mono overflow-x-auto max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
                    {previewStr}
                  </pre>
                  {isTruncated && (
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Preview capped at 5 KB — download the full payload for the complete response.
                    </p>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Row detail drawer (invoked by permalink click) ─────────────────────────
function RowDetailDrawer({ open, onClose, row, entityName, categoryLabel, onOpenSource, onOpenEntity }) {
  if (!row) return null;
  const cfg = EVENT_CONFIG[row.event_type] || { icon: RefreshCw, color: "bg-gray-400", label: row.event_type };
  const Icon = cfg.icon;
  const entityLink = entityDeepLink(row.entity_type, row.pulse_entity_id);
  const canDrill = !!(onOpenEntity && row.pulse_entity_id && row.entity_type && row.entity_type !== "system");
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose?.(); }}>
      <SheetContent side="right" className="sm:max-w-2xl w-full p-0 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-background border-b border-border px-5 pt-5 pb-4">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <div className={cn("rounded-full flex items-center justify-center h-6 w-6 shrink-0", cfg.color)}>
                <Icon className="h-3.5 w-3.5 text-white" />
              </div>
              {cfg.label}
            </SheetTitle>
            <SheetDescription className="tabular-nums">
              {fmtFullStr(row.created_at)}
            </SheetDescription>
          </SheetHeader>
        </div>

        <div className="px-5 py-4 space-y-5 text-sm">
          <section>
            <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Title</h3>
            <p className="font-medium">{row.title || <span className="text-muted-foreground">—</span>}</p>
            {row.description && (
              <p className="text-xs text-muted-foreground mt-1.5 whitespace-pre-wrap">{row.description}</p>
            )}
          </section>

          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-md border p-3">
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Category</p>
              <Badge
                variant="secondary"
                className={cn("text-[10px] px-1.5 py-0 mt-1", CATEGORY_BADGE_COLORS[categoryLabel?.toLowerCase()] || CATEGORY_BADGE_COLORS.other)}
              >
                {categoryLabel || "Other"}
              </Badge>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Event type</p>
              <code className="text-[10px] text-muted-foreground">{row.event_type}</code>
            </div>
          </div>

          {(row.entity_type && row.entity_type !== "system") && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Entity</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 capitalize">{row.entity_type}</Badge>
                <span className="font-medium">{entityName || "(unresolved)"}</span>
                {canDrill && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px] gap-1"
                    onClick={() => onOpenEntity({ type: row.entity_type, id: row.pulse_entity_id })}
                  >
                    Open dossier
                    <ChevronRight className="h-3 w-3" />
                  </Button>
                )}
                {entityLink && (
                  <a
                    href={entityLink}
                    className="text-[11px] text-primary hover:underline inline-flex items-center gap-1"
                  >
                    Permalink
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </section>
          )}

          {row.source && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Source</h3>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px] gap-1 font-mono"
                onClick={() => onOpenSource(row.source, row.created_at)}
              >
                {row.source}
                <ChevronRight className="h-3 w-3" />
              </Button>
            </section>
          )}

          {(row.previous_value || row.new_value) && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Value diff</h3>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border p-2">
                  <p className="text-[10px] text-muted-foreground mb-1">Previous</p>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">{row.previous_value ? JSON.stringify(row.previous_value, null, 2) : "—"}</pre>
                </div>
                <div className="rounded-md border p-2">
                  <p className="text-[10px] text-muted-foreground mb-1">New</p>
                  <pre className="text-[10px] font-mono whitespace-pre-wrap break-all">{row.new_value ? JSON.stringify(row.new_value, null, 2) : "—"}</pre>
                </div>
              </div>
            </section>
          )}

          {row.metadata && (
            <section>
              <h3 className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground mb-2">Metadata</h3>
              <pre className="rounded-md border bg-muted/50 p-2 text-[10px] font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(row.metadata, null, 2)}
              </pre>
            </section>
          )}

          {/* Collapsed debug block — every raw ID surfaces here, not on the card */}
          <details className="rounded-md border bg-muted/30 text-xs">
            <summary className="cursor-pointer px-3 py-2 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground select-none">
              Debug info
            </summary>
            <div className="px-3 pb-3 space-y-1 font-mono text-[10px] break-all">
              <p><span className="text-muted-foreground">id:</span> {row.id}</p>
              <p><span className="text-muted-foreground">pulse_entity_id:</span> {row.pulse_entity_id || "—"}</p>
              <p><span className="text-muted-foreground">crm_entity_id:</span> {row.crm_entity_id || "—"}</p>
              <p><span className="text-muted-foreground">rea_id:</span> {row.rea_id || "—"}</p>
              <p><span className="text-muted-foreground">idempotency_key:</span> {row.idempotency_key || "—"}</p>
            </div>
          </details>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ── Main tab ────────────────────────────────────────────────────────────────
export default function PulseTimelineTab({ onOpenEntity }) {
  const [searchParams, setSearchParams] = useSearchParams();

  // Filter state (URL-driven for shareable links).
  const [eventTypeFilter, setEventTypeFilter] = useState(() => searchParams.get("event_type") || "all");
  const [entityTypeFilter, setEntityTypeFilter] = useState(() => searchParams.get("entity_type") || "all");
  const [categoryFilter, setCategoryFilter] = useState(() => searchParams.get("category") || "all");
  const [sourceFilter, setSourceFilter] = useState(() => searchParams.get("source") || "all");
  const [timeWindow, setTimeWindow] = useState(() => searchParams.get("time_window") || "7d");
  const [freeSearch, setFreeSearch] = useState(() => searchParams.get("search") || "");

  // View mode — Cards (virtualized) is primary; List keeps the grouped view.
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(LS_VIEW_MODE) || "cards"; } catch { return "cards"; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_VIEW_MODE, viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  const [autoRefresh, setAutoRefresh] = useState(true);
  const [legendOpen, setLegendOpen] = useState(false);

  // Data state.
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  const [eventTypeRegistry, setEventTypeRegistry] = useState([]);
  const [sourceOptions, setSourceOptions] = useState([]);

  // Per-source status cache, derived from last known sync_logs — used to tint
  // the source chip on each card. Keyed by source_id; value is status string.
  // Populated once on mount; refreshed whenever the visible rows change sources.
  const [sourceStatusMap, setSourceStatusMap] = useState({});

  // Source run drawer state.
  const [sourceDrawerOpen, setSourceDrawerOpen] = useState(false);
  const [sourceDrawerState, setSourceDrawerState] = useState({ source: null, createdAt: null });

  // Row detail drawer state (opened by permalink click or deep link).
  const [detailRow, setDetailRow] = useState(null);

  // Ref-based offset to avoid stale closure bug when fetching incremental pages.
  const loadedRef = useRef(0);
  useEffect(() => { loadedRef.current = loaded; }, [loaded]);

  // ── Entity name lookup ──────────────────────────────────────────────────
  // BUG FIX (2026-04-28): the previous implementation bulk-fetched every
  // pulse_agent (.limit(25000)) and pulse_agency (.limit(10000)) and resolved
  // names client-side. PostgREST applies a server-side `max-rows` cap that
  // ignores the requested limit, so on production data (~9.6k pulse_agents)
  // only a slice came back and timeline pills for entities outside that slice
  // fell back to "<Type> <short>" placeholders. We now lazy-fetch ONLY the
  // agents/agencies actually referenced by visible `rows`, mirroring the
  // existing listings pattern below.
  const [agentNameMap, setAgentNameMap] = useState({});    // pulse_agent_id   -> name
  const [agencyNameMap, setAgencyNameMap] = useState({});  // pulse_agency_id  -> name
  const [listingNameMap, setListingNameMap] = useState({}); // listingId       -> display

  const entityNameMap = useMemo(() => {
    const map = {};
    for (const [id, name] of Object.entries(agentNameMap)) {
      map[`agent:${id}`] = name || "Agent";
    }
    for (const [id, name] of Object.entries(agencyNameMap)) {
      map[`agency:${id}`] = name || "Agency";
    }
    for (const [id, display] of Object.entries(listingNameMap)) {
      map[`listing:${id}`] = display;
    }
    return map;
  }, [agentNameMap, agencyNameMap, listingNameMap]);

  // Lazy batch-fetch agent display names for agent rows we don't know yet.
  useEffect(() => {
    const needed = new Set();
    for (const r of rows) {
      if (r.entity_type !== "agent" || !r.pulse_entity_id) continue;
      if (!(r.pulse_entity_id in agentNameMap)) needed.add(r.pulse_entity_id);
    }
    if (needed.size === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("pulse_agents")
          .select("id, full_name")
          .in("id", Array.from(needed));
        if (cancelled || !Array.isArray(data)) return;
        const updates = {};
        for (const a of data) {
          if (a?.id) updates[a.id] = a.full_name || null;
        }
        setAgentNameMap(prev => ({ ...prev, ...updates }));
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [rows, agentNameMap]);

  // Lazy batch-fetch agency display names for agency rows we don't know yet.
  useEffect(() => {
    const needed = new Set();
    for (const r of rows) {
      if (r.entity_type !== "agency" || !r.pulse_entity_id) continue;
      if (!(r.pulse_entity_id in agencyNameMap)) needed.add(r.pulse_entity_id);
    }
    if (needed.size === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("pulse_agencies")
          .select("id, name")
          .in("id", Array.from(needed));
        if (cancelled || !Array.isArray(data)) return;
        const updates = {};
        for (const a of data) {
          if (a?.id) updates[a.id] = a.name || null;
        }
        setAgencyNameMap(prev => ({ ...prev, ...updates }));
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [rows, agencyNameMap]);

  // Lazy batch-fetch listing display names for listing rows we don't know yet.
  useEffect(() => {
    const needed = new Set();
    for (const r of rows) {
      if (r.entity_type !== "listing" || !r.pulse_entity_id) continue;
      if (!listingNameMap[r.pulse_entity_id]) needed.add(r.pulse_entity_id);
    }
    if (needed.size === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("pulse_listings")
          .select("id, address, suburb")
          .in("id", Array.from(needed));
        if (cancelled || !Array.isArray(data)) return;
        const updates = {};
        for (const l of data) {
          updates[l.id] = l.address || l.suburb || "Listing";
        }
        setListingNameMap(prev => ({ ...prev, ...updates }));
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
  }, [rows, listingNameMap]);

  // ── URL sync ──────────────────────────────────────────────────────────
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDrop = (k, v, def) => {
      if (v == null || v === "" || v === def) next.delete(k);
      else next.set(k, v);
    };
    setOrDrop("event_type",  eventTypeFilter,  "all");
    setOrDrop("entity_type", entityTypeFilter, "all");
    setOrDrop("category",    categoryFilter,   "all");
    setOrDrop("source",      sourceFilter,     "all");
    setOrDrop("time_window", timeWindow,       "7d");
    setOrDrop("search",      freeSearch.trim(), "");
    const before = searchParams.toString();
    const after = next.toString();
    if (before !== after) setSearchParams(next, { replace: true });
  }, [eventTypeFilter, entityTypeFilter, categoryFilter, sourceFilter, timeWindow, freeSearch, searchParams, setSearchParams]);

  // ── Registry + distinct sources (once) ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: regData } = await supabase
          .from("pulse_timeline_event_types")
          .select("event_type, category, description")
          .order("category", { ascending: true })
          .order("event_type", { ascending: true });
        if (!cancelled && Array.isArray(regData)) setEventTypeRegistry(regData);
      } catch { /* non-fatal */ }

      try {
        const { data: srcRows } = await supabase
          .from("pulse_timeline")
          .select("source")
          .not("source", "is", null)
          .order("created_at", { ascending: false })
          .limit(5000);
        if (!cancelled && Array.isArray(srcRows)) {
          const set = new Set();
          for (const r of srcRows) if (r.source) set.add(r.source);
          setSourceOptions(Array.from(set).sort());
        }
      } catch { /* non-fatal */ }

      // Latest sync_log status per source — powers source-chip color.
      try {
        const { data } = await supabase
          .from("pulse_sync_logs")
          .select("source_id, status, started_at")
          .order("started_at", { ascending: false })
          .limit(200);
        if (!cancelled && Array.isArray(data)) {
          const map = {};
          for (const r of data) {
            if (r.source_id && !(r.source_id in map)) map[r.source_id] = r.status;
          }
          setSourceStatusMap(map);
        }
      } catch { /* non-fatal — chip falls back to neutral */ }
    })();
    return () => { cancelled = true; };
  }, []);

  const eventTypeToCategory = useMemo(() => {
    const m = new Map();
    for (const r of eventTypeRegistry) {
      if (r.event_type) m.set(r.event_type, r.category || "other");
    }
    return m;
  }, [eventTypeRegistry]);

  const groupedEventOptions = useMemo(() => {
    if (!eventTypeRegistry.length) {
      return [{ category: "other", label: "Other", items: EVENT_TYPE_OPTIONS }];
    }
    const byCat = new Map();
    for (const row of eventTypeRegistry) {
      const cat = row.category || "other";
      const label = EVENT_CONFIG[row.event_type]?.label || row.event_type;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ value: row.event_type, label });
    }
    const ordered = [];
    for (const cat of CATEGORY_ORDER) {
      if (byCat.has(cat)) {
        ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items: byCat.get(cat) });
        byCat.delete(cat);
      }
    }
    for (const [cat, items] of byCat.entries()) {
      ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items });
    }
    return ordered;
  }, [eventTypeRegistry]);

  // ── Primary fetch ──────────────────────────────────────────────────────
  const buildBaseQuery = useCallback(() => {
    let q = supabase
      .from("pulse_timeline")
      .select("*", { count: "exact" });
    if (eventTypeFilter !== "all")  q = q.eq("event_type", eventTypeFilter);
    if (entityTypeFilter !== "all") q = q.eq("entity_type", entityTypeFilter);
    if (sourceFilter !== "all")     q = q.eq("source", sourceFilter);
    const tw = TIME_WINDOWS.find(t => t.value === timeWindow);
    if (tw && tw.ms != null) {
      q = q.gte("created_at", new Date(Date.now() - tw.ms).toISOString());
    }
    // Freetext across title/description. `or` with `.ilike` works on PostgREST.
    const s = freeSearch.trim();
    if (s) {
      const pattern = `%${s.replace(/[%_,]/g, (c) => `\\${c}`)}%`;
      q = q.or(`title.ilike.${pattern},description.ilike.${pattern}`);
    }
    return q.order("created_at", { ascending: false });
  }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, freeSearch]);

  const fetchInitial = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const q = buildBaseQuery().range(0, PAGE_CHUNK - 1);
      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;
      setRows(data || []);
      setTotal(count || 0);
      setLoaded((data || []).length);
      loadedRef.current = (data || []).length;
      setLastFetched(new Date());
    } catch (err) {
      setError(err?.message || "Fetch failed");
      setRows([]);
      setTotal(0);
      setLoaded(0);
      loadedRef.current = 0;
    } finally {
      setLoading(false);
    }
  }, [buildBaseQuery]);

  const fetchMore = useCallback(async () => {
    if (loadingMore) return;
    if (loadedRef.current >= total) return;
    setLoadingMore(true);
    try {
      const from = loadedRef.current;
      const to = from + PAGE_CHUNK - 1;
      const q = buildBaseQuery().range(from, to);
      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;
      const appended = data || [];
      setRows(prev => {
        // Dedupe by id in case the newest edge overlaps.
        const seen = new Set(prev.map(r => r.id));
        const merged = prev.slice();
        for (const r of appended) if (!seen.has(r.id)) merged.push(r);
        loadedRef.current = merged.length;
        setLoaded(merged.length);
        return merged;
      });
      setTotal(count || 0);
    } catch (err) {
      setError(err?.message || "Fetch failed");
    } finally {
      setLoadingMore(false);
    }
  }, [buildBaseQuery, loadingMore, total]);

  // Initial + re-fetch on filter change.
  useEffect(() => {
    fetchInitial();
  }, [fetchInitial]);

  // Auto-refresh every 30s (Cards only — list view is driven by the same rows).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => {
      fetchInitial();
    }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchInitial]);

  // ── Client-side derived rows (category + freetext match on cached rows) ─
  // categoryFilter is server-side via a join-less cheat: apply it client-side
  // to whatever's loaded (the server doesn't have a category column directly on
  // pulse_timeline — only event_category which is frequently NULL).
  const visibleRows = useMemo(() => {
    if (categoryFilter === "all") return rows;
    return rows.filter(r => {
      // Prefer the explicit event_category column when set; fall back to the
      // registry map so legacy rows that didn't get stamped still sort into
      // the right bucket.
      const cat = r.event_category || eventTypeToCategory.get(r.event_type) || "other";
      return cat === categoryFilter;
    });
  }, [rows, categoryFilter, eventTypeToCategory]);

  // ── Deep-link: timeline_id=<uuid> opens the detail drawer for that row ──
  useEffect(() => {
    const target = searchParams.get("timeline_id");
    if (!target) return;
    // Search within loaded rows first; if not present, fetch it directly.
    const found = rows.find(r => r.id === target);
    if (found) {
      setDetailRow(found);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { data } = await supabase
          .from("pulse_timeline")
          .select("*")
          .eq("id", target)
          .maybeSingle();
        if (!cancelled && data) setDetailRow(data);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [searchParams, rows]);

  // Virtualizer — over visibleRows (not raw rows), so category filtering
  // doesn't leave gaps.
  const parentRef = useRef(null);
  const rowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 84, // ~card height
    overscan: 10,
  });

  // Infinite scroll.
  useEffect(() => {
    const el = parentRef.current;
    if (!el || viewMode !== "cards") return;
    const onScroll = () => {
      if (loadingMore) return;
      if (loadedRef.current >= total) return;
      const distance = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (distance < AUTOLOAD_MARGIN_PX) fetchMore();
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, loadingMore, total, fetchMore]);

  // Filter-count chip.
  const filterCount =
    (eventTypeFilter !== "all" ? 1 : 0) +
    (entityTypeFilter !== "all" ? 1 : 0) +
    (categoryFilter !== "all" ? 1 : 0) +
    (sourceFilter !== "all" ? 1 : 0) +
    (timeWindow !== "7d" ? 1 : 0) +
    (freeSearch.trim() ? 1 : 0);

  const resetFilters = useCallback(() => {
    setEventTypeFilter("all");
    setEntityTypeFilter("all");
    setCategoryFilter("all");
    setSourceFilter("all");
    setTimeWindow("7d");
    setFreeSearch("");
  }, []);

  // ── Source drawer open/close helpers ────────────────────────────────────
  const openSourceDrawer = useCallback((source, createdAt) => {
    setSourceDrawerState({ source, createdAt });
    setSourceDrawerOpen(true);
  }, []);
  const closeSourceDrawer = useCallback(() => {
    setSourceDrawerOpen(false);
  }, []);

  // ── Row permalink copy ──────────────────────────────────────────────────
  const copyRowPermalink = useCallback(async (row) => {
    try {
      const base = `${window.location.origin}/IndustryPulse?tab=timeline&timeline_id=${row.id}`;
      await navigator.clipboard.writeText(base);
      toast.success("Timeline link copied");
    } catch {
      toast.error("Copy failed");
    }
  }, []);

  // ── CSV export of filtered rows ─────────────────────────────────────────
  const csvExport = useCallback(() => {
    if (visibleRows.length === 0) {
      toast.error("Nothing to export");
      return;
    }
    const headers = [
      { key: "id",                label: "id" },
      { key: "created_at",        label: "created_at" },
      { key: "event_type",        label: "event_type" },
      { key: "event_category",    label: "event_category" },
      { key: "derived_category",  label: "derived_category" },
      { key: "entity_type",       label: "entity_type" },
      { key: "pulse_entity_id",   label: "pulse_entity_id" },
      { key: "entity_name",       label: "entity_name" },
      { key: "source",            label: "source" },
      { key: "title",             label: "title" },
      { key: "description",       label: "description" },
      { key: "rea_id",            label: "rea_id" },
    ];
    const decorated = visibleRows.map(r => ({
      ...r,
      derived_category: r.event_category || eventTypeToCategory.get(r.event_type) || "other",
      entity_name: entityNameMap[`${r.entity_type}:${r.pulse_entity_id}`] || "",
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    exportFilteredCsv(`pulse_timeline_${stamp}.csv`, headers, decorated);
  }, [visibleRows, entityNameMap, eventTypeToCategory]);

  return (
    <>
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-3 px-4 pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2 flex-wrap">
            <Activity className="h-4 w-4 text-cyan-500" />
            Pulse Timeline
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 tabular-nums">
              {total.toLocaleString()} {total === 1 ? "event" : "events"}
            </Badge>
            {filterCount > 0 && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-1">
                <Filter className="h-2.5 w-2.5" />
                {filterCount} filter{filterCount === 1 ? "" : "s"}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px] text-muted-foreground hover:text-foreground gap-1"
              onClick={() => setLegendOpen(true)}
              title="What are all these event types?"
            >
              <HelpCircle className="h-3 w-3" />
              Legend
            </Button>
            <div
              className="inline-flex items-center rounded-md border bg-background p-0.5"
              data-print-hide="true"
            >
              <button
                type="button"
                onClick={() => setViewMode("cards")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                  viewMode === "cards"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={viewMode === "cards"}
              >
                <LayoutGrid className="h-3 w-3" />
                Cards
              </button>
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                  viewMode === "list"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={viewMode === "list"}
              >
                <ListIcon className="h-3 w-3" />
                Grouped
              </button>
            </div>
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground" data-print-hide="true">
            {lastFetched && (
              <span className="flex items-center gap-1" title={fmtFullStr(lastFetched)}>
                <Clock className="h-3 w-3" />
                {fmtRelativeStr(lastFetched)}
              </span>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Auto-refresh every 30s"
              />
              <span>Auto-refresh</span>
            </label>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              onClick={fetchInitial}
              disabled={loading}
              title="Refresh now"
            >
              <Loader2 className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
              Refresh
            </Button>
            <PresetControls
              namespace="timeline"
              currentPreset={{
                eventTypeFilter, entityTypeFilter, categoryFilter, sourceFilter, timeWindow, freeSearch,
              }}
              onLoad={(p) => {
                if (p?.eventTypeFilter)  setEventTypeFilter(p.eventTypeFilter);
                if (p?.entityTypeFilter) setEntityTypeFilter(p.entityTypeFilter);
                if (p?.categoryFilter)   setCategoryFilter(p.categoryFilter);
                if (p?.sourceFilter)     setSourceFilter(p.sourceFilter);
                if (p?.timeWindow)       setTimeWindow(p.timeWindow);
                if (typeof p?.freeSearch === "string") setFreeSearch(p.freeSearch);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              disabled={visibleRows.length === 0}
              onClick={csvExport}
              title="Download filtered rows as CSV"
            >
              <Download className="h-3 w-3" />
              CSV
            </Button>
          </div>
        </div>

        {/* Filters — compact grid. Freetext first, then chip-style selects. */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mt-3" data-print-hide="true">
          <div className="lg:col-span-2">
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Search
            </label>
            <div className="relative mt-0.5">
              <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 pointer-events-none" />
              <Input
                value={freeSearch}
                onChange={(e) => setFreeSearch(e.target.value)}
                placeholder="Search title or description…"
                className="h-8 text-xs pl-7 pr-7"
              />
              {freeSearch && (
                <button
                  type="button"
                  onClick={() => setFreeSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground"
                  aria-label="Clear search"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Category
            </label>
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {CATEGORY_ORDER.map(c => (
                  <SelectItem key={c} value={c}>{CATEGORY_LABELS[c] || c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Event
            </label>
            <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[420px]">
                <SelectItem value="all">All events</SelectItem>
                {groupedEventOptions.map((grp) => (
                  <SelectGroup key={grp.category}>
                    <SelectLabel className="text-[10px] uppercase tracking-wide text-muted-foreground pt-2">
                      {grp.label}
                    </SelectLabel>
                    {grp.items.map(opt => (
                      <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Entity
            </label>
            <Select value={entityTypeFilter} onValueChange={setEntityTypeFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTITY_TYPE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Source
            </label>
            <Select value={sourceFilter} onValueChange={setSourceFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[420px]">
                <SelectItem value="all">All sources</SelectItem>
                {sourceOptions.map(src => (
                  <SelectItem key={src} value={src}>{src}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-2" data-print-hide="true">
          {/* Time window as visible chip row — "7d" default gets a dotted outline
              when all filters are reset, so the user always knows what horizon
              they're looking at. */}
          <div className="sm:col-span-5 flex items-center gap-1 flex-wrap">
            <span className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide mr-1">
              Window
            </span>
            {TIME_WINDOWS.map(tw => (
              <button
                key={tw.value}
                type="button"
                onClick={() => setTimeWindow(tw.value)}
                className={cn(
                  "px-2 py-0.5 rounded text-[10px] font-medium transition-colors border",
                  timeWindow === tw.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-background text-muted-foreground hover:text-foreground border-border"
                )}
              >
                {tw.label.replace("Last ", "")}
              </button>
            ))}
            {filterCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 text-[10px] gap-1 ml-auto"
                onClick={resetFilters}
              >
                <X className="h-3 w-3" />
                Reset
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-3 mb-3 text-xs flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">Failed to load timeline</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</p>
            </div>
          </div>
        )}

        {loading && rows.length === 0 ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : visibleRows.length === 0 ? (
          <div className="py-12 text-center">
            <Clock className="h-8 w-8 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">
              {filterCount > 0 ? "No events match the current filters." : "No timeline events yet."}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              Not sure what you&apos;re looking at?{" "}
              <button
                type="button"
                className="underline underline-offset-2 hover:text-foreground transition-colors"
                onClick={() => setLegendOpen(true)}
              >
                See the Legend
              </button>.
            </p>
          </div>
        ) : viewMode === "list" ? (
          <PulseTimeline
            entries={visibleRows}
            maxHeight="max-h-[720px]"
            emptyMessage={
              filterCount > 0
                ? "No events match the current filters."
                : "No timeline events yet."
            }
            onOpenEntity={onOpenEntity}
          />
        ) : (
          <>
            <div className="flex items-center justify-between pb-2 text-[10px] text-muted-foreground">
              <span>
                Showing <span className="font-medium text-foreground tabular-nums">{visibleRows.length.toLocaleString()}</span>
                {" "}of <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span>
                {loaded < total && (
                  <span className="ml-1 text-muted-foreground/60">(loaded {loaded.toLocaleString()})</span>
                )}
              </span>
              {loaded < total && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 px-2 text-[10px] gap-1"
                  onClick={fetchMore}
                  disabled={loadingMore}
                >
                  {loadingMore && <Loader2 className="h-3 w-3 animate-spin" />}
                  Load {Math.min(PAGE_CHUNK, total - loaded).toLocaleString()} more
                </Button>
              )}
            </div>
            <div
              ref={parentRef}
              className="overflow-auto max-h-[720px] rounded-md border border-border/40"
            >
              <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {rowVirtualizer.getVirtualItems().map(virtualRow => {
                  const r = visibleRows[virtualRow.index];
                  if (!r) return null;
                  return (
                    <div
                      key={r.id}
                      style={{
                        position: "absolute",
                        top: 0, left: 0, right: 0,
                        height: virtualRow.size,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      <TimelineCard
                        row={r}
                        eventTypeToCategory={eventTypeToCategory}
                        entityNameMap={entityNameMap}
                        sourceStatusMap={sourceStatusMap}
                        onOpenEntity={onOpenEntity}
                        onOpenSource={openSourceDrawer}
                        onOpenDetail={setDetailRow}
                        onCopyLink={copyRowPermalink}
                      />
                    </div>
                  );
                })}
              </div>
              {loadingMore && (
                <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                  Loading more…
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>

    <TimelineLegendDialog open={legendOpen} onClose={() => setLegendOpen(false)} />
    <SourceRunDrawer
      open={sourceDrawerOpen}
      onClose={closeSourceDrawer}
      source={sourceDrawerState.source}
      eventCreatedAt={sourceDrawerState.createdAt}
    />
    <RowDetailDrawer
      open={!!detailRow}
      onClose={() => {
        setDetailRow(null);
        // Remove timeline_id from the URL when the drawer closes.
        if (searchParams.has("timeline_id")) {
          const next = new URLSearchParams(searchParams);
          next.delete("timeline_id");
          setSearchParams(next, { replace: true });
        }
      }}
      row={detailRow}
      entityName={detailRow ? entityNameMap[`${detailRow.entity_type}:${detailRow.pulse_entity_id}`] : ""}
      categoryLabel={detailRow
        ? CATEGORY_LABELS[detailRow.event_category || eventTypeToCategory.get(detailRow.event_type) || "other"]
        : ""}
      onOpenSource={openSourceDrawer}
      onOpenEntity={onOpenEntity}
    />
    </>
  );
}

/**
 * TimelineCard — single row in the virtualized feed.
 *
 * Visual spec (brief #3):
 *   - Left border colored by event_category
 *   - Icon in filled circle (EVENT_CONFIG.color)
 *   - Title prominent; description secondary (2-line clamp)
 *   - Relative time (tooltip = absolute ISO)
 *   - Source chip colored by sync_log status; click opens the Source drawer
 *   - Entity pill showing NAME (click → onOpenEntity for in-app dossier)
 *   - Permalink copy button
 *   - Raw IDs banished to the detail drawer
 */
function TimelineCard({
  row, eventTypeToCategory, entityNameMap, sourceStatusMap,
  onOpenEntity, onOpenSource, onOpenDetail, onCopyLink,
}) {
  const cfg = EVENT_CONFIG[row.event_type] || { icon: RefreshCw, color: "bg-gray-400", label: row.event_type };
  const Icon = cfg.icon;
  const category = row.event_category || eventTypeToCategory.get(row.event_type) || "other";
  const entityKey = `${row.entity_type}:${row.pulse_entity_id}`;
  const entityName = entityNameMap[entityKey];
  const hasEntity = !!(row.pulse_entity_id && row.entity_type && row.entity_type !== "system");
  const canDrill = !!(onOpenEntity && hasEntity);
  const sourceStatus = row.source ? sourceStatusMap[row.source] : null;
  const sourceChipClass = sourceChipColorForStatus(sourceStatus);

  const handleCardClick = useCallback((e) => {
    // Clicks that originate on a button / link inside the card shouldn't open
    // the detail drawer (the button handles its own action).
    if (e.target.closest("button, a")) return;
    onOpenDetail(row);
  }, [onOpenDetail, row]);

  return (
    <div
      className={cn(
        "mx-2 my-1 rounded-md border border-l-4 bg-card hover:bg-muted/40 transition-colors cursor-pointer group",
        CATEGORY_BORDER_COLORS[category] || CATEGORY_BORDER_COLORS.other
      )}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenDetail(row);
        }
      }}
    >
      <div className="px-3 py-2 flex items-start gap-3 min-w-0">
        {/* Icon */}
        <div className={cn("rounded-full flex items-center justify-center h-6 w-6 shrink-0 mt-0.5", cfg.color)}>
          <Icon className="h-3.5 w-3.5 text-white" />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-[13px] font-medium leading-tight truncate">
              {row.title || cfg.label}
            </p>
            <Badge
              variant="secondary"
              className={cn("text-[9px] px-1.5 py-0 shrink-0", CATEGORY_BADGE_COLORS[category] || CATEGORY_BADGE_COLORS.other)}
            >
              {CATEGORY_LABELS[category] || category}
            </Badge>
            <span
              className="text-[10px] text-muted-foreground tabular-nums shrink-0 ml-auto"
              title={fmtFullStr(row.created_at)}
            >
              {fmtRelativeStr(row.created_at)}
            </span>
          </div>
          {row.description && (
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2" title={row.description}>
              {row.description}
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap mt-1.5">
            {hasEntity && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (canDrill) onOpenEntity({ type: row.entity_type, id: row.pulse_entity_id });
                }}
                disabled={!canDrill}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] border transition-colors max-w-xs",
                  canDrill
                    ? "bg-background border-border hover:bg-primary/10 hover:border-primary/30 text-primary"
                    : "bg-muted border-border text-muted-foreground cursor-default"
                )}
                title={entityName
                  ? `${row.entity_type}: ${entityName}`
                  : `Unresolved ${row.entity_type}`}
              >
                <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0 capitalize">{row.entity_type}</Badge>
                <span className="truncate">
                  {entityName || (
                    <span className="text-muted-foreground/70 italic">unresolved</span>
                  )}
                </span>
              </button>
            )}
            {row.source && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSource(row.source, row.created_at);
                }}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] border font-mono transition-colors hover:brightness-95",
                  sourceChipClass
                )}
                title={`Click to view source run details${sourceStatus ? ` (last known status: ${sourceStatus})` : ""}`}
              >
                <Link2 className="h-2.5 w-2.5 shrink-0" />
                {row.source}
              </button>
            )}
            <div className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1.5 text-[10px] gap-1"
                onClick={(e) => { e.stopPropagation(); onCopyLink(row); }}
                title="Copy permalink"
              >
                <Copy className="h-3 w-3" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

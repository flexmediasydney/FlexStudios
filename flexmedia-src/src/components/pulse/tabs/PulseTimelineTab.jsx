/**
 * PulseTimelineTab — full audit-style view of every Pulse timeline event.
 * Server-side pagination + status/category/time-window filters.
 *
 * The Command Center "Recent Timeline" widget keeps a tight 10-row preview
 * for at-a-glance visibility; the "View full timeline" link there navigates
 * here so ops can drill the entire history.
 *
 * Why server-side: client-side `slice(0, 20)` was hiding 90%+ of events on
 * busy weeks. PulseTimeline can run thousands of rows after a big sync.
 */
import React, { useState, useEffect, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import PulseTimeline, { EVENT_CONFIG } from "@/components/pulse/PulseTimeline";
import {
  Activity, Clock, ChevronLeft, ChevronRight, Filter, Loader2, X, AlertCircle,
  HelpCircle, RefreshCw,
} from "lucide-react";

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const TIME_WINDOWS = [
  { value: "1h",  label: "Last 1 hour",   ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time",      ms: null },
];

// Build event-type list from the canonical EVENT_CONFIG so filter stays in sync
// when new events are added in PulseTimeline.jsx. Fallback label used when the
// DB registry returns a category we didn't pre-map.
const EVENT_TYPE_OPTIONS = Object.keys(EVENT_CONFIG).map(key => ({
  value: key,
  label: EVENT_CONFIG[key].label,
}));

// Category display order and labels — mirrors pulse_timeline_event_types.category
// (migration 116 + signal category added later). Unknown categories fall through to "Other".
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

// Category order for the Legend modal — what the user scans top-to-bottom. Most
// actionable / business-relevant categories first; housekeeping ("system") last.
const LEGEND_CATEGORY_ORDER = ["movement", "market", "contact", "media", "mapping", "signal", "agent", "system"];

// Muted color chips per category — used on the Legend modal badges so a glance
// tells you which bucket a row belongs to. Kept intentionally low-saturation.
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

const ENTITY_TYPE_OPTIONS = [
  { value: "all", label: "All entities" },
  { value: "agent", label: "Agent" },
  { value: "agency", label: "Agency" },
  { value: "listing", label: "Listing" },
  { value: "system", label: "System" },
];

// ── Timeline Legend dialog ────────────────────────────────────────────────
// Explains every event type the system can emit, grouped by category, with
// the icon + color from EVENT_CONFIG, the description from the DB registry
// (pulse_timeline_event_types), and a live emission count from pulse_timeline.
// Mirrors the Signals Legend pattern in PulseSignals.jsx.
function TimelineLegendDialog({ open, onClose }) {
  const [registry, setRegistry] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        // Parallel: registry + a bounded slice of pulse_timeline to derive counts client-side.
        // Bounded at 10k rows — legend counts are "roughly how often you see this", not
        // authoritative totals. Keeps the query cheap and RLS-safe.
        const [regRes, cntRes] = await Promise.all([
          api._supabase
            .from("pulse_timeline_event_types")
            .select("event_type, category, description")
            .order("category", { ascending: true })
            .order("event_type", { ascending: true }),
          api._supabase
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

  // Group registry by category + merge in EVENT_CONFIG entries that the registry
  // might not know about yet (forward-compat — a code emitter gets added before
  // its migration row lands). Each orphan EVENT_CONFIG key bucketed as "other".
  const grouped = React.useMemo(() => {
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
    // Orphans — EVENT_CONFIG keys the registry doesn't list.
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
    // Append anything we didn't pre-order (forward compat).
    for (const [cat, items] of byCat.entries()) {
      ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items });
    }
    return ordered;
  }, [registry]);

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
        <div className="space-y-5 pt-2">
          {loading && registry.length === 0 && (
            <div className="flex items-center justify-center py-8 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading event registry…
            </div>
          )}
          {grouped.map((group) => (
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
          <div className="rounded-md bg-muted/40 border p-3 text-xs text-muted-foreground">
            <p className="font-semibold mb-1">Where do these come from?</p>
            <p>
              Most timeline events are emitted by scheduled scrapes (REA diffs),
              the detail-enricher (memo23), cron dispatchers, and the signal
              generator. System events are housekeeping; movement / market /
              contact / media events are the high-signal rows you usually care about.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export default function PulseTimelineTab({ onOpenEntity }) {
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [timeWindow, setTimeWindow] = useState("7d");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);
  // TL03: event-type registry (category-grouped) fetched from DB at mount
  const [eventTypeRegistry, setEventTypeRegistry] = useState([]);
  // TL08: distinct source values fetched from DB at mount
  const [sourceOptions, setSourceOptions] = useState([]);
  // Legend modal — explains every event type; opened from header or empty state.
  const [legendOpen, setLegendOpen] = useState(false);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, pageSize]);

  // Fetch event-type registry + distinct sources once at mount. These are small
  // (~30 rows, ~5 sources) and rarely change — no need to refresh on every page.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data: regData } = await api._supabase
          .from("pulse_timeline_event_types")
          .select("event_type, category, description")
          .order("category", { ascending: true })
          .order("event_type", { ascending: true });
        if (!cancelled && Array.isArray(regData)) setEventTypeRegistry(regData);
      } catch { /* non-fatal — dropdown falls back to flat EVENT_CONFIG keys */ }

      try {
        // Pull a bounded recent slice and derive distinct sources client-side.
        // Cheaper than a DISTINCT RPC; source cardinality is tiny (~5).
        const { data: srcRows } = await api._supabase
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
      } catch { /* non-fatal — source filter just won't populate */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Group the event-type registry by category, keeping entries that also have
  // a matching EVENT_CONFIG label (so the dropdown shows friendly names).
  const groupedEventOptions = React.useMemo(() => {
    if (!eventTypeRegistry.length) {
      // Fallback: single "Other" bucket with everything in EVENT_CONFIG.
      return [{ category: "other", label: "Other", items: EVENT_TYPE_OPTIONS }];
    }
    const byCat = new Map();
    for (const row of eventTypeRegistry) {
      const cat = row.category || "other";
      const label = EVENT_CONFIG[row.event_type]?.label || row.event_type;
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat).push({ value: row.event_type, label, description: row.description });
    }
    const ordered = [];
    for (const cat of CATEGORY_ORDER) {
      if (byCat.has(cat)) {
        ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items: byCat.get(cat) });
        byCat.delete(cat);
      }
    }
    // Append any categories we didn't pre-order (forward compat).
    for (const [cat, items] of byCat.entries()) {
      ordered.push({ category: cat, label: CATEGORY_LABELS[cat] || cat, items });
    }
    return ordered;
  }, [eventTypeRegistry]);

  const fetchPage = useCallback(async () => {
    setError(null);
    try {
      let q = api._supabase
        .from("pulse_timeline")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false });

      if (eventTypeFilter !== "all") {
        q = q.eq("event_type", eventTypeFilter);
      }
      if (entityTypeFilter !== "all") {
        q = q.eq("entity_type", entityTypeFilter);
      }
      if (sourceFilter !== "all") {
        q = q.eq("source", sourceFilter);
      }
      const tw = TIME_WINDOWS.find(t => t.value === timeWindow);
      if (tw && tw.ms != null) {
        q = q.gte("created_at", new Date(Date.now() - tw.ms).toISOString());
      }

      const from = page * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;
      setRows(data || []);
      setTotal(count || 0);
      setLastFetched(new Date());
    } catch (err) {
      setError(err?.message || "Fetch failed");
      setRows([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, page, pageSize]);

  useEffect(() => {
    setLoading(true);
    fetchPage();
  }, [fetchPage]);

  // Auto-refresh every 30s when enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { fetchPage(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchPage]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);
  const hasPrev = page > 0;
  const hasNext = (page + 1) < pageCount;

  const filterCount =
    (eventTypeFilter !== "all" ? 1 : 0) +
    (entityTypeFilter !== "all" ? 1 : 0) +
    (sourceFilter !== "all" ? 1 : 0) +
    (timeWindow !== "7d" ? 1 : 0);

  const fmtRelative = useCallback((ts) => {
    if (!ts) return "—";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "—";
    const diff = Math.max(0, Date.now() - d.getTime());
    if (diff < 60_000) return "Just now";
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
    return d.toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }, []);

  return (
    <>
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-3 px-4 pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-500" />
            Pulse Timeline
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {total.toLocaleString()} events
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
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            {lastFetched && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtRelative(lastFetched)}
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
              onClick={() => { setLoading(true); fetchPage(); }}
              disabled={loading}
              title="Refresh now"
            >
              <Loader2 className={loading ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3">
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Event type
            </label>
            <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-[420px]">
                <SelectItem value="all">All event types</SelectItem>
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
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {sourceOptions.map(src => (
                  <SelectItem key={src} value={src}>{src}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Time window
            </label>
            <Select value={timeWindow} onValueChange={setTimeWindow}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIME_WINDOWS.map(tw => (
                  <SelectItem key={tw.value} value={tw.value}>{tw.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Page size
            </label>
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(parseInt(v, 10))}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map(n => (
                  <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {filterCount > 0 && (
          <div className="mt-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] gap-1"
              onClick={() => {
                setEventTypeFilter("all");
                setEntityTypeFilter("all");
                setSourceFilter("all");
                setTimeWindow("7d");
              }}
            >
              <X className="h-3 w-3" />
              Reset filters
            </Button>
          </div>
        )}
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

        {rows.length === 0 && !loading ? (
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
        ) : (
          <PulseTimeline
            entries={rows}
            maxHeight="max-h-[640px]"
            emptyMessage={
              filterCount > 0
                ? "No events match the current filters."
                : "No timeline events yet."
            }
            onOpenEntity={onOpenEntity}
          />
        )}

        {/* Pagination footer */}
        {total > 0 && (
          <div className="flex items-center justify-between mt-3 pt-3 border-t border-border/40">
            <p className="text-[10px] text-muted-foreground">
              Showing <span className="font-medium text-foreground tabular-nums">{showingFrom.toLocaleString()}</span>
              –<span className="font-medium text-foreground tabular-nums">{showingTo.toLocaleString()}</span>{" "}
              of <span className="font-medium text-foreground tabular-nums">{total.toLocaleString()}</span>{" "}
              · Page <span className="tabular-nums">{page + 1}</span> of <span className="tabular-nums">{pageCount}</span>
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 text-[10px]"
                disabled={!hasPrev || loading}
                onClick={() => setPage(p => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-3 w-3" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 gap-1 text-[10px]"
                disabled={!hasNext || loading}
                onClick={() => setPage(p => p + 1)}
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
    <TimelineLegendDialog open={legendOpen} onClose={() => setLegendOpen(false)} />
    </>
  );
}

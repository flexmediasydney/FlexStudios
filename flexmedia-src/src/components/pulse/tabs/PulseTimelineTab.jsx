/**
 * PulseTimelineTab — full audit-style view of every Pulse timeline event.
 * Server-side pagination + status/category/time-window filters.
 *
 * The Command Center "Recent Timeline" widget keeps a tight 10-row preview
 * for at-a-glance visibility; the "View full timeline" link there navigates
 * here so ops can drill the entire history.
 *
 * Two view modes:
 *   - List  — the existing card/row timeline (grouped by month, detail panels).
 *   - Table — compact/comfortable dense table, sortable + per-column filters,
 *             virtualized (react-virtual) so unbounded row counts stay fluid.
 *
 * Why server-side pagination for List: client-side `slice(0, 20)` was hiding
 * 90%+ of events on busy weeks. PulseTimeline can run thousands of rows after
 * a big sync. The Table view fetches in large pages (unbounded size) and lets
 * the user load more via infinite scroll / "Load 100 more".
 */
import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  SelectGroup, SelectLabel,
} from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import PulseTimeline, { EVENT_CONFIG } from "@/components/pulse/PulseTimeline";
import {
  Activity, Clock, ChevronLeft, ChevronRight, Filter, Loader2, X, AlertCircle,
  HelpCircle, RefreshCw, Search, Download, List as ListIcon, Table as TableIcon,
  ArrowUp, ArrowDown, ArrowUpDown, Columns, Rows, ChevronDown,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { exportFilteredCsv } from "@/components/pulse/utils/qolHelpers";
import PresetControls from "@/components/pulse/utils/PresetControls";

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

// LocalStorage keys for the Table view (density, visible columns, view mode).
const LS_VIEW_MODE        = "pulse_timeline_view_mode";          // "list" | "table"
const LS_TABLE_DENSITY    = "pulse_timeline_table_density";      // "compact" | "comfortable"
const LS_TABLE_COLS       = "pulse_timeline_table_columns_v1";   // JSON array of visible col keys

// Canonical table columns — order used for both CSV export + render.
const TABLE_COLUMNS = [
  { key: "select",      label: "",            sortable: false, filterable: false, width: "w-8"  },
  { key: "when",        label: "When",        sortable: true,  filterable: true,  width: "w-28" },
  { key: "event",       label: "Event",       sortable: true,  filterable: true,  width: "w-44" },
  { key: "category",    label: "Category",    sortable: true,  filterable: true,  width: "w-28" },
  { key: "title",       label: "Title",       sortable: true,  filterable: false, width: ""     },
  { key: "entity",      label: "Entity",      sortable: true,  filterable: true,  width: "w-56" },
  { key: "source",      label: "Source",      sortable: true,  filterable: true,  width: "w-32" },
  { key: "description", label: "Description", sortable: false, filterable: false, width: ""     },
];

// Default visible columns — user can toggle via the Columns dropdown.
const DEFAULT_VISIBLE_COLS = TABLE_COLUMNS.map(c => c.key);

// How many extra rows the Table fetches per "page" (infinite scroll chunk).
const TABLE_CHUNK = 100;
// Scroll-trigger margin (px) — auto-load more when the user scrolls within
// this many pixels of the bottom of the virtualized list.
const AUTOLOAD_MARGIN_PX = 200;

// ── Timeline Legend dialog ────────────────────────────────────────────────
// Explains every event type the system can emit, grouped by category, with
// the icon + color from EVENT_CONFIG, the description from the DB registry
// (pulse_timeline_event_types), and a live emission count from pulse_timeline.
// Mirrors the Signals Legend pattern in PulseSignals.jsx.
function TimelineLegendDialog({ open, onClose }) {
  const [registry, setRegistry] = useState([]);
  const [counts, setCounts] = useState({});
  const [loading, setLoading] = useState(false);
  // #54: filter legend rows by event_type OR description (case-insensitive).
  const [legendSearch, setLegendSearch] = useState("");

  // Reset search when dialog closes so reopening doesn't show stale filter.
  useEffect(() => {
    if (!open) setLegendSearch("");
  }, [open]);

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

  // #54: apply search filter. Keeps category groups but filters their items —
  // hides category entirely if no items match. Matches event_type OR description
  // OR the pretty label from EVENT_CONFIG.
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
        {/* #54: search box for filtering legend rows */}
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

// ── Helpers: format relative + full timestamps ────────────────────────────
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

// Truncate a string to n chars with an ellipsis.
function truncate(s, n = 80) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export default function PulseTimelineTab({ onOpenEntity }) {
  // #57: URL-driven filter state. Hydrate once on mount from ?event_type=&source=&...
  // and re-serialise on every change. We use a local state mirror to keep the
  // existing logic simple — the effect below syncs URL → state and state → URL.
  const [searchParams, setSearchParams] = useSearchParams();
  const [eventTypeFilter, setEventTypeFilter] = useState(() => searchParams.get("event_type") || "all");
  const [entityTypeFilter, setEntityTypeFilter] = useState(() => searchParams.get("category") || "all"); // "category" per spec
  const [sourceFilter, setSourceFilter] = useState(() => searchParams.get("source") || "all");
  const [timeWindow, setTimeWindow] = useState(() => searchParams.get("time_window") || "7d");
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

  // ── View mode (List | Table) ────────────────────────────────────────────
  const [viewMode, setViewMode] = useState(() => {
    try { return localStorage.getItem(LS_VIEW_MODE) || "list"; } catch { return "list"; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_VIEW_MODE, viewMode); } catch { /* ignore */ }
  }, [viewMode]);

  // ── Table-only state ────────────────────────────────────────────────────
  const [tableRows, setTableRows] = useState([]);
  const [tableTotal, setTableTotal] = useState(0);
  const [tableLoaded, setTableLoaded] = useState(0);     // how many rows loaded so far
  const [tableLoading, setTableLoading] = useState(false);
  const [tableError, setTableError] = useState(null);
  const [sortKey, setSortKey] = useState("when");        // default sort by created_at
  const [sortDir, setSortDir] = useState("desc");
  // Per-column inline filters
  const [colFilters, setColFilters] = useState({
    when_from: "", when_to: "",
    event: [],                // multi-select event_types
    category: "all",
    entity: "",               // text search across entity name + type
    source: "all",
  });
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem(LS_TABLE_DENSITY) || "comfortable"; } catch { return "comfortable"; }
  });
  useEffect(() => {
    try { localStorage.setItem(LS_TABLE_DENSITY, density); } catch { /* ignore */ }
  }, [density]);
  const [visibleCols, setVisibleCols] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_TABLE_COLS);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* ignore */ }
    return DEFAULT_VISIBLE_COLS;
  });
  useEffect(() => {
    try { localStorage.setItem(LS_TABLE_COLS, JSON.stringify(visibleCols)); } catch { /* ignore */ }
  }, [visibleCols]);
  const [selected, setSelected] = useState(() => new Set());

  // Entity name cache populated lazily from tableRows (agent/agency/listing lookups).
  const [entityNameMap, setEntityNameMap] = useState({}); // `${type}:${id}` -> display name

  // #47: last-visit tracking for "N new events since last visit".
  // On mount we snapshot the stored ts and count events created after it; a
  // sticky pill above the list lets the user "load" (sets the marker to now).
  const LAST_VIEWED_KEY = "pulse_timeline_last_viewed_at";
  const initialLastViewedRef = useRef(null);
  if (initialLastViewedRef.current === null) {
    initialLastViewedRef.current = localStorage.getItem(LAST_VIEWED_KEY) || null;
  }
  const [newEventsSinceLastVisit, setNewEventsSinceLastVisit] = useState(0);

  // Reset page when filters change (List view only)
  useEffect(() => { setPage(0); }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, pageSize]);

  // #57: write filter state back to the URL whenever it changes.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    const setOrDrop = (k, v, def) => {
      if (v == null || v === "" || v === def) next.delete(k);
      else next.set(k, v);
    };
    setOrDrop("event_type",  eventTypeFilter, "all");
    setOrDrop("category",    entityTypeFilter, "all");
    setOrDrop("source",      sourceFilter, "all");
    setOrDrop("time_window", timeWindow, "7d");
    // Only replace if something actually changed — avoids churn on every render.
    const before = searchParams.toString();
    const after = next.toString();
    if (before !== after) setSearchParams(next, { replace: true });
  }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, searchParams, setSearchParams]);

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

  // Map: event_type -> category, built from the registry. Used for the Table
  // view's Category column.
  const eventTypeToCategory = useMemo(() => {
    const m = new Map();
    for (const r of eventTypeRegistry) {
      if (r.event_type) m.set(r.event_type, r.category || "other");
    }
    return m;
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
    if (viewMode !== "list") return; // skip list fetch when in table mode
    setLoading(true);
    fetchPage();
  }, [fetchPage, viewMode]);

  // Auto-refresh every 30s when enabled (List view only — Table uses its own
  // infinite-scroll pagination and would churn scroll position on refresh).
  useEffect(() => {
    if (!autoRefresh || viewMode !== "list") return;
    const id = setInterval(() => { fetchPage(); }, 30_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchPage, viewMode]);

  // #47: on mount, count how many pulse_timeline rows exist with created_at
  // > stored last-viewed timestamp. We do a separate head-count query so the
  // filter dropdowns can't hide the "new since" badge.
  useEffect(() => {
    const lastViewed = initialLastViewedRef.current;
    if (!lastViewed) {
      setNewEventsSinceLastVisit(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { count } = await api._supabase
          .from("pulse_timeline")
          .select("id", { count: "exact", head: true })
          .gt("created_at", lastViewed);
        if (!cancelled) setNewEventsSinceLastVisit(count || 0);
      } catch {
        if (!cancelled) setNewEventsSinceLastVisit(0);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // #47: mark this moment as "last viewed" and clear the pill. Does NOT
  // re-trigger a server fetch — the list already shows the newest rows at
  // the top; clicking Load simply reveals them by scrolling to page 0 and
  // resetting any active filter that might hide them.
  const markTimelineViewed = useCallback(() => {
    const now = new Date().toISOString();
    localStorage.setItem(LAST_VIEWED_KEY, now);
    initialLastViewedRef.current = now;
    setNewEventsSinceLastVisit(0);
    setPage(0);
    fetchPage();
  }, [fetchPage]);

  // Quiet "mark viewed on unmount" so that next visit's counter baseline is
  // fresh even if the user didn't explicitly click the "Load" pill.
  useEffect(() => {
    return () => {
      try { localStorage.setItem(LAST_VIEWED_KEY, new Date().toISOString()); } catch {
        /* storage disabled — just swallow */
      }
    };
  }, []);

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

  const fmtRelative = useCallback((ts) => fmtRelativeStr(ts), []);

  // ── Table data fetch ────────────────────────────────────────────────────
  // Fetches rows in large chunks (100 by default) and appends to tableRows.
  // Server-side applies the "global" filters (event_type, entity, source, time
  // window) + sort; the per-column inline filters apply client-side on top
  // (avoids rewriting the query for every keystroke).
  const fetchTableChunk = useCallback(async ({ reset = false } = {}) => {
    setTableError(null);
    setTableLoading(true);
    try {
      let q = api._supabase
        .from("pulse_timeline")
        .select("*", { count: "exact" });

      // Global filters mirror the List-view filters exactly so the user can
      // share behaviour between modes.
      if (eventTypeFilter !== "all") q = q.eq("event_type", eventTypeFilter);
      if (entityTypeFilter !== "all") q = q.eq("entity_type", entityTypeFilter);
      if (sourceFilter !== "all") q = q.eq("source", sourceFilter);
      const tw = TIME_WINDOWS.find(t => t.value === timeWindow);
      if (tw && tw.ms != null) {
        q = q.gte("created_at", new Date(Date.now() - tw.ms).toISOString());
      }

      // Map Table sortKey → DB column. Everything else sorts client-side.
      const serverSortCol = (() => {
        switch (sortKey) {
          case "when":     return "created_at";
          case "event":    return "event_type";
          case "title":    return "title";
          case "entity":   return "entity_type";
          case "source":   return "source";
          default:         return "created_at";
        }
      })();
      q = q.order(serverSortCol, { ascending: sortDir === "asc" });

      const from = reset ? 0 : tableLoaded;
      const to = from + TABLE_CHUNK - 1;
      q = q.range(from, to);

      const { data, error: qErr, count } = await q;
      if (qErr) throw qErr;
      const newRows = data || [];
      setTableRows(prev => (reset ? newRows : [...prev, ...newRows]));
      setTableLoaded(prev => (reset ? newRows.length : prev + newRows.length));
      setTableTotal(count || 0);
    } catch (err) {
      setTableError(err?.message || "Fetch failed");
    } finally {
      setTableLoading(false);
    }
  }, [eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, sortKey, sortDir, tableLoaded]);

  // Reset + refetch when entering Table view or when any global filter / sort
  // changes. Uses reset:true to clear previously-loaded rows.
  useEffect(() => {
    if (viewMode !== "table") return;
    setTableRows([]);
    setTableLoaded(0);
    setSelected(new Set());
    // Use a local fetch (can't rely on fetchTableChunk closure over tableLoaded).
    (async () => {
      setTableError(null);
      setTableLoading(true);
      try {
        let q = api._supabase
          .from("pulse_timeline")
          .select("*", { count: "exact" });
        if (eventTypeFilter !== "all") q = q.eq("event_type", eventTypeFilter);
        if (entityTypeFilter !== "all") q = q.eq("entity_type", entityTypeFilter);
        if (sourceFilter !== "all") q = q.eq("source", sourceFilter);
        const tw = TIME_WINDOWS.find(t => t.value === timeWindow);
        if (tw && tw.ms != null) {
          q = q.gte("created_at", new Date(Date.now() - tw.ms).toISOString());
        }
        const serverSortCol = (() => {
          switch (sortKey) {
            case "when":   return "created_at";
            case "event":  return "event_type";
            case "title":  return "title";
            case "entity": return "entity_type";
            case "source": return "source";
            default:       return "created_at";
          }
        })();
        q = q.order(serverSortCol, { ascending: sortDir === "asc" });
        q = q.range(0, TABLE_CHUNK - 1);
        const { data, error: qErr, count } = await q;
        if (qErr) throw qErr;
        setTableRows(data || []);
        setTableLoaded((data || []).length);
        setTableTotal(count || 0);
      } catch (err) {
        setTableError(err?.message || "Fetch failed");
      } finally {
        setTableLoading(false);
      }
    })();
  }, [viewMode, eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow, sortKey, sortDir]);

  // Lazy-load entity names for rows that have pulse_entity_id + entity_type.
  // Fetches in batched lookups (one per entity_type) and caches by `${type}:${id}`.
  useEffect(() => {
    if (viewMode !== "table" || tableRows.length === 0) return;
    const needByType = { agent: [], agency: [], listing: [] };
    for (const r of tableRows) {
      if (!r.pulse_entity_id) continue;
      const key = `${r.entity_type}:${r.pulse_entity_id}`;
      if (entityNameMap[key]) continue;
      if (needByType[r.entity_type]) needByType[r.entity_type].push(r.pulse_entity_id);
    }
    const anyNeed = Object.values(needByType).some(arr => arr.length > 0);
    if (!anyNeed) return;

    let cancelled = false;
    (async () => {
      const updates = {};
      const tasks = [];
      if (needByType.agent.length) {
        tasks.push(
          api._supabase
            .from("pulse_agents")
            .select("id, display_name, first_name, last_name")
            .in("id", Array.from(new Set(needByType.agent)))
            .then(({ data }) => {
              for (const a of (data || [])) {
                const name = a.display_name || [a.first_name, a.last_name].filter(Boolean).join(" ") || "Agent";
                updates[`agent:${a.id}`] = name;
              }
            })
        );
      }
      if (needByType.agency.length) {
        tasks.push(
          api._supabase
            .from("pulse_agencies")
            .select("id, name")
            .in("id", Array.from(new Set(needByType.agency)))
            .then(({ data }) => {
              for (const a of (data || [])) {
                updates[`agency:${a.id}`] = a.name || "Agency";
              }
            })
        );
      }
      if (needByType.listing.length) {
        tasks.push(
          api._supabase
            .from("pulse_listings")
            .select("id, display_address, suburb")
            .in("id", Array.from(new Set(needByType.listing)))
            .then(({ data }) => {
              for (const l of (data || [])) {
                updates[`listing:${l.id}`] = l.display_address || l.suburb || "Listing";
              }
            })
        );
      }
      try { await Promise.all(tasks); } catch { /* non-fatal */ }
      if (!cancelled && Object.keys(updates).length > 0) {
        setEntityNameMap(prev => ({ ...prev, ...updates }));
      }
    })();
    return () => { cancelled = true; };
  }, [viewMode, tableRows, entityNameMap]);

  // ── Client-side filter + sort for the Table ─────────────────────────────
  const filteredTableRows = useMemo(() => {
    let out = tableRows;
    // When range
    if (colFilters.when_from) {
      const from = new Date(colFilters.when_from).getTime();
      if (!isNaN(from)) out = out.filter(r => new Date(r.created_at).getTime() >= from);
    }
    if (colFilters.when_to) {
      // include the full day
      const to = new Date(colFilters.when_to).getTime() + 86_400_000 - 1;
      if (!isNaN(to)) out = out.filter(r => new Date(r.created_at).getTime() <= to);
    }
    // Event multi-select
    if (colFilters.event && colFilters.event.length > 0) {
      const set = new Set(colFilters.event);
      out = out.filter(r => set.has(r.event_type));
    }
    // Category
    if (colFilters.category && colFilters.category !== "all") {
      out = out.filter(r => (eventTypeToCategory.get(r.event_type) || "other") === colFilters.category);
    }
    // Entity text search — matches entity_type OR cached name OR pulse_entity_id substring
    if (colFilters.entity && colFilters.entity.trim()) {
      const q = colFilters.entity.trim().toLowerCase();
      out = out.filter(r => {
        const key = `${r.entity_type}:${r.pulse_entity_id}`;
        const name = (entityNameMap[key] || "").toLowerCase();
        return (r.entity_type || "").toLowerCase().includes(q)
          || name.includes(q)
          || String(r.pulse_entity_id || "").toLowerCase().includes(q);
      });
    }
    // Source dropdown (column-level; overrides the global source only when ≠ "all")
    if (colFilters.source && colFilters.source !== "all") {
      out = out.filter(r => r.source === colFilters.source);
    }

    // Client-side sort for columns not handled server-side (category).
    if (sortKey === "category") {
      const dir = sortDir === "asc" ? 1 : -1;
      out = [...out].sort((a, b) => {
        const ca = eventTypeToCategory.get(a.event_type) || "other";
        const cb = eventTypeToCategory.get(b.event_type) || "other";
        return ca.localeCompare(cb) * dir;
      });
    }
    return out;
  }, [tableRows, colFilters, sortKey, sortDir, eventTypeToCategory, entityNameMap]);

  // ── Virtualizer ────────────────────────────────────────────────────────
  const parentRef = useRef(null);
  const rowHeight = density === "compact" ? 32 : 56;
  const rowVirtualizer = useVirtualizer({
    count: filteredTableRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
  });

  // Infinite scroll — when the virtualizer reports we're near the end AND
  // there are more rows on the server, load the next chunk.
  useEffect(() => {
    const el = parentRef.current;
    if (!el || viewMode !== "table") return;
    const onScroll = () => {
      if (tableLoading) return;
      if (tableLoaded >= tableTotal) return;
      const distanceFromBottom = el.scrollHeight - (el.scrollTop + el.clientHeight);
      if (distanceFromBottom < AUTOLOAD_MARGIN_PX) {
        fetchTableChunk();
      }
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [viewMode, tableLoading, tableLoaded, tableTotal, fetchTableChunk]);

  // Header click → sort toggle.
  const onHeaderSort = (key) => {
    const col = TABLE_COLUMNS.find(c => c.key === key);
    if (!col || !col.sortable) return;
    if (sortKey === key) {
      setSortDir(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  // ── Selection helpers ──────────────────────────────────────────────────
  const toggleSelected = (id) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAllVisible = () => {
    setSelected(new Set(filteredTableRows.map(r => r.id)));
  };
  const clearSelection = () => setSelected(new Set());

  // ── CSV export (Table) ─────────────────────────────────────────────────
  const tableCsvExport = () => {
    const headers = [
      { key: "id",              label: "id" },
      { key: "created_at",      label: "created_at" },
      { key: "event_type",      label: "event_type" },
      { key: "category",        label: "category" },
      { key: "entity_type",     label: "entity_type" },
      { key: "pulse_entity_id", label: "pulse_entity_id" },
      { key: "entity_name",     label: "entity_name" },
      { key: "source",          label: "source" },
      { key: "title",           label: "title" },
      { key: "description",     label: "description" },
      { key: "rea_id",          label: "rea_id" },
      { key: "sync_log_id",     label: "sync_log_id" },
    ];
    const rowsToExport = selected.size > 0
      ? filteredTableRows.filter(r => selected.has(r.id))
      : filteredTableRows;
    const decorated = rowsToExport.map(r => ({
      ...r,
      category: eventTypeToCategory.get(r.event_type) || "other",
      entity_name: entityNameMap[`${r.entity_type}:${r.pulse_entity_id}`] || "",
    }));
    const stamp = new Date().toISOString().slice(0, 10);
    exportFilteredCsv(`pulse_timeline_${stamp}.csv`, headers, decorated);
  };

  const eventTypeOptionsFlat = useMemo(() => {
    // Flattened list of event type options for the multi-select in the
    // Event column. Preserves group order.
    const out = [];
    for (const grp of groupedEventOptions) {
      for (const item of grp.items) {
        out.push({ ...item, category: grp.category });
      }
    }
    return out;
  }, [groupedEventOptions]);

  const toggleColVisible = (key) => {
    setVisibleCols(prev => {
      if (prev.includes(key)) {
        // Refuse to hide the last remaining column — always keep at least one.
        if (prev.length <= 1) return prev;
        return prev.filter(k => k !== key);
      }
      // Maintain canonical order.
      return TABLE_COLUMNS.filter(c => prev.includes(c.key) || c.key === key).map(c => c.key);
    });
  };

  return (
    <>
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-3 px-4 pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Activity className="h-4 w-4 text-cyan-500" />
            Pulse Timeline
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {(viewMode === "table" ? tableTotal : total).toLocaleString()} events
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
            {/* View mode toggle — segmented control */}
            <div
              className="inline-flex items-center rounded-md border bg-background p-0.5"
              data-print-hide="true"
            >
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
                List
              </button>
              <button
                type="button"
                onClick={() => setViewMode("table")}
                className={cn(
                  "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                  viewMode === "table"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
                aria-pressed={viewMode === "table"}
              >
                <TableIcon className="h-3 w-3" />
                Table
              </button>
            </div>
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground" data-print-hide="true">
            {lastFetched && viewMode === "list" && (
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {fmtRelative(lastFetched)}
              </span>
            )}
            {viewMode === "list" && (
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <Switch
                  checked={autoRefresh}
                  onCheckedChange={setAutoRefresh}
                  aria-label="Auto-refresh every 30s"
                />
                <span>Auto-refresh</span>
              </label>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              onClick={() => {
                if (viewMode === "list") { setLoading(true); fetchPage(); }
                else {
                  // Force a reset refetch on Table.
                  setSortKey(k => k); // no-op to retrigger effect
                  setTableRows([]); setTableLoaded(0);
                  fetchTableChunk({ reset: true });
                }
              }}
              disabled={viewMode === "list" ? loading : tableLoading}
              title="Refresh now"
            >
              <Loader2 className={(viewMode === "list" ? loading : tableLoading) ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
              Refresh
            </Button>
            {/* #51: filter preset save/load (Timeline namespace) */}
            <PresetControls
              namespace="timeline"
              currentPreset={{
                eventTypeFilter, entityTypeFilter, sourceFilter, timeWindow,
              }}
              onLoad={(p) => {
                if (p?.eventTypeFilter)  setEventTypeFilter(p.eventTypeFilter);
                if (p?.entityTypeFilter) setEntityTypeFilter(p.entityTypeFilter);
                if (p?.sourceFilter)     setSourceFilter(p.sourceFilter);
                if (p?.timeWindow)       setTimeWindow(p.timeWindow);
              }}
            />
            {/* #52: export the currently-visible rows as CSV */}
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              disabled={viewMode === "list" ? rows.length === 0 : filteredTableRows.length === 0}
              onClick={() => {
                if (viewMode === "list") {
                  const headers = [
                    { key: "id",               label: "id" },
                    { key: "created_at",       label: "created_at" },
                    { key: "event_type",       label: "event_type" },
                    { key: "entity_type",      label: "entity_type" },
                    { key: "pulse_entity_id",  label: "pulse_entity_id" },
                    { key: "source",           label: "source" },
                    { key: "title",            label: "title" },
                    { key: "description",      label: "description" },
                    { key: "rea_id",           label: "rea_id" },
                    { key: "sync_log_id",      label: "sync_log_id" },
                  ];
                  const stamp = new Date().toISOString().slice(0, 10);
                  exportFilteredCsv(`pulse_timeline_${stamp}.csv`, headers, rows);
                } else {
                  tableCsvExport();
                }
              }}
              title="Download visible timeline rows as CSV"
            >
              <Download className="h-3 w-3" />
              CSV
            </Button>
          </div>
        </div>

        {/* Filter row — shared by both views */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 mt-3" data-print-hide="true">
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
          {viewMode === "list" ? (
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
          ) : (
            <div>
              <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                Density
              </label>
              <div className="inline-flex items-center rounded-md border bg-background p-0.5 mt-0.5 h-8">
                <button
                  type="button"
                  onClick={() => setDensity("compact")}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                    density === "compact"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={density === "compact"}
                >
                  <Rows className="h-3 w-3" />
                  Compact
                </button>
                <button
                  type="button"
                  onClick={() => setDensity("comfortable")}
                  className={cn(
                    "flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium transition-colors",
                    density === "comfortable"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={density === "comfortable"}
                >
                  <Rows className="h-3 w-3" />
                  Comfortable
                </button>
              </div>
            </div>
          )}
        </div>

        {filterCount > 0 && (
          <div className="mt-2" data-print-hide="true">
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
        {/* #47: sticky "N new events since last visit" pill — List view only */}
        {newEventsSinceLastVisit > 0 && viewMode === "list" && (
          <div className="sticky top-0 z-10 mb-3">
            <button
              type="button"
              onClick={markTimelineViewed}
              className="w-full flex items-center justify-center gap-2 text-[11px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-900/50 border border-blue-200 dark:border-blue-800 rounded-md px-3 py-1.5 transition-colors"
            >
              <Activity className="h-3 w-3" />
              <span>
                {newEventsSinceLastVisit.toLocaleString()} new event{newEventsSinceLastVisit === 1 ? "" : "s"} since last visit
              </span>
              <span className="underline">Load</span>
            </button>
          </div>
        )}

        {viewMode === "list" && error && (
          <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-3 mb-3 text-xs flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">Failed to load timeline</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</p>
            </div>
          </div>
        )}

        {viewMode === "list" ? (
          // ── List view (existing) ─────────────────────────────────────
          rows.length === 0 && !loading ? (
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
          )
        ) : (
          // ── Table view ───────────────────────────────────────────────
          <TableView
            rows={filteredTableRows}
            totalRows={tableTotal}
            loadedRows={tableLoaded}
            loading={tableLoading}
            error={tableError}
            sortKey={sortKey}
            sortDir={sortDir}
            onHeaderSort={onHeaderSort}
            colFilters={colFilters}
            setColFilters={setColFilters}
            density={density}
            visibleCols={visibleCols}
            toggleColVisible={toggleColVisible}
            eventTypeOptionsFlat={eventTypeOptionsFlat}
            eventTypeToCategory={eventTypeToCategory}
            sourceOptions={sourceOptions}
            entityNameMap={entityNameMap}
            selected={selected}
            toggleSelected={toggleSelected}
            selectAllVisible={selectAllVisible}
            clearSelection={clearSelection}
            tableCsvExport={tableCsvExport}
            parentRef={parentRef}
            rowVirtualizer={rowVirtualizer}
            rowHeight={rowHeight}
            fetchMore={() => fetchTableChunk()}
            onOpenEntity={onOpenEntity}
            setLegendOpen={setLegendOpen}
            filterCount={filterCount}
          />
        )}

        {/* Pagination footer — List view only */}
        {viewMode === "list" && total > 0 && (
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

/* ── TableView ──────────────────────────────────────────────────────────────
 * Extracted to its own component so the parent tab stays readable. All data
 * + handlers are threaded through props; no internal fetches.
 */
function TableView({
  rows, totalRows, loadedRows, loading, error,
  sortKey, sortDir, onHeaderSort,
  colFilters, setColFilters,
  density, visibleCols, toggleColVisible,
  eventTypeOptionsFlat, eventTypeToCategory, sourceOptions, entityNameMap,
  selected, toggleSelected, selectAllVisible, clearSelection,
  tableCsvExport,
  parentRef, rowVirtualizer, rowHeight,
  fetchMore,
  onOpenEntity, setLegendOpen, filterCount,
}) {
  const visibleColDefs = TABLE_COLUMNS.filter(c => visibleCols.includes(c.key));

  // Render sort indicator arrows on the header.
  const SortIndicator = ({ colKey }) => {
    if (sortKey !== colKey) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc"
      ? <ArrowUp className="h-3 w-3" />
      : <ArrowDown className="h-3 w-3" />;
  };

  return (
    <div className="space-y-2">
      {/* Top action bar: column visibility + bulk actions */}
      <div className="flex items-center justify-between gap-2 flex-wrap" data-print-hide="true">
        <div className="flex items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-7 px-2 text-[10px] gap-1">
                <Columns className="h-3 w-3" />
                Columns
                <ChevronDown className="h-3 w-3" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-2">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">
                Visible columns
              </p>
              <div className="space-y-1">
                {TABLE_COLUMNS.filter(c => c.key !== "select").map(c => (
                  <label
                    key={c.key}
                    className="flex items-center gap-2 text-xs cursor-pointer py-0.5 hover:bg-muted rounded px-1"
                  >
                    <Checkbox
                      checked={visibleCols.includes(c.key)}
                      onCheckedChange={() => toggleColVisible(c.key)}
                    />
                    <span>{c.label}</span>
                  </label>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          {selected.size > 0 && (
            <div className="flex items-center gap-2 rounded-md border bg-muted/50 px-2 py-1">
              <span className="text-[10px] font-medium">
                {selected.size} selected
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-[10px]"
                onClick={selectAllVisible}
              >
                Select all visible
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-5 px-1 text-[10px]"
                onClick={clearSelection}
              >
                Clear
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-5 px-2 text-[10px] gap-1"
                onClick={tableCsvExport}
              >
                <Download className="h-3 w-3" />
                Export {selected.size} CSV
              </Button>
            </div>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground tabular-nums">
          Showing <span className="font-medium text-foreground">{rows.length.toLocaleString()}</span>
          {" "}of <span className="font-medium text-foreground">{totalRows.toLocaleString()}</span> events
          {loadedRows < totalRows && (
            <span className="ml-1 text-muted-foreground/60">(loaded {loadedRows.toLocaleString()})</span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-3 text-xs flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-red-700 dark:text-red-400">Failed to load timeline</p>
            <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</p>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="border border-border/40 rounded-md overflow-hidden">
        {/* Header + column filters */}
        <div data-print-hide="true" className="bg-muted/50 border-b border-border/40">
          <table className="w-full table-fixed">
            <thead>
              <tr>
                {visibleColDefs.map(col => (
                  <th
                    key={col.key}
                    className={cn(
                      "text-left text-[10px] uppercase tracking-wide text-muted-foreground font-semibold px-2 py-1.5",
                      col.width,
                      col.sortable && "cursor-pointer select-none hover:text-foreground"
                    )}
                    onClick={col.sortable ? () => onHeaderSort(col.key) : undefined}
                  >
                    <div className="flex items-center gap-1">
                      {col.key === "select" ? (
                        <Checkbox
                          checked={rows.length > 0 && selected.size >= rows.length}
                          onCheckedChange={(v) => {
                            if (v) selectAllVisible(); else clearSelection();
                          }}
                          aria-label="Select all"
                        />
                      ) : (
                        <>
                          <span>{col.label}</span>
                          {col.sortable && <SortIndicator colKey={col.key} />}
                        </>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
              {/* Column-level filter row */}
              <tr>
                {visibleColDefs.map(col => (
                  <th key={`${col.key}-filter`} className="px-2 pb-1.5 align-top">
                    {col.key === "when" && (
                      <div className="flex items-center gap-1">
                        <Input
                          type="date"
                          value={colFilters.when_from}
                          onChange={(e) => setColFilters(f => ({ ...f, when_from: e.target.value }))}
                          className="h-6 text-[10px] px-1"
                          placeholder="From"
                          title="From date"
                        />
                        <Input
                          type="date"
                          value={colFilters.when_to}
                          onChange={(e) => setColFilters(f => ({ ...f, when_to: e.target.value }))}
                          className="h-6 text-[10px] px-1"
                          placeholder="To"
                          title="To date"
                        />
                      </div>
                    )}
                    {col.key === "event" && (
                      <Popover>
                        <PopoverTrigger asChild>
                          <button
                            type="button"
                            className="h-6 w-full text-[10px] border rounded px-1.5 bg-background hover:bg-muted flex items-center justify-between"
                          >
                            <span className="truncate">
                              {colFilters.event.length === 0
                                ? "All events"
                                : `${colFilters.event.length} selected`}
                            </span>
                            <ChevronDown className="h-3 w-3 shrink-0" />
                          </button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-64 p-2 max-h-80 overflow-y-auto">
                          <div className="flex items-center justify-between mb-1">
                            <p className="text-[10px] uppercase text-muted-foreground">Filter events</p>
                            {colFilters.event.length > 0 && (
                              <button
                                type="button"
                                className="text-[10px] text-muted-foreground hover:text-foreground underline"
                                onClick={() => setColFilters(f => ({ ...f, event: [] }))}
                              >
                                Clear
                              </button>
                            )}
                          </div>
                          {eventTypeOptionsFlat.map(opt => (
                            <label
                              key={opt.value}
                              className="flex items-center gap-2 text-xs cursor-pointer py-0.5 hover:bg-muted rounded px-1"
                            >
                              <Checkbox
                                checked={colFilters.event.includes(opt.value)}
                                onCheckedChange={() => {
                                  setColFilters(f => {
                                    const set = new Set(f.event);
                                    if (set.has(opt.value)) set.delete(opt.value);
                                    else set.add(opt.value);
                                    return { ...f, event: Array.from(set) };
                                  });
                                }}
                              />
                              <span className="truncate">{opt.label}</span>
                            </label>
                          ))}
                        </PopoverContent>
                      </Popover>
                    )}
                    {col.key === "category" && (
                      <select
                        value={colFilters.category}
                        onChange={(e) => setColFilters(f => ({ ...f, category: e.target.value }))}
                        className="h-6 w-full text-[10px] border rounded px-1 bg-background"
                      >
                        <option value="all">All</option>
                        {CATEGORY_ORDER.map(c => (
                          <option key={c} value={c}>{CATEGORY_LABELS[c] || c}</option>
                        ))}
                      </select>
                    )}
                    {col.key === "entity" && (
                      <Input
                        type="text"
                        value={colFilters.entity}
                        onChange={(e) => setColFilters(f => ({ ...f, entity: e.target.value }))}
                        className="h-6 text-[10px] px-1.5"
                        placeholder="Search…"
                      />
                    )}
                    {col.key === "source" && (
                      <select
                        value={colFilters.source}
                        onChange={(e) => setColFilters(f => ({ ...f, source: e.target.value }))}
                        className="h-6 w-full text-[10px] border rounded px-1 bg-background"
                      >
                        <option value="all">All</option>
                        {sourceOptions.map(src => (
                          <option key={src} value={src}>{src}</option>
                        ))}
                      </select>
                    )}
                    {/* Other columns: no inline filter */}
                  </th>
                ))}
              </tr>
            </thead>
          </table>
        </div>

        {/* Virtualized body */}
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
          <div
            ref={parentRef}
            className="overflow-auto max-h-[640px] relative"
          >
            <table className="w-full table-fixed">
              <colgroup>
                {visibleColDefs.map(c => (
                  <col key={c.key} className={c.width} />
                ))}
              </colgroup>
              <tbody style={{ display: "block", height: rowVirtualizer.getTotalSize(), position: "relative" }}>
                {/* Offset spacer approach — since <table> doesn't play nicely
                    with absolute-positioned virtual items, we render just the
                    visible window of rows with a top padding row to push them
                    down to the right scroll offset. */}
                {rowVirtualizer.getVirtualItems().length > 0 && (
                  <tr style={{ height: rowVirtualizer.getVirtualItems()[0].start, display: "block" }} />
                )}
                {rowVirtualizer.getVirtualItems().map(virtualRow => {
                  const r = rows[virtualRow.index];
                  if (!r) return null;
                  return (
                    <tr
                      key={r.id}
                      className={cn(
                        "border-b border-border/40 hover:bg-muted/40 transition-colors",
                        selected.has(r.id) && "bg-blue-50/50 dark:bg-blue-950/20"
                      )}
                      style={{
                        height: rowHeight,
                        display: "table",
                        tableLayout: "fixed",
                        width: "100%",
                      }}
                    >
                      {renderRowCells(r, {
                        visibleCols, density, selected, toggleSelected,
                        eventTypeToCategory, entityNameMap, onOpenEntity,
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {loading && (
              <div className="flex items-center justify-center py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                Loading…
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer: loaded / total + manual "Load more" */}
      {totalRows > 0 && (
        <div className="flex items-center justify-between pt-2 text-[10px] text-muted-foreground">
          <span>
            Showing <span className="font-medium text-foreground tabular-nums">{rows.length.toLocaleString()}</span>
            {" "}of <span className="font-medium text-foreground tabular-nums">{totalRows.toLocaleString()}</span> events
          </span>
          {loadedRows < totalRows && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[10px]"
              onClick={fetchMore}
              disabled={loading}
            >
              {loading ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
              Load {Math.min(TABLE_CHUNK, totalRows - loadedRows)} more
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/* Render the body cells for a row. Factored out so virtualized rows and the
   main flow share identical markup. */
function renderRowCells(r, ctx) {
  const { visibleCols, density, selected, toggleSelected, eventTypeToCategory, entityNameMap, onOpenEntity } = ctx;
  const isColVisible = (key) => visibleCols.includes(key);
  const cfg = EVENT_CONFIG[r.event_type] || { icon: RefreshCw, color: "bg-gray-400", label: r.event_type };
  const Icon = cfg.icon;
  const category = eventTypeToCategory.get(r.event_type) || "other";
  const entityKey = `${r.entity_type}:${r.pulse_entity_id}`;
  const entityName = entityNameMap[entityKey] || (r.pulse_entity_id ? String(r.pulse_entity_id).slice(0, 8) : "");
  const canDrill = !!(onOpenEntity && r.pulse_entity_id && r.entity_type && r.entity_type !== "system");
  const isSelected = selected.has(r.id);
  const cells = [];

  if (isColVisible("select")) {
    cells.push(
      <td key="select" className="px-2 align-middle w-8">
        <Checkbox
          checked={isSelected}
          onCheckedChange={() => toggleSelected(r.id)}
          aria-label={`Select row ${r.id}`}
        />
      </td>
    );
  }
  if (isColVisible("when")) {
    cells.push(
      <td key="when" className="px-2 align-middle whitespace-nowrap text-[11px] text-muted-foreground tabular-nums w-28">
        <span title={fmtFullStr(r.created_at)}>{fmtRelativeStr(r.created_at)}</span>
      </td>
    );
  }
  if (isColVisible("event")) {
    cells.push(
      <td key="event" className="px-2 align-middle w-44">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className={cn("rounded-full flex items-center justify-center h-4 w-4 shrink-0", cfg.color)}>
            <Icon className="h-2.5 w-2.5 text-white" />
          </div>
          <span className="text-[11px] font-medium truncate" title={r.event_type}>
            {cfg.label || r.event_type}
          </span>
        </div>
      </td>
    );
  }
  if (isColVisible("category")) {
    cells.push(
      <td key="category" className="px-2 align-middle w-28">
        <Badge
          variant="secondary"
          className={cn("text-[9px] px-1.5 py-0", CATEGORY_BADGE_COLORS[category] || "")}
        >
          {CATEGORY_LABELS[category] || category}
        </Badge>
      </td>
    );
  }
  if (isColVisible("title")) {
    cells.push(
      <td key="title" className="px-2 align-middle">
        <span
          className="text-[11px] font-medium truncate block"
          title={r.title}
        >
          {truncate(r.title, 80)}
        </span>
      </td>
    );
  }
  if (isColVisible("entity")) {
    cells.push(
      <td key="entity" className="px-2 align-middle w-56">
        {r.pulse_entity_id ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (canDrill) onOpenEntity({ type: r.entity_type, id: r.pulse_entity_id });
            }}
            disabled={!canDrill}
            className={cn(
              "flex items-center gap-1 text-[11px] truncate max-w-full",
              canDrill
                ? "text-primary hover:underline cursor-pointer"
                : "text-muted-foreground cursor-default"
            )}
            title={`${r.entity_type}: ${entityName}`}
          >
            <Badge variant="outline" className="text-[8px] px-1 py-0 shrink-0">
              {r.entity_type}
            </Badge>
            <span className="truncate">{entityName}</span>
          </button>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
    );
  }
  if (isColVisible("source")) {
    cells.push(
      <td key="source" className="px-2 align-middle w-32">
        {r.source ? (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground font-mono">
            {r.source}
          </Badge>
        ) : (
          <span className="text-[11px] text-muted-foreground/60">—</span>
        )}
      </td>
    );
  }
  if (isColVisible("description")) {
    cells.push(
      <td key="description" className="px-2 align-middle">
        {density === "comfortable" && r.description ? (
          <span
            className="text-[11px] text-muted-foreground truncate block"
            title={r.description}
          >
            {truncate(r.description, 80)}
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground/40">—</span>
        )}
      </td>
    );
  }
  return cells;
}

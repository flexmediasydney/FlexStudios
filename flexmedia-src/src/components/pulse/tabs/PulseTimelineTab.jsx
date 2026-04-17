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
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import PulseTimeline, { EVENT_CONFIG } from "@/components/pulse/PulseTimeline";
import {
  Activity, Clock, ChevronLeft, ChevronRight, Filter, Loader2, X, AlertCircle,
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
// when new events are added in PulseTimeline.jsx.
const EVENT_TYPE_OPTIONS = Object.keys(EVENT_CONFIG).map(key => ({
  value: key,
  label: EVENT_CONFIG[key].label,
}));

const ENTITY_TYPE_OPTIONS = [
  { value: "all", label: "All entities" },
  { value: "agent", label: "Agent" },
  { value: "agency", label: "Agency" },
  { value: "listing", label: "Listing" },
  { value: "system", label: "System" },
];

export default function PulseTimelineTab() {
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [entityTypeFilter, setEntityTypeFilter] = useState("all");
  const [timeWindow, setTimeWindow] = useState("7d");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [eventTypeFilter, entityTypeFilter, timeWindow, pageSize]);

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
  }, [eventTypeFilter, entityTypeFilter, timeWindow, page, pageSize]);

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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Event type
            </label>
            <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All event types</SelectItem>
                {EVENT_TYPE_OPTIONS.map(opt => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
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

        <PulseTimeline
          entries={rows}
          maxHeight="max-h-[640px]"
          emptyMessage={
            filterCount > 0
              ? "No events match the current filters."
              : "No timeline events yet."
          }
        />

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
  );
}

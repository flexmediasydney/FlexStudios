/**
 * EdgeFunctionAuditLog
 *
 * Admin-only view into the `edge_fn_call_audit` table populated by the
 * `serveWithAudit()` wrapper. Complements `/EdgeFunctionHealth` (which
 * shows aggregates from the Supabase Log Explorer) by giving per-call
 * drill-down: caller, status, HTTP code, duration, error message, user.
 *
 * Data source: direct table read against `edge_fn_call_audit`. The table
 * has an admin-only SELECT RLS policy (see migration 079), so this relies
 * on Joseph's admin/master_admin role resolving via the JWT claim.
 *
 * Features:
 *   - Filters: function name (distinct in last 7d), status, time window, caller.
 *   - 50 rows per page, prev/next with "Showing X-Y of Z" counter.
 *   - Auto-refresh every 30s.
 *   - Click error message to expand.
 *   - Clicking the fn_name cell in a row toggles that function as the
 *     active function-name filter (linkable filter).
 */

import { useMemo, useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { formatDistanceToNow, format } from "date-fns";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ClipboardList, RefreshCw, Clock, Loader2, XCircle, ChevronLeft,
  ChevronRight, Filter, CheckCircle2, AlertTriangle,
} from "lucide-react";

const PAGE_SIZE = 50;
const REFRESH_MS = 30_000;

const TIME_WINDOWS = [
  { value: "1h",  label: "Last 1 hour",  ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
];

// ── helpers ────────────────────────────────────────────────────────

function relTime(ts) {
  if (!ts) return null;
  try { return formatDistanceToNow(new Date(ts), { addSuffix: true }); }
  catch { return null; }
}

function absTime(ts) {
  if (!ts) return null;
  try { return format(new Date(ts), "PPpp"); }
  catch { return null; }
}

function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1000)   return `${(v / 1000).toFixed(2)}s`;
  return `${v}ms`;
}

/** Normalise a caller string for display. */
function prettyCaller(c) {
  if (!c) return "unknown";
  if (c === "frontend") return "frontend";
  if (c.startsWith("cross_fn:")) return c;
  return c;
}

/** Status dot classes. */
function statusDot(status) {
  if (status === "success") return "bg-green-500";
  if (status === "timeout") return "bg-amber-500";
  return "bg-red-500"; // error / unknown
}

function statusLabelClass(status) {
  if (status === "success") return "text-green-700";
  if (status === "timeout") return "text-amber-700";
  return "text-red-700";
}

function httpStatusBadge(code) {
  if (code == null) {
    return { cls: "bg-muted text-muted-foreground border-muted-foreground/30 font-mono", label: "—" };
  }
  if (code >= 500) return { cls: "bg-red-100 text-red-700 border-red-200 font-mono", label: String(code) };
  if (code >= 400) return { cls: "bg-red-100 text-red-700 border-red-200 font-mono", label: String(code) };
  if (code >= 300) return { cls: "bg-amber-100 text-amber-800 border-amber-200 font-mono", label: String(code) };
  return { cls: "bg-green-100 text-green-700 border-green-200 font-mono", label: String(code) };
}

function truncate(s, max = 120) {
  if (!s) return "";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ── page ──────────────────────────────────────────────────────────

export default function EdgeFunctionAuditLog() {
  // ── filter state ──
  const [fnFilter, setFnFilter] = useState("all");      // 'all' | fn_name
  const [statusFilter, setStatusFilter] = useState("all"); // 'all' | 'success' | 'error'
  const [timeWindow, setTimeWindow] = useState("24h");  // '1h' | '24h' | '7d'
  const [callerFilter, setCallerFilter] = useState("all"); // 'all' | 'frontend' | 'cross_fn'
  const [page, setPage] = useState(0); // 0-indexed
  const [expandedErrors, setExpandedErrors] = useState(new Set()); // Set<id>

  // Reset page to 0 whenever filters change
  useEffect(() => { setPage(0); }, [fnFilter, statusFilter, timeWindow, callerFilter]);

  const sinceIso = useMemo(() => {
    const w = TIME_WINDOWS.find(t => t.value === timeWindow) || TIME_WINDOWS[1];
    return new Date(Date.now() - w.ms).toISOString();
  }, [timeWindow]);

  // ── distinct function names from last 7 days (for the dropdown) ──
  const { data: fnNames = [] } = useQuery({
    queryKey: ["edge-fn-audit-distinct-fns"],
    queryFn: async () => {
      const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      // Grab a generous sample and dedupe client-side. Server-side DISTINCT
      // would require an RPC; the audit table has an index on (fn_name, created_at)
      // so this is cheap.
      const { data, error } = await api._supabase
        .from("edge_fn_call_audit")
        .select("fn_name")
        .gte("created_at", sevenDays)
        .order("created_at", { ascending: false })
        .limit(5000);
      if (error) throw error;
      const seen = new Set();
      for (const row of data || []) {
        if (row.fn_name) seen.add(row.fn_name);
      }
      return Array.from(seen).sort();
    },
    staleTime: 5 * 60 * 1000,
  });

  // ── main query: filtered rows + exact count ──
  const { data, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["edge-fn-audit-log", { fnFilter, statusFilter, timeWindow, callerFilter, page }],
    queryFn: async () => {
      let q = api._supabase
        .from("edge_fn_call_audit")
        .select("id, fn_name, caller, status, http_status, duration_ms, error_message, user_id, created_at", { count: "exact" })
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false });

      if (fnFilter && fnFilter !== "all") {
        q = q.eq("fn_name", fnFilter);
      }
      if (statusFilter === "success") {
        q = q.eq("status", "success");
      } else if (statusFilter === "error") {
        q = q.neq("status", "success"); // include error + timeout
      }
      if (callerFilter === "frontend") {
        q = q.eq("caller", "frontend");
      } else if (callerFilter === "cross_fn") {
        q = q.like("caller", "cross_fn:%");
      }

      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;
      return { rows: data || [], count: count || 0 };
    },
    refetchInterval: REFRESH_MS,
    refetchOnWindowFocus: true,
    keepPreviousData: true,
  });

  const rows = data?.rows || [];
  const total = data?.count || 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasPrev = page > 0;
  const hasNext = (page + 1) < pageCount;
  const showingFrom = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const showingTo = Math.min(total, (page + 1) * PAGE_SIZE);

  // ── look up distinct user ids in the page and resolve to emails ──
  const userIds = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.user_id) set.add(r.user_id);
    return Array.from(set);
  }, [rows]);

  const { data: userMap = {} } = useQuery({
    queryKey: ["edge-fn-audit-users", userIds.sort().join(",")],
    queryFn: async () => {
      if (userIds.length === 0) return {};
      const { data, error } = await api._supabase
        .from("users")
        .select("id, email, full_name")
        .in("id", userIds);
      if (error) throw error;
      const m = {};
      for (const u of data || []) m[u.id] = u.email || u.full_name || u.id;
      return m;
    },
    enabled: userIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const lastRefreshedLabel = dataUpdatedAt
    ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })
    : "never";

  const toggleErrorExpand = (id) => {
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Setting the fn-name filter from a row click (linkable filter).
  const clickFnName = (fn) => {
    if (fnFilter === fn) {
      setFnFilter("all");
    } else {
      setFnFilter(fn);
    }
  };

  // ── render ──

  if (isLoading && !data) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading audit log…
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="max-w-7xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ClipboardList className="h-6 w-6" />
              Edge Function Audit Log
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Per-call audit trail captured by the <code className="font-mono text-xs px-1 py-0.5 rounded bg-muted">serveWithAudit()</code>{" "}
              wrapper. Complements the aggregated{" "}
              <a href="/EdgeFunctionHealth" className="underline underline-offset-2">Edge Function Health</a>{" "}
              dashboard with per-invocation detail (caller, user, error message).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Updated {lastRefreshedLabel}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2"
                  onClick={() => refetch()}
                  disabled={isFetching}
                >
                  {isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>Auto-refreshes every 30s</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Filters */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Filter className="h-4 w-4" />
              Filters
            </CardTitle>
            <CardDescription>
              Narrow the audit log by function, status, time window, or caller.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Function</label>
                <Select value={fnFilter} onValueChange={setFnFilter}>
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="All functions" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All functions</SelectItem>
                    {fnNames.map((fn) => (
                      <SelectItem key={fn} value={fn}>
                        <span className="font-mono text-xs">{fn}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Status</label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="success">Success only</SelectItem>
                    <SelectItem value="error">Errors only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Time window</label>
                <Select value={timeWindow} onValueChange={setTimeWindow}>
                  <SelectTrigger className="mt-1">
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
                <label className="text-[11px] font-medium text-muted-foreground uppercase tracking-wide">Caller</label>
                <Select value={callerFilter} onValueChange={setCallerFilter}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All callers</SelectItem>
                    <SelectItem value="frontend">Frontend only</SelectItem>
                    <SelectItem value="cross_fn">Cross-function only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Error state */}
        {isError && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-3 text-sm">
                <XCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-red-700">Failed to load audit log</p>
                  <p className="text-muted-foreground mt-1">
                    {error?.message || "The edge_fn_call_audit query did not return."}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    The table has an admin-only SELECT RLS policy. If your JWT role
                    claim is not resolving, you may need an edge-function fallback.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              Invocations
            </CardTitle>
            <CardDescription>
              Showing {showingFrom.toLocaleString()}–{showingTo.toLocaleString()} of {total.toLocaleString()} call
              {total === 1 ? "" : "s"}.
              {(fnFilter !== "all" || statusFilter !== "all" || callerFilter !== "all") && (
                <span className="ml-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-5 px-1 text-[11px] underline underline-offset-2"
                    onClick={() => {
                      setFnFilter("all");
                      setStatusFilter("all");
                      setCallerFilter("all");
                    }}
                  >
                    Clear filters
                  </Button>
                </span>
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {rows.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No audit rows match the current filters.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[130px]">When</TableHead>
                    <TableHead className="w-[220px]">Function</TableHead>
                    <TableHead className="w-[160px]">Caller</TableHead>
                    <TableHead className="w-[110px]">Status</TableHead>
                    <TableHead className="w-[70px] text-right">HTTP</TableHead>
                    <TableHead className="w-[80px] text-right">Duration</TableHead>
                    <TableHead>Error / User</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const badge = httpStatusBadge(r.http_status);
                    const isExpanded = expandedErrors.has(r.id);
                    const hasError = !!r.error_message;
                    const userLabel = r.user_id ? (userMap[r.user_id] || r.user_id) : null;
                    return (
                      <TableRow key={r.id} className="align-top">
                        <TableCell className="text-xs text-muted-foreground" title={absTime(r.created_at) || ""}>
                          {relTime(r.created_at) || "—"}
                        </TableCell>
                        <TableCell>
                          <button
                            onClick={() => clickFnName(r.fn_name)}
                            className="font-mono text-xs hover:underline underline-offset-2 text-left"
                            title={fnFilter === r.fn_name
                              ? "Click to clear function filter"
                              : `Filter by ${r.fn_name}`}
                          >
                            {r.fn_name}
                          </button>
                        </TableCell>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {prettyCaller(r.caller)}
                        </TableCell>
                        <TableCell>
                          <div className={`flex items-center gap-1.5 text-xs ${statusLabelClass(r.status)}`}>
                            <span className={`h-2 w-2 rounded-full ${statusDot(r.status)}`} />
                            <span className="capitalize">{r.status || "unknown"}</span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <Badge variant="outline" className={`${badge.cls} h-5 px-1.5 text-[10px]`}>
                            {badge.label}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {fmtMs(r.duration_ms)}
                        </TableCell>
                        <TableCell className="max-w-[420px]">
                          {hasError ? (
                            <div
                              className="text-xs font-mono cursor-pointer"
                              onClick={() => toggleErrorExpand(r.id)}
                              title={isExpanded ? "Click to collapse" : "Click to expand"}
                            >
                              <p className={isExpanded ? "whitespace-pre-wrap break-words text-red-700" : "text-red-700 truncate"}>
                                {isExpanded ? r.error_message : truncate(r.error_message, 120)}
                              </p>
                            </div>
                          ) : r.status === "success" ? (
                            <span className="text-xs text-muted-foreground inline-flex items-center gap-1">
                              <CheckCircle2 className="h-3 w-3 text-green-600" />
                              ok
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground italic">
                              (no message)
                            </span>
                          )}
                          {userLabel && (
                            <p className="text-[10px] text-muted-foreground mt-1">
                              user: <span className="font-mono">{userLabel}</span>
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              Page {page + 1} of {pageCount}
            </p>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={!hasPrev || isFetching}
                onClick={() => setPage(p => Math.max(0, p - 1))}
              >
                <ChevronLeft className="h-4 w-4" />
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                disabled={!hasNext || isFetching}
                onClick={() => setPage(p => p + 1)}
              >
                Next
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        <Separator />

        <div className="text-[11px] text-muted-foreground text-center pt-2 flex items-center justify-center gap-1.5 flex-wrap">
          <AlertTriangle className="h-3 w-3" />
          Rows retained for 30 days (daily pg_cron cleanup at 03:00 UTC). Auto-refreshes every 30 seconds.
        </div>
      </div>
    </TooltipProvider>
  );
}

/**
 * EdgeFunctionHealth
 *
 * Admin-only diagnostic page showing per-edge-function health over the last
 * 24 hours. Catches silent platform breakage (e.g. auth-key migrations that
 * break dozens of functions for hours) before it turns into customer-visible
 * downtime.
 *
 * Data source: `edgeFunctionHealth` edge function which queries the Supabase
 * Log Explorer via the Management API.
 *
 * Features:
 *   - Sortable table of functions, worst error-rate first.
 *   - Colour-coded error-rate badges (green <1%, amber 1-5%, red >5%).
 *   - Drill-in dialog with recent 4xx/5xx events per function.
 *   - "Run Health Check" button per function pings _health_check and
 *     reports latency + version.
 *   - Auto-refresh every 60s.
 *   - Top summary strip with total calls, success rate, and functions with
 *     high error rate.
 */

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { formatDistanceToNow, format } from "date-fns";
import { toast } from "sonner";
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
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock,
  Gauge, Loader2, Stethoscope, Copy, ShieldAlert, Server,
} from "lucide-react";

// ── helpers ────────────────────────────────────────────────────────

function fmtNum(n) {
  if (n == null) return "0";
  return Number(n).toLocaleString();
}

function relTime(ts) {
  if (!ts) return null;
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return null;
  }
}

function absTime(ts) {
  if (!ts) return null;
  try {
    return format(new Date(ts), "PPpp");
  } catch {
    return null;
  }
}

function errorRate(s) {
  if (!s || !s.total_calls) return 0;
  return s.error_count / s.total_calls;
}

/** 0 < 0.01 = green, 0.01-0.05 = amber, >0.05 = red. Returns badge classNames. */
function rateBadge(rate) {
  if (rate === 0)       return { cls: "bg-green-100 text-green-700 border-green-200",   label: "healthy" };
  if (rate < 0.01)      return { cls: "bg-green-100 text-green-700 border-green-200",   label: "healthy" };
  if (rate < 0.05)      return { cls: "bg-amber-100 text-amber-800 border-amber-200",   label: "elevated" };
  return                       { cls: "bg-red-100 text-red-700 border-red-200",         label: "errors"  };
}

function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1000)   return `${(v / 1000).toFixed(2)}s`;
  return `${v}ms`;
}

// ── summary card ───────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, tone = "default", sublabel }) {
  const toneCls = {
    default: "bg-card border-border",
    green:   "bg-green-50 border-green-200 text-green-900",
    amber:   "bg-amber-50 border-amber-200 text-amber-900",
    red:     "bg-red-50 border-red-200 text-red-900",
    blue:    "bg-blue-50 border-blue-200 text-blue-900",
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${toneCls}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium opacity-70 uppercase tracking-wide">{label}</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
          {sublabel && <p className="text-[11px] opacity-70 mt-0.5">{sublabel}</p>}
        </div>
        {Icon && <Icon className="h-5 w-5 opacity-60 flex-shrink-0" />}
      </div>
    </div>
  );
}

// ── health-check result bubble ─────────────────────────────────────

function HealthCheckPill({ hc }) {
  if (!hc) return null;
  const ok = hc.ok;
  const cls = ok
    ? "bg-green-50 border-green-200 text-green-700"
    : "bg-red-50 border-red-200 text-red-700";
  const Icon = ok ? CheckCircle2 : XCircle;
  const version = typeof hc.response === "object"
    ? (hc.response?._version || hc.response?.version)
    : null;
  return (
    <div className={`mt-1.5 text-[11px] rounded border px-1.5 py-0.5 inline-flex items-center gap-1 ${cls}`}>
      <Icon className="h-3 w-3" />
      <span className="tabular-nums">{hc.status || "ERR"} · {fmtMs(hc.latency_ms)}</span>
      {version && <span className="opacity-80">· {version}</span>}
    </div>
  );
}

// ── drill-in dialog (recent errors for a function) ─────────────────

function ErrorDetailDialog({ open, onOpenChange, functionName }) {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ["edge-fn-errors", functionName],
    queryFn: async () => {
      const res = await api.functions.invoke("edgeFunctionHealth", { function: functionName });
      return res?.data;
    },
    enabled: open && !!functionName,
    staleTime: 30_000,
  });

  const errors = data?.errors || [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-600" />
            Recent errors — <span className="font-mono text-base">{functionName}</span>
          </DialogTitle>
          <DialogDescription>
            Up to 50 most recent 4xx/5xx events from the last 24 hours.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading errors…
          </div>
        ) : isError ? (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            Failed to load: {error?.message || "unknown error"}
          </div>
        ) : errors.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No errors in the last 24 hours.
          </div>
        ) : (
          <div className="max-h-[60vh] overflow-auto border rounded-md">
            <Table>
              <TableHeader className="sticky top-0 bg-background z-10">
                <TableRow>
                  <TableHead className="w-[160px]">Timestamp</TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="w-[90px]">Latency</TableHead>
                  <TableHead>Message / request id</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((e, i) => (
                  <TableRow key={e.execution_id || i}>
                    <TableCell
                      className="text-xs font-mono text-muted-foreground"
                      title={absTime(e.timestamp_ms) || ""}
                    >
                      {relTime(e.timestamp_ms) || "—"}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={
                          (e.status_code >= 500 || !e.status_code)
                            ? "bg-red-50 border-red-200 text-red-700 font-mono"
                            : "bg-amber-50 border-amber-200 text-amber-800 font-mono"
                        }
                      >
                        {e.status_code || "???"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {fmtMs(e.execution_time_ms)}
                    </TableCell>
                    <TableCell className="max-w-[480px]">
                      <p className="text-xs break-words font-mono text-muted-foreground">
                        {e.message || <span className="italic">(no message)</span>}
                      </p>
                      {e.execution_id && (
                        <p
                          className="text-[10px] text-muted-foreground/70 mt-0.5 font-mono flex items-center gap-1 cursor-pointer hover:text-foreground"
                          onClick={() => {
                            navigator.clipboard.writeText(e.execution_id);
                            toast.success("Request ID copied");
                          }}
                          title="Click to copy"
                        >
                          <Copy className="h-2.5 w-2.5" />
                          {e.execution_id}
                        </p>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <div className="flex justify-between items-center pt-1">
          <p className="text-[11px] text-muted-foreground">
            Showing {errors.length} event{errors.length !== 1 ? "s" : ""}
          </p>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── page ──────────────────────────────────────────────────────────

export default function EdgeFunctionHealth() {
  const [detailFn, setDetailFn] = useState(null);
  const [healthChecks, setHealthChecks] = useState({}); // { [fn]: { ok, status, latency_ms, response } }

  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["edge-fn-health-overview"],
    queryFn: async () => {
      const res = await api.functions.invoke("edgeFunctionHealth", {});
      return res?.data;
    },
    staleTime: 45_000,
    refetchInterval: 60_000, // auto-refresh every 60s
    refetchOnWindowFocus: true,
  });

  const functions = data?.functions || [];
  const summary = data?.summary || { total_calls: 0, total_errors: 0, total_success: 0, overall_success_rate: 100, high_error_count: 0 };

  // Health-check mutation per fn
  const healthCheckMutation = useMutation({
    mutationFn: async (fn) => {
      const res = await api.functions.invoke("edgeFunctionHealth", {
        action: "health_check",
        function: fn,
      });
      return { fn, hc: res?.data };
    },
    onSuccess: ({ fn, hc }) => {
      setHealthChecks(prev => ({ ...prev, [fn]: hc }));
      if (hc?.ok) {
        toast.success(`${fn} healthy · ${hc.status} in ${hc.latency_ms}ms`);
      } else {
        toast.error(`${fn} unhealthy · ${hc?.status || "ERR"}${hc?.error ? ` — ${hc.error}` : ""}`);
      }
    },
    onError: (err, fn) => {
      toast.error(`Health check failed for ${fn}: ${err?.message || "unknown error"}`);
    },
  });

  const overallTone = useMemo(() => {
    if (summary.overall_success_rate >= 99) return "green";
    if (summary.overall_success_rate >= 95) return "amber";
    return "red";
  }, [summary.overall_success_rate]);

  const lastRefreshedLabel = dataUpdatedAt
    ? formatDistanceToNow(new Date(dataUpdatedAt), { addSuffix: true })
    : "never";

  // ── render ──

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-16 justify-center text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading edge function metrics…
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
              <Gauge className="h-6 w-6" />
              Edge Function Health
            </h1>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Live per-function invocation stats over the last 24 hours. Catches silent
              platform breakage (auth-key migrations, regional outages, deploy regressions)
              before it turns into a multi-hour incident.
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
                  {isFetching
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : <RefreshCw className="h-4 w-4" />}
                  Refresh
                </Button>
              </TooltipTrigger>
              <TooltipContent>Re-queries the Log Explorer (auto-refreshes every 60s)</TooltipContent>
            </Tooltip>
          </div>
        </div>

        {/* Summary strip */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Total invocations (24h)"
            value={fmtNum(summary.total_calls)}
            icon={Activity}
            tone="blue"
            sublabel={`${functions.length} functions seen`}
          />
          <StatCard
            label="Overall success rate"
            value={`${summary.overall_success_rate}%`}
            icon={CheckCircle2}
            tone={overallTone}
            sublabel={`${fmtNum(summary.total_success)} of ${fmtNum(summary.total_calls)}`}
          />
          <StatCard
            label="Errors (24h)"
            value={fmtNum(summary.total_errors)}
            icon={AlertTriangle}
            tone={summary.total_errors > 0 ? "red" : "green"}
          />
          <StatCard
            label="High error rate (>5%)"
            value={summary.high_error_count}
            icon={ShieldAlert}
            tone={summary.high_error_count > 0 ? "red" : "green"}
            sublabel="Functions needing attention"
          />
        </div>

        {/* Error state */}
        {isError && (
          <Card>
            <CardContent className="p-4">
              <div className="flex items-start gap-3 text-sm">
                <XCircle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="font-medium text-red-700">Failed to load metrics</p>
                  <p className="text-muted-foreground mt-1">
                    {error?.message || "The edgeFunctionHealth function did not respond."}
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Check the <code className="px-1 py-0.5 rounded bg-muted font-mono">MANAGEMENT_API_TOKEN</code>{" "}
                    secret is set on the function and that the caller has admin role.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Main table */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Server className="h-4 w-4" />
              Functions by health
            </CardTitle>
            <CardDescription>
              Sorted worst-first. Click a row to see recent error events.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {functions.length === 0 ? (
              <div className="py-12 text-center text-sm text-muted-foreground">
                No edge-function invocations recorded in the last 24 hours.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[220px]">Function</TableHead>
                    <TableHead className="w-[90px] text-right">Calls</TableHead>
                    <TableHead className="w-[110px] text-right">Success</TableHead>
                    <TableHead className="w-[90px] text-right">Errors</TableHead>
                    <TableHead className="w-[80px] text-right">p50</TableHead>
                    <TableHead className="w-[80px] text-right">p95</TableHead>
                    <TableHead className="w-[180px]">Last error</TableHead>
                    <TableHead className="w-[140px]">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {functions.map((fn) => {
                    const rate = errorRate(fn);
                    const badge = rateBadge(rate);
                    const hc = healthChecks[fn.function_name];
                    const hcPending =
                      healthCheckMutation.isPending &&
                      healthCheckMutation.variables === fn.function_name;
                    return (
                      <TableRow
                        key={fn.function_name}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => setDetailFn(fn.function_name)}
                      >
                        <TableCell className="font-medium">
                          <div className="flex flex-col">
                            <span className="font-mono text-sm">{fn.function_name}</span>
                            <Badge
                              variant="outline"
                              className={`${badge.cls} mt-1 w-fit text-[10px] uppercase tracking-wide`}
                            >
                              {badge.label}
                            </Badge>
                            <HealthCheckPill hc={hc} />
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fmtNum(fn.total_calls)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span
                            className={
                              fn.success_rate < 95
                                ? "text-red-600 font-semibold"
                                : fn.success_rate < 99
                                  ? "text-amber-700"
                                  : "text-green-700"
                            }
                          >
                            {fn.success_rate}%
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {fn.error_count > 0 ? (
                            <span className="text-red-600 font-semibold">{fmtNum(fn.error_count)}</span>
                          ) : (
                            <span className="text-muted-foreground">0</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {fmtMs(fn.p50_ms)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-xs">
                          {fmtMs(fn.p95_ms)}
                        </TableCell>
                        <TableCell>
                          {fn.last_error_ts ? (
                            <div className="text-xs">
                              <div className="flex items-center gap-1.5">
                                <Badge
                                  variant="outline"
                                  className="bg-red-50 border-red-200 text-red-700 font-mono h-5 px-1 text-[10px]"
                                >
                                  {fn.last_error_status || "?"}
                                </Badge>
                                <span
                                  className="text-muted-foreground"
                                  title={absTime(fn.last_error_ts) || ""}
                                >
                                  {relTime(fn.last_error_ts) || "—"}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="outline"
                            className="gap-1.5 h-7 text-xs"
                            onClick={() => healthCheckMutation.mutate(fn.function_name)}
                            disabled={hcPending}
                          >
                            {hcPending
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Stethoscope className="h-3.5 w-3.5" />}
                            Health check
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Separator />

        <div className="text-[11px] text-muted-foreground text-center pt-2 flex items-center justify-center gap-1.5 flex-wrap">
          <Clock className="h-3 w-3" />
          Metrics via Supabase Log Explorer, last {data?.lookback_hours || 24}h.
          Auto-refreshes every 60 seconds.
          {data?.generated_at && <span>· Snapshot {absTime(data.generated_at)}</span>}
        </div>

        {/* Drill-in dialog */}
        <ErrorDetailDialog
          open={!!detailFn}
          onOpenChange={(v) => !v && setDetailFn(null)}
          functionName={detailFn}
        />
      </div>
    </TooltipProvider>
  );
}

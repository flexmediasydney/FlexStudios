/**
 * SettingsOperationsHealth — Wave 7 P0-2
 *
 * Admin-only ops dashboard that pings every shortlisting edge function's
 * `_health_check` endpoint and renders the result as a row in a status
 * grid. Surfaces missing/malformed secrets immediately via the dispatcher's
 * `secrets_ok` field — see Wave 7 P0-2 backlog item.
 *
 * Round 2 (2026-04-26) cost ~15 minutes debugging a missing
 * SHORTLISTING_DISPATCHER_JWT secret. The dispatcher claimed jobs fine,
 * but every chain-call to extract/pass0/shape-d/pass3 silently 401'd.
 * This page is the visual equivalent of "is the dispatcher healthy?".
 *
 * Pattern mirrors EdgeFunctionHealth.jsx (per-fn ping + auto-refresh +
 * green/red badge) but is shortlisting-specific and intentionally cheap —
 * one fetch per fn per refresh tick (~15 fns × every 60s = 0.25 req/s
 * across all admins viewing this).
 */

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Activity, AlertTriangle, CheckCircle2, XCircle, RefreshCw, Clock,
  Stethoscope, Server, ShieldCheck, ShieldAlert, KeyRound, Loader2,
} from "lucide-react";

// ─── Function inventory ─────────────────────────────────────────────────────
//
// Every shortlisting function that exposes a `_health_check` body. Adding a
// new fn here is one line + auto-included in the next refresh tick. Order
// reflects the typical pipeline flow (dispatcher first because it's the
// keystone — a 503 here means the engine is fully blocked).
//
// `critical: true` marks the dispatcher specifically; the page elevates a
// dispatcher 503 to a banner-level alert because it implies the entire
// engine is broken, not just one fn.

const SHORTLISTING_FUNCTIONS = [
  { name: "shortlisting-job-dispatcher", critical: true,
    description: "pg_cron dispatcher — chain-calls per-pass fns" },
  { name: "shortlisting-ingest", critical: false,
    description: "round entry-point — enqueues N×extract jobs" },
  { name: "shortlisting-extract", critical: false,
    description: "per-bracket EXIF/JPEG via Modal" },
  { name: "shortlisting-pass0", critical: false,
    description: "technical filter (sharpness/exposure)" },
  { name: "shortlisting-pass3", critical: false,
    description: "coverage check + notification dispatch" },
  { name: "shortlist-lock", critical: false,
    description: "Dropbox copy/move on round-finalize" },
  { name: "shortlisting-overrides", critical: false,
    description: "human override capture" },
  { name: "shortlisting-finals-watcher", critical: false,
    description: "_finals folder watcher" },
];

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Ping a single fn's _health_check endpoint. Always resolves (never throws);
 * the row component reads `ok` to render green/red.
 *
 * Error shape captures both:
 *   - Network/timeout failures (status null, error.message)
 *   - HTTP 503 with structured body (e.g. dispatcher's
 *     `{ ok: false, error: "...not set..." }`) — the api wrapper surfaces
 *     `error.body` and `error.status` in this case.
 */
async function pingFunction(fnName) {
  const startMs = Date.now();
  try {
    const res = await api.functions.invoke(fnName, { _health_check: true }, {
      throwOnError: false,
    });
    const latency_ms = Date.now() - startMs;
    if (res?.error) {
      return {
        ok: false,
        latency_ms,
        status: res.error.status ?? null,
        message: res.error.body?.error || res.error.message || "Unknown error",
        body: res.error.body || null,
      };
    }
    return {
      ok: true,
      latency_ms,
      status: 200,
      message: "OK",
      body: res?.data || null,
    };
  } catch (err) {
    return {
      ok: false,
      latency_ms: Date.now() - startMs,
      status: null,
      message: err?.message || "Network error",
      body: null,
    };
  }
}

function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v >= 10_000) return `${(v / 1000).toFixed(1)}s`;
  if (v >= 1000) return `${(v / 1000).toFixed(2)}s`;
  return `${v}ms`;
}

// ─── Row component ──────────────────────────────────────────────────────────

function FunctionRow({ fn, result, isFetching }) {
  const ok = result?.ok === true;
  const status = result?.status ?? null;
  const body = result?.body || null;
  const version = body?._version || null;
  const secretsOk = body?.secrets_ok === true;
  const isDispatcher = fn.name === "shortlisting-job-dispatcher";

  // Status badge styling
  let badge;
  if (isFetching) {
    badge = { cls: "bg-gray-100 text-gray-600 border-gray-200", label: "checking…" };
  } else if (ok) {
    badge = { cls: "bg-green-100 text-green-700 border-green-200", label: "healthy" };
  } else {
    badge = { cls: "bg-red-100 text-red-700 border-red-200", label: "unhealthy" };
  }

  return (
    <TableRow className={!ok && !isFetching ? "bg-red-50/50" : undefined}>
      <TableCell>
        <div className="flex flex-col">
          <span className="font-mono text-sm font-medium">{fn.name}</span>
          <span className="text-xs text-muted-foreground">{fn.description}</span>
          {fn.critical && (
            <Badge
              variant="outline"
              className="mt-1 w-fit text-[10px] uppercase tracking-wide bg-blue-50 border-blue-200 text-blue-700"
            >
              critical
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell>
        <Badge variant="outline" className={`gap-1 ${badge.cls}`}>
          {isFetching ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : ok ? (
            <CheckCircle2 className="h-3 w-3" />
          ) : (
            <XCircle className="h-3 w-3" />
          )}
          {badge.label}
        </Badge>
      </TableCell>
      <TableCell className="text-right tabular-nums">
        {status != null ? (
          <span className={ok ? "text-green-700" : "text-red-700 font-semibold"}>
            {status}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right tabular-nums text-xs">
        {result ? fmtMs(result.latency_ms) : "—"}
      </TableCell>
      <TableCell className="text-xs">
        {version ? (
          <span className="font-mono text-muted-foreground">{version}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {/* Dispatcher gets a special secrets-ok pill since that's the whole
            point of the Wave 7 P0-2 strengthening. Other fns just show their
            status message on failure. */}
        {isDispatcher ? (
          <div className="flex flex-col gap-0.5">
            {ok ? (
              <Badge
                variant="outline"
                className="gap-1 w-fit bg-emerald-50 border-emerald-200 text-emerald-700 text-[11px]"
              >
                <ShieldCheck className="h-3 w-3" />
                secrets_ok: {secretsOk ? "true" : "false"}
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="gap-1 w-fit bg-red-50 border-red-200 text-red-700 text-[11px]"
              >
                <ShieldAlert className="h-3 w-3" />
                secrets check FAILED
              </Badge>
            )}
            {!ok && result?.message && (
              <span
                className="text-[11px] text-red-700 font-mono break-words mt-0.5 line-clamp-2"
                title={result.message}
              >
                {result.message}
              </span>
            )}
          </div>
        ) : !ok && result?.message ? (
          <span
            className="text-[11px] text-red-700 font-mono break-words line-clamp-2"
            title={result.message}
          >
            {result.message}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

// ─── Page body ──────────────────────────────────────────────────────────────

function PageBody() {
  const queryClient = useQueryClient();

  // One TanStack query, runs all fns in parallel via Promise.allSettled. This
  // keeps Rules of Hooks happy (no useQuery inside a .map()) while still
  // letting individual fns succeed/fail independently. The inner promises
  // fire in parallel so one slow fn doesn't block another.
  //
  // Auto-refreshes every 60s; 30s staleTime so a manual click within the
  // window doesn't re-fetch unnecessarily.
  const allQuery = useQuery({
    queryKey: ["ops-health-all"],
    queryFn: async () => {
      const settled = await Promise.allSettled(
        SHORTLISTING_FUNCTIONS.map((fn) =>
          pingFunction(fn.name).then((r) => ({ name: fn.name, ...r })),
        ),
      );
      const out = {};
      settled.forEach((s, i) => {
        const fn = SHORTLISTING_FUNCTIONS[i];
        if (s.status === "fulfilled") {
          out[fn.name] = s.value;
        } else {
          out[fn.name] = {
            ok: false,
            latency_ms: 0,
            status: null,
            message: s.reason?.message || "fetch threw",
            body: null,
          };
        }
      });
      return out;
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  // Index results by fn name so we can pair with the inventory order.
  const resultsByName = useMemo(() => {
    const m = new Map();
    const data = allQuery.data || {};
    for (const fn of SHORTLISTING_FUNCTIONS) {
      m.set(fn.name, {
        result: data[fn.name] || null,
        isFetching: allQuery.isFetching && !data[fn.name],
        isLoading: allQuery.isLoading,
      });
    }
    return m;
  }, [allQuery.data, allQuery.isFetching, allQuery.isLoading]);

  // Aggregate stats
  const stats = useMemo(() => {
    let healthy = 0;
    let unhealthy = 0;
    let pending = 0;
    let dispatcherOk = null; // null | true | false
    let secretsOk = null; // null | true | false
    for (const fn of SHORTLISTING_FUNCTIONS) {
      const e = resultsByName.get(fn.name);
      if (!e?.result) {
        pending += 1;
      } else if (e.result.ok) {
        healthy += 1;
      } else {
        unhealthy += 1;
      }
      if (fn.name === "shortlisting-job-dispatcher" && e?.result) {
        dispatcherOk = e.result.ok;
        secretsOk = e.result.body?.secrets_ok === true;
      }
    }
    return { healthy, unhealthy, pending, dispatcherOk, secretsOk };
  }, [resultsByName]);

  // Has any function returned 503?
  const has503 = useMemo(() => {
    for (const e of resultsByName.values()) {
      if (e?.result && e.result.status === 503) return true;
    }
    return false;
  }, [resultsByName]);

  const lastRefreshedAt = allQuery.dataUpdatedAt || null;
  const lastRefreshedLabel = lastRefreshedAt
    ? formatDistanceToNow(new Date(lastRefreshedAt), { addSuffix: true })
    : "never";

  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: ["ops-health-all"] });
    toast.success("Refreshing health checks…");
  };

  const isAnyFetching = allQuery.isFetching;
  const isInitialLoading = allQuery.isLoading;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Stethoscope className="h-6 w-6" />
            Operations Health
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Live health probe of every shortlisting edge function. Pings each
            fn's <code className="px-1 py-0.5 rounded bg-muted font-mono">_health_check</code>{" "}
            endpoint and surfaces missing/malformed secrets via the dispatcher's
            <code className="px-1 py-0.5 rounded bg-muted font-mono">secrets_ok</code>{" "}
            field. Auto-refreshes every 60 seconds.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Clock className="h-3 w-3" />
            Updated {lastRefreshedLabel}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={refreshAll}
            disabled={isAnyFetching}
          >
            {isAnyFetching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh All
          </Button>
        </div>
      </div>

      {/* Banner-level alerts */}
      {/* Dispatcher 503 / secrets-missing → critical alert because the engine
          is fully blocked. Wave 7 P0-2 deliverable. */}
      {stats.dispatcherOk === false && (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Dispatcher unhealthy — engine is blocked</AlertTitle>
          <AlertDescription className="mt-1 space-y-1">
            <p>
              The shortlisting-job-dispatcher health-check is failing.
              {has503 && " Returned HTTP 503."}{" "}
              No new shortlisting jobs will be processed until this is fixed.
            </p>
            <p className="text-xs">
              See <code className="px-1 py-0.5 rounded bg-background/50 font-mono">docs/DEPLOYMENT_RUNBOOK.md</code>{" "}
              → "SHORTLISTING_DISPATCHER_JWT" section for the fix.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Generic 503 alert (non-dispatcher) — still actionable but lower
          severity since other fns failing means specific phases broken,
          not the whole engine. */}
      {stats.dispatcherOk !== false && has503 && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>One or more functions returned 503</AlertTitle>
          <AlertDescription>
            A shortlisting function is in a service-unavailable state. Inspect
            the row(s) below to see which secret or upstream is missing.
          </AlertDescription>
        </Alert>
      )}

      {/* Top stat strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Healthy"
          value={stats.healthy}
          icon={CheckCircle2}
          tone={stats.healthy === SHORTLISTING_FUNCTIONS.length ? "green" : "default"}
          sublabel={`of ${SHORTLISTING_FUNCTIONS.length} functions`}
        />
        <StatCard
          label="Unhealthy"
          value={stats.unhealthy}
          icon={AlertTriangle}
          tone={stats.unhealthy > 0 ? "red" : "default"}
          sublabel={stats.unhealthy > 0 ? "Needs attention" : "All clear"}
        />
        <StatCard
          label="Dispatcher"
          value={
            stats.dispatcherOk === null
              ? "…"
              : stats.dispatcherOk
                ? "OK"
                : "FAIL"
          }
          icon={Activity}
          tone={
            stats.dispatcherOk === null
              ? "default"
              : stats.dispatcherOk
                ? "green"
                : "red"
          }
          sublabel="Engine keystone"
        />
        <StatCard
          label="Critical secrets"
          value={
            stats.secretsOk === null
              ? "…"
              : stats.secretsOk
                ? "OK"
                : "MISSING"
          }
          icon={KeyRound}
          tone={
            stats.secretsOk === null
              ? "default"
              : stats.secretsOk
                ? "green"
                : "red"
          }
          sublabel={
            stats.secretsOk === false
              ? "SHORTLISTING_DISPATCHER_JWT"
              : "Dispatcher reports secrets_ok"
          }
        />
      </div>

      {/* Main table */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Server className="h-4 w-4" />
            Functions
          </CardTitle>
          <CardDescription>
            Each row pings <code className="px-1 py-0.5 rounded bg-muted font-mono">_health_check: true</code>.
            Critical functions are highlighted; the dispatcher is the keystone.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {isInitialLoading ? (
            <div className="flex items-center gap-2 py-12 justify-center text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" /> Probing functions…
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[280px]">Function</TableHead>
                  <TableHead className="w-[110px]">Status</TableHead>
                  <TableHead className="w-[80px] text-right">HTTP</TableHead>
                  <TableHead className="w-[90px] text-right">Latency</TableHead>
                  <TableHead className="w-[100px]">Version</TableHead>
                  <TableHead>Detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SHORTLISTING_FUNCTIONS.map((fn) => {
                  const e = resultsByName.get(fn.name);
                  return (
                    <FunctionRow
                      key={fn.name}
                      fn={fn}
                      result={e?.result}
                      isFetching={e?.isFetching}
                    />
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
        Auto-refreshes every 60 seconds. Each probe is a single
        <code className="px-1 py-0.5 mx-0.5 rounded bg-muted font-mono">_health_check</code>
        invocation. See
        <code className="px-1 py-0.5 mx-0.5 rounded bg-muted font-mono">docs/DEPLOYMENT_RUNBOOK.md</code>
        for secret reference.
      </div>
    </div>
  );
}

// ─── Tiny stat card ────────────────────────────────────────────────────────

function StatCard({ label, value, icon: Icon, tone = "default", sublabel }) {
  const toneCls = {
    default: "bg-card border-border",
    green: "bg-green-50 border-green-200 text-green-900",
    amber: "bg-amber-50 border-amber-200 text-amber-900",
    red: "bg-red-50 border-red-200 text-red-900",
  }[tone];
  return (
    <div className={`rounded-lg border p-4 ${toneCls}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs font-medium opacity-70 uppercase tracking-wide">
            {label}
          </p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{value}</p>
          {sublabel && (
            <p className="text-[11px] opacity-70 mt-0.5">{sublabel}</p>
          )}
        </div>
        {Icon && <Icon className="h-5 w-5 opacity-60 flex-shrink-0" />}
      </div>
    </div>
  );
}

// ─── Page export with PermissionGuard ───────────────────────────────────────

export default function SettingsOperationsHealth() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <PageBody />
    </PermissionGuard>
  );
}

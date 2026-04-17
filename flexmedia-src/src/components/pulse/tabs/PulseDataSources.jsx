/**
 * PulseDataSources — Industry Pulse "Sources" tab.
 * Manages REA scraper runs, cron schedule display, sync history,
 * suburb pool, and raw payload drill-through.
 */
import React, { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Database, Users, Home, DollarSign, Clock, CheckCircle2,
  AlertTriangle, Loader2, Plus, Trash2, Settings2,
  ChevronDown, ChevronUp, Eye, MapPin, ToggleLeft, ToggleRight,
  ExternalLink, Repeat, Globe, Calendar, Coins, FileCode2,
  User, XCircle, Activity, Copy, Edit3, Save, AlertCircle,
  ChevronLeft, ChevronRight, Filter, Download, History, X,
} from "lucide-react";

// ── Source UI metadata ────────────────────────────────────────────────────────
// The authoritative config (actor_input, max_results_per_suburb, schedule_cron,
// is_enabled, etc.) lives in pulse_source_configs (DB). UI metadata below is
// purely presentational — icon, gradient, cost estimate. New sources added in
// the DB will get sensible defaults here.

const SOURCE_UI_META = {
  rea_agents: {
    icon: Users,
    color: "text-red-600",
    accentClass: "from-red-500/10 to-red-600/5 border-red-200/60 dark:border-red-800/40",
    costNote: "~$0.005/suburb",
  },
  rea_listings: {
    icon: Home,
    color: "text-blue-600",
    accentClass: "from-blue-500/10 to-blue-600/5 border-blue-200/60 dark:border-blue-800/40",
    costNote: "~$0.01/suburb",
  },
  rea_listings_bb_buy: {
    icon: DollarSign,
    color: "text-green-600",
    accentClass: "from-emerald-500/10 to-green-600/5 border-emerald-200/60 dark:border-emerald-800/40",
    costNote: "~$0.05/run",
  },
  rea_listings_bb_rent: {
    icon: Home,
    color: "text-teal-600",
    accentClass: "from-teal-500/10 to-teal-600/5 border-teal-200/60 dark:border-teal-800/40",
    costNote: "~$0.05/run",
  },
  rea_listings_bb_sold: {
    icon: DollarSign,
    color: "text-orange-600",
    accentClass: "from-orange-500/10 to-orange-600/5 border-orange-200/60 dark:border-orange-800/40",
    costNote: "~$0.05/run",
  },
};

const DEFAULT_META = {
  icon: Database,
  color: "text-slate-600",
  accentClass: "from-slate-500/10 to-slate-600/5 border-slate-200/60 dark:border-slate-800/40",
  costNote: "—",
};

function getSourceMeta(sourceId) {
  return SOURCE_UI_META[sourceId] || DEFAULT_META;
}

// ── Cron decoder (human-readable summary of cron string) ──────────────────────

function cronLabel(cronStr) {
  if (!cronStr) return "On-demand";
  // Handle common cron patterns
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [min, hour, dom, month, dow] = parts;

  // Weekly: "0 18 * * 0" -> "Weekly (Sun)"
  if (dom === "*" && month === "*" && dow !== "*") {
    const days = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" };
    return `Weekly (${days[dow] || dow}) ${hour}:${String(min).padStart(2, "0")} UTC`;
  }

  // Daily with comma hours: "0 20,4 * * *" -> "Daily 20 + 4 UTC"
  if (dom === "*" && month === "*" && dow === "*" && hour.includes(",")) {
    return `Daily ${hour}:${String(min).padStart(2, "0")} UTC`;
  }

  // Daily: "0 22 * * *" -> "Daily 22:00 UTC"
  if (dom === "*" && month === "*" && dow === "*") {
    return `Daily ${hour}:${String(min).padStart(2, "0")} UTC`;
  }

  return cronStr;
}

function nextRunFromCron(cronStr) {
  if (!cronStr) return "—";
  // Best-effort: parse cron and predict next UTC occurrence.
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return "—";
  const [min, hour, dom, month, dow] = parts;
  try {
    const now = new Date();
    const mins = parseInt(min, 10);
    if (isNaN(mins)) return "—";

    // Handle comma-separated hours (e.g., "20,4")
    const hours = hour.includes(",") ? hour.split(",").map((h) => parseInt(h, 10)) : [parseInt(hour, 10)];
    if (hours.some(isNaN)) return "—";

    // Weekly
    if (dom === "*" && month === "*" && dow !== "*") {
      const targetDow = parseInt(dow, 10);
      if (isNaN(targetDow)) return "—";
      const daysUntil = (targetDow - now.getUTCDay() + 7) % 7 || 7;
      const next = new Date(now);
      next.setUTCDate(now.getUTCDate() + daysUntil);
      next.setUTCHours(hours[0], mins, 0, 0);
      return next.toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }

    // Daily (potentially multiple hours)
    if (dom === "*" && month === "*" && dow === "*") {
      // Find next hour today or tomorrow
      const candidates = hours.map((h) => {
        const d = new Date(now);
        d.setUTCHours(h, mins, 0, 0);
        if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
        return d;
      });
      candidates.sort((a, b) => a.getTime() - b.getTime());
      return candidates[0].toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }

    return "—";
  } catch {
    return "—";
  }
}

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

// Backward-compat shim: original `nextCronLabel` took a human-readable schedule
// string. We now prefer nextRunFromCron(cronStr). Keep this thin wrapper so
// any residual callers still compile.
function nextCronLabel(scheduleOrCron) {
  if (!scheduleOrCron) return "—";
  // Detect cron string (5 space-separated parts)
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(scheduleOrCron.trim())) {
    return nextRunFromCron(scheduleOrCron);
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

// --- Source Card (enhanced, DB-driven) ---
//
// Everything the user sees on each source card reads from the DB row
// `sourceConfig` (pulse_source_configs). The icon/accent are the only thing
// pulled from local UI metadata. The card shows the FULL actor_input JSON
// (never truncated), has a Copy button, and an Edit button that opens the
// editor dialog.

function SourceCard({ sourceConfig, lastLog, pulseTimeline, activeSuburbCount, isRunning, onRun, onOpenPayload, onOpenSchedule, onEdit, onDrillDispatch, onViewHistory }) {
  const meta = getSourceMeta(sourceConfig.source_id);
  const Icon = meta.icon;
  const lastStatus = lastLog?.status;
  const [showInput, setShowInput] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);

  // Pull aggregated runs from the view. First run is the "latest"; rest are history.
  const { runs: syncRuns } = usePulseSyncRuns(sourceConfig.source_id, 10);
  const latestRun = syncRuns[0] || null;
  const historyRuns = syncRuns.slice(1);
  const isBoundingBox = sourceConfig.approach === "bounding_box";
  const approachLabel = isBoundingBox ? "Bounding box" : "Per-suburb iteration";
  const cronStr = sourceConfig.schedule_cron || null;
  const scheduleDisplay = cronLabel(cronStr);
  const perSuburbMax = sourceConfig.max_results_per_suburb || 0;
  const actorInput = sourceConfig.actor_input || {};
  const actorInputJson = useMemo(() => JSON.stringify(actorInput, null, 2), [actorInput]);

  const copyInput = useCallback(() => {
    try {
      navigator.clipboard.writeText(actorInputJson);
      toast.success("actor_input copied to clipboard");
    } catch {
      toast.error("Clipboard unavailable");
    }
  }, [actorInputJson]);

  // Detect "cron_dispatched" event without a matching sync_log (queuing state)
  const hasRecentDispatchWithoutLog = useMemo(() => {
    if (latestRun || !Array.isArray(pulseTimeline)) return false;
    const now = Date.now();
    return pulseTimeline.some((ev) => {
      if (ev.event_type !== "cron_dispatched") return false;
      const newVal = ev.new_value;
      if (newVal?.source_id && newVal.source_id !== sourceConfig.source_id) return false;
      if (!newVal?.source_id && !(ev.title || "").includes((sourceConfig.label || "").split(" ")[1] || "")) {
        return false;
      }
      const ageMs = now - new Date(ev.created_at).getTime();
      return ageMs < 10 * 60 * 1000; // within 10 minutes
    });
  }, [pulseTimeline, latestRun, sourceConfig.source_id, sourceConfig.label]);

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

  // Staleness warning — heuristic from cron string
  if (lastRunAt && statusDot !== "bg-blue-500 animate-pulse") {
    const ageMs = Date.now() - new Date(lastRunAt).getTime();
    const ageDays = ageMs / 86400000;
    // Weekly schedules = 9 day limit; daily = 2 day limit; no schedule = no check
    const isWeekly = cronStr && /^\S+\s+\S+\s+\*\s+\*\s+[0-6]$/.test(cronStr);
    const limit = isWeekly ? 9 : cronStr ? 2 : Infinity;
    if (ageDays > limit && lastStatus !== "failed") statusDot = "bg-amber-500";
  }

  // Disabled source — visually faded
  const isDisabled = sourceConfig.is_enabled === false;

  return (
    <Card className={cn(
      "rounded-xl border shadow-sm hover:shadow-md transition-shadow bg-gradient-to-br",
      meta.accentClass,
      isDisabled && "opacity-60 grayscale-[40%]",
    )}>
      <CardContent className="p-4 flex flex-col gap-3">
        {/* Header row: icon + label + Apify link + enabled indicator */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <div className="p-2 rounded-lg bg-background/80 shrink-0 border shadow-sm">
              <Icon className={cn("h-4 w-4", meta.color)} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <p className="text-sm font-semibold leading-tight truncate">{sourceConfig.label}</p>
                <span className={cn("inline-block h-1.5 w-1.5 rounded-full shrink-0", statusDot)} title={lastStatus || "never run"} />
                {isDisabled && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0 uppercase border-muted-foreground/40 text-muted-foreground">
                    Disabled
                  </Badge>
                )}
              </div>
              {sourceConfig.actor_slug && (
                <a
                  href={sourceConfig.apify_store_url || `https://apify.com/${sourceConfig.actor_slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[10px] text-muted-foreground hover:text-primary transition-colors mt-0.5 font-mono"
                >
                  {sourceConfig.actor_slug}
                  <ExternalLink className="h-2.5 w-2.5" />
                </a>
              )}
            </div>
          </div>
        </div>

        {/* Approach + schedule row */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] px-1.5 py-0 uppercase tracking-wide font-semibold",
                !isBoundingBox
                  ? "border-indigo-400/50 text-indigo-700 bg-indigo-50 dark:bg-indigo-900/30 dark:text-indigo-300"
                  : "border-cyan-400/50 text-cyan-700 bg-cyan-50 dark:bg-cyan-900/30 dark:text-cyan-300",
              )}
            >
              {!isBoundingBox ? <Repeat className="h-2.5 w-2.5 mr-1" /> : <Globe className="h-2.5 w-2.5 mr-1" />}
              {approachLabel}
            </Badge>
            {cronStr ? (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono" title={cronStr}>
                <Clock className="h-2.5 w-2.5 mr-1" />
                {scheduleDisplay}
              </Badge>
            ) : (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">
                On-demand
              </Badge>
            )}
          </div>
          {!isBoundingBox ? (
            <PerSuburbDiagram suburbCount={activeSuburbCount} perSuburb={perSuburbMax} />
          ) : (
            <BoundingBoxDiagram region="Greater Sydney" maxItems={actorInput.maxItems || perSuburbMax} />
          )}
        </div>

        {/* Input (FULL, expanded by default). Shows the exact actor_input that
            Apify receives, unabridged. URLs wrap within the pre block. */}
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setShowInput((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground transition-colors"
            >
              <FileCode2 className="h-3 w-3" />
              <span>actor_input</span>
              {showInput ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </button>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={copyInput}
                className="inline-flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors"
                title="Copy JSON"
              >
                <Copy className="h-3 w-3" />
              </button>
              <button
                type="button"
                onClick={() => onEdit(sourceConfig)}
                className="inline-flex items-center gap-1 text-[9px] text-muted-foreground hover:text-primary transition-colors"
                title="Edit config"
              >
                <Edit3 className="h-3 w-3" />
                <span>Edit</span>
              </button>
            </div>
          </div>
          {showInput && (
            <pre className="rounded-md bg-background/80 border p-2 font-mono text-[10px] whitespace-pre-wrap break-all overflow-x-auto max-h-56 overflow-y-auto">
              {actorInputJson}
            </pre>
          )}
        </div>

        {/* Config summary row: max_results, max_suburbs, min_priority */}
        <div className="grid grid-cols-3 gap-1 text-[9px]">
          <div className="rounded bg-background/60 border px-2 py-1">
            <div className="text-muted-foreground uppercase tracking-wide">Max results</div>
            <div className="font-mono font-semibold">{sourceConfig.max_results_per_suburb ?? "—"}</div>
          </div>
          {!isBoundingBox ? (
            <>
              <div className="rounded bg-background/60 border px-2 py-1">
                <div className="text-muted-foreground uppercase tracking-wide">Max suburbs</div>
                <div className="font-mono font-semibold">{sourceConfig.max_suburbs ?? "—"}</div>
              </div>
              <div className="rounded bg-background/60 border px-2 py-1">
                <div className="text-muted-foreground uppercase tracking-wide">Min priority</div>
                <div className="font-mono font-semibold">{sourceConfig.min_priority ?? 0}</div>
              </div>
            </>
          ) : (
            <div className="col-span-2 rounded bg-background/60 border px-2 py-1">
              <div className="text-muted-foreground uppercase tracking-wide">Cost estimate</div>
              <div className="font-mono font-semibold">{meta.costNote}</div>
            </div>
          )}
        </div>

        {/* Last run summary */}
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

        {/* Next run — computed from DB cron string */}
        <div className="flex items-center justify-between text-[10px] text-muted-foreground px-1">
          <span className="flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Next: <span className="font-medium text-foreground">{cronStr ? nextRunFromCron(cronStr) : "—"}</span>
          </span>
          <span className="flex items-center gap-1">
            <Coins className="h-3 w-3" />
            <span className="font-medium text-foreground">{meta.costNote}</span>
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
            onClick={() => onRun(sourceConfig)}
            disabled={isRunning || isDisabled}
            title={isDisabled ? "Source disabled — enable in Edit dialog" : undefined}
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
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => onEdit(sourceConfig)}
            title="Edit config"
          >
            <Edit3 className="h-3 w-3" />
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
          {onViewHistory && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2 text-[10px]"
              onClick={() => onViewHistory(sourceConfig.source_id)}
              title="View full sync history for this source"
            >
              <History className="h-3 w-3" />
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[10px]"
            onClick={() => onOpenSchedule(sourceConfig)}
            title="View schedule details"
          >
            <Calendar className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// --- Config Edit Dialog ---
//
// Allows editing: actor_input JSON (freeform, validated on save),
// max_results_per_suburb, max_suburbs, min_priority, schedule_cron,
// is_enabled. Persists to pulse_source_configs. A success triggers
// refetchEntityList('PulseSourceConfig') so the card reflects changes.

function EditConfigDialog({ config, onClose, onSaved }) {
  const [form, setForm] = useState(() => ({
    actor_input_json: JSON.stringify(config?.actor_input || {}, null, 2),
    max_results_per_suburb: config?.max_results_per_suburb ?? "",
    max_suburbs: config?.max_suburbs ?? "",
    min_priority: config?.min_priority ?? 0,
    schedule_cron: config?.schedule_cron || "",
    is_enabled: config?.is_enabled !== false,
    label: config?.label || "",
    description: config?.description || "",
    notes: config?.notes || "",
  }));
  const [saving, setSaving] = useState(false);
  const [jsonError, setJsonError] = useState(null);

  // Render actor_input as individual fields + a JSON textarea for power users.
  const parsedInput = useMemo(() => {
    try {
      const p = JSON.parse(form.actor_input_json);
      setJsonError(null);
      return p;
    } catch (e) {
      setJsonError(e.message);
      return null;
    }
  }, [form.actor_input_json]);

  const updateInputField = useCallback((key, value) => {
    setForm((f) => {
      let current = {};
      try {
        current = JSON.parse(f.actor_input_json);
      } catch {
        // keep invalid JSON untouched — user will see the error
        return f;
      }
      // Try to coerce to number if original was a number
      const origType = typeof current[key];
      let coerced = value;
      if (origType === "number" && value !== "" && !isNaN(Number(value))) {
        coerced = Number(value);
      } else if (origType === "boolean" && (value === "true" || value === "false")) {
        coerced = value === "true";
      }
      current[key] = coerced;
      return { ...f, actor_input_json: JSON.stringify(current, null, 2) };
    });
  }, []);

  const removeInputField = useCallback((key) => {
    setForm((f) => {
      let current = {};
      try {
        current = JSON.parse(f.actor_input_json);
      } catch {
        return f;
      }
      delete current[key];
      return { ...f, actor_input_json: JSON.stringify(current, null, 2) };
    });
  }, []);

  const addInputField = useCallback(() => {
    const key = prompt("Field name (e.g. maxPages, startUrl)");
    if (!key) return;
    setForm((f) => {
      let current = {};
      try {
        current = JSON.parse(f.actor_input_json);
      } catch {
        return f;
      }
      if (key in current) {
        toast.error(`Field '${key}' already exists`);
        return f;
      }
      current[key] = "";
      return { ...f, actor_input_json: JSON.stringify(current, null, 2) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (jsonError) {
      toast.error(`Fix JSON: ${jsonError}`);
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(form.actor_input_json);
    } catch (e) {
      toast.error(`Invalid JSON: ${e.message}`);
      return;
    }
    setSaving(true);
    try {
      const updates = {
        actor_input: parsed,
        max_results_per_suburb: form.max_results_per_suburb === "" ? null : Number(form.max_results_per_suburb),
        max_suburbs: form.max_suburbs === "" ? null : Number(form.max_suburbs),
        min_priority: form.min_priority === "" ? 0 : Number(form.min_priority),
        schedule_cron: form.schedule_cron.trim() || null,
        is_enabled: !!form.is_enabled,
        label: form.label,
        description: form.description,
        notes: form.notes || null,
      };
      await api.entities.PulseSourceConfig.update(config.id, updates);
      await refetchEntityList("PulseSourceConfig");
      toast.success(`Saved: ${form.label}`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(`Save failed: ${err.message || err}`);
    } finally {
      setSaving(false);
    }
  }, [form, config?.id, jsonError, onClose, onSaved]);

  if (!config) return null;

  return (
    <Dialog open={!!config} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Settings2 className="h-4 w-4" />
            Edit config: {config.label}
            <Badge variant="outline" className="text-[9px] font-mono">{config.source_id}</Badge>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-xs">
          {/* Warning callout */}
          <div className="rounded-md border border-amber-400/50 bg-amber-50 dark:bg-amber-950/30 p-2 flex items-start gap-2 text-[11px] text-amber-800 dark:text-amber-300">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              Changes take effect on the next <strong>Run Now</strong> click or scheduled cron run.
              pulseFireScrapes, pulseScheduledScrape and pulseDataSync all read from this row.
            </div>
          </div>

          {/* Label + description */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Label</Label>
              <Input
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Enabled</Label>
                <div className="h-8 flex items-center gap-2">
                  <Switch
                    checked={!!form.is_enabled}
                    onCheckedChange={(v) => setForm((f) => ({ ...f, is_enabled: v }))}
                  />
                  <span className="text-[11px] text-muted-foreground">
                    {form.is_enabled ? "Active" : "Disabled (cron & Run Now skip)"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Description</Label>
            <Input
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="h-8 text-xs"
            />
          </div>

          {/* actor_input — key/value editor + raw JSON fallback */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">
                actor_input (passed verbatim to Apify)
              </Label>
              <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]" onClick={addInputField}>
                <Plus className="h-3 w-3 mr-1" />
                Add field
              </Button>
            </div>

            {parsedInput && (
              <div className="rounded-md border p-2 bg-background/60 space-y-1.5">
                {Object.keys(parsedInput).length === 0 && (
                  <p className="text-[10px] text-muted-foreground italic">No fields. Click "Add field" or paste JSON below.</p>
                )}
                {Object.entries(parsedInput).map(([k, v]) => {
                  const origType = typeof v;
                  const isLong = typeof v === "string" && v.length > 60;
                  return (
                    <div key={k} className="flex items-start gap-1.5">
                      <span className="font-mono text-[10px] font-semibold text-primary/80 w-28 shrink-0 pt-1.5 truncate" title={k}>
                        {k}
                      </span>
                      {origType === "boolean" ? (
                        <select
                          value={String(v)}
                          onChange={(e) => updateInputField(k, e.target.value)}
                          className="h-7 text-[11px] font-mono rounded border bg-background px-1 flex-1"
                        >
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : isLong ? (
                        <Textarea
                          value={String(v ?? "")}
                          onChange={(e) => updateInputField(k, e.target.value)}
                          className="font-mono text-[10px] min-h-[44px] flex-1"
                        />
                      ) : (
                        <Input
                          type={origType === "number" ? "number" : "text"}
                          value={v ?? ""}
                          onChange={(e) => updateInputField(k, e.target.value)}
                          className="h-7 text-[11px] font-mono flex-1"
                        />
                      )}
                      <button
                        type="button"
                        onClick={() => removeInputField(k)}
                        className="h-7 w-7 rounded hover:bg-red-50 dark:hover:bg-red-950/30 text-muted-foreground hover:text-red-600 transition-colors flex items-center justify-center shrink-0"
                        title={`Remove ${k}`}
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  );
                })}
                <p className="text-[9px] text-muted-foreground italic pt-1 border-t">
                  Placeholders: <code className="font-mono">{"{suburb}"}</code> substitutes the current suburb name;{" "}
                  <code className="font-mono">{"{suburb-slug}"}</code> substitutes the slugified form.
                </p>
              </div>
            )}

            <details>
              <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">
                Edit as raw JSON
              </summary>
              <Textarea
                value={form.actor_input_json}
                onChange={(e) => setForm((f) => ({ ...f, actor_input_json: e.target.value }))}
                className="font-mono text-[10px] min-h-[120px] mt-1"
                spellCheck={false}
              />
              {jsonError && (
                <p className="text-[10px] text-red-600 mt-1">JSON error: {jsonError}</p>
              )}
            </details>
          </div>

          {/* Run controls */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">max_results_per_suburb</Label>
              <Input
                type="number"
                value={form.max_results_per_suburb}
                onChange={(e) => setForm((f) => ({ ...f, max_results_per_suburb: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">max_suburbs (cron cap)</Label>
              <Input
                type="number"
                value={form.max_suburbs}
                onChange={(e) => setForm((f) => ({ ...f, max_suburbs: e.target.value }))}
                className="h-8 text-xs"
                placeholder="n/a for bounding_box"
              />
            </div>
            <div>
              <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">min_priority</Label>
              <Input
                type="number"
                value={form.min_priority}
                onChange={(e) => setForm((f) => ({ ...f, min_priority: e.target.value }))}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {/* Cron */}
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">schedule_cron (UTC)</Label>
            <Input
              value={form.schedule_cron}
              onChange={(e) => setForm((f) => ({ ...f, schedule_cron: e.target.value }))}
              className="h-8 text-xs font-mono"
              placeholder="e.g. 0 18 * * 0  (leave blank for on-demand)"
            />
            <div className="text-[10px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              <span>Parsed:</span>
              <Badge variant="outline" className="text-[9px] font-mono">
                {form.schedule_cron ? cronLabel(form.schedule_cron) : "On-demand"}
              </Badge>
              {form.schedule_cron && (
                <>
                  <span>Next:</span>
                  <Badge variant="outline" className="text-[9px]">
                    {nextRunFromCron(form.schedule_cron)}
                  </Badge>
                </>
              )}
            </div>
            <p className="text-[9px] text-muted-foreground mt-1 italic">
              Note: editing this field updates the DB row only. The actual pg_cron job schedule lives in cron.job and must be updated separately if you change the schedule.
            </p>
          </div>

          {/* Notes */}
          <div>
            <Label className="text-[10px] uppercase tracking-wide text-muted-foreground">Notes (internal)</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              className="text-[11px] min-h-[44px]"
              placeholder="Internal notes about this source"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || !!jsonError}>
            {saving ? (
              <>
                <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                Saving...
              </>
            ) : (
              <>
                <Save className="h-3 w-3 mr-1.5" />
                Save changes
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --- Cron Schedule Table (DB-driven) ---
// Lists every pulse_source_configs row that has a schedule_cron. No hardcoded
// source list.

function CronScheduleTable({ runningSources, lastLogBySource, sourceConfigs }) {
  const scheduled = useMemo(
    () => (sourceConfigs || []).filter((c) => c.schedule_cron && c.is_enabled !== false),
    [sourceConfigs]
  );
  return (
    <Card className="rounded-xl border shadow-sm">
      <CardHeader className="pb-2 px-4 pt-4">
        <CardTitle className="text-sm font-semibold flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-muted-foreground" />
          Scheduled Runs
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">{scheduled.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {scheduled.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No scheduled sources.</p>
        ) : (
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
              {scheduled.map((config) => {
                const lastRun = config.last_run_at || lastLogBySource?.[config.source_id]?.started_at;
                return (
                  <tr key={config.source_id} className="border-b last:border-0">
                    <td className="py-2 pr-3 font-medium">{config.label}</td>
                    <td className="py-2 pr-3 text-muted-foreground font-mono text-[10px]" title={config.schedule_cron}>
                      {cronLabel(config.schedule_cron)}
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{fmtRelativeTs(lastRun)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{nextRunFromCron(config.schedule_cron)}</td>
                    <td className="py-2">
                      {runningSources.has(config.source_id) ? (
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
        )}
      </CardContent>
    </Card>
  );
}

// --- Sync History Table (paginated, filtered, server-fetched) ---
//
// Replaces the previous client-side .slice(0, 20) cap. The full pulse_sync_logs
// table is the authoritative audit trail for every Apify dispatch — capping at
// 20 hid hours of history. Now we fetch server-side with proper pagination,
// filters (source / status / time-window), CSV export, and a 60s auto-refresh
// toggle. Matches the design language of /EdgeFunctionAuditLog.
//
// Props:
//   sourceConfigs   — used to populate the Source dropdown
//   onDrill(log)    — open the raw-payload dialog
//   filterSourceId  — controlled "deep-link" filter (set by SourceCard "View History")
//   onChangeFilter  — clears/changes the controlled filter

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const TIME_WINDOWS = [
  { value: "1h",  label: "Last 1 hour",   ms: 60 * 60 * 1000 },
  { value: "24h", label: "Last 24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d",  label: "Last 7 days",   ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", label: "Last 30 days",  ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All time",      ms: null },
];

// Stats summary derived from result_summary jsonb. Used for CSV column too.
function recordsSummaryFlat(log) {
  const s = log?.result_summary || {};
  const a = s.agents_processed ?? "";
  const l = s.listings_stored ?? "";
  const r = s.records_saved ?? "";
  return { agents: a, listings: l, records: r };
}

function downloadCsv(rows) {
  const header = [
    "started_at", "completed_at", "source_id", "source_label", "status",
    "duration_sec", "agents_processed", "listings_stored", "records_saved",
    "triggered_by", "triggered_by_name", "apify_run_id", "error_message",
  ];
  const escape = (v) => {
    if (v == null) return "";
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(",")];
  for (const log of rows) {
    const dur = log.started_at && log.completed_at
      ? Math.max(0, Math.round((new Date(log.completed_at) - new Date(log.started_at)) / 1000))
      : "";
    const sums = recordsSummaryFlat(log);
    lines.push([
      log.started_at || "",
      log.completed_at || "",
      log.source_id || "",
      log.source_label || "",
      log.status || "",
      dur,
      sums.agents,
      sums.listings,
      sums.records,
      log.triggered_by || "",
      log.triggered_by_name || "",
      log.apify_run_id || "",
      (log.error_message || "").slice(0, 500),
    ].map(escape).join(","));
  }
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pulse_sync_logs_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function SyncHistory({ sourceConfigs = [], onDrill, filterSourceId, onChangeFilter }) {
  // ── filter state ──
  const [statusFilter, setStatusFilter] = useState("all");
  // Default to "all time" — the user's intent for sync history is the full
  // audit trail, not a recent window. They can narrow with the time-window
  // dropdown if they want.
  const [timeWindow, setTimeWindow] = useState("all");
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(0);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastFetched, setLastFetched] = useState(null);

  // Reset page on filter change
  useEffect(() => { setPage(0); }, [filterSourceId, statusFilter, timeWindow, pageSize]);

  // Build dropdown of distinct source_ids — combine known configs + any
  // source_ids seen on the current page (so historical/legacy ids still appear).
  const sourceOptions = useMemo(() => {
    const map = new Map();
    for (const c of sourceConfigs || []) {
      if (c.source_id) map.set(c.source_id, c.label || c.source_id);
    }
    for (const r of rows) {
      const sid = r.source_id;
      if (sid && !map.has(sid)) map.set(sid, r.source_label || sid);
    }
    return Array.from(map.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [sourceConfigs, rows]);

  // ── server fetch ──
  const fetchPage = useCallback(async () => {
    setError(null);
    try {
      let q = api._supabase
        .from("pulse_sync_logs")
        .select(
          "id, source_id, source_label, status, started_at, completed_at, " +
          "result_summary, triggered_by, triggered_by_name, apify_run_id, error_message",
          { count: "exact" }
        )
        .order("started_at", { ascending: false });

      if (filterSourceId && filterSourceId !== "all") {
        q = q.eq("source_id", filterSourceId);
      }
      if (statusFilter !== "all") {
        q = q.eq("status", statusFilter);
      }
      const tw = TIME_WINDOWS.find(t => t.value === timeWindow);
      if (tw && tw.ms != null) {
        q = q.gte("started_at", new Date(Date.now() - tw.ms).toISOString());
      }
      const from = page * pageSize;
      const to = from + pageSize - 1;
      q = q.range(from, to);

      const { data, error, count } = await q;
      if (error) throw error;
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
  }, [filterSourceId, statusFilter, timeWindow, page, pageSize]);

  useEffect(() => {
    setLoading(true);
    fetchPage();
  }, [fetchPage]);

  // Auto-refresh every 60s when enabled
  useEffect(() => {
    if (!autoRefresh) return;
    const id = setInterval(() => { fetchPage(); }, 60_000);
    return () => clearInterval(id);
  }, [autoRefresh, fetchPage]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const showingFrom = total === 0 ? 0 : page * pageSize + 1;
  const showingTo = Math.min(total, (page + 1) * pageSize);
  const hasPrev = page > 0;
  const hasNext = (page + 1) < pageCount;

  const filterCount =
    (filterSourceId && filterSourceId !== "all" ? 1 : 0) +
    (statusFilter !== "all" ? 1 : 0) +
    (timeWindow !== "all" ? 1 : 0);

  return (
    <Card id="sync-history" className="rounded-xl border shadow-sm scroll-mt-16">
      <CardHeader className="pb-3 px-4 pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            Sync History
            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
              {total.toLocaleString()} total
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
                {fmtRelativeTs(lastFetched)}
              </span>
            )}
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <Switch
                checked={autoRefresh}
                onCheckedChange={setAutoRefresh}
                aria-label="Auto-refresh every 60s"
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
              <Loader2 className={cn("h-3 w-3", loading && "animate-spin")} />
              Refresh
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[10px] gap-1"
              onClick={() => downloadCsv(rows)}
              disabled={rows.length === 0}
              title="Download visible rows as CSV"
            >
              <Download className="h-3 w-3" />
              CSV
            </Button>
          </div>
        </div>

        {/* Filter row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Source
            </label>
            <Select
              value={filterSourceId || "all"}
              onValueChange={(v) => onChangeFilter?.(v === "all" ? null : v)}
            >
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue placeholder="All sources" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All sources</SelectItem>
                {sourceOptions.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    <span className="truncate">{label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
              Status
            </label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="h-8 text-xs mt-0.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="failed">Failed</SelectItem>
                <SelectItem value="running">Running</SelectItem>
                <SelectItem value="timed_out">Timed out</SelectItem>
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
                onChangeFilter?.(null);
                setStatusFilter("all");
                setTimeWindow("all");
              }}
            >
              <X className="h-3 w-3" />
              Clear all filters
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="px-4 pb-4">
        {error && (
          <div className="rounded-md border border-red-300 bg-red-50/60 dark:bg-red-950/20 p-3 mb-3 text-xs flex items-start gap-2">
            <XCircle className="h-4 w-4 text-red-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-700 dark:text-red-400">Failed to load sync history</p>
              <p className="text-muted-foreground mt-0.5 font-mono text-[10px]">{error}</p>
            </div>
          </div>
        )}
        <div className="overflow-x-auto">
          {rows.length === 0 && !loading ? (
            <p className="text-xs text-muted-foreground py-8 text-center">
              {filterCount > 0
                ? "No sync logs match the current filters."
                : "No sync logs yet."}
            </p>
          ) : (
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="border-b">
                  <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Started</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Duration</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Records</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Triggered by</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((log) => (
                  <tr key={log.id} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="py-2 pr-3 font-medium max-w-[200px] truncate" title={log.source_id || ""}>
                      {log.source_label || log.source_id || "—"}
                    </td>
                    <td className="py-2 pr-3"><StatusBadge status={log.status} /></td>
                    <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{fmtTs(log.started_at)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{fmtDuration(log.started_at, log.completed_at)}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{recordsSummary(log)}</td>
                    <td className="py-2 pr-3 text-muted-foreground text-[10px] max-w-[140px] truncate" title={log.triggered_by_name || log.triggered_by || ""}>
                      {log.triggered_by_name || log.triggered_by || "—"}
                    </td>
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
        </div>

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

// --- Schedule Dialog (DB-driven, read-only view) ---
// Use the Edit dialog to modify. This is just a detail view.

function ScheduleDialog({ source, onClose }) {
  if (!source) return null;
  const meta = getSourceMeta(source.source_id);
  const cronStr = source.schedule_cron;
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
            <div className="col-span-1 text-muted-foreground">Cron</div>
            <div className="col-span-2 font-mono">{cronStr || "on-demand"}</div>
            <div className="col-span-1 text-muted-foreground">Schedule</div>
            <div className="col-span-2 font-medium">{cronLabel(cronStr)}</div>
            <div className="col-span-1 text-muted-foreground">Next run</div>
            <div className="col-span-2 font-medium">{cronStr ? nextRunFromCron(cronStr) : "—"}</div>
            <div className="col-span-1 text-muted-foreground">Approach</div>
            <div className="col-span-2 font-medium">{source.approach === "bounding_box" ? "Bounding box" : "Per-suburb iteration"}</div>
            {source.actor_slug && (
              <>
                <div className="col-span-1 text-muted-foreground">Actor</div>
                <div className="col-span-2">
                  <a href={source.apify_store_url || `https://apify.com/${source.actor_slug}`} target="_blank" rel="noreferrer" className="font-mono text-primary hover:underline inline-flex items-center gap-1">
                    {source.actor_slug}
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </>
            )}
            <div className="col-span-1 text-muted-foreground">Cost estimate</div>
            <div className="col-span-2 font-medium">{meta.costNote}</div>
            {source.notes && (
              <>
                <div className="col-span-1 text-muted-foreground">Notes</div>
                <div className="col-span-2 text-[11px]">{source.notes}</div>
              </>
            )}
          </div>
          <div className="rounded-md bg-muted/40 border p-2 text-[10px] text-muted-foreground">
            To modify cadence, input params or toggles, use the <strong>Edit</strong> button on the source card.
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
  // Controlled "deep-link" filter for the SyncHistory table — set by SourceCard
  // "View History" links so a card can scroll to and filter the history.
  const [historyFilterSourceId, setHistoryFilterSourceId] = useState(null);

  const openHistoryForSource = useCallback((sourceId) => {
    setHistoryFilterSourceId(sourceId || null);
    // Scroll to the sync history card
    setTimeout(() => {
      const el = document.getElementById("sync-history");
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 50);
  }, []);

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

  // runSource now ONLY passes source_id — pulseFireScrapes reads the full
  // actor_input, approach, max_results, etc. from pulse_source_configs.
  // No more hardcoded runParams or per-source branching.
  const runSource = useCallback(async (sourceConfig) => {
    const sid = sourceConfig.source_id;
    setRunningSources((prev) => new Set([...prev, sid]));
    try {
      // Manual run cap at 20 suburbs for per-suburb sources — avoids blowing
      // the edge function wall clock. (This can be raised in the DB config too.)
      const fireParams = sourceConfig.approach === "bounding_box"
        ? { source_id: sid }
        : { source_id: sid, min_priority: sourceConfig.min_priority ?? 0, max_suburbs: sourceConfig.max_suburbs ?? 20 };

      const { data } = await api.functions.invoke("pulseFireScrapes", fireParams);
      const dispatched = data?.dispatched ?? 0;
      if (data?.success === false) {
        toast.warning(data?.message || `${sourceConfig.label}: already running`);
      } else if (sourceConfig.approach === "bounding_box") {
        toast.success(`${sourceConfig.label} dispatched — sync log will appear shortly`);
      } else {
        toast.success(`${sourceConfig.label}: ${dispatched} suburb${dispatched === 1 ? "" : "s"} dispatched`);
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
        n.delete(sid);
        return n;
      });
    }
  }, []);

  // Edit dialog state
  const [editConfig, setEditConfig] = useState(null);

  // Visible sources: every enabled (or all?) row from pulse_source_configs.
  // Sorted: per-suburb first (visual group), then bounding_box, each by label.
  const visibleSources = useMemo(() => {
    const rows = [...(sourceConfigs || [])];
    // Filter out legacy non-REA rows (domain_*) that are disabled — these are
    // kept in DB for archival but don't need cards. Easy to re-include by
    // setting is_enabled=true. We keep disabled REA sources visible so users
    // can re-enable from the UI.
    const isReaSource = (c) => c.source_id?.startsWith("rea_");
    const filtered = rows.filter(isReaSource);
    filtered.sort((a, b) => {
      const aBB = a.approach === "bounding_box" ? 1 : 0;
      const bBB = b.approach === "bounding_box" ? 1 : 0;
      if (aBB !== bBB) return aBB - bBB;
      return (a.label || "").localeCompare(b.label || "");
    });
    return filtered;
  }, [sourceConfigs]);

  const perSuburbCount = visibleSources.filter((s) => s.approach !== "bounding_box").length;
  const boundingBoxCount = visibleSources.filter((s) => s.approach === "bounding_box").length;

  return (
    <div className="space-y-5">
      {/* ── Header summary ── */}
      <Card className="rounded-xl border shadow-sm bg-gradient-to-br from-primary/5 via-background to-background">
        <CardContent className="p-4 flex flex-wrap items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm">{visibleSources.length} data sources</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Repeat className="h-3.5 w-3.5" />
            <span>{perSuburbCount} per-suburb (iterates {activeSuburbCount} suburbs)</span>
          </div>
          <div className="flex items-center gap-1.5 text-muted-foreground">
            <Globe className="h-3.5 w-3.5" />
            <span>{boundingBoxCount} bounding-box (single call, Greater Sydney)</span>
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
          {visibleSources.map((config) => (
            <SourceCard
              key={config.source_id}
              sourceConfig={config}
              lastLog={lastLogBySource[config.source_id]}
              pulseTimeline={pulseTimeline}
              activeSuburbCount={activeSuburbCount}
              isRunning={runningSources.has(config.source_id)}
              onRun={runSource}
              onOpenPayload={setDrillLog}
              onOpenSchedule={setScheduleSource}
              onEdit={setEditConfig}
              onDrillDispatch={handleDrillDispatch}
              onViewHistory={openHistoryForSource}
            />
          ))}
          {visibleSources.length === 0 && (
            <Card className="col-span-full">
              <CardContent className="p-8 text-center text-muted-foreground">
                No REA sources configured. Insert rows into <code className="font-mono text-xs">pulse_source_configs</code> to get started.
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* ── Cron schedule + Suburb pool side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <CronScheduleTable
          runningSources={runningSources}
          lastLogBySource={lastLogBySource}
          sourceConfigs={visibleSources}
        />
        <SuburbPool targetSuburbs={targetSuburbs} />
      </div>

      {/* ── Sync history ── */}
      <SyncHistory
        sourceConfigs={visibleSources}
        onDrill={setDrillLog}
        filterSourceId={historyFilterSourceId}
        onChangeFilter={setHistoryFilterSourceId}
      />

      {/* ── Dialogs ── */}
      {drillLog && (
        <DrillDialog log={drillLog} onClose={() => setDrillLog(null)} />
      )}
      {scheduleSource && (
        <ScheduleDialog source={scheduleSource} onClose={() => setScheduleSource(null)} />
      )}
      {editConfig && (
        <EditConfigDialog config={editConfig} onClose={() => setEditConfig(null)} />
      )}
    </div>
  );
}

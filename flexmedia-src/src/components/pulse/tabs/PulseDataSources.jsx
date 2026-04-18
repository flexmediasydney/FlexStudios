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
  // ── Migration 095 ────────────────────────────────────────────────────
  // result_summary moved to pulse_sync_log_payloads side-table. Prefer the
  // slim-row columns (records_fetched, records_new, records_updated) so
  // this function works off the hot-path list query. Fall back to the
  // side-table payload when it's been hydrated (drill dialog context).
  const s = log?.result_summary || {};
  const parts = [];
  if (s.agents_processed != null) parts.push(`${s.agents_processed} agents`);
  if (s.listings_stored != null)  parts.push(`${s.listings_stored} listings`);
  if (!parts.length && log?.records_fetched != null) {
    const fetched = log.records_fetched || 0;
    const newRows = log.records_new || 0;
    const updated = log.records_updated || 0;
    if (fetched > 0 || newRows > 0 || updated > 0) {
      parts.push(`${fetched} fetched`);
      if (newRows > 0) parts.push(`${newRows} new`);
      if (updated > 0) parts.push(`${updated} updated`);
    }
  }
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
  const [activeBatch, setActiveBatch] = useState(null);
  // `latestBatch` is the most recent pulse_fire_batches row of ANY status.
  // Used as the AUTHORITATIVE "last run" number on the source card — a chunked
  // dispatch may span multiple 15-min `pulse_sync_runs` buckets (showing e.g.
  // 141/141 for bucket 1 and 42/42 for bucket 2), but the batch row says
  // "183 of 183 dispatched" for the whole cohort, which is what users expect
  // to see on the card. `activeBatch` is a strict subset (status='running')
  // of `latestBatch`.
  const [latestBatch, setLatestBatch] = useState(null);
  // Queue state (migration 093): per-source totals across the queue table.
  // Shape: { pending, running, completed_24h, failed_24h, failed_attempts_exhausted }
  const [queueStats, setQueueStats] = useState(null);
  // Circuit breaker state (migration 093): { state, consecutive_failures, reopen_at }
  const [circuit, setCircuit] = useState(null);
  // Coverage row from pulse_source_coverage view
  const [coverage, setCoverage] = useState(null);
  const [loading, setLoading] = useState(true);

  // An operation is active if there's a non-terminal batch row, any run has
  // per-suburb dispatches still firing, OR the queue has pending/running items.
  // The batch check matters during the handoff gap between worker ticks when
  // no sync_logs are in 'running' state but the queue still has work pending —
  // prevents the card from flickering "in progress" ↔ "complete".
  const hasActive = useMemo(
    () =>
      (activeBatch != null) ||
      runs.some((r) => (r.in_progress || 0) > 0) ||
      ((queueStats?.pending || 0) + (queueStats?.running || 0)) > 0,
    [runs, activeBatch, queueStats]
  );

  useEffect(() => {
    if (!sourceId) return;
    let cancelled = false;

    const fetchRuns = async () => {
      try {
        const [runsRes, activeBatchRes, latestBatchRes, queuePendingRes, queueRunningRes, queueRecentRes, circuitRes, coverageRes] = await Promise.all([
          api._supabase
            .from("pulse_sync_runs")
            .select("*")
            .eq("source_id", sourceId)
            .order("run_started_at", { ascending: false })
            .limit(limit),
          api._supabase
            .from("pulse_fire_batches")
            .select("id,status,total_count,dispatched_count,current_offset,batch_size,started_at,last_batch_at,completed_at")
            .eq("source_id", sourceId)
            .eq("status", "running")
            .order("started_at", { ascending: false })
            .limit(1),
          // Latest batch regardless of status — the authoritative "last run"
          // counter for the source card.
          api._supabase
            .from("pulse_fire_batches")
            .select("id,status,total_count,dispatched_count,current_offset,batch_size,started_at,last_batch_at,completed_at,error_message")
            .eq("source_id", sourceId)
            .order("started_at", { ascending: false })
            .limit(1),
          // Queue counts — split into 3 head queries because postgrest doesn't
          // give us aggregations in one hit; the three combined are still <10ms.
          api._supabase
            .from("pulse_fire_queue")
            .select("id", { count: "exact", head: true })
            .eq("source_id", sourceId)
            .eq("status", "pending"),
          api._supabase
            .from("pulse_fire_queue")
            .select("id", { count: "exact", head: true })
            .eq("source_id", sourceId)
            .eq("status", "running"),
          // Recent terminal state (24h window) for the "just ran" stats
          api._supabase
            .from("pulse_fire_queue")
            .select("status,attempts", { count: "exact" })
            .eq("source_id", sourceId)
            .in("status", ["completed", "failed"])
            .gte("completed_at", new Date(Date.now() - 24 * 3600 * 1000).toISOString())
            .limit(500),
          api._supabase
            .from("pulse_source_circuit_breakers")
            .select("state,consecutive_failures,failure_threshold,opened_at,reopen_at,total_opens")
            .eq("source_id", sourceId)
            .maybeSingle(),
          api._supabase
            .from("pulse_source_coverage")
            .select("coverage_pct_24h,suburbs_synced_24h,items_dead_lettered_24h,pool_size,last_completion_at")
            .eq("source_id", sourceId)
            .maybeSingle(),
        ]);
        if (runsRes.error) throw runsRes.error;
        if (cancelled) return;
        setRuns(runsRes.data || []);
        setActiveBatch(activeBatchRes.error ? null : (activeBatchRes.data?.[0] || null));
        setLatestBatch(latestBatchRes.error ? null : (latestBatchRes.data?.[0] || null));

        const recentRows = queueRecentRes.error ? [] : (queueRecentRes.data || []);
        const completed24h = recentRows.filter((r) => r.status === "completed").length;
        const failed24h = recentRows.filter((r) => r.status === "failed").length;
        setQueueStats({
          pending: queuePendingRes.count || 0,
          running: queueRunningRes.count || 0,
          completed_24h: completed24h,
          failed_24h: failed24h,
        });

        setCircuit(circuitRes.error ? null : circuitRes.data);
        setCoverage(coverageRes.error ? null : coverageRes.data);
      } catch (err) {
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

  return { runs, activeBatch, latestBatch, queueStats, circuit, coverage, loading };
}

// ── pulse_source_card_stats RPC hook ──────────────────────────────────────────

/**
 * Fetches "last cron dispatch" coverage stats for every source in one call
 * (see migration 083_pulse_source_card_stats.sql). Each row tells the Source
 * Card how many suburbs the LAST CRON dispatched, vs how many were eligible.
 *
 * This is fundamentally different from pulse_sync_runs (which counts how many
 * sync_log rows exist in the latest 15-min bucket — a number that includes
 * manual fan-outs and double-counts when crons fire mid-bucket). The RPC
 * answers "did the most recent CRON cover the suburb pool?", not "how many
 * sync_log rows landed".
 *
 * Returns a map keyed by source_id for O(1) lookup in <SourceCard>.
 * Refreshes every 60s (cron_dispatched events are infrequent).
 */
function usePulseSourceCardStats() {
  const [byId, setById] = useState({});

  useEffect(() => {
    let cancelled = false;
    const fetchStats = async () => {
      try {
        const { data, error } = await api._supabase.rpc("pulse_source_card_stats");
        if (error) throw error;
        if (!cancelled) {
          const map = {};
          for (const r of (data || [])) map[r.source_id] = r;
          setById(map);
        }
      } catch (err) {
        // Silent — RPC may not yet be deployed. Card falls back to no-coverage display.
        console.warn("pulse_source_card_stats RPC failed:", err.message);
      }
    };
    fetchStats();
    const id = setInterval(fetchStats, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return byId;
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
            {/* Batch attribution (migration 088) — blank for ad-hoc syncs */}
            <th className="text-center pb-1 font-medium">Batch</th>
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
                <td className="py-1 pr-2 text-center">
                  {d.batch_number != null && d.total_batches != null ? (
                    <span
                      className="font-mono text-muted-foreground tabular-nums"
                      title={d.batch_id ? `Batch ${d.batch_number} of ${d.total_batches} · id ${String(d.batch_id).slice(0, 8)}…` : undefined}
                    >
                      {d.batch_number}/{d.total_batches}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/30">—</span>
                  )}
                </td>
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

function RunSummary({ run, latestBatch, isBoundingBox, expanded, onToggle, onDrillDispatch }) {
  // ── Authoritative vs bucket-level counters ───────────────────────────────
  // When a chunked dispatch spans multiple 15-min buckets, `run` (from the
  // pulse_sync_runs view) reports only the latest bucket — e.g. 141/141 when
  // the full dispatch was 183/183 across two buckets. `latestBatch` (from
  // pulse_fire_batches) reports the whole cohort, which is what "Last run"
  // should mean on the source card.
  //
  // Heuristic for when to trust the batch row over the bucket row:
  //   - `latestBatch` exists AND
  //   - its started_at is within 10 minutes of (or after) run.run_started_at
  //     — i.e. this batch row belongs to the same logical cron dispatch.
  //
  // If the newest batch is much older than the latest 15-min bucket, the
  // bucket is a newer manual/ad-hoc run and we should keep displaying bucket
  // numbers. The 10-min threshold matches the worst-case chunked-dispatch
  // wall-clock (most finish in <5 min; 30s-stagger sources may run 8-10 min).
  const batchBelongsToRun = useMemo(() => {
    if (!latestBatch) return false;
    const batchMs = new Date(latestBatch.started_at).getTime();
    const runMs = new Date(run.run_started_at).getTime();
    // batch started within 20min before/after run bucket → same logical op
    return Math.abs(runMs - batchMs) < 20 * 60 * 1000;
  }, [latestBatch, run.run_started_at]);

  const [showBreakdown, setShowBreakdown] = useState(false);

  // Canonical numbers displayed on the card. When batch is authoritative we
  // use total_count / dispatched_count (no succeeded/failed breakdown — that
  // still lives in the bucket view); otherwise bucket numbers.
  const useBatchNumbers = batchBelongsToRun && !isBoundingBox;

  const bucketTotal = run.total_dispatches || 0;
  const bucketSucceeded = run.succeeded || 0;
  const bucketFailed = run.failed || 0;
  const bucketInProgress = run.in_progress || 0;

  const total = useBatchNumbers ? (latestBatch.total_count || 0) : bucketTotal;
  const succeeded = bucketSucceeded; // still sourced from bucket — batch table has no status breakdown
  const failed = bucketFailed;
  const inProgress = bucketInProgress;
  const dispatched = useBatchNumbers ? (latestBatch.dispatched_count || 0) : (succeeded + failed);

  const allFailed = bucketTotal > 0 && bucketFailed === bucketTotal;
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
          Last run · {fmtRelativeTs(useBatchNumbers ? latestBatch.started_at : run.run_started_at)}
          {/* Batch attribution:
              - When useBatchNumbers is true (chunked dispatch spanning multiple
                15-min buckets), show the authoritative whole-cohort range via a
                "cohort" badge — the bucket-level batch_label is de-emphasised
                behind the "Show breakdown" toggle below.
              - Otherwise preserve the existing behaviour where run.batch_label
                (pre-formatted "Batches 3–6 of 10" from migration 089) is
                inlined as before. */}
          {useBatchNumbers ? (
            <span
              className="inline-flex items-center gap-0.5 ml-1 normal-case tracking-normal font-mono text-muted-foreground/80"
              title={`Full dispatch cohort (batch id ${String(latestBatch.id).slice(0, 8)}…, status ${latestBatch.status})`}
            >
              · full cohort
            </span>
          ) : run.batch_label && (
            <span
              className="inline-flex items-center gap-0.5 ml-1 normal-case tracking-normal font-mono text-muted-foreground/80"
              title={`Chunked dispatch — this 15-min window covers batch(es) ${run.batch_label}`}
            >
              · Batch {run.batch_label}
            </span>
          )}
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

      {/* Progress bar — batch-level progress when authoritative, else bucket. */}
      {useBatchNumbers ? (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
            <div
              className={cn(
                "h-full transition-all",
                latestBatch.status === "running" ? "bg-blue-500 animate-pulse" :
                latestBatch.status === "failed" ? "bg-red-500" :
                latestBatch.status === "timed_out" ? "bg-amber-500" :
                "bg-emerald-500"
              )}
              style={{ width: total > 0 ? `${Math.min(100, (dispatched / total) * 100)}%` : "0%" }}
            />
          </div>
        </div>
      ) : (
        <RunProgressBar run={run} />
      )}

      {/* Status counters */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-medium">
          {dispatched}/{total} suburbs
          {inProgress > 0 && (
            <span className="text-blue-600 dark:text-blue-400"> · {inProgress} in progress</span>
          )}
          {useBatchNumbers && latestBatch.status === "running" && (
            <span className="text-blue-600 dark:text-blue-400 ml-1">(dispatch running)</span>
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

      {/* When batch-level numbers are being used, let the user drill down
          into the 15-min bucket (latest sync_runs row). This keeps the
          authoritative "183/183 cohort" line clean while still exposing the
          "but what did the latest bucket do?" detail on demand. */}
      {useBatchNumbers && run.batch_label && (
        <div className="pt-1 border-t border-border/40">
          <button
            type="button"
            onClick={() => setShowBreakdown((v) => !v)}
            className="flex items-center gap-1 text-[9px] text-muted-foreground hover:text-foreground transition-colors uppercase tracking-wide font-semibold"
          >
            {showBreakdown ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            <span>Latest 15-min bucket</span>
            <span className="font-normal normal-case tracking-normal ml-1 tabular-nums">
              · {bucketSucceeded + bucketFailed}/{bucketTotal} · Batch {run.batch_label}
            </span>
          </button>
          {showBreakdown && (
            <div className="mt-1 pl-4 text-[10px] text-muted-foreground space-y-0.5">
              <div>
                Bucket started: <span className="font-mono">{fmtRelativeTs(run.run_started_at)}</span>
              </div>
              <div>
                Last activity: <span className="font-mono">{fmtRelativeTs(run.run_last_activity)}</span>
              </div>
              <div>
                {bucketSucceeded} succeeded · {bucketFailed} failed · {bucketInProgress} running
              </div>
            </div>
          )}
        </div>
      )}

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

// --- Empty-state: cron has never fired for this source ---
//
// Replaces the "Last run" RunSummary block when the source has zero
// cron_dispatched events ever. Surfaces the more honest message that
// any visible per-suburb counts (e.g. "1/1 records fetched" from a one-off
// manual load) are NOT a coverage metric, and the cron has yet to run.
function NoCronRunsYet({ hasManualRun }) {
  return (
    <div className="rounded-md border border-dashed border-amber-300/60 bg-amber-50/30 dark:bg-amber-950/10 px-2.5 py-2 text-[10px] text-amber-700 dark:text-amber-400 space-y-0.5">
      <div className="font-semibold uppercase tracking-wide flex items-center gap-1">
        <Clock className="h-3 w-3" />
        No cron runs yet
      </div>
      <div className="text-muted-foreground">
        {hasManualRun
          ? "Only manual runs recorded. Cron has not yet fired for this source."
          : "Click Run Now to trigger a manual scrape, or wait for the next scheduled cron."}
      </div>
    </div>
  );
}

// --- Empty-state: source intentionally disabled ---
//
// For domain_* (and any other) sources whose `is_enabled = false`. We still
// render the card for visibility but suppress all the run/coverage chatter so
// users don't read into the "0 / 0" or "never" lines.
function DisabledSourceState() {
  return (
    <div className="rounded-md border border-dashed px-2.5 py-3 text-[10px] text-muted-foreground italic text-center">
      Source disabled — enable in Edit dialog to start scraping.
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

// --- Suburb-coverage block (cron dispatch view) ---
//
// Reads the row from pulse_source_card_stats() RPC for this source and renders:
//   1. "X / Y suburbs covered" line — colored green/amber/red on the ratio
//   2. "Last dispatch: Xh ago" line
//   3. Red "Last cron did not dispatch" badge if dispatched is null/0
// This is intentionally separate from RunSummary (which shows the latest
// pulse_sync_runs row — i.e. the records-fetched/new counts of one suburb).
// Both blocks coexist on the card.

function SuburbCoverageBlock({ stats, isBoundingBox }) {
  // No RPC data yet (deploying or pre-rollout). Render nothing — the card
  // still works using the legacy RunSummary block below.
  if (!stats) return null;

  const {
    dispatched,
    eligible_at_run,
    suburb_pool_size,
    last_cron_at,
    status,
    config_max_suburbs,
    config_min_priority,
  } = stats;
  const cronMissed = dispatched === null || dispatched === 0;
  const eligible = Math.max(eligible_at_run || 0, 1);
  const ratio = cronMissed ? 0 : (dispatched / eligible);

  // Color tint for the coverage line — mirrors the status returned by the RPC.
  let coverColor = "text-emerald-700 dark:text-emerald-400";
  let coverBorder = "border-emerald-300/50 bg-emerald-50/40 dark:bg-emerald-950/20";
  if (status === "never") {
    coverColor = "text-muted-foreground";
    coverBorder = "border-dashed";
  } else if (cronMissed) {
    coverColor = "text-red-700 dark:text-red-400";
    coverBorder = "border-red-400/60 bg-red-50/60 dark:bg-red-950/20";
  } else if (status === "low" || ratio < 0.5) {
    coverColor = "text-red-700 dark:text-red-400";
    coverBorder = "border-red-400/60 bg-red-50/60 dark:bg-red-950/20";
  } else if (status === "partial" || ratio < 0.9) {
    coverColor = "text-amber-700 dark:text-amber-400";
    coverBorder = "border-amber-400/60 bg-amber-50/60 dark:bg-amber-950/20";
  }

  // Build the secondary "configured to scrape" line. Three flavors:
  //   1. Per-suburb capped (max_suburbs < pool): "configured to scrape Y of your N-suburb pool"
  //   2. Per-suburb uncapped (max_suburbs >= pool): "scraping full N-suburb pool"
  //   3. Bounding box: skip this line (it's a single region call, not a pool slice)
  let configContext = null;
  if (!isBoundingBox && suburb_pool_size != null) {
    const cap = config_max_suburbs;
    const minPri = config_min_priority || 0;
    const pri = minPri > 0 ? `, min_priority=${minPri}` : "";
    if (cap == null || cap >= suburb_pool_size) {
      configContext = `scraping full ${suburb_pool_size}-suburb pool${pri}`;
    } else {
      configContext = `configured to scrape ${cap} of your ${suburb_pool_size}-suburb pool${pri}`;
    }
  }

  return (
    <div className={cn("rounded-md border px-2.5 py-1.5 text-[10px] space-y-1", coverBorder)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-muted-foreground uppercase tracking-wide font-semibold">
          <MapPin className="h-3 w-3" />
          {isBoundingBox ? "Region coverage" : "Suburb coverage"}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {last_cron_at ? `last dispatch ${fmtRelativeTs(last_cron_at)}` : "no cron yet"}
        </span>
      </div>
      <div className={cn("flex items-center gap-2 flex-wrap font-medium", coverColor)}>
        {status === "never" ? (
          <span>No cron dispatch recorded yet</span>
        ) : cronMissed ? (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase font-semibold border-red-500/60 text-red-700 bg-red-100/60 dark:bg-red-900/40 dark:text-red-300">
            <AlertTriangle className="h-2.5 w-2.5 mr-1" />
            Last cron did not dispatch — config issue?
          </Badge>
        ) : (
          <span className="tabular-nums">
            <span className="font-bold text-base leading-none">{dispatched}</span>
            <span className="opacity-70"> / {eligible_at_run}</span>{" "}
            {isBoundingBox ? "region call" : "suburbs covered"}
          </span>
        )}
      </div>
      {configContext && (
        <div className="text-[9px] text-muted-foreground/80 italic">
          {configContext}
        </div>
      )}
    </div>
  );
}

// --- Dead-letter drill dialog (migration 093) ---
//
// Click the DLQ chip → see the last N failed queue items for this source with
// last_error, attempts, and a "Requeue" button that resets status='pending'
// and zeros attempts so the worker picks them up again on the next tick.

function DlqDrillDialog({ sourceId, onClose }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actingId, setActingId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const { data } = await api._supabase
      .from("pulse_fire_queue")
      .select("id, suburb_name, attempts, max_attempts, last_error, last_error_category, completed_at, updated_at")
      .eq("source_id", sourceId)
      .eq("status", "failed")
      .order("updated_at", { ascending: false })
      .limit(100);
    setItems(data || []);
    setLoading(false);
  }, [sourceId]);

  useEffect(() => { load(); }, [load]);

  const requeue = useCallback(async (id) => {
    setActingId(id);
    try {
      const { error } = await api._supabase
        .from("pulse_fire_queue")
        .update({
          status: "pending",
          attempts: 0,
          next_attempt_at: new Date().toISOString(),
          dispatched_at: null,
          completed_at: null,
          last_error: null,
          last_error_category: null,
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("Requeued — worker will pick it up on the next tick");
      await load();
    } catch (err) {
      toast.error(`Requeue failed: ${err.message}`);
    } finally {
      setActingId(null);
    }
  }, [load]);

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            Dead-lettered items · {sourceId}
          </DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : items.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-6">No dead-lettered items for this source.</p>
        ) : (
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {items.map(it => (
              <div key={it.id} className="rounded border border-amber-300/50 bg-amber-50/30 dark:bg-amber-950/20 p-2.5 space-y-1">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-xs">{it.suburb_name}</span>
                    <Badge variant="outline" className="text-[9px] py-0 px-1 font-mono">
                      {it.attempts}/{it.max_attempts} attempts
                    </Badge>
                    {it.last_error_category && (
                      <Badge variant="outline" className={cn("text-[9px] py-0 px-1",
                        it.last_error_category === 'permanent' ? "border-red-400/50 text-red-700 dark:text-red-400" :
                        it.last_error_category === 'rate_limit' ? "border-orange-400/50 text-orange-700 dark:text-orange-400" :
                        "border-amber-400/50 text-amber-700 dark:text-amber-400"
                      )}>
                        {it.last_error_category}
                      </Badge>
                    )}
                    <span className="text-[9px] text-muted-foreground">
                      {fmtRelativeTs(it.updated_at || it.completed_at)}
                    </span>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => requeue(it.id)}
                    disabled={actingId === it.id}
                  >
                    {actingId === it.id ? <Loader2 className="h-3 w-3 animate-spin" /> : "Requeue"}
                  </Button>
                </div>
                {it.last_error && (
                  <pre className="text-[10px] font-mono text-red-700 dark:text-red-400 bg-red-50/50 dark:bg-red-950/20 border border-red-200/40 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                    {it.last_error}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// --- Queue pipeline block (migration 093) ---
//
// Replaces the silent-dispatch fragility of the old chained self-invocation
// with a visible, per-state count of the durable work queue. Shows:
//   - Pending → Running → Completed (24h)
//   - Failed (24h) with DLQ warning tint
//   - Circuit breaker state (red chip when open/half_open)
//   - Coverage % (from pulse_source_coverage view)

function QueuePipelineBlock({ queueStats, circuit, coverage, onOpenDlq }) {
  const { pending = 0, running = 0, completed_24h = 0, failed_24h = 0 } = queueStats || {};
  const hasActive = pending > 0 || running > 0;
  const hasFailed = failed_24h > 0;
  const breakerOpen = circuit?.state === "open" || circuit?.state === "half_open";
  const cov = coverage?.coverage_pct_24h;

  // Color the block based on most-alarming signal
  let tone = "border-border bg-muted/20";
  if (breakerOpen) tone = "border-red-400/60 bg-red-50/50 dark:bg-red-950/20";
  else if (hasFailed) tone = "border-amber-400/60 bg-amber-50/50 dark:bg-amber-950/20";
  else if (hasActive) tone = "border-blue-400/60 bg-blue-50/50 dark:bg-blue-950/20";
  else if (cov != null && cov >= 95) tone = "border-emerald-400/60 bg-emerald-50/40 dark:bg-emerald-950/20";

  return (
    <div className={cn("rounded-md border px-2.5 py-1.5 text-[10px] space-y-1", tone)}>
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-muted-foreground uppercase tracking-wide font-semibold">
          <Activity className="h-3 w-3" />
          Queue pipeline
        </span>
        {cov != null && (
          <span
            className={cn(
              "tabular-nums font-medium",
              cov >= 95 ? "text-emerald-700 dark:text-emerald-400" :
              cov >= 75 ? "text-amber-700 dark:text-amber-400" :
              "text-red-700 dark:text-red-400"
            )}
            title="coverage_pct_24h from pulse_source_coverage view"
          >
            {cov}% · 24h
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-wrap tabular-nums">
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0 rounded border",
            pending > 0 ? "border-blue-400/50 text-blue-700 dark:text-blue-300 bg-blue-100/30 dark:bg-blue-900/20" : "border-border text-muted-foreground/60"
          )}
          title="Items waiting for a worker tick"
        >
          <span className="font-semibold">{pending}</span>
          <span className="text-[9px] uppercase">pending</span>
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0 rounded border",
            running > 0 ? "border-blue-500/60 text-blue-700 dark:text-blue-300 bg-blue-100/40 dark:bg-blue-900/30 animate-pulse" : "border-border text-muted-foreground/60"
          )}
          title="Items currently being processed by pulseDataSync"
        >
          <Loader2 className={cn("h-2.5 w-2.5", running > 0 && "animate-spin")} />
          <span className="font-semibold">{running}</span>
          <span className="text-[9px] uppercase">running</span>
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0 rounded border",
            completed_24h > 0 ? "border-emerald-400/50 text-emerald-700 dark:text-emerald-300 bg-emerald-100/30 dark:bg-emerald-900/20" : "border-border text-muted-foreground/60"
          )}
          title="Suburbs successfully synced in last 24h"
        >
          <CheckCircle2 className="h-2.5 w-2.5" />
          <span className="font-semibold">{completed_24h}</span>
          <span className="text-[9px] uppercase">synced 24h</span>
        </span>
        {failed_24h > 0 && (
          <button
            type="button"
            onClick={onOpenDlq}
            className="inline-flex items-center gap-1 px-1.5 py-0 rounded border border-amber-500/60 text-amber-700 dark:text-amber-300 bg-amber-100/40 dark:bg-amber-900/30 hover:bg-amber-200/50 transition-colors cursor-pointer"
            title="Click to drill into dead-lettered items + requeue"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            <span className="font-semibold">{failed_24h}</span>
            <span className="text-[9px] uppercase">DLQ</span>
          </button>
        )}
      </div>
      {breakerOpen && circuit && (
        <div className="flex items-center gap-1.5 text-[9px] text-red-700 dark:text-red-400 font-medium pt-0.5 border-t border-red-500/20">
          <AlertCircle className="h-2.5 w-2.5" />
          Circuit breaker {circuit.state.toUpperCase()} ({circuit.consecutive_failures} consecutive failures)
          {circuit.reopen_at && (
            <span className="text-muted-foreground font-normal">
              · reopens {fmtRelativeTs(circuit.reopen_at)}
            </span>
          )}
        </div>
      )}
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

function SourceCard({ sourceConfig, lastLog, pulseTimeline, activeSuburbCount, cardStats, isRunning, onRun, onOpenPayload, onOpenSchedule, onEdit, onDrillDispatch, onViewHistory }) {
  const meta = getSourceMeta(sourceConfig.source_id);
  const [dlqOpen, setDlqOpen] = useState(false);
  const Icon = meta.icon;
  const lastStatus = lastLog?.status;
  const [showInput, setShowInput] = useState(false);
  const [runExpanded, setRunExpanded] = useState(false);

  // Pull aggregated runs from the view + active chunked batch (for cross-batch
  // "in progress" continuity that sync_logs alone can't tell us about).
  // `latestBatch` is the authoritative "last cron dispatch" counter (spans all
  // 15-min buckets of a chunked run); `latestRun` is only the latest 15-min
  // slice from pulse_sync_runs and can under-count.
  const { runs: syncRuns, activeBatch, latestBatch, queueStats, circuit, coverage } = usePulseSyncRuns(sourceConfig.source_id, 10);
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

  // Status traffic light. activeBatch trumps everything — if a chunked dispatch
  // is still firing, always show blue pulse regardless of whether the current
  // moment is a batch handoff gap (sync_logs momentarily 0 in_progress).
  let statusDot = "bg-gray-300";
  if (activeBatch) {
    statusDot = "bg-blue-500 animate-pulse";
  } else if (latestRun) {
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
                {activeBatch && (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 uppercase border-blue-400/60 text-blue-700 dark:text-blue-400 bg-blue-50/60 dark:bg-blue-950/30 tabular-nums">
                    {activeBatch.dispatched_count}/{activeBatch.total_count} dispatched
                  </Badge>
                )}
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

        {/* Approach + schedule + config tokens (single compact row) */}
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
          <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono text-muted-foreground" title="max_results_per_suburb">
            ≤{sourceConfig.max_results_per_suburb ?? "—"} each
          </Badge>
          {!isBoundingBox ? (
            <>
              <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono text-muted-foreground" title={`max_suburbs=${sourceConfig.max_suburbs ?? "—"}, min_priority=${sourceConfig.min_priority ?? 0}`}>
                {sourceConfig.max_suburbs ?? "—"} / {activeSuburbCount} pool
              </Badge>
              {sourceConfig.min_priority > 0 && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono text-muted-foreground" title="min_priority filter">
                  p≥{sourceConfig.min_priority}
                </Badge>
              )}
            </>
          ) : (
            <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono text-muted-foreground" title="Cost estimate">
              {meta.costNote}
            </Badge>
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

        {/* Suburb coverage (last cron dispatch) — answers "did the cron cover the
            pool?". Distinct from the per-suburb fetch counts in RunSummary
            below, which describe what ONE suburb returned.

            Suppressed for disabled sources — the X/Y line is meaningless when
            no cron is configured to fire. */}
        {!isDisabled && (
          <SuburbCoverageBlock stats={cardStats} isBoundingBox={isBoundingBox} />
        )}

        {/* Queue pipeline (migration 093) — durable work queue state.
            Shows pending → running → completed (24h) → failed (24h) and
            circuit breaker state if tripped. Answers the real question:
            "is my data getting synced reliably right now?" */}
        {!isDisabled && queueStats && (
          <QueuePipelineBlock
            queueStats={queueStats}
            circuit={circuit}
            coverage={coverage}
            onOpenDlq={() => setDlqOpen(true)}
          />
        )}

        {/* Last run summary block.
            Decision tree:
              - disabled source: clean "Source disabled" message
              - cron has never fired (cardStats.last_cron_at is null): suppress
                the misleading "1/1 records" tertiary block — manual loads are
                NOT a coverage metric. Show "No cron runs yet" instead, noting
                if a manual run exists.
              - latest sync_run exists: standard RunSummary
              - very recent dispatch but no log yet (queuing): DispatchedNoLogs
              - otherwise: NoRunsYet (rare — means no logs at all) */}
        {isDisabled ? (
          <DisabledSourceState />
        ) : cardStats && cardStats.last_cron_at == null ? (
          <NoCronRunsYet hasManualRun={!!latestRun} />
        ) : latestRun ? (
          <RunSummary
            run={latestRun}
            latestBatch={latestBatch}
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
        {cronStr && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground px-1">
            <Calendar className="h-3 w-3" />
            Next: <span className="font-medium text-foreground">{nextRunFromCron(cronStr)}</span>
            <span className="text-muted-foreground/40">·</span>
            <Coins className="h-3 w-3" />
            <span>{meta.costNote}</span>
          </div>
        )}

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
      {dlqOpen && (
        <DlqDrillDialog sourceId={sourceConfig.source_id} onClose={() => setDlqOpen(false)} />
      )}
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
          "result_summary, triggered_by, triggered_by_name, apify_run_id, error_message, " +
          // Batch attribution (migration 088) — rendered as "3/10" chip below.
          "batch_id, batch_number, total_batches",
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
            <table className="w-full text-xs min-w-[720px]">
              <thead>
                <tr className="border-b">
                  <th className="text-left pb-2 font-medium text-muted-foreground">Source</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Status</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Started</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Duration</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground">Records</th>
                  <th className="text-left pb-2 font-medium text-muted-foreground" title="Chunked dispatch batch (N of M). Blank for ad-hoc/manual syncs.">Batch</th>
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
                    <td className="py-2 pr-3">
                      {log.batch_number != null && log.total_batches != null ? (
                        <Badge
                          variant="outline"
                          className="text-[9px] px-1.5 py-0 tabular-nums font-mono"
                          title={log.batch_id ? `Batch ${log.batch_number} of ${log.total_batches} — batch_id ${log.batch_id.slice(0, 8)}…` : undefined}
                        >
                          {log.batch_number}/{log.total_batches}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
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
  // ── Migration 095 ────────────────────────────────────────────────────
  // Heavy payload lives in pulse_sync_log_payloads (side-table) now. If the
  // caller handed us a log object without raw_payload (e.g. it came from the
  // slim list query), lazy-fetch from the side-table when the dialog opens.
  const [sidePayload, setSidePayload] = useState(null);
  const [loadingPayload, setLoadingPayload] = useState(false);
  useEffect(() => {
    if (!log?.id) return;
    // Already has payload (from handleDrillDispatch, which merges both tables)
    if (log.raw_payload !== undefined && log.raw_payload !== null) return;
    let cancelled = false;
    setLoadingPayload(true);
    api._supabase
      .from("pulse_sync_log_payloads")
      .select("raw_payload, result_summary, input_config, records_detail")
      .eq("sync_log_id", log.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setSidePayload(data || {});
      })
      .finally(() => {
        if (!cancelled) setLoadingPayload(false);
      });
    return () => { cancelled = true; };
  }, [log?.id]);

  const payload = log?.raw_payload ?? sidePayload?.raw_payload ?? {};
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

  // Last-cron-dispatch coverage stats per source_id (one RPC call, refreshes 60s).
  // Powers the "X / Y suburbs covered" line on each Source Card.
  const cardStatsById = usePulseSourceCardStats();

  // Open the drill dialog for a given sync_log id.
  // ── Migration 095 ────────────────────────────────────────────────────
  // pulse_sync_logs no longer carries raw_payload / result_summary /
  // input_config / records_detail — those live in the pulse_sync_log_payloads
  // side-table. When the user opens the drill dialog, we fetch header from
  // pulse_sync_logs and heavy payload from the side-table in parallel, then
  // merge into the single `log` object the dialog component expects.
  const handleDrillDispatch = useCallback(
    async (syncLogId) => {
      if (!syncLogId) return;
      try {
        const [header, payloadRes] = await Promise.all([
          (() => {
            const existing = syncLogs.find((l) => l.id === syncLogId);
            if (existing) return Promise.resolve(existing);
            return api.entities.PulseSyncLog.get(syncLogId);
          })(),
          api._supabase
            .from("pulse_sync_log_payloads")
            .select("raw_payload, result_summary, input_config, records_detail")
            .eq("sync_log_id", syncLogId)
            .maybeSingle(),
        ]);
        if (!header) return;
        const payload = payloadRes?.data || {};
        setDrillLog({
          ...header,
          raw_payload: payload.raw_payload ?? header.raw_payload ?? null,
          result_summary: payload.result_summary ?? header.result_summary ?? null,
          input_config: payload.input_config ?? header.input_config ?? null,
          records_detail: payload.records_detail ?? header.records_detail ?? null,
        });
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

  // Visible sources: every REA row from pulse_source_configs.
  // Sorted: per-suburb first (visual group), then bounding_box, each by label.
  // Domain source rows were deleted in migration 092 — this filter just
  // guards against stray non-REA rows being inserted later.
  const visibleSources = useMemo(() => {
    const rows = [...(sourceConfigs || [])];
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

  // ── Run All: fire every enabled REA source sequentially ──────────────
  // Sequential (not parallel) so we don't double-dispatch the websift actor
  // which is rate-limited. Each source gets a 1s pause before the next
  // starts — pulseFireScrapes itself handles the inter-suburb stagger.
  const [runningAll, setRunningAll] = useState(false);
  const runAllSources = useCallback(async () => {
    const enabled = visibleSources.filter((s) => s.is_enabled !== false);
    if (enabled.length === 0) {
      toast.warning("No enabled sources to run");
      return;
    }
    setRunningAll(true);
    try {
      toast.info(`Run All: dispatching ${enabled.length} REA sources…`);
      for (const cfg of enabled) {
        // eslint-disable-next-line no-await-in-loop
        await runSource(cfg);
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1000));
      }
      toast.success(`Run All complete — ${enabled.length} sources dispatched`);
    } catch (err) {
      toast.error(`Run All failed mid-batch: ${err.message}`);
    } finally {
      setRunningAll(false);
    }
  }, [visibleSources, runSource]);

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
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Data Sources
          </h2>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2.5 text-xs gap-1.5"
            onClick={runAllSources}
            disabled={runningAll || runningSources.size > 0 || visibleSources.length === 0}
            title="Dispatch every enabled REA source sequentially"
          >
            {runningAll ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> Running all…</>
            ) : (
              <><Repeat className="h-3 w-3" /> Run All</>
            )}
          </Button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {visibleSources.map((config) => (
            <SourceCard
              key={config.source_id}
              sourceConfig={config}
              lastLog={lastLogBySource[config.source_id]}
              pulseTimeline={pulseTimeline}
              activeSuburbCount={activeSuburbCount}
              cardStats={cardStatsById[config.source_id]}
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

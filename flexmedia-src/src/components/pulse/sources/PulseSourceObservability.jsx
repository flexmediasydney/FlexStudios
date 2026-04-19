/**
 * PulseSourceObservability — observability primitives for the Data Sources tab.
 *
 * Exports:
 *   - PipelineHealthRibbon       A/B/C/D/F grade + 4 sub-badges (SLO, success,
 *                                coverage, dead-letter). Click-throughs into
 *                                the relevant sub-view.
 *   - DeadLetterBanner           Thin red banner when any DLQ items exist.
 *   - PipelineTimelineSwimlane   6-hour swimlane of runs across all sources.
 *   - SourceDrillPanel           Slide-out (shadcn Sheet) with tabs:
 *                                Recent runs | Throughput | Errors |
 *                                Dead-letter | Schedule.
 *   - AdminControls              Admin-only row of toggles and buttons.
 *
 * Backed by migration 177 RPCs:
 *   pulse_get_pipeline_health_score()
 *   pulse_get_pipeline_swimlane(hours, limit)
 *   pulse_get_source_error_digest(source_id, days)
 *   pulse_get_source_throughput(source_id, days)
 *
 * Styled with Tailwind + shadcn UI. Recharts for inline viz.
 */
import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, ReferenceLine,
} from "recharts";
import {
  Activity, AlertTriangle, CheckCircle2, Clock, XCircle, RefreshCw,
  TrendingUp, Zap, Skull, Play, Pause, Trash2, Loader2, ChevronRight,
  Calendar, BarChart3, Bug, Inbox, Timer,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtInt(n) { return n == null ? "—" : Number(n).toLocaleString(); }
function fmtPct(n) { return n == null ? "—" : `${Number(n).toFixed(1)}%`; }

function fmtDuration(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

function fmtRelative(d) {
  if (!d) return "—";
  const diff = Date.now() - new Date(d).getTime();
  if (diff < 0) {
    const fut = -diff;
    const mins = Math.round(fut / 60000);
    if (mins < 1) return "in <1m";
    if (mins < 60) return `in ${mins}m`;
    const hrs = Math.round(mins / 60);
    return `in ${hrs}h`;
  }
  const mins = Math.round(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

// Translate a cron string into a human phrase. Handles common patterns;
// falls back to raw expression if unrecognized.
function cronToHuman(cronStr) {
  if (!cronStr || typeof cronStr !== "string") return "On demand";
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [min, hour, dom, month, dow] = parts;
  if (min === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") return "Every minute";
  const slashMin = /^\*\/(\d+)$/.exec(min);
  if (slashMin && hour === "*" && dom === "*" && month === "*" && dow === "*") return `Every ${slashMin[1]} minutes`;
  const slashHour = /^\*\/(\d+)$/.exec(hour);
  if (min === "0" && slashHour && dom === "*" && month === "*" && dow === "*") return `Every ${slashHour[1]} hours`;
  if (dom === "*" && month === "*" && dow === "*" && !hour.includes(",")) {
    if (min === "0") return `Daily at ${hour.padStart(2, "0")}:00 UTC`;
    return `Daily at ${hour}:${min.padStart(2, "0")} UTC`;
  }
  if (dom === "*" && month === "*" && dow === "*" && hour.includes(",")) {
    return `Daily at ${hour.split(",").map((h) => `${h.padStart(2, "0")}:${min.padStart(2, "0")}`).join(", ")} UTC`;
  }
  if (dom === "*" && month === "*" && dow !== "*") {
    const days = { "0": "Sun", "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu", "5": "Fri", "6": "Sat" };
    return `Weekly (${days[dow] || dow}) ${hour}:${min.padStart(2, "0")} UTC`;
  }
  return cronStr;
}

// Estimate next fire time for the simple cron patterns we actually use.
// Returns a Date or null if we can't guess.
function nextFireAt(cronStr) {
  if (!cronStr || typeof cronStr !== "string") return null;
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hour, dom, month, dow] = parts;
  const now = new Date();

  // every N minutes
  const slashMin = /^\*\/(\d+)$/.exec(min);
  if (slashMin && hour === "*") {
    const step = parseInt(slashMin[1], 10);
    const nowMin = now.getUTCMinutes();
    const nextMin = Math.ceil((nowMin + 1) / step) * step;
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    if (nextMin >= 60) {
      next.setUTCHours(next.getUTCHours() + 1, nextMin - 60, 0, 0);
    } else {
      next.setUTCMinutes(nextMin, 0, 0);
    }
    return next;
  }

  // daily one or multi hour
  const mins = parseInt(min, 10);
  if (!isNaN(mins) && dom === "*" && month === "*" && dow === "*") {
    const hours = hour.includes(",") ? hour.split(",").map((h) => parseInt(h, 10)) : [parseInt(hour, 10)];
    if (hours.some(isNaN)) return null;
    const candidates = hours.map((h) => {
      const d = new Date(now);
      d.setUTCHours(h, mins, 0, 0);
      if (d <= now) d.setUTCDate(d.getUTCDate() + 1);
      return d;
    });
    candidates.sort((a, b) => a.getTime() - b.getTime());
    return candidates[0];
  }

  return null;
}

// Countdown text given a target Date.
function countdownTo(target) {
  if (!target) return "—";
  const diff = target.getTime() - Date.now();
  if (diff <= 0) return "due now";
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function gradeColor(grade) {
  if (grade === "A") return "from-emerald-500 to-green-600 text-white";
  if (grade === "B") return "from-sky-500 to-blue-600 text-white";
  if (grade === "C") return "from-amber-500 to-yellow-600 text-white";
  if (grade === "D") return "from-orange-500 to-red-500 text-white";
  return "from-red-600 to-rose-700 text-white"; // F
}

function gradeLabel(grade) {
  return ({
    A: "Excellent",
    B: "Healthy",
    C: "Degraded",
    D: "At risk",
    F: "Broken",
  })[grade] || "Unknown";
}

// ── Health score hook ────────────────────────────────────────────────────────

export function usePipelineHealth() {
  return useQuery({
    queryKey: ["pulse_pipeline_health_score"],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_pipeline_health_score");
      if (error) throw error;
      return data;
    },
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
}

// ── Health ribbon ────────────────────────────────────────────────────────────

export function PipelineHealthRibbon({ onDrillSLO, onDrillSuccess, onDrillCoverage, onDrillDLQ }) {
  const { data: h, isLoading, refetch } = usePipelineHealth();

  const grade = h?.grade || "—";
  const overall = h?.overall_score;
  const sloPct = h?.slo_pct;
  const successPct = h?.success_pct;
  const coveragePct = h?.coverage_pct;
  const dlq = h?.dead_letter_count || 0;

  return (
    <Card className="rounded-xl border shadow-sm overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-stretch">
          {/* Grade tile */}
          <div className={cn("flex flex-col items-center justify-center px-6 py-4 bg-gradient-to-br min-w-[120px]", gradeColor(grade))}>
            <div className="text-5xl font-bold leading-none">{grade}</div>
            <div className="text-[10px] uppercase tracking-wider opacity-90 mt-1">{gradeLabel(grade)}</div>
            {overall != null && <div className="text-[10px] opacity-75 mt-0.5 tabular-nums">{overall}/100</div>}
          </div>

          {/* Sub-badges grid */}
          <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-px bg-border">
            <HealthSubBadge
              label="SLO met"
              icon={Activity}
              primary={fmtPct(sloPct)}
              secondary={h ? `${h.sources_meeting_slo}/${h.sources_total} sources` : ""}
              tone={sloPct >= 90 ? "green" : sloPct >= 60 ? "amber" : "red"}
              onClick={onDrillSLO}
            />
            <HealthSubBadge
              label="Run success"
              icon={CheckCircle2}
              primary={fmtPct(successPct)}
              secondary={h ? `${fmtInt(h.runs_succeeded_24h)} ok · ${fmtInt(h.runs_failed_24h)} fail` : ""}
              tone={successPct >= 95 ? "green" : successPct >= 80 ? "amber" : "red"}
              onClick={onDrillSuccess}
            />
            <HealthSubBadge
              label="Coverage"
              icon={TrendingUp}
              primary={fmtPct(coveragePct)}
              secondary="weighted avg 24h"
              tone={coveragePct >= 95 ? "green" : coveragePct >= 80 ? "amber" : "red"}
              onClick={onDrillCoverage}
            />
            <HealthSubBadge
              label="Dead-lettered"
              icon={Skull}
              primary={fmtInt(dlq)}
              secondary="last 7d"
              tone={dlq === 0 ? "green" : dlq <= 5 ? "amber" : "red"}
              onClick={onDrillDLQ}
            />
          </div>
        </div>
        {h?.snapshot_at && (
          <div className="px-4 py-1.5 bg-muted/30 border-t text-[10px] text-muted-foreground flex items-center justify-between">
            <span>Pipeline health · snapshot {fmtRelative(h.snapshot_at)} · auto-refreshes every 30s</span>
            <button
              onClick={() => refetch()}
              className="inline-flex items-center gap-1 hover:text-foreground"
              title="Force refresh"
              disabled={isLoading}
            >
              <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
              Refresh
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function HealthSubBadge({ label, icon: Icon, primary, secondary, tone, onClick }) {
  const toneClass = {
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  }[tone] || "text-muted-foreground";
  return (
    <button
      type="button"
      className="group bg-background hover:bg-muted/30 px-4 py-3 text-left transition-colors flex flex-col gap-1"
      onClick={onClick}
    >
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3 w-3" />
        {label}
        <ChevronRight className="h-3 w-3 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
      <div className={cn("text-xl font-semibold tabular-nums", toneClass)}>{primary}</div>
      <div className="text-[10px] text-muted-foreground truncate">{secondary || "\u00A0"}</div>
    </button>
  );
}

// ── Dead-letter banner ───────────────────────────────────────────────────────

export function DeadLetterBanner({ onClick }) {
  const { data } = usePipelineHealth();
  const dlq = data?.dead_letter_count || 0;
  const sourcesCount = Array.isArray(data?.dlq_by_source) ? data.dlq_by_source.length : 0;
  if (dlq === 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-red-400/60 bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 transition-colors text-xs"
    >
      <Skull className="h-4 w-4 shrink-0" />
      <span className="font-semibold">{dlq}</span>
      <span>items dead-lettered across</span>
      <span className="font-semibold">{sourcesCount}</span>
      <span>source{sourcesCount === 1 ? "" : "s"}</span>
      <span className="text-red-600/80 dark:text-red-400/80">— click to inspect and retry</span>
      <ChevronRight className="h-3 w-3 ml-auto" />
    </button>
  );
}

// ── Swimlane timeline ───────────────────────────────────────────────────────

export function PipelineTimelineSwimlane({ onRunClick, sourceLabels = {} }) {
  const { data, isLoading } = useQuery({
    queryKey: ["pulse_pipeline_swimlane", 6],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_pipeline_swimlane", { p_hours: 6, p_limit: 500 });
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });

  const runs = data || [];

  // Group by source lane
  const { lanes, tMin, tMax } = useMemo(() => {
    const now = Date.now();
    const tMax = now;
    const tMin = now - 6 * 3600 * 1000;
    const byLane = new Map();
    for (const r of runs) {
      if (!byLane.has(r.source_id)) byLane.set(r.source_id, []);
      byLane.get(r.source_id).push(r);
    }
    const lanes = [...byLane.entries()]
      .map(([sid, items]) => ({ sid, label: sourceLabels[sid] || sid, items }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { lanes, tMin, tMax };
  }, [runs, sourceLabels]);

  if (isLoading && runs.length === 0) {
    return (
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-6 text-center text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin mx-auto mb-2" />
          Loading pipeline timeline…
        </CardContent>
      </Card>
    );
  }

  if (lanes.length === 0) {
    return (
      <Card className="rounded-xl border shadow-sm">
        <CardContent className="p-6 text-center text-xs text-muted-foreground">
          No runs recorded in the last 6 hours.
        </CardContent>
      </Card>
    );
  }

  // Hour tick labels — every hour from tMin to tMax
  const hours = [];
  const startHour = new Date(tMin);
  startHour.setMinutes(0, 0, 0);
  for (let t = startHour.getTime(); t <= tMax; t += 3600 * 1000) {
    hours.push(t);
  }

  const totalSpan = tMax - tMin;
  const x = (t) => `${(((t - tMin) / totalSpan) * 100).toFixed(2)}%`;
  const w = (a, b) => `${(((b - a) / totalSpan) * 100).toFixed(2)}%`;

  const statusColor = (s) => {
    if (s === "completed") return "bg-emerald-500 hover:bg-emerald-600";
    if (s === "failed") return "bg-red-500 hover:bg-red-600";
    if (s === "running") return "bg-blue-500 animate-pulse hover:bg-blue-600";
    if (s === "partial") return "bg-amber-500 hover:bg-amber-600";
    return "bg-slate-400 hover:bg-slate-500";
  };

  return (
    <Card className="rounded-xl border shadow-sm overflow-hidden">
      <CardContent className="p-0">
        <div className="px-4 py-2 border-b bg-muted/30 flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-xs font-semibold uppercase tracking-wider">Pipeline timeline · last 6 hours</h3>
          <Badge variant="outline" className="text-[10px]">{runs.length} runs</Badge>
          <div className="ml-auto flex items-center gap-2 text-[10px] text-muted-foreground">
            <LegendDot className="bg-emerald-500" /> ok
            <LegendDot className="bg-red-500" /> fail
            <LegendDot className="bg-blue-500" /> running
          </div>
        </div>

        <div className="overflow-x-auto">
          <div className="min-w-[600px]">
            {/* Hour axis */}
            <div className="relative h-5 border-b bg-muted/20">
              {hours.map((t) => (
                <div
                  key={t}
                  className="absolute top-0 bottom-0 border-l border-border/50"
                  style={{ left: x(t) }}
                >
                  <span className="text-[9px] text-muted-foreground pl-1">
                    {new Date(t).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))}
            </div>

            {/* Lanes */}
            <TooltipProvider delayDuration={100}>
              {lanes.map((lane) => (
                <div key={lane.sid} className="relative h-7 border-b border-border/40 last:border-0 flex">
                  <div className="shrink-0 w-40 px-2 py-1 text-[10px] text-muted-foreground truncate bg-muted/20 border-r" title={lane.label}>
                    {lane.label}
                  </div>
                  <div className="relative flex-1">
                    {/* gridlines */}
                    {hours.map((t) => (
                      <div
                        key={`gl-${lane.sid}-${t}`}
                        className="absolute top-0 bottom-0 border-l border-border/30"
                        style={{ left: x(t) }}
                      />
                    ))}
                    {lane.items.map((r) => {
                      const start = new Date(r.started_at).getTime();
                      const end = r.completed_at ? new Date(r.completed_at).getTime() : Date.now();
                      const left = Math.max(start, tMin);
                      const right = Math.min(Math.max(end, start + 20_000), tMax); // min 20s width
                      if (right < tMin || left > tMax) return null;
                      return (
                        <Tooltip key={r.id}>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={() => onRunClick && onRunClick(r)}
                              className={cn(
                                "absolute top-1 bottom-1 rounded transition-colors",
                                statusColor(r.status),
                              )}
                              style={{ left: x(left), width: w(left, right), minWidth: 3 }}
                            />
                          </TooltipTrigger>
                          <TooltipContent side="top" className="text-[11px]">
                            <div className="font-semibold">{lane.label}</div>
                            <div className="text-muted-foreground">{new Date(r.started_at).toLocaleString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</div>
                            <div>Status: <span className="font-mono">{r.status}</span></div>
                            <div>Duration: {fmtDuration(r.duration_seconds)}</div>
                            {r.records_fetched != null && <div>{fmtInt(r.records_fetched)} fetched · {fmtInt(r.records_new || 0)} new</div>}
                            {r.error_message && <div className="text-red-400 max-w-[250px] break-words">{String(r.error_message).slice(0, 180)}</div>}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              ))}
            </TooltipProvider>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function LegendDot({ className }) {
  return <span className={cn("inline-block w-2 h-2 rounded-sm", className)} />;
}

// ── Drill panel (slide-out) ─────────────────────────────────────────────────

export function SourceDrillPanel({
  open,
  onClose,
  sourceConfig,
  onRun,
  onOpenSyncLog,
  onOpenSchedule,
  isAdmin = false,
  runningNow = false,
}) {
  const [tab, setTab] = useState("runs");
  useEffect(() => { if (open) setTab("runs"); }, [open, sourceConfig?.source_id]);

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
        {sourceConfig && (
          <>
            <SheetHeader className="p-4 border-b bg-muted/20">
              <SheetTitle className="text-base font-semibold flex items-center gap-2">
                <Activity className="h-4 w-4" />
                {sourceConfig.label}
              </SheetTitle>
              <SheetDescription className="text-[11px] flex flex-wrap items-center gap-2">
                <span className="font-mono">{sourceConfig.source_id}</span>
                <span>·</span>
                <span>{cronToHuman(sourceConfig.schedule_cron)}</span>
                {sourceConfig.schedule_cron && (() => {
                  const next = nextFireAt(sourceConfig.schedule_cron);
                  return next ? <><span>·</span><span>next run {countdownTo(next)}</span></> : null;
                })()}
              </SheetDescription>
              <div className="flex items-center gap-2 pt-2">
                <Button
                  size="sm"
                  className="h-7 text-xs gap-1"
                  onClick={() => onRun && onRun(sourceConfig)}
                  disabled={runningNow || sourceConfig.is_enabled === false}
                >
                  {runningNow ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  Run now
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1"
                  onClick={() => onOpenSchedule && onOpenSchedule(sourceConfig)}
                >
                  <Calendar className="h-3 w-3" />
                  Schedule
                </Button>
              </div>
            </SheetHeader>

            <Tabs value={tab} onValueChange={setTab} className="w-full">
              <TabsList className="w-full justify-start rounded-none border-b bg-transparent h-auto p-0">
                <DrillTab value="runs" icon={Clock} label="Recent runs" />
                <DrillTab value="throughput" icon={TrendingUp} label="Throughput" />
                <DrillTab value="errors" icon={Bug} label="Errors" />
                <DrillTab value="dlq" icon={Skull} label="Dead-letter" />
                <DrillTab value="schedule" icon={Calendar} label="Schedule" />
              </TabsList>

              <TabsContent value="runs" className="p-4 m-0">
                <DrillRecentRuns sourceId={sourceConfig.source_id} onOpenSyncLog={onOpenSyncLog} />
              </TabsContent>
              <TabsContent value="throughput" className="p-4 m-0">
                <DrillThroughput sourceId={sourceConfig.source_id} />
              </TabsContent>
              <TabsContent value="errors" className="p-4 m-0">
                <DrillErrors sourceId={sourceConfig.source_id} onOpenSyncLog={onOpenSyncLog} />
              </TabsContent>
              <TabsContent value="dlq" className="p-4 m-0">
                <DrillDeadLetter sourceId={sourceConfig.source_id} isAdmin={isAdmin} />
              </TabsContent>
              <TabsContent value="schedule" className="p-4 m-0">
                <DrillSchedule sourceConfig={sourceConfig} onEdit={onOpenSchedule} isAdmin={isAdmin} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DrillTab({ value, icon: Icon, label }) {
  return (
    <TabsTrigger
      value={value}
      className="rounded-none border-b-2 border-transparent data-[state=active]:border-primary data-[state=active]:bg-transparent px-3 py-2 text-xs gap-1.5"
    >
      <Icon className="h-3 w-3" />
      {label}
    </TabsTrigger>
  );
}

function DrillRecentRuns({ sourceId, onOpenSyncLog }) {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pulse_drill_recent_runs", sourceId],
    queryFn: async () => {
      const { data, error } = await api._supabase
        .from("pulse_sync_logs")
        .select("id, status, started_at, completed_at, records_fetched, records_new, records_updated, error_message, triggered_by")
        .eq("source_id", sourceId)
        .order("started_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 5_000,
    staleTime: 3_000,
  });

  const rows = data || [];
  if (isLoading && rows.length === 0) {
    return <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto" /></div>;
  }
  if (rows.length === 0) {
    return <div className="text-xs text-muted-foreground py-6 text-center">No runs yet.</div>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b text-muted-foreground">
            <th className="text-left py-1.5 pr-2 font-medium">Started</th>
            <th className="text-left py-1.5 pr-2 font-medium">Status</th>
            <th className="text-right py-1.5 pr-2 font-medium">Duration</th>
            <th className="text-right py-1.5 pr-2 font-medium">Fetched</th>
            <th className="text-right py-1.5 pr-2 font-medium">New</th>
            <th className="text-left py-1.5 font-medium">Error</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const dur = r.completed_at
              ? (new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()) / 1000
              : (Date.now() - new Date(r.started_at).getTime()) / 1000;
            return (
              <tr
                key={r.id}
                className="border-b border-border/30 hover:bg-muted/30 cursor-pointer"
                onClick={() => onOpenSyncLog && onOpenSyncLog(r.id)}
              >
                <td className="py-1.5 pr-2 tabular-nums">{new Date(r.started_at).toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="py-1.5 pr-2"><StatusPill status={r.status} /></td>
                <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">{fmtDuration(dur)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{fmtInt(r.records_fetched)}</td>
                <td className="py-1.5 pr-2 text-right tabular-nums">{fmtInt(r.records_new)}</td>
                <td className="py-1.5 truncate max-w-[180px]" title={r.error_message || ""}>
                  {r.error_message && (
                    <span className="text-red-600 dark:text-red-400">{String(r.error_message).slice(0, 60)}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="text-[10px] text-muted-foreground pt-2 text-right">
        Auto-refreshes every 5s ·{" "}
        <button onClick={() => refetch()} className="underline">refresh now</button>
      </div>
    </div>
  );
}

function StatusPill({ status }) {
  const s = status || "—";
  const cls = {
    completed: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 animate-pulse",
    partial: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  }[s] || "bg-muted text-muted-foreground";
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium", cls)}>{s}</span>;
}

function DrillThroughput({ sourceId }) {
  const { data, isLoading } = useQuery({
    queryKey: ["pulse_drill_throughput", sourceId],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_source_throughput", { p_source_id: sourceId, p_days: 30 });
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = data || [];

  const { mean, stddev } = useMemo(() => {
    const xs = rows.map((r) => Number(r.records_fetched || 0));
    if (xs.length === 0) return { mean: 0, stddev: 0 };
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
    return { mean: m, stddev: Math.sqrt(v) };
  }, [rows]);

  const threshold = Math.max(0, mean - 2 * stddev);

  const chartData = rows.map((r) => ({
    ts: new Date(r.started_at).getTime(),
    label: new Date(r.started_at).toLocaleDateString("en-AU", { day: "2-digit", month: "short" }),
    fetched: r.records_fetched || 0,
    isAnomaly: (r.records_fetched || 0) < threshold && rows.length >= 5,
  }));

  if (isLoading) return <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto" /></div>;
  if (rows.length === 0) return <div className="text-xs text-muted-foreground py-6 text-center">No throughput data in last 30 days.</div>;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3 text-[11px]">
        <MiniStat label="Mean / run" value={fmtInt(Math.round(mean))} />
        <MiniStat label="Std dev" value={fmtInt(Math.round(stddev))} />
        <MiniStat label="Anomaly threshold" value={fmtInt(Math.round(threshold))} tone="amber" />
      </div>
      <div className="h-48">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 10, right: 10, bottom: 10, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-muted/30" />
            <XAxis dataKey="label" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 9 }} width={30} />
            <RTooltip contentStyle={{ fontSize: 10, padding: 6 }} />
            <ReferenceLine y={mean} stroke="#10b981" strokeDasharray="3 3" label={{ value: "mean", fontSize: 9, fill: "#10b981" }} />
            <ReferenceLine y={threshold} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: "−2σ", fontSize: 9, fill: "#f59e0b" }} />
            <Bar dataKey="fetched" fill="#3b82f6" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[10px] text-muted-foreground">
        {chartData.filter((d) => d.isAnomaly).length} run{chartData.filter((d) => d.isAnomaly).length === 1 ? "" : "s"} below −2σ (potential anomalies).
      </p>
    </div>
  );
}

function MiniStat({ label, value, tone }) {
  const toneCls = {
    green: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    red: "text-red-600 dark:text-red-400",
  }[tone] || "text-foreground";
  return (
    <div className="border rounded px-2 py-1.5">
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("text-sm font-semibold tabular-nums", toneCls)}>{value}</div>
    </div>
  );
}

function DrillErrors({ sourceId, onOpenSyncLog }) {
  const { data, isLoading } = useQuery({
    queryKey: ["pulse_drill_errors", sourceId],
    queryFn: async () => {
      const { data, error } = await api._supabase.rpc("pulse_get_source_error_digest", { p_source_id: sourceId, p_days: 7 });
      if (error) throw error;
      return data || [];
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const rows = data || [];
  if (isLoading) return <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto" /></div>;
  if (rows.length === 0) return <div className="text-xs text-muted-foreground py-6 text-center">No failed runs in the last 7 days.</div>;

  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="border rounded-lg p-2.5 hover:bg-muted/30">
          <div className="flex items-start gap-2">
            <AlertTriangle className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="font-mono text-[11px] break-words">{r.error_signature || "—"}</div>
              <div className="text-[10px] text-muted-foreground mt-1">
                <span className="font-semibold text-red-600 dark:text-red-400">{r.occurrences}</span> occurrence{r.occurrences === 1 ? "" : "s"} ·
                first {fmtRelative(r.first_seen)} · last {fmtRelative(r.last_seen)}
              </div>
            </div>
            {r.example_sync_log_id && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[10px]"
                onClick={() => onOpenSyncLog && onOpenSyncLog(r.example_sync_log_id)}
              >
                View example <ChevronRight className="h-3 w-3 ml-0.5" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DrillDeadLetter({ sourceId, isAdmin }) {
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["pulse_drill_dlq", sourceId],
    queryFn: async () => {
      const { data, error } = await api._supabase
        .from("pulse_fire_queue")
        .select("id, suburb_name, postcode, actor_input, last_error, last_error_category, attempts, max_attempts, updated_at, completed_at")
        .eq("source_id", sourceId)
        .eq("status", "failed")
        .gte("updated_at", new Date(Date.now() - 7 * 86_400_000).toISOString())
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data || []).filter((r) => r.attempts >= r.max_attempts);
    },
    refetchInterval: 20_000,
    staleTime: 10_000,
  });

  const rows = data || [];
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["pulse_drill_dlq", sourceId] });
    qc.invalidateQueries({ queryKey: ["pulse_pipeline_health_score"] });
  };

  const retryOne = async (id) => {
    try {
      const { error } = await api._supabase
        .from("pulse_fire_queue")
        .update({
          status: "pending",
          attempts: 0,
          last_error: null,
          last_error_category: null,
          next_attempt_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("Re-queued for retry");
      invalidate();
    } catch (e) {
      toast.error(`Retry failed: ${e.message}`);
    }
  };

  const retryAll = async () => {
    if (!rows.length) return;
    if (!window.confirm(`Retry all ${rows.length} dead-lettered items for this source?`)) return;
    try {
      const ids = rows.map((r) => r.id);
      const { error } = await api._supabase
        .from("pulse_fire_queue")
        .update({
          status: "pending",
          attempts: 0,
          last_error: null,
          last_error_category: null,
          next_attempt_at: new Date().toISOString(),
        })
        .in("id", ids);
      if (error) throw error;
      toast.success(`Re-queued ${ids.length} item${ids.length === 1 ? "" : "s"}`);
      invalidate();
    } catch (e) {
      toast.error(`Bulk retry failed: ${e.message}`);
    }
  };

  const deleteOne = async (id) => {
    if (!window.confirm("Delete this dead-lettered item permanently?")) return;
    try {
      const { error } = await api._supabase.from("pulse_fire_queue").delete().eq("id", id);
      if (error) throw error;
      toast.success("Deleted");
      invalidate();
    } catch (e) {
      toast.error(`Delete failed: ${e.message}`);
    }
  };

  if (isLoading) return <div className="text-xs text-muted-foreground py-6 text-center"><Loader2 className="h-4 w-4 animate-spin mx-auto" /></div>;
  if (rows.length === 0) {
    return (
      <div className="text-xs text-muted-foreground py-6 text-center flex flex-col items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-500" />
        No dead-lettered items. Queue is healthy.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-muted-foreground">{rows.length} dead-lettered item{rows.length === 1 ? "" : "s"}</div>
        {isAdmin && (
          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={retryAll}>
            <RefreshCw className="h-3 w-3 mr-1" />
            Retry all
          </Button>
        )}
      </div>
      {rows.map((r) => (
        <div key={r.id} className="border rounded-lg p-2.5">
          <div className="flex items-start gap-2">
            <Skull className="h-3.5 w-3.5 text-red-500 shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-semibold">{r.suburb_name || "—"}{r.postcode ? ` · ${r.postcode}` : ""}</div>
              <div className="text-[10px] text-muted-foreground mt-0.5">
                {r.attempts}/{r.max_attempts} attempts · {r.last_error_category || "unknown"} · {fmtRelative(r.updated_at)}
              </div>
              {r.last_error && (
                <div className="text-[10px] text-red-600 dark:text-red-400 mt-1 break-words font-mono">
                  {String(r.last_error).slice(0, 240)}
                </div>
              )}
            </div>
            {isAdmin && (
              <div className="flex flex-col gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]" onClick={() => retryOne(r.id)}>
                  <RefreshCw className="h-3 w-3" />
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] text-red-600" onClick={() => deleteOne(r.id)}>
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        </div>
      ))}
      <div className="text-[10px] text-muted-foreground pt-1 text-right">
        <button onClick={() => refetch()} className="underline">refresh</button>
      </div>
    </div>
  );
}

function DrillSchedule({ sourceConfig, onEdit, isAdmin }) {
  const [, forceTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const next = sourceConfig?.schedule_cron ? nextFireAt(sourceConfig.schedule_cron) : null;
  return (
    <div className="space-y-3 text-xs">
      <div className="border rounded-lg p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Cron expression</div>
          {isAdmin && (
            <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => onEdit && onEdit(sourceConfig)}>
              Edit schedule
            </Button>
          )}
        </div>
        <div className="font-mono text-sm">{sourceConfig?.schedule_cron || "(none)"}</div>
        <div className="text-muted-foreground">{cronToHuman(sourceConfig?.schedule_cron)}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Next run</div>
          <div className="text-sm font-semibold tabular-nums">{next ? countdownTo(next) : "—"}</div>
          <div className="text-[10px] text-muted-foreground">{next ? next.toLocaleString("en-AU", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }) : "unknown"}</div>
        </div>
        <div className="border rounded-lg p-3">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Approach</div>
          <div className="text-sm font-semibold capitalize">{(sourceConfig?.approach || "").replace("_", " ") || "—"}</div>
          <div className="text-[10px] text-muted-foreground">
            {sourceConfig?.approach === "bounding_box" ? "Single call, Greater Sydney" : `Per-suburb · min_priority ${sourceConfig?.min_priority ?? 0}`}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Admin controls row ──────────────────────────────────────────────────────

export function AdminControls({ sources = [], onRefresh }) {
  const [busy, setBusy] = useState(false);

  const togglePause = async (sourceId, newState) => {
    try {
      const { error } = await api._supabase
        .from("pulse_source_configs")
        .update({ is_enabled: newState })
        .eq("source_id", sourceId);
      if (error) throw error;
      toast.success(`${sourceId}: ${newState ? "resumed" : "paused"}`);
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(`Toggle failed: ${e.message}`);
    }
  };

  const clearStuck = async () => {
    if (!window.confirm("Mark all 'running' sync_logs older than 30 minutes as 'failed'?")) return;
    setBusy(true);
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const { data, error } = await api._supabase
        .from("pulse_sync_logs")
        .update({ status: "failed", completed_at: new Date().toISOString(), error_message: "Marked as stuck by admin clear" })
        .eq("status", "running")
        .lt("started_at", cutoff)
        .select("id");
      if (error) throw error;
      toast.success(`Cleared ${data?.length || 0} stuck run${(data?.length || 0) === 1 ? "" : "s"}`);
      onRefresh && onRefresh();
    } catch (e) {
      toast.error(`Clear failed: ${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="rounded-xl border shadow-sm">
      <CardContent className="p-3 flex flex-wrap items-center gap-2 text-xs">
        <span className="font-semibold text-muted-foreground uppercase tracking-wide text-[10px] mr-2">Admin</span>
        {sources.map((s) => (
          <Button
            key={s.source_id}
            size="sm"
            variant="outline"
            className={cn(
              "h-7 text-[11px] gap-1",
              s.is_enabled === false && "opacity-60"
            )}
            onClick={() => togglePause(s.source_id, s.is_enabled === false)}
            title={s.is_enabled === false ? "Click to resume" : "Click to pause"}
          >
            {s.is_enabled === false ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}
            {s.label || s.source_id}
          </Button>
        ))}
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-[11px] gap-1 ml-auto"
          onClick={clearStuck}
          disabled={busy}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Timer className="h-3 w-3" />}
          Clear stuck runs &gt; 30m
        </Button>
      </CardContent>
    </Card>
  );
}

// ── Exports ─────────────────────────────────────────────────────────────────

export { cronToHuman, nextFireAt, countdownTo, fmtRelative };

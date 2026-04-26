/**
 * ShortlistingCommandCenter — Wave 6 Phase 7 SHORTLIST
 *
 * Global ops dashboard for the Photo Shortlisting Engine. master_admin/admin only.
 *
 * Layout (mirrors DroneCommandCenter conventions):
 *   1. Hero stat cards: Today's rounds · Pending jobs · Dead-letter · Cost today ·
 *      Median round duration · Active rounds processing
 *   2. Pipeline kanban — shortlisting_rounds grouped by status
 *      (processing | proposed | locked | delivered)
 *   3. Activity feed — last 50 shortlisting_events (filterable)
 *   4. Dead-letter section — get_shortlisting_dead_letter_jobs(50) + Resurrect button
 *   5. Alerts panel — unfilled mandatory slots + bracket-count anomalies
 *   6. Phase 8 placeholder — Recalibration Proposals (post-learning loop)
 *
 * Realtime/polling strategy:
 *   - 30 s refetch interval on the hero stats, dead-letter, kanban, alerts, and
 *     events queries (matches the brief's 30 s auto-refresh contract). Realtime
 *     subscriptions on shortlisting_rounds + shortlisting_events keep the UI
 *     "live" between polling beats so an operator doesn't have to wait the
 *     full window to see a status change.
 *
 * Auth gate: defensive in-component permission check (admin+) on top of the
 * route guard in routeAccess.jsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  DollarSign,
  Layers,
  Loader2,
  ListChecks,
  Lock,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  TimerReset,
  TrendingUp,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";

// ── Pipeline kanban columns ─────────────────────────────────────────────────
//
// Each column groups one (or more) shortlisting_rounds.status values.
// The terminal "delivered" column lets operators see what shipped today
// without having to dig into the project pages.
const PIPELINE_COLUMNS = [
  { key: "processing", label: "Processing",  statuses: ["pending", "processing"] },
  { key: "proposed",   label: "Proposed",    statuses: ["proposed"] },
  { key: "locked",     label: "Locked",      statuses: ["locked"] },
  { key: "delivered",  label: "Delivered",   statuses: ["delivered"] },
];

const STATUS_TONE = {
  pending:    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  processing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  proposed:   "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  locked:     "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  delivered:  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const EVENT_TYPE_TONE = {
  pass0_started:        "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  pass0_complete:       "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  pass1_started:        "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  pass1_complete:       "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  pass2_started:        "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  pass2_slot_assigned:  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  pass2_phase3_recommendation: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  pass2_complete:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  pass3_started:        "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  pass3_complete:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  round_locked:         "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  round_delivered:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  override_recorded:    "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  job_failed:           "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  job_dead_letter:      "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

const PER_COLUMN_LIMIT = 8;
const ACTIVITY_PAGE_SIZE = 50;
const ACTIVITY_WINDOW_HOURS = 24;
const POLL_INTERVAL_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return "—";
  }
}
function fmtSeconds(secs) {
  if (secs == null || !isFinite(Number(secs))) return "—";
  const n = Number(secs);
  if (n < 60) return `${Math.round(n)}s`;
  if (n < 3600) return `${(n / 60).toFixed(1)}m`;
  return `${(n / 3600).toFixed(1)}h`;
}
function num(v, fallback = "—") {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    const n = Number(v);
    return isFinite(n) ? n : fallback;
  }
  return typeof v === "number" && isFinite(v) ? v : fallback;
}
function fmtCost(usd) {
  if (usd == null || !isFinite(Number(usd))) return "$0.00";
  return `$${Number(usd).toFixed(2)}`;
}
function truncate(str, max = 80) {
  if (!str) return "";
  const s = String(str);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── Hero stat card ──────────────────────────────────────────────────────────
function StatCard({ icon: Icon, label, value, suffix, hint, tone }) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div
            className={cn(
              "h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0",
              tone || "bg-muted",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground truncate">
              {label}
            </p>
            <p className="text-lg font-semibold tabular-nums leading-tight mt-0.5">
              {value}
              {suffix && (
                <span className="text-xs font-normal text-muted-foreground ml-1">
                  {suffix}
                </span>
              )}
            </p>
            {hint && (
              <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
                {hint}
              </p>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Pipeline kanban ─────────────────────────────────────────────────────────
function PipelineKanban({ rounds, projectsById }) {
  const navigate = useNavigate();

  const grouped = useMemo(() => {
    const byCol = new Map(PIPELINE_COLUMNS.map((c) => [c.key, []]));
    for (const r of rounds || []) {
      const col = PIPELINE_COLUMNS.find((c) => c.statuses.includes(r.status));
      if (col) byCol.get(col.key).push(r);
    }
    for (const col of PIPELINE_COLUMNS) {
      const arr = byCol.get(col.key);
      arr.sort(
        (a, b) =>
          new Date(b.started_at || b.created_at || 0).getTime() -
          new Date(a.started_at || a.created_at || 0).getTime(),
      );
      byCol.set(col.key, arr.slice(0, PER_COLUMN_LIMIT));
    }
    return byCol;
  }, [rounds]);

  const totalsByCol = useMemo(() => {
    const totals = new Map();
    for (const col of PIPELINE_COLUMNS) {
      const count = (rounds || []).filter((r) => col.statuses.includes(r.status))
        .length;
      totals.set(col.key, count);
    }
    return totals;
  }, [rounds]);

  const handleClick = (round) => {
    if (!round?.project_id) return;
    navigate(
      createPageUrl("ProjectDetails") +
        `?id=${round.project_id}&tab=shortlisting&round=${round.id}`,
    );
  };

  const totalActive = useMemo(
    () =>
      (rounds || []).filter((r) =>
        PIPELINE_COLUMNS.some((c) => c.statuses.includes(r.status)),
      ).length,
    [rounds],
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Layers className="h-4 w-4" />
          Pipeline
          <span className="text-muted-foreground font-normal">
            ({totalActive} rounds)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {totalActive === 0 ? (
          <div className="px-4 py-8 text-center">
            <Sparkles className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm font-medium text-muted-foreground">
              No active shortlisting rounds
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Pipeline appears once a round moves past pending.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <div
              className="grid gap-2 p-3 min-w-[800px]"
              style={{
                gridTemplateColumns: `repeat(${PIPELINE_COLUMNS.length}, minmax(180px, 1fr))`,
              }}
            >
              {PIPELINE_COLUMNS.map((col) => {
                const items = grouped.get(col.key) || [];
                const total = totalsByCol.get(col.key) || 0;
                return (
                  <div key={col.key} className="space-y-1.5">
                    <div className="flex items-center justify-between px-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {col.label}
                      </span>
                      <span className="text-[10px] font-medium text-muted-foreground tabular-nums">
                        {total}
                      </span>
                    </div>
                    {items.length === 0 ? (
                      <div className="rounded border border-dashed border-border/60 px-2 py-3 text-[11px] text-muted-foreground italic text-center">
                        empty
                      </div>
                    ) : (
                      items.map((r) => {
                        const proj = projectsById?.get?.(r.project_id);
                        const projName =
                          proj?.title ||
                          proj?.property_address ||
                          `Project ${String(r.project_id).slice(0, 8)}`;
                        return (
                          <button
                            key={r.id}
                            onClick={() => handleClick(r)}
                            className="w-full text-left rounded border bg-background hover:bg-muted/40 transition-colors p-2 space-y-1"
                            title={projName}
                          >
                            <div className="flex items-center gap-1">
                              <span
                                className={cn(
                                  "inline-block h-1.5 w-1.5 rounded-full",
                                  STATUS_TONE[r.status]?.split(" ")[0] || "bg-muted",
                                )}
                              />
                              <span className="text-[11px] font-medium truncate flex-1">
                                {projName}
                              </span>
                              <Badge
                                variant="outline"
                                className="text-[9px] px-1 py-0"
                              >
                                #{r.round_number}
                              </Badge>
                            </div>
                            <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                              {r.package_type && (
                                <span className="truncate">{r.package_type}</span>
                              )}
                              {typeof r.total_compositions === "number" && (
                                <span className="tabular-nums">
                                  {r.total_compositions} comps
                                </span>
                              )}
                              {typeof r.total_cost_usd === "number" && (
                                <span className="tabular-nums">
                                  {fmtCost(r.total_cost_usd)}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground">
                              {fmtTime(r.started_at || r.created_at)}
                            </div>
                          </button>
                        );
                      })
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Activity feed ───────────────────────────────────────────────────────────
function ActivityRow({ event, projectsById, expanded, onToggle }) {
  const proj = projectsById?.get?.(event.project_id);
  const projName =
    proj?.title ||
    proj?.property_address ||
    (event.project_id
      ? `Project ${String(event.project_id).slice(0, 8)}`
      : "—");
  const ts = event.created_at ? new Date(event.created_at) : null;
  const tone =
    EVENT_TYPE_TONE[event.event_type] ||
    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200";

  // Build a short payload summary line.
  const payloadSummary = useMemo(() => {
    if (!event.payload || typeof event.payload !== "object") return "";
    const p = event.payload;
    const parts = [];
    if (p.slot_id) parts.push(`slot=${p.slot_id}`);
    if (p.rank != null) parts.push(`rank=${p.rank}`);
    if (p.phase != null) parts.push(`phase=${p.phase}`);
    if (typeof p.cost_usd === "number") parts.push(`cost=$${p.cost_usd.toFixed(3)}`);
    if (typeof p.total_cost_usd === "number")
      parts.push(`total=$${p.total_cost_usd.toFixed(2)}`);
    if (Array.isArray(p.unfilled_slots) && p.unfilled_slots.length > 0)
      parts.push(`unfilled=[${p.unfilled_slots.join(", ")}]`);
    if (Array.isArray(p.warnings) && p.warnings.length > 0)
      parts.push(`warnings=${p.warnings.length}`);
    return parts.join(" · ");
  }, [event.payload]);

  return (
    <li className="px-3 py-2 hover:bg-muted/40 text-xs">
      <div className="flex items-start gap-3">
        <div className="h-5 w-5 rounded flex items-center justify-center flex-shrink-0 bg-muted mt-0.5">
          <Activity className="h-3 w-3" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className={cn("text-[10px]", tone)}
            >
              {event.event_type || "event"}
            </Badge>
            <span className="text-muted-foreground">in</span>
            {event.project_id ? (
              <Link
                to={
                  createPageUrl("ProjectDetails") +
                  `?id=${event.project_id}&tab=shortlisting${event.round_id ? `&round=${event.round_id}` : ""}`
                }
                className="font-medium text-foreground hover:text-primary truncate max-w-[280px]"
                title={projName}
              >
                {projName}
              </Link>
            ) : (
              <span className="font-medium text-foreground">—</span>
            )}
            {payloadSummary && (
              <span className="font-mono text-[10px] truncate max-w-[280px]" title={payloadSummary}>
                {truncate(payloadSummary, 80)}
              </span>
            )}
            {event.payload && typeof event.payload === "object" && Object.keys(event.payload).length > 0 && (
              <button
                onClick={onToggle}
                className="ml-auto text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                title={expanded ? "Hide payload" : "Show full payload"}
              >
                {expanded ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                payload
              </button>
            )}
          </div>
          <div className="text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
            <span title={ts ? format(ts, "PPpp") : ""}>{fmtTime(event.created_at)}</span>
            <span>·</span>
            <span>{event.actor_type || "system"}</span>
          </div>
          {expanded && event.payload && (
            <pre className="mt-1 text-[10px] bg-muted/40 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">
              {JSON.stringify(event.payload, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </li>
  );
}

function ActivityFeed({
  events,
  projectsById,
  isLoading,
  onRefresh,
  isFetching,
}) {
  const [search, setSearch] = useState("");
  const [eventTypeFilter, setEventTypeFilter] = useState("all");
  const [expandedIds, setExpandedIds] = useState(() => new Set());

  const eventTypeOptions = useMemo(() => {
    const set = new Set();
    for (const e of events || []) if (e.event_type) set.add(e.event_type);
    return Array.from(set).sort();
  }, [events]);

  const filtered = useMemo(() => {
    if (!Array.isArray(events)) return [];
    return events.filter((e) => {
      if (eventTypeFilter !== "all" && e.event_type !== eventTypeFilter)
        return false;
      if (search.trim()) {
        const s = search.trim().toLowerCase();
        const proj = projectsById?.get?.(e.project_id);
        const haystack = [
          e.event_type,
          e.actor_type,
          proj?.title,
          proj?.property_address,
          typeof e.payload === "object" ? JSON.stringify(e.payload) : null,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(s)) return false;
      }
      return true;
    });
  }, [events, eventTypeFilter, search, projectsById]);

  const toggleExpand = useCallback((id) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Activity className="h-4 w-4" />
            Activity feed
            {isFetching && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
          <Button
            variant="ghost"
            size="sm"
            onClick={onRefresh}
            disabled={isFetching}
            className="h-7 px-2 text-xs"
          >
            <RefreshCw
              className={cn("h-3 w-3", isFetching && "animate-spin")}
            />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search project, event, payload…"
              className="pl-7 h-9 text-xs"
            />
          </div>
          <Select value={eventTypeFilter} onValueChange={setEventTypeFilter}>
            <SelectTrigger className="h-9 w-[200px] text-xs">
              <SelectValue placeholder="Event type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {eventTypeOptions.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="text-[10px] text-muted-foreground">
          Showing events from the last {ACTIVITY_WINDOW_HOURS}h ({filtered.length} of{" "}
          {events?.length || 0} loaded)
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="h-12 rounded bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">
            No events match the current filters.
          </div>
        ) : (
          <ul className="divide-y rounded border max-h-[600px] overflow-y-auto">
            {filtered.map((e) => (
              <ActivityRow
                key={e.id}
                event={e}
                projectsById={projectsById}
                expanded={expandedIds.has(e.id)}
                onToggle={() => toggleExpand(e.id)}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Dead-letter section ─────────────────────────────────────────────────────
function DeadLetterSection({
  jobs,
  projectsById,
  isLoading,
  isFetching,
  onResurrect,
  resurrectingId,
}) {
  const [confirmId, setConfirmId] = useState(null);
  const navigate = useNavigate();

  const confirmJob = useMemo(
    () => jobs?.find?.((j) => j.id === confirmId) || null,
    [jobs, confirmId],
  );

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-500" />
            Dead-letter jobs
            <span className="text-muted-foreground font-normal">
              ({jobs?.length ?? 0})
            </span>
            {isFetching && (
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-10 rounded bg-muted/40 animate-pulse" />
              ))}
            </div>
          ) : !jobs || jobs.length === 0 ? (
            <div className="px-4 py-6 flex items-center gap-2 text-emerald-700 dark:text-emerald-300 bg-emerald-50/60 dark:bg-emerald-950/30 m-3 rounded">
              <CheckCircle2 className="h-4 w-4" />
              <span className="text-xs font-medium">
                No dead-letter jobs — engine healthy.
              </span>
            </div>
          ) : (
            <ul className="divide-y">
              {jobs.map((j) => {
                const proj = projectsById?.get?.(j.project_id);
                const projName =
                  proj?.title ||
                  proj?.property_address ||
                  (j.project_id
                    ? `Project ${String(j.project_id).slice(0, 8)}`
                    : "—");
                const isResurrecting = resurrectingId === j.id;
                return (
                  <li
                    key={j.id}
                    className="px-3 py-2.5 text-xs flex items-start gap-3 hover:bg-muted/30"
                  >
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline" className="text-[10px] font-mono">
                          {j.kind || "job"}
                        </Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          attempt {j.attempt_count ?? "?"}
                        </Badge>
                        {j.project_id ? (
                          <Link
                            to={
                              createPageUrl("ProjectDetails") +
                              `?id=${j.project_id}&tab=shortlisting${j.round_id ? `&round=${j.round_id}` : ""}`
                            }
                            className="font-medium text-foreground hover:text-primary truncate max-w-[260px]"
                            title={projName}
                          >
                            {projName}
                          </Link>
                        ) : (
                          <span className="font-medium text-foreground">—</span>
                        )}
                      </div>
                      <p
                        className="text-[11px] text-red-700 dark:text-red-300 font-mono break-words"
                        title={j.error_message}
                      >
                        {truncate(j.error_message, 200) || "(no error message)"}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        failed {fmtTime(j.finished_at || j.scheduled_for)}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {j.project_id && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-[11px]"
                          onClick={() =>
                            navigate(
                              createPageUrl("ProjectDetails") +
                                `?id=${j.project_id}&tab=shortlisting${j.round_id ? `&round=${j.round_id}` : ""}`,
                            )
                          }
                          title="Open project shortlisting"
                        >
                          Open
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 text-[11px]"
                        onClick={() => setConfirmId(j.id)}
                        disabled={isResurrecting}
                        title="Resurrect this job"
                      >
                        {isResurrecting ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <>
                            <RotateCcw className="h-3 w-3 mr-1" />
                            Resurrect
                          </>
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!confirmId} onOpenChange={(o) => !o && setConfirmId(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resurrect dead-letter job?</DialogTitle>
            <DialogDescription>
              The job will be re-queued with a fresh attempt budget. Use this only
              after the underlying cause has been resolved (e.g. transient API
              failure, missing input fixed).
            </DialogDescription>
          </DialogHeader>
          {confirmJob && (
            <div className="text-xs space-y-1.5 bg-muted/40 rounded p-3 font-mono">
              <div>
                <span className="text-muted-foreground">kind:</span>{" "}
                {confirmJob.kind}
              </div>
              <div>
                <span className="text-muted-foreground">job_id:</span>{" "}
                {String(confirmJob.id)}
              </div>
              <div>
                <span className="text-muted-foreground">attempts:</span>{" "}
                {confirmJob.attempt_count}
              </div>
              <div className="break-words">
                <span className="text-muted-foreground">error:</span>{" "}
                {truncate(confirmJob.error_message, 240) || "(none)"}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmId(null)}
              disabled={resurrectingId === confirmId}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const id = confirmId;
                setConfirmId(null);
                onResurrect(id);
              }}
              disabled={resurrectingId === confirmId}
            >
              {resurrectingId === confirmId ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Resurrecting…
                </>
              ) : (
                <>
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Resurrect
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Alerts panel ────────────────────────────────────────────────────────────
function AlertsPanel({
  unfilledSlotEvents,
  bracketAnomalyEvents,
  projectsById,
}) {
  const navigate = useNavigate();

  const allAlerts = useMemo(() => {
    const out = [];
    for (const e of unfilledSlotEvents || []) {
      const slots = Array.isArray(e.payload?.unfilled_slots)
        ? e.payload.unfilled_slots
        : [];
      if (slots.length === 0) continue;
      out.push({
        key: `unfilled-${e.id}`,
        kind: "unfilled_slots",
        severity: "warning",
        label: `Mandatory slots unfilled: ${slots.slice(0, 3).join(", ")}${slots.length > 3 ? `+${slots.length - 3}` : ""}`,
        sub: `${slots.length} slot${slots.length === 1 ? "" : "s"} missing`,
        ts: e.created_at,
        project_id: e.project_id,
        round_id: e.round_id,
      });
    }
    for (const e of bracketAnomalyEvents || []) {
      const warnings = Array.isArray(e.payload?.warnings)
        ? e.payload.warnings
        : [];
      const anomalies = warnings.filter(
        (w) =>
          typeof w === "string" && w.toLowerCase().includes("bracket"),
      );
      if (anomalies.length === 0) continue;
      out.push({
        key: `bracket-${e.id}`,
        kind: "bracket_anomaly",
        severity: "warning",
        label: "Anomalous bracket count",
        sub: truncate(anomalies[0], 80),
        ts: e.created_at,
        project_id: e.project_id,
        round_id: e.round_id,
      });
    }
    out.sort(
      (a, b) =>
        new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime(),
    );
    return out;
  }, [unfilledSlotEvents, bracketAnomalyEvents]);

  const visible = allAlerts.slice(0, 8);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Alerts
          <span className="text-muted-foreground font-normal">
            ({allAlerts.length})
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {allAlerts.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-3 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            All clear — no unfilled mandatory slots or bracket anomalies in the
            last 24h.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {visible.map((a) => {
              const proj = projectsById?.get?.(a.project_id);
              const projName =
                proj?.title ||
                proj?.property_address ||
                (a.project_id
                  ? `Project ${String(a.project_id).slice(0, 8)}`
                  : "—");
              return (
                <li key={a.key}>
                  <button
                    onClick={() =>
                      a.project_id &&
                      navigate(
                        createPageUrl("ProjectDetails") +
                          `?id=${a.project_id}&tab=shortlisting${a.round_id ? `&round=${a.round_id}` : ""}`,
                      )
                    }
                    className="w-full text-left rounded border px-2 py-1.5 hover:bg-muted/40 flex items-start gap-2 text-xs"
                  >
                    <AlertTriangle className="h-3.5 w-3.5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{a.label}</p>
                      <p className="text-muted-foreground truncate">
                        {projName} · {a.sub} · {fmtTime(a.ts)}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
            {allAlerts.length > visible.length && (
              <li className="text-[11px] text-muted-foreground text-center pt-1">
                +{allAlerts.length - visible.length} more
              </li>
            )}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ── Recalibration insights ───────────────────────────────────────────────────
// Wave 6 P8: was a placeholder. Now wired to:
//   - shortlisting_benchmark_results (latest row → match rate vs 78% baseline)
//   - get_override_analytics (top 3 most-overridden signals from last 90 days)
// Empty state shown if either source has no data yet.
function RecalibrationPlaceholder() {
  const benchmarkQuery = useQuery({
    queryKey: ["shortlisting_benchmark_latest"],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingBenchmarkResult.list("-ran_at", 1);
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    staleTime: 60 * 1000,
  });

  const since90 = useMemo(
    () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
    [],
  );

  const signalsQuery = useQuery({
    queryKey: ["shortlisting_top_signals_overridden", since90],
    queryFn: async () => {
      const rows = await api.rpc("get_override_analytics", {
        p_since: since90,
        p_package_type: null,
        p_project_tier: null,
      });
      return (rows || [])
        .filter((r) => String(r.dimension).toLowerCase() === "signal")
        .sort((a, b) => Number(b.count) - Number(a.count))
        .slice(0, 3);
    },
    staleTime: 60 * 1000,
  });

  const bench = benchmarkQuery.data;
  const signals = signalsQuery.data || [];
  const hasData = bench != null || signals.length > 0;
  const matchRate = bench ? Number(bench.match_rate) : null;
  const baseline = bench ? Number(bench.baseline_match_rate || 0.78) : 0.78;
  const delta = matchRate != null ? matchRate - baseline : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4" />
          Recalibration insights
          <a
            href="/ShortlistingCalibration"
            className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline"
          >
            full view →
          </a>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!hasData ? (
          <div className="text-xs text-muted-foreground italic py-3 px-1">
            No data yet. Run a benchmark or accumulate override telemetry to populate.
          </div>
        ) : (
          <>
            {bench ? (
              <div className="rounded border p-2 text-xs space-y-1">
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">Latest match rate</span>
                  <span className="font-bold tabular-nums text-base">
                    {(matchRate * 100).toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-muted-foreground">vs baseline ({(baseline * 100).toFixed(0)}%)</span>
                  <span
                    className={cn(
                      "tabular-nums font-medium",
                      delta > 0 ? "text-emerald-600" : delta < 0 ? "text-red-600" : "",
                    )}
                  >
                    {delta >= 0 ? "+" : ""}
                    {(delta * 100).toFixed(1)} pp
                  </span>
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {bench.sample_size} rounds · {fmtTime(bench.ran_at)}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground italic">
                No benchmarks run yet.
              </div>
            )}

            {signals.length > 0 && (
              <div>
                <div className="text-[11px] text-muted-foreground mb-1.5 uppercase tracking-wide">
                  Top overridden signals (90d)
                </div>
                <ul className="space-y-1">
                  {signals.map((s) => (
                    <li
                      key={s.bucket}
                      className="flex items-center justify-between text-xs"
                    >
                      <span className="font-mono truncate" title={s.bucket}>
                        {s.bucket}
                      </span>
                      <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
                        {s.count} · {(Number(s.rate) * 100).toFixed(1)}%
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main page ───────────────────────────────────────────────────────────────
export default function ShortlistingCommandCenter() {
  const queryClient = useQueryClient();
  const { isAdminOrAbove } = usePermissions();
  const adminGateOpen = isAdminOrAbove === true;

  // ── Stats RPC ────────────────────────────────────────────────────────────
  const statsQuery = useQuery({
    queryKey: ["shortlisting_dashboard_stats"],
    queryFn: async () => {
      const rows = await api.rpc("get_shortlisting_dashboard_stats", {});
      return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    },
    staleTime: 15 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // ── Active rounds for kanban (last 30 days) ─────────────────────────────
  const roundsQuery = useQuery({
    queryKey: ["shortlisting_command_center_rounds"],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
      return await api.entities.ShortlistingRound.filter(
        { created_at: { $gte: since } },
        "-created_at",
        500,
      );
    },
    staleTime: 15 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // ── Project lookup map ──────────────────────────────────────────────────
  const projectIds = useMemo(() => {
    const set = new Set();
    for (const r of roundsQuery.data || [])
      if (r.project_id) set.add(r.project_id);
    return Array.from(set);
  }, [roundsQuery.data]);

  const projectsQuery = useQuery({
    queryKey: [
      "shortlisting_command_center_projects",
      projectIds.length,
      projectIds.slice(0, 3).join(","),
    ],
    queryFn: async () => {
      if (projectIds.length === 0) return [];
      return await api.entities.Project.filter(
        { id: { $in: projectIds } },
        null,
        500,
      );
    },
    enabled: adminGateOpen && projectIds.length > 0,
    staleTime: 60 * 1000,
  });

  const projectsById = useMemo(() => {
    const m = new Map();
    for (const p of projectsQuery.data || []) m.set(p.id, p);
    return m;
  }, [projectsQuery.data]);

  // ── Activity feed ────────────────────────────────────────────────────────
  const eventsSinceIso = useMemo(
    () =>
      new Date(
        Date.now() - ACTIVITY_WINDOW_HOURS * 3600 * 1000,
      ).toISOString(),
    [],
  );
  const eventsQuery = useQuery({
    queryKey: ["shortlisting_events_recent"],
    queryFn: () =>
      api.entities.ShortlistingEvent.filter(
        { created_at: { $gte: eventsSinceIso } },
        "-created_at",
        ACTIVITY_PAGE_SIZE,
      ),
    staleTime: 5 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // ── Alerts: derive from shortlisting_events with specific event_types ───
  // Read pass2_complete events for unfilled_slots — these are emitted at the
  // end of pass 2 with the list of mandatory slots that couldn't be filled.
  const unfilledSlotsQuery = useQuery({
    queryKey: ["shortlisting_unfilled_slots"],
    queryFn: () =>
      api.entities.ShortlistingEvent.filter(
        {
          event_type: "pass2_complete",
          created_at: { $gte: eventsSinceIso },
        },
        "-created_at",
        100,
      ),
    staleTime: 30 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // pass0_complete events carry validation warnings; we filter client-side for
  // bracket-count anomalies (the DB-side filter operators don't support
  // jsonb-array string-contains, so we over-fetch a small window and filter).
  const pass0Query = useQuery({
    queryKey: ["shortlisting_pass0_complete"],
    queryFn: () =>
      api.entities.ShortlistingEvent.filter(
        {
          event_type: "pass0_complete",
          created_at: { $gte: eventsSinceIso },
        },
        "-created_at",
        100,
      ),
    staleTime: 30 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // ── Dead-letter jobs ─────────────────────────────────────────────────────
  const deadLetterQuery = useQuery({
    queryKey: ["shortlisting_dead_letter_jobs"],
    queryFn: () =>
      api.rpc("get_shortlisting_dead_letter_jobs", { p_limit: 50 }),
    staleTime: 15 * 1000,
    refetchInterval: POLL_INTERVAL_MS,
    enabled: adminGateOpen,
  });

  // Resolve missing project ids referenced by dead-letter jobs (might point to
  // projects not currently in the rounds window).
  const deadLetterProjectIds = useMemo(() => {
    const have = new Set(projectIds);
    const extra = new Set();
    for (const j of deadLetterQuery.data || []) {
      if (j.project_id && !have.has(j.project_id)) extra.add(j.project_id);
    }
    return Array.from(extra);
  }, [deadLetterQuery.data, projectIds]);

  const deadLetterProjectsQuery = useQuery({
    queryKey: [
      "shortlisting_dead_letter_projects",
      deadLetterProjectIds.length,
      deadLetterProjectIds.slice(0, 3).join(","),
    ],
    queryFn: async () => {
      if (deadLetterProjectIds.length === 0) return [];
      return await api.entities.Project.filter(
        { id: { $in: deadLetterProjectIds } },
        null,
        100,
      );
    },
    enabled: adminGateOpen && deadLetterProjectIds.length > 0,
    staleTime: 60 * 1000,
  });

  const allProjectsById = useMemo(() => {
    const m = new Map(projectsById);
    for (const p of deadLetterProjectsQuery.data || []) m.set(p.id, p);
    return m;
  }, [projectsById, deadLetterProjectsQuery.data]);

  // ── Resurrect ────────────────────────────────────────────────────────────
  const [resurrectingId, setResurrectingId] = useState(null);
  const handleResurrect = useCallback(
    async (jobId) => {
      setResurrectingId(jobId);
      try {
        const result = await api.rpc("resurrect_shortlisting_dead_letter_job", {
          p_job_id: jobId,
        });
        // RPC returns jsonb — accept truthy { ok: true } shape OR a raw string.
        const ok =
          result && typeof result === "object"
            ? result.ok !== false
            : !!result;
        if (!ok) {
          throw new Error(
            (result && result.error) ||
              "Resurrect RPC returned a non-success response",
          );
        }
        toast.success("Job resurrected — re-queued for retry.");
        queryClient.invalidateQueries({
          queryKey: ["shortlisting_dead_letter_jobs"],
        });
        queryClient.invalidateQueries({
          queryKey: ["shortlisting_dashboard_stats"],
        });
      } catch (err) {
        toast.error(`Resurrect failed: ${err?.message || "unknown error"}`);
      } finally {
        setResurrectingId(null);
      }
    },
    [queryClient],
  );

  // ── Realtime invalidations (throttled per-key) ──────────────────────────
  // 30s polling already covers the quiet case; subscriptions just shorten the
  // window for visible state changes (a round flipping from processing →
  // proposed shows up in <1s instead of <30s).
  const INVALIDATE_WINDOW_MS = 2_000;
  const invalidateThrottleRef = useRef(new Map());
  const throttledInvalidate = useCallback(
    (keyArr) => {
      const keyStr = JSON.stringify(keyArr);
      const map = invalidateThrottleRef.current;
      const now = Date.now();
      const entry = map.get(keyStr) || { last: 0, timeout: null };
      const elapsed = now - entry.last;
      if (elapsed >= INVALIDATE_WINDOW_MS) {
        if (entry.timeout) {
          clearTimeout(entry.timeout);
          entry.timeout = null;
        }
        entry.last = now;
        map.set(keyStr, entry);
        queryClient.invalidateQueries({ queryKey: keyArr });
      } else if (!entry.timeout) {
        const remaining = INVALIDATE_WINDOW_MS - elapsed;
        entry.timeout = setTimeout(() => {
          entry.last = Date.now();
          entry.timeout = null;
          map.set(keyStr, entry);
          queryClient.invalidateQueries({ queryKey: keyArr });
        }, remaining);
        map.set(keyStr, entry);
      }
    },
    [queryClient],
  );

  useEffect(() => {
    if (!adminGateOpen) return;
    const unsubs = [];
    try {
      unsubs.push(
        api.entities.ShortlistingRound.subscribe(() => {
          throttledInvalidate(["shortlisting_command_center_rounds"]);
          throttledInvalidate(["shortlisting_dashboard_stats"]);
        }),
      );
    } catch (e) {
      console.warn("[ShortlistingCommandCenter] ShortlistingRound subscribe failed:", e);
    }
    try {
      unsubs.push(
        api.entities.ShortlistingEvent.subscribe(() => {
          throttledInvalidate(["shortlisting_events_recent"]);
          throttledInvalidate(["shortlisting_unfilled_slots"]);
          throttledInvalidate(["shortlisting_pass0_complete"]);
        }),
      );
    } catch (e) {
      console.warn("[ShortlistingCommandCenter] ShortlistingEvent subscribe failed:", e);
    }
    try {
      unsubs.push(
        api.entities.ShortlistingJob.subscribe(() => {
          throttledInvalidate(["shortlisting_dead_letter_jobs"]);
          throttledInvalidate(["shortlisting_dashboard_stats"]);
        }),
      );
    } catch (e) {
      console.warn("[ShortlistingCommandCenter] ShortlistingJob subscribe failed:", e);
    }
    return () => {
      for (const u of unsubs) {
        try {
          if (typeof u === "function") u();
        } catch {
          /* ignore */
        }
      }
      const map = invalidateThrottleRef.current;
      for (const [, entry] of map) {
        if (entry.timeout) clearTimeout(entry.timeout);
      }
      map.clear();
    };
  }, [adminGateOpen, throttledInvalidate]);

  // ── Refresh-all helper ───────────────────────────────────────────────────
  const refreshAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["shortlisting_dashboard_stats"] });
    queryClient.invalidateQueries({ queryKey: ["shortlisting_command_center_rounds"] });
    queryClient.invalidateQueries({ queryKey: ["shortlisting_events_recent"] });
    queryClient.invalidateQueries({ queryKey: ["shortlisting_dead_letter_jobs"] });
    queryClient.invalidateQueries({ queryKey: ["shortlisting_unfilled_slots"] });
    queryClient.invalidateQueries({ queryKey: ["shortlisting_pass0_complete"] });
  }, [queryClient]);

  // ── Defensive permission check (route guard handles this too) ───────────
  if (!isAdminOrAbove) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-8 max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">
            Access denied
          </h2>
          <p className="text-sm text-red-700 dark:text-red-300">
            The Shortlisting Command Center is restricted to admins.
          </p>
        </div>
      </div>
    );
  }

  const stats = statsQuery.data || {};
  const isLoadingStats = statsQuery.isLoading;

  return (
    <div className="p-4 md:p-6 max-w-[1400px] mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="h-9 w-9 rounded-lg bg-purple-500/10 flex items-center justify-center">
            <Sparkles className="h-5 w-5 text-purple-600 dark:text-purple-400" />
          </div>
          <div>
            <h1 className="text-xl font-semibold leading-none">
              Shortlisting Command Center
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Live engine ops + cost + dead-letter recovery
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refreshAll}
          className="text-xs"
        >
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Refresh
        </Button>
      </div>

      {/* Hero stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <StatCard
          icon={Sparkles}
          tone="bg-purple-500/15 text-purple-600 dark:text-purple-400"
          label="Today's rounds"
          value={isLoadingStats ? "…" : num(stats.rounds_today, 0)}
          hint={
            !isLoadingStats && stats.rounds_delivered_today != null
              ? `${num(stats.rounds_delivered_today, 0)} delivered`
              : null
          }
        />
        <StatCard
          icon={Activity}
          tone="bg-blue-500/15 text-blue-600 dark:text-blue-400"
          label="Active processing"
          value={isLoadingStats ? "…" : num(stats.rounds_processing, 0)}
          hint={
            !isLoadingStats && stats.rounds_proposed != null
              ? `${num(stats.rounds_proposed, 0)} proposed · ${num(stats.rounds_locked, 0)} locked`
              : null
          }
        />
        <StatCard
          icon={ListChecks}
          tone="bg-amber-500/15 text-amber-600 dark:text-amber-400"
          label="Pending jobs"
          value={isLoadingStats ? "…" : num(stats.jobs_pending, 0)}
          hint={
            !isLoadingStats && stats.jobs_running != null
              ? `${num(stats.jobs_running, 0)} running`
              : null
          }
        />
        <StatCard
          icon={AlertCircle}
          tone="bg-red-500/15 text-red-600 dark:text-red-400"
          label="Dead-letter"
          value={isLoadingStats ? "…" : num(stats.jobs_dead_letter, 0)}
          hint={
            !isLoadingStats && stats.jobs_failed_24h != null
              ? `${num(stats.jobs_failed_24h, 0)} failed 24h`
              : null
          }
        />
        <StatCard
          icon={DollarSign}
          tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
          label="Cost today"
          value={
            isLoadingStats
              ? "…"
              : fmtCost(stats.total_cost_today_usd ?? 0)
          }
          hint="USD spend"
        />
        <StatCard
          icon={TimerReset}
          tone="bg-slate-500/15 text-slate-600 dark:text-slate-400"
          label="Median duration"
          value={
            isLoadingStats
              ? "…"
              : fmtSeconds(stats.median_round_duration_seconds)
          }
          hint="round end-to-end"
        />
      </div>

      {statsQuery.error && (
        <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5" />
          <div>
            <p className="font-medium">Failed to load stats</p>
            <p>{statsQuery.error.message || "Unknown error"}</p>
          </div>
        </div>
      )}

      {/* Pipeline kanban */}
      {roundsQuery.isLoading ? (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-2 animate-pulse">
              <div className="h-4 bg-muted rounded w-1/4" />
              <div className="grid grid-cols-4 gap-2">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className="h-32 bg-muted/60 rounded" />
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      ) : roundsQuery.error ? (
        <Card>
          <CardContent className="p-4 text-xs text-red-600">
            Failed to load rounds: {roundsQuery.error.message}
          </CardContent>
        </Card>
      ) : (
        <PipelineKanban
          rounds={roundsQuery.data || []}
          projectsById={allProjectsById}
        />
      )}

      {/* Activity + Alerts side by side on wide */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-4">
        <ActivityFeed
          events={eventsQuery.data || []}
          projectsById={allProjectsById}
          isLoading={eventsQuery.isLoading}
          isFetching={eventsQuery.isFetching}
          onRefresh={() =>
            queryClient.invalidateQueries({
              queryKey: ["shortlisting_events_recent"],
            })
          }
        />
        <div className="space-y-4">
          <AlertsPanel
            unfilledSlotEvents={unfilledSlotsQuery.data || []}
            bracketAnomalyEvents={pass0Query.data || []}
            projectsById={allProjectsById}
          />
          <RecalibrationPlaceholder />
        </div>
      </div>

      {/* Dead-letter section */}
      <DeadLetterSection
        jobs={deadLetterQuery.data || []}
        projectsById={allProjectsById}
        isLoading={deadLetterQuery.isLoading}
        isFetching={deadLetterQuery.isFetching}
        onResurrect={handleResurrect}
        resurrectingId={resurrectingId}
      />
    </div>
  );
}

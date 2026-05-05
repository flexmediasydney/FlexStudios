/**
 * DispatcherPanel — Wave 11.6 / Wave 2B operator visibility.
 *
 * Sits below ShapeDEngineBanner on the round detail page (wired via
 * ShortlistingSwimlane.jsx). Shows the dispatcher state for the current
 * project so operators can see WHEN the next tick will fire and WHAT is
 * in flight, without needing to jq the edge_fn_call_audit table.
 *
 * Sections:
 *   1. Countdown header   "Next dispatcher tick in 0:42"
 *      — re-renders every second using a 1Hz setInterval
 *      — countdown is computed locally from `next_dispatcher_tick_iso`
 *        returned by list-project-jobs; we do NOT re-fetch every second.
 *   2. Active jobs list
 *      — kind badge, status pill, scheduled-in / running-for, attempt counter
 *      — "Force run now" button per pending row, master_admin only
 *   3. Recent jobs (collapsible)
 *      — last 30 min of terminal rows, success/fail counts at top
 *   4. Stage timeline mini-viz
 *      — horizontal segmented bar showing Shape D pipeline progress
 *        (ingest → extract → pass0 → shape_d_stage1 → stage4_synthesis → pass3)
 *      — green=succeeded, amber=running, blue=pending, red=failed, gray=untouched
 *
 * Refresh strategy:
 *   - Jobs poll: every 5 seconds (refetchInterval)
 *   - Countdown: every 1 second (local interval, no network)
 *   - Manual refresh button calls invalidateQueries
 *   - Polling auto-stops when component unmounts
 *
 * Spec: W11.6 Wave 2B — operator UX gap audit (defect class: dispatcher
 * opacity). The 60s cron tick + 2h ingest debounce window were the two
 * leading sources of "is anything actually happening?" support pings.
 *
 * Backend:
 *   - list-project-jobs (read; master_admin/admin/manager)
 *   - force-run-now    (mutate; master_admin only — UI button hidden otherwise)
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useVisibleInterval } from "@/components/hooks/useVisibleInterval";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Clock,
  Loader2,
  PlayCircle,
  RefreshCw,
  Activity,
  CheckCircle2,
  XCircle,
  Hourglass,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

// ─── Constants ──────────────────────────────────────────────────────────────

// Stages we visualise in the mini-timeline. Ordering reflects the canonical
// Shape D pipeline so the strip reads left→right as "first run → last run".
const TIMELINE_STAGES = [
  { kind: "ingest", label: "Ingest" },
  { kind: "extract", label: "Extract" },
  { kind: "pass0", label: "Pass 0" },
  { kind: "shape_d_stage1", label: "Stage 1" },
  { kind: "stage4_synthesis", label: "Stage 4" },
  { kind: "pass3", label: "Pass 3" },
];

const KIND_LABEL = {
  ingest: "Ingest",
  extract: "Extract",
  pass0: "Pass 0",
  pass3: "Pass 3",
  shape_d_stage1: "Shape D · Stage 1",
  stage4_synthesis: "Shape D · Stage 4",
  render_preview: "Render preview",
};

const STATUS_TONE = {
  pending: "bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300",
  running:
    "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300",
  succeeded:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300",
  dead_letter:
    "bg-red-200 text-red-900 dark:bg-red-950/70 dark:text-red-200",
};

const STATUS_LABEL = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  dead_letter: "Dead-letter",
};

// Stage cell tones for the mini-timeline.
const TIMELINE_TONE = {
  succeeded:
    "bg-emerald-500 dark:bg-emerald-500 text-white border-emerald-600",
  running: "bg-amber-400 dark:bg-amber-500 text-white border-amber-500 animate-pulse",
  pending: "bg-blue-300 dark:bg-blue-700 text-white border-blue-400",
  failed: "bg-red-500 dark:bg-red-600 text-white border-red-600",
  dead_letter: "bg-red-600 dark:bg-red-700 text-white border-red-700",
  none: "bg-slate-100 dark:bg-slate-800 text-slate-400 border-slate-200 dark:border-slate-700",
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Format a number of seconds as `m:ss` (pads seconds to 2 digits). Negative
 * inputs render as `0:00` because a "due NOW" countdown should hold at zero
 * rather than flicker to "-0:01" between ticks.
 */
function formatMmSs(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

/** Friendly `Xs / Xm Ys` for wall durations. Returns "—" for null/invalid. */
function formatDuration(seconds) {
  if (seconds == null || !isFinite(Number(seconds))) return "—";
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}h ${rm}m` : `${h}h`;
}

/**
 * Compute "scheduled in" relative to a reference time. Returns:
 *   - "in 1m 23s"  when due in the future
 *   - "due now"    when within ±1s
 *   - "overdue 5s" when past
 */
function formatScheduledIn(scheduledIso, refTime) {
  if (!scheduledIso) return "—";
  const t = Date.parse(scheduledIso);
  if (!isFinite(t)) return "—";
  const diffSec = Math.round((t - refTime) / 1000);
  if (Math.abs(diffSec) <= 1) return "due now";
  if (diffSec > 0) return `in ${formatDuration(diffSec)}`;
  return `overdue ${formatDuration(-diffSec)}`;
}

/**
 * Build the timeline row state from the latest job per kind. We dedupe on
 * `kind` and prefer the most recent row (succeeded > running > pending >
 * failed in tiebreakers — but in practice we just take the freshest by
 * finished_at|started_at|scheduled_for).
 */
function buildTimelineState(jobs) {
  const byKind = new Map();
  const ts = (j) =>
    Date.parse(j.finished_at || j.started_at || j.scheduled_for || 0) || 0;
  for (const j of jobs) {
    const prior = byKind.get(j.kind);
    if (!prior || ts(j) > ts(prior)) byKind.set(j.kind, j);
  }
  return TIMELINE_STAGES.map((stage) => {
    const job = byKind.get(stage.kind);
    return {
      ...stage,
      job: job || null,
      tone: job ? TIMELINE_TONE[job.status] || TIMELINE_TONE.none : TIMELINE_TONE.none,
    };
  });
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function DispatcherPanel({ projectId, roundId }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions();
  const [recentExpanded, setRecentExpanded] = useState(false);
  // Local ticker state — incremented every second to force the countdown
  // header + "running for" durations to re-render. Holds nothing else.
  const [, setTick] = useState(0);

  // 1Hz tick — paused when the tab is hidden so the dispatcher panel doesn't
  // burn CPU on a backgrounded tab. The shortlisting subtab never unmounts
  // once opened (mountedTabs is sticky), so visibility-pausing is the only
  // way to stop this ticker for the remainder of the session.
  const onTick = useCallback(() => setTick((t) => (t + 1) % 1_000_000), []);
  useVisibleInterval(onTick, 1000);

  // Jobs query — auto-refetch every 5s while mounted.
  const jobsQuery = useQuery({
    queryKey: ["dispatcher-panel-jobs", projectId, roundId],
    queryFn: async () => {
      const result = await api.functions.invoke("list-project-jobs", {
        project_id: projectId,
        round_id: roundId,
        since_minutes: 30,
      });
      // Edge fn returns { ok, jobs, ... } directly; supabase-js wraps it in `data`.
      if (result?.error) {
        throw new Error(result.error.message || "list-project-jobs failed");
      }
      return result?.data ?? result;
    },
    enabled: Boolean(projectId || roundId),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
  });

  // Force-run mutation. Optimistic UI: button label flips to "Forcing…",
  // refresh queries on success. Master_admin gated server-side too.
  const forceRunMutation = useMutation({
    mutationFn: async (jobId) => {
      const result = await api.functions.invoke("force-run-now", {
        job_id: jobId,
      });
      if (result?.error) {
        throw new Error(
          result.error.message || result.error.body?.error || "force-run failed",
        );
      }
      return result?.data ?? result;
    },
    onSuccess: (data) => {
      toast.success(
        `Job pulled forward — next dispatcher tick will pick it up`,
      );
      queryClient.invalidateQueries({
        queryKey: ["dispatcher-panel-jobs", projectId, roundId],
      });
    },
    onError: (err) => {
      toast.error(`Force-run failed: ${err?.message || err}`);
    },
  });

  // Derived data for rendering. Memoised on data only — the 1Hz ticker
  // re-renders the parent but the derived sets stay stable.
  const data = jobsQuery.data;
  const jobs = useMemo(() => (data?.jobs || []), [data?.jobs]);
  const activeJobs = useMemo(
    () => jobs.filter((j) => j.status === "pending" || j.status === "running"),
    [jobs],
  );
  const recentJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.status === "succeeded" ||
          j.status === "failed" ||
          j.status === "dead_letter",
      ),
    [jobs],
  );
  const timelineState = useMemo(() => buildTimelineState(jobs), [jobs]);

  // Countdown derivation. We rely on the locally-stored `tick` so this
  // re-runs every second; the actual math is `nextTick - clientNow`. We
  // adjust for clock skew by using server_time_iso only as a sanity check
  // — the dispatcher cron runs on Supabase clock, but the tick header is
  // an estimate so client clock is fine (±1-2s tolerable for a UX hint).
  const nextTickIso = data?.next_dispatcher_tick_iso || null;
  const nowMs = Date.now();
  const secondsUntilTick = nextTickIso
    ? Math.round((Date.parse(nextTickIso) - nowMs) / 1000)
    : null;

  if (!projectId && !roundId) return null;

  const isLoading = jobsQuery.isLoading && !data;
  const isError = jobsQuery.isError;

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/40 p-3 space-y-3">
      {/* Header: countdown + status summary + manual refresh */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <Activity className="h-4 w-4 text-slate-600 dark:text-slate-300" />
          <span className="text-sm font-medium">Dispatcher</span>
          {nextTickIso ? (
            <span
              className="text-xs text-muted-foreground flex items-center gap-1"
              title={`Cron tick fires every minute. Next: ${new Date(nextTickIso).toLocaleTimeString()}`}
            >
              <Clock className="h-3 w-3" />
              Next tick in{" "}
              <span className="font-mono font-medium text-foreground tabular-nums">
                {formatMmSs(secondsUntilTick)}
              </span>
            </span>
          ) : null}
          {data?.active_count != null && (
            <Badge variant="secondary" className="text-[10px] h-5">
              {data.active_count} active
            </Badge>
          )}
          {data?.succeeded_count > 0 && (
            <Badge
              className={cn(
                "text-[10px] h-5",
                "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300",
              )}
            >
              {data.succeeded_count} ok / {data.since_minutes}m
            </Badge>
          )}
          {data?.failed_count > 0 && (
            <Badge variant="destructive" className="text-[10px] h-5">
              {data.failed_count} failed / {data.since_minutes}m
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 text-xs"
          onClick={() =>
            queryClient.invalidateQueries({
              queryKey: ["dispatcher-panel-jobs", projectId, roundId],
            })
          }
          disabled={jobsQuery.isFetching}
          title="Refresh now"
        >
          {jobsQuery.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Error state */}
      {isError && (
        <div className="flex items-center gap-2 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded px-2 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="flex-1">
            Couldn't load dispatcher state: {jobsQuery.error?.message || "unknown error"}
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-xs"
            onClick={() => jobsQuery.refetch()}
          >
            Retry
          </Button>
        </div>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Loading dispatcher state…
        </div>
      )}

      {/* Stage timeline mini-viz — only render when we have data */}
      {!isLoading && !isError && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
            Pipeline timeline
          </div>
          <div className="flex items-center gap-1 overflow-x-auto">
            {timelineState.map((stage, i) => (
              <div
                key={stage.kind}
                className="flex items-center gap-1 flex-shrink-0"
              >
                <div
                  className={cn(
                    "h-7 px-2 rounded border flex items-center text-[10px] font-medium whitespace-nowrap",
                    stage.tone,
                  )}
                  title={
                    stage.job
                      ? `${stage.label} · ${STATUS_LABEL[stage.job.status] || stage.job.status}` +
                        (stage.job.wall_seconds != null
                          ? ` · ${formatDuration(stage.job.wall_seconds)}`
                          : "") +
                        (stage.job.attempt_count > 0
                          ? ` · attempt ${stage.job.attempt_count}/${stage.job.max_attempts}`
                          : "")
                      : `${stage.label} · not yet enqueued`
                  }
                >
                  {stage.label}
                  {stage.job?.status === "succeeded" && (
                    <CheckCircle2 className="h-3 w-3 ml-1" />
                  )}
                  {stage.job?.status === "failed" && (
                    <XCircle className="h-3 w-3 ml-1" />
                  )}
                  {stage.job?.status === "running" && (
                    <Loader2 className="h-3 w-3 ml-1 animate-spin" />
                  )}
                  {stage.job?.status === "pending" && (
                    <Hourglass className="h-3 w-3 ml-1" />
                  )}
                </div>
                {i < timelineState.length - 1 && (
                  <div className="h-px w-2 bg-slate-200 dark:bg-slate-700 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Active jobs list */}
      {!isLoading && !isError && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">
            Active jobs ({activeJobs.length})
          </div>
          {activeJobs.length === 0 ? (
            <EmptyActiveJobs recentJobs={recentJobs} />
          ) : (
            <ul className="space-y-1">
              {activeJobs.map((job) => (
                <ActiveJobRow
                  key={job.id}
                  job={job}
                  nowMs={nowMs}
                  isMasterAdmin={isMasterAdmin}
                  onForceRun={forceRunMutation.mutate}
                  isForcing={
                    forceRunMutation.isPending &&
                    forceRunMutation.variables === job.id
                  }
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Recent jobs (collapsible) */}
      {!isLoading && !isError && recentJobs.length > 0 && (
        <div>
          <button
            type="button"
            className="flex items-center gap-1 text-[10px] text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors"
            onClick={() => setRecentExpanded((s) => !s)}
            aria-expanded={recentExpanded}
            aria-controls="dispatcher-panel-recent-list"
          >
            {recentExpanded ? (
              <ChevronDown className="h-3 w-3" />
            ) : (
              <ChevronRight className="h-3 w-3" />
            )}
            Recent ({recentJobs.length}, last {data?.since_minutes ?? 30}m)
          </button>
          {recentExpanded && (
            <ul
              id="dispatcher-panel-recent-list"
              className="space-y-1 mt-1 max-h-64 overflow-y-auto"
            >
              {recentJobs.map((job) => (
                <RecentJobRow key={job.id} job={job} />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function EmptyActiveJobs({ recentJobs }) {
  // Find the most recent terminal job to render "Last run X min ago".
  const last = recentJobs[0];
  if (!last) {
    return (
      <div className="text-xs text-muted-foreground italic">
        No active jobs · No recent activity in the last window
      </div>
    );
  }
  const finishedAt = last.finished_at ? Date.parse(last.finished_at) : null;
  const diffSec = finishedAt ? Math.round((Date.now() - finishedAt) / 1000) : null;
  const ago = diffSec != null ? formatDuration(diffSec) : "—";
  return (
    <div className="text-xs text-muted-foreground italic">
      No active jobs · Last run{" "}
      <span className="not-italic font-medium text-foreground">
        {KIND_LABEL[last.kind] || last.kind}
      </span>{" "}
      {ago} ago ({STATUS_LABEL[last.status] || last.status})
    </div>
  );
}

function ActiveJobRow({ job, nowMs, isMasterAdmin, onForceRun, isForcing }) {
  const isPending = job.status === "pending";
  const isRunning = job.status === "running";

  const wall = isRunning
    ? Math.round(
        (nowMs - (Date.parse(job.started_at) || nowMs)) / 1000,
      )
    : job.wall_seconds;

  return (
    <li className="flex items-center gap-2 flex-wrap text-xs bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded px-2 py-1.5">
      <Badge
        variant="outline"
        className="text-[10px] h-5 font-mono"
        title={`kind=${job.kind}`}
      >
        {KIND_LABEL[job.kind] || job.kind}
      </Badge>
      <Badge
        className={cn(
          "text-[10px] h-5",
          STATUS_TONE[job.status] || STATUS_TONE.pending,
        )}
      >
        {isRunning && <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />}
        {STATUS_LABEL[job.status] || job.status}
      </Badge>
      <span className="text-muted-foreground tabular-nums">
        {isPending && (
          <>scheduled {formatScheduledIn(job.scheduled_for, nowMs)}</>
        )}
        {isRunning && (
          <>
            running{" "}
            <span className="font-medium text-foreground">
              {formatDuration(wall)}
            </span>
          </>
        )}
      </span>
      {job.attempt_count > 0 && (
        <span className="text-[10px] text-muted-foreground">
          attempt {job.attempt_count}/{job.max_attempts}
        </span>
      )}
      {job.error_message_short && (
        <span
          className="text-[10px] text-red-700 dark:text-red-300 truncate max-w-[40ch]"
          title={job.error_message_short}
        >
          ⚠ {job.error_message_short}
        </span>
      )}
      <span className="flex-1" />
      {isMasterAdmin && isPending && (
        <Button
          size="sm"
          variant="outline"
          className="h-6 text-[10px] px-2"
          onClick={() => onForceRun(job.id)}
          disabled={isForcing}
          title="Pull scheduled_for to NOW so the next dispatcher tick picks it up"
        >
          {isForcing ? (
            <>
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              Forcing…
            </>
          ) : (
            <>
              <PlayCircle className="h-3 w-3 mr-1" />
              Force run now
            </>
          )}
        </Button>
      )}
    </li>
  );
}

function RecentJobRow({ job }) {
  const finishedAt = job.finished_at ? new Date(job.finished_at) : null;
  return (
    <li className="flex items-center gap-2 flex-wrap text-xs bg-slate-50 dark:bg-slate-900/40 border border-slate-200 dark:border-slate-800 rounded px-2 py-1">
      <Badge
        variant="outline"
        className="text-[10px] h-5 font-mono"
        title={`kind=${job.kind}`}
      >
        {KIND_LABEL[job.kind] || job.kind}
      </Badge>
      <Badge
        className={cn(
          "text-[10px] h-5",
          STATUS_TONE[job.status] || STATUS_TONE.pending,
        )}
      >
        {STATUS_LABEL[job.status] || job.status}
      </Badge>
      <span className="text-muted-foreground tabular-nums">
        {formatDuration(job.wall_seconds)}
      </span>
      {finishedAt && (
        <span
          className="text-[10px] text-muted-foreground"
          title={finishedAt.toLocaleString()}
        >
          {finishedAt.toLocaleTimeString()}
        </span>
      )}
      {job.attempt_count > 0 && (
        <span className="text-[10px] text-muted-foreground">
          attempt {job.attempt_count}/{job.max_attempts}
        </span>
      )}
      {job.error_message_short && (
        <span
          className="text-[10px] text-red-700 dark:text-red-300 truncate max-w-[40ch]"
          title={job.error_message_short}
        >
          ⚠ {job.error_message_short}
        </span>
      )}
    </li>
  );
}

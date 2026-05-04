/**
 * ActiveEngineRunsWidget — Pipeline card with three swimlanes.
 *
 * Surfaces the engine chain that runs *after* a pending ingest fires.
 * Joseph asked for swimlane organisation: Queued / Running / Recently
 * finished, so the eye scans the pipeline left-to-right rather than
 * hunting through one mixed-status list.
 *
 * Lanes:
 *   - Queued            — status='pending', any chain kind except ingest
 *   - Running           — status='running'
 *   - Recently finished — status IN ('succeeded','failed','dead_letter')
 *                         AND finished_at within the last 60 minutes
 *
 * Chain kinds (left-to-right canonical order):
 *   extract → pass0 → shape_d_stage1 → detect_instances → stage4_synthesis
 *
 * Per-row payload:
 *   - Property address + suburb (cross-project surface only)
 *   - Kind chip with chain-position color
 *   - Status indicator with colour-coded tone
 *   - Wall time (running: current; terminal: total)
 *   - Error preview when failed
 *
 * Two surfaces:
 *   - Settings → Shortlisting Command Center → Overview (no projectId prop)
 *   - Per-project ProjectShortlistingTab (projectId prop filters)
 */
import React, { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Activity,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Clock,
  XCircle,
  Skull,
} from "lucide-react";

const POLL_INTERVAL_MS = 15_000;

/** Chain kinds the widget surfaces. extract = the per-image dropbox extract
 *  fan-out. We deliberately exclude 'ingest' (the PendingIngestsWidget owns
 *  it) and 'render_preview' / 'canonical_rollup' / 'pulse_*' (peripheral). */
const ENGINE_CHAIN_KINDS = [
  "extract",
  "pass0",
  "shape_d_stage1",
  "detect_instances",
  "stage4_synthesis",
];

/** Pretty labels + chain-position colors. */
const KIND_META = {
  extract: { label: "Extract", colorClass: "bg-slate-100 text-slate-700" },
  pass0: { label: "Pass 0", colorClass: "bg-cyan-50 text-cyan-700 dark:bg-cyan-950/40" },
  shape_d_stage1: {
    label: "Stage 1 vision",
    colorClass: "bg-blue-50 text-blue-700 dark:bg-blue-950/40",
  },
  detect_instances: {
    label: "Instance clustering",
    colorClass: "bg-violet-50 text-violet-700 dark:bg-violet-950/40",
  },
  stage4_synthesis: {
    label: "Stage 4 synthesis",
    colorClass: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40",
  },
};

const STATUS_META = {
  pending: { label: "Pending", icon: Clock, tone: "text-muted-foreground" },
  running: { label: "Running", icon: Loader2, tone: "text-blue-600", spin: true },
  succeeded: { label: "Succeeded", icon: CheckCircle2, tone: "text-emerald-600" },
  failed: { label: "Failed", icon: XCircle, tone: "text-amber-700" },
  dead_letter: { label: "Dead-letter", icon: Skull, tone: "text-red-600" },
};

/** Format ms-difference as `Hh Mm Ss` / `Mm Ss` / `Ss`. */
function formatWall(ms) {
  if (ms == null || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

function formatAgo(ms) {
  if (ms < 0) return "soon";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

/**
 * @param {object} props
 * @param {string=} props.projectId
 * @param {boolean=} props.compact
 */
export default function ActiveEngineRunsWidget({ projectId, compact = false }) {
  const qc = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick the local clock for live wall-time on running jobs.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const queryKey = useMemo(
    () => ["active-engine-runs", projectId ?? "all"],
    [projectId],
  );

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      // Cutoff: 60 min ago, applied below to terminal rows.
      const cutoffIso = new Date(Date.now() - 60 * 60_000).toISOString();
      let q = supabase
        .from("shortlisting_jobs")
        .select(
          "id, project_id, kind, status, started_at, finished_at, " +
            "attempt_count, error_message, payload, result, round_id, " +
            "project:projects(id, property_address, property_suburb)",
        )
        .in("kind", ENGINE_CHAIN_KINDS)
        .or(
          `status.eq.pending,status.eq.running,and(status.in.(succeeded,failed,dead_letter),finished_at.gte.${cutoffIso})`,
        )
        .order("updated_at", { ascending: false })
        // Bumped 50 → 250 (2026-05-03): a large round (e.g. 46 Brays at 58
        // chunks) plus a few in-flight downstream stages can easily exceed
        // 50 rows. UI was capping the running-lane at 50 and silently
        // hiding the rest, which made operators think jobs were missing.
        .limit(250);
      if (projectId) q = q.eq("project_id", projectId);
      const { data: rows, error: err } = await q;
      if (err) throw err;
      return Array.isArray(rows) ? rows : [];
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 5_000,
  });

  const rows = Array.isArray(data) ? data : [];

  // Split into three swimlanes; sort each by recency (running → started_at,
  // queued → scheduled_for-ish via updated_at, finished → finished_at).
  const queued = rows
    .filter((r) => r.status === "pending")
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() -
        new Date(a.created_at ?? 0).getTime(),
    );
  const running = rows
    .filter((r) => r.status === "running")
    .sort(
      (a, b) =>
        new Date(b.started_at ?? 0).getTime() -
        new Date(a.started_at ?? 0).getTime(),
    );
  const finished = rows
    .filter((r) =>
      ["succeeded", "failed", "dead_letter"].includes(r.status),
    )
    .sort(
      (a, b) =>
        new Date(b.finished_at ?? 0).getTime() -
        new Date(a.finished_at ?? 0).getTime(),
    );

  /**
   * Build a per-row subtitle that gives operators meaningful context about
   * what each engine job is actually processing.  Extract chunks get the
   * heaviest treatment (29+ rows for a 575-file round are otherwise
   * indistinguishable):
   *
   *   "Chunk 5/29 · 20 files · 034A8375 → 034A8395"
   *
   * For terminal extract rows we also show the per-file outcome:
   *
   *   "Chunk 5/29 · 18/20 ok · 034A8375 → 034A8395"
   *
   * Other engine kinds (pass0, shape_d_stage1, etc.) have one row per
   * round so their context is the round itself — we surface a short
   * round_id chip and any size hint we can extract from payload.
   */
  function buildContextSubtitle(row) {
    const payload = (row.payload || {}) ;
    const result = (row.result || {});
    if (row.kind === "extract") {
      const filePaths = Array.isArray(payload.file_paths) ? payload.file_paths : [];
      const chunkIdx = typeof payload.chunk_index === "number" ? payload.chunk_index : null;
      const chunkTotal = typeof payload.chunk_total === "number" ? payload.chunk_total : null;
      const stems = filePaths.map((p) => {
        const last = String(p).split("/").pop() || "";
        return last.replace(/\.[a-z0-9]+$/i, "");
      });
      const stemFirst = stems[0] || "";
      const stemLast = stems[stems.length - 1] || "";
      const parts = [];
      if (chunkIdx != null && chunkTotal != null) {
        parts.push(`Chunk ${chunkIdx + 1}/${chunkTotal}`);
      }
      // Per-file outcome on terminal rows
      if (
        ["succeeded", "failed", "dead_letter"].includes(row.status) &&
        (typeof result?.files_succeeded === "number" || typeof result?.modal_response?.files_succeeded === "number")
      ) {
        const succ = typeof result?.files_succeeded === "number"
          ? result.files_succeeded
          : result?.modal_response?.files_succeeded ?? 0;
        const total = typeof result?.files_processed === "number"
          ? result.files_processed
          : result?.modal_response?.files_total ?? filePaths.length;
        parts.push(`${succ}/${total} ok`);
      } else if (filePaths.length > 0) {
        parts.push(`${filePaths.length} files`);
      }
      // Stem range — only show when both ends exist and they differ
      if (stemFirst && stemLast && stemFirst !== stemLast) {
        parts.push(`${stemFirst} → ${stemLast}`);
      } else if (stemFirst) {
        parts.push(stemFirst);
      }
      return parts.length > 0 ? parts.join(" · ") : null;
    }
    // Non-extract kinds (pass0, shape_d_stage1, etc.) — one row per round.
    // Show the round id tail so operators can correlate across multi-round
    // pipelines, and any size hint from the payload.
    const roundTail = row.round_id ? String(row.round_id).slice(0, 8) : null;
    const fileCount = typeof payload.file_count === "number" ? payload.file_count : null;
    const groupCount = typeof payload.group_count === "number" ? payload.group_count : null;
    const parts = [];
    if (roundTail) parts.push(`Round ${roundTail}`);
    if (groupCount != null) parts.push(`${groupCount} groups`);
    else if (fileCount != null) parts.push(`${fileCount} files`);
    return parts.length > 0 ? parts.join(" · ") : null;
  }

  function renderRow(row) {
    const startedMs = row.started_at
      ? new Date(row.started_at).getTime()
      : null;
    const finishedMs = row.finished_at
      ? new Date(row.finished_at).getTime()
      : null;
    const wallMs =
      row.status === "running" && startedMs != null
        ? nowMs - startedMs
        : startedMs != null && finishedMs != null
          ? finishedMs - startedMs
          : null;
    const ageMs = finishedMs != null ? nowMs - finishedMs : null;
    const kindMeta =
      KIND_META[row.kind] || {
        label: row.kind,
        colorClass: "bg-muted text-muted-foreground",
      };
    const statusMeta = STATUS_META[row.status] || STATUS_META.pending;
    const StatusIcon = statusMeta.icon;
    const address = row?.project?.property_address ?? "(unknown)";
    const isFailed =
      row.status === "failed" || row.status === "dead_letter";

    return (
      <div
        key={row.id}
        className={`rounded border px-2 py-1.5 text-xs ${
          isFailed
            ? "border-amber-200 bg-amber-50/40 dark:bg-amber-950/30"
            : row.status === "running"
              ? "border-blue-200 bg-blue-50/40 dark:bg-blue-950/30"
              : "border-border/60 bg-background/40"
        }`}
        data-testid={`active-engine-runs-row-${row.id}`}
      >
        <div className="grid grid-cols-12 gap-2 items-center">
          {!projectId && (
            <div
              className="col-span-5 truncate font-medium"
              title={address}
            >
              {address}
            </div>
          )}
          <div className={projectId ? "col-span-4" : "col-span-3"}>
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-mono ${kindMeta.colorClass}`}
            >
              {kindMeta.label}
            </span>
          </div>
          <div
            className={
              projectId
                ? "col-span-3 inline-flex items-center gap-1"
                : "col-span-2 inline-flex items-center gap-1"
            }
          >
            <StatusIcon
              className={`h-3 w-3 ${statusMeta.tone} ${
                statusMeta.spin ? "animate-spin" : ""
              }`}
            />
            <span className={statusMeta.tone}>{statusMeta.label}</span>
            {row.attempt_count > 1 && (
              <span className="text-[10px] text-muted-foreground">
                (try {row.attempt_count})
              </span>
            )}
          </div>
          <div
            className={
              projectId
                ? "col-span-5 text-right font-mono tabular-nums"
                : "col-span-2 text-right font-mono tabular-nums"
            }
          >
            {row.status === "running" ? (
              <span title="wall time so far">
                {formatWall(wallMs)} elapsed
              </span>
            ) : row.status === "pending" ? (
              <span className="text-muted-foreground">queued</span>
            ) : finishedMs != null ? (
              <span
                title={`wall ${formatWall(wallMs)} · finished ${new Date(finishedMs).toISOString()}`}
              >
                {formatWall(wallMs)} · {formatAgo(ageMs)}
              </span>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </div>
        </div>
        {(() => {
          const subtitle = buildContextSubtitle(row);
          return subtitle ? (
            <div className="mt-0.5 text-[10px] text-muted-foreground/80 font-mono truncate" title={subtitle}>
              {subtitle}
            </div>
          ) : null;
        })()}
        {isFailed && row.error_message && (
          <div className="mt-1 text-[10px] text-amber-800 dark:text-amber-300 truncate font-mono">
            {row.error_message}
          </div>
        )}
      </div>
    );
  }

  function Lane({ title, rows: laneRows, badgeTone, emptyHint, testId }) {
    return (
      <div className="space-y-1.5" data-testid={testId}>
        <div className="flex items-center gap-2">
          <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </h4>
          <Badge
            variant="outline"
            className={`text-[10px] px-1.5 py-0 ${badgeTone}`}
          >
            {laneRows.length}
          </Badge>
        </div>
        {laneRows.length === 0 ? (
          <div className="text-[11px] text-muted-foreground italic px-2 py-1.5 rounded border border-dashed border-border/60">
            {emptyHint}
          </div>
        ) : (
          <div className="space-y-1">
            {laneRows.map(renderRow)}
          </div>
        )}
      </div>
    );
  }

  return (
    <Card data-testid="active-engine-runs-widget">
      <CardContent className="p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600" />
            <h3 className="text-sm font-semibold">Engine pipeline</h3>
            {!isLoading && (
              <>
                <Badge
                  variant="secondary"
                  className="text-[10px] px-1.5 py-0"
                  title="Total surfaced rows"
                >
                  {rows.length}
                </Badge>
                {running.length > 0 && (
                  <Badge className="text-[10px] px-1.5 py-0 bg-blue-600 hover:bg-blue-600 text-white">
                    {running.length} running
                  </Badge>
                )}
                {queued.length > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 border-amber-300 text-amber-700"
                  >
                    {queued.length} queued
                  </Badge>
                )}
              </>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["active-engine-runs"] });
              refetch();
            }}
            disabled={isFetching}
            data-testid="active-engine-runs-refresh"
          >
            <RefreshCw
              className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        {!compact && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            Engine chain after ingest fires:{" "}
            <span className="font-mono text-[10px]">
              extract → pass0 → stage1 → detect_instances → stage4
            </span>
            . Three swimlanes — Queued, Running, Recently finished — show
            where every project is in the pipeline.
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{error?.message || "Failed to load engine runs."}</span>
          </div>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <div
            className="text-xs text-muted-foreground italic"
            data-testid="active-engine-runs-empty"
          >
            {projectId
              ? "No engine activity for this project in the last 60 minutes — chain is idle."
              : "No engine runs in flight or finished in the last 60 minutes. The chain is idle."}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-3" data-testid="active-engine-runs-lanes">
            <Lane
              title="Queued"
              rows={queued}
              badgeTone="border-amber-300 text-amber-700"
              emptyHint="No queued jobs."
              testId="lane-queued"
            />
            <Lane
              title="Running"
              rows={running}
              badgeTone="border-blue-300 text-blue-700"
              emptyHint="Nothing running right now."
              testId="lane-running"
            />
            <Lane
              title="Recently finished"
              rows={finished}
              badgeTone="border-emerald-300 text-emerald-700"
              emptyHint="No completions in the last 60 minutes."
              testId="lane-finished"
            />
          </div>
        )}

        {!compact && (
          <p className="text-[10px] text-muted-foreground italic pt-1">
            Polling every 15s. Terminal rows drop out of the Recently
            finished lane 60min after they finished — open the round's Audit
            subtab for the full history.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

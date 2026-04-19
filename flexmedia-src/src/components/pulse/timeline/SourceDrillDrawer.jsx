/**
 * SourceDrillDrawer — right-side Sheet surfacing the sync_log + payload that
 * emitted a given timeline row. Opened when the user clicks a source chip on
 * any timeline surface (PulseTimeline shared, PulseTimelineTab tab,
 * PulseCommandCenter tile).
 *
 * Contents:
 *   1. Source config header  (label, actor slug link, Apify store link)
 *   2. Sync-log summary      (status, started/completed, duration, records)
 *   3. Apify run deep-link   (console.apify.com/actors/runs/{apify_run_id})
 *   4. Payload preview       (first ~5KB, jsonb-pretty)
 *   5. "Download full" button for payloads >5KB
 *   6. "View all runs for this source" link → Data Sources tab filtered
 *
 * If the lookup yields no matching sync_log we render a graceful empty state
 * with a link into Data Sources so the user can investigate why.
 *
 * Generic enough to be imported by PulseTimelineTab.jsx (Agent A) without
 * modification — it takes only {source, createdAt, open, onClose}.
 */
import React, { useMemo, useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  ExternalLink, Download, Copy, CheckCircle2, AlertCircle, Loader2,
  Clock, Zap, Database, Hash, FileJson, XCircle,
} from "lucide-react";
import { useTimelineSourceRun, fetchFullPayload } from "./useTimelineSourceRun";
import { sourceChipClass } from "./timelineIcons";

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-AU", {
    day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  if (isNaN(ms) || ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}

function StatusPill({ status }) {
  const cls = sourceChipClass(status);
  const label = status ? status.replace(/_/g, " ") : "unknown";
  let Icon = Loader2;
  if (/success|completed/i.test(status || "")) Icon = CheckCircle2;
  else if (/failed|error|timeout/i.test(status || "")) Icon = XCircle;
  else if (/running|in_progress|pending/i.test(status || "")) Icon = Loader2;
  return (
    <Badge variant="outline" className={cn("gap-1 capitalize", cls)}>
      <Icon className={cn("h-3 w-3", /running|pending|in_progress/i.test(status || "") && "animate-spin")} />
      {label}
    </Badge>
  );
}

export default function SourceDrillDrawer({ source, createdAt, open, onClose }) {
  const query = useTimelineSourceRun(source, createdAt, { enabled: open });
  const { data, isLoading, isError, error } = query;
  const syncLog = data?.syncLog;
  const sourceConfig = data?.sourceConfig;
  const payload = data?.payload;
  const payloadTruncated = data?.payloadTruncated;

  const [copied, setCopied] = useState(false);
  const [downloading, setDownloading] = useState(false);

  const duration = useMemo(
    () => (syncLog ? fmtDuration(syncLog.started_at, syncLog.completed_at) : null),
    [syncLog]
  );

  const apifyRunUrl = syncLog?.apify_run_id
    ? `https://console.apify.com/actors/runs/${syncLog.apify_run_id}`
    : null;

  const allRunsUrl = `/IndustryPulse?tab=sources&source_id=${encodeURIComponent(source || "")}`;
  const syncLogUrl = syncLog?.id
    ? `/IndustryPulse?tab=sources&sync_log_id=${syncLog.id}`
    : null;

  async function handleCopy() {
    if (!payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function handleDownload() {
    if (!syncLog?.id) return;
    setDownloading(true);
    try {
      const full = await fetchFullPayload(syncLog.id);
      const blob = new Blob(
        [JSON.stringify(full?.raw_payload ?? full ?? {}, null, 2)],
        { type: "application/json" }
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sync-log-${syncLog.id}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Payload download failed", e);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose?.()}>
      <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <Database className="h-4 w-4" />
            Source: {sourceConfig?.label || source || "Unknown"}
          </SheetTitle>
          <SheetDescription className="font-mono text-[11px]">{source || "—"}</SheetDescription>
        </SheetHeader>

        {/* ── Source config ─────────────────────────────────────────── */}
        <div className="mt-4 space-y-2 rounded-lg border p-3 bg-muted/30">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Source Config</span>
          </div>
          <dl className="text-xs space-y-1.5">
            {sourceConfig?.description && (
              <div>
                <dt className="text-muted-foreground text-[10px]">Description</dt>
                <dd className="font-medium">{sourceConfig.description}</dd>
              </div>
            )}
            {sourceConfig?.actor_slug && (
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground text-[10px] shrink-0">Actor</dt>
                <a
                  href={sourceConfig.apify_store_url || `https://apify.com/${sourceConfig.actor_slug}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-primary hover:underline inline-flex items-center gap-1 truncate"
                >
                  {sourceConfig.actor_slug}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </div>
            )}
            {sourceConfig?.schedule_cron && (
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground text-[10px]">Schedule</dt>
                <code className="text-[10px] px-1.5 py-0.5 rounded bg-muted">{sourceConfig.schedule_cron}</code>
              </div>
            )}
            {!sourceConfig && !isLoading && (
              <p className="text-[10px] text-muted-foreground italic">
                No source_config row for this source_id.
              </p>
            )}
          </dl>
        </div>

        {/* ── Sync-log summary ──────────────────────────────────────── */}
        <div className="mt-3">
          {isLoading ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading matched sync run…
            </div>
          ) : isError ? (
            <div className="rounded-lg border border-rose-200 dark:border-rose-800/50 p-3 text-xs">
              <div className="flex items-center gap-2 font-semibold text-rose-700 dark:text-rose-300">
                <AlertCircle className="h-3 w-3" />
                Failed to load sync run
              </div>
              <p className="mt-1 text-muted-foreground">{error?.message || "Unknown error"}</p>
            </div>
          ) : syncLog ? (
            <div className="rounded-lg border p-3 space-y-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Matched Sync Run</span>
                <StatusPill status={syncLog.status} />
              </div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                <div className="col-span-2">
                  <dt className="text-muted-foreground text-[10px]">Started</dt>
                  <dd className="font-mono">{fmtDateTime(syncLog.started_at)}</dd>
                </div>
                <div className="col-span-2">
                  <dt className="text-muted-foreground text-[10px]">Completed</dt>
                  <dd className="font-mono">{fmtDateTime(syncLog.completed_at)}</dd>
                </div>
                {duration && (
                  <div>
                    <dt className="text-muted-foreground text-[10px]">Duration</dt>
                    <dd className="tabular-nums">
                      <Clock className="inline h-3 w-3 mr-1 text-muted-foreground" />
                      {duration}
                    </dd>
                  </div>
                )}
                {syncLog.triggered_by && (
                  <div>
                    <dt className="text-muted-foreground text-[10px]">Trigger</dt>
                    <dd className="truncate">{syncLog.triggered_by_name || syncLog.triggered_by}</dd>
                  </div>
                )}
                <div>
                  <dt className="text-muted-foreground text-[10px]">Fetched</dt>
                  <dd className="tabular-nums">{syncLog.records_fetched ?? 0}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[10px]">New</dt>
                  <dd className="tabular-nums text-emerald-700 dark:text-emerald-400">
                    {syncLog.records_new ?? 0}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[10px]">Updated</dt>
                  <dd className="tabular-nums text-blue-700 dark:text-blue-400">
                    {syncLog.records_updated ?? 0}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[10px]">Run ID</dt>
                  <dd className="font-mono text-[10px] truncate" title={syncLog.id}>
                    {String(syncLog.id).slice(0, 8)}…
                  </dd>
                </div>
              </dl>
              {syncLog.error_message && (
                <div className="rounded-md border border-rose-200 dark:border-rose-800/50 bg-rose-50/60 dark:bg-rose-950/30 p-2 text-[11px] text-rose-700 dark:text-rose-300">
                  <div className="font-semibold flex items-center gap-1 mb-0.5">
                    <AlertCircle className="h-3 w-3" />
                    Error
                  </div>
                  <p className="font-mono text-[10px] whitespace-pre-wrap break-words">
                    {syncLog.error_message}
                  </p>
                </div>
              )}
              {apifyRunUrl && (
                <a
                  href={apifyRunUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
                >
                  <Zap className="h-3 w-3" />
                  Open Apify run
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
              <div className="flex items-center gap-2 font-medium text-foreground mb-1">
                <AlertCircle className="h-3.5 w-3.5" />
                No matching sync run found
              </div>
              <p>
                No <code className="px-1 rounded bg-muted">pulse_sync_logs</code> row
                matched source <code className="px-1 rounded bg-muted">{source}</code> within
                5 minutes of this event. The event may have been backfilled or emitted by
                a different pipeline.
              </p>
            </div>
          )}
        </div>

        {/* ── Payload preview ───────────────────────────────────────── */}
        {payload && (
          <div className="mt-3 rounded-lg border p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                <FileJson className="h-3 w-3" />
                Payload Preview
                {payloadTruncated && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">
                    first 5KB
                  </Badge>
                )}
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 px-2 text-[10px]"
                  onClick={handleCopy}
                  title="Copy preview to clipboard"
                >
                  {copied ? <CheckCircle2 className="h-3 w-3 mr-1 text-emerald-600" /> : <Copy className="h-3 w-3 mr-1" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                {payloadTruncated && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-[10px]"
                    onClick={handleDownload}
                    disabled={downloading}
                  >
                    {downloading ? (
                      <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                    ) : (
                      <Download className="h-3 w-3 mr-1" />
                    )}
                    Download full
                  </Button>
                )}
              </div>
            </div>
            <pre className="text-[10px] font-mono whitespace-pre-wrap break-words bg-muted/40 rounded-md p-2 max-h-[280px] overflow-auto">
              {payload}
            </pre>
          </div>
        )}

        {/* ── Footer links ──────────────────────────────────────────── */}
        <div className="mt-4 flex items-center justify-between gap-2 pt-3 border-t text-[11px]">
          <a
            href={allRunsUrl}
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <Hash className="h-3 w-3" />
            View all runs for this source
          </a>
          {syncLogUrl && (
            <a
              href={syncLogUrl}
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-primary"
            >
              Full run details
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

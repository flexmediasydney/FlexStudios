/**
 * DropboxFolderProbeWidget — real-time visibility into the project's
 * `Photos/Raws/Shortlist Proposed/` Dropbox folder, independent of the
 * webhook chain.
 *
 * Why this exists (Joseph 2026-05-04):
 *   "i just uploaded raw images... i dont feel like i have any visual
 *    cues in the shortlisting tab for this project, nor on the command
 *    center, if it knows the files are there, how many, and when the
 *    next cron job/detection will occur"
 *
 * The complementary `PendingIngestsWidget` ONLY shows rows that already
 * exist in `shortlisting_jobs WHERE kind='ingest' AND status='pending'`.
 * Those rows depend on the Dropbox webhook → enqueue chain firing
 * successfully — and there's a real gap (debounce window, webhook
 * delivery latency, sync_state cursor staleness) where files can sit
 * in Dropbox for hours while the operator sees nothing.
 *
 * This widget hits Dropbox's `/files/list_folder` directly via the
 * `shortlisting-folder-probe` edge function and shows:
 *   - File count + total bytes in the folder right now
 *   - Latest server_modified timestamp ("most recent upload 2m ago")
 *   - Top 5 recent filenames
 *   - Pending ingest job (if any) — countdown to scheduled fire time
 *   - "Detect now" button (master_admin) to skip debounce + enqueue
 *     immediately
 *
 * Polling: 60s (Dropbox API costs ~1 unit per call; conservative).
 */
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  CloudDownload,
  RefreshCw,
  AlertTriangle,
  Zap,
  FileImage,
  Clock,
} from "lucide-react";
import { usePermissions } from "@/components/auth/PermissionGuard";

const POLL_INTERVAL_MS = 60_000;

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

/** Format ms-ago as a short relative phrase. */
function formatRelativeAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/** Format scheduled_for as ms-until + countdown. */
function formatCountdown(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "ready — claiming next tick";
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `in ${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return `in ${hr}h ${remMin}m`;
}

/**
 * @param {object} props
 * @param {string} props.projectId — required.
 * @param {boolean} [props.compact] — render compact (no header, smaller).
 */
export default function DropboxFolderProbeWidget({ projectId, compact = false }) {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions() ?? {};
  const [now, setNow] = useState(Date.now());

  // 1s ticker for live countdown rendering.
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const probeQuery = useQuery({
    queryKey: ["shortlisting_folder_probe", projectId],
    enabled: Boolean(projectId),
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    queryFn: async () => {
      const resp = await api.functions.invoke("shortlisting-folder-probe", {
        project_id: projectId,
        action: "probe",
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) {
        throw new Error(result?.error || "Folder probe failed");
      }
      return result;
    },
  });

  const detectNowMutation = useMutation({
    mutationFn: async () => {
      const resp = await api.functions.invoke("shortlisting-folder-probe", {
        project_id: projectId,
        action: "detect_now",
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false || result?.detect_now?.enqueued === false) {
        throw new Error(
          result?.detect_now?.skipped_reason ||
            result?.error ||
            "Detect now failed",
        );
      }
      return result;
    },
    onSuccess: (data) => {
      const moved = data?.detect_now?.job_id ? "enqueued" : "no-op";
      toast.success(
        `Detect now → ${moved}. Cron dispatcher picks it up on the next minute tick.`,
      );
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_folder_probe", projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_jobs_pending_ingest"],
      });
    },
    onError: (err) => {
      toast.error(err?.message || "Detect now failed");
    },
  });

  const data = probeQuery.data;
  const isLoading = probeQuery.isLoading;
  const isFetching = probeQuery.isFetching;
  const error = probeQuery.error;

  const fileCount = data?.file_count ?? 0;
  const totalBytes = data?.total_bytes ?? 0;
  const latestModified = data?.latest_modified || null;
  const recentFiles = data?.recent_files || [];
  const pendingJob = data?.pending_ingest_job || null;
  const folderProvisioned = data?.folder_provisioned !== false;
  const probeError = data?.error || data?.list_error || null;

  const latestAgo = useMemo(
    () => (latestModified ? formatRelativeAgo(latestModified) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [latestModified, now],
  );
  const pendingCountdown = useMemo(
    () => (pendingJob?.scheduled_for ? formatCountdown(pendingJob.scheduled_for) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pendingJob?.scheduled_for, now],
  );

  if (!projectId) return null;

  // Loading skeleton
  if (isLoading) {
    return (
      <Card>
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center gap-2 text-xs text-muted-foreground animate-pulse">
            <CloudDownload className="h-3.5 w-3.5" />
            Probing Dropbox…
          </div>
        </CardContent>
      </Card>
    );
  }

  // Folder not provisioned — show neutral status, don't alarm.
  if (!folderProvisioned) {
    return (
      <Card>
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 text-amber-600" />
            <div>
              <div className="font-medium text-foreground">
                Project folders not provisioned yet
              </div>
              <div className="text-[11px] mt-0.5">{probeError}</div>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // No files in folder — gentle empty state.
  if (fileCount === 0 && !error) {
    return (
      <Card>
        <CardContent className={compact ? "p-3" : "p-4"}>
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-start gap-2 text-xs">
              <CloudDownload className="h-3.5 w-3.5 mt-0.5 text-muted-foreground" />
              <div>
                <div className="font-medium text-foreground">
                  Photos/Raws/Shortlist Proposed/
                </div>
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Empty — drop CR3/RAW files into this Dropbox folder to start
                  an auto-round.{" "}
                  {probeError ? (
                    <span className="text-amber-700">
                      ({probeError.slice(0, 80)})
                    </span>
                  ) : null}
                </div>
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => probeQuery.refetch()}
              disabled={isFetching}
              className="text-[11px]"
              title="Re-probe Dropbox folder"
            >
              <RefreshCw
                className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Files detected — the meat of the widget.
  return (
    <Card className={
      pendingJob
        ? "border-amber-300 bg-amber-50/30 dark:bg-amber-950/10"
        : "border-emerald-300 bg-emerald-50/30 dark:bg-emerald-950/10"
    }>
      <CardContent className={compact ? "p-3 space-y-2" : "p-4 space-y-3"}>
        {/* Header: file count + last upload */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <FileImage
              className={`h-4 w-4 mt-0.5 ${
                pendingJob ? "text-amber-700" : "text-emerald-700"
              }`}
            />
            <div>
              <div className="text-sm font-semibold tabular-nums">
                {fileCount} RAW file{fileCount === 1 ? "" : "s"} in{" "}
                <code className="text-[11px] font-mono">
                  Photos/Raws/Shortlist Proposed/
                </code>
              </div>
              <div className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                <span>{formatBytes(totalBytes)}</span>
                {latestAgo ? (
                  <>
                    <span>·</span>
                    <span title={latestModified}>
                      most recent upload {latestAgo}
                    </span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => probeQuery.refetch()}
            disabled={isFetching}
            className="text-[11px] shrink-0"
            title="Re-probe Dropbox folder"
          >
            <RefreshCw
              className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        {/* Pending ingest status */}
        {pendingJob ? (
          <div className="flex items-center justify-between gap-2 rounded border border-amber-300 bg-amber-100/60 dark:bg-amber-900/20 px-2 py-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              <Clock className="h-3 w-3 text-amber-700" />
              <span className="font-medium text-amber-900 dark:text-amber-200">
                Auto-ingest scheduled — {pendingCountdown}
              </span>
              <Badge variant="outline" className="text-[10px] py-0 h-4">
                {pendingJob.status}
              </Badge>
            </div>
            {isMasterAdmin ? (
              <Button
                size="sm"
                variant="default"
                onClick={() => detectNowMutation.mutate()}
                disabled={detectNowMutation.isLoading}
                className="h-6 text-[11px] px-2"
              >
                <Zap className="h-3 w-3 mr-1" />
                Fire now
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 rounded border border-emerald-300 bg-emerald-100/60 dark:bg-emerald-900/20 px-2 py-1.5">
            <div className="flex items-center gap-2 text-[11px]">
              <Clock className="h-3 w-3 text-emerald-700" />
              <span className="text-emerald-900 dark:text-emerald-200">
                Files detected. No pending ingest yet — auto-detection will
                catch it within ~2 min, or click{" "}
                <strong>Detect now</strong>.
              </span>
            </div>
            {isMasterAdmin ? (
              <Button
                size="sm"
                variant="default"
                onClick={() => detectNowMutation.mutate()}
                disabled={detectNowMutation.isLoading}
                className="h-6 text-[11px] px-2"
              >
                <Zap className="h-3 w-3 mr-1" />
                Detect now
              </Button>
            ) : null}
          </div>
        )}

        {/* Recent files (top 5) — collapsed in compact mode */}
        {!compact && recentFiles.length > 0 ? (
          <div className="space-y-0.5 text-[11px] text-muted-foreground border-t pt-2">
            <div className="font-medium text-foreground/80">
              Recent uploads ({recentFiles.length})
            </div>
            {recentFiles.map((f) => (
              <div
                key={f.name}
                className="flex items-center justify-between gap-2 font-mono"
              >
                <span className="truncate">{f.name}</span>
                <span className="shrink-0 tabular-nums">
                  {formatRelativeAgo(f.server_modified)}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {/* Stale-cursor warning — when latest_modified is fresh but no
            pending job exists after a reasonable lag (5 min), surface
            it because that suggests the webhook chain didn't fire. */}
        {latestModified &&
        !pendingJob &&
        Date.now() - new Date(latestModified).getTime() > 5 * 60_000 ? (
          <div className="flex items-start gap-2 rounded border border-amber-300 bg-amber-100/60 dark:bg-amber-900/20 px-2 py-1.5 text-[11px]">
            <AlertTriangle className="h-3 w-3 mt-0.5 text-amber-700" />
            <span className="text-amber-900 dark:text-amber-200">
              Files have been here &gt;5 min without an auto-ingest being
              enqueued. The Dropbox webhook may have a stale cursor — use{" "}
              <strong>Detect now</strong> to bypass.
            </span>
          </div>
        ) : null}

        {error ? (
          <div className="flex items-start gap-2 text-[11px] text-red-700">
            <AlertTriangle className="h-3 w-3 mt-0.5" />
            <span>{error.message || String(error)}</span>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

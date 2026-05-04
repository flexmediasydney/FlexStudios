/**
 * LockProgressDialog — Wave 7 P0-1
 *
 * Live progress dialog for the swimlane Lock & Reorganize action.
 *
 * Why it exists:
 *   The old shortlist-lock fn did per-file /files/move_v2 in a 6-worker loop
 *   inside the 150s edge gateway window. >50-file rounds timed out, the DB
 *   transitioned to status='locked' regardless, and recovery was a 30-min
 *   manual revert/retry cycle.
 *
 *   The new fn submits ALL moves to /files/move_batch_v2 (async, up to 10K
 *   entries per call) and returns immediately with `status: 'in_progress'`
 *   plus a progress_id. EdgeRuntime.waitUntil() polls Dropbox in the background
 *   and updates shortlisting_lock_progress; this dialog polls
 *   shortlist-lock-status every 2.5s to render the live progress bar.
 *
 * Properties:
 *   - Non-blocking: dismissable. If the user closes mid-flight, the
 *     background poll keeps running on the server. They can re-open the dialog
 *     by hitting Lock again — the open progress row short-circuits via the
 *     "lock already in flight" 409 path, OR they can wait for the round to
 *     transition to status='locked' and the swimlane queries will refresh.
 *   - Resume on failure: when stage='failed', surfaces a Resume button that
 *     POSTs `{ round_id, resume: true }` to shortlist-lock — the new fn
 *     re-builds the move list (skipping files already at destination) and
 *     submits a fresh batch.
 *
 * Polling strategy:
 *   2500ms poll interval matches the spec. We use TanStack Query's
 *   refetchInterval. Disabled once stage='complete' or 'failed' to avoid
 *   wasted reads after the terminal state.
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";

const POLL_INTERVAL_MS = 2500;

function stageLabel(stage, succeeded, total) {
  switch (stage) {
    case "submitting":
      return "Submitting batch to Dropbox...";
    case "polling":
      return total > 0
        ? `Moving ${succeeded}/${total} files...`
        : "Waiting for Dropbox...";
    case "finalizing":
      return "Finalising round status...";
    case "complete":
      return "Done.";
    case "failed":
      return "Lock failed";
    default:
      return "Starting lock...";
  }
}

export default function LockProgressDialog({
  open,
  onOpenChange,
  roundId,
  projectId,
  // The initial response from shortlist-lock — we use it to seed the dialog
  // so the operator sees total_moves immediately rather than waiting for the
  // first poll.
  initialResponse,
}) {
  const queryClient = useQueryClient();
  const [resumeInFlight, setResumeInFlight] = useState(false);

  // Live progress query.
  const progressQuery = useQuery({
    queryKey: ["shortlist_lock_progress", roundId],
    queryFn: async () => {
      const resp = await api.functions.invoke("shortlist-lock-status", {
        round_id: roundId,
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) {
        throw new Error(result?.error || "Status fetch failed");
      }
      return result?.progress || null;
    },
    enabled: Boolean(roundId) && open,
    // Poll while non-terminal. Terminal states stop refetching. The
    // refetchInterval callback is invoked AFTER each successful fetch.
    refetchInterval: (query) => {
      const data = query?.state?.data;
      if (!data) return POLL_INTERVAL_MS;
      if (data.stage === "complete" || data.stage === "failed") return false;
      return POLL_INTERVAL_MS;
    },
    // Always refetch on focus + reconnect — operator may be tabbed away.
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    // Don't cache stale data across dialog opens; we want a fresh poll each open.
    staleTime: 0,
  });

  const progress = progressQuery.data;
  const initialTotal = initialResponse?.total_moves ?? 0;
  const initialApproved = initialResponse?.moved?.approved ?? 0;
  const initialRejected = initialResponse?.moved?.rejected ?? 0;
  // The initial response from a no-work fast path can come back with
  // status='complete' before the progress row is queried — render it directly.
  const inferredStatus = useMemo(() => {
    if (progress) return progress.stage;
    if (initialResponse?.status === "complete") return "complete";
    if (initialResponse?.status === "in_progress") return "polling";
    return "pending";
  }, [progress, initialResponse]);

  const total = progress?.total_moves ?? initialTotal;
  const succeeded = progress?.succeeded_moves ?? 0;
  const failed = progress?.failed_moves ?? 0;
  const percent = progress?.percent_complete
    ?? (initialResponse?.status === "complete" ? 100 : 0);
  const approvedCount = progress?.approved_count ?? 0;
  const rejectedCount = progress?.rejected_count ?? 0;

  // When we transition to 'complete', refresh the swimlane queries so the
  // round shows as locked.
  useEffect(() => {
    if (inferredStatus === "complete") {
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_rounds", projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["composition_groups", roundId],
      });
    }
  }, [inferredStatus, projectId, roundId, queryClient]);

  // Resume handler — POSTs {resume:true} to shortlist-lock.
  const onResume = useCallback(async () => {
    if (!roundId) return;
    setResumeInFlight(true);
    try {
      const resp = await api.functions.invoke("shortlist-lock", {
        round_id: roundId,
        resume: true,
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) {
        throw new Error(result?.error || "Resume failed");
      }
      toast.success("Resume submitted — polling for completion.");
      // Force an immediate refetch of the progress row so the dialog updates.
      queryClient.invalidateQueries({
        queryKey: ["shortlist_lock_progress", roundId],
      });
    } catch (err) {
      console.error("[LockProgressDialog] resume failed:", err);
      toast.error(err?.message || "Resume failed");
    } finally {
      setResumeInFlight(false);
    }
  }, [roundId, queryClient]);

  // Compute a friendly subtitle.
  const subtitle = stageLabel(inferredStatus, succeeded, total);

  const isTerminal = inferredStatus === "complete" || inferredStatus === "failed";
  const isFailed = inferredStatus === "failed";
  const isComplete = inferredStatus === "complete";

  // 2026-05-04 — fix display bug.  The PRIOR formula read
  // `initialResponse.moved.approved` first when isComplete, but on the
  // async path the initial 202 response has moved={approved:0,rejected:0}
  // (counts populate during background poll into lock_progress).  Result
  // was "Moved 0 approved + 0 rejected" even when 154 files succeeded.
  // Fix: prefer polled progress when it has data; fall back to initial
  // response only for sync-complete / zero-work fast paths where progress
  // row may not exist.
  const hasPolledCounts = progress && progress.succeeded_moves != null;
  const movedApproved = hasPolledCounts
    ? Math.min(progress.succeeded_moves, progress.approved_count ?? 0)
    : (initialResponse?.moved?.approved ?? initialApproved);
  const movedRejected = hasPolledCounts
    ? Math.max(0, progress.succeeded_moves - (progress.approved_count ?? 0))
    : (initialResponse?.moved?.rejected ?? initialRejected);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isComplete
              ? "Shortlist locked"
              : isFailed
                ? "Lock failed"
                : "Locking shortlist..."}
          </DialogTitle>
          <DialogDescription>
            {isComplete
              ? failed > 0
                ? `Moved ${succeeded} of ${total} file(s) into Final Shortlist/. ${failed} transient failure${failed === 1 ? "" : "s"} (rate-limit retries already exhausted; check errors below).`
                : `Moved ${succeeded} file(s) into Final Shortlist/.${movedRejected > 0 ? ` (${movedRejected} explicitly rejected → Rejected/.)` : ""}`
              : isFailed
                ? "The Dropbox batch did not complete. You can resume — files already at their destination will be skipped."
                : "Dropbox is moving files in the background. You can close this dialog; we'll keep working."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {isComplete ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            ) : isFailed ? (
              <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
            ) : (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            <span>{subtitle}</span>
          </div>

          <Progress value={percent} aria-label="Lock progress" />

          <div className="grid grid-cols-3 gap-3 text-xs">
            <div>
              <div className="text-muted-foreground">Total</div>
              <div className="font-medium tabular-nums">{total}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Succeeded</div>
              <div className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                {succeeded}
              </div>
            </div>
            <div>
              <div className="text-muted-foreground">Failed</div>
              <div
                className={
                  failed > 0
                    ? "font-medium tabular-nums text-red-700 dark:text-red-400"
                    : "font-medium tabular-nums"
                }
              >
                {failed}
              </div>
            </div>
          </div>

          {isFailed && progress?.error_message ? (
            <div className="rounded-md border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-2 text-xs text-red-700 dark:text-red-300">
              <div className="font-medium mb-0.5">Error</div>
              <div className="whitespace-pre-wrap">{progress.error_message}</div>
            </div>
          ) : null}

          {isFailed
            && Array.isArray(progress?.errors_sample)
            && progress.errors_sample.length > 0 ? (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer font-medium">
                {progress.errors_sample.length} failed file(s) — show details
              </summary>
              <ul className="mt-1 space-y-0.5 max-h-40 overflow-y-auto font-mono">
                {progress.errors_sample.slice(0, 20).map((e, i) => (
                  <li key={i} className="truncate" title={e.detail || ""}>
                    {e.from_path} — {e.failure_tag}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}

          {progressQuery.error ? (
            <div className="text-xs text-red-700 dark:text-red-400">
              Could not read progress: {progressQuery.error.message}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          {isFailed ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={resumeInFlight}
              >
                Close
              </Button>
              <Button onClick={onResume} disabled={resumeInFlight}>
                {resumeInFlight && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                {!resumeInFlight && <RefreshCw className="h-4 w-4 mr-2" />}
                Resume
              </Button>
            </>
          ) : isComplete ? (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          ) : (
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Hide (keep working in background)
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

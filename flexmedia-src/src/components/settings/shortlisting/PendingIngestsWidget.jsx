/**
 * PendingIngestsWidget — Shortlisting Command Center + per-project tab.
 *
 * Surfaces every shortlisting_jobs row with kind='ingest' and status='pending'
 * with a live countdown to scheduled_for. Each pending ingest reflects a
 * Dropbox folder change that triggered debounce — the system waits 2 hours
 * after the *last* touch before claiming the job, on the assumption that
 * the photographer is still uploading. Operators previously had no way to
 * see this — Joseph reported "I added images to 46 Brays, no idea if it
 * was detected and no idea when ingest will fire."
 *
 * Two surfaces:
 *   - Settings → Shortlisting Command Center → Overview (no projectId prop;
 *     shows every project with a pending ingest, ordered by scheduled_for).
 *   - Per-project ProjectShortlistingTab (projectId prop; filters to one).
 *
 * Operator affordance — "Fire now" button (master_admin only) calls the
 * shortlisting_fire_pending_ingest_now(p_job_id) RPC (mig 457) to set
 * scheduled_for = now(), bypassing the rest of the 2h debounce. Useful
 * when the photographer signals "all uploaded, run it now."
 *
 * Two refresh cadences:
 *   - useQuery: 30s — picks up new pending jobs + status flips when the
 *     dispatcher claims them.
 *   - Ticking countdown: 1s — purely client-side recomputation against the
 *     cached scheduled_for; no network.
 */
import React, { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Clock,
  FolderClock,
  RefreshCw,
  AlertTriangle,
  Zap,
} from "lucide-react";
import { usePermissions } from "@/components/auth/PermissionGuard";

const POLL_INTERVAL_MS = 30_000;

/** Format ms-difference as `Hh Mm Ss` / `Mm Ss` / `Ss`, capped at days. */
function formatDuration(ms) {
  if (ms <= 0) return "ready";
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m ${String(secs).padStart(2, "0")}s`;
  if (mins > 0) return `${mins}m ${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** Format ms-ago (positive = past) as a short relative phrase. */
function formatAgo(ms) {
  if (ms < 0) return "in the future";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s ago`;
  const mins = Math.floor(totalSec / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}

/**
 * @param {object} props
 * @param {string=} props.projectId — filter to a single project (per-project
 *   surface); omit for the cross-project command-center surface.
 * @param {boolean=} props.compact — drop the explanatory paragraph + footer
 *   note when embedded inline in a denser layout.
 */
export default function PendingIngestsWidget({ projectId, compact = false }) {
  const qc = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const { isMasterAdmin } = usePermissions() ?? {};

  // Tick the local clock every second so countdowns advance without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const queryKey = useMemo(
    () => ["pending-ingest-jobs", projectId ?? "all"],
    [projectId],
  );

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey,
    queryFn: async () => {
      let q = supabase
        .from("shortlisting_jobs")
        .select(
          "id, project_id, kind, status, scheduled_for, created_at, payload, " +
            "project:projects!inner(id, property_address, property_suburb, dropbox_root_path)",
        )
        .eq("kind", "ingest")
        .eq("status", "pending")
        .order("scheduled_for", { ascending: true });
      if (projectId) q = q.eq("project_id", projectId);
      const { data: rows, error: err } = await q;
      if (err) throw err;
      return Array.isArray(rows) ? rows : [];
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 15_000,
  });

  const fireNow = useMutation({
    mutationFn: async (jobId) => {
      const { data: result, error: err } = await api.rpc(
        "shortlisting_fire_pending_ingest_now",
        { p_job_id: jobId },
      );
      if (err) throw err;
      return result;
    },
    onSuccess: () => {
      toast.success(
        "Fired ingest now — dispatcher claims within 2 minutes.",
      );
      qc.invalidateQueries({ queryKey: ["pending-ingest-jobs"] });
    },
    onError: (e) => {
      toast.error(`Fire now failed: ${e?.message || "unknown error"}`);
    },
  });

  const rows = Array.isArray(data) ? data : [];

  return (
    <Card data-testid="pending-ingests-widget">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderClock className="h-4 w-4 text-blue-600" />
            <h3 className="text-sm font-semibold">Pending ingests</h3>
            {!isLoading && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                {rows.length}
              </Badge>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={() => {
              qc.invalidateQueries({ queryKey: ["pending-ingest-jobs"] });
              refetch();
            }}
            disabled={isFetching}
            data-testid="pending-ingests-refresh"
          >
            <RefreshCw
              className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`}
            />
          </Button>
        </div>

        {!compact && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            A 2-hour Dropbox-touch debounce delays ingest until the
            photographer stops uploading. Each row below shows when ingest
            will auto-fire.
            {isMasterAdmin && (
              <>
                {" "}Use <strong>Fire now</strong> to skip the rest of the
                debounce window.
              </>
            )}
          </p>
        )}

        {error && (
          <div className="flex items-start gap-2 text-xs text-amber-700">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>
              {error?.message || "Failed to load pending ingest jobs."}
            </span>
          </div>
        )}

        {!isLoading && !error && rows.length === 0 && (
          <div
            className="text-xs text-muted-foreground italic"
            data-testid="pending-ingests-empty"
          >
            {projectId
              ? "No pending ingest for this project. Either ingest already fired or no Dropbox folder change has been detected since the last run."
              : "No pending ingests. Folders without a 2h-old debounce timer have either already fired or never received a Dropbox touch."}
          </div>
        )}

        {rows.length > 0 && (
          <div className="space-y-1.5" data-testid="pending-ingests-list">
            {rows.map((row) => {
              const scheduledMs = row.scheduled_for
                ? new Date(row.scheduled_for).getTime()
                : null;
              const lastTouchedRaw = row?.payload?.last_debounced_at ?? null;
              const lastTouchedMs = lastTouchedRaw
                ? new Date(lastTouchedRaw).getTime()
                : null;
              const remainingMs =
                scheduledMs != null ? scheduledMs - nowMs : null;
              const isReady = remainingMs != null && remainingMs <= 0;

              const address = row?.project?.property_address ?? "(unknown)";
              const suburb = row?.project?.property_suburb ?? null;

              return (
                <div
                  key={row.id}
                  className={`grid grid-cols-12 gap-2 items-center text-xs rounded px-2 py-1.5 border ${
                    isReady
                      ? "border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/30"
                      : "border-border/60 bg-muted/30"
                  }`}
                  data-testid={`pending-ingests-row-${row.id}`}
                >
                  {!projectId && (
                    <div className="col-span-5 truncate">
                      <div
                        className="font-medium truncate"
                        title={address}
                      >
                        {address}
                      </div>
                      {suburb && (
                        <div className="text-[10px] text-muted-foreground truncate">
                          {suburb}
                        </div>
                      )}
                    </div>
                  )}
                  <div
                    className={
                      projectId
                        ? "col-span-5 text-[11px] text-muted-foreground"
                        : "col-span-3 text-[11px] text-muted-foreground"
                    }
                  >
                    last touch:{" "}
                    {lastTouchedMs != null ? (
                      <span title={new Date(lastTouchedMs).toISOString()}>
                        {formatAgo(nowMs - lastTouchedMs)}
                      </span>
                    ) : (
                      <span className="italic">unknown</span>
                    )}
                  </div>
                  <div
                    className={
                      projectId
                        ? "col-span-4 text-right font-mono tabular-nums"
                        : "col-span-3 text-right font-mono tabular-nums"
                    }
                  >
                    {scheduledMs == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : isReady ? (
                      <span className="text-emerald-700 dark:text-emerald-400 inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        ready — claiming next tick
                      </span>
                    ) : (
                      <span title={new Date(scheduledMs).toISOString()}>
                        fires in {formatDuration(remainingMs)}
                      </span>
                    )}
                  </div>
                  {isMasterAdmin && (
                    <div className="col-span-3 text-right">
                      {!isReady && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 px-2 text-[10px]"
                          disabled={
                            fireNow.isPending &&
                            fireNow.variables === row.id
                          }
                          onClick={() => {
                            if (
                              window.confirm(
                                `Skip the 2h Dropbox-touch debounce and fire ingest for "${address}" now?\n\nThe dispatcher will claim it within 2 minutes.`,
                              )
                            ) {
                              fireNow.mutate(row.id);
                            }
                          }}
                          data-testid={`pending-ingests-fire-${row.id}`}
                        >
                          <Zap className="h-3 w-3 mr-1" />
                          Fire now
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {!compact && (
          <p className="text-[10px] text-muted-foreground italic pt-1">
            Dispatcher claims pending jobs every 2 minutes whose{" "}
            <code className="text-[10px]">scheduled_for</code> ≤ now. Polling
            every 30s; countdowns tick every second.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

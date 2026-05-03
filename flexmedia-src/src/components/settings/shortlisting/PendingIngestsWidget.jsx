/**
 * PendingIngestsWidget — Shortlisting Command Center.
 *
 * Surfaces every shortlisting_jobs row with kind='ingest' and status='pending'
 * with a live countdown to scheduled_for. Each pending ingest reflects a
 * Dropbox folder change that triggered debounce — the system waits 2 hours
 * after the *last* touch before claiming the job, on the assumption that
 * the photographer is still uploading. Operators previously had no way to
 * see this — Joseph reported "I added images to 46 Brays, no idea if it
 * was detected and no idea when ingest will fire."
 *
 * Data source: shortlisting_jobs JOIN projects via project_id. RLS allows
 * master_admin / admin / manager / employee SELECT.
 *
 * Two refresh cadences:
 *   - useQuery: 30s — picks up new pending jobs + status flips when the
 *     dispatcher claims them.
 *   - Ticking countdown: 1s — purely client-side recomputation against the
 *     cached scheduled_for; no network.
 *
 * Empty state: when no ingests are pending (the common case mid-day), the
 * widget collapses to a single line of muted copy.
 */
import React, { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Clock, FolderClock, RefreshCw, AlertTriangle } from "lucide-react";

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

export default function PendingIngestsWidget() {
  const qc = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick the local clock every second so countdowns advance without re-fetching.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data, isLoading, error, isFetching, refetch } = useQuery({
    queryKey: ["pending-ingest-jobs"],
    queryFn: async () => {
      // Embedded select: shortlisting_jobs → projects (FK project_id).
      const { data: rows, error: err } = await api
        .from("shortlisting_jobs")
        .select(
          "id, project_id, kind, status, scheduled_for, created_at, payload, " +
            "project:projects!inner(id, property_address, property_suburb, dropbox_root_path)",
        )
        .eq("kind", "ingest")
        .eq("status", "pending")
        .order("scheduled_for", { ascending: true });
      if (err) throw err;
      return Array.isArray(rows) ? rows : [];
    },
    refetchInterval: POLL_INTERVAL_MS,
    staleTime: 15_000,
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

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          A 2-hour Dropbox-touch debounce delays ingest until the photographer
          stops uploading. Each row below shows when ingest will auto-fire.
        </p>

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
            No pending ingests. Folders without a 2h-old debounce timer have
            either already fired or never received a Dropbox touch.
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
                  <div className="col-span-6 truncate">
                    <div className="font-medium truncate" title={address}>
                      {address}
                    </div>
                    {suburb && (
                      <div className="text-[10px] text-muted-foreground truncate">
                        {suburb}
                      </div>
                    )}
                  </div>
                  <div className="col-span-3 text-[11px] text-muted-foreground">
                    last touch:{" "}
                    {lastTouchedMs != null ? (
                      <span title={new Date(lastTouchedMs).toISOString()}>
                        {formatAgo(nowMs - lastTouchedMs)}
                      </span>
                    ) : (
                      <span className="italic">unknown</span>
                    )}
                  </div>
                  <div className="col-span-3 text-right font-mono tabular-nums">
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
                </div>
              );
            })}
          </div>
        )}

        <p className="text-[10px] text-muted-foreground italic pt-1">
          Dispatcher claims pending jobs every 2 minutes whose{" "}
          <code className="text-[10px]">scheduled_for</code> ≤ now. Polling
          every 30s; countdowns tick every second.
        </p>
      </CardContent>
    </Card>
  );
}

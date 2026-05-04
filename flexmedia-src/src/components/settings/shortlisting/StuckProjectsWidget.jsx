/**
 * StuckProjectsWidget — Shortlisting Command Center.
 *
 * Lists projects that COULD have files in their `Photos/Raws/Shortlist Proposed/`
 * Dropbox folder but are NOT currently waiting on a pending ingest.  Helps
 * operators spot projects where the dropbox-webhook → enqueue chain
 * silently failed (stale `dropbox_sync_state` cursor, debounce confusion,
 * or the photographer just uploaded the moment we check).
 *
 * Why this exists (Joseph 2026-05-04):
 *   "yes add to command center" — complementing the per-project
 *   DropboxFolderProbeWidget so operators see stuck projects from the
 *   global view.
 *
 * Cheap candidate query (no Dropbox API calls until operator clicks
 * "Probe"):
 *   - projects where shortlist_status IS NULL OR != 'locked'
 *   - AND shoot has happened (shoot_date <= today, if set)
 *   - AND status not in cancelled/lost/archived
 *   - AND has photos_raws_shortlist_proposed folder provisioned
 *   - AND NO pending shortlisting_jobs row (kind='ingest', status='pending')
 *   - AND NO actively-running round (status='processing' or 'pending')
 *
 * Then per-row a "Probe" button that calls shortlisting-folder-probe with
 * action='probe' and renders the file count + Detect now inline.
 *
 * Master_admin-only "Probe all" button at the top for operators who
 * want to scan the whole list.  Cost: 1 Dropbox API call per project,
 * sequenced (not parallel) to avoid 429s.
 */
import React, { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
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
  Loader2,
  ExternalLink,
} from "lucide-react";
import { Link } from "react-router-dom";
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
  return `${Math.floor(hr / 24)}d ago`;
}

export default function StuckProjectsWidget() {
  const queryClient = useQueryClient();
  const { isMasterAdmin } = usePermissions() ?? {};

  // Per-project probe results, keyed by project_id.  null = not probed
  // yet, undefined = same, otherwise object with file_count etc.
  const [probeByProject, setProbeByProject] = useState({});
  const [probingId, setProbingId] = useState(null);
  const [probingAll, setProbingAll] = useState(false);

  // Candidate query: projects that COULD have stuck files.
  const candidatesQuery = useQuery({
    queryKey: ["stuck_projects_candidates"],
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    queryFn: async () => {
      // 1. Projects in active pipeline (not cancelled/lost/delivered),
      //    with a provisioned photos_raws_shortlist_proposed folder.
      //    We pull last 200 most-recent-shoot projects to keep the list
      //    bounded — a busy studio could have hundreds of "active"
      //    projects but this widget targets recent shoots.
      const { data: projects, error: pErr } = await supabase
        .from("projects")
        .select(
          "id, title, property_address, shoot_date, status, shortlist_status, project_type_name",
        )
        .in("status", [
          "scheduled",
          "onsite",
          "uploaded",
          "submitted",
          "in_progress",
          "in_production",
          "partially_delivered",
          "in_revision",
        ])
        .order("shoot_date", { ascending: false, nullsFirst: false })
        .limit(200);
      if (pErr) throw pErr;
      if (!projects || projects.length === 0) return [];

      const projectIds = projects.map((p) => p.id);

      // 2. Filter to those with photos_raws_shortlist_proposed folder.
      const { data: folders } = await supabase
        .from("project_folders")
        .select("project_id")
        .eq("folder_kind", "photos_raws_shortlist_proposed")
        .in("project_id", projectIds);
      const provisioned = new Set((folders || []).map((f) => f.project_id));

      // 3. Pull pending ingest jobs for these projects (excluded).
      const { data: pending } = await supabase
        .from("shortlisting_jobs")
        .select("project_id")
        .in("project_id", projectIds)
        .eq("kind", "ingest")
        .eq("status", "pending");
      const hasPending = new Set((pending || []).map((j) => j.project_id));

      // 4. Pull active rounds (processing/pending) for these projects (excluded).
      const { data: activeRounds } = await supabase
        .from("shortlisting_rounds")
        .select("project_id, status")
        .in("project_id", projectIds)
        .in("status", ["pending", "processing"]);
      const hasActiveRound = new Set(
        (activeRounds || []).map((r) => r.project_id),
      );

      // Filter
      const candidates = projects.filter(
        (p) =>
          provisioned.has(p.id) &&
          !hasPending.has(p.id) &&
          !hasActiveRound.has(p.id),
      );
      return candidates;
    },
  });

  const probeOne = async (projectId) => {
    setProbingId(projectId);
    try {
      const resp = await api.functions.invoke("shortlisting-folder-probe", {
        project_id: projectId,
        action: "probe",
      });
      const result = resp?.data ?? resp ?? {};
      setProbeByProject((prev) => ({ ...prev, [projectId]: result }));
      return result;
    } catch (err) {
      const errResult = { ok: false, error: err?.message || "Probe failed" };
      setProbeByProject((prev) => ({ ...prev, [projectId]: errResult }));
      return errResult;
    } finally {
      setProbingId(null);
    }
  };

  const probeAll = async () => {
    if (!isMasterAdmin || !candidatesQuery.data) return;
    setProbingAll(true);
    try {
      // Sequenced (not parallel) to keep Dropbox API rate-limit-friendly.
      for (const c of candidatesQuery.data) {
        await probeOne(c.id);
      }
      toast.success(
        `Probed ${candidatesQuery.data.length} project(s) — see file counts inline.`,
      );
    } finally {
      setProbingAll(false);
    }
  };

  const detectNow = useMutation({
    mutationFn: async (projectId) => {
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
      toast.success(
        `Detect now → enqueued. Cron picks it up on next minute tick.`,
      );
      queryClient.invalidateQueries({
        queryKey: ["shortlisting_jobs_pending_ingest"],
      });
      queryClient.invalidateQueries({
        queryKey: ["stuck_projects_candidates"],
      });
    },
    onError: (err) => {
      toast.error(err?.message || "Detect now failed");
    },
  });

  const candidates = candidatesQuery.data || [];
  // Sort: probed-with-files first (most actionable), then unprobed,
  // then probed-empty (least interesting).
  const sortedCandidates = useMemo(() => {
    const filesFirst = (p) => {
      const probe = probeByProject[p.id];
      if (probe?.file_count > 0) return 0;
      if (!probe) return 1;
      return 2;
    };
    return [...candidates].sort((a, b) => {
      const ra = filesFirst(a);
      const rb = filesFirst(b);
      if (ra !== rb) return ra - rb;
      // Same rank → most-recent shoot first.
      const ad = a.shoot_date || "";
      const bd = b.shoot_date || "";
      return bd.localeCompare(ad);
    });
  }, [candidates, probeByProject]);

  const totalFilesFound = useMemo(
    () =>
      Object.values(probeByProject).reduce(
        (sum, p) => sum + (p?.file_count ?? 0),
        0,
      ),
    [probeByProject],
  );
  const projectsWithFiles = useMemo(
    () =>
      Object.values(probeByProject).filter((p) => (p?.file_count ?? 0) > 0)
        .length,
    [probeByProject],
  );

  if (candidatesQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground animate-pulse">
            <CloudDownload className="h-3.5 w-3.5" />
            Loading candidate projects…
          </div>
        </CardContent>
      </Card>
    );
  }

  if (candidates.length === 0) {
    return null; // hide entirely when nothing to show
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-sm font-semibold flex items-center gap-2">
              <CloudDownload className="h-4 w-4" />
              Projects without pending ingest
              <Badge variant="secondary" className="text-[10px]">
                {candidates.length}
              </Badge>
            </div>
            <div className="text-[11px] text-muted-foreground mt-0.5">
              Active projects with provisioned Dropbox folders but no
              pending ingest + no running round. Click <strong>Probe</strong>{" "}
              on any row to check Dropbox directly — surfaces files the
              webhook chain may have missed.
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isMasterAdmin && candidates.length > 0 ? (
              <Button
                size="sm"
                variant="outline"
                onClick={probeAll}
                disabled={probingAll}
                className="text-[11px]"
                title={`Probe all ${candidates.length} projects (sequential, ~${candidates.length}s)`}
              >
                {probingAll ? (
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                ) : (
                  <CloudDownload className="h-3 w-3 mr-1" />
                )}
                Probe all
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => candidatesQuery.refetch()}
              disabled={candidatesQuery.isFetching}
              className="text-[11px]"
              title="Refresh candidate list"
            >
              <RefreshCw
                className={`h-3 w-3 ${candidatesQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
        </div>

        {/* Aggregate badge once probing has happened */}
        {Object.keys(probeByProject).length > 0 ? (
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground border-t pt-2">
            <FileImage className="h-3 w-3" />
            Probed {Object.keys(probeByProject).length} of {candidates.length}{" "}
            ·{" "}
            <span className="font-semibold text-foreground">
              {projectsWithFiles}
            </span>{" "}
            with files ·{" "}
            <span className="font-semibold text-foreground tabular-nums">
              {totalFilesFound}
            </span>{" "}
            total RAWs detected
          </div>
        ) : null}

        {/* Candidates list */}
        <div className="divide-y">
          {sortedCandidates.map((p) => {
            const probe = probeByProject[p.id];
            const fileCount = probe?.file_count ?? null;
            const totalBytes = probe?.total_bytes ?? null;
            const latestModified = probe?.latest_modified ?? null;
            const probeError = probe?.list_error || probe?.error || null;
            const hasProbed = !!probe;
            const hasFiles = (fileCount ?? 0) > 0;
            const isProbingThis = probingId === p.id;

            return (
              <div
                key={p.id}
                className={`flex items-center gap-2 py-2 first:pt-0 last:pb-0 ${
                  hasFiles
                    ? "bg-emerald-50/40 dark:bg-emerald-950/20 -mx-4 px-4"
                    : ""
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      to={`/ProjectDetails?id=${p.id}&tab=shortlisting`}
                      className="text-sm font-medium hover:underline truncate"
                    >
                      {p.title || p.property_address || p.id}
                    </Link>
                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                    {p.project_type_name ? (
                      <Badge variant="outline" className="text-[10px] py-0 h-4 shrink-0">
                        {p.project_type_name}
                      </Badge>
                    ) : null}
                  </div>
                  {/* Probe result inline */}
                  {hasProbed ? (
                    <div className="text-[11px] mt-0.5 flex items-center gap-2 flex-wrap">
                      {hasFiles ? (
                        <>
                          <span className="font-semibold text-emerald-700 tabular-nums">
                            {fileCount} RAW
                            {fileCount === 1 ? "" : "s"}
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span className="text-muted-foreground tabular-nums">
                            {formatBytes(totalBytes)}
                          </span>
                          {latestModified ? (
                            <>
                              <span className="text-muted-foreground">·</span>
                              <span
                                className="text-muted-foreground"
                                title={latestModified}
                              >
                                latest {formatRelativeAgo(latestModified)}
                              </span>
                            </>
                          ) : null}
                        </>
                      ) : probeError ? (
                        <span className="text-amber-700">{probeError}</span>
                      ) : (
                        <span className="text-muted-foreground">
                          Empty — no RAWs in folder.
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="text-[11px] text-muted-foreground/60 mt-0.5">
                      {p.shoot_date
                        ? `Shoot: ${new Date(p.shoot_date).toLocaleDateString()}`
                        : "No shoot date set"}
                    </div>
                  )}
                </div>
                {/* Action button(s) */}
                <div className="flex items-center gap-1 shrink-0">
                  {!hasProbed ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => probeOne(p.id)}
                      disabled={isProbingThis}
                      className="h-6 text-[11px] px-2"
                    >
                      {isProbingThis ? (
                        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                      ) : (
                        <CloudDownload className="h-3 w-3 mr-1" />
                      )}
                      Probe
                    </Button>
                  ) : hasFiles && isMasterAdmin ? (
                    <Button
                      size="sm"
                      variant="default"
                      onClick={() => detectNow.mutate(p.id)}
                      disabled={detectNow.isLoading}
                      className="h-6 text-[11px] px-2"
                    >
                      <Zap className="h-3 w-3 mr-1" />
                      Detect now
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => probeOne(p.id)}
                      disabled={isProbingThis}
                      className="h-6 text-[11px] px-2"
                      title="Re-probe"
                    >
                      <RefreshCw
                        className={`h-3 w-3 ${isProbingThis ? "animate-spin" : ""}`}
                      />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

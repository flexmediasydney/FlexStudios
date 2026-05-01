/**
 * FinalsQADashboard — Wave 15a operator surface for the internal finals QA pass.
 *
 * Spec: docs/design-specs/W11-universal-vision-response-schema-v2.md §8 +
 *       docs/WAVE_PLAN.md Wave 15.
 *
 * URL: /FinalsQADashboard
 * Permission: master_admin only.
 *
 * What it does:
 *   1. Lists Delivered projects with a Photos/Finals folder.
 *   2. Lets master_admin trigger `shortlisting-finals-qa` on a project's full
 *      finals folder ("Run Finals QA").
 *   3. Surfaces per-row classification results for the project's finals:
 *        - thumbnail (from getDropboxFilePreview)
 *        - filename
 *        - room_type / image_type
 *        - window_blowout_severity (finals_specific)
 *        - sky_replaced + halo severity (finals_specific)
 *        - digital_furniture_present + artefact severity
 *        - retouch_artefact_severity
 *        - flag_for_retouching + retouch_priority
 *        - the editor-relevant analysis snippet
 *   4. Filters: project, severity threshold, has-issues only.
 *
 * Style mirrors CalibrationDashboard.jsx.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertTriangle,
  CheckCircle2,
  PlayCircle,
  Loader2,
  Activity,
  Image as ImageIcon,
  Sun,
  Cloud,
  Sofa,
  Sparkles,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ─── Helpers ────────────────────────────────────────────────────────────────

function fmtNum(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(digits);
}

function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(new Date(iso), { addSuffix: true });
  } catch {
    return iso;
  }
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "$0.00";
  return `$${Number(n).toFixed(4)}`;
}

function pathBasename(p) {
  if (!p) return "";
  const ix = p.lastIndexOf("/");
  return ix === -1 ? p : p.slice(ix + 1);
}

/** Severity tone (0-10 scores). */
function severityTone(value) {
  if (value == null) return "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400";
  const n = Number(value);
  if (n >= 7) return "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-300";
  if (n >= 4) return "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300";
  if (n >= 1) return "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300";
  return "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300";
}

function priorityTone(p) {
  if (p === "urgent") return "bg-red-100 text-red-800 border-red-200 dark:bg-red-950/30 dark:text-red-300 dark:border-red-900";
  if (p === "recommended") return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900";
  return "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700";
}

// ─── Query hooks ────────────────────────────────────────────────────────────

/** All Delivered projects with a non-null dropbox_root_path. */
function useDeliveredProjects() {
  return useQuery({
    queryKey: ["finals_qa_delivered_projects"],
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("projects")
        .select("id, title, property_address, status, dropbox_root_path, updated_at")
        .eq("status", "delivered")
        .not("dropbox_root_path", "is", null)
        .order("updated_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 60_000,
  });
}

/** Latest finals_qa_runs row per project (status / count / cost). */
function useLatestQaRunsByProject(projectIds) {
  return useQuery({
    queryKey: ["finals_qa_latest_runs", projectIds.sort().join(",")],
    enabled: projectIds.length > 0,
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("finals_qa_runs")
        .select("id, project_id, status, started_at, finished_at, finals_count, successes, failures, total_cost_usd, run_kind")
        .in("project_id", projectIds)
        .order("started_at", { ascending: false });
      if (error) throw new Error(error.message);
      // Keep only the LATEST row per project_id (data is pre-sorted DESC).
      const out = {};
      for (const r of data || []) {
        if (!out[r.project_id]) out[r.project_id] = r;
      }
      return out;
    },
    staleTime: 10_000,
    refetchInterval: (data) => {
      // Refetch faster while any row is still running.
      const running = Object.values(data || {}).some((r) => r.status === "running");
      return running ? 5_000 : 30_000;
    },
  });
}

/** All finals classifications for a single project (source_type='internal_finals'). */
function useFinalsRows(projectId) {
  return useQuery({
    queryKey: ["finals_qa_classifications", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("composition_classifications")
        .select(
          "id, group_id, project_id, classified_at, analysis, room_type, image_type, " +
            "signal_scores, finals_specific, retouch_priority, retouch_estimate_minutes, " +
            "flag_for_retouching, gallery_position_hint, source_type, schema_version, " +
            "technical_score, lighting_score, composition_score, aesthetic_score, combined_score",
        )
        .eq("project_id", projectId)
        .eq("source_type", "internal_finals")
        .order("classified_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
    staleTime: 10_000,
  });
}

/** Resolve filename → dropbox path map by joining the latest run's finals_paths jsonb. */
function useFinalsPathLookup(projectId) {
  return useQuery({
    queryKey: ["finals_qa_path_lookup", projectId],
    enabled: Boolean(projectId),
    queryFn: async () => {
      const { data, error } = await api.supabase
        .from("finals_qa_runs")
        .select("finals_paths")
        .eq("project_id", projectId)
        .order("started_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(error.message);
      const paths = (data?.[0]?.finals_paths) || [];
      const lookup = {};
      for (const p of paths) {
        const name = pathBasename(p);
        if (name) lookup[name] = p;
      }
      return lookup;
    },
    staleTime: 60_000,
  });
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SeverityChip({ icon: Icon, label, value, suffix = "" }) {
  if (value == null) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums",
        severityTone(value),
      )}
      title={`${label}: ${value}${suffix}`}
    >
      <Icon className="h-3 w-3" />
      <span>{label}</span>
      <span className="font-mono">{value}{suffix}</span>
    </span>
  );
}

function FinalsThumbnail({ path }) {
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.functions.invoke("getDropboxFilePreview", { filePath: path });
        const link = res?.data?.url ?? res?.url ?? null;
        if (!cancelled && link) setUrl(link);
        else if (!cancelled) setError("no preview");
      } catch (err) {
        if (!cancelled) setError(err?.message || "preview failed");
      }
    })();
    return () => { cancelled = true; };
  }, [path]);

  if (error) {
    return (
      <div className="w-32 h-20 bg-slate-100 dark:bg-slate-800 rounded flex items-center justify-center text-[10px] text-muted-foreground">
        {error}
      </div>
    );
  }
  if (!url) {
    return <Skeleton className="w-32 h-20" />;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="block">
      <img
        src={url}
        alt={pathBasename(path) || "finals"}
        className="w-32 h-20 object-cover rounded border border-slate-200 dark:border-slate-700"
        loading="lazy"
      />
    </a>
  );
}

function FinalsRow({ row, pathLookup }) {
  const finals = row.finals_specific || {};
  const sig = row.signal_scores || {};
  // The classification row stores group_id (synthetic). We resolve the file
  // path via the latest finals_qa_runs.finals_paths jsonb keyed by the
  // analysis's first observed filename hint — but since the v2 schema doesn't
  // emit a delivery_path back, we rely on order-of-classification + the runs
  // row's path snapshot. Fall back to "—" if we can't find a match.
  const possibleNames = useMemo(() => {
    if (!pathLookup) return [];
    return Object.keys(pathLookup);
  }, [pathLookup]);
  // Best-effort: when row.analysis text mentions one of the filenames, link it.
  const matchedName = possibleNames.find((n) =>
    row.analysis && row.analysis.toLowerCase().includes(n.toLowerCase()),
  );
  const matchedPath = matchedName ? pathLookup?.[matchedName] : null;

  const hasIssue =
    row.flag_for_retouching ||
    Number(finals.window_blowout_severity || 0) >= 4 ||
    Number(finals.sky_replacement_halo_severity || 0) >= 4 ||
    Number(finals.digital_furniture_artefact_severity || 0) >= 4 ||
    Number(finals.retouch_artefact_severity || 0) >= 4;

  return (
    <div
      className={cn(
        "border rounded p-3 grid grid-cols-1 lg:grid-cols-[8rem_1fr] gap-3",
        hasIssue ? "border-amber-300 dark:border-amber-700/60" : "border-slate-200 dark:border-slate-700",
      )}
    >
      <div className="flex-shrink-0">
        {matchedPath ? (
          <FinalsThumbnail path={matchedPath} />
        ) : (
          <div className="w-32 h-20 bg-slate-100 dark:bg-slate-800 rounded flex items-center justify-center">
            <ImageIcon className="h-6 w-6 text-muted-foreground" />
          </div>
        )}
        <div className="text-[10px] text-muted-foreground mt-1 truncate" title={matchedName}>
          {matchedName || row.group_id?.slice(0, 8)}
        </div>
      </div>
      <div className="space-y-2 min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {row.image_type || "—"}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {row.room_type || "—"}
          </Badge>
          <Badge
            className={cn("text-[10px] border", priorityTone(row.retouch_priority))}
          >
            {row.retouch_priority || "—"}
          </Badge>
          {row.flag_for_retouching ? (
            <Badge className="text-[10px] bg-red-100 text-red-800 dark:bg-red-950/40 dark:text-red-300">
              flag_for_retouching
            </Badge>
          ) : null}
          {row.retouch_estimate_minutes != null && (
            <span className="text-[10px] text-muted-foreground tabular-nums">
              ~{row.retouch_estimate_minutes} min
            </span>
          )}
          <span className="text-[10px] text-muted-foreground tabular-nums ml-auto">
            combined {fmtNum(row.combined_score)}
          </span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <SeverityChip
            icon={Sun}
            label="blowout"
            value={finals.window_blowout_severity}
          />
          <SeverityChip
            icon={Cloud}
            label="sky halo"
            value={finals.sky_replaced ? finals.sky_replacement_halo_severity ?? 0 : null}
          />
          <SeverityChip
            icon={Sofa}
            label="dig furniture"
            value={finals.digital_furniture_present ? finals.digital_furniture_artefact_severity ?? 0 : null}
          />
          <SeverityChip
            icon={Sparkles}
            label="retouch artefact"
            value={finals.retouch_artefact_severity}
          />
          {finals.color_grade_consistent_with_set === false && (
            <Badge className="text-[10px] bg-amber-100 text-amber-800">
              colour grade off-set
            </Badge>
          )}
          {finals.vertical_lines_corrected === false && (
            <Badge className="text-[10px] bg-amber-100 text-amber-800">
              verticals not corrected
            </Badge>
          )}
        </div>

        <p className="text-xs text-muted-foreground line-clamp-3">
          {row.analysis || "—"}
        </p>

        <div className="text-[10px] text-muted-foreground tabular-nums flex flex-wrap gap-3">
          <span>tech {fmtNum(row.technical_score)}</span>
          <span>light {fmtNum(row.lighting_score)}</span>
          <span>comp {fmtNum(row.composition_score)}</span>
          <span>aest {fmtNum(row.aesthetic_score)}</span>
          {sig.exposure_balance != null && <span>· exposure {sig.exposure_balance}</span>}
          {sig.plumb_verticals != null && <span>· verticals {sig.plumb_verticals}</span>}
          <span className="ml-auto">
            v{row.schema_version || "?"} · {fmtTime(row.classified_at)}
          </span>
        </div>
      </div>
    </div>
  );
}

function ProjectRow({ project, latestRun, onRunQa, isRunning }) {
  const isPending = latestRun?.status === "running";
  return (
    <Card>
      <CardContent className="p-3 flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium truncate">
            {project.title || project.property_address || project.id?.slice(0, 8)}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {project.dropbox_root_path}
          </div>
        </div>
        <div className="text-[11px] text-muted-foreground tabular-nums hidden md:block">
          {latestRun ? (
            <>
              {latestRun.successes ?? 0}/{latestRun.finals_count ?? 0} ·{" "}
              {fmtUsd(latestRun.total_cost_usd)} · {fmtTime(latestRun.started_at)}
            </>
          ) : (
            <span className="italic">no QA run yet</span>
          )}
        </div>
        {latestRun?.status && (
          <Badge
            className={cn(
              "text-[10px]",
              latestRun.status === "running" && "bg-amber-100 text-amber-800",
              latestRun.status === "succeeded" && "bg-emerald-100 text-emerald-800",
              latestRun.status === "failed" && "bg-red-100 text-red-800",
              latestRun.status === "partial" && "bg-amber-100 text-amber-800",
            )}
          >
            {latestRun.status === "running" && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
            {latestRun.status}
          </Badge>
        )}
        <Button
          size="sm"
          onClick={() => onRunQa(project.id)}
          disabled={isPending || isRunning}
        >
          {isRunning ? (
            <><Loader2 className="h-3 w-3 mr-1 animate-spin" /> Dispatching</>
          ) : (
            <><PlayCircle className="h-3 w-3 mr-1" /> Run Finals QA</>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function FinalsQADashboard() {
  const queryClient = useQueryClient();
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [severityThreshold, setSeverityThreshold] = useState("0");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [runningProjectId, setRunningProjectId] = useState(null);

  const projectsQuery = useDeliveredProjects();
  const projects = projectsQuery.data || [];
  const projectIds = projects.map((p) => p.id);
  const latestRunsQuery = useLatestQaRunsByProject(projectIds);
  const latestRunsByProject = latestRunsQuery.data || {};

  const finalsQuery = useFinalsRows(selectedProjectId);
  const pathLookupQuery = useFinalsPathLookup(selectedProjectId);
  const allFinals = finalsQuery.data || [];

  const runQaMutation = useMutation({
    mutationFn: async (projectId) => {
      setRunningProjectId(projectId);
      const result = await api.functions.invoke("shortlisting-finals-qa", {
        project_id: projectId,
        all_finals: true,
      });
      if (result?.error) {
        throw new Error(result.error.message || result.error.body?.error || "Run failed");
      }
      return result?.data ?? result;
    },
    onSuccess: (data, projectId) => {
      toast.success(
        `Finals QA dispatched: run_id=${data?.run_id?.slice(0, 8)} (${data?.finals_count} finals)`,
      );
      // Invalidate both the runs and the rows so the UI refreshes.
      queryClient.invalidateQueries({ queryKey: ["finals_qa_latest_runs"] });
      queryClient.invalidateQueries({ queryKey: ["finals_qa_classifications", projectId] });
      setRunningProjectId(null);
      // Auto-select the project to reveal results once they land.
      if (!selectedProjectId) setSelectedProjectId(projectId);
    },
    onError: (err) => {
      toast.error(`Run failed: ${err?.message || err}`);
      setRunningProjectId(null);
    },
  });

  // Filtered + sorted finals: severity threshold + has-issues toggle.
  const filteredFinals = useMemo(() => {
    const threshold = Number(severityThreshold) || 0;
    return allFinals.filter((row) => {
      const finals = row.finals_specific || {};
      const maxSev = Math.max(
        Number(finals.window_blowout_severity || 0),
        Number(finals.sky_replacement_halo_severity || 0),
        Number(finals.digital_furniture_artefact_severity || 0),
        Number(finals.retouch_artefact_severity || 0),
      );
      if (maxSev < threshold) return false;
      if (issuesOnly && !row.flag_for_retouching && maxSev < 4) return false;
      return true;
    });
  }, [allFinals, severityThreshold, issuesOnly]);

  const issueCount = useMemo(() => {
    return allFinals.filter((row) => {
      const f = row.finals_specific || {};
      return (
        row.flag_for_retouching ||
        Number(f.window_blowout_severity || 0) >= 4 ||
        Number(f.sky_replacement_halo_severity || 0) >= 4 ||
        Number(f.digital_furniture_artefact_severity || 0) >= 4 ||
        Number(f.retouch_artefact_severity || 0) >= 4
      );
    }).length;
  }, [allFinals]);

  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-4 md:p-6 space-y-4 max-w-6xl mx-auto">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Activity className="h-5 w-5" />
            Finals QA dashboard
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Wave 15a — feed delivered final JPEGs through Stage 1 with
            <code className="mx-1 px-1 bg-slate-100 dark:bg-slate-800 rounded text-[11px]">
              source_type=&apos;internal_finals&apos;
            </code>
            and surface what the editor missed: blowout, sky-replacement halos,
            digital-furniture artefacts, vertical line drift, retouch artefacts.
          </p>
        </div>

        {/* Project picker / runner */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Delivered projects</CardTitle>
            <CardDescription className="text-xs">
              Click {`"Run Finals QA"`} to scan the project&apos;s
              <code className="mx-1 px-1 bg-slate-100 dark:bg-slate-800 rounded">Photos/Finals</code>
              folder. Cost is ~$0.014 per JPEG.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 max-h-96 overflow-y-auto">
            {projectsQuery.isLoading && <Skeleton className="h-16 w-full" />}
            {projects.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                latestRun={latestRunsByProject[p.id]}
                onRunQa={(pid) => runQaMutation.mutate(pid)}
                isRunning={runningProjectId === p.id}
              />
            ))}
            {!projectsQuery.isLoading && projects.length === 0 && (
              <div className="text-sm text-muted-foreground p-2">
                No delivered projects with a Dropbox folder.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Filters + results */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-end gap-3">
              <div className="flex-1 min-w-[12rem]">
                <Label htmlFor="finals-project" className="text-xs">Project</Label>
                <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                  <SelectTrigger id="finals-project" className="h-8 text-xs">
                    <SelectValue placeholder="Pick a project to view results" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id} className="text-xs">
                        {p.title || p.property_address || p.id.slice(0, 8)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="finals-threshold" className="text-xs">Min severity</Label>
                <Input
                  id="finals-threshold"
                  type="number"
                  min={0}
                  max={10}
                  step={1}
                  value={severityThreshold}
                  onChange={(e) => setSeverityThreshold(e.target.value)}
                  className="h-8 text-xs w-20"
                />
              </div>
              <Button
                variant={issuesOnly ? "default" : "outline"}
                size="sm"
                onClick={() => setIssuesOnly((v) => !v)}
              >
                {issuesOnly ? <CheckCircle2 className="h-3 w-3 mr-1" /> : <AlertTriangle className="h-3 w-3 mr-1" />}
                Has issues only
              </Button>
              {selectedProjectId && (
                <span className="text-[11px] text-muted-foreground tabular-nums ml-auto">
                  {filteredFinals.length} of {allFinals.length} · {issueCount} flagged
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {!selectedProjectId && (
              <div className="text-sm text-muted-foreground py-6 text-center">
                Pick a project above to view its finals classifications.
              </div>
            )}
            {selectedProjectId && finalsQuery.isLoading && <Skeleton className="h-32 w-full" />}
            {selectedProjectId && !finalsQuery.isLoading && filteredFinals.length === 0 && (
              <div className="text-sm text-muted-foreground py-6 text-center">
                No finals classifications match the current filters.
              </div>
            )}
            {filteredFinals.map((row) => (
              <FinalsRow
                key={row.id}
                row={row}
                pathLookup={pathLookupQuery.data}
              />
            ))}
          </CardContent>
        </Card>

        <Card className="border-blue-200 dark:border-blue-900 bg-blue-50/30 dark:bg-blue-950/10">
          <CardContent className="p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">W15a spec:</span>{" "}
            See <code>docs/design-specs/W11-universal-vision-response-schema-v2.md</code> §8 +
            <code className="mx-1">docs/WAVE_PLAN.md</code> Wave 15.
            Edge fn: <code>shortlisting-finals-qa</code>. Tracking table:
            <code className="mx-1">finals_qa_runs</code>. master_admin-gated.
          </CardContent>
        </Card>
      </div>
    </PermissionGuard>
  );
}

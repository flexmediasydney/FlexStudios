/**
 * ProjectDronesTab — Drone Phase 2 Stream K
 *
 * Top-level tab content for the project detail page's "Drones" tab.
 * Layout per IMPLEMENTATION_PLAN_V2.md §6.1:
 *   - Top: shoots list (left ~30%) + shoot detail panel (right ~70%)
 *   - Shoots list: timeline cards (flight start time, image count,
 *     has_nadir_grid badge, status chip, sfm_residual_median_m if known)
 *   - Shoot detail: status pipeline strip then sub-tabs (Shots / Renders)
 *
 * URL state (so a shoot/sub-tab is shareable):
 *   ?shoot=<uuid>           selected shoot id
 *   ?subtab=shots|renders   active sub-tab (default: shots)
 *
 * Data:
 *   - api.entities.DroneShoot.filter({ project_id })
 *   - api.entities.DroneShoot.subscribe()  → invalidate on insert/update for project
 *   - Selected shoot loads shots, renders, latest sfm run lazily
 *
 * Empty state when no shoots exist: explains the upload path.
 */

import { useEffect, useMemo, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { createPageUrl } from "@/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Plane,
  Grid3x3,
  Activity,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Pencil,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import DroneShotsSubtab from "./DroneShotsSubtab";
import DroneRendersSubtab from "./DroneRendersSubtab";

// ── Status pipeline ──────────────────────────────────────────────────────────
// Ordered chain — first 4 are linear ingestion/processing, last 4 are pipeline columns.
const PIPELINE_STAGES = [
  { key: "ingested",          label: "Ingested" },
  { key: "sfm_complete",      label: "SfM" },
  { key: "rendering",         label: "Render" },
  { key: "proposed_ready",    label: "Proposed" },
  { key: "adjustments_ready", label: "Adjustments" },
  { key: "final_ready",       label: "Final" },
];

// Map a shoot.status → "completed" rank (number of stages fully done).
//
// Strip is 6 stages indexed 0-5: Ingested, SfM, Render, Proposed, Adjustments,
// Final. The strip lights stage `i` as DONE when `i + 1 <= rank` and as CURRENT
// when `i + 1 === rank + 1`, so:
//   rank=1 → Ingested DONE, SfM CURRENT
//   rank=2 → Ingested+SfM DONE, Render CURRENT
//   rank=6 → all DONE
//
// #73 fix: previously rendering=1 put Render BEFORE SfM in the strip's done
// state, and sfm_complete collapsed onto the same rank. Re-ordered so SfM
// happens first, and render_failed is mapped explicitly.
function stagesCompleted(status) {
  const rank = {
    ingested:          1, // Ingested DONE; SfM is the current stage
    analysing:         1, // analysis still part of Ingested
    sfm_running:       1, // SfM is the current stage (in progress, not done)
    sfm_complete:      2, // SfM DONE; Render is the current stage
    sfm_failed:        1, // SfM stopped; strip shows SfM as current with failed badge
    rendering:         2, // Render is the current stage (in progress, not done)
    render_failed:     2, // Render stopped; strip stops at Render
    proposed_ready:    3, // Render DONE; Proposed is the current stage
    adjustments_ready: 4, // Proposed DONE; Adjustments is the current stage
    final_ready:       5, // Adjustments DONE; Final is the current stage
    delivered:         6, // all DONE
  };
  return rank[status] ?? 0;
}

const STATUS_CHIP_TONE = {
  ingested:          "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  analysing:         "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  sfm_running:       "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  sfm_complete:      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  sfm_failed:        "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  rendering:         "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  proposed_ready:    "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  adjustments_ready: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  final_ready:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  delivered:         "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const STATUS_LABEL = {
  ingested: "Ingested",
  analysing: "Analysing",
  sfm_running: "SfM running",
  sfm_complete: "SfM complete",
  sfm_failed: "SfM failed",
  rendering: "Rendering",
  proposed_ready: "Proposed ready",
  adjustments_ready: "Adjustments",
  final_ready: "Final ready",
  delivered: "Delivered",
};

// ── URL helpers ──────────────────────────────────────────────────────────────
function readSearchParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
function writeSearchParam(name, value) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(name, value);
    else params.delete(name);
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}`;
    window.history.replaceState(null, "", url);
  } catch {
    /* ignore */
  }
}

// ── Main component ───────────────────────────────────────────────────────────
export default function ProjectDronesTab({ project }) {
  const queryClient = useQueryClient();
  const projectId = project?.id;

  // URL-driven state
  const [selectedShootId, setSelectedShootId] = useState(() =>
    readSearchParam("shoot"),
  );
  const [activeSubtab, setActiveSubtab] = useState(() => {
    const t = readSearchParam("subtab");
    return t === "renders" ? "renders" : "shots";
  });

  // Persist URL on changes
  useEffect(() => {
    writeSearchParam("shoot", selectedShootId);
  }, [selectedShootId]);
  useEffect(() => {
    writeSearchParam("subtab", activeSubtab === "shots" ? null : activeSubtab);
  }, [activeSubtab]);

  // ── Shoots list ────────────────────────────────────────────────────────────
  const shootsKey = ["drone_shoots", projectId];
  const shootsQuery = useQuery({
    queryKey: shootsKey,
    queryFn: async () => {
      const rows = await api.entities.DroneShoot.filter(
        { project_id: projectId },
        "-flight_started_at",
        500,
      );
      return rows || [];
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });

  // Realtime: any DroneShoot insert/update for this project → refresh list
  // (QC3 #1) DELETE events have evt.data === null, so the previous "if data
  // present and project_id mismatched, skip" condition fail-opened: every
  // drone_shoot delete app-wide invalidated this project's list. We now
  // require evt.data to be present AND scope to our project_id; bare
  // deletes for unrelated projects are correctly ignored. (Local deletes
  // initiated from this UI use queryClient.invalidateQueries directly, so
  // we don't lose the refresh path for our own actions.)
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const unsubscribe = api.entities.DroneShoot.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.project_id || evt.data.project_id !== projectId) return;
      queryClient.invalidateQueries({ queryKey: ["drone_shoots", projectId] });
    });
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[ProjectDronesTab] DroneShoot unsubscribe failed:", e);
      }
    };
  }, [projectId, queryClient]);

  const shoots = shootsQuery.data || [];

  // #74: combine the "auto-select most recent" + "clear if-deleted" effects
  // into one. Both used `shoots` in their dep array; refetching produced a new
  // array reference and re-ran both. Now we derive a single signal from
  // `shoots[0]?.id` + a presence-check signature so unrelated array re-renders
  // don't re-trigger this effect.
  const firstShootId = shoots[0]?.id || null;
  const selectedShootStillExists =
    selectedShootId && shoots.some((s) => s.id === selectedShootId);
  useEffect(() => {
    if (!firstShootId) return;
    // Auto-select the most recent shoot if URL didn't pin one
    if (!selectedShootId) {
      setSelectedShootId(firstShootId);
      return;
    }
    // If selected id is no longer in the list (e.g. deleted), fall back to first
    if (!selectedShootStillExists) {
      setSelectedShootId(firstShootId);
    }
  }, [firstShootId, selectedShootId, selectedShootStillExists]);

  const selectedShoot = useMemo(
    () => shoots.find((s) => s.id === selectedShootId) || null,
    [shoots, selectedShootId],
  );

  // ── Latest SfM run for selected shoot ──────────────────────────────────────
  const sfmKey = ["drone_sfm_runs", selectedShootId];
  const sfmQuery = useQuery({
    queryKey: sfmKey,
    queryFn: async () => {
      const rows = await api.entities.DroneSfmRun.filter(
        { shoot_id: selectedShootId },
        "-started_at",
        1,
      );
      return rows?.[0] || null;
    },
    enabled: Boolean(selectedShootId),
    staleTime: 15_000,
  });

  // Realtime SfM updates for status strip
  useEffect(() => {
    if (!selectedShootId) return;
    let active = true;
    const unsubscribe = api.entities.DroneSfmRun.subscribe((evt) => {
      if (!active) return;
      if (evt.data?.shoot_id && evt.data.shoot_id !== selectedShootId) return;
      queryClient.invalidateQueries({ queryKey: ["drone_sfm_runs", selectedShootId] });
    });
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[ProjectDronesTab] DroneSfmRun unsubscribe failed:", e);
      }
    };
  }, [selectedShootId, queryClient]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["drone_shoots", projectId] });
    if (selectedShootId) {
      queryClient.invalidateQueries({ queryKey: ["drone_sfm_runs", selectedShootId] });
    }
  }, [queryClient, projectId, selectedShootId]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No project loaded.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Plane className="h-4 w-4 text-muted-foreground" />
            Drones
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {shoots.length === 0
              ? "No shoots yet"
              : `${shoots.length} shoot${shoots.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* #16: Discoverability — Pin Editor was previously only reachable
              from a PROPOSED render's "Edit" button, leaving operators
              stranded if no proposed renders existed yet. Surface a top-level
              entry point at the shoot scope. Disabled until at least one
              shoot exists. */}
          <Button
            variant="outline"
            size="sm"
            asChild={shoots.length > 0 && Boolean(selectedShootId)}
            disabled={shoots.length === 0 || !selectedShootId}
            title={
              shoots.length === 0
                ? "No shoots yet — upload drone images first"
                : !selectedShootId
                  ? "Select a shoot to edit pins"
                  : "Open the Pin Editor for this shoot"
            }
          >
            {shoots.length > 0 && selectedShootId ? (
              <Link
                to={createPageUrl(
                  `DronePinEditor?project=${projectId}&shoot=${selectedShootId}`,
                )}
              >
                <Pencil className="h-4 w-4 mr-2" />
                Open Pin Editor
              </Link>
            ) : (
              <span className="inline-flex items-center">
                <Pencil className="h-4 w-4 mr-2" />
                Open Pin Editor
              </span>
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={shootsQuery.isFetching}
          >
            {shootsQuery.isFetching ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Error state */}
      {shootsQuery.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            <p className="font-medium">Failed to load drone shoots</p>
            <p className="text-xs mt-0.5">
              {shootsQuery.error.message || "Unknown error"}
            </p>
          </div>
        </div>
      )}

      {/* Empty state — no shoots */}
      {!shootsQuery.isLoading && !shootsQuery.error && shoots.length === 0 && (
        <Card>
          <CardContent className="p-10 flex flex-col items-center text-center gap-3">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <Plane className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">No drone shots uploaded yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                Upload to <code className="text-[11px] font-mono">01_RAW_WORKING/drones/</code>{" "}
                in Dropbox and they'll appear here within a minute.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {shootsQuery.isLoading && (
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 animate-pulse">
              <div className="space-y-2">
                <div className="h-16 bg-muted rounded" />
                <div className="h-16 bg-muted rounded" />
                <div className="h-16 bg-muted rounded" />
              </div>
              <div className="space-y-2">
                <div className="h-12 bg-muted rounded" />
                <div className="h-48 bg-muted rounded" />
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Main split: shoots list + detail */}
      {shoots.length > 0 && (
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] divide-y lg:divide-y-0 lg:divide-x">
              {/* Shoots list */}
              <div className="p-3 lg:max-h-[640px] overflow-y-auto">
                <ShootsList
                  shoots={shoots}
                  selectedShootId={selectedShootId}
                  onSelect={setSelectedShootId}
                />
              </div>

              {/* Shoot detail */}
              <div className="p-3 lg:max-h-[640px] overflow-y-auto">
                {selectedShoot ? (
                  <ShootDetail
                    shoot={selectedShoot}
                    sfmRun={sfmQuery.data || null}
                    activeSubtab={activeSubtab}
                    onSubtabChange={setActiveSubtab}
                    projectId={projectId}
                  />
                ) : (
                  <div className="flex items-center justify-center h-40 text-sm text-muted-foreground">
                    Select a shoot to view details
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── ShootsList ───────────────────────────────────────────────────────────────
function ShootsList({ shoots, selectedShootId, onSelect }) {
  return (
    <div className="space-y-1.5">
      {shoots.map((shoot) => {
        const selected = shoot.id === selectedShootId;
        return (
          <ShootCard
            key={shoot.id}
            shoot={shoot}
            selected={selected}
            onClick={() => onSelect(shoot.id)}
          />
        );
      })}
    </div>
  );
}

function ShootCard({ shoot, selected, onClick }) {
  const flightStart = shoot.flight_started_at;
  const status = shoot.status || "ingested";
  const tone = STATUS_CHIP_TONE[status] || STATUS_CHIP_TONE.ingested;
  const residual = shoot.sfm_residual_median_m;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "w-full text-left rounded-md border px-3 py-2.5 transition-colors",
        selected
          ? "border-primary bg-primary/5"
          : "border-border hover:bg-muted/50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate">
            {flightStart
              ? format(new Date(flightStart), "d MMM yyyy")
              : "Unknown date"}
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {flightStart
              ? format(new Date(flightStart), "h:mm a")
              : "—"}
            {" · "}
            {shoot.image_count ?? 0} {shoot.image_count === 1 ? "shot" : "shots"}
          </div>
        </div>
        <span
          className={cn(
            "text-[10px] font-medium px-1.5 py-0.5 rounded",
            tone,
          )}
        >
          {STATUS_LABEL[status] || status}
        </span>
      </div>
      <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
        {shoot.has_nadir_grid && (
          <Badge variant="secondary" className="text-[10px] h-5 px-1.5">
            <Grid3x3 className="h-2.5 w-2.5 mr-1" />
            Nadir grid
          </Badge>
        )}
        {typeof residual === "number" && (
          <Badge
            variant="outline"
            className="text-[10px] h-5 px-1.5"
            title="SfM median residual (metres)"
          >
            ±{residual.toFixed(2)}m
          </Badge>
        )}
        {shoot.drone_model && (
          <Badge variant="outline" className="text-[10px] h-5 px-1.5">
            {shoot.drone_model}
          </Badge>
        )}
      </div>
    </button>
  );
}

// ── ShootDetail ──────────────────────────────────────────────────────────────
function ShootDetail({ shoot, sfmRun, activeSubtab, onSubtabChange, projectId }) {
  // Plan §4.4: surface a UI warning when the pilot uploaded ≥10 images but
  // <10 of them are nadir-grid (gimbal pitch ≤ -85°). Suggests they skipped
  // the nadir grid step and SfM will fall back to GPS-only renders.
  const NADIR_GRID_MIN_SHOTS = 10;
  const enoughImagesForGrid = (shoot?.image_count ?? 0) >= NADIR_GRID_MIN_SHOTS;
  const missingNadirGrid = enoughImagesForGrid && shoot?.has_nadir_grid === false;
  return (
    <div className="space-y-3">
      {missingNadirGrid && (
        <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 px-3 py-2 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-amber-800 dark:text-amber-200">
            <p className="font-medium">No nadir grid detected</p>
            <p className="mt-0.5 leading-snug">
              This shoot has {shoot.image_count} images but none of them are
              nadir (camera pointing straight down at ≤-85°). SfM needs a
              nadir grid for accurate pose recovery — renders will fall back
              to GPS-only positioning, which is less precise. Re-fly with a
              ~10-image nadir sweep over the property to enable SfM.
            </p>
          </div>
        </div>
      )}
      {/* Status pipeline strip */}
      <PipelineStrip shoot={shoot} sfmRun={sfmRun} />

      {/* Sub-tabs */}
      <Tabs value={activeSubtab} onValueChange={onSubtabChange} className="w-full">
        <TabsList className="grid grid-cols-2 w-full max-w-xs">
          <TabsTrigger value="shots" className="text-xs">
            Shots
          </TabsTrigger>
          <TabsTrigger value="renders" className="text-xs">
            Renders
          </TabsTrigger>
        </TabsList>

        <TabsContent value="shots" className="mt-3">
          <DroneShotsSubtab shoot={shoot} />
        </TabsContent>

        <TabsContent value="renders" className="mt-3">
          <DroneRendersSubtab shoot={shoot} projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── PipelineStrip ────────────────────────────────────────────────────────────
function PipelineStrip({ shoot, sfmRun }) {
  const completedRank = stagesCompleted(shoot.status);
  // #73: surface render_failed in the strip too (was only checking sfm_failed).
  const failed =
    shoot.status === "sfm_failed" || shoot.status === "render_failed";
  const failedLabel =
    shoot.status === "render_failed" ? "Render failed" : "SfM failed";

  return (
    <div className="rounded-md border bg-muted/30 px-3 py-2.5">
      <div className="flex items-center gap-1 overflow-x-auto">
        {PIPELINE_STAGES.map((stage, i) => {
          const done = i + 1 <= completedRank;
          const current = i + 1 === completedRank + 1 && !failed;
          return (
            <div key={stage.key} className="flex items-center">
              <div
                className={cn(
                  "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] whitespace-nowrap",
                  done && "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
                  current && "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
                  !done && !current && "text-muted-foreground",
                )}
              >
                {done ? (
                  <CheckCircle2 className="h-3 w-3" />
                ) : current ? (
                  <Clock className="h-3 w-3" />
                ) : (
                  <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
                )}
                <span className={cn(done && "font-medium")}>{stage.label}</span>
              </div>
              {i < PIPELINE_STAGES.length - 1 && (
                <span className="text-muted-foreground mx-0.5 text-xs">›</span>
              )}
            </div>
          );
        })}
        {failed && (
          <Badge variant="destructive" className="ml-2 text-[10px]">
            <AlertCircle className="h-2.5 w-2.5 mr-1" />
            {failedLabel}
          </Badge>
        )}
      </div>

      {/* Inline detail row */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        {sfmRun?.images_registered != null && (
          <span>
            <Activity className="h-2.5 w-2.5 inline mr-1" />
            {sfmRun.images_registered}/{shoot.image_count ?? 0} registered
          </span>
        )}
        {sfmRun?.residual_median_m != null && (
          <span>±{Number(sfmRun.residual_median_m).toFixed(2)}m residual</span>
        )}
        {sfmRun?.finished_at && (
          <span title={format(new Date(sfmRun.finished_at), "d MMM yyyy, h:mm a")}>
            SfM finished {formatDistanceToNow(new Date(sfmRun.finished_at), { addSuffix: true })}
          </span>
        )}
        {sfmRun?.error_message && (
          <span className="text-red-600 dark:text-red-400 truncate" title={sfmRun.error_message}>
            {sfmRun.error_message}
          </span>
        )}
      </div>
    </div>
  );
}

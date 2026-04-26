/**
 * DroneShotsSubtab — Drone Phase 2 Stream K
 *
 * Read-only EXIF/metadata browser for the shots in a drone shoot.
 *
 * Props: { shoot }
 *
 * Features:
 *   - Filter by shot_role (nadir_grid / orbital / oblique_hero / building_hero / ground_level / unclassified)
 *   - Grid of shot cards with metadata: filename, dji_index, captured_at,
 *     altitude/yaw/pitch, role badge, registered-in-SfM checkmark,
 *     FlightRoll warning if > 10° (gimbal compensation limit)
 *   - Click → detail dialog with full EXIF JSON
 *
 * Thumbnails: rendered via the shared DroneThumbnail component which reuses
 * the existing FlexStudios media-proxy infrastructure (getDeliveryMediaFeed
 * Edge Function + mediaPerf.js LRU cache + concurrency limiter). Lazy-loaded
 * via IntersectionObserver so a 1000-shot shoot doesn't fire 1000 fetches.
 * The detail dialog upgrades to the full-resolution proxy variant for closer
 * inspection.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Image as ImageIcon,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  AlertCircle,
  Info,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import DroneLightbox from "@/components/drone/DroneLightbox";
import DroneStageProgress from "@/components/drone/DroneStageProgress";
import { Zap } from "lucide-react";

const ROLE_LABEL = {
  nadir_grid: "Nadir grid",
  nadir_hero: "Nadir hero",
  orbital: "Orbital",
  oblique_hero: "Oblique hero",
  building_hero: "Building hero",
  ground_level: "Ground",
  unclassified: "Unclassified",
};

const ROLE_TONE = {
  nadir_grid: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  nadir_hero: "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
  orbital: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  oblique_hero: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  building_hero: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  ground_level: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  unclassified: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const FLIGHT_ROLL_LIMIT_DEG = 10;

// Wave 9 S3: pipelineState (from ProjectDronesTab) + onForceFire let the
// empty-state surface a "skip ingest wait" affordance when the shoot has
// zero shots and an ingest job is pending. Both default to null/no-op so
// the page still loads if the parent is older than W9.
export default function DroneShotsSubtab({ shoot, pipelineState = null, onForceFire = null }) {
  const queryClient = useQueryClient();
  const shootId = shoot?.id;
  // Tick once a second so the ingest countdown ("scheduled in 1:23") is live.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const [roleFilter, setRoleFilter] = useState("all");
  const [openShot, setOpenShot] = useState(null);
  // Lightbox: open at a shot index within the currently filtered list.
  const [lightboxIndex, setLightboxIndex] = useState(null);

  // Fetch shots for this shoot
  const shotsKey = ["drone_shots", shootId];
  const shotsQuery = useQuery({
    queryKey: shotsKey,
    queryFn: async () => {
      const rows = await api.entities.DroneShot.filter(
        { shoot_id: shootId },
        "dji_index",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  // Realtime updates for this shoot's shots
  // (QC3 #1) Guard for DELETE events: evt.data is null on deletes. Previous
  // `if (evt.data?.shoot_id && ...)` short-circuited to false → invalidate
  // fired for every drone_shot delete app-wide, not just ones in our shoot.
  // Flip to "skip when shoot_id missing OR mismatched".
  useEffect(() => {
    if (!shootId) return;
    let active = true;
    const unsubscribe = api.entities.DroneShot.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.shoot_id || evt.data.shoot_id !== shootId) return;
      queryClient.invalidateQueries({ queryKey: ["drone_shots", shootId] });
    });
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[DroneShotsSubtab] DroneShot unsubscribe failed:", e);
      }
    };
  }, [shootId, queryClient]);

  const shots = shotsQuery.data || [];

  // Counts by role for the filter pills
  const roleCounts = useMemo(() => {
    const counts = { all: shots.length };
    for (const role of Object.keys(ROLE_LABEL)) counts[role] = 0;
    for (const s of shots) {
      const r = s.shot_role || "unclassified";
      counts[r] = (counts[r] || 0) + 1;
    }
    return counts;
  }, [shots]);

  const filteredShots = useMemo(() => {
    if (roleFilter === "all") return shots;
    return shots.filter((s) => (s.shot_role || "unclassified") === roleFilter);
  }, [shots, roleFilter]);

  if (shotsQuery.isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 animate-pulse">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-32 bg-muted rounded-md" />
        ))}
      </div>
    );
  }

  if (shotsQuery.error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="font-medium">Failed to load shots</p>
          <p className="text-xs mt-0.5">
            {shotsQuery.error.message || "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  if (shots.length === 0) {
    // Wave 9 S3: pipeline-aware empty state. When the ingest stage is
    // pending, surface the upload path + a "Skip wait — ingest now"
    // affordance backed by S2's onForceFire(active_job.id).
    //
    // QC iter 6 C contract fix: RPC stage_key is the bare key 'ingest' (per
    // mig 301:282-375), not 'drone-ingest' (the function_name). And the RPC
    // exposes active_jobs (plural array, sorted running first), not
    // active_job. Old code never matched → "Skip wait" affordance never
    // surfaced and the countdown was always blank.
    const stages = Array.isArray(pipelineState?.stages) ? pipelineState.stages : [];
    const ingestStage = stages.find((s) => s?.stage_key === "ingest");
    const ingestPending = ingestStage?.status === "pending";
    const activeJobs = Array.isArray(pipelineState?.active_jobs) ? pipelineState.active_jobs : [];
    const activeJob = activeJobs[0] || null;
    const ingestJobId =
      ingestStage?.active_job_id ||
      ingestStage?.job_id ||
      (activeJob?.kind === "ingest" ? activeJob.job_id : null);
    const scheduledFor =
      ingestStage?.scheduled_for || activeJob?.scheduled_for || null;
    const secondsUntil = scheduledFor
      ? Math.max(0, Math.ceil((new Date(scheduledFor).getTime() - now) / 1000))
      : null;
    const countdown =
      secondsUntil != null
        ? `${Math.floor(secondsUntil / 60)}:${String(secondsUntil % 60).padStart(2, "0")}`
        : null;

    return (
      <div className="space-y-3">
        {/* In-context compact stage strip — visible even with zero shots
            so the operator sees the pipeline is alive. */}
        {pipelineState && (
          <DroneStageProgress pipelineState={pipelineState} compact />
        )}
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground space-y-3">
            {ingestPending ? (
              <>
                <p>
                  No shots ingested yet. Awaiting Dropbox upload to{" "}
                  <code className="text-[11px] font-mono">/Drones/Raws/Shortlist Proposed/</code>.
                </p>
                <p className="text-xs">
                  Ingest scheduled in {countdown ? <strong>{countdown}</strong> : "a moment"}
                  {" "}— files uploaded in the last 2 minutes are batched.
                </p>
                {ingestJobId && typeof onForceFire === "function" && (
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs"
                      onClick={() => {
                        try {
                          onForceFire(ingestJobId);
                        } catch (err) {
                          console.warn("[DroneShotsSubtab] forceFire threw:", err);
                        }
                      }}
                    >
                      <Zap className="h-3.5 w-3.5 mr-1.5" />
                      Skip wait — ingest now
                    </Button>
                  </div>
                )}
              </>
            ) : (
              <p>No shots indexed yet for this shoot.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Wave 9 S3: compact pipeline-stage strip in-context. Renders
          nothing when pipelineState is null (older parents / loading). */}
      {pipelineState && (
        <DroneStageProgress pipelineState={pipelineState} compact />
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All roles ({roleCounts.all})</SelectItem>
            {Object.keys(ROLE_LABEL).map((r) => (
              <SelectItem key={r} value={r}>
                {ROLE_LABEL[r]} ({roleCounts[r] || 0})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">
          {filteredShots.length} of {shots.length}
        </span>
        {shotsQuery.isFetching && (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        )}
      </div>

      {/* Shots grid */}
      {filteredShots.length === 0 ? (
        <div className="text-center py-10 text-sm text-muted-foreground">
          No shots match this filter.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {filteredShots.map((shot, idx) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              onClick={() => setLightboxIndex(idx)}
              onShowDetails={() => setOpenShot(shot)}
            />
          ))}
        </div>
      )}

      {/* Detail dialog (EXIF / SfM / metadata) */}
      <ShotDetailDialog
        shot={openShot}
        onClose={() => setOpenShot(null)}
      />

      {/* Lightbox — flick through the filtered shots without leaving the page */}
      {lightboxIndex !== null && filteredShots.length > 0 && (
        <DroneLightbox
          items={filteredShots.map((s) => ({
            id: s.id,
            dropbox_path: s.dropbox_path,
            filename: s.filename,
            shot_role: ROLE_LABEL[s.shot_role] || s.shot_role || null,
            ai_recommended: Boolean(s.is_ai_recommended),
            status: null,
          }))}
          initialIndex={Math.min(lightboxIndex, filteredShots.length - 1)}
          groupLabel={
            roleFilter === "all"
              ? "All roles"
              : ROLE_LABEL[roleFilter] || roleFilter
          }
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

// ── ShotCard ─────────────────────────────────────────────────────────────────
// Card body click → lightbox; the small Info button → EXIF / metadata dialog.
function ShotCard({ shot, onClick, onShowDetails }) {
  const role = shot.shot_role || "unclassified";
  const flightRoll = shot.flight_roll;
  const flightRollWarn =
    typeof flightRoll === "number" && Math.abs(flightRoll) > FLIGHT_ROLL_LIMIT_DEG;
  const altitude = shot.relative_altitude;
  const yaw = shot.flight_yaw;
  const pitch = shot.gimbal_pitch;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      className={cn(
        "rounded-md border bg-card text-left overflow-hidden hover:bg-muted/50 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        flightRollWarn && "ring-1 ring-amber-400/60",
      )}
    >
      {/* Thumbnail (lazy, served via existing media-proxy edge function) */}
      <DroneThumbnail
        dropboxPath={shot.dropbox_path}
        mode="thumb"
        alt={shot.filename || "drone shot"}
        aspectRatio="aspect-[4/3]"
      />
      {/* Hidden ImageIcon kept for a11y/icon-fallback parity but suppressed visually */}
      <span className="sr-only">
        <ImageIcon aria-hidden="true" />
      </span>

      {/* Body */}
      <div className="p-2 space-y-1">
        <div className="flex items-start justify-between gap-1">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium truncate" title={shot.filename}>
              {shot.filename || "—"}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {shot.dji_index != null ? `#${shot.dji_index}` : ""}
              {shot.captured_at ? (
                <>
                  {shot.dji_index != null ? " · " : ""}
                  {format(new Date(shot.captured_at), "h:mm:ss a")}
                </>
              ) : null}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 mt-0.5">
            {shot.registered_in_sfm && (
              <CheckCircle2
                className="h-3 w-3 text-emerald-600"
                title="Registered in SfM"
              />
            )}
            {onShowDetails && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onShowDetails();
                }}
                className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-muted"
                title="Show EXIF / metadata"
                aria-label="Show EXIF and metadata"
              >
                <Info className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-wrap">
          <span
            className={cn(
              "text-[9px] px-1 py-0.5 rounded font-medium",
              ROLE_TONE[role] || ROLE_TONE.unclassified,
            )}
          >
            {ROLE_LABEL[role] || role}
          </span>
          {flightRollWarn && (
            <span
              className="text-[9px] px-1 py-0.5 rounded font-medium bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300 flex items-center gap-0.5"
              title={`FlightRoll ${flightRoll.toFixed(1)}° > ±${FLIGHT_ROLL_LIMIT_DEG}° gimbal compensation limit`}
            >
              <AlertTriangle className="h-2.5 w-2.5" />
              Roll {flightRoll.toFixed(1)}°
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 text-[10px] text-muted-foreground tabular-nums">
          {altitude != null && <span title="Relative altitude (m)">↕ {Number(altitude).toFixed(1)}m</span>}
          {yaw != null && <span title="Flight yaw">⤵ {Number(yaw).toFixed(0)}°</span>}
          {pitch != null && <span title="Gimbal pitch">∠ {Number(pitch).toFixed(0)}°</span>}
        </div>
      </div>
    </div>
  );
}

// ── ShotDetailDialog ─────────────────────────────────────────────────────────
function ShotDetailDialog({ shot, onClose }) {
  const open = Boolean(shot);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <ImageIcon className="h-4 w-4" />
            {shot?.filename || "Shot detail"}
          </DialogTitle>
          {shot?.dji_index != null && (
            <DialogDescription className="text-xs">
              DJI index #{shot.dji_index}
              {shot.captured_at && (
                <> · captured {format(new Date(shot.captured_at), "d MMM yyyy, h:mm:ss a")}</>
              )}
            </DialogDescription>
          )}
        </DialogHeader>
        {shot && (
          <div className="space-y-3 max-h-[70vh] overflow-y-auto">
            {/* Larger preview — fetched at proxy quality, lazy-loaded */}
            {shot.dropbox_path && (
              <DroneThumbnail
                dropboxPath={shot.dropbox_path}
                mode="thumb"
                alt={shot.filename || "drone shot preview"}
                aspectRatio="aspect-[3/2]"
                rounded
                className="object-contain bg-black/40"
              />
            )}

            {/* Top fields */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <DetailRow label="Role" value={ROLE_LABEL[shot.shot_role] || shot.shot_role || "—"} />
              <DetailRow
                label="Registered in SfM"
                value={shot.registered_in_sfm ? "Yes" : "No"}
              />
              <DetailRow
                label="Altitude"
                value={shot.relative_altitude != null ? `${Number(shot.relative_altitude).toFixed(2)}m` : "—"}
              />
              <DetailRow
                label="Flight yaw"
                value={shot.flight_yaw != null ? `${Number(shot.flight_yaw).toFixed(2)}°` : "—"}
              />
              <DetailRow
                label="Gimbal pitch"
                value={shot.gimbal_pitch != null ? `${Number(shot.gimbal_pitch).toFixed(2)}°` : "—"}
              />
              <DetailRow
                label="Gimbal roll"
                value={shot.gimbal_roll != null ? `${Number(shot.gimbal_roll).toFixed(2)}°` : "—"}
              />
              <DetailRow
                label="Flight roll"
                value={shot.flight_roll != null ? `${Number(shot.flight_roll).toFixed(2)}°` : "—"}
              />
              <DetailRow label="GPS status" value={shot.gps_status || "—"} />
              <DetailRow
                label="GPS lat/lon"
                value={
                  shot.gps_lat != null && shot.gps_lon != null
                    ? `${Number(shot.gps_lat).toFixed(6)}, ${Number(shot.gps_lon).toFixed(6)}`
                    : "—"
                }
              />
              <DetailRow
                label="Dropbox path"
                value={shot.dropbox_path || "—"}
                mono
              />
            </div>

            {/* SfM pose (#72): show stale/null status next to the heading so
               operators know whether the rendered pose is from the current
               SfM run or a stale one (e.g. after EXIF re-ingest). */}
            <div>
              <p className="text-xs font-semibold mb-1 flex items-center gap-1.5">
                SfM pose
                {shot.sfm_pose && Object.keys(shot.sfm_pose).length > 0 ? (
                  shot.registered_in_sfm ? null : (
                    <span
                      className="text-[9px] px-1 py-0.5 rounded font-medium bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
                      title="Pose was set by an earlier SfM run but the shot is not registered in the current run — likely stale (e.g. after EXIF re-ingest)."
                    >
                      stale
                    </span>
                  )
                ) : (
                  <span
                    className="text-[9px] px-1 py-0.5 rounded font-medium bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                    title="No SfM pose recorded for this shot."
                  >
                    ?
                  </span>
                )}
              </p>
              {shot.sfm_pose && Object.keys(shot.sfm_pose).length > 0 ? (
                <pre className="text-[10px] bg-muted/50 rounded p-2 overflow-x-auto max-h-40">
                  {JSON.stringify(shot.sfm_pose, null, 2)}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No SfM pose stored.
                </p>
              )}
            </div>

            {/* Full EXIF */}
            <div>
              <p className="text-xs font-semibold mb-1">EXIF (raw)</p>
              {shot.exif_raw && Object.keys(shot.exif_raw).length > 0 ? (
                <pre className="text-[10px] bg-muted/50 rounded p-2 overflow-x-auto max-h-80">
                  {JSON.stringify(shot.exif_raw, null, 2)}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground italic">
                  No raw EXIF stored.
                </p>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({ label, value, mono = false }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="text-muted-foreground flex-shrink-0">{label}:</span>
      <span className={cn("min-w-0 truncate", mono && "font-mono text-[10px]")} title={String(value)}>
        {value}
      </span>
    </div>
  );
}

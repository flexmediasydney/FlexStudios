/**
 * DroneShotsSubtab — Drone Phase 2 Stream K
 *
 * Read-only EXIF/metadata browser for the shots in a drone shoot.
 *
 * Props: { shoot }
 *
 * Features:
 *   - Filter by shot_role (nadir_grid / orbital / oblique_hero / ground_level / unclassified)
 *   - Grid of shot cards with metadata: filename, dji_index, captured_at,
 *     altitude/yaw/pitch, role badge, registered-in-SfM checkmark,
 *     FlightRoll warning if > 10° (gimbal compensation limit)
 *   - Click → detail dialog with full EXIF JSON
 *
 * Thumbnails: v1 uses a placeholder (folder icon + filename). Future PR can
 * wire up Dropbox preview proxy once the dropbox_path → thumbnail URL helper
 * exists for drones (Stream G's drone-ingest hasn't shipped that helper yet).
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
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

const ROLE_LABEL = {
  nadir_grid: "Nadir grid",
  orbital: "Orbital",
  oblique_hero: "Oblique hero",
  ground_level: "Ground",
  unclassified: "Unclassified",
};

const ROLE_TONE = {
  nadir_grid: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  orbital: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  oblique_hero: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  ground_level: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  unclassified: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

const FLIGHT_ROLL_LIMIT_DEG = 10;

export default function DroneShotsSubtab({ shoot }) {
  const queryClient = useQueryClient();
  const shootId = shoot?.id;

  const [roleFilter, setRoleFilter] = useState("all");
  const [openShot, setOpenShot] = useState(null);

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
  useEffect(() => {
    if (!shootId) return;
    let active = true;
    const unsubscribe = api.entities.DroneShot.subscribe((evt) => {
      if (!active) return;
      if (evt.data?.shoot_id && evt.data.shoot_id !== shootId) return;
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
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No shots indexed yet for this shoot.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
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
          {filteredShots.map((shot) => (
            <ShotCard
              key={shot.id}
              shot={shot}
              onClick={() => setOpenShot(shot)}
            />
          ))}
        </div>
      )}

      {/* Detail dialog */}
      <ShotDetailDialog
        shot={openShot}
        onClose={() => setOpenShot(null)}
      />
    </div>
  );
}

// ── ShotCard ─────────────────────────────────────────────────────────────────
function ShotCard({ shot, onClick }) {
  const role = shot.shot_role || "unclassified";
  const flightRoll = shot.flight_roll;
  const flightRollWarn =
    typeof flightRoll === "number" && Math.abs(flightRoll) > FLIGHT_ROLL_LIMIT_DEG;
  const altitude = shot.relative_altitude;
  const yaw = shot.flight_yaw;
  const pitch = shot.gimbal_pitch;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border bg-card text-left overflow-hidden hover:bg-muted/50 transition-colors",
        flightRollWarn && "ring-1 ring-amber-400/60",
      )}
    >
      {/* Thumbnail placeholder */}
      <div className="aspect-[4/3] bg-muted/40 flex items-center justify-center text-muted-foreground">
        <ImageIcon className="h-8 w-8 opacity-40" />
      </div>

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
          {shot.registered_in_sfm && (
            <CheckCircle2
              className="h-3 w-3 text-emerald-600 flex-shrink-0 mt-0.5"
              title="Registered in SfM"
            />
          )}
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
    </button>
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
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
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

            {/* SfM pose */}
            {shot.sfm_pose && Object.keys(shot.sfm_pose).length > 0 && (
              <div>
                <p className="text-xs font-semibold mb-1">SfM pose</p>
                <pre className="text-[10px] bg-muted/50 rounded p-2 overflow-x-auto max-h-40">
                  {JSON.stringify(shot.sfm_pose, null, 2)}
                </pre>
              </div>
            )}

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

/**
 * ProjectLocationPage — Drone Phase 7 Stream M
 *
 * Per-project draggable-pin map UI for setting confirmed_lat/lng.
 * Visible: any project member. Editable: master_admin/admin only.
 * Mounted at the URL-style page key "ProjectLocation" (route: /ProjectLocation?id=…).
 *
 * Layout per IMPLEMENTATION_PLAN_V2.md §6.5:
 *  - back-to-project link
 *  - property address heading
 *  - leaflet map with two markers:
 *      * draggable pin   = confirmed_lat/lng (or geocoded fallback for first-set)
 *      * static grey dot = geocoded_lat/lng (origin reference, only when distinct)
 *  - bbox overlay rectangle when drone shoot GPS extents are available
 *  - coords readout + distance from geocoded
 *  - Save / Reset actions (admin+ only)
 *
 * On Save:
 *   - api.entities.Project.update(projectId, { confirmed_lat, confirmed_lng,
 *       confirmed_at, confirmed_by })
 *   - drone_events insert: event_type='confirmed_coord_set'
 *
 * No new map library — uses existing react-leaflet + OpenStreetMap tiles.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { usePermissions, useCurrentUser } from "@/components/auth/PermissionGuard";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, MapPin, Save, RotateCcw, AlertCircle, Loader2, Info } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { createPageUrl } from "@/utils";
import {
  MapContainer,
  TileLayer,
  Marker,
  CircleMarker,
  Rectangle,
  Tooltip as LTooltip,
  useMap,
} from "react-leaflet";
import { LEAFLET_ICON_OPTIONS } from "@/lib/constants";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

// Re-init default Leaflet icon (avoids broken-image marker on bundled builds)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions(LEAFLET_ICON_OPTIONS);

const TILE_LIGHT = "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const SYDNEY = [-33.8688, 151.2093];
const DEFAULT_ZOOM = 18;

// Haversine distance (m) between two lat/lng pairs.
function haversineMeters(a, b) {
  if (!a || !b) return null;
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * R * Math.asin(Math.sqrt(x));
}

function fmtCoord(v) {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : parseFloat(v);
  if (!isFinite(n)) return "—";
  return n.toFixed(6);
}

function fmtMeters(m) {
  if (m === null || m === undefined || !isFinite(m)) return "—";
  if (m < 1) return `${(m * 100).toFixed(0)} cm`;
  if (m < 1000) return `${m.toFixed(1)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}

function parseCoord(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isFinite(n) ? n : null;
}

// Helper: pan map to a center position only when the trigger key changes.
// We deliberately depend on `triggerKey` (e.g. project.id) and NOT on the
// center coords — otherwise dragging the marker would re-snap the map view
// back to the marker on every dragend.
function MapRecenter({ center, zoom, triggerKey }) {
  const map = useMap();
  useEffect(() => {
    if (!center) return;
    map.setView(center, zoom ?? map.getZoom());
    // Defensive: ensure leaflet recalculates size if the parent flex/grid
    // settled after first paint (common cause of "grey tiles" on first load).
    setTimeout(() => { try { map.invalidateSize(); } catch { /* noop */ } }, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey]);
  return null;
}

// Helper: fit map to drone shoot bbox bounds when they appear (lets ops
// confirm the pin sits within the actual flight area without manual zoom).
function FitToBounds({ bounds, triggerKey }) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    try {
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 19 });
    } catch { /* invalid bounds */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerKey]);
  return null;
}

export default function ProjectLocationPage() {
  const [searchParams] = useSearchParams();
  const projectId = searchParams.get("id");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { isAdminOrAbove } = usePermissions();
  const { data: currentUser } = useCurrentUser();

  // Local pin state (lat/lng) for drag interactions.
  const [pinPos, setPinPos] = useState(null);
  const [saving, setSaving] = useState(false);

  // ─── Project fetch ──────────────────────────────────────────────────────
  const projectQuery = useQuery({
    queryKey: ["project_location", projectId],
    queryFn: () => (projectId ? api.entities.Project.get(projectId) : null),
    enabled: !!projectId,
    staleTime: 10 * 1000,
  });

  const project = projectQuery.data || null;
  const geocoded = useMemo(() => {
    const lat = parseCoord(project?.geocoded_lat ?? project?.latitude);
    const lng = parseCoord(project?.geocoded_lng ?? project?.longitude);
    return lat != null && lng != null ? { lat, lng } : null;
  }, [project?.geocoded_lat, project?.geocoded_lng, project?.latitude, project?.longitude]);

  const confirmed = useMemo(() => {
    const lat = parseCoord(project?.confirmed_lat);
    const lng = parseCoord(project?.confirmed_lng);
    return lat != null && lng != null ? { lat, lng } : null;
  }, [project?.confirmed_lat, project?.confirmed_lng]);

  // Initialize pin position from confirmed → geocoded → Sydney fallback.
  useEffect(() => {
    if (!project) return;
    if (confirmed) setPinPos(confirmed);
    else if (geocoded) setPinPos(geocoded);
    else setPinPos({ lat: SYDNEY[0], lng: SYDNEY[1] });
  }, [project?.id, confirmed?.lat, confirmed?.lng, geocoded?.lat, geocoded?.lng]);

  // ─── Drone shoot bbox overlay (optional, helpful for verification) ──────
  const shotsQuery = useQuery({
    queryKey: ["project_location_drone_shots", projectId],
    queryFn: async () => {
      if (!projectId) return [];
      const shoots = await api.entities.DroneShoot.filter({ project_id: projectId }, "-created_at", 50);
      const shootIds = shoots.map((s) => s.id);
      if (shootIds.length === 0) return [];
      // Fetch shots with GPS coords. We only care about the coords; rely on
      // db filtering the most recent shoot's worth of shots.
      return await api.entities.DroneShot.filter(
        { shoot_id: { $in: shootIds.slice(0, 3) } },
        null,
        500,
      );
    },
    enabled: !!projectId,
    staleTime: 60 * 1000,
  });

  const shootBbox = useMemo(() => {
    const shots = shotsQuery.data || [];
    const points = shots
      .map((s) => ({ lat: parseCoord(s.gps_lat), lng: parseCoord(s.gps_lon) }))
      .filter((p) => p.lat != null && p.lng != null);
    if (points.length < 2) return null;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const p of points) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    }
    return [[minLat, minLng], [maxLat, maxLng]];
  }, [shotsQuery.data]);

  // ─── Distance from geocoded ─────────────────────────────────────────────
  const distanceFromGeocoded = useMemo(() => {
    if (!pinPos || !geocoded) return null;
    return haversineMeters(geocoded, pinPos);
  }, [pinPos, geocoded]);

  // ─── Save action ────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!isAdminOrAbove) {
      toast.error("Only admins can change confirmed coordinates.");
      return;
    }
    if (!projectId || !pinPos) return;
    setSaving(true);
    try {
      const before = confirmed
        ? { lat: confirmed.lat, lng: confirmed.lng }
        : null;
      const after = { lat: pinPos.lat, lng: pinPos.lng };
      const distFromGeocoded = geocoded ? haversineMeters(geocoded, pinPos) : null;

      await api.entities.Project.update(projectId, {
        confirmed_lat: pinPos.lat,
        confirmed_lng: pinPos.lng,
        confirmed_at: new Date().toISOString(),
        confirmed_by: currentUser?.id || null,
      });

      // Best-effort drone audit event. Failure here MUST NOT mask the save.
      try {
        await api.entities.DroneEvent.create({
          project_id: projectId,
          event_type: "confirmed_coord_set",
          actor_type: "user",
          actor_id: currentUser?.id || null,
          payload: {
            before,
            after,
            distance_from_geocoded_m: distFromGeocoded,
          },
        });
      } catch (auditErr) {
        console.warn("[ProjectLocationPage] failed to log drone_event:", auditErr);
      }

      toast.success(
        distFromGeocoded != null
          ? `Saved — ${fmtMeters(distFromGeocoded)} from geocoded`
          : "Saved",
      );
      queryClient.invalidateQueries({ queryKey: ["project_location", projectId] });
    } catch (err) {
      console.error("[ProjectLocationPage] save failed:", err);
      toast.error(err?.message || "Failed to save location");
    } finally {
      setSaving(false);
    }
  };

  const handleResetToGeocoded = () => {
    if (!geocoded) {
      toast.error("No geocoded coordinate to reset to.");
      return;
    }
    setPinPos(geocoded);
  };

  // ─── Render guards ──────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="p-6 text-sm">
            <div className="flex items-start gap-2 text-red-600">
              <AlertCircle className="h-4 w-4 mt-0.5" />
              <div>
                <p className="font-medium">No project specified</p>
                <p className="text-muted-foreground">Pass a project id via the URL: <code>?id=…</code></p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (projectQuery.isLoading) {
    return (
      <div className="p-6 max-w-5xl mx-auto space-y-3 animate-pulse">
        <div className="h-4 bg-muted rounded w-32" />
        <div className="h-8 bg-muted rounded w-1/2" />
        <div className="h-[420px] bg-muted/60 rounded" />
        <div className="h-20 bg-muted/40 rounded" />
      </div>
    );
  }

  if (projectQuery.error || !project) {
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <Card>
          <CardContent className="p-6 text-sm">
            <div className="flex items-start gap-2 text-red-600">
              <AlertCircle className="h-4 w-4 mt-0.5" />
              <div>
                <p className="font-medium">Failed to load project</p>
                <p className="text-muted-foreground">{projectQuery.error?.message || "Project not found"}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const mapCenter = pinPos ? [pinPos.lat, pinPos.lng] : SYDNEY;
  const draggable = !!isAdminOrAbove;
  const dirty =
    pinPos &&
    confirmed &&
    (Math.abs(pinPos.lat - confirmed.lat) > 1e-7 ||
      Math.abs(pinPos.lng - confirmed.lng) > 1e-7);
  const dirtyVsGeocoded =
    pinPos &&
    !confirmed &&
    geocoded &&
    (Math.abs(pinPos.lat - geocoded.lat) > 1e-7 ||
      Math.abs(pinPos.lng - geocoded.lng) > 1e-7);
  const canSave = isAdminOrAbove && pinPos && (dirty || dirtyVsGeocoded || !confirmed);

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-3">
      {/* Back link */}
      <div>
        <Link
          to={createPageUrl("ProjectDetails") + `?id=${projectId}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to project
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">Project Location</h1>
          <p className="text-sm text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <MapPin className="h-3.5 w-3.5" />
            {project.property_address || project.title || "Unknown property"}
          </p>
        </div>
        {!isAdminOrAbove && (
          <Badge variant="outline" className="text-[10px]">Read-only</Badge>
        )}
      </div>

      {/* Map */}
      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="h-[460px] w-full relative">
            <MapContainer
              center={mapCenter}
              zoom={DEFAULT_ZOOM}
              scrollWheelZoom={true}
              style={{ height: "100%", width: "100%" }}
              attributionControl={true}
            >
              <TileLayer url={TILE_LIGHT} attribution={TILE_ATTR} />
              <MapRecenter
                center={pinPos ? [pinPos.lat, pinPos.lng] : null}
                triggerKey={project.id}
              />
              {/* When drone bbox arrives (after initial center), pan/zoom to fit. */}
              {shootBbox && (
                <FitToBounds bounds={shootBbox} triggerKey={`${project.id}-bbox-${shotsQuery.dataUpdatedAt}`} />
              )}

              {/* Drone shoot GPS bbox overlay */}
              {shootBbox && (
                <Rectangle
                  bounds={shootBbox}
                  pathOptions={{ color: "#3b82f6", fill: false, weight: 1.5, dashArray: "4 4" }}
                >
                  <LTooltip permanent={false} direction="top" sticky>
                    Drone GPS extent
                  </LTooltip>
                </Rectangle>
              )}

              {/* Static geocoded reference marker (only show if distinct from pin) */}
              {geocoded && (!pinPos ||
                Math.abs(pinPos.lat - geocoded.lat) > 1e-7 ||
                Math.abs(pinPos.lng - geocoded.lng) > 1e-7) && (
                <CircleMarker
                  center={[geocoded.lat, geocoded.lng]}
                  radius={5}
                  pathOptions={{ color: "#6b7280", fillColor: "#9ca3af", fillOpacity: 0.7, weight: 1 }}
                >
                  <LTooltip direction="top">Geocoded (Google)</LTooltip>
                </CircleMarker>
              )}

              {/* Draggable confirmed marker */}
              {pinPos && (
                <Marker
                  position={[pinPos.lat, pinPos.lng]}
                  draggable={draggable}
                  eventHandlers={{
                    dragend: (e) => {
                      const ll = e.target.getLatLng();
                      setPinPos({ lat: ll.lat, lng: ll.lng });
                    },
                  }}
                >
                  <LTooltip direction="top">
                    {confirmed ? "Confirmed (drag to adjust)" : "Drag to set confirmed location"}
                  </LTooltip>
                </Marker>
              )}
            </MapContainer>
          </div>
        </CardContent>
      </Card>

      {/* Coords readout + actions */}
      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Geocoded</p>
              <p className="font-mono tabular-nums mt-0.5">
                {geocoded ? `${fmtCoord(geocoded.lat)}, ${fmtCoord(geocoded.lng)}` : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">via Google geocoder</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Confirmed</p>
              <p className="font-mono tabular-nums mt-0.5">
                {confirmed
                  ? `${fmtCoord(confirmed.lat)}, ${fmtCoord(confirmed.lng)}`
                  : pinPos
                    ? <span className="text-muted-foreground">{fmtCoord(pinPos.lat)}, {fmtCoord(pinPos.lng)} <span className="text-amber-600">(unsaved)</span></span>
                    : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {confirmed && project.confirmed_at
                  ? `set ${new Date(project.confirmed_at).toLocaleString()}`
                  : "not yet set"}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">Pin offset</p>
              <p className={cn(
                "font-mono tabular-nums mt-0.5",
                distanceFromGeocoded != null && distanceFromGeocoded > 50 && "text-amber-600",
              )}>
                {distanceFromGeocoded != null ? fmtMeters(distanceFromGeocoded) : "—"}
              </p>
              <p className="text-[10px] text-muted-foreground">from geocoded</p>
            </div>
          </div>

          {!isAdminOrAbove && (
            <div className="rounded border border-border bg-muted/30 p-2 text-xs text-muted-foreground flex items-start gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5" />
              You can view this location, but only admins can change the confirmed coordinate.
            </div>
          )}

          {isAdminOrAbove && (
            <div className="flex items-center gap-2 flex-wrap">
              <Button onClick={handleSave} disabled={!canSave || saving} size="sm">
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                )}
                {confirmed ? "Save adjusted location" : "Save confirmed location"}
              </Button>
              {geocoded && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleResetToGeocoded}
                  disabled={saving}
                >
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Reset to geocoded
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => navigate(createPageUrl("ProjectDetails") + `?id=${projectId}`)}
              >
                Cancel
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Helpful diagnostic when drone bbox available */}
      {shootBbox && (
        <Card>
          <CardContent className="p-3 text-xs text-muted-foreground flex items-start gap-2">
            <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>
              The dashed blue rectangle shows the GPS extent of recent drone shots for this project — useful for verifying the pin sits within the area the drone actually flew.
            </span>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

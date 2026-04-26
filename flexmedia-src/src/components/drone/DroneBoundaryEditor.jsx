/**
 * DroneBoundaryEditor — Wave 5 Phase 2 Stream S5
 *
 * Full-screen interactive canvas for editing the property boundary polygon
 * + per-overlay tweaks that ride alongside it (side measurements, sqm
 * total, address overlay). Persists to drone_property_boundary via the
 * drone-boundary-save Edge Function; cascades a project-wide re-render of
 * every Edited shoot through the dispatcher.
 *
 * Architecture mirrors <PinEditor />:
 *   - Top toolbar:    Save / Cancel / Reset to NSW DCDB / Undo / Redo
 *   - Centre canvas:  raw HTML <img> in a CSS-transformed wrapper +
 *                     absolutely-positioned draggable vertex handles
 *                     (no Konva — same approach as PinEditor; Joseph's
 *                     plan note about Konva being a PinEditor dep was
 *                     incorrect, package.json doesn't include it)
 *   - Right inspector: 4 sections (Polygon / Side Measurements /
 *                     SQM Total / Address Overlay) per architect spec
 *
 * Drag model:
 *   - Vertex handle drag → updates one vertex via inverse projection
 *     (pixel → ground GPS using the same droneProjection lib PinEditor
 *     uses; pose taken from the first available shot in the project)
 *   - Edge midpoint click → inserts a new vertex
 *   - Vertex right-click / hover-✕ → delete
 *   - Centroid handle drag → translatePolygon (delta in pixels →
 *     converted to dlat/dlng via the local equirectangular approximation)
 *
 * Save flow:
 *   - Build payload via state.buildSaveBody({ projectId })
 *   - POST drone-boundary-save → on 200, markSaved(version) + toast
 *     "Re-rendering N edited shoots — boundary updated"
 *   - On 409 (version_mismatch), surface a confirm dialog with the
 *     server's polygon/version + offer to discard local edits or keep
 *     editing. We expose a `onConflictResolve` callback so the page
 *     wrapper can swap state via the hook's reset() helper.
 *
 * Reset to NSW DCDB:
 *   - POST { action:'reset_to_cadastral' } — server replaces polygon
 *     with cadastral_snapshot, source='cadastral', cascades the same
 *     way. Disabled when no cadastral_snapshot is present (first save
 *     never happened, or DCDB lookup failed).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  Save as SaveIcon,
  Loader2,
  Undo2,
  Redo2,
  RotateCcw,
  AlertCircle,
  Eye,
  EyeOff,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CAMERA_DEFAULTS,
  gpsToPixel,
  pixelToGroundGps,
  poseFromShot,
} from "@/lib/droneProjection";
import useBoundaryEditorState from "@/hooks/useBoundaryEditorState";

const VERTEX_HIT_RADIUS = 14; // px in screen coords
const VERTEX_RADIUS = 8;      // visual radius of the draggable circle

export default function DroneBoundaryEditor({
  // Server-loaded boundary row + polygon (page wrapper resolves these).
  initialBoundary,                // { polygon, source, overrides, savedVersion } shape
  // Source image to draw the polygon over — a rendered Edited JPG (via
  // Dropbox proxy → blob URL).
  imageUrl,
  imageError = null,
  // The shot whose pose drives the gps↔px projection. Page wrapper picks
  // one (typically the first available Edited render's shot).
  poseShot,
  // Project context — passed through on save.
  projectId,
  projectAddress,
  // Whether a cadastral snapshot exists (controls Reset button enable).
  cadastralAvailable = false,
  // Save handler is provided by the page wrapper so it can wire up
  // toast + navigation + cache invalidation. Receives the payload, returns
  // a promise of { ok:boolean, status:number, body:any }.
  onSave,
  // Reset handler — same shape as save but for the reset_to_cadastral path.
  onReset,
  // Cancel/back navigation.
  onCancel,
  // Optional callback fired on a 409-conflict; the page wrapper hands the
  // server's authoritative state back into the hook via reset(...).
  onConflict,
}) {
  // ── Editor state ────────────────────────────────────────────────────────
  const { state, actions, computed } = useBoundaryEditorState(initialBoundary);

  // ── Layout refs ─────────────────────────────────────────────────────────
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  // Canvas-native dimensions of the displayed image. We seed with camera
  // defaults so the first projection isn't off; updated on <img onLoad>.
  // Same caveat as PinEditor #22: when the rendered image is downscaled
  // below camera-native (pose intrinsics still 5280×3956), projected
  // pixels overshoot the displayed extent. We compensate with a uniform
  // scale during render — see `renderXY` below.
  const [imageNatural, setImageNatural] = useState({
    w: CAMERA_DEFAULTS.w,
    h: CAMERA_DEFAULTS.h,
  });
  const [view, setView] = useState({ zoom: 0.3, panX: 0, panY: 0 });
  // Drag state — kind: 'vertex' | 'pan' | 'translate' | 'addr'
  const dragRef = useRef(null);
  const [hoverVertexIdx, setHoverVertexIdx] = useState(null);
  const [hoverEdgeIdx, setHoverEdgeIdx] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [conflict, setConflict] = useState(null); // server payload on 409
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  // Inspector folded sections (for compactness on small screens).
  const [foldedSections, setFoldedSections] = useState(new Set());

  // Pose for projection — from the page wrapper's chosen shot.
  const pose = useMemo(() => poseFromShot(poseShot), [poseShot]);

  // ── Project polygon to pixels ───────────────────────────────────────────
  const polygonPx = useMemo(() => {
    if (!pose || !Array.isArray(state.polygon)) return [];
    const out = [];
    for (let i = 0; i < state.polygon.length; i++) {
      const [lat, lng] = state.polygon[i];
      const p = gpsToPixel({ lat, lng, ...pose });
      // gpsToPixel may return null if behind the focal plane — keep the
      // index slot so edge indexes stay aligned with state.polygon.
      out.push(p);
    }
    return out;
  }, [state.polygon, pose]);

  // ── Fit-to-frame on first image load ────────────────────────────────────
  const fitToFrame = useCallback(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const cw = stage.clientWidth;
    const ch = stage.clientHeight;
    const scaleX = cw / imageNatural.w;
    const scaleY = ch / imageNatural.h;
    const scale = Math.min(scaleX, scaleY) * 0.9;
    setView({
      zoom: Number.isFinite(scale) && scale > 0 ? scale : 0.3,
      panX: (cw - imageNatural.w * scale) / 2,
      panY: (ch - imageNatural.h * scale) / 2,
    });
  }, [imageNatural]);

  useEffect(() => {
    if (!imageLoaded) return;
    fitToFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageLoaded]);

  // ── Helpers — screen↔image coords ───────────────────────────────────────
  const screenToImage = useCallback(
    (sx, sy) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (sx - rect.left - view.panX) / view.zoom,
        y: (sy - rect.top - view.panY) / view.zoom,
      };
    },
    [view],
  );

  const renderXY = useCallback(
    (px) => {
      // px is a {x,y} in camera-native pixel space (same intrinsics as
      // gpsToPixel uses). PinEditor #22 caveat applies — we render in
      // image-native coords because the page-wrapper image sits in the
      // same coordinate space (no extra scale).
      if (!px || !Number.isFinite(px.x) || !Number.isFinite(px.y)) return null;
      return {
        sx: px.x * view.zoom + view.panX,
        sy: px.y * view.zoom + view.panY,
      };
    },
    [view],
  );

  // ── Pointer interaction ────────────────────────────────────────────────
  const onPointerDown = useCallback(
    (e) => {
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Hit test against vertex handles (top-most first)
      let vertexHit = null;
      for (let i = polygonPx.length - 1; i >= 0; i--) {
        const px = polygonPx[i];
        if (!px) continue;
        const r = renderXY(px);
        if (!r) continue;
        if (Math.hypot(sx - r.sx, sy - r.sy) <= VERTEX_HIT_RADIUS) {
          vertexHit = i;
          break;
        }
      }

      // Right-click on a vertex → delete (unless polygon is at minimum 3)
      if (e.button === 2 && vertexHit !== null) {
        e.preventDefault();
        if (state.polygon.length > 3) {
          actions.deleteVertex(vertexHit);
        } else {
          toast.warning("Polygon must have at least 3 vertices");
        }
        return;
      }

      if (vertexHit !== null) {
        dragRef.current = {
          kind: "vertex",
          idx: vertexHit,
          startMouse: { x: e.clientX, y: e.clientY },
          startVertex: state.polygon[vertexHit].slice(),
          // Snapshot the pose so the inverse projection on mouseup uses
          // the same pose that was active at drag start. Mirrors PinEditor #79.
          pose,
          moved: false,
        };
        return;
      }

      // Hit test against edge midpoints — click inserts a new vertex
      let edgeHit = null;
      for (let i = 0; i < polygonPx.length; i++) {
        const a = polygonPx[i];
        const b = polygonPx[(i + 1) % polygonPx.length];
        if (!a || !b) continue;
        const ra = renderXY(a);
        const rb = renderXY(b);
        if (!ra || !rb) continue;
        const mx = (ra.sx + rb.sx) / 2;
        const my = (ra.sy + rb.sy) / 2;
        if (Math.hypot(sx - mx, sy - my) <= VERTEX_HIT_RADIUS) {
          edgeHit = i;
          break;
        }
      }

      if (edgeHit !== null) {
        // Inverse-project the screen midpoint to ground GPS and insert.
        const midScreenX = sx;
        const midScreenY = sy;
        const img = screenToImage(midScreenX + rect.left, midScreenY + rect.top);
        if (pose) {
          const ground = pixelToGroundGps({ px: img.x, py: img.y, ...pose });
          if (ground) {
            actions.addVertex(edgeHit, [ground.lat, ground.lon]);
            return;
          }
        }
        toast.warning(
          "Couldn't insert vertex — pose data unavailable or pixel above horizon",
        );
        return;
      }

      // Default: pan
      dragRef.current = {
        kind: "pan",
        startMouse: { x: e.clientX, y: e.clientY },
        startView: { ...view },
      };
    },
    [actions, polygonPx, pose, renderXY, screenToImage, state.polygon, view],
  );

  const onPointerMove = useCallback(
    (e) => {
      const ds = dragRef.current;
      if (!ds) return;
      if (ds.kind === "pan") {
        const dx = e.clientX - ds.startMouse.x;
        const dy = e.clientY - ds.startMouse.y;
        setView({
          ...ds.startView,
          panX: ds.startView.panX + dx,
          panY: ds.startView.panY + dy,
        });
      } else if (ds.kind === "vertex") {
        const dx = e.clientX - ds.startMouse.x;
        const dy = e.clientY - ds.startMouse.y;
        if (Math.hypot(dx, dy) > 2) ds.moved = true;
        // Live preview — don't write to state on every mousemove (it would
        // explode the undo stack). Instead, store the live pixel target on
        // the dragRef and let render read it via state.polygon[idx] +
        // dragRef.current.previewPx.
        ds.previewPx = {
          x: ds.startVertex /* don't compute here */,
          screenX: e.clientX,
          screenY: e.clientY,
        };
        // Force a re-render of just the vertex layer.
        setHoverVertexIdx((p) => (p === ds.idx ? p : ds.idx));
      }
    },
    [],
  );

  const onPointerUp = useCallback(
    (e) => {
      try {
        e?.currentTarget?.releasePointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      const ds = dragRef.current;
      dragRef.current = null;
      if (!ds) return;
      if (ds.kind === "vertex" && ds.moved) {
        const rect = stageRef.current?.getBoundingClientRect();
        if (!rect) return;
        const img = screenToImage(
          ds.previewPx?.screenX ?? ds.startMouse.x,
          ds.previewPx?.screenY ?? ds.startMouse.y,
        );
        const usePose = ds.pose || pose;
        if (!usePose) {
          toast.warning("Pose data unavailable — vertex not moved");
          return;
        }
        const ground = pixelToGroundGps({
          px: img.x,
          py: img.y,
          ...usePose,
        });
        if (!ground) {
          toast.warning(
            "Pixel above horizon — vertex not moved (move the cursor onto the ground)",
          );
          return;
        }
        actions.setVertex(ds.idx, [ground.lat, ground.lon]);
      }
    },
    [actions, pose, screenToImage],
  );

  const onWheel = useCallback(
    (e) => {
      e.preventDefault();
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const delta = e.deltaY < 0 ? 0.1 : -0.1;
      const nextZoom = Math.max(0.05, Math.min(8, view.zoom * (1 + delta)));
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const ix = (sx - view.panX) / view.zoom;
      const iy = (sy - view.panY) / view.zoom;
      const newPanX = sx - ix * nextZoom;
      const newPanY = sy - iy * nextZoom;
      setView({ zoom: nextZoom, panX: newPanX, panY: newPanY });
    },
    [view],
  );

  // ── Save ────────────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!computed.canSave) return;
    setIsSaving(true);
    try {
      const body = actions.buildSaveBody({ projectId });
      const result = await onSave(body);
      if (result?.ok) {
        actions.markSaved(result?.body?.version ?? state.savedVersion);
      } else if (result?.status === 409) {
        // Conflict — show the server's authoritative state.
        const c = result?.body?.current_row || null;
        setConflict({ version: result.body?.current_version, row: c });
        if (typeof onConflict === "function") onConflict(result.body);
      } else {
        toast.error(
          result?.body?.message ||
            result?.body?.error ||
            "Save failed — check server logs",
        );
      }
    } catch (e) {
      toast.error(e?.message || "Save failed");
    } finally {
      setIsSaving(false);
    }
  }, [actions, computed.canSave, onConflict, onSave, projectId, state.savedVersion]);

  const handleReset = useCallback(async () => {
    if (!cadastralAvailable) return;
    setIsSaving(true);
    setConfirmReset(false);
    try {
      const body = actions.buildSaveBody({ projectId, reset: true });
      const result = await onReset(body);
      if (result?.ok) {
        // The server returns the reset row — re-anchor local state so the
        // canvas redraws against the cadastral polygon.
        const row = result?.body?.row;
        if (row) {
          actions.reset({
            polygon: row.polygon_latlng,
            source: row.source,
            overrides: extractOverridesFromRow(row),
            savedVersion: row.version,
          });
        } else {
          actions.markSaved(result?.body?.version ?? state.savedVersion);
        }
      } else if (result?.status === 409) {
        const c = result?.body?.current_row || null;
        setConflict({ version: result.body?.current_version, row: c });
      } else {
        toast.error(
          result?.body?.message ||
            result?.body?.error ||
            "Reset failed — check server logs",
        );
      }
    } catch (e) {
      toast.error(e?.message || "Reset failed");
    } finally {
      setIsSaving(false);
    }
  }, [actions, cadastralAvailable, onReset, projectId, state.savedVersion]);

  // ── Conflict resolution actions ─────────────────────────────────────────
  const acceptServerVersion = useCallback(() => {
    if (!conflict?.row) return;
    actions.reset({
      polygon: conflict.row.polygon_latlng,
      source: conflict.row.source,
      overrides: extractOverridesFromRow(conflict.row),
      savedVersion: conflict.row.version,
    });
    setConflict(null);
  }, [actions, conflict]);

  // ── Cancel ──────────────────────────────────────────────────────────────
  const handleCancel = useCallback(() => {
    if (state.dirty) {
      setConfirmCancel(true);
      return;
    }
    onCancel?.();
  }, [onCancel, state.dirty]);

  const toggleSection = useCallback((key) => {
    setFoldedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────
  if (imageError) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-background p-8">
        <AlertCircle className="h-10 w-10 text-red-500" />
        <p className="text-sm font-medium">Source image unavailable</p>
        <p className="text-xs text-muted-foreground max-w-md text-center">
          {imageError}
        </p>
        <Button variant="outline" onClick={onCancel} className="gap-1">
          <ArrowLeft className="h-3 w-3" /> Go back
        </Button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      {/* ── Top toolbar ───────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleCancel}
            className="gap-1"
          >
            <ArrowLeft className="h-3 w-3" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="text-sm font-medium truncate">
            Boundary Editor
          </div>
          <Badge
            variant={state.source === "operator" ? "default" : "outline"}
            className="ml-1 text-[10px]"
          >
            {state.source === "operator" ? "Operator" : "Cadastral"}
          </Badge>
          {state.dirty && (
            <Badge variant="secondary" className="text-[10px]">
              Unsaved
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            onClick={actions.undo}
            disabled={!computed.canUndo || isSaving}
            title="Undo"
          >
            <Undo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={actions.redo}
            disabled={!computed.canRedo || isSaving}
            title="Redo"
          >
            <Redo2 className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirmReset(true)}
            disabled={!cadastralAvailable || isSaving}
            title={
              cadastralAvailable
                ? "Reset polygon to NSW cadastral DCDB"
                : "No cadastral snapshot available — save a polygon first to capture one"
            }
            className="gap-1"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            <span className="hidden md:inline">Reset to DCDB</span>
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!computed.canSave || isSaving}
            className="gap-1"
          >
            {isSaving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <SaveIcon className="h-3.5 w-3.5" />
            )}
            <span>Save</span>
          </Button>
        </div>
      </div>

      {/* ── Body: canvas + inspector ─────────────────────────────────── */}
      <div className="flex-1 flex min-h-0">
        {/* Canvas */}
        <div
          ref={stageRef}
          className="relative flex-1 overflow-hidden bg-zinc-900 select-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(e) => e.preventDefault()}
          style={{ touchAction: "none" }}
        >
          {imageUrl ? (
            <img
              ref={imgRef}
              src={imageUrl}
              alt="boundary editor source"
              draggable={false}
              onLoad={(e) => {
                setImageNatural({
                  w: e.target.naturalWidth || CAMERA_DEFAULTS.w,
                  h: e.target.naturalHeight || CAMERA_DEFAULTS.h,
                });
                setImageLoaded(true);
              }}
              style={{
                position: "absolute",
                top: view.panY,
                left: view.panX,
                width: imageNatural.w * view.zoom,
                height: imageNatural.h * view.zoom,
                pointerEvents: "none",
                userSelect: "none",
              }}
            />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading image…
            </div>
          )}

          {/* Polygon overlay — SVG so we get cheap line + circle hit testing
              without having to manage <canvas> redraws ourselves. */}
          {imageLoaded && polygonPx.length >= 3 && (
            <svg
              className="absolute inset-0 pointer-events-none"
              width="100%"
              height="100%"
            >
              <PolygonLines polygonPx={polygonPx} renderXY={renderXY} />
              <EdgeMidpointHandles
                polygonPx={polygonPx}
                renderXY={renderXY}
                hoverEdgeIdx={hoverEdgeIdx}
              />
              <VertexHandles
                polygonPx={polygonPx}
                renderXY={renderXY}
                hoverVertexIdx={hoverVertexIdx}
                onHover={setHoverVertexIdx}
              />
            </svg>
          )}
        </div>

        {/* Inspector */}
        <div className="w-80 shrink-0 border-l border-border bg-card overflow-y-auto">
          <div className="p-3 space-y-3">
            <InspectorSection
              title="Polygon"
              folded={foldedSections.has("polygon")}
              onToggle={() => toggleSection("polygon")}
            >
              <div className="text-xs text-muted-foreground">
                {state.polygon.length} vertices · ~{Math.round(computed.areaSqm).toLocaleString()} sqm
              </div>
              <div className="text-[11px] text-muted-foreground">
                Source: <span className="font-mono">{state.source}</span>
              </div>
              <div className="text-[10px] text-muted-foreground">
                Drag a vertex to move; click an edge midpoint to insert; right-click a vertex to delete.
              </div>
            </InspectorSection>

            <InspectorSection
              title="Side Measurements"
              folded={foldedSections.has("side")}
              onToggle={() => toggleSection("side")}
              right={
                <Switch
                  checked={state.overrides.side_measurements_enabled !== false}
                  onCheckedChange={(v) =>
                    actions.setOverride("side_measurements_enabled", v)
                  }
                />
              }
            >
              {state.overrides.side_measurements_enabled !== false && (
                <SideMeasurementsList
                  polygon={state.polygon}
                  overrides={state.overrides.side_measurements_overrides || {}}
                  onPatch={(idx, p) => actions.setSideOverride(idx, p)}
                />
              )}
            </InspectorSection>

            <InspectorSection
              title="Total SQM"
              folded={foldedSections.has("sqm")}
              onToggle={() => toggleSection("sqm")}
              right={
                <Switch
                  checked={state.overrides.sqm_total_enabled !== false}
                  onCheckedChange={(v) =>
                    actions.setOverride("sqm_total_enabled", v)
                  }
                />
              }
            >
              {state.overrides.sqm_total_enabled !== false && (
                <SqmTotalControls
                  overrides={state.overrides}
                  computedSqm={computed.areaSqm}
                  onSetOverride={actions.setOverride}
                />
              )}
            </InspectorSection>

            <InspectorSection
              title="Address Overlay"
              folded={foldedSections.has("addr")}
              onToggle={() => toggleSection("addr")}
              right={
                <Switch
                  checked={state.overrides.address_overlay_enabled !== false}
                  onCheckedChange={(v) =>
                    actions.setOverride("address_overlay_enabled", v)
                  }
                />
              }
            >
              {state.overrides.address_overlay_enabled !== false && (
                <AddressOverlayControls
                  overrides={state.overrides}
                  projectAddress={projectAddress}
                  onSetOverride={actions.setOverride}
                />
              )}
            </InspectorSection>
          </div>
        </div>
      </div>

      {/* ── Reset confirm ────────────────────────────────────────────── */}
      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to NSW DCDB?</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace the polygon with the cadastral snapshot and
              re-render every Edited shoot in the project. Your unsaved
              overrides on side measurements, sqm and address are preserved
              — only the polygon vertices are reset.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReset} disabled={isSaving}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Cancel-with-unsaved confirm ──────────────────────────────── */}
      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved boundary edits?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Leaving will lose them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmCancel(false);
                onCancel?.();
              }}
            >
              Discard and leave
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Conflict (409) dialog ────────────────────────────────────── */}
      <AlertDialog open={conflict !== null} onOpenChange={(o) => !o && setConflict(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Boundary changed on the server</AlertDialogTitle>
            <AlertDialogDescription>
              Another user saved version <b>{conflict?.version}</b> while you
              were editing. Keep your edits and try again, or load the
              server's version (your edits will be lost).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my edits</AlertDialogCancel>
            <AlertDialogAction onClick={acceptServerVersion}>
              Load server version
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────

function PolygonLines({ polygonPx, renderXY }) {
  const points = polygonPx
    .map((p) => renderXY(p))
    .filter(Boolean)
    .map((r) => `${r.sx},${r.sy}`)
    .join(" ");
  if (!points) return null;
  return (
    <polygon
      points={points}
      fill="rgba(56, 189, 248, 0.18)"
      stroke="#38BDF8"
      strokeWidth={2}
    />
  );
}

function EdgeMidpointHandles({ polygonPx, renderXY, hoverEdgeIdx }) {
  // Render a tiny circle at every edge midpoint — clicking it inserts a
  // new vertex (handled in onPointerDown above; this is purely visual).
  return (
    <g>
      {polygonPx.map((a, i) => {
        const b = polygonPx[(i + 1) % polygonPx.length];
        if (!a || !b) return null;
        const ra = renderXY(a);
        const rb = renderXY(b);
        if (!ra || !rb) return null;
        const mx = (ra.sx + rb.sx) / 2;
        const my = (ra.sy + rb.sy) / 2;
        const isHover = hoverEdgeIdx === i;
        return (
          <circle
            key={`mid-${i}`}
            cx={mx}
            cy={my}
            r={4}
            fill={isHover ? "#FCD34D" : "rgba(252, 211, 77, 0.4)"}
            stroke="#FCD34D"
            strokeWidth={1}
          />
        );
      })}
    </g>
  );
}

function VertexHandles({ polygonPx, renderXY, hoverVertexIdx, onHover }) {
  return (
    <g>
      {polygonPx.map((p, i) => {
        if (!p) return null;
        const r = renderXY(p);
        if (!r) return null;
        const isHover = hoverVertexIdx === i;
        return (
          <circle
            key={`v-${i}`}
            cx={r.sx}
            cy={r.sy}
            r={isHover ? VERTEX_RADIUS + 2 : VERTEX_RADIUS}
            fill={isHover ? "#F59E0B" : "#FBBF24"}
            stroke="#0F172A"
            strokeWidth={2}
            // Re-enable pointer events on the dot itself so hover works
            // (the parent <svg> has pointer-events:none).
            style={{ pointerEvents: "all", cursor: "grab" }}
            onPointerEnter={() => onHover?.(i)}
            onPointerLeave={() => onHover?.(null)}
          />
        );
      })}
    </g>
  );
}

function InspectorSection({ title, folded, onToggle, right, children }) {
  return (
    <div className="rounded border border-border bg-background">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2 py-1.5 text-left text-xs font-medium hover:bg-muted/50"
      >
        <span className="flex items-center gap-1">
          {folded ? (
            <ChevronRight className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {title}
        </span>
        <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
          {right}
        </span>
      </button>
      {!folded && <div className="px-2 pb-2 space-y-2">{children}</div>}
    </div>
  );
}

function SideMeasurementsList({ polygon, overrides, onPatch }) {
  if (!Array.isArray(polygon) || polygon.length < 3) {
    return <div className="text-[11px] text-muted-foreground">No edges</div>;
  }
  return (
    <div className="space-y-1">
      {polygon.map((_, i) => {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        const len = haversineMeters(a[0], a[1], b[0], b[1]);
        const ov = overrides[String(i)] || {};
        const hidden = ov.hide === true;
        const off = Array.isArray(ov.label_offset_px) ? ov.label_offset_px : [0, 0];
        return (
          <div
            key={i}
            className={cn(
              "rounded border border-border px-2 py-1 text-[11px]",
              hidden && "opacity-60",
            )}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="font-mono">
                Edge {i}: {len.toFixed(1)}m
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5"
                onClick={() => onPatch(i, hidden ? { hide: false } : { hide: true })}
                title={hidden ? "Show this edge label" : "Hide this edge label"}
              >
                {hidden ? (
                  <Eye className="h-3 w-3" />
                ) : (
                  <EyeOff className="h-3 w-3" />
                )}
              </Button>
            </div>
            {!hidden && (
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[10px] text-muted-foreground">Nudge:</span>
                <Input
                  type="number"
                  className="h-6 w-14 text-[11px] px-1"
                  value={off[0] ?? 0}
                  onChange={(e) =>
                    onPatch(i, {
                      label_offset_px: [Number(e.target.value) || 0, off[1] ?? 0],
                    })
                  }
                />
                <Input
                  type="number"
                  className="h-6 w-14 text-[11px] px-1"
                  value={off[1] ?? 0}
                  onChange={(e) =>
                    onPatch(i, {
                      label_offset_px: [off[0] ?? 0, Number(e.target.value) || 0],
                    })
                  }
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SqmTotalControls({ overrides, computedSqm, onSetOverride }) {
  const off = Array.isArray(overrides.sqm_total_position_offset_px)
    ? overrides.sqm_total_position_offset_px
    : [0, 0];
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground">
        Auto: ~{Math.round(computedSqm).toLocaleString()} sqm
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground" htmlFor="sqm-override">
          Override value (sqm)
        </label>
        <Input
          id="sqm-override"
          type="number"
          className="h-7 text-[12px]"
          placeholder="auto"
          value={overrides.sqm_total_value_override ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === "" || raw === null) {
              onSetOverride("sqm_total_value_override", null);
              return;
            }
            const n = Number(raw);
            if (Number.isFinite(n) && n >= 0) {
              onSetOverride("sqm_total_value_override", n);
            }
          }}
        />
      </div>
      <div>
        <div className="text-[10px] text-muted-foreground">
          Centroid offset (px)
        </div>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-7 w-20 text-[12px]"
            value={off[0] ?? 0}
            onChange={(e) =>
              onSetOverride("sqm_total_position_offset_px", [
                Number(e.target.value) || 0,
                off[1] ?? 0,
              ])
            }
            placeholder="dx"
          />
          <Input
            type="number"
            className="h-7 w-20 text-[12px]"
            value={off[1] ?? 0}
            onChange={(e) =>
              onSetOverride("sqm_total_position_offset_px", [
                off[0] ?? 0,
                Number(e.target.value) || 0,
              ])
            }
            placeholder="dy"
          />
        </div>
      </div>
    </div>
  );
}

function AddressOverlayControls({ overrides, projectAddress, onSetOverride }) {
  const pos = Array.isArray(overrides.address_overlay_position_latlng)
    ? overrides.address_overlay_position_latlng
    : null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] text-muted-foreground truncate">
        Auto: {projectAddress || "(no address on project)"}
      </div>
      <div>
        <label className="text-[10px] text-muted-foreground" htmlFor="addr-override">
          Override text
        </label>
        <Input
          id="addr-override"
          className="h-7 text-[12px]"
          placeholder="auto from project address"
          value={overrides.address_overlay_text_override ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            onSetOverride(
              "address_overlay_text_override",
              raw === "" ? null : raw,
            );
          }}
        />
      </div>
      <div>
        <div className="text-[10px] text-muted-foreground">
          Position (lat, lng)
        </div>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            step="any"
            className="h-7 w-28 text-[11px] font-mono"
            value={pos?.[0] ?? ""}
            placeholder="auto"
            onChange={(e) => {
              const lat = e.target.value === "" ? null : Number(e.target.value);
              if (lat === null) {
                onSetOverride("address_overlay_position_latlng", null);
              } else if (Number.isFinite(lat)) {
                onSetOverride("address_overlay_position_latlng", [lat, pos?.[1] ?? 0]);
              }
            }}
          />
          <Input
            type="number"
            step="any"
            className="h-7 w-28 text-[11px] font-mono"
            value={pos?.[1] ?? ""}
            placeholder="auto"
            onChange={(e) => {
              const lng = e.target.value === "" ? null : Number(e.target.value);
              if (lng === null) {
                onSetOverride("address_overlay_position_latlng", null);
              } else if (Number.isFinite(lng)) {
                onSetOverride("address_overlay_position_latlng", [pos?.[0] ?? 0, lng]);
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Geodesic distance in metres. Mirrors render_engine._haversine_m so the
 * inspector's "Edge N: X.Xm" matches what the renderer draws.
 */
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dphi = ((lat2 - lat1) * Math.PI) / 180;
  const dlam = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dphi / 2) ** 2 +
    Math.cos(phi1) * Math.cos(phi2) * Math.sin(dlam / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Pull the override fields out of a server-returned drone_property_boundary
 * row into the shape the hook expects on its `overrides` field.
 */
function extractOverridesFromRow(row) {
  if (!row) return null;
  return {
    side_measurements_enabled: row.side_measurements_enabled !== false,
    side_measurements_overrides: row.side_measurements_overrides || null,
    sqm_total_enabled: row.sqm_total_enabled !== false,
    sqm_total_position_offset_px: row.sqm_total_position_offset_px || null,
    sqm_total_value_override:
      row.sqm_total_value_override === undefined ? null : row.sqm_total_value_override,
    address_overlay_enabled: row.address_overlay_enabled !== false,
    address_overlay_position_latlng: row.address_overlay_position_latlng || null,
    address_overlay_text_override:
      row.address_overlay_text_override === undefined
        ? null
        : row.address_overlay_text_override,
  };
}

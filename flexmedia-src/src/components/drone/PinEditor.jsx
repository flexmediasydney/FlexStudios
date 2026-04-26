/**
 * PinEditor — Drone Phase 6 Stream L
 *
 * Full-screen interactive canvas for editing pins on rendered drone shots.
 *
 * Per IMPLEMENTATION_PLAN_V2.md §6.3:
 *   - Top bar: title, shot N of M, [Preview][Save][Cancel]
 *   - Layers panel (left): tree of items grouped World vs Pixel
 *   - Canvas (centre): zoomable / pannable image with pin overlay
 *   - Inspector panel (right): selected item properties + actions
 *   - Shot strip (bottom): thumbnails of all shots in the shoot
 *
 * Anchoring model:
 *   - World-anchored pins (Property, theme POIs, manual POIs with GPS) move
 *     in world coords. Drag end → pixelToGroundGps → store new world coord.
 *     "Apply to all shots" is the killer feature — moves the world coord and
 *     every other shot in the shoot re-projects automatically.
 *   - Pixel-anchored pins (text, ribbon, address overlay) live in image
 *     pixel coords on a single shot. Drag end → just update pixel_x / pixel_y.
 *
 * Canvas implementation: raw HTML <canvas> for the background image plus an
 * absolutely-positioned overlay <div> for pins (cheap hit-testing, free CSS
 * styling, no new dependency). Pan/zoom managed by local state.
 *
 * Save behaviour: writes inserts/updates/deletes to drone_custom_pins. After
 * successful write, a drone_jobs row is enqueued (kind='render') so Stream I
 * picks up the re-render. v1 doesn't wait for completion.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "@/api/supabaseClient";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import PinLayersPanel from "@/components/drone/PinLayersPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Save as SaveIcon,
  Eye,
  EyeOff,
  MousePointer2,
  Hand,
  Pin as PinIcon,
  Type as TextIcon,
  ZoomIn,
  Undo2,
  Redo2,
  Trash2,
  Loader2,
  AlertTriangle,
  Globe,
  Image as ImageIconLucide,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  CAMERA_DEFAULTS,
  gpsToPixel,
  pixelToGroundGps,
  poseFromShot,
} from "@/lib/droneProjection";

// ── Constants ──────────────────────────────────────────────────────────────

const TOOLS = {
  SELECT: "select",
  PAN: "pan",
  ADD_PIN: "add_pin",
  ADD_TEXT: "add_text",
};

// Built-in "world" items resolved from theme + project metadata. These are
// not rows in drone_custom_pins (yet) — operators can override them via the
// editor and we persist the override as a custom pin.
const VIRTUAL_WORLD_KINDS = {
  property: {
    label: "Property",
    color: "#F59E0B",
    icon: "P",
  },
};

// ── Utility — generate a stable client id for new pins ─────────────────────
let _localCounter = 0;
function localId(prefix = "local") {
  _localCounter += 1;
  return `${prefix}_${Date.now()}_${_localCounter}`;
}

// ── Hit testing ────────────────────────────────────────────────────────────
const PIN_HIT_RADIUS = 18; // px in screen coords

// ── Component ──────────────────────────────────────────────────────────────

export default function PinEditor({
  shoot,
  shots = [],
  currentShotId,
  theme,
  themeError = null, // truthy when theme failed to load — blocks editing
  customPins = [],
  cachedPois = [], // drone_pois_cache.pois — read-only "AI-detected" layer
  projectCoord,
  imageUrl,
  imageError = null, // truthy when source image failed to load
  poseAvailable = true, // false → SfM not available, use GPS prior
  // W5 P2 S4 / Task 5: pipeline tells the server which lane the cascade
  // should target. Pin Editor is edited-only so this defaults to 'edited'
  // — the server ignores anything else and always cascades through
  // render_edited.
  pipeline = "edited",
  onShotChange, // (newShotId) => void — drives URL + image swap from parent
  onAfterSave, // optional — called after a successful save with the response
  onSave,
  onCancel,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [tool, setTool] = useState(TOOLS.SELECT);
  const [activeShotId, setActiveShotId] = useState(currentShotId);
  // Keep activeShotId in lockstep with the parent's currentShotId. The
  // parent owns the `?shot=` URL param and the imageUrl pipeline; if the
  // URL changes externally (back/forward, deep-link) we need to update
  // local state so the Inspector + projection use the right shot.
  const [selectedItemId, setSelectedItemId] = useState(null);
  useEffect(() => {
    if (currentShotId && currentShotId !== activeShotId) {
      setActiveShotId(currentShotId);
      setSelectedItemId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentShotId]);
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  // Inline preview modal — replaces the previous window.open() flow which
  // was killed by every common pop-up blocker (window.open after async
  // fetch is blocked by default in Safari + Brave). Stays in-tab + the
  // operator can close with ESC or the Done button.
  const [previewDataUrl, setPreviewDataUrl] = useState(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  // #22: Initial seed uses camera-native dimensions (5280x3956 for Mavic 3 Pro)
  // but `output_variants.target_width_px` may render a downscaled JPEG (e.g.
  // 2400px wide). On image onLoad we update `imageNatural` to the displayed
  // image's actual naturalWidth/Height so fit-to-frame is sized correctly.
  // HOWEVER, `gpsToPixel` / `pixelToGroundGps` are called with `...pose`,
  // and pose carries CAMERA_DEFAULTS (5280x3956) intrinsics — so pin positions
  // returned by the projection live in the camera-native pixel space, NOT the
  // rendered/displayed image space. When the displayed image is downscaled,
  // the projected pin coords overshoot the displayed image extent and pins
  // appear in the wrong place on screen.
  // TODO Wave 4 (#22): proper fix requires either (a) always rendering
  // against the ORIGINAL drone shot resolution (CSS-scale to fit), or (b)
  // scaling pixel coords from camera-native space → rendered-image space
  // using the ratio (imageNatural.w / pose.w). Option (b) is cheaper but
  // requires every gpsToPixel/pixelToGroundGps call site to scale-and-
  // unscale consistently.
  const [imageNatural, setImageNatural] = useState({
    w: CAMERA_DEFAULTS.w,
    h: CAMERA_DEFAULTS.h,
  });
  // Track folded layer groups
  const [foldedGroups, setFoldedGroups] = useState(new Set());
  // Confirmation modals: 'apply_all' | 'cancel_unsaved' | null
  const [confirm, setConfirm] = useState(null);

  // Edit history is keyed off the local items state; we keep simple
  // undo/redo stacks of snapshots.
  const [items, _setItems] = useState(() =>
    initialiseItems({ customPins, theme, projectCoord }),
  );
  // #77: replace Array.shift-based pruning (O(n) per push) with a circular
  // buffer. We keep 50 most-recent snapshots; pushing onto a full buffer
  // overwrites the oldest in O(1).
  const HISTORY_CAP = 50;
  const undoStack = useRef({ buf: new Array(HISTORY_CAP), head: 0, size: 0 });
  const redoStack = useRef({ buf: new Array(HISTORY_CAP), head: 0, size: 0 });
  // #19: mirror stack sizes in React state so the Undo/Redo toolbar buttons
  // re-render when the underlying refs change. useRef.current.size doesn't
  // trigger renders, so the disabled prop went stale (button stayed disabled
  // after the first edit, or stayed enabled after undoing back to empty).
  // Always update these in lockstep with pushHistory/popHistory/clearHistory.
  const [undoSize, setUndoSize] = useState(0);
  const [redoSize, setRedoSize] = useState(0);

  const pushHistory = useCallback((stack, snapshot) => {
    const s = stack.current;
    s.buf[s.head] = snapshot;
    s.head = (s.head + 1) % HISTORY_CAP;
    if (s.size < HISTORY_CAP) s.size += 1;
    if (stack === undoStack) setUndoSize(s.size);
    else if (stack === redoStack) setRedoSize(s.size);
  }, []);
  const popHistory = useCallback((stack) => {
    const s = stack.current;
    if (s.size === 0) return undefined;
    s.head = (s.head - 1 + HISTORY_CAP) % HISTORY_CAP;
    const v = s.buf[s.head];
    s.buf[s.head] = undefined;
    s.size -= 1;
    if (stack === undoStack) setUndoSize(s.size);
    else if (stack === redoStack) setRedoSize(s.size);
    return v;
  }, []);
  const clearHistory = useCallback((stack) => {
    const s = stack.current;
    s.buf = new Array(HISTORY_CAP);
    s.head = 0;
    s.size = 0;
    if (stack === undoStack) setUndoSize(0);
    else if (stack === redoStack) setRedoSize(0);
  }, []);

  const setItems = useCallback((updater) => {
    _setItems((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      pushHistory(undoStack, prev);
      clearHistory(redoStack);
      return next;
    });
  }, [pushHistory, clearHistory]);

  // QC4 F17: keep a ref to the latest committed items so handleSave can
  // read post-flush state without waiting for a React render. Inspector's
  // label/color drafts only commit on blur — when the operator clicks Save
  // we force-blur the focused input so the on-blur handler fires + state
  // is scheduled, but the surrounding handleSave closure still sees the
  // pre-blur items unless we read through this ref.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const undo = useCallback(() => {
    _setItems((current) => {
      const prev = popHistory(undoStack);
      if (!prev) return current;
      pushHistory(redoStack, current);
      return prev;
    });
  }, [popHistory, pushHistory]);
  const redo = useCallback(() => {
    _setItems((current) => {
      const next = popHistory(redoStack);
      if (!next) return current;
      pushHistory(undoStack, current);
      return next;
    });
  }, [popHistory, pushHistory]);

  // ── Derived data ─────────────────────────────────────────────────────────
  const activeShot = useMemo(
    () => shots.find((s) => s.id === activeShotId) || null,
    [shots, activeShotId],
  );

  const pose = useMemo(() => poseFromShot(activeShot), [activeShot]);

  const resolvedTheme = theme?.resolved_config || theme || {};

  // Master toggles from the resolved theme. Default true when missing —
  // never assume false-by-default. When false, the corresponding overlay
  // layer is hidden in the editor preview (matching the rendered output).
  // Form inputs / drag handles remain enabled so edits are still saved.
  const poisEnabled = resolvedTheme?.poi_label?.enabled !== false;
  const pinEnabled = resolvedTheme?.property_pin?.enabled !== false;

  // F31 (W5 P2 S4): cachedPois infra is dead post-W3-ARCH. AI pins now live
  // in drone_custom_pins (mig 268+) and load via the unified customPinsQ.
  // The cachedPois prop is preserved on the public API for backwards
  // compatibility but ignored. drone_pois_cache is an audit log only.
  void cachedPois;

  // Items that should be visible on the active shot (after world→pixel projection).
  // F35: suppressed pins are filtered OUT of the canvas (still appear in
  // Layers via the suppress-strikethrough rendering — they're hidden from
  // the rendered output until restored).
  const projectedItems = useMemo(() => {
    if (!activeShot) return [];
    const out = [];
    for (const item of items) {
      if (hiddenIds.has(item.id)) continue;
      // F35: suppress filter — both the persisted lifecycle and the
      // optimistic _suppress flag count.
      if (item.lifecycle === "suppressed" || item._suppress === true) continue;
      // Master-toggle suppression of overlay markers. Property pin is the
      // virtual "property" item; POIs are theme POIs + any manual poi_manual
      // pin (world or pixel anchored).
      if (!pinEnabled && item.virtual === "property") continue;
      if (
        !poisEnabled &&
        (item.virtual === "theme_poi" ||
          item.subtype === "poi_manual" ||
          item.isAi === true)
      ) {
        continue;
      }
      let pixel = null;
      if (item.kind === "world") {
        if (
          item.world &&
          Number.isFinite(item.world.lat) &&
          Number.isFinite(item.world.lng)
        ) {
          if (pose) {
            pixel = gpsToPixel({
              tlat: item.world.lat,
              tlon: item.world.lng,
              ...pose,
            });
          }
        }
      } else if (item.kind === "pixel" && item.shot_id === activeShot.id) {
        pixel = { x: item.pixel.x, y: item.pixel.y };
      }
      if (!pixel) continue;
      out.push({ ...item, _pixel: pixel });
    }
    return out;
  }, [items, hiddenIds, activeShot, pose, pinEnabled, poisEnabled]);

  // ── Canvas / image refs ─────────────────────────────────────────────────
  const containerRef = useRef(null);
  const stageRef = useRef(null);

  // Image natural-size after load.
  // #76: Defensively revoke previous blob URLs on shot change / unmount so
  // we don't leak object URLs if the parent ever switches from query-string
  // URLs to URL.createObjectURL() blobs. No-op for normal http(s) URLs.
  const previousImageUrlRef = useRef(null);
  useEffect(() => {
    setImageLoaded(false);
    const prev = previousImageUrlRef.current;
    if (prev && prev !== imageUrl && typeof prev === "string" && prev.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(prev);
      } catch {
        /* ignore */
      }
    }
    previousImageUrlRef.current = imageUrl || null;
    return () => {
      // On unmount, revoke whatever blob URL we currently hold (if any).
      const current = previousImageUrlRef.current;
      if (current && typeof current === "string" && current.startsWith("blob:")) {
        try {
          URL.revokeObjectURL(current);
        } catch {
          /* ignore */
        }
      }
    };
  }, [activeShotId, imageUrl]);

  const handleImageLoad = useCallback((e) => {
    const node = e.currentTarget;
    setImageNatural({ w: node.naturalWidth, h: node.naturalHeight });
    setImageLoaded(true);
  }, []);

  // Fit-to-frame: compute initial zoom that fits the image in the container.
  const fitToFrame = useCallback(() => {
    const c = stageRef.current;
    if (!c) return;
    const cw = c.clientWidth;
    const ch = c.clientHeight;
    const scale = Math.min(
      cw / imageNatural.w,
      ch / imageNatural.h,
    );
    setView({
      zoom: Number.isFinite(scale) && scale > 0 ? scale : 1,
      panX: (cw - imageNatural.w * scale) / 2,
      panY: (ch - imageNatural.h * scale) / 2,
    });
  }, [imageNatural]);

  useEffect(() => {
    if (!imageLoaded) return;
    fitToFrame();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageLoaded]);

  // ── Pointer interaction ────────────────────────────────────────────────
  // #17: Pointer Events instead of Mouse Events so touch (iPad on-site
  // drone operators) and stylus work the same as mouse. setPointerCapture
  // on pointerdown ensures all subsequent pointermove / pointerup events
  // for that pointerId fire on the capturing element even if the finger
  // leaves it.
  const dragState = useRef(null);

  const screenToImage = useCallback(
    (sx, sy) => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      const ox = sx - rect.left - view.panX;
      const oy = sy - rect.top - view.panY;
      return { x: ox / view.zoom, y: oy / view.zoom };
    },
    [view],
  );

  // E9 (W5 P2 S4): direct pointerdown handler for pin markers. The marker
  // calls this on pointerdown WITH stopPropagation, so the canvas pan
  // handler never sees the event for pin starts. Without this the
  // geometric hit-test on the stage's pointerdown sometimes missed
  // (small markers, label-side click) and pan engaged instead of drag.
  const onPinPointerDown = useCallback(
    (item, e) => {
      // Honor pose lock for the property pin (same as the stage handler).
      setSelectedItemId(item.id);
      try {
        // Capture pointer on the stage so subsequent pointermove/up
        // events bubble up via the same path the existing handlers use.
        const stage = stageRef.current;
        if (stage && typeof stage.setPointerCapture === "function") {
          stage.setPointerCapture(e.pointerId);
        }
      } catch {
        /* ignore */
      }
      if (item.virtual === "property") {
        // Property pin: select but don't drag (lock-out).
        dragState.current = {
          kind: "pan",
          startMouse: { x: e.clientX, y: e.clientY },
          startView: { ...view },
        };
        return;
      }
      // Compute the projected pixel for this item (mirrors the stage hit-
      // test), so subsequent pointermove deltas use the right baseline.
      let pixel;
      if (item.kind === "world" && item.world && pose) {
        pixel = gpsToPixel({ tlat: item.world.lat, tlon: item.world.lng, ...pose });
      } else if (item.kind === "pixel") {
        pixel = { x: item.pixel.x, y: item.pixel.y };
      }
      if (!pixel) {
        // Off-frame or unprojectable; fall back to pan to keep the
        // cursor responsive.
        dragState.current = {
          kind: "pan",
          startMouse: { x: e.clientX, y: e.clientY },
          startView: { ...view },
        };
        return;
      }
      dragState.current = {
        kind: "drag-pin",
        id: item.id,
        startMouse: { x: e.clientX, y: e.clientY },
        startPixel: pixel,
        moved: false,
        startPose: pose,
      };
    },
    [pose, view],
  );

  const onPointerDown = useCallback(
    (e) => {
      // #17: Capture this pointer so pointermove/pointerup keep firing on
      // the stage even if the finger/cursor leaves the stage element
      // mid-drag. Wrapped in try/catch — capture is best-effort and may
      // fail on detached nodes.
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* ignore */
      }
      // Hit test against projected pins
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // Find an item under the cursor (top-most)
      let hit = null;
      for (let i = projectedItems.length - 1; i >= 0; i--) {
        const it = projectedItems[i];
        const px = it._pixel.x * view.zoom + view.panX;
        const py = it._pixel.y * view.zoom + view.panY;
        const dx = sx - px;
        const dy = sy - py;
        if (Math.hypot(dx, dy) <= PIN_HIT_RADIUS) {
          hit = it;
          break;
        }
      }

      if (tool === TOOLS.SELECT) {
        if (hit) {
          setSelectedItemId(hit.id);
          // #5: Property pin position is owned by `projects.confirmed_lat/lng`.
          // Allow selection (so the inspector renders + shows the lock-out
          // hint) but skip the drag — fall through to pan so the gesture
          // doesn't feel inert. The inspector also disables label/color/etc.
          if (hit.virtual === "property") {
            dragState.current = {
              kind: "pan",
              startMouse: { x: e.clientX, y: e.clientY },
              startView: { ...view },
            };
          } else {
            dragState.current = {
              kind: "drag-pin",
              id: hit.id,
              startMouse: { x: e.clientX, y: e.clientY },
              startPixel: { ...hit._pixel },
              moved: false,
              // #79: snapshot the pose at drag-start so the inverse projection
              // on mouseup uses the pose that was active when the drag began,
              // not whatever pose belongs to a shot the user clicked through to
              // mid-drag.
              startPose: pose,
            };
          }
        } else {
          setSelectedItemId(null);
          dragState.current = {
            kind: "pan",
            startMouse: { x: e.clientX, y: e.clientY },
            startView: { ...view },
          };
        }
      } else if (tool === TOOLS.PAN) {
        dragState.current = {
          kind: "pan",
          startMouse: { x: e.clientX, y: e.clientY },
          startView: { ...view },
        };
      } else if (tool === TOOLS.ADD_PIN || tool === TOOLS.ADD_TEXT) {
        const img = screenToImage(e.clientX, e.clientY);
        if (
          img.x < 0 ||
          img.x > imageNatural.w ||
          img.y < 0 ||
          img.y > imageNatural.h
        ) {
          return;
        }
        const newItem = makeNewItem({
          tool,
          imgPos: img,
          activeShotId: activeShot?.id,
          pose,
        });
        if (newItem) {
          setItems((prev) => [...prev, newItem]);
          setSelectedItemId(newItem.id);
          setTool(TOOLS.SELECT);
        }
      }
    },
    [
      activeShot,
      imageNatural.h,
      imageNatural.w,
      pose,
      projectedItems,
      screenToImage,
      setItems,
      tool,
      view,
    ],
  );

  const onPointerMove = useCallback(
    (e) => {
      const ds = dragState.current;
      if (!ds) return;
      if (ds.kind === "pan") {
        const dx = e.clientX - ds.startMouse.x;
        const dy = e.clientY - ds.startMouse.y;
        setView({
          ...ds.startView,
          panX: ds.startView.panX + dx,
          panY: ds.startView.panY + dy,
        });
      } else if (ds.kind === "drag-pin") {
        const dx = e.clientX - ds.startMouse.x;
        const dy = e.clientY - ds.startMouse.y;
        if (Math.hypot(dx, dy) > 2) ds.moved = true;
        const newPx = ds.startPixel.x + dx / view.zoom;
        const newPy = ds.startPixel.y + dy / view.zoom;
        // Live update visual position of the dragged pin
        _setItems((prev) =>
          prev.map((it) => {
            if (it.id !== ds.id) return it;
            if (it.kind === "pixel") {
              return {
                ...it,
                pixel: { x: newPx, y: newPy },
                _dirty: true,
              };
            }
            // World pin: update pixel preview but defer world reprojection until mouseup
            return { ...it, _previewPixel: { x: newPx, y: newPy } };
          }),
        );
      }
    },
    [view.zoom],
  );

  const onPointerUp = useCallback((e) => {
    // #17: Release pointer capture taken in onPointerDown. Best-effort —
    // some platforms drop the capture automatically.
    try {
      e?.currentTarget?.releasePointerCapture?.(e.pointerId);
    } catch {
      /* ignore */
    }
    const ds = dragState.current;
    dragState.current = null;
    if (!ds) return;
    if (ds.kind === "drag-pin" && ds.moved) {
      // Snapshot history at end of drag (single undo step per drag)
      // #77: use the circular-buffer helpers so capacity stays bounded in O(1).
      pushHistory(undoStack, items);
      clearHistory(redoStack);

      _setItems((prev) =>
        prev.map((it) => {
          if (it.id !== ds.id) return it;
          // F47: flip aiOperatorEdited on AI pins so Reset-to-AI surfaces
          // immediately after the drag, not only after a save round-trip.
          const aiFlag = it.isAi ? { aiOperatorEdited: true } : {};
          if (it.kind !== "world") return { ...it, ...aiFlag, _dirty: true };
          // Convert _previewPixel → world via inverse projection.
          // #79: use the pose snapshot captured at mousedown rather than the
          // current closure's `pose` (which may have changed if activeShotId
          // shifted mid-drag).
          const target = it._previewPixel || ds.startPixel;
          const dragPose = ds.startPose || pose;
          if (!dragPose) {
            toast.warning(
              "Pose data unavailable — pin world position not updated",
            );
            const { _previewPixel: _, ...rest } = it;
            return { ...rest, ...aiFlag };
          }
          const newWorld = pixelToGroundGps({
            px: target.x,
            py: target.y,
            ...dragPose,
          });
          if (!newWorld) {
            toast.warning(
              "Pixel above horizon — cannot ray-cast to ground; world coord unchanged",
            );
            const { _previewPixel: _, ...rest } = it;
            return { ...rest, ...aiFlag };
          }
          const { _previewPixel: _, ...rest } = it;
          return {
            ...rest,
            ...aiFlag,
            world: { lat: newWorld.lat, lng: newWorld.lon },
            _dirty: true,
          };
        }),
      );
    }
  }, [items, pose, pushHistory, clearHistory]);

  // Mouse-wheel zoom about cursor.
  const onWheel = useCallback(
    (e) => {
      e.preventDefault();
      const rect = stageRef.current?.getBoundingClientRect();
      if (!rect) return;
      // QC4 #28: Magic Mouse / trackpad pinch fires the wheel event with the
      // dominant axis on either deltaY (vertical scroll) OR deltaX (horizontal
      // scroll, common when the gesture is rotated). Take whichever has the
      // larger magnitude so a sideways pinch still zooms instead of being
      // ignored. Sign is inverted so scrolling "up" / pinching out zooms in.
      const dy = e.deltaY || 0;
      const dx = e.deltaX || 0;
      const dominant = Math.abs(dx) > Math.abs(dy) ? dx : dy;
      const delta = -dominant * 0.0015;
      const nextZoom = Math.max(0.1, Math.min(8, view.zoom * (1 + delta)));
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      // Keep the image point under the cursor stationary
      const ix = (sx - view.panX) / view.zoom;
      const iy = (sy - view.panY) / view.zoom;
      setView({
        zoom: nextZoom,
        panX: sx - ix * nextZoom,
        panY: sy - iy * nextZoom,
      });
    },
    [view],
  );

  // Wire DOM listeners on the stage for native non-passive wheel
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const wheelHandler = (e) => onWheel(e);
    node.addEventListener("wheel", wheelHandler, { passive: false });
    return () => node.removeEventListener("wheel", wheelHandler);
  }, [onWheel]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      // #78: Skip ALL shortcuts (v/m/p/t/z and the navigation arrows) when
      // the user is typing in any input-like element. Cover INPUT/TEXTAREA/
      // SELECT plus contentEditable surfaces (e.g. shadcn dialogs that wrap
      // their content in editable divs).
      const ae = document.activeElement;
      const isInputFocused =
        ae &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(ae.tagName) ||
          ae.isContentEditable === true);
      if (isInputFocused) return;
      // Also bail if the event target itself is an editable surface (defence
      // against focus mismatches).
      const tgt = e.target;
      if (
        tgt &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(tgt.tagName) ||
          tgt.isContentEditable === true)
      ) {
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        if (e.key.toLowerCase() === "z") {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
          return;
        }
      }
      switch (e.key.toLowerCase()) {
        case "v":
          setTool(TOOLS.SELECT);
          break;
        case "m":
        case "h":
          // #30: H is the Figma/Adobe convention for the hand/pan tool. Keep
          // M as a synonym so existing muscle memory still works.
          setTool(TOOLS.PAN);
          break;
        case "p":
          setTool(TOOLS.ADD_PIN);
          break;
        case "t":
          setTool(TOOLS.ADD_TEXT);
          break;
        case "z":
          fitToFrame();
          break;
        case "delete":
        case "backspace":
          if (selectedItemId) {
            // eslint-disable-next-line no-use-before-define -- keypress fires after render; handleDelete is initialised by then
            handleDelete(selectedItemId);
            e.preventDefault();
          }
          break;
        case "arrowleft":
        case "arrowright":
        case "arrowup":
        case "arrowdown":
          if (selectedItemId) {
            const step = e.shiftKey ? 10 : 1;
            const dx =
              e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
            const dy =
              e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
            // eslint-disable-next-line no-use-before-define -- keypress fires after render; nudgeSelected is initialised by then
            nudgeSelected(dx, dy);
            e.preventDefault();
          }
          break;
        default:
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedItemId, fitToFrame]);

  // ── Item mutators ────────────────────────────────────────────────────────
  // F47 (W5 P2 S4): when an AI pin is updated locally (label change, color,
  // etc.), flip aiOperatorEdited=true so the Reset-to-AI button surfaces
  // for current-session edits. Was previously only set from the server's
  // updated_by field, meaning the button only appeared after a save round-
  // trip — operators couldn't undo their in-progress edits.
  const updateItem = useCallback(
    (id, patch) => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          const merged = { ...it, ...patch, _dirty: true };
          if (it.isAi) merged.aiOperatorEdited = true;
          return merged;
        }),
      );
    },
    [setItems],
  );

  const handleDelete = useCallback(
    (id) => {
      setItems((prev) => {
        return prev
          .map((it) => {
            if (it.id !== id) return it;
            // For DB-persisted items we mark for delete; for local items we drop.
            if (it.dbId) return { ...it, _delete: true };
            return null;
          })
          .filter(Boolean);
      });
      setSelectedItemId(null);
    },
    [setItems],
  );

  // W3-PINS / E12 (W5 P2 S4): Suppress — optimistic state update so the
  // canvas, Layers panel, and Inspector all reflect the suppression
  // immediately. The server hook (suppress action) flips lifecycle in
  // drone_custom_pins on save.
  const handleSuppress = useCallback(
    (id) => {
      setItems((prev) =>
        prev.map((it) =>
          it.id === id && it.dbId
            ? {
                ...it,
                _suppress: true,
                _unsuppress: false,
                lifecycle: "suppressed",
                _dirty: true,
              }
            : it,
        ),
      );
    },
    [setItems],
  );

  // F35 (W5 P2 S4): Un-suppress — flip a previously-suppressed pin back
  // to active. Optimistic state mirrors the eventual server-side
  // un_suppress action. Suppression is no longer a one-way trapdoor.
  const handleUnsuppress = useCallback(
    (id) => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id || !it.dbId) return it;
          return {
            ...it,
            _suppress: false,
            _unsuppress: true,
            lifecycle: "active",
            _dirty: true,
          };
        }),
      );
    },
    [setItems],
  );

  // Layers panel callbacks (extracted to PinLayersPanel.jsx).
  const handleToggleFold = useCallback((groupKey) => {
    setFoldedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }, []);

  const handleToggleVisibility = useCallback((itemId) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }, []);

  // W3-PINS: Reset to AI — restore world coords + label from latest_ai_snapshot.
  // We just stamp _reset_to_ai; the server reloads the snapshot from the row.
  const handleResetToAi = useCallback(
    (id) => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          if (!it.isAi || !it.aiSnapshot) return it;
          const snap = it.aiSnapshot;
          const restoredLabel = snap.name || it.label;
          return {
            ...it,
            label: restoredLabel,
            world: { lat: Number(snap.lat), lng: Number(snap.lng) },
            color: '#10B981',
            _reset_to_ai: true,
            _dirty: true,
          };
        }),
      );
    },
    [setItems],
  );

  const nudgeSelected = useCallback(
    (dx, dy) => {
      const item = items.find((i) => i.id === selectedItemId);
      if (!item) return;
      // #5: Property pin is owned by projects.confirmed_lat/lng — don't let
      // arrow-key nudges create a hidden override.
      if (item.virtual === "property") return;
      if (item.kind === "pixel") {
        updateItem(item.id, {
          pixel: { x: item.pixel.x + dx, y: item.pixel.y + dy },
        });
      } else if (item.kind === "world" && pose) {
        // Move via pixel coord first, then re-derive world
        const cur = gpsToPixel({
          tlat: item.world.lat,
          tlon: item.world.lng,
          ...pose,
        });
        if (!cur) return;
        const newWorld = pixelToGroundGps({
          px: cur.x + dx,
          py: cur.y + dy,
          ...pose,
        });
        if (!newWorld) return;
        updateItem(item.id, {
          world: { lat: newWorld.lat, lng: newWorld.lon },
        });
      }
    },
    [items, pose, selectedItemId, updateItem],
  );

  const resetToTheme = useCallback(
    (id) => {
      setItems((prev) =>
        prev.map((it) => {
          if (it.id !== id) return it;
          if (!it.themeDefaults) return it;
          return {
            ...it,
            ...it.themeDefaults,
            _dirty: true,
            style_overrides: null,
          };
        }),
      );
    },
    [setItems],
  );

  // ── Save ────────────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async () => {
      // #3: scope param dropped — Subagent A removed it from drone-pins-save
      // and the "Apply to all shots" UI is now hidden until the backend
      // supports a real per-pin fan-out. World pins already broadcast across
      // all renders in the shoot via projection at render time.
      if (!shoot?.id) {
        toast.error("Missing shoot id — cannot save");
        return;
      }
      // QC4 F17: Inspector's `labelDraft` / `colorDraft` only commit
      // upstream on blur. If the operator clicks Save while still focused
      // in the Label or Color text input, the most recent keystrokes never
      // reach `items` and silently vanish. Force-blur the active element so
      // the on-blur handler fires before we read items. We then wait two
      // animation frames for React to (a) commit the on-blur setState and
      // (b) refresh itemsRef via the syncing useEffect. Reading from the
      // ref (not the closure-captured `items`) lets us pick up the just-
      // flushed draft without restructuring handleSave around state.
      const ae = document.activeElement;
      if (ae && typeof ae.blur === "function" && ae !== document.body) {
        try {
          ae.blur();
        } catch {
          /* ignore */
        }
        await new Promise((r) => requestAnimationFrame(() => r()));
        await new Promise((r) => requestAnimationFrame(() => r()));
      }
      setIsSaving(true);
      try {
        const latestItems = itemsRef.current || items;
        const edits = computeSaveEdits({
          items: latestItems,
          shootId: shoot.id,
          imageNatural,
        });
        if (edits.length === 0) {
          toast.info("Nothing to save");
          return;
        }
        const callable = api.functions?.invoke;
        let result;
        let usedFallback = false;
        if (callable) {
          // Try the optional drone-pins-save edge function. If it's not
          // deployed yet we fall back to direct entity mutations so v1
          // works without the function.
          try {
            const resp = await api.functions.invoke("drone-pins-save", {
              shoot_id: shoot.id,
              edits,
              // W5 P2 S4 / Task 5: forwarded for forward-compat. Server
              // currently always treats Pin Editor saves as 'edited'.
              pipeline,
            });
            result = resp?.data || resp;
            // Surface partial-failure (HTTP 207-style) errors
            if (Array.isArray(result?.errors) && result.errors.length > 0) {
              toast.warning(
                `${result.errors.length} edit${result.errors.length === 1 ? "" : "s"} failed; see console`,
              );
              console.warn("[PinEditor] partial save errors:", result.errors);
            }
          } catch (err) {
            console.warn(
              "[PinEditor] drone-pins-save invoke failed; falling back to direct entity writes:",
              err?.message || err,
            );
            result = await directEntityFallback({ edits });
            usedFallback = true;
          }
        } else {
          result = await directEntityFallback({ edits });
          usedFallback = true;
        }

        const totalApplied =
          (result?.applied?.creates ?? result?.creates ?? 0) +
          (result?.applied?.updates ?? result?.updates ?? 0) +
          (result?.applied?.deletes ?? result?.deletes ?? 0);

        // W3 cascade telemetry: when a world-anchored pin is touched the
        // server fans out one render per shoot in the project (POIs and the
        // property pin project to every shot). The toast surfaces the count
        // so the operator sees that sibling shoots are also re-rendering.
        const cascadeCount = Number(result?.cascade?.cascaded_shoot_count ?? 0);
        const cascadeReason = result?.cascade?.reason;
        const isCascade = cascadeReason === "pin_edit_cascade" && cascadeCount > 1;

        toast.success(
          `Saved ${totalApplied || edits.length} pin${
            (totalApplied || edits.length) === 1 ? "" : "s"
          }`,
          {
            description: usedFallback
              ? "Edge function unavailable — saved direct (no re-render queued)."
              : isCascade
              ? `Re-rendering ${cascadeCount} shoots — project-wide pin update.`
              : result?.job_id || cascadeCount > 0
              ? "Re-render queued — your renders will refresh shortly."
              : undefined,
          },
        );
        // #7: clear local dirty markers and history stacks after a successful
        // save so dirtyCount drops to 0, the Save button disables, and the
        // beforeunload / useBlocker / "Discard unsaved changes?" modal stops
        // firing on subsequent navigation. Without this, an editor that didn't
        // unmount on save (e.g. fallback path or future un-navigate) would
        // claim there are unsaved changes forever.
        // Drop _delete rows (they're gone server-side) and reset _dirty/_new
        // on everything else; this also means the "saved" snapshot becomes
        // the new baseline for undo, so we clear both stacks too.
        // Also: stamp dbId on items that just got created server-side, using
        // the response's created_ids array (server emits IDs in the same
        // order computeSaveEdits emitted 'create' actions). Without this,
        // a second save in the same session re-issues create actions for
        // already-persisted pins → dupes in drone_custom_pins.
        const createdIds = Array.isArray(result?.created_ids)
          ? result.created_ids
          : [];
        // Reconstruct the order of create-emitting items from computeSaveEdits:
        // any item that was _dirty or _new and had no dbId became a create.
        // Use the same `latestItems` snapshot as computeSaveEdits so the
        // create-order list lines up with the server's created_ids array
        // (we'd otherwise zip the server response against the closure's
        // pre-blur `items` and stamp dbId on the wrong row).
        const createOrderItemIds = [];
        for (const it of latestItems) {
          if (it._delete) continue;
          if (it.virtual === "property") continue;
          if (!it._dirty && !it._new) continue;
          if (!it.dbId) createOrderItemIds.push(it.id);
        }
        const dbIdByLocalId = new Map();
        for (let i = 0; i < createOrderItemIds.length && i < createdIds.length; i++) {
          dbIdByLocalId.set(createOrderItemIds[i], createdIds[i]);
        }
        _setItems((prev) =>
          prev
            .filter((i) => !i._delete)
            .map((i) => {
              const newDbId = dbIdByLocalId.get(i.id);
              return {
                ...i,
                _dirty: false,
                _new: false,
                ...(newDbId ? { dbId: newDbId, id: newDbId } : {}),
              };
            }),
        );
        clearHistory(undoStack);
        clearHistory(redoStack);
        // Notify the page so it can invalidate the customPinsQ + renders queries
        // → next refetch picks up the server's authoritative pin set.
        if (typeof onAfterSave === "function") onAfterSave(result);
        if (typeof onSave === "function") onSave({ edits, result });
      } catch (err) {
        console.error("[PinEditor] save failed", err);
        toast.error(`Save failed: ${err?.message || err}`);
      } finally {
        setIsSaving(false);
      }
    },
    [items, shoot?.id, onSave, imageNatural, clearHistory],
  );

  // Preview-only render: hits drone-render-preview for fast iteration.
  // Renders inline in a Dialog (was: window.open which pop-up blockers kill).
  const handlePreview = useCallback(async () => {
    if (!theme) {
      toast.warning("No theme loaded — preview unavailable");
      return;
    }
    setIsPreviewing(true);
    try {
      const themeConfig = theme?.resolved_config || theme || {};
      const resp = await api.functions.invoke("drone-render-preview", {
        theme_config: themeConfig,
      });
      const data = resp?.data;
      if (!data?.success || !data?.image_b64) {
        throw new Error(data?.error || "Preview render failed");
      }
      const fmt = (data.format || "JPEG").toLowerCase();
      setPreviewDataUrl(`data:image/${fmt};base64,${data.image_b64}`);
    } catch (err) {
      console.error("[PinEditor] preview failed", err);
      toast.error(`Preview failed: ${err?.message || err}`);
    } finally {
      setIsPreviewing(false);
    }
  }, [theme]);

  // #24: single source of truth for "is this item unsaved?" — used by the
  // dirty-count badge, save-button enable, beforeunload, requestCancel and
  // useBlocker so they can never disagree.
  const isItemDirty = useCallback(
    (i) => Boolean(i._dirty || i._delete || i._new),
    [],
  );

  // Cancel button: warn about unsaved changes via confirm modal.
  const requestCancel = useCallback(() => {
    if (items.some(isItemDirty)) {
      setConfirm("cancel_unsaved");
    } else {
      onCancel?.();
    }
  }, [items, isItemDirty, onCancel]);

  // Warn before window unload if unsaved.
  useEffect(() => {
    const beforeUnload = (e) => {
      if (!items.some(isItemDirty)) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [items, isItemDirty]);

  // #25: in-app navigation guard. We previously used react-router 6.4+
  // useBlocker here, but the app is mounted under <BrowserRouter> (declarative)
  // not a Data Router (createBrowserRouter), and useBlocker throws
  // "useBlocker must be used within a data router" in that mode — which
  // crashed the editor on mount. The editor still has beforeunload above
  // for full-reload / tab-close, and the explicit Cancel button via
  // requestCancel for in-editor navigation. In-app navigation away (e.g.
  // clicking project breadcrumb) is unguarded for now.
  // TODO Wave 4: migrate the app to a Data Router and reinstate useBlocker
  // so internal navigation honours the unsaved-changes guard too.

  // ── UI ──────────────────────────────────────────────────────────────────
  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId],
  );

  const dirtyCount = items.filter(isItemDirty).length;

  // F31 (W5 P2 S4): Layer groups built directly from `items`. AI pins
  // (source='ai' / isAi=true) flow into 'detected'; manual world-anchored
  // pins into 'world'; pixel-anchored into 'pixel'. The legacy
  // cachedPoiItems path is dead — drone_pois_cache is an audit log only
  // post-W3-ARCH; AI pins live in drone_custom_pins now (mig 268+).
  //
  // F35: include suppressed pins in the layer tree (rendered grey/strike-
  // through by PinLayersPanel) so the operator can find and restore
  // them. Without this, suppression was a one-way trapdoor in the UI.
  const layerGroups = useMemo(() => {
    const groups = {
      detected: { label: "Detected POIs (AI)", items: [] },
      world: { label: "World-anchored", items: [] },
      pixel: { label: "Pixel-anchored", items: [] },
    };
    for (const it of items) {
      // Drop hard-deletes (the local _delete tombstone). Suppressed and
      // un-suppress-pending pins both stay visible — the panel renders
      // them with affordances.
      if (it._delete) continue;
      // Property pin is virtual + non-anchored to a group bucket — it
      // surfaces under 'world' as a non-AI item (matches the legacy
      // grouping operators are used to).
      const isAi = Boolean(it.isAi || it.source === "ai");
      if (isAi) {
        groups.detected.items.push(it);
      } else if (it.kind === "world") {
        groups.world.items.push(it);
      } else {
        groups.pixel.items.push(it);
      }
    }
    return groups;
  }, [items]);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="fixed inset-0 z-50 flex flex-col bg-slate-50 dark:bg-slate-950 text-foreground">
        {/* ── TOP BAR ───────────────────────────────────────── */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-border bg-background shadow-sm shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={requestCancel}
            disabled={isSaving}
            className="gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">Back</span>
          </Button>
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="font-semibold truncate">Pin Editor</h1>
            {shoot?.notes ? (
              <span className="text-xs text-muted-foreground truncate">
                — {shoot.notes}
              </span>
            ) : null}
          </div>
          <div className="text-xs text-muted-foreground">
            shot {shots.findIndex((s) => s.id === activeShotId) + 1} of{" "}
            {shots.length}
          </div>

          {!poseAvailable && (
            <Badge variant="outline" className="gap-1 text-amber-700 border-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Pose data not available — using GPS prior
            </Badge>
          )}

          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={isSaving || isPreviewing}
              onClick={handlePreview}
              className="gap-2"
              title="Render a low-res preview using the current theme"
            >
              {isPreviewing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
              <span className="hidden sm:inline">Preview</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={isSaving}
              onClick={requestCancel}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={isSaving || dirtyCount === 0 || Boolean(themeError)}
              onClick={() => handleSave()}
              className="gap-2"
              title={
                themeError
                  ? "Editing blocked — theme failed to load"
                  : undefined
              }
            >
              {isSaving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SaveIcon className="h-4 w-4" />
              )}
              Save
              {dirtyCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center rounded-full bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-[10px] px-1.5 py-0.5">
                  {dirtyCount}
                </span>
              )}
            </Button>
          </div>
        </div>

        {/* #11: Theme load failure is BLOCKING — without a theme we don't
            know which POIs are enabled and the editor would silently render
            stale defaults that won't match the real render. Render a top-level
            red banner above the canvas so the operator can't accidentally
            commit edits against an unresolved theme.
            #imageError: surface the source-image failure in the same banner
            row so the user sees both problems at once. */}
        {(themeError || imageError) && (
          <div className="bg-red-50 dark:bg-red-950/40 border-b border-red-300 dark:border-red-800 px-4 py-2.5 text-sm text-red-800 dark:text-red-200 flex items-start gap-2 shrink-0">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              {themeError && (
                <div>
                  <span className="font-semibold">Theme failed to load.</span>{" "}
                  Editing is blocked — pin overrides require a resolved theme
                  so the editor preview matches the rendered output.{" "}
                  <span className="text-xs opacity-80">
                    {themeError?.message || ""}
                  </span>
                </div>
              )}
              {imageError && (
                <div className={cn(themeError && "mt-1")}>
                  <span className="font-semibold">Image unavailable.</span>{" "}
                  {typeof imageError === "string"
                    ? imageError
                    : imageError?.message || "Failed to load shot image."}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── MAIN ROW ──────────────────────────────────────── */}
        <div className={cn("flex flex-1 min-h-0", themeError && "opacity-50 pointer-events-none")}>
          {/* Layers panel — extracted to PinLayersPanel.jsx (Wave 5 P2 S4) */}
          <PinLayersPanel
            layerGroups={layerGroups}
            foldedGroups={foldedGroups}
            onToggleFold={handleToggleFold}
            selectedItemId={selectedItemId}
            onSelectItem={setSelectedItemId}
            hiddenIds={hiddenIds}
            onToggleVisibility={handleToggleVisibility}
            onUnsuppress={handleUnsuppress}
            tool={tool}
            onSetTool={setTool}
            shotsCount={shots.length}
            poseAvailable={poseAvailable}
            TOOLS={TOOLS}
          />

          {/* Canvas */}
          <main
            ref={containerRef}
            className="relative flex-1 min-w-0 overflow-hidden bg-slate-200 dark:bg-slate-900"
          >
            {/* Theme-toggle suppression banner (top-left, non-blocking) */}
            {(!poisEnabled || !pinEnabled) && (
              <div className="absolute top-3 left-3 z-10 max-w-[60%] text-[11px] px-2 py-1 rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800/50 text-amber-800 dark:text-amber-200 mb-2">
                Theme overrides hide{" "}
                {!poisEnabled && !pinEnabled
                  ? "POIs and the property pin"
                  : !poisEnabled
                    ? "POI labels"
                    : "the property pin"}
                . Edits made here are still saved but won&apos;t appear in renders
                until the theme toggle is re-enabled.
              </div>
            )}

            {/* Toolbar (top-right) */}
            <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-background/90 backdrop-blur rounded-md border border-border shadow-sm p-1">
              <ToolButton
                tool={tool}
                value={TOOLS.SELECT}
                setTool={setTool}
                Icon={MousePointer2}
                label="Select (V)"
              />
              <ToolButton
                tool={tool}
                value={TOOLS.PAN}
                setTool={setTool}
                Icon={Hand}
                label="Pan (H or M)"
              />
              <ToolButton
                tool={tool}
                value={TOOLS.ADD_PIN}
                setTool={setTool}
                Icon={PinIcon}
                label={
                  shots.length === 0
                    ? "No shots in this shoot — add shots first."
                    : "Add Pin (P)"
                }
                disabled={shots.length === 0}
              />
              <ToolButton
                tool={tool}
                value={TOOLS.ADD_TEXT}
                setTool={setTool}
                Icon={TextIcon}
                label={
                  shots.length === 0
                    ? "No shots in this shoot — add shots first."
                    : "Add Text (T)"
                }
                disabled={shots.length === 0}
              />
              <div className="w-px h-5 bg-border mx-1" />
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    // QC7 F21/iPad polish: same min-44px-on-mobile pattern as
                    // ToolButton; aria-label gives the action to AT users
                    // (icon alone reads as "button").
                    className="h-11 w-11 md:h-7 md:w-7"
                    onClick={fitToFrame}
                    aria-label="Fit to frame"
                  >
                    <ZoomIn className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Fit to frame (Z)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11 md:h-7 md:w-7"
                    onClick={undo}
                    disabled={undoSize === 0}
                    aria-label="Undo"
                  >
                    <Undo2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Undo (⌘Z)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-11 w-11 md:h-7 md:w-7"
                    onClick={redo}
                    disabled={redoSize === 0}
                    aria-label="Redo"
                  >
                    <Redo2 className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Redo (⌘⇧Z)</TooltipContent>
              </Tooltip>
            </div>

            <div
              ref={stageRef}
              className={cn(
                // #17: touch-none disables browser-native gestures (page
                // scroll / pinch zoom) inside the stage so a tablet/iPad
                // operator can drag pins with one finger without the page
                // hijacking the gesture.
                "absolute inset-0 touch-none",
                tool === TOOLS.PAN && "cursor-grab",
                tool === TOOLS.ADD_PIN && "cursor-crosshair",
                tool === TOOLS.ADD_TEXT && "cursor-text",
              )}
              // #17: Pointer Events unify mouse + touch + stylus. Pointer
              // capture guarantees pointermove/pointerup fire on the stage
              // even if the finger leaves it mid-drag, which removes the
              // need for an onPointerLeave fallback.
              // TODO Wave 4: convert pin-marker handlers to Pointer Events
              // too if we ever attach drag handlers directly to PinMarker
              // (today all hit-testing happens on the stage, so this is a
              // no-op).
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
            >
              {/* Image */}
              {imageUrl ? (
                <img
                  src={imageUrl}
                  alt="drone shot"
                  draggable={false}
                  onLoad={handleImageLoad}
                  onError={() => {
                    setImageLoaded(false);
                    toast.error(
                      "Failed to load shot image — Dropbox proxy may be unavailable",
                    );
                  }}
                  style={{
                    position: "absolute",
                    left: view.panX,
                    top: view.panY,
                    width: imageNatural.w * view.zoom,
                    height: imageNatural.h * view.zoom,
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                />
              ) : (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-muted-foreground p-6 text-center">
                  <ImageIconLucide className="h-10 w-10 opacity-30" />
                  <p className="font-medium">No render available for this shot</p>
                  <p className="text-xs max-w-md">
                    {shots.length === 0
                      ? "Run drone-ingest first to load shots into this shoot."
                      : "Run a render job (drone-render or drone-render-preview) so the editor has an image to draw pins on."}
                  </p>
                </div>
              )}

              {/* Pin overlay */}
              <div
                className="absolute inset-0 pointer-events-none"
                aria-label="pin overlay"
              >
                {projectedItems.map((it) => {
                  const sx = it._pixel.x * view.zoom + view.panX;
                  const sy = it._pixel.y * view.zoom + view.panY;
                  const isSelected = it.id === selectedItemId;
                  return (
                    <PinMarker
                      key={it.id}
                      item={it}
                      x={sx}
                      y={sy}
                      isSelected={isSelected}
                      onPinPointerDown={onPinPointerDown}
                    />
                  );
                })}
              </div>
            </div>
          </main>

          {/* Inspector panel */}
          <aside className="w-72 border-l border-border bg-background overflow-y-auto shrink-0 p-3 text-sm">
            <div className="font-semibold text-xs uppercase text-muted-foreground mb-2">
              Inspector
            </div>
            {!selectedItem ? (
              <p className="text-xs text-muted-foreground">
                Select a pin or text to edit its properties.
              </p>
            ) : (
              <Inspector
                item={selectedItem}
                pose={pose}
                shotsCount={shots.length}
                poseAvailable={poseAvailable}
                onChange={(patch) => updateItem(selectedItem.id, patch)}
                onDelete={() => handleDelete(selectedItem.id)}
                onResetTheme={() => resetToTheme(selectedItem.id)}
                onApplyAll={() => setConfirm("apply_all")}
                onSuppress={() => handleSuppress(selectedItem.id)}
                onUnsuppress={() => handleUnsuppress(selectedItem.id)}
                onResetToAi={() => handleResetToAi(selectedItem.id)}
                resolvedTheme={resolvedTheme}
                disabled={isSaving}
              />
            )}
          </aside>
        </div>

        {/* ── SHOT STRIP ──────────────────────────────────── */}
        <div className="border-t border-border bg-background overflow-x-auto shrink-0">
          <div className="flex items-center gap-2 p-2 min-h-[58px]">
            {shots.length === 0 ? (
              <div className="text-xs text-muted-foreground px-2">
                No shots in this shoot — run drone-ingest first.
              </div>
            ) : (
              shots.map((s, idx) => {
                const active = s.id === activeShotId;
                return (
                  <button
                    type="button"
                    key={s.id}
                    onClick={() => {
                      setActiveShotId(s.id);
                      setSelectedItemId(null);
                      // Bubble the shot change up so the page can update the
                      // URL `?shot=` param and re-derive the imageDropboxPath
                      // → without this the canvas image never swaps even
                      // though `activeShotId` and the Inspector update.
                      if (typeof onShotChange === "function") {
                        onShotChange(s.id);
                      }
                    }}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded border px-2 py-1 text-[10px] shrink-0 transition",
                      active
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300"
                        : "border-border hover:bg-muted",
                    )}
                    title={s.filename}
                  >
                    {/* #10: real thumbnail (was a placeholder icon). The
                        DroneThumbnail component lazy-fetches via the shared
                        media-proxy LRU + IntersectionObserver, so this only
                        loads when the strip scrolls into view. */}
                    <div className="w-12 h-9 overflow-hidden rounded">
                      <DroneThumbnail
                        dropboxPath={s.dropbox_path}
                        mode="thumb"
                        alt={s.filename || "shot"}
                        aspectRatio="aspect-[4/3]"
                      />
                    </div>
                    <span className="font-mono">
                      {s.dji_index ?? idx + 1}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* ── CONFIRMATION DIALOGS ──────────────────────────── */}
        <AlertDialog
          open={confirm === "apply_all"}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-blue-600" />
                Apply to all shots?
              </AlertDialogTitle>
              <AlertDialogDescription>
                World-anchored pins are stored as a single GPS coord. Saving
                with{" "}
                <span className="font-semibold">
                  &quot;all shots&quot;
                </span>{" "}
                scope re-projects this pin onto every render in the shoot
                ({shots.length} shot{shots.length === 1 ? "" : "s"}). Per-shot
                positions for this pin will be overwritten by the inverse
                projection.
                <br />
                <br />
                <span className="text-xs">
                  Pixel-anchored pins (text, ribbons) are unaffected — they
                  remain on their original shot.
                </span>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={isSaving}>
                Cancel
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(null);
                  // #3: scope arg dropped; handleSave is shoot-wide for world
                  // pins regardless. The confirm dialog itself is currently
                  // unreachable (Apply-to-all button is hidden), but kept here
                  // for the day backend fan-out lands.
                  handleSave();
                }}
                disabled={isSaving}
              >
                Apply to all {shots.length} shot
                {shots.length === 1 ? "" : "s"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <AlertDialog
          open={confirm === "cancel_unsaved"}
          onOpenChange={(open) => {
            if (!open) setConfirm(null);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-500" />
                Discard unsaved changes?
              </AlertDialogTitle>
              <AlertDialogDescription>
                You have {dirtyCount} unsaved change
                {dirtyCount === 1 ? "" : "s"}. Leaving the editor will lose
                them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirm(null);
                  onCancel?.();
                }}
                className="bg-destructive hover:bg-destructive/90"
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Inline preview modal — replaces the prior window.open() flow which
            most pop-up blockers killed. drone-render-preview returns a base64
            JPEG of the resolved theme over a stock background scene; we
            display it as a data URL inside a Dialog. */}
        <Dialog
          open={Boolean(previewDataUrl)}
          onOpenChange={(open) => {
            if (!open) setPreviewDataUrl(null);
          }}
        >
          <DialogContent className="max-w-5xl p-0 overflow-hidden">
            <DialogHeader className="px-4 py-3 border-b border-border">
              <DialogTitle className="flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Theme preview
              </DialogTitle>
            </DialogHeader>
            <div className="bg-black flex items-center justify-center max-h-[80vh] overflow-auto">
              {previewDataUrl ? (
                <img
                  src={previewDataUrl}
                  alt="Theme preview"
                  className="max-w-full max-h-[80vh] object-contain"
                />
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────

function ToolButton({ tool, value, setTool, Icon, label, disabled = false }) {
  const active = tool === value;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant={active ? "secondary" : "ghost"}
          // QC7 F21 a11y: aria-label so screen-readers and keyboard users
          // get the tool name (icon-only buttons otherwise render as
          // "button"). aria-pressed mirrors the active-tool state so AT users
          // hear "pressed" / "not pressed" instead of inferring from style.
          // QC7 iPad polish: min-h/w 44px enforces the WCAG / Apple HIG touch
          // target on tablets while keeping the tighter 28px visual on
          // desktop. The icon stays the same size — only the hit area grows
          // via padding from the min-* utilities at >=md breakpoints.
          className="h-11 w-11 md:h-7 md:w-7"
          onClick={() => setTool(value)}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PinMarker({ item, x, y, isSelected, onPinPointerDown }) {
  const color = item.color || "#3B82F6";
  // E9 (W5 P2 S4): explicit pointerdown handler on the marker so a click
  // STARTS A PIN DRAG instead of falling through to the canvas pan
  // handler. Without this the geometric hit-test in the stage's
  // onPointerDown sometimes misses (small markers, label offset) and
  // pan engages instead of drag. stopPropagation prevents the stage
  // handler from also running and clobbering dragState.
  const handlePointerDown = (e) => {
    if (typeof onPinPointerDown === "function") {
      // Stop propagation so the stage's onPointerDown doesn't ALSO start a
      // pan / re-hit-test against this same coordinate.
      e.stopPropagation();
      onPinPointerDown(item, e);
    }
  };
  if (item.kind === "pixel" && item.subtype === "text") {
    return (
      <div
        className={cn(
          "absolute -translate-x-1/2 -translate-y-1/2 px-2 py-1 rounded text-xs font-semibold pointer-events-auto select-none",
          isSelected
            ? "ring-2 ring-blue-500 shadow-lg"
            : "shadow",
        )}
        style={{
          left: x,
          top: y,
          background: "rgba(0,0,0,0.7)",
          color: "#fff",
          // E9: ensure pointer events fire on the marker even when its
          // descendants render with their own pointer rules.
          pointerEvents: "auto",
        }}
        onPointerDown={handlePointerDown}
      >
        {item.label || "Text"}
      </div>
    );
  }
  return (
    <div
      className={cn(
        "absolute -translate-x-1/2 -translate-y-1/2 pointer-events-auto",
      )}
      style={{ left: x, top: y, pointerEvents: "auto" }}
      onPointerDown={handlePointerDown}
    >
      <div
        className={cn(
          "w-4 h-4 rounded-full border-2 border-white shadow-md transition-transform",
          isSelected && "scale-150",
        )}
        style={{ backgroundColor: color }}
      />
      {item.label && (
        <div className="absolute left-3 top-1/2 -translate-y-1/2 whitespace-nowrap text-[10px] font-semibold text-white px-1.5 py-0.5 rounded bg-black/60">
          {item.label}
        </div>
      )}
    </div>
  );
}

function Inspector({
  item,
  pose,
  shotsCount = 0,
  poseAvailable = true,
  onChange,
  onDelete,
  onResetTheme,
  onApplyAll,
  onSuppress,
  onUnsuppress,
  onResetToAi,
  resolvedTheme,
  disabled,
}) {
  void resolvedTheme;
  // #5: The property pin's position is owned by `projects.confirmed_lat/lng`
  // (set by SfM, sometimes overridden in the Project Details page). Inline
  // edits in the Pin Editor would persist as a custom-pin override that
  // silently shadows the project coord without writing back to the project
  // row — confusing, hard to undo, and divergent from what the renderer
  // reads on the next pass. Lock all edit affordances on this virtual item
  // and surface a hint pointing operators to the project page.
  const isPropertyPin = item.virtual === "property";
  const inputsDisabled = disabled || isPropertyPin;
  // F35 (W5 P2 S4): suppressed pins get a Restore affordance instead of
  // Suppress; both lifecycle and the optimistic _suppress flag count.
  const isItemSuppressed =
    item.lifecycle === "suppressed" || item._suppress === true;
  // E6 (W5 P2 S4): AI POIs use suppress instead of delete — Google can
  // re-detect them on the next drone-pois pass, so a hard delete fights
  // the AI ingestion pipeline. Manual pins keep their hard-delete.
  const isAiPin = Boolean(item.isAi || item.source === "ai");

  const [labelDraft, setLabelDraft] = useState(item.label || "");
  useEffect(() => setLabelDraft(item.label || ""), [item.id, item.label]);

  // #29: Color text input validation. Allow partial entry while typing
  // (e.g. "#3B" → "#3B82" → "#3B82F6") via a permissive partial regex; on
  // blur, snap to a valid 6-char hex or revert to the previous valid value.
  const [colorDraft, setColorDraft] = useState(item.color || "");
  useEffect(() => setColorDraft(item.color || ""), [item.id, item.color]);
  const PARTIAL_HEX_RE = /^#[0-9A-Fa-f]{0,6}$/;
  const FULL_HEX_RE = /^#[0-9A-Fa-f]{6}$/;
  const colorFullValid = FULL_HEX_RE.test(colorDraft);

  // QC4 F16: <input type="color"> fires onChange on every step of the
  // native colour-picker drag. Each call hit setItems → pushHistory, so a
  // single "drag the saturation slider once" produced 50+ identical undo
  // entries (cap = 50 → undoing back was almost a no-op). Throttle so we
  // commit at most once per 250ms window during the drag, then a final
  // commit on `onBlur` (covers the close-the-picker case). The local
  // state still updates immediately so the UI feels live.
  const colorChangeRafRef = useRef(null);
  const lastColorCommitRef = useRef(0);
  const pendingColorRef = useRef(null);
  const COLOR_THROTTLE_MS = 250;
  const flushPendingColor = useCallback(() => {
    if (colorChangeRafRef.current) {
      clearTimeout(colorChangeRafRef.current);
      colorChangeRafRef.current = null;
    }
    if (pendingColorRef.current != null) {
      const v = pendingColorRef.current;
      pendingColorRef.current = null;
      lastColorCommitRef.current = Date.now();
      onChange({ color: v });
    }
  }, [onChange]);
  const queueColorCommit = useCallback(
    (next) => {
      pendingColorRef.current = next;
      const elapsed = Date.now() - lastColorCommitRef.current;
      if (elapsed >= COLOR_THROTTLE_MS) {
        flushPendingColor();
      } else if (!colorChangeRafRef.current) {
        colorChangeRafRef.current = setTimeout(
          () => {
            colorChangeRafRef.current = null;
            flushPendingColor();
          },
          COLOR_THROTTLE_MS - elapsed,
        );
      }
    },
    [flushPendingColor],
  );
  // Always flush on unmount or item change so a pending colour doesn't
  // get dropped (the next paint won't re-trigger the timer).
  useEffect(() => {
    return () => flushPendingColor();
  }, [flushPendingColor]);
  useEffect(() => {
    return () => {
      if (colorChangeRafRef.current) {
        clearTimeout(colorChangeRafRef.current);
        colorChangeRafRef.current = null;
      }
    };
  }, []);

  // Compute current pixel position for read-only display
  const px = useMemo(() => {
    if (item.kind === "pixel") return item.pixel;
    if (item.kind === "world" && pose && item.world) {
      return gpsToPixel({
        tlat: item.world.lat,
        tlon: item.world.lng,
        ...pose,
      });
    }
    return null;
  }, [item, pose]);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-xs text-muted-foreground">Type</div>
        <div className="text-sm font-medium capitalize">
          {item.kindLabel ||
            (item.kind === "world" ? "World pin" : "Pixel pin")}
        </div>
      </div>
      {/* #5: Property pin lock-out hint. Renders right under the type so the
          operator sees it before fiddling with the (now disabled) inputs. */}
      {isPropertyPin && (
        <div className="rounded border border-blue-300 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-700 px-2 py-1.5 text-[11px] text-blue-800 dark:text-blue-200 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            The property pin position comes from the SfM-resolved coordinates
            on the project. To override, edit confirmed_lat/lng in the project
            details page.
          </span>
        </div>
      )}
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="pin-label">
          Label
        </label>
        <Input
          id="pin-label"
          value={labelDraft}
          onChange={(e) => setLabelDraft(e.target.value)}
          onBlur={() => onChange({ label: labelDraft })}
          placeholder="(no label)"
          className="h-8 text-sm"
          disabled={inputsDisabled}
        />
      </div>
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="pin-color">
          Color
        </label>
        <div className="flex items-center gap-2">
          <input
            id="pin-color"
            type="color"
            value={colorDraft || item.color || "#3B82F6"}
            // QC4 F16: native colour picker fires onChange continuously
            // during drag. Throttle the upstream commit to 250ms so we
            // don't spam the undo stack (was: 50+ entries per drag); local
            // draft updates immediately for live feedback. onBlur (close
            // picker) flushes any pending value.
            onChange={(e) => {
              const next = e.target.value;
              setColorDraft(next);
              queueColorCommit(next);
            }}
            onBlur={flushPendingColor}
            className="h-8 w-10 rounded border border-input bg-background disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={inputsDisabled}
            aria-label="Pick colour"
          />
          <Input
            value={colorDraft}
            onChange={(e) => {
              const next = e.target.value;
              // Permissive while typing — only update local draft if the
              // value matches the partial-hex shape (or is empty). Reject
              // pasted "rgb(...)", colour names, or other garbage at the
              // input layer rather than letting them leak into item state.
              if (next === "" || PARTIAL_HEX_RE.test(next)) {
                setColorDraft(next);
                // Commit immediately if it's already a valid full 6-char hex.
                if (FULL_HEX_RE.test(next)) onChange({ color: next });
              }
            }}
            onBlur={() => {
              if (FULL_HEX_RE.test(colorDraft)) {
                onChange({ color: colorDraft });
              } else {
                // Revert to the last committed valid value.
                setColorDraft(item.color || "");
              }
            }}
            placeholder="#3B82F6"
            className={cn(
              "h-8 text-sm font-mono",
              !colorFullValid && colorDraft !== "" && "ring-1 ring-red-500",
            )}
            aria-invalid={!colorFullValid && colorDraft !== ""}
            disabled={inputsDisabled}
          />
        </div>
      </div>
      {item.kind === "world" && (
        <div>
          <div className="text-xs text-muted-foreground">World coord</div>
          <div className="text-xs font-mono">
            {item.world ? (
              <>
                {Number(item.world.lat).toFixed(6)},{" "}
                {Number(item.world.lng).toFixed(6)}
              </>
            ) : (
              "—"
            )}
          </div>
        </div>
      )}
      <div>
        <div className="text-xs text-muted-foreground">Pixel coord</div>
        <div className="text-xs font-mono">
          {px ? `${Math.round(px.x)}, ${Math.round(px.y)}` : "off-frame"}
        </div>
      </div>

      {item.kind === "world" && !poseAvailable && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            SfM not available — using raw EXIF GPS prior. Pin position may
            drift across shots.
          </span>
        </div>
      )}
      {item.kind === "world" && !pose && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700 px-2 py-1.5 text-[11px] text-amber-800 dark:text-amber-200 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
          <span>
            This shot is missing pose (GPS / yaw / pitch). Move via inverse
            projection unavailable on this frame.
          </span>
        </div>
      )}

      <div className="border-t border-border pt-2 space-y-1">
        {/* W3-PINS: AI POI badge + per-pin metadata when available. */}
        {item.isAi && (
          <div className="rounded border border-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 dark:border-emerald-700 px-2 py-1.5 text-[11px] text-emerald-800 dark:text-emerald-200 space-y-0.5">
            <div className="flex items-center gap-1 font-medium">
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-400 text-emerald-700 dark:text-emerald-300">
                AI
              </Badge>
              {item.subsource === 'google_places' ? 'Google Places' : (item.subsource || 'AI-detected')}
            </div>
            {item.meta?.distance_m != null && (
              <div className="font-mono">
                {item.meta.distance_m > 999
                  ? `${(item.meta.distance_m / 1000).toFixed(1)} km away`
                  : `${Math.round(item.meta.distance_m)} m away`}
              </div>
            )}
            {item.meta?.type && (
              <div className="capitalize">{String(item.meta.type).replace(/_/g, ' ')}</div>
            )}
            {item.aiOperatorEdited && (
              <div className="italic opacity-80">Operator-edited (snapshot preserved)</div>
            )}
          </div>
        )}
        {item.themeDefaults && (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onResetTheme}
            disabled={inputsDisabled}
          >
            Reset to theme
          </Button>
        )}
        {/* W3-PINS: Reset-to-AI restores world coords + content from the
            latest_ai_snapshot. Only meaningful for AI pins that have been
            operator-edited. */}
        {item.isAi && item.aiOperatorEdited && item.aiSnapshot && (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onResetToAi}
            disabled={inputsDisabled}
            title="Discard your edits and restore Google Places' original position + label"
          >
            Reset to AI
          </Button>
        )}
        {/* W3-PINS: Suppress — soft-hide the pin without deleting. F35
            (W5 P2 S4): when the pin IS already suppressed, swap to a
            Restore affordance instead. Both flip the optimistic local
            state immediately; the save round-trip persists the change. */}
        {item.dbId && !isPropertyPin && !isItemSuppressed && (
          <Button
            size="sm"
            variant="ghost"
            className="w-full"
            onClick={onSuppress}
            disabled={inputsDisabled}
            title="Hide this pin from renders without deleting it"
          >
            <EyeOff className="h-3.5 w-3.5 mr-1" />
            Suppress
          </Button>
        )}
        {item.dbId && !isPropertyPin && isItemSuppressed && (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onUnsuppress}
            disabled={inputsDisabled}
            title="Restore this pin so it appears in renders again"
          >
            <Eye className="h-3.5 w-3.5 mr-1" />
            Restore from suppression
          </Button>
        )}
        {/*
          #3: "Apply to all shots" button is HIDDEN until the backend supports
          proper fan-out. Previously, clicking it stamped scope='all_shots' on
          every dirty edit in the batch — which the server-side validator
          (correctly) rejects on pixel-anchored pins, aborting the entire save.
          For world-anchored pins this is also moot: world coords are already
          shared across every render in the shoot, so dragging the world pin
          once already updates all shots that use the world projection.
          When the backend grows a real per-pin "rebroadcast world coord to all
          renders" pathway, restore this button and pipe scope through to just
          the selected pin (forceItemId) — see notes on issue #3.
          NOTE: Subagent A is removing `scope` from drone-pins-save server-side,
          and `computeSaveEdits` no longer sends it. The onApplyAll prop is
          retained on Inspector for forward compatibility.
        */}
        {false && item.kind === "world" && (
          <Button
            size="sm"
            variant="outline"
            className="w-full gap-1"
            onClick={onApplyAll}
            disabled={disabled}
            title={`Save and re-project this pin onto all ${shotsCount} shots`}
          >
            <Globe className="h-3.5 w-3.5" />
            Apply to all {shotsCount} shot{shotsCount === 1 ? "" : "s"}
          </Button>
        )}
        {/* E6 (W5 P2 S4): Delete is hidden on AI pins. AI pins should
            never be hard-deleted via UI — Google can re-detect them on
            the next drone-pois pass, fighting the hard-delete. Use
            Suppress instead (rendered above for AI). Manual pins keep
            their hard-delete. */}
        {!isAiPin && (
          <Button
            size="sm"
            variant="ghost"
            className="w-full text-red-600 hover:text-red-700"
            onClick={onDelete}
            disabled={inputsDisabled}
          >
            <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Pure helpers (exported only as defaults; kept module-private otherwise) ──

function initialiseItems({ customPins, theme, projectCoord }) {
  const items = [];

  // 1. Property pin (world-anchored, from project coord)
  if (
    projectCoord &&
    Number.isFinite(projectCoord.lat) &&
    Number.isFinite(projectCoord.lng)
  ) {
    const meta = VIRTUAL_WORLD_KINDS.property;
    items.push({
      id: localId("virtual_property"),
      kind: "world",
      kindLabel: "Property pin",
      label: "Property",
      color: meta.color,
      world: { lat: projectCoord.lat, lng: projectCoord.lng },
      virtual: "property",
      themeDefaults: { color: meta.color, label: "Property" },
    });
  }

  // 2. Theme POIs. #12: canonical key is `poi_label.points` — the only
  //    location the renderer reads from. Don't fall back to `themeCfg.pois`;
  //    that legacy key isn't part of the resolved theme schema and reading it
  //    here lets editor-only edits diverge from what actually renders.
  const themeCfg = theme?.resolved_config || theme || {};
  const themePois = Array.isArray(themeCfg.poi_label?.points)
    ? themeCfg.poi_label.points
    : [];
  for (const p of themePois) {
    if (!p) continue;
    if (
      Number.isFinite(p.lat) &&
      (Number.isFinite(p.lng) || Number.isFinite(p.lon))
    ) {
      items.push({
        id: localId("theme_poi"),
        kind: "world",
        kindLabel: "POI",
        label: p.label || p.name || "POI",
        color: p.color || themeCfg.poi_label?.color || "#6366F1",
        world: { lat: p.lat, lng: p.lng ?? p.lon },
        virtual: "theme_poi",
        themeDefaults: {
          color: p.color || themeCfg.poi_label?.color || "#6366F1",
          label: p.label || p.name || "POI",
        },
      });
    }
  }

  // 3. Persisted custom pins
  for (const cp of customPins || []) {
    items.push(adaptCustomPinRow(cp));
  }

  return items;
}

function adaptCustomPinRow(row) {
  const isWorld =
    row.world_lat != null &&
    row.world_lng != null &&
    !row.pixel_anchored_shot_id;
  const style = row.style_overrides || {};
  const content = row.content || {};
  const label = content.label || content.text || "";
  // W3-PINS (mig 268): rows now carry source/subsource/external_ref
  // /lifecycle/latest_ai_snapshot. Surface them so the editor can show
  // the AI badge, suppress + reset-to-AI affordances.
  const source = row.source || 'manual';
  const isAi = source === 'ai';
  return {
    id: row.id,
    dbId: row.id,
    kind: isWorld ? "world" : "pixel",
    kindLabel: isAi ? "AI POI" : (row.pin_type === "text" ? "Text" : "Custom pin"),
    subtype: row.pin_type,
    label,
    // AI pins keep the emerald colour; manual pins blue/white. Style
    // overrides (operator colour pick) still win.
    color:
      style.color ||
      (isAi
        ? "#10B981"
        : row.pin_type === "text"
          ? "#FFFFFF"
          : "#3B82F6"),
    world: isWorld
      ? { lat: Number(row.world_lat), lng: Number(row.world_lng) }
      : null,
    pixel: isWorld
      ? null
      : { x: Number(row.pixel_x), y: Number(row.pixel_y) },
    shot_id: isWorld ? null : row.pixel_anchored_shot_id,
    raw_content: content,
    raw_style: style,
    // ── W3-PINS metadata ───────────────────────────────────────────────
    source,
    subsource: row.subsource || null,
    external_ref: row.external_ref || null,
    lifecycle: row.lifecycle || 'active',
    aiSnapshot: row.latest_ai_snapshot || null,
    updatedBy: row.updated_by || null,
    isAi,
    // True when the operator has touched this AI pin (drag, rename, etc).
    // The "Reset to AI" affordance only makes sense when this is true.
    aiOperatorEdited: isAi && row.updated_by != null,
    meta: isAi
      ? {
          type: content.type || null,
          distance_m: content.distance_m ?? null,
          rating: content.rating ?? null,
        }
      : null,
  };
}

function makeNewItem({ tool, imgPos, activeShotId, pose }) {
  if (tool === TOOLS.ADD_TEXT) {
    return {
      id: localId("text"),
      kind: "pixel",
      kindLabel: "Text",
      subtype: "text",
      label: "New text",
      color: "#FFFFFF",
      pixel: { x: imgPos.x, y: imgPos.y },
      shot_id: activeShotId,
      _new: true,
    };
  }
  if (tool === TOOLS.ADD_PIN) {
    // Try to make it world-anchored if pose available; else pixel-anchored.
    if (pose) {
      const w = pixelToGroundGps({
        px: imgPos.x,
        py: imgPos.y,
        ...pose,
      });
      if (w) {
        return {
          id: localId("poi"),
          kind: "world",
          kindLabel: "POI",
          subtype: "poi_manual",
          label: "New POI",
          color: "#6366F1",
          world: { lat: w.lat, lng: w.lon },
          _new: true,
        };
      }
    }
    return {
      id: localId("pin"),
      kind: "pixel",
      kindLabel: "Pin",
      subtype: "poi_manual",
      label: "New pin",
      color: "#6366F1",
      pixel: { x: imgPos.x, y: imgPos.y },
      shot_id: activeShotId,
      _new: true,
    };
  }
  return null;
}

function computeSaveEdits({ items, shootId, imageNatural }) {
  // #3: `scope` is no longer sent. Subagent A removed scope from
  // drone-pins-save; the editor doesn't need to coordinate it. World pins
  // already fan out across all renders in the shoot via projection at render
  // time, so a "save" is implicitly per-shoot for world pins.
  // #14: `style_overrides: null` is preserved when an item was reset to the
  // theme defaults — letting the row become a true "follow theme" row in DB
  // rather than a colour override that pins it to the current default.
  // #20: pixel coords are clamped to [0, imageNatural.{w,h}] in addition to
  // being rounded, so a pin dragged off-canvas still saves a valid pixel
  // position in-bounds.
  const w = Number.isFinite(imageNatural?.w) ? imageNatural.w : 0;
  const h = Number.isFinite(imageNatural?.h) ? imageNatural.h : 0;
  const edits = [];
  for (const it of items) {
    if (it._delete && it.dbId) {
      edits.push({ action: "delete", pin_id: it.dbId });
      continue;
    }
    // W3-PINS: suppress + reset_to_ai are first-class action types.
    // F35 (W5 P2 S4): un_suppress flips lifecycle back to 'active'.
    // F39 (W5 P2 S4): if a suppress is paired with a coord/content
    // change in the same edit, emit a single 'update' carrying
    // _suppress_after_update=true so the server applies BOTH the
    // mutation and the lifecycle flip (was: suppress alone won, coord
    // change silently dropped).
    const hasCoordOrContentChange =
      it._dirty &&
      (it.kind !== "world" || (it.world && Number.isFinite(it.world.lat)));
    if (it._suppress && it.dbId && !hasCoordOrContentChange) {
      edits.push({ action: "suppress", pin_id: it.dbId });
      continue;
    }
    if (it._unsuppress && it.dbId) {
      edits.push({ action: "un_suppress", pin_id: it.dbId });
      continue;
    }
    if (it._reset_to_ai && it.dbId) {
      edits.push({ action: "reset_to_ai", pin_id: it.dbId });
      continue;
    }
    if (!it._dirty && !it._new) continue;
    if (it.virtual && !it.dbId && it.virtual === "property") {
      // #5: Property pin position is owned by `projects.confirmed_lat/lng`
      // (set by SfM). Operators shouldn't move it inline; if they want to
      // override, they edit the project page. Skip persisting any override
      // edits to the property pin so we don't shadow the canonical project
      // coord with an out-of-band custom pin row.
      continue;
    }
    if (it.virtual && !it.dbId) {
      // Virtual pins (theme POIs) become custom pin rows when first
      // edited. (Property pin handled above.)
    }
    if (it._delete) continue;
    // #14: when the local item explicitly carries style_overrides=null and
    // the colour matches the theme default, persist null (meaning: follow
    // theme). Otherwise persist the colour override as before.
    let styleOverridesPayload;
    if (
      it.style_overrides === null &&
      it.themeDefaults &&
      it.color === it.themeDefaults.color
    ) {
      styleOverridesPayload = null;
    } else {
      styleOverridesPayload = { color: it.color || null };
    }
    const base = {
      action: it.dbId ? "update" : "create",
      pin_id: it.dbId,
      pin_type: it.subtype || (it.kind === "world" ? "poi_manual" : "text"),
      content: { label: it.label || "", text: it.label || "" },
      style_overrides: styleOverridesPayload,
    };
    // F39: when this update edit also carries a suppression, signal the
    // server to flip lifecycle='suppressed' as a follow-up UPDATE so the
    // coord change AND the suppression both land.
    if (it._suppress && it.dbId) {
      base._suppress_after_update = true;
    }
    if (it.kind === "world") {
      base.world_lat = it.world?.lat ?? null;
      base.world_lng = it.world?.lng ?? null;
      base.shoot_id = shootId;
    } else {
      base.pixel_anchored_shot_id = it.shot_id || null;
      // #20: clamp pixel coords to image bounds. A pin nudged off-canvas
      // (Math.round only) used to save with negative or >imageNatural values
      // which then never re-projected back into view on the next session.
      base.pixel_x = Math.max(0, Math.min(w, Math.round(it.pixel?.x ?? 0)));
      base.pixel_y = Math.max(0, Math.min(h, Math.round(it.pixel?.y ?? 0)));
      base.shoot_id = shootId;
    }
    edits.push(base);
  }
  return edits;
}

async function directEntityFallback({ edits }) {
  // Used when the drone-pins-save Edge Function isn't reachable.
  // Writes via api.entities.DroneCustomPin directly (RLS gates access).
  let creates = 0;
  let updates = 0;
  let deletes = 0;
  for (const e of edits) {
    if (e.action === "delete" && e.pin_id) {
      await api.entities.DroneCustomPin.delete(e.pin_id);
      deletes++;
    } else if (e.action === "update" && e.pin_id) {
      await api.entities.DroneCustomPin.update(e.pin_id, payloadFromEdit(e));
      updates++;
    } else if (e.action === "create") {
      await api.entities.DroneCustomPin.create(payloadFromEdit(e));
      creates++;
    }
  }
  return { creates, updates, deletes, fallback: true };
}

function payloadFromEdit(e) {
  return {
    shoot_id: e.shoot_id || null,
    pin_type: e.pin_type,
    world_lat: e.world_lat ?? null,
    world_lng: e.world_lng ?? null,
    pixel_anchored_shot_id: e.pixel_anchored_shot_id ?? null,
    pixel_x: e.pixel_x ?? null,
    pixel_y: e.pixel_y ?? null,
    content: e.content || null,
    style_overrides: e.style_overrides || null,
  };
}

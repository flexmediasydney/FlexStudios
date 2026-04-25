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
import { useBlocker } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
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
  Plus,
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
  projectCoord,
  imageUrl,
  imageError = null, // truthy when source image failed to load
  poseAvailable = true, // false → SfM not available, use GPS prior
  onSave,
  onCancel,
}) {
  // ── State ────────────────────────────────────────────────────────────────
  const [tool, setTool] = useState(TOOLS.SELECT);
  const [activeShotId, setActiveShotId] = useState(currentShotId);
  const [selectedItemId, setSelectedItemId] = useState(null);
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
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
  // TODO(#22): proper fix requires either (a) always rendering against the
  // ORIGINAL drone shot resolution (CSS-scale to fit), or (b) scaling pixel
  // coords from camera-native space → rendered-image space using the ratio
  // (imageNatural.w / pose.w). Option (b) is cheaper but requires every
  // gpsToPixel/pixelToGroundGps call site to scale-and-unscale consistently.
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

  // Items that should be visible on the active shot (after world→pixel projection).
  const projectedItems = useMemo(() => {
    if (!activeShot) return [];
    const out = [];
    for (const item of items) {
      if (hiddenIds.has(item.id)) continue;
      // Master-toggle suppression of overlay markers. Property pin is the
      // virtual "property" item; POIs are theme POIs + any manual poi_manual
      // pin (world or pixel anchored).
      if (!pinEnabled && item.virtual === "property") continue;
      if (
        !poisEnabled &&
        (item.virtual === "theme_poi" || item.subtype === "poi_manual")
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
          if (it.kind !== "world") return { ...it, _dirty: true };
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
            return rest;
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
            return rest;
          }
          const { _previewPixel: _, ...rest } = it;
          return {
            ...rest,
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
      const delta = -e.deltaY * 0.0015;
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
  const updateItem = useCallback(
    (id, patch) => {
      setItems((prev) =>
        prev.map((it) =>
          it.id === id ? { ...it, ...patch, _dirty: true } : it,
        ),
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
      setIsSaving(true);
      try {
        const edits = computeSaveEdits({
          items,
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

        toast.success(
          `Saved ${totalApplied || edits.length} change${
            (totalApplied || edits.length) === 1 ? "" : "s"
          }`,
          {
            description:
              !usedFallback && result?.job_id
                ? "Re-render queued — your renders will refresh shortly."
                : usedFallback
                ? "Edge function unavailable — saved direct (no re-render queued)."
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
        _setItems((prev) =>
          prev
            .filter((i) => !i._delete)
            .map((i) => ({ ...i, _dirty: false, _new: false })),
        );
        clearHistory(undoStack);
        clearHistory(redoStack);
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
      // Open in a new tab so we don't disturb the editing canvas.
      const win = window.open("");
      if (win) {
        win.document.title = "Pin Editor — Preview";
        win.document.body.style.margin = "0";
        win.document.body.style.background = "#000";
        const img = win.document.createElement("img");
        img.src = `data:image/${(data.format || "JPEG").toLowerCase()};base64,${data.image_b64}`;
        img.style.maxWidth = "100vw";
        img.style.maxHeight = "100vh";
        img.style.display = "block";
        img.style.margin = "0 auto";
        win.document.body.appendChild(img);
      } else {
        toast.warning("Pop-up blocked — allow pop-ups to view preview");
      }
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

  // #25: react-router v6.4+ useBlocker handles in-app navigation away from a
  // dirty editor — beforeUnload above only catches full reload / tab close.
  // Confirm via window.confirm to keep this lightweight.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      items.some(isItemDirty) &&
      currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker?.state !== "blocked") return;
    if (window.confirm("You have unsaved pin edits. Discard and leave?")) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);

  // ── UI ──────────────────────────────────────────────────────────────────
  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) || null,
    [items, selectedItemId],
  );

  const dirtyCount = items.filter(isItemDirty).length;

  // Layer groups for the tree.
  const layerGroups = useMemo(() => {
    const groups = {
      world: { label: "World-anchored", items: [] },
      pixel: { label: "Pixel-anchored", items: [] },
    };
    for (const it of items) {
      if (it._delete) continue;
      groups[it.kind === "world" ? "world" : "pixel"].items.push(it);
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
          {/* Layers panel */}
          <aside className="w-60 border-r border-border bg-background overflow-y-auto shrink-0 p-3 text-sm">
            <div className="font-semibold text-xs uppercase text-muted-foreground mb-2">
              Layers
            </div>
            {Object.entries(layerGroups).map(([key, group]) => {
              const folded = foldedGroups.has(key);
              return (
                <div key={key} className="mb-3">
                  <button
                    type="button"
                    onClick={() =>
                      setFoldedGroups((prev) => {
                        const next = new Set(prev);
                        if (next.has(key)) next.delete(key);
                        else next.add(key);
                        return next;
                      })
                    }
                    className="flex items-center gap-1 w-full text-left text-xs font-medium text-foreground/80 hover:text-foreground"
                  >
                    {folded ? (
                      <ChevronRight className="h-3 w-3" />
                    ) : (
                      <ChevronDown className="h-3 w-3" />
                    )}
                    {key === "world" ? (
                      <Globe className="h-3 w-3" />
                    ) : (
                      <ImageIconLucide className="h-3 w-3" />
                    )}
                    {group.label}
                    <span className="text-muted-foreground ml-auto">
                      {group.items.length}
                    </span>
                  </button>
                  {!folded && group.items.length === 0 && (
                    <p className="pl-5 text-[11px] text-muted-foreground italic mt-1">
                      {key === "world"
                        ? "Property + theme POIs (GPS-anchored)"
                        : "Text, ribbons, address overlays (per-shot)"}
                    </p>
                  )}
                  {!folded && (
                    <ul className="mt-1 space-y-0.5 pl-2">
                      {group.items.map((it) => {
                        const isHidden = hiddenIds.has(it.id);
                        const isSelected = it.id === selectedItemId;
                        return (
                          <li
                            key={it.id}
                            className={cn(
                              "flex items-center gap-1 rounded px-1.5 py-1 text-xs cursor-pointer",
                              isSelected
                                ? "bg-blue-100 dark:bg-blue-950 text-blue-900 dark:text-blue-200"
                                : "hover:bg-muted",
                            )}
                            onClick={() => setSelectedItemId(it.id)}
                          >
                            <span
                              className="inline-block w-2 h-2 rounded-full shrink-0"
                              style={{ backgroundColor: it.color || "#888" }}
                            />
                            <span className="truncate flex-1">
                              {it.label || it.kindLabel || "Item"}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setHiddenIds((prev) => {
                                  const next = new Set(prev);
                                  if (next.has(it.id)) next.delete(it.id);
                                  else next.add(it.id);
                                  return next;
                                });
                              }}
                              className="opacity-50 hover:opacity-100 shrink-0"
                              title={isHidden ? "Show" : "Hide"}
                            >
                              {isHidden ? (
                                <EyeOff className="h-3 w-3" />
                              ) : (
                                <Eye className="h-3 w-3" />
                              )}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
            <div className="border-t border-border pt-3 mt-2 space-y-1">
              <Button
                size="sm"
                variant={tool === TOOLS.ADD_PIN ? "secondary" : "ghost"}
                className="w-full justify-start gap-1 text-xs"
                onClick={() => setTool(TOOLS.ADD_PIN)}
                disabled={shots.length === 0}
                title={
                  shots.length === 0
                    ? "No shots in this shoot — add shots first."
                    : poseAvailable
                      ? "Click on canvas to drop a world-anchored pin (GPS)"
                      : "SfM unavailable — pin will be pixel-anchored to this shot"
                }
              >
                <Plus className="h-3 w-3" /> Add POI pin
              </Button>
              <Button
                size="sm"
                variant={tool === TOOLS.ADD_TEXT ? "secondary" : "ghost"}
                className="w-full justify-start gap-1 text-xs"
                onClick={() => setTool(TOOLS.ADD_TEXT)}
                disabled={shots.length === 0}
                title={
                  shots.length === 0
                    ? "No shots in this shoot — add shots first."
                    : "Click on canvas to drop a pixel-anchored text label on this shot"
                }
              >
                <TextIcon className="h-3 w-3" /> Add text
              </Button>
              <p className="text-[10px] text-muted-foreground pl-1 leading-tight pt-1">
                <span className="font-medium">World</span> pins move with GPS
                across all shots.
                <br />
                <span className="font-medium">Pixel</span> labels stay on a
                single shot.
              </p>
            </div>
          </aside>

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
                    className="h-7 w-7"
                    onClick={fitToFrame}
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
                    className="h-7 w-7"
                    onClick={undo}
                    disabled={undoSize === 0}
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
                    className="h-7 w-7"
                    onClick={redo}
                    disabled={redoSize === 0}
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
              // TODO: convert pin-marker handlers to Pointer Events too if
              // we ever attach drag handlers directly to PinMarker (today
              // all hit-testing happens on the stage, so this is a no-op).
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
          className="h-7 w-7"
          onClick={() => setTool(value)}
          disabled={disabled}
        >
          <Icon className="h-3.5 w-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function PinMarker({ item, x, y, isSelected }) {
  const color = item.color || "#3B82F6";
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
        }}
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
      style={{ left: x, top: y }}
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
            value={item.color || "#3B82F6"}
            onChange={(e) => {
              onChange({ color: e.target.value });
              setColorDraft(e.target.value);
            }}
            className="h-8 w-10 rounded border border-input bg-background disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={inputsDisabled}
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
        <Button
          size="sm"
          variant="ghost"
          className="w-full text-red-600 hover:text-red-700"
          onClick={onDelete}
          disabled={inputsDisabled}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
        </Button>
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
  return {
    id: row.id,
    dbId: row.id,
    kind: isWorld ? "world" : "pixel",
    kindLabel: row.pin_type === "text" ? "Text" : "Custom pin",
    subtype: row.pin_type,
    label,
    color: style.color || (row.pin_type === "text" ? "#FFFFFF" : "#3B82F6"),
    world: isWorld
      ? { lat: Number(row.world_lat), lng: Number(row.world_lng) }
      : null,
    pixel: isWorld
      ? null
      : { x: Number(row.pixel_x), y: Number(row.pixel_y) },
    shot_id: isWorld ? null : row.pixel_anchored_shot_id,
    raw_content: content,
    raw_style: style,
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

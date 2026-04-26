/**
 * useBoundaryEditorState — Wave 5 Phase 2 Stream S5
 *
 * State machinery for the new <DroneBoundaryEditor /> component. Mirrors
 * <PinEditor />'s undo/redo + dirty-tracking pattern but for a property
 * boundary polygon + per-overlay tweaks.
 *
 * The hook owns the full editor state shape:
 *
 *   {
 *     polygon: [[lat,lng], ...],          // ≥3 vertices
 *     source:  'cadastral' | 'operator',  // lifecycle marker
 *     overrides: {
 *       side_measurements_enabled,
 *       side_measurements_overrides:    { "<edge_idx>": { hide?, label_offset_px? } },
 *       sqm_total_enabled,
 *       sqm_total_position_offset_px:   [dx, dy] | null,
 *       sqm_total_value_override:       number  | null,
 *       address_overlay_enabled,
 *       address_overlay_position_latlng: [lat, lng] | null,
 *       address_overlay_text_override:   string | null,
 *     },
 *     savedVersion: number | null,        // server-known version
 *     dirty: boolean,                     // true if state diverges from saved
 *   }
 *
 * Action API (returned from the hook alongside the state):
 *   setPolygon(next)                — replace the entire polygon
 *   setVertex(idx, latlng)          — replace one vertex
 *   addVertex(idx, latlng)          — insert a vertex AFTER index `idx`
 *                                     (e.g. dropped on edge midpoint)
 *   deleteVertex(idx)               — remove a vertex (no-op if would drop <3)
 *   translatePolygon(dlat, dlng)    — translate every vertex
 *   setOverride(key, value)         — set one inspector field on overrides
 *   setSideOverride(edgeIdx, patch) — patch one entry in
 *                                     overrides.side_measurements_overrides
 *   undo() / redo()                 — replay history
 *   markSaved(version)              — call after a successful save to clear
 *                                     dirty + bump savedVersion
 *   reset(initialState)             — re-initialise from a fresh server load
 *                                     (used by the 409-conflict refresh path)
 *   buildSaveBody(opts?)            — compose the drone-boundary-save payload
 *                                     using the current state + the version
 *                                     to send for optimistic concurrency
 *
 * Computed helpers:
 *   canUndo, canRedo
 *   canSave        — dirty AND polygon valid (≥3 finite vertices)
 *   polygonValid   — boolean
 *   areaSqm        — geodesic shoelace (UI-side preview only; server is
 *                    authoritative). Lets the inspector show "412 sqm" so
 *                    the operator knows what the renderer will draw.
 */

import { useCallback, useMemo, useRef, useState } from "react";

const HISTORY_CAP = 50;

const DEFAULT_OVERRIDES = Object.freeze({
  side_measurements_enabled: true,
  side_measurements_overrides: null,
  sqm_total_enabled: true,
  sqm_total_position_offset_px: null,
  sqm_total_value_override: null,
  address_overlay_enabled: true,
  address_overlay_position_latlng: null,
  address_overlay_text_override: null,
});

function cloneOverrides(o) {
  // JSON deep-clone — overrides only contain primitives + plain {} / [].
  return o ? JSON.parse(JSON.stringify(o)) : { ...DEFAULT_OVERRIDES };
}

function clonePolygon(p) {
  return Array.isArray(p) ? p.map((v) => [Number(v[0]), Number(v[1])]) : [];
}

function isFiniteLatLng(v) {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    Number.isFinite(Number(v[0])) &&
    Number.isFinite(Number(v[1]))
  );
}

/**
 * Geodesic-shoelace area in sqm. Mirrors render_engine._draw_sqm_total — same
 * local equirectangular ENU projection on the polygon centroid. Caller can
 * round / format. Returns 0 on invalid input.
 */
export function computeAreaSqm(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  const valid = polygon.filter(isFiniteLatLng);
  if (valid.length < 3) return 0;
  const lat0 = valid.reduce((s, v) => s + Number(v[0]), 0) / valid.length;
  const lon0 = valid.reduce((s, v) => s + Number(v[1]), 0) / valid.length;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const enu = valid.map(([lat, lng]) => [
    (lng - lon0) * 111319 * cosLat,
    (lat - lat0) * 111319,
  ]);
  let s = 0;
  for (let i = 0; i < enu.length; i++) {
    const [x1, y1] = enu[i];
    const [x2, y2] = enu[(i + 1) % enu.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

/**
 * Build the initial state object the hook + component share. Pulls fields
 * from a drone_property_boundary row (or the seeded cadastral polygon when
 * no row exists yet). Pure — safe to call inside useState initializer.
 */
export function buildInitialBoundaryState({
  polygon,
  source = "cadastral",
  overrides = null,
  savedVersion = null,
} = {}) {
  return {
    polygon: clonePolygon(polygon),
    source,
    overrides: cloneOverrides(overrides),
    savedVersion: typeof savedVersion === "number" ? savedVersion : null,
    dirty: false,
  };
}

/**
 * The hook itself. Accepts the initial state (from page wrapper after
 * server load) and returns { state, actions, computed }. Internally
 * maintains undo/redo ring buffers and a savedSnapshot to compute dirty.
 */
export default function useBoundaryEditorState(initial) {
  const [state, _setState] = useState(() =>
    initial && typeof initial === "object"
      ? buildInitialBoundaryState(initial)
      : buildInitialBoundaryState(),
  );

  // Saved snapshot — what the server currently has for this row, used by
  // the dirty computation. Re-anchored on markSaved().
  const savedSnapshotRef = useRef(serialiseForDirty(state));

  // Undo / redo ring buffers — same circular-buffer pattern PinEditor uses
  // (#77 — O(1) push, no Array.shift cost on a full buffer).
  const undoStack = useRef({ buf: new Array(HISTORY_CAP), head: 0, size: 0 });
  const redoStack = useRef({ buf: new Array(HISTORY_CAP), head: 0, size: 0 });
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

  /**
   * Internal helper — apply an updater + push the prior state onto undo,
   * clear redo, recompute dirty. Mirrors PinEditor.setItems contract.
   */
  const apply = useCallback(
    (updater) => {
      _setState((prev) => {
        const draft = typeof updater === "function" ? updater(prev) : updater;
        if (!draft || draft === prev) return prev;
        const next = {
          ...draft,
          dirty:
            serialiseForDirty(draft) !== savedSnapshotRef.current,
        };
        pushHistory(undoStack, prev);
        clearHistory(redoStack);
        return next;
      });
    },
    [pushHistory, clearHistory],
  );

  // ── Polygon actions ─────────────────────────────────────────────────────
  const setPolygon = useCallback(
    (next) => {
      const cloned = clonePolygon(next);
      apply((prev) => ({ ...prev, polygon: cloned, source: "operator" }));
    },
    [apply],
  );

  const setVertex = useCallback(
    (idx, latlng) => {
      if (!isFiniteLatLng(latlng)) return;
      apply((prev) => {
        if (idx < 0 || idx >= prev.polygon.length) return prev;
        const polygon = prev.polygon.slice();
        polygon[idx] = [Number(latlng[0]), Number(latlng[1])];
        return { ...prev, polygon, source: "operator" };
      });
    },
    [apply],
  );

  // ── W6 FIX 7 (QC3-5 BE1+BE2): live vertex drag preview ──────────────────
  // The boundary editor's onPointerMove updated `dragRef.current.previewPx`
  // but the VertexHandles + PolygonLines components only read from
  // state.polygon — so the vertex visually never moved during a drag,
  // only snapping to the final position on pointerup. Pushing one history
  // entry per pointermove would explode the undo stack.
  //
  // setPolygonNoHistory: write through to state.polygon (so VertexHandles
  // re-renders) but bypass undo/redo + dirty re-anchor. Used during the
  // drag for the live preview.
  // commitDragHistory: snapshot the pre-drag state onto undoStack so the
  // operator gets ONE undo per drag, not zero (no-history) or N (per move).
  // Caller must hand in the pre-drag polygon snapshot (taken at pointerdown
  // on the dragRef).
  const setPolygonNoHistory = useCallback((next) => {
    const cloned = clonePolygon(next);
    _setState((prev) => {
      const draft = { ...prev, polygon: cloned, source: "operator" };
      return {
        ...draft,
        dirty: serialiseForDirty(draft) !== savedSnapshotRef.current,
      };
    });
  }, []);

  const commitDragHistory = useCallback(
    (preDragSnapshot) => {
      if (!preDragSnapshot || typeof preDragSnapshot !== "object") return;
      pushHistory(undoStack, preDragSnapshot);
      clearHistory(redoStack);
    },
    [pushHistory, clearHistory],
  );

  const addVertex = useCallback(
    (afterIdx, latlng) => {
      if (!isFiniteLatLng(latlng)) return;
      apply((prev) => {
        const insertAt = Math.max(
          0,
          Math.min(prev.polygon.length, afterIdx + 1),
        );
        const polygon = prev.polygon.slice();
        polygon.splice(insertAt, 0, [Number(latlng[0]), Number(latlng[1])]);
        // Re-index side_measurements_overrides — the inserted vertex shifts
        // every subsequent edge index by +1. Without this, the operator's
        // "hide edge 2" would silently apply to edge 3 after an insert.
        const next = { ...prev, polygon, source: "operator" };
        next.overrides = reindexSideOverrides(prev.overrides, insertAt, +1);
        return next;
      });
    },
    [apply],
  );

  const deleteVertex = useCallback(
    (idx) => {
      apply((prev) => {
        if (prev.polygon.length <= 3) return prev; // can't drop below triangle
        if (idx < 0 || idx >= prev.polygon.length) return prev;
        const polygon = prev.polygon.slice();
        polygon.splice(idx, 1);
        const next = { ...prev, polygon, source: "operator" };
        next.overrides = reindexSideOverrides(prev.overrides, idx, -1);
        return next;
      });
    },
    [apply],
  );

  const translatePolygon = useCallback(
    (dlat, dlng) => {
      if (!Number.isFinite(dlat) || !Number.isFinite(dlng)) return;
      apply((prev) => ({
        ...prev,
        polygon: prev.polygon.map(([lat, lng]) => [lat + dlat, lng + dlng]),
        source: "operator",
      }));
    },
    [apply],
  );

  // ── Override actions ────────────────────────────────────────────────────
  const setOverride = useCallback(
    (key, value) => {
      if (!key) return;
      apply((prev) => ({
        ...prev,
        overrides: { ...prev.overrides, [key]: value },
      }));
    },
    [apply],
  );

  /**
   * Patch one entry in side_measurements_overrides. Pass patch={hide:true}
   * to hide edge `edgeIdx`, patch={label_offset_px:[dx,dy]} to nudge.
   * Pass patch=null to clear the entry (re-enable the default rendering).
   */
  const setSideOverride = useCallback(
    (edgeIdx, patch) => {
      apply((prev) => {
        const map = { ...(prev.overrides.side_measurements_overrides || {}) };
        const k = String(edgeIdx);
        if (patch === null) {
          delete map[k];
        } else {
          const existing = map[k] || {};
          map[k] = { ...existing, ...patch };
        }
        return {
          ...prev,
          overrides: {
            ...prev.overrides,
            side_measurements_overrides:
              Object.keys(map).length > 0 ? map : null,
          },
        };
      });
    },
    [apply],
  );

  // ── History ─────────────────────────────────────────────────────────────
  const undo = useCallback(() => {
    _setState((current) => {
      const prev = popHistory(undoStack);
      if (!prev) return current;
      pushHistory(redoStack, current);
      return {
        ...prev,
        dirty: serialiseForDirty(prev) !== savedSnapshotRef.current,
      };
    });
  }, [popHistory, pushHistory]);

  const redo = useCallback(() => {
    _setState((current) => {
      const next = popHistory(redoStack);
      if (!next) return current;
      pushHistory(undoStack, current);
      return {
        ...next,
        dirty: serialiseForDirty(next) !== savedSnapshotRef.current,
      };
    });
  }, [popHistory, pushHistory]);

  // ── Save lifecycle ──────────────────────────────────────────────────────
  /**
   * Re-anchor the savedSnapshot to the current state and stamp the new
   * server version. Call after drone-boundary-save returns 200.
   */
  const markSaved = useCallback((nextVersion) => {
    _setState((prev) => {
      const next = {
        ...prev,
        savedVersion: typeof nextVersion === "number" ? nextVersion : prev.savedVersion,
        dirty: false,
      };
      savedSnapshotRef.current = serialiseForDirty(next);
      return next;
    });
  }, []);

  /**
   * Reset to a fresh server-loaded state — typically called from the
   * 409-conflict path so the operator can see the server's version and
   * choose to re-apply their edits manually.
   */
  const reset = useCallback((initialState) => {
    const built = buildInitialBoundaryState(initialState || {});
    savedSnapshotRef.current = serialiseForDirty(built);
    _setState(built);
    clearHistory(undoStack);
    clearHistory(redoStack);
  }, [clearHistory]);

  /**
   * Build the JSON body for POST /drone-boundary-save. Includes the
   * version_for_concurrency the server will check. Caller can layer
   * action='reset_to_cadastral' on top by passing { reset: true }.
   */
  const buildSaveBody = useCallback(
    ({ projectId, reset: doReset = false } = {}) => {
      if (doReset) {
        return {
          project_id: projectId,
          action: "reset_to_cadastral",
          version_for_concurrency: state.savedVersion,
        };
      }
      return {
        project_id: projectId,
        polygon_latlng: state.polygon,
        side_measurements_enabled: state.overrides.side_measurements_enabled,
        side_measurements_overrides: state.overrides.side_measurements_overrides,
        sqm_total_enabled: state.overrides.sqm_total_enabled,
        sqm_total_position_offset_px:
          state.overrides.sqm_total_position_offset_px,
        sqm_total_value_override: state.overrides.sqm_total_value_override,
        address_overlay_enabled: state.overrides.address_overlay_enabled,
        address_overlay_position_latlng:
          state.overrides.address_overlay_position_latlng,
        address_overlay_text_override:
          state.overrides.address_overlay_text_override,
        version_for_concurrency: state.savedVersion,
      };
    },
    [state],
  );

  // ── Computed ────────────────────────────────────────────────────────────
  const polygonValid = useMemo(() => {
    return (
      Array.isArray(state.polygon) &&
      state.polygon.length >= 3 &&
      state.polygon.every(isFiniteLatLng)
    );
  }, [state.polygon]);

  const canSave = state.dirty && polygonValid;
  const canUndo = undoSize > 0;
  const canRedo = redoSize > 0;

  const areaSqm = useMemo(() => computeAreaSqm(state.polygon), [state.polygon]);

  const actions = useMemo(
    () => ({
      setPolygon,
      setVertex,
      // W6 FIX 7: live-drag helpers — write polygon without pushing history,
      // commit a single undo step at the end of a drag.
      setPolygonNoHistory,
      commitDragHistory,
      addVertex,
      deleteVertex,
      translatePolygon,
      setOverride,
      setSideOverride,
      undo,
      redo,
      markSaved,
      reset,
      buildSaveBody,
    }),
    [
      setPolygon,
      setVertex,
      setPolygonNoHistory,
      commitDragHistory,
      addVertex,
      deleteVertex,
      translatePolygon,
      setOverride,
      setSideOverride,
      undo,
      redo,
      markSaved,
      reset,
      buildSaveBody,
    ],
  );

  const computed = useMemo(
    () => ({ polygonValid, canSave, canUndo, canRedo, areaSqm }),
    [polygonValid, canSave, canUndo, canRedo, areaSqm],
  );

  return { state, actions, computed };
}

// ── Internal helpers (exported for unit tests but not via barrel) ─────────

/**
 * Stable JSON serialisation used for the dirty check. Sorting object keys
 * keeps the comparison stable across {a:1,b:2} vs {b:2,a:1}.
 */
function serialiseForDirty(s) {
  return JSON.stringify({
    polygon: s.polygon,
    source: s.source,
    overrides: sortKeys(s.overrides),
  });
}

function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === "object") {
    return Object.keys(o)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(o[k]);
        return acc;
      }, {});
  }
  return o;
}

/**
 * Re-index side_measurements_overrides keys after a vertex insert/delete.
 * `insertAt` = the polygon index where the change happened. `delta` = +1
 * for insert, -1 for delete. Edges at indexes >= insertAt shift by delta.
 *
 * Returns a new overrides object (or null if the resulting map is empty).
 */
function reindexSideOverrides(overrides, insertAt, delta) {
  const map = overrides?.side_measurements_overrides;
  if (!map || typeof map !== "object") return overrides;
  const next = {};
  for (const [k, v] of Object.entries(map)) {
    const idx = Number(k);
    if (!Number.isFinite(idx)) continue;
    if (idx < insertAt) {
      next[String(idx)] = v;
    } else if (delta < 0 && idx === insertAt) {
      // The deleted edge's overrides drop out — there's no edge anymore.
      continue;
    } else {
      next[String(idx + delta)] = v;
    }
  }
  return {
    ...overrides,
    side_measurements_overrides: Object.keys(next).length > 0 ? next : null,
  };
}

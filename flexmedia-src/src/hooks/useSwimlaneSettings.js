/**
 * useSwimlaneSettings — W11.6.1 swimlane operator UX persistence.
 *
 * Persists the operator's per-user toolbar preferences (sort, preview size,
 * group-by-slot) in localStorage and the per-round filter state in the URL
 * query string. Designed so a hard refresh restores the operator's last view
 * without surprising them.
 *
 * Storage scheme:
 *   localStorage  swimlane-sort-${userId}        — sort key (string)
 *   localStorage  swimlane-preview-size          — sm | md | lg
 *   localStorage  swimlane-group-by-slot         — "1" | "0"
 *   URL ?filter=slot:kitchen_hero,living_hero;room:kitchen,living_room
 *
 * The URL filter syntax is intentionally compact:
 *   - segments separated by ";"
 *   - each segment is "<key>:<csv-of-values>"
 *   - keys: slot, room
 *
 * Per-round vs per-user split:
 *   - Sort, preview size and group-by-slot are persisted per-USER (operator
 *     muscle memory survives across rounds).
 *   - Filter is persisted per-ROUND via the URL because filters reflect what
 *     the operator was just looking at, not a stable preference. URL state
 *     means a copy-paste of the link reproduces the exact view.
 *
 * Safe-by-default: every read swallows storage exceptions (private mode,
 * disabled storage) and falls back to a sensible default. SSR-safe: guards
 * `typeof window`.
 */
import { useCallback, useEffect, useState } from "react";

export const SORT_OPTIONS = [
  { value: "slot_importance", label: "Slot importance" },
  { value: "filename", label: "Filename" },
  { value: "combined_score", label: "Score (high → low)" },
  { value: "group_index", label: "Group index" },
];

export const PREVIEW_SIZES = {
  sm: { px: 96, label: "Small" },
  md: { px: 192, label: "Medium" },
  lg: { px: 256, label: "Large" },
};

const DEFAULT_SORT = "slot_importance";
const DEFAULT_PREVIEW_SIZE = "md";

function safeReadLocal(key, fallback) {
  if (typeof window === "undefined") return fallback;
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

function safeWriteLocal(key, value) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or quota — ignore */
  }
}

/**
 * Parse the current URL's `filter` param into { slotIds:Set, roomTypes:Set }.
 * Tolerant of malformed input — returns empty sets rather than throwing.
 */
export function parseFilterParam(searchString) {
  const out = { slotIds: new Set(), roomTypes: new Set() };
  if (typeof searchString !== "string" || searchString.length === 0) return out;
  let raw;
  try {
    const params = new URLSearchParams(searchString);
    raw = params.get("filter");
  } catch {
    return out;
  }
  if (!raw) return out;
  for (const segment of raw.split(";")) {
    const [key, csv] = segment.split(":");
    if (!key || !csv) continue;
    const values = csv
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (key === "slot") values.forEach((v) => out.slotIds.add(v));
    else if (key === "room") values.forEach((v) => out.roomTypes.add(v));
  }
  return out;
}

/** Inverse of parseFilterParam — Set → compact "slot:a,b;room:c". */
export function serializeFilter({ slotIds, roomTypes }) {
  const segments = [];
  if (slotIds && slotIds.size > 0) {
    segments.push("slot:" + [...slotIds].sort().join(","));
  }
  if (roomTypes && roomTypes.size > 0) {
    segments.push("room:" + [...roomTypes].sort().join(","));
  }
  return segments.join(";");
}

/**
 * Replace the URL's `filter` param without triggering a router navigation —
 * we use history.replaceState so the operator can hard-refresh and restore
 * their view, but back-button doesn't accumulate filter changes.
 */
function writeFilterToUrl(serialized) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (serialized && serialized.length > 0) {
      url.searchParams.set("filter", serialized);
    } else {
      url.searchParams.delete("filter");
    }
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* ignore */
  }
}

export function useSwimlaneSettings({ userId, roundId } = {}) {
  // Sort — per user. Falls back to slot_importance default when no user yet.
  const sortKey = userId ? `swimlane-sort-${userId}` : null;
  const [sort, setSortState] = useState(() =>
    sortKey ? safeReadLocal(sortKey, DEFAULT_SORT) : DEFAULT_SORT,
  );
  // Re-read when userId resolves (auth bootstrap is async).
  useEffect(() => {
    if (!sortKey) return;
    setSortState(safeReadLocal(sortKey, DEFAULT_SORT));
  }, [sortKey]);
  const setSort = useCallback(
    (value) => {
      setSortState(value);
      if (sortKey) safeWriteLocal(sortKey, value);
    },
    [sortKey],
  );

  // Preview size — per user (no userId scoping — same operator across all
  // rounds wants a stable preview size; we keep one global key per browser).
  const [previewSize, setPreviewSizeState] = useState(() =>
    safeReadLocal("swimlane-preview-size", DEFAULT_PREVIEW_SIZE),
  );
  const setPreviewSize = useCallback((value) => {
    if (!Object.prototype.hasOwnProperty.call(PREVIEW_SIZES, value)) return;
    setPreviewSizeState(value);
    safeWriteLocal("swimlane-preview-size", value);
  }, []);

  // Group-by-slot — per user. Stored as "1"/"0" for compactness.
  const [groupBySlot, setGroupBySlotState] = useState(
    () => safeReadLocal("swimlane-group-by-slot", "0") === "1",
  );
  const setGroupBySlot = useCallback((value) => {
    const v = !!value;
    setGroupBySlotState(v);
    safeWriteLocal("swimlane-group-by-slot", v ? "1" : "0");
  }, []);

  // Filter — per round, lives in URL. Initial read from window.location.
  const [filter, setFilterState] = useState(() =>
    typeof window === "undefined"
      ? { slotIds: new Set(), roomTypes: new Set() }
      : parseFilterParam(window.location.search),
  );
  // Re-parse on round switch — same URL, same router instance, but the
  // operator may have navigated within a tab without a full remount.
  useEffect(() => {
    if (typeof window === "undefined") return;
    setFilterState(parseFilterParam(window.location.search));
  }, [roundId]);
  const setFilter = useCallback((next) => {
    const slotIds =
      next?.slotIds instanceof Set ? next.slotIds : new Set(next?.slotIds || []);
    const roomTypes =
      next?.roomTypes instanceof Set
        ? next.roomTypes
        : new Set(next?.roomTypes || []);
    const safe = { slotIds, roomTypes };
    setFilterState(safe);
    writeFilterToUrl(serializeFilter(safe));
  }, []);

  return {
    sort,
    setSort,
    previewSize,
    setPreviewSize,
    groupBySlot,
    setGroupBySlot,
    filter,
    setFilter,
  };
}

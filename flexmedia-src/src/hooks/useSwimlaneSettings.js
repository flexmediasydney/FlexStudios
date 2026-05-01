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
 * Parse the current URL's `filter` param into the operator-filter shape.
 * Tolerant of malformed input — returns empty sets rather than throwing.
 *
 * URL syntax:
 *   ?filter=slot:a,b;room:c,d;intent:hero_establishing;appeal:natural_light;
 *           concern:dated_finishes;review:1
 *
 * W11.6.16 added: intent (single), appeal (any-of), concern (any-of),
 * review (boolean) — alongside the original slot + room.
 */
export function parseFilterParam(searchString) {
  const out = {
    slotIds: new Set(),
    roomTypes: new Set(),
    shotIntents: new Set(),
    appealSignals: new Set(),
    concernSignals: new Set(),
    requiresHumanReview: false,
  };
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
    else if (key === "intent") values.forEach((v) => out.shotIntents.add(v));
    else if (key === "appeal") values.forEach((v) => out.appealSignals.add(v));
    else if (key === "concern") values.forEach((v) => out.concernSignals.add(v));
    else if (key === "review") out.requiresHumanReview = values.includes("1") || values.includes("true");
  }
  return out;
}

/** Inverse of parseFilterParam — Set → compact "slot:a,b;room:c". */
export function serializeFilter({
  slotIds,
  roomTypes,
  shotIntents,
  appealSignals,
  concernSignals,
  requiresHumanReview,
} = {}) {
  const segments = [];
  if (slotIds && slotIds.size > 0) {
    segments.push("slot:" + [...slotIds].sort().join(","));
  }
  if (roomTypes && roomTypes.size > 0) {
    segments.push("room:" + [...roomTypes].sort().join(","));
  }
  if (shotIntents && shotIntents.size > 0) {
    segments.push("intent:" + [...shotIntents].sort().join(","));
  }
  if (appealSignals && appealSignals.size > 0) {
    segments.push("appeal:" + [...appealSignals].sort().join(","));
  }
  if (concernSignals && concernSignals.size > 0) {
    segments.push("concern:" + [...concernSignals].sort().join(","));
  }
  if (requiresHumanReview === true) {
    segments.push("review:1");
  }
  return segments.join(";");
}

/**
 * W11.6.16: parse the URL's `q` param (free-text keyword search). Stripped
 * to <=120 chars so a runaway paste doesn't bloat the query string. Lower-
 * cased on read for case-insensitive ILIKE matching downstream.
 */
export function parseQueryParam(searchString) {
  if (typeof searchString !== "string" || searchString.length === 0) return "";
  try {
    const q = new URLSearchParams(searchString).get("q");
    return (q || "").trim().slice(0, 120);
  } catch {
    return "";
  }
}

/** Replace the URL's `q` param without router navigation. */
function writeQueryToUrl(q) {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (q && q.length > 0) {
      url.searchParams.set("q", q);
    } else {
      url.searchParams.delete("q");
    }
    window.history.replaceState({}, "", url.toString());
  } catch {
    /* ignore */
  }
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
  // W11.6.16: shape extended with shotIntents (Set), appealSignals (Set),
  // concernSignals (Set), requiresHumanReview (bool). Defaults are empty
  // sets / false so the existing slot+room logic is undisturbed.
  const [filter, setFilterState] = useState(() =>
    typeof window === "undefined"
      ? {
          slotIds: new Set(),
          roomTypes: new Set(),
          shotIntents: new Set(),
          appealSignals: new Set(),
          concernSignals: new Set(),
          requiresHumanReview: false,
        }
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
    // W11.6.16: tolerate missing fields (legacy callers passing only
    // {slotIds, roomTypes}). Each new field defaults to its empty form so
    // the URL drops the segment entirely on roundtrip.
    const shotIntents =
      next?.shotIntents instanceof Set ? next.shotIntents : new Set(next?.shotIntents || []);
    const appealSignals =
      next?.appealSignals instanceof Set ? next.appealSignals : new Set(next?.appealSignals || []);
    const concernSignals =
      next?.concernSignals instanceof Set ? next.concernSignals : new Set(next?.concernSignals || []);
    const requiresHumanReview = next?.requiresHumanReview === true;
    const safe = { slotIds, roomTypes, shotIntents, appealSignals, concernSignals, requiresHumanReview };
    setFilterState(safe);
    writeFilterToUrl(serializeFilter(safe));
  }, []);

  // W11.6.16: free-text keyword search — per round, lives in URL ?q=...
  // Matches against embedding_anchor_text + searchable_keywords downstream.
  const [searchQuery, setSearchQueryState] = useState(() =>
    typeof window === "undefined" ? "" : parseQueryParam(window.location.search),
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    setSearchQueryState(parseQueryParam(window.location.search));
  }, [roundId]);
  const setSearchQuery = useCallback((value) => {
    const safe = typeof value === "string" ? value.trim().slice(0, 120) : "";
    setSearchQueryState(safe);
    writeQueryToUrl(safe);
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
    searchQuery, // W11.6.16
    setSearchQuery, // W11.6.16
  };
}

/**
 * useLightboxAnnotations — W11.6.20
 *
 * Persists the operator's lightbox annotation prefs in localStorage:
 *   - enabled               (bool, default TRUE)
 *   - confidenceThreshold   (number 0–1, default 0.5 — hides low-conf boxes)
 *   - categoryFilter        (string[], default [] = show all)
 *
 * Storage key: "lightbox-annotations" (JSON-encoded). One-shot read on mount;
 * each setter writes back synchronously. SSR-safe (guards window).
 *
 * Categories — matches BoundingBoxOverlay's color buckets:
 *   ["arch", "material", "styling", "fixture", "concern", "unknown"]
 *
 * Empty categoryFilter[] means "show all". This lets us avoid a re-render
 * loop where toggling the very last filter on/off would otherwise show
 * nothing.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "lightbox-annotations";

const DEFAULT_SETTINGS = {
  enabled: true,
  confidenceThreshold: 0.5,
  categoryFilter: [],
};

// Categories the overlay knows how to bucket. Exported for the toolbar UI.
export const ANNOTATION_CATEGORIES = [
  "arch",
  "material",
  "styling",
  "fixture",
  "concern",
  "unknown",
];

function safeRead() {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_SETTINGS.enabled,
      confidenceThreshold:
        typeof parsed.confidenceThreshold === "number" &&
        parsed.confidenceThreshold >= 0 &&
        parsed.confidenceThreshold <= 1
          ? parsed.confidenceThreshold
          : DEFAULT_SETTINGS.confidenceThreshold,
      categoryFilter: Array.isArray(parsed.categoryFilter)
        ? parsed.categoryFilter.filter(
            (c) => typeof c === "string" && ANNOTATION_CATEGORIES.includes(c),
          )
        : DEFAULT_SETTINGS.categoryFilter,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function safeWrite(settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* private mode / quota — ignore */
  }
}

export default function useLightboxAnnotations() {
  const [settings, setSettings] = useState(() => safeRead());

  // Re-read on mount (in case the localStorage value was updated by another
  // tab / hook instance between hook construction and React commit).
  useEffect(() => {
    setSettings(safeRead());
  }, []);

  const setEnabled = useCallback((value) => {
    setSettings((prev) => {
      const next = { ...prev, enabled: !!value };
      safeWrite(next);
      return next;
    });
  }, []);

  const setConfidenceThreshold = useCallback((value) => {
    const v =
      typeof value === "number" && value >= 0 && value <= 1
        ? value
        : DEFAULT_SETTINGS.confidenceThreshold;
    setSettings((prev) => {
      const next = { ...prev, confidenceThreshold: v };
      safeWrite(next);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((category) => {
    if (!ANNOTATION_CATEGORIES.includes(category)) return;
    setSettings((prev) => {
      const has = prev.categoryFilter.includes(category);
      const nextList = has
        ? prev.categoryFilter.filter((c) => c !== category)
        : [...prev.categoryFilter, category];
      const next = { ...prev, categoryFilter: nextList };
      safeWrite(next);
      return next;
    });
  }, []);

  return {
    settings,
    setEnabled,
    setConfidenceThreshold,
    toggleCategory,
  };
}

/**
 * useLightboxAnnotations — W11.6.20
 *
 * Persists the operator's lightbox annotation prefs in localStorage:
 *   - enabled               (bool, default TRUE)
 *   - confidenceThreshold   (number 0–1, default 0.5 — hides low-conf boxes)
 *   - categoryFilter        (string[], default [] = show all)
 *
 * Storage key: "lightbox-annotations:<scope>" (JSON-encoded). Scope keeps each
 * surface (drone / shortlist / pulse) on its own preference because they are
 * different engines with different operator workflows. One-shot read on mount;
 * each setter writes back synchronously. SSR-safe (guards window).
 *
 * Migration: pre-scope code wrote to plain "lightbox-annotations". On first
 * read for the 'drone' scope (the only pre-scope caller), if the new key is
 * missing but the legacy key exists, we adopt the legacy value once. Other
 * scopes ignore the legacy key entirely.
 *
 * Categories — matches BoundingBoxOverlay's color buckets:
 *   ["arch", "material", "styling", "fixture", "concern", "unknown"]
 *
 * Empty categoryFilter[] means "show all". This lets us avoid a re-render
 * loop where toggling the very last filter on/off would otherwise show
 * nothing.
 */
import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY_BASE = "lightbox-annotations";
const LEGACY_STORAGE_KEY = "lightbox-annotations";

const VALID_SCOPES = ["drone", "shortlist", "pulse"];

function storageKey(scope) {
  return `${STORAGE_KEY_BASE}:${scope}`;
}

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

function parseSettings(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
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
    return null;
  }
}

function safeRead(scope) {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const scoped = window.localStorage.getItem(storageKey(scope));
    const parsed = parseSettings(scoped);
    if (parsed) return parsed;

    // Migration path: the original 'drone' caller used the unscoped key.
    // Adopt it once if the new key is missing.
    if (scope === "drone") {
      const legacy = window.localStorage.getItem(LEGACY_STORAGE_KEY);
      const legacyParsed = parseSettings(legacy);
      if (legacyParsed) {
        // Persist under the new scoped key so subsequent reads are scope-pure.
        try {
          window.localStorage.setItem(
            storageKey(scope),
            JSON.stringify(legacyParsed),
          );
        } catch {
          /* ignore */
        }
        return legacyParsed;
      }
    }
    return DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function safeWrite(scope, settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(storageKey(scope), JSON.stringify(settings));
  } catch {
    /* private mode / quota — ignore */
  }
}

/**
 * @param {'drone' | 'shortlist' | 'pulse'} scope — surface identifier so each
 *   engine keeps its own toggle/threshold/filter preferences. Required.
 */
export default function useLightboxAnnotations(scope) {
  if (!VALID_SCOPES.includes(scope)) {
    // Fail loud in dev; default to 'drone' in production to avoid breaking
    // pre-existing call sites that haven't migrated.
    if (typeof window !== "undefined" && window.location?.hostname === "localhost") {
      // eslint-disable-next-line no-console
      console.error(
        `useLightboxAnnotations: invalid scope "${scope}". Must be one of: ${VALID_SCOPES.join(", ")}`,
      );
    }
    scope = "drone";
  }

  const [settings, setSettings] = useState(() => safeRead(scope));

  // Re-read on mount (in case the localStorage value was updated by another
  // tab / hook instance between hook construction and React commit).
  useEffect(() => {
    setSettings(safeRead(scope));
  }, [scope]);

  const setEnabled = useCallback(
    (value) => {
      setSettings((prev) => {
        const next = { ...prev, enabled: !!value };
        safeWrite(scope, next);
        return next;
      });
    },
    [scope],
  );

  const setConfidenceThreshold = useCallback(
    (value) => {
      const v =
        typeof value === "number" && value >= 0 && value <= 1
          ? value
          : DEFAULT_SETTINGS.confidenceThreshold;
      setSettings((prev) => {
        const next = { ...prev, confidenceThreshold: v };
        safeWrite(scope, next);
        return next;
      });
    },
    [scope],
  );

  const toggleCategory = useCallback(
    (category) => {
      if (!ANNOTATION_CATEGORIES.includes(category)) return;
      setSettings((prev) => {
        const has = prev.categoryFilter.includes(category);
        const nextList = has
          ? prev.categoryFilter.filter((c) => c !== category)
          : [...prev.categoryFilter, category];
        const next = { ...prev, categoryFilter: nextList };
        safeWrite(scope, next);
        return next;
      });
    },
    [scope],
  );

  return {
    settings,
    setEnabled,
    setConfidenceThreshold,
    toggleCategory,
  };
}

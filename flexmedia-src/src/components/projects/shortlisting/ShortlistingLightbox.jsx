/**
 * ShortlistingLightbox — W11.6.20 swimlane lightbox.
 *
 * The shortlisting swimlane was the missing piece for the bbox feature: the
 * highest-traffic surface (Joseph's daily review workflow) had no way to
 * inspect a card at full size, see the 26-signal scores, or click into the
 * BoundingBoxOverlay. This component fills that gap.
 *
 * Built fresh rather than refactoring DroneLightbox into a generic shell:
 *   - DroneLightbox carries heavy Dropbox-proxy + slot-aware-nav machinery
 *     (905 lines) tied to W11.6.3 DOM contracts. Touching it risks regressing
 *     the Drone tab's existing tests / lightbox UX.
 *   - ExternalListingLightbox is closer to what we want but uses plain
 *     `<img src=…>` (CDN URLs), which won't work for shortlisting raws/finals
 *     that need the Dropbox proxy.
 *   - This component cherry-picks: the Dropbox proxy fetch + per-instance
 *     blob cache from DroneLightbox, the BoundingBoxOverlay/CanonicalObjectPanel
 *     wiring from both, and adds a side panel for signal_scores + slot_decision
 *     + voice_tier metadata that's specific to the shortlisting context.
 *
 * Items shape (caller normalises):
 *   {
 *     id:                 string,    // composition_group id (unique)
 *     dropbox_path:       string,    // proxy path for the FULL-RES image
 *     filename:           string,    // display label
 *     observed_objects:   Array,     // bbox data (W11.6.20 schema v2 percent coords)
 *     signal_scores:      object,    // 26-signal map (key → {raw, normalized})
 *     slot_decision:      object,    // { slot_id, phase, rank } or null
 *     voice_tier:         string,    // optional Stage 4 voice tier label
 *     master_listing:     string,    // optional snippet
 *     classification:     object,    // composition_classifications row
 *   }
 *
 * Props:
 *   items                   - Array<Item>  (length >= 1)
 *   initialIndex            - integer index into items
 *   onClose                 - close handler
 *   bucketLabel             - e.g. "HUMAN APPROVED"  (shown in counter)
 *   allClassificationsInRound - optional, fed to CanonicalObjectPanel
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Image as ImageIcon,
  Eye,
  EyeOff,
  HelpCircle,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { fetchMediaProxy } from "@/utils/mediaPerf";
import { cn } from "@/lib/utils";
import useLightboxAnnotations from "@/hooks/useLightboxAnnotations";
import BoundingBoxOverlay from "./BoundingBoxOverlay";
import CanonicalObjectPanel from "./CanonicalObjectPanel";

const SWIPE_THRESHOLD_PX = 50;

// Per-instance LRU-ish blob cache so opening the lightbox on one bucket
// doesn't pollute SHARED_THUMB_CACHE with full-res blobs (which are 4–8 MB
// each). On unmount we revoke every URL and clear the map. Mirrors the
// DroneLightbox cache pattern.
function makeLightboxCache() {
  return new Map();
}

function makeProxyFetcher(cache) {
  const inflight = new Map();
  return async function fetchProxyUrl(path) {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path);
    if (inflight.has(path)) return inflight.get(path);
    // mode='proxy' fetches the full-res image (vs 'thumb'). The fetchMediaProxy
    // helper already wraps enqueueFetch + LRUBlobCache + retries; we pass our
    // local cache as the writeback target so the SHARED_THUMB_CACHE is left
    // alone.
    const p = fetchMediaProxy(cache, path, "proxy")
      .then((url) => {
        inflight.delete(path);
        return url || null;
      })
      .catch(() => {
        inflight.delete(path);
        return null;
      });
    inflight.set(path, p);
    return p;
  };
}

// Pretty-print a snake_case signal token. "natural_light_quality" → "Natural light quality".
function humanSignalLabel(key) {
  if (!key) return "";
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

function formatScore(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}

export default function ShortlistingLightbox({
  items,
  initialIndex = 0,
  onClose,
  bucketLabel = "",
  allClassificationsInRound = null,
}) {
  const total = items?.length || 0;
  const safeInitial = Math.max(0, Math.min(initialIndex, Math.max(0, total - 1)));
  const [index, setIndex] = useState(safeInitial);
  const safeIndex = total > 0 ? Math.max(0, Math.min(index, total - 1)) : 0;
  const item = total > 0 ? items[safeIndex] : null;

  // ── Annotations / bbox overlay state ────────────────────────────────────
  // 'shortlist' scope — separate from drone + pulse so each surface keeps
  // its own toggle / threshold / category-filter preferences (different
  // engines, different operator workflows). Persisted via localStorage so
  // the operator's preference survives across sessions on this surface.
  const annotations = useLightboxAnnotations("shortlist");
  const overlayOn = annotations.settings.enabled;
  const setOverlayOn = (next) =>
    annotations.setEnabled(typeof next === "function" ? next(overlayOn) : next);
  const [selectedObject, setSelectedObject] = useState(null);
  const imageContainerRef = useRef(null);

  const observedObjects = useMemo(
    () =>
      Array.isArray(item?.observed_objects) ? item.observed_objects : [],
    [item],
  );
  const annotationsAvailable = observedObjects.length > 0;

  // Reset bbox side panel + collapse "Why?" when image changes.
  const [whyExpanded, setWhyExpanded] = useState(false);
  useEffect(() => {
    setSelectedObject(null);
    setWhyExpanded(false);
  }, [safeIndex]);

  // ── Per-instance blob cache + proxy fetcher ─────────────────────────────
  const cacheRef = useRef(null);
  if (cacheRef.current === null) cacheRef.current = makeLightboxCache();
  const fetchProxyUrlRef = useRef(null);
  if (fetchProxyUrlRef.current === null) {
    fetchProxyUrlRef.current = makeProxyFetcher(cacheRef.current);
  }
  const fetchProxyUrl = fetchProxyUrlRef.current;
  const getCachedProxyUrl = useCallback(
    (path) => (path ? cacheRef.current.get(path) || null : null),
    [],
  );

  const [imageUrl, setImageUrl] = useState(() =>
    getCachedProxyUrl(item?.dropbox_path),
  );
  const [isFetching, setIsFetching] = useState(false);
  const [errored, setErrored] = useState(false);
  const mountedRef = useRef(true);
  const touchStartRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Cleanup: revoke every blob URL we created on unmount. Per-instance cache
  // means we can nuke the entire map without affecting the swimlane's
  // SHARED_THUMB_CACHE.
  useEffect(() => {
    return () => {
      const cache = cacheRef.current;
      if (!cache) return;
      for (const url of cache.values()) {
        if (typeof url === "string" && url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            /* ignore */
          }
        }
      }
      cache.clear();
    };
  }, []);

  // Wrap-around prev/next.
  const goPrev = useCallback(() => {
    if (total <= 1) return;
    setIndex((i) => (i > 0 ? i - 1 : total - 1));
  }, [total]);
  const goNext = useCallback(() => {
    if (total <= 1) return;
    setIndex((i) => (i < total - 1 ? i + 1 : 0));
  }, [total]);

  // Re-fetch (or pull from cache) whenever the displayed path changes.
  useEffect(() => {
    const path = item?.dropbox_path || null;
    setErrored(false);
    if (!path) {
      setImageUrl(null);
      setIsFetching(false);
      return;
    }
    const cached = getCachedProxyUrl(path);
    if (cached) {
      setImageUrl(cached);
      setIsFetching(false);
      return;
    }
    setImageUrl(null);
    setIsFetching(true);
    let stale = false;
    fetchProxyUrl(path)
      .then((url) => {
        if (stale || !mountedRef.current) return;
        if (url) {
          setImageUrl(url);
          setErrored(false);
        } else {
          setErrored(true);
        }
        setIsFetching(false);
      })
      .catch(() => {
        if (stale || !mountedRef.current) return;
        setErrored(true);
        setIsFetching(false);
      });
    return () => {
      stale = true;
    };
  }, [item?.dropbox_path]);

  // Predictive preload of neighbours so flicking forward feels instant.
  useEffect(() => {
    if (total <= 1) return;
    const offsets = [1, -1, 2];
    const tasks = [];
    for (const off of offsets) {
      const idx = ((safeIndex + off) % total + total) % total;
      const path = items[idx]?.dropbox_path;
      if (!path) continue;
      if (getCachedProxyUrl(path)) continue;
      tasks.push(fetchProxyUrl(path));
    }
    if (tasks.length > 0) Promise.allSettled(tasks);
  }, [safeIndex, total, items]);

  // Keyboard nav. Esc closes; arrows cycle prev/next.
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") {
        onClose?.();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, goPrev, goNext]);

  // Body scroll lock while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Focus management — capture launcher + focus close button on mount;
  // restore launcher focus on unmount. Without this the keyboard user is
  // stranded after Esc.
  const previousFocusRef = useRef(null);
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);

  useEffect(() => {
    previousFocusRef.current =
      typeof document !== "undefined" ? document.activeElement : null;
    const id = setTimeout(() => {
      try {
        closeButtonRef.current?.focus();
      } catch {
        /* ignore */
      }
    }, 0);
    return () => {
      clearTimeout(id);
      const prev = previousFocusRef.current;
      if (
        prev &&
        typeof prev.focus === "function" &&
        document.contains(prev)
      ) {
        try {
          prev.focus();
        } catch {
          /* ignore */
        }
      }
    };
  }, []);

  // Focus trap — keep Tab within the dialog. Mirrors DroneLightbox's
  // implementation so the two lightboxes feel the same.
  useEffect(() => {
    const onTab = (e) => {
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) =>
          el.offsetParent !== null || el.getClientRects().length > 0,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onTab);
    return () => window.removeEventListener("keydown", onTab);
  }, []);

  // Touch swipe (mobile/tablet).
  const handleTouchStart = (e) => {
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY };
  };
  const handleTouchEnd = (e) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (Math.abs(dx) < SWIPE_THRESHOLD_PX) return;
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx > 0) goPrev();
    else goNext();
  };

  if (!item) return null;

  // ── Side panel data: signal_scores + decision metadata ──────────────────
  // signal_scores from composition_classifications.signal_scores JSONB. Schema
  // can be either a flat number map or {raw, normalized} objects — handle
  // both. We surface the top 8 by value so the panel stays scannable.
  const signalScoresEntries = useMemo(() => {
    const ss = item?.signal_scores;
    if (!ss || typeof ss !== "object") return [];
    const out = [];
    for (const [k, v] of Object.entries(ss)) {
      let val = null;
      if (typeof v === "number") val = v;
      else if (v && typeof v === "object") {
        if (typeof v.normalized === "number") val = v.normalized;
        else if (typeof v.raw === "number") val = v.raw;
      }
      if (val == null) continue;
      out.push({ key: k, label: humanSignalLabel(k), value: val });
    }
    out.sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
    return out.slice(0, 8);
  }, [item]);

  const slot = item?.slot_decision || null;
  const voiceTier = item?.voice_tier || null;
  const masterListing = item?.master_listing || null;

  const counter =
    total > 0
      ? `${safeIndex + 1} of ${total}${bucketLabel ? ` — ${bucketLabel}` : ""}`
      : "";

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={
        item?.filename
          ? `Lightbox — ${item.filename}`
          : "Shortlisting media lightbox"
      }
      // QC-iter2-W7 F-C-012: surface the bucket counter to screen readers via
      // aria-describedby so AT users hear "3 of 12 — HUMAN APPROVED" when the
      // dialog opens (and after each prev/next nav). Without this, the
      // counter is visually present but invisible to non-sighted users.
      aria-describedby="shortlisting-lightbox-counter"
      tabIndex={-1}
      data-testid="shortlisting-lightbox"
      className="fixed inset-0 z-50 flex flex-col bg-black/95 select-none"
      onClick={handleOverlayClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top bar — counter + annotations toggle + close */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10 gap-3">
        <div
          id="shortlisting-lightbox-counter"
          className="text-white/80 text-xs sm:text-sm tabular-nums whitespace-nowrap"
          aria-live="polite"
        >
          {counter}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            data-testid="lightbox-annotations-toggle"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (!annotationsAvailable) return;
              setOverlayOn((v) => !v);
            }}
            disabled={!annotationsAvailable}
            className={cn(
              "p-2 rounded-lg transition-colors",
              annotationsAvailable
                ? overlayOn
                  ? "text-emerald-300 hover:text-emerald-200 hover:bg-white/10 ring-1 ring-emerald-400/30"
                  : "text-white/70 hover:text-white hover:bg-white/10"
                : "text-white/30 cursor-not-allowed",
            )}
            aria-pressed={overlayOn}
            aria-label={
              annotationsAvailable
                ? overlayOn
                  ? "Hide annotations"
                  : "Show annotations"
                : "No annotations available for this image"
            }
            title={
              annotationsAvailable
                ? overlayOn
                  ? "Hide annotations"
                  : "Show annotations"
                : "No annotations available — Stage 1 has not yet detected objects on this image"
            }
          >
            {overlayOn ? (
              <Eye className="h-5 w-5" />
            ) : (
              <EyeOff className="h-5 w-5" />
            )}
          </button>
          <span aria-hidden="true" className="h-5 w-px bg-white/15" />
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
            title="Close (Esc)"
            aria-label="Close lightbox"
            data-testid="lightbox-close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Nav arrows */}
      {total > 1 && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            className="absolute left-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors"
            title="Previous (←)"
            aria-label="Previous"
            data-testid="lightbox-prev"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors"
            title="Next (→)"
            aria-label="Next"
            data-testid="lightbox-next"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Body — image (left) + side panel (right) */}
      <div
        className="flex-1 flex flex-col lg:flex-row items-stretch w-full px-4 sm:px-16 py-14 gap-4"
        onClick={handleOverlayClick}
      >
        {/* Image area */}
        <div
          className="flex-1 flex items-center justify-center min-w-0"
          onClick={handleOverlayClick}
        >
          {imageUrl ? (
            <div
              ref={imageContainerRef}
              data-testid="lightbox-image-frame"
              className="relative max-w-full max-h-full inline-flex"
              onClick={(e) => e.stopPropagation()}
            >
              <img
                src={imageUrl}
                alt={item.filename || "shortlisting media"}
                draggable={false}
                onError={() => setErrored(true)}
                className="max-w-full max-h-full object-contain rounded shadow-lg"
              />
              {overlayOn && annotationsAvailable && (
                <BoundingBoxOverlay
                  observedObjects={observedObjects}
                  imageContainerRef={imageContainerRef}
                  onObjectClick={(obj) => setSelectedObject(obj)}
                />
              )}
              <CanonicalObjectPanel
                object={selectedObject}
                allClassificationsInRound={allClassificationsInRound || []}
                onClose={() => setSelectedObject(null)}
              />
            </div>
          ) : isFetching ? (
            <div className="flex flex-col items-center gap-2 text-white/70">
              <Loader2 className="h-8 w-8 animate-spin" />
              <span className="text-xs">Loading full-resolution…</span>
            </div>
          ) : errored ? (
            <div
              className="flex flex-col items-center gap-2 text-white/70"
              onClick={(e) => e.stopPropagation()}
            >
              <ImageIcon className="h-12 w-12 opacity-40" />
              <span className="text-sm">Preview unavailable</span>
              <span className="text-xs text-white/50 max-w-md text-center break-all">
                {item.dropbox_path}
              </span>
            </div>
          ) : (
            <ImageIcon className="h-12 w-12 text-white/30" />
          )}
        </div>

        {/* Side panel — signal scores + decision metadata + Why? */}
        <aside
          data-testid="lightbox-side-panel"
          className="w-full lg:w-[340px] shrink-0 lg:max-h-full overflow-y-auto rounded-md bg-slate-900/85 backdrop-blur text-white border border-white/10 p-3 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Filename header */}
          <div className="border-b border-white/10 pb-2 mb-2">
            <div
              className="text-sm font-medium truncate"
              title={item.filename || ""}
            >
              {item.filename || "Untitled"}
            </div>
          </div>

          {/* Slot / voice tier badges */}
          {(slot?.slot_id || voiceTier) && (
            <div className="flex flex-wrap items-center gap-1.5 mb-2">
              {slot?.slot_id && (
                <span
                  data-testid="slot-badge"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                    "bg-amber-500/20 text-amber-200 text-[10px] font-medium",
                    "ring-1 ring-amber-400/30",
                  )}
                  title={`Slot: ${slot.slot_id}${slot.phase != null ? ` · phase ${slot.phase}` : ""}`}
                >
                  <span className="opacity-80">Slot:</span>
                  <code className="font-mono text-amber-100">
                    {slot.slot_id}
                  </code>
                  {slot.phase != null && (
                    <span className="opacity-70">P{slot.phase}</span>
                  )}
                </span>
              )}
              {voiceTier && (
                <span
                  data-testid="voice-tier-badge"
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                    "bg-emerald-500/20 text-emerald-200 text-[10px] font-medium",
                    "ring-1 ring-emerald-400/30",
                  )}
                  title="Stage 4 voice tier"
                >
                  <span className="opacity-80">Voice:</span>
                  <span>{voiceTier}</span>
                </span>
              )}
            </div>
          )}

          {/* W11.6.22b — Position panel: only renders when the slot_decision
              has a position_index (curated_positions slot). Cards from
              ai_decides slots have position_index=null so this section is
              hidden entirely (backward compat). */}
          {slot?.position_index != null && (
            <div
              data-testid="position-panel"
              data-position-index={slot.position_index}
              data-position-filled-via={slot.position_filled_via || "unknown"}
              className="mb-3 border-t border-white/10 pt-2"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] uppercase tracking-wide text-white/60">
                  Position
                </div>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
                    slot.position_filled_via === "ai_backfill"
                      ? "bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/30"
                      : "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/30",
                  )}
                  data-testid="position-badge"
                >
                  {slot.position_filled_via === "ai_backfill"
                    ? "AI backfill"
                    : "Curated match"}
                </span>
              </div>
              <div className="text-white/85 font-medium">
                Position {slot.position_index}
                {slot.position_label ? ` — ${slot.position_label}` : ""}
              </div>
              {slot.position_criteria && typeof slot.position_criteria === "object" && (
                <ul className="mt-1.5 space-y-0.5">
                  {Object.entries(slot.position_criteria)
                    .filter(([, v]) => v !== null && v !== undefined && v !== "" && !(Array.isArray(v) && v.length === 0))
                    .map(([k, v]) => (
                      <li
                        key={k}
                        className="flex items-center justify-between gap-2 text-[10px]"
                        data-testid={`position-criterion-${k}`}
                      >
                        <span className="text-white/60 capitalize">
                          {k.replace(/_/g, " ")}
                        </span>
                        <span className="font-mono text-white/85 truncate max-w-[200px]" title={Array.isArray(v) ? v.join(", ") : String(v)}>
                          {Array.isArray(v) ? v.join(", ") : String(v)}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          )}

          {/* 26-signal scores — top 8 */}
          <div className="mb-3">
            <div className="text-[10px] uppercase tracking-wide text-white/60 mb-1">
              Top signals (top 8 of 26)
            </div>
            {signalScoresEntries.length === 0 ? (
              <div className="text-[10px] text-white/40 italic">
                No signal scores recorded.
              </div>
            ) : (
              <ul
                data-testid="signal-scores-list"
                className="space-y-0.5"
              >
                {signalScoresEntries.map((entry) => (
                  <li
                    key={entry.key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span
                      className="text-white/80 truncate"
                      title={entry.label}
                    >
                      {entry.label}
                    </span>
                    <span
                      className="font-mono tabular-nums text-white/90 shrink-0"
                      data-signal-key={entry.key}
                    >
                      {formatScore(entry.value)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Master listing snippet */}
          {masterListing && (
            <div className="mb-3 border-t border-white/10 pt-2">
              <div className="text-[10px] uppercase tracking-wide text-white/60 mb-1">
                Master listing
              </div>
              <p className="text-white/80 leading-snug whitespace-pre-wrap">
                {masterListing}
              </p>
            </div>
          )}

          {/* "Why?" expander — Stage 1 analysis prose */}
          {item?.classification?.analysis && (
            <div className="border-t border-white/10 pt-2">
              <button
                type="button"
                onClick={() => setWhyExpanded((v) => !v)}
                className={cn(
                  "flex items-center gap-1 text-[11px] focus:outline-none rounded-sm px-1 -mx-1",
                  "text-blue-300 hover:underline",
                )}
                aria-expanded={whyExpanded}
                aria-label="Show reasoning for this image"
                data-testid="lightbox-why-toggle"
              >
                <HelpCircle className="h-3 w-3" />
                <span>Why?</span>
                {whyExpanded ? (
                  <ChevronUp className="h-3 w-3" />
                ) : (
                  <ChevronDown className="h-3 w-3" />
                )}
              </button>
              {whyExpanded && (
                <div className="mt-1 text-white/80 leading-snug whitespace-pre-wrap text-[11px]">
                  {item.classification.analysis}
                </div>
              )}
            </div>
          )}

          {/* EXIF — pulled from classification when present.
              QC-iter2-W7 F-C-018: render the highest-signal subset as a
              compact key/value list instead of a full JSON.stringify dump.
              Drone EXIF blobs can run 80+ tags (XMP camera-state spam); the
              dump stretched the side panel and obscured the operator's
              actual mental model (when, what camera/lens, how exposed). The
              curated list keeps the panel scannable; the full blob remains
              available via a "Show all" toggle when needed for debugging. */}
          {item?.classification?.exif && (
            <ExifPanel exif={item.classification.exif} />
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

// QC-iter2-W7 F-C-018: compact EXIF panel. Renders the most operator-relevant
// fields as a scannable key/value list, with a collapsible "Show all" escape
// hatch for debugging. Accepts the same shapes the previous dump did
// (string blob, object map, or stringified JSON nested inside).
const EXIF_TOP_FIELDS = [
  ["DateTimeOriginal", "Captured"],
  ["Make", "Make"],
  ["Model", "Model"],
  ["LensModel", "Lens"],
  ["FocalLength", "Focal length"],
  ["FNumber", "Aperture"],
  ["ExposureTime", "Shutter"],
  ["ISOSpeedRatings", "ISO"],
  ["WhiteBalance", "WB"],
  ["GPSLatitude", "GPS lat"],
  ["GPSLongitude", "GPS lon"],
  ["Orientation", "Orientation"],
];

function ExifPanel({ exif }) {
  const [showAll, setShowAll] = useState(false);
  const exifObj = useMemo(() => {
    if (!exif) return null;
    if (typeof exif === "object") return exif;
    if (typeof exif === "string") {
      try {
        return JSON.parse(exif);
      } catch {
        return null;
      }
    }
    return null;
  }, [exif]);

  // EXIF tag values come in many shapes (raw value, {value, description},
  // arrays for rationals). Surface the most-readable string form.
  const readField = useCallback((key) => {
    if (!exifObj) return null;
    const tag = exifObj[key];
    if (tag == null) return null;
    if (typeof tag === "string" || typeof tag === "number") return String(tag);
    if (typeof tag === "object") {
      if (typeof tag.description === "string" && tag.description.length > 0) {
        return tag.description;
      }
      if (typeof tag.value === "number" || typeof tag.value === "string") {
        return String(tag.value);
      }
      if (Array.isArray(tag.value)) return tag.value.join(", ");
    }
    return null;
  }, [exifObj]);

  if (!exifObj) {
    // Couldn't parse — render the raw blob so debug paths still work.
    return (
      <div className="mt-3 border-t border-white/10 pt-2">
        <div className="text-[10px] uppercase tracking-wide text-white/60 mb-1">
          EXIF
        </div>
        <pre className="text-[10px] text-white/70 whitespace-pre-wrap break-all">
          {typeof exif === "string" ? exif : JSON.stringify(exif, null, 2)}
        </pre>
      </div>
    );
  }

  const rows = EXIF_TOP_FIELDS
    .map(([key, label]) => [label, readField(key)])
    .filter(([, val]) => val != null && val !== "");

  return (
    <div className="mt-3 border-t border-white/10 pt-2" data-testid="lightbox-exif-panel">
      <div className="flex items-center justify-between mb-1">
        <div className="text-[10px] uppercase tracking-wide text-white/60">
          EXIF
        </div>
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="text-[10px] text-blue-300 hover:underline"
          data-testid="lightbox-exif-show-all"
        >
          {showAll ? "Show key fields" : "Show all"}
        </button>
      </div>
      {showAll ? (
        <pre className="text-[10px] text-white/70 whitespace-pre-wrap break-all">
          {JSON.stringify(exifObj, null, 2)}
        </pre>
      ) : rows.length === 0 ? (
        <div className="text-[10px] text-white/40 italic">
          No recognised EXIF fields. Use Show all to inspect raw blob.
        </div>
      ) : (
        <ul className="space-y-0.5">
          {rows.map(([label, val]) => (
            <li
              key={label}
              className="flex items-center justify-between gap-2 text-[10px]"
            >
              <span className="text-white/60">{label}</span>
              <span
                className="font-mono text-white/85 truncate max-w-[200px]"
                title={String(val)}
              >
                {String(val)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

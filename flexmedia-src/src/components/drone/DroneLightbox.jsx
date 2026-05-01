/**
 * DroneLightbox — full-screen viewer for drone shot/render images.
 *
 * Wraps the same authenticated `mediaPerf`/`DroneThumbnail` proxy fetch the
 * rest of the drone module already uses (POST → blob URL). Plain `<img src=…>`
 * URLs 401 at the gateway, so we cannot use the generic AttachmentLightbox.
 *
 * Receives a list of `items` (already filtered/grouped by the caller — e.g. one
 * swimlane column or one role-filtered shot list) and the index of the one to
 * show first. Left/right arrows + ←/→ keys + touch swipe walk through the
 * list with wrap-around. Esc closes.
 *
 * Each item shape (caller normalises to this):
 *   {
 *     dropbox_path: string,           // required — proxy path
 *     filename:     string|null,
 *     shot_role:    string|null,      // shot role label (already humanised) or null
 *     ai_recommended: boolean|null,   // surfaces a small AI badge
 *     status:       string|null,      // small text-only status pill (e.g. "AI Proposed")
 *     id:           string,           // for React keys / preload de-dup
 *     stem:         string|null,      // OPTIONAL — file stem (e.g. "IMG_5751").
 *                                     // Required only when the caller wants
 *                                     // slot-aware nav via filterStems
 *                                     // (W11.6.3 P3 #8). Drone callers may
 *                                     // omit.
 *   }
 *
 * Props:
 *   items         - array of items as above (length >= 1)
 *   initialIndex  - integer index into items
 *   groupLabel    - string shown next to the counter ("Raw Proposed", "Orbital", "All roles")
 *   onClose       - close handler
 *   filterStems   - OPTIONAL string[]|null. Slot-aware nav scope (W11.6.3
 *                   P3 #8): when provided, ←/→ only cycle through items whose
 *                   `stem` is in this set. Pass `null` for unrestricted nav
 *                   (legacy behaviour).
 *   filterLabel   - OPTIONAL string. Pretty label rendered in the slot pill
 *                   (e.g. "kitchen_hero"). Only shown when filterStems is
 *                   active.
 *
 * Slot-aware nav (W11.6.3 P3 #8):
 *   When `filterStems` is provided we precompute a list of indices into
 *   `items` whose stems match. Prev/next walks that virtual list with
 *   wrap-around. The original `items` array is left intact so the
 *   per-instance blob cache + neighbour preload still benefit from the full
 *   set. When `filterStems` is null/undefined, behaviour is unchanged.
 *
 * Graceful degradation: callers walk the DOM via
 *   `event.target.closest('[data-slot-id]')`
 * to find the slot wrapper. If group-by-slot is OFF, no ancestor is found
 * and the caller passes `null` — the lightbox falls back to legacy nav and
 * no slot pill renders. This matters during the W11.6.1 rollout window:
 * before W11.6.1's `data-slot-id` markers ship, this prop is dormant and
 * the lightbox just behaves as it always did.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Loader2,
  Image as ImageIcon,
  Filter,
} from "lucide-react";
import { enqueueFetch } from "@/utils/mediaPerf";
import { cn } from "@/lib/utils";

const SWIPE_THRESHOLD_PX = 50;

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// ── Isolated lightbox blob cache ───────────────────────────────────────────
// The lightbox fetches FULL-RESOLUTION proxy blobs (4–8MB each). If we wrote
// these into SHARED_THUMB_CACHE, opening the lightbox on 200 final renders
// would retain ~1GB of full-res blobs across the whole app until LRU
// eviction. Worse — when we revoked them on close, the swimlane / shots
// subtab thumbnails would silently break (they share the same cache).
//
// Instead each lightbox INSTANCE owns its own Map<path, blobUrl>. On close
// (or unmount) we revoke every blob in that map and clear it. The swimlane's
// SHARED_THUMB_CACHE is never touched.
function makeLightboxCache() {
  return new Map();
}

async function _doFetchProxy(path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON}`,
        },
        body: JSON.stringify({ action: "proxy", file_path: path }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type?.startsWith("image/") && blob.size < 200) return null;
    return URL.createObjectURL(blob);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function makeProxyFetcher(cache) {
  const inflight = new Map();
  return async function fetchProxyUrl(path) {
    if (!path) return null;
    if (cache.has(path)) return cache.get(path);
    if (inflight.has(path)) return inflight.get(path);
    const p = enqueueFetch(() => _doFetchProxy(path)).then((url) => {
      inflight.delete(path);
      if (url) cache.set(path, url);
      return url;
    });
    inflight.set(path, p);
    return p;
  };
}

export default function DroneLightbox({
  items,
  initialIndex = 0,
  groupLabel = "",
  onClose,
  filterStems = null,
  filterLabel = "",
}) {
  const total = items?.length || 0;
  const safeInitial = Math.max(0, Math.min(initialIndex, Math.max(0, total - 1)));
  const [index, setIndex] = useState(safeInitial);
  const safeIndex = total > 0 ? Math.max(0, Math.min(index, total - 1)) : 0;
  const item = total > 0 ? items[safeIndex] : null;

  // ── Slot-aware filter (W11.6.3 P3 #8) ──────────────────────────────────
  // Normalise filterStems → Set for O(1) lookups, then precompute the list
  // of indices into `items` whose stem is in the set. Prev/next walks that
  // list when filterActive; otherwise we walk the full items array (legacy).
  const filterStemSet = useMemo(() => {
    if (!Array.isArray(filterStems)) return null;
    return new Set(filterStems);
  }, [filterStems]);

  const filteredIndices = useMemo(() => {
    if (!filterStemSet) return null;
    const out = [];
    for (let i = 0; i < (items?.length || 0); i++) {
      const stem = items[i]?.stem;
      if (stem && filterStemSet.has(stem)) out.push(i);
    }
    return out;
  }, [items, filterStemSet]);

  // Position of the currently-displayed item within the filtered subset, or
  // -1 if outside. Outside-the-slot is rare (caller picks the click target)
  // but guarded: first ←/→ press jumps into the slot.
  const filterPosition = useMemo(() => {
    if (!filteredIndices) return -1;
    return filteredIndices.indexOf(safeIndex);
  }, [filteredIndices, safeIndex]);

  // Filter is active when caller provided filterStems AND we found at least
  // one matching item. Gates: slot pill, "in slot" counter, filter-aware
  // preload, filter-aware nav arrows.
  const filterActive =
    filteredIndices !== null && filteredIndices.length > 0;

  // QC3 #8 a11y: capture the element that opened the lightbox so we can
  // restore focus on close (without this, AT users — and any keyboard user
  // — get dumped at <body> after Esc). Saved on mount because that's the
  // only frame where document.activeElement is still the launcher button.
  const previousFocusRef = useRef(null);
  // Focus-trap target — the close button inside the dialog. We focus this
  // on mount (so ⇥-Tab cycles inside the modal, not into background
  // content) and use it as the wrap-around landing pad for the trap.
  const closeButtonRef = useRef(null);
  const dialogRef = useRef(null);

  // Per-instance blob cache + fetcher. Lifetime is bounded by this lightbox's
  // mount; on unmount we revoke every blob in the map (see effect below).
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

  // Image state for the currently-displayed item.
  const [imageUrl, setImageUrl] = useState(() => getCachedProxyUrl(item?.dropbox_path));
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

  // ── Cleanup: revoke ALL blob URLs we created when the lightbox unmounts.
  // The local cache holds only this instance's blobs, so it's safe to nuke
  // everything here without affecting the swimlane or shots-subtab thumbs.
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

  // Wrap-around prev/next. Two modes:
  //   1. Filtered (W11.6.3 P3 #8): walks filteredIndices with wrap-around.
  //      The lightbox's `index` state still indexes into the full items
  //      list — we just translate filtered position → filteredIndices[pos]
  //      before setting it. If the initial item is outside the filter, the
  //      first press JUMPS into the slot (last for prev, first for next).
  //   2. Unfiltered (legacy): walks the full items array with wrap-around.
  const goPrev = useCallback(() => {
    if (filterActive) {
      const len = filteredIndices.length;
      if (len <= 1) {
        setIndex(filteredIndices[0]);
        return;
      }
      if (filterPosition < 0) {
        // Currently outside the slot — first prev press lands on the LAST
        // item in the slot (visually "going back into the slot").
        setIndex(filteredIndices[len - 1]);
        return;
      }
      const next = filterPosition > 0 ? filterPosition - 1 : len - 1;
      setIndex(filteredIndices[next]);
      return;
    }
    if (total <= 1) return;
    setIndex((i) => (i > 0 ? i - 1 : total - 1));
  }, [total, filterActive, filteredIndices, filterPosition]);

  const goNext = useCallback(() => {
    if (filterActive) {
      const len = filteredIndices.length;
      if (len <= 1) {
        setIndex(filteredIndices[0]);
        return;
      }
      if (filterPosition < 0) {
        // Currently outside the slot — first next press lands on the FIRST
        // item in the slot.
        setIndex(filteredIndices[0]);
        return;
      }
      const next = filterPosition < len - 1 ? filterPosition + 1 : 0;
      setIndex(filteredIndices[next]);
      return;
    }
    if (total <= 1) return;
    setIndex((i) => (i < total - 1 ? i + 1 : 0));
  }, [total, filterActive, filteredIndices, filterPosition]);

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
  // Walks the wrap-around so the last item preloads index 0 too. Cache writes
  // are dedup'd by mediaPerf — cheap to call repeatedly.
  //
  // When slot-aware filtering is active we preload along the filtered scope —
  // otherwise we'd waste fetches on images the operator can't reach via ←/→
  // (those land on different slot sub-lanes the operator hasn't opened).
  useEffect(() => {
    if (total <= 1) return;
    const offsets = [1, -1, 2];
    const tasks = [];
    if (filterActive) {
      const len = filteredIndices.length;
      if (len <= 1) return;
      // If currently outside the slot, anchor preload at position 0 (where
      // the first ←/→ press will land).
      const anchor = filterPosition >= 0 ? filterPosition : 0;
      for (const off of offsets) {
        const pos = ((anchor + off) % len + len) % len;
        const idx = filteredIndices[pos];
        const path = items[idx]?.dropbox_path;
        if (!path) continue;
        if (getCachedProxyUrl(path)) continue;
        tasks.push(fetchProxyUrl(path));
      }
    } else {
      for (const off of offsets) {
        const idx = ((safeIndex + off) % total + total) % total;
        const path = items[idx]?.dropbox_path;
        if (!path) continue;
        if (getCachedProxyUrl(path)) continue;
        tasks.push(fetchProxyUrl(path));
      }
    }
    if (tasks.length > 0) Promise.allSettled(tasks);
  }, [safeIndex, total, items, filterActive, filteredIndices, filterPosition]);

  // Keyboard navigation.
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

  // QC3 #8: Focus management — on mount, capture launcher + focus close
  // button; on unmount, restore focus to launcher. Without this the
  // keyboard user is stranded with no visible focus ring after Esc.
  useEffect(() => {
    previousFocusRef.current =
      typeof document !== "undefined" ? document.activeElement : null;
    // Defer focus to the next tick so the portal has actually mounted in
    // the DOM (focus on an unmounted ref is a silent no-op in React 18+).
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

  // QC3 #8: Focus trap — keep Tab within the dialog. Without this, ⇥-Tab
  // skips into the background page (which is also scroll-locked, so the
  // user may not even see where focus went). Find every tabbable element
  // inside the dialog on each Tab and wrap from last↔first.
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
          el.offsetParent !== null ||
          el.getClientRects().length > 0 /* visible */,
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

  // Touch swipe (mobile/tablet). Horizontal swipe past threshold = nav;
  // anything else falls through (no scroll: we lock the body anyway).
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
    if (Math.abs(dy) > Math.abs(dx)) return; // mostly-vertical: ignore
    if (dx > 0) goPrev();
    else goNext();
  };

  if (!item) return null;

  // Counter text — when the slot filter is active we show position within
  // the filtered subset (matches what ←/→ traverses); otherwise we show
  // position in the full list. We keep `groupLabel` (caller-supplied free
  // text like "Raw Proposed") at the end of the unfiltered counter for
  // back-compat with the drone module. When outside the slot we fall back
  // to the unfiltered counter style and append "outside slot" so the
  // operator knows ←/→ will jump into the slot.
  const counter =
    total > 0
      ? filterActive
        ? filterPosition >= 0
          ? `${filterPosition + 1} of ${filteredIndices.length} in slot`
          : `${safeIndex + 1} of ${total} (outside slot)`
        : `${safeIndex + 1} of ${total}${groupLabel ? ` — ${groupLabel}` : ""}`
      : "";

  // Pretty label for the slot pill. Caller passes the canonical slot id —
  // we render it verbatim (same convention as ShortlistingCard's slot
  // badge). Falls back to "Slot" if the caller forgot to pass a label.
  const slotPillLabel = filterActive ? filterLabel || "Slot" : null;

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return createPortal(
    <div
      ref={dialogRef}
      // QC3 #8: aria-modal/role tell AT this is a modal dialog so the rest
      // of the page is treated as inert. aria-labelledby points at the
      // counter/filename pair so screen readers announce context on open.
      role="dialog"
      aria-modal="true"
      aria-label={
        item?.filename
          ? `Lightbox — ${item.filename}`
          : "Drone media lightbox"
      }
      tabIndex={-1}
      className="fixed inset-0 z-50 flex flex-col bg-black/95 select-none"
      onClick={handleOverlayClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top bar — counter + slot pill (W11.6.3 P3 #8) + close */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10 gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-white/80 text-xs sm:text-sm tabular-nums whitespace-nowrap">
            {counter}
          </div>
          {/* Slot pill — only renders in slot-aware filtering mode. The
              "X of Y in slot" portion lives in `counter` above; the pill
              itself just shows the slot id so the operator can see at a
              glance which scope ←/→ is bound to. */}
          {slotPillLabel && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5",
                "bg-amber-500/20 text-amber-200 text-[11px] font-medium",
                "ring-1 ring-amber-400/30 shrink-0",
              )}
              title="Slot-aware navigation: arrow keys cycle within this slot"
            >
              <Filter className="h-3 w-3" aria-hidden="true" />
              <span className="opacity-80">Slot:</span>
              <code className="font-mono text-[11px] text-amber-100">
                {slotPillLabel}
              </code>
            </span>
          )}
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
          title="Close (Esc)"
          aria-label="Close lightbox"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Nav arrows. Hidden when nav scope has only one element — for the
          legacy unfiltered case that's `total <= 1`; for slot-aware filtering
          it's `filteredIndices.length <= 1` so the operator doesn't see
          arrows that wrap to the same image. */}
      {(filterActive ? filteredIndices.length > 1 : total > 1) && (
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
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        </>
      )}

      {/* Image area — flex-1, centred. Click image: no-op (avoid accidental close). */}
      <div
        className="flex-1 flex items-center justify-center w-full px-4 sm:px-16 py-14"
        onClick={handleOverlayClick}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={item.filename || "drone media"}
            draggable={false}
            onClick={(e) => e.stopPropagation()}
            onError={() => setErrored(true)}
            className="max-w-full max-h-full object-contain rounded shadow-lg"
          />
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

      {/* Bottom bar — filename + badges */}
      <div
        className="absolute bottom-0 left-0 right-0 px-4 py-3 z-10 bg-gradient-to-t from-black/80 to-transparent"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <div
              className="text-white text-sm font-medium truncate"
              title={item.filename || ""}
            >
              {item.filename || "Untitled"}
            </div>
            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
              {item.shot_role && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/15 text-white/80">
                  {item.shot_role}
                </span>
              )}
              {item.ai_recommended && (
                // QC3 #29 a11y: tooltip-only "title" attribute is keyboard-
                // inaccessible — sighted-mouse users see it on hover, but
                // keyboard-only / AT users get no exposition. Promote to a
                // proper label-bearing element with explicit aria-label so
                // the rationale ("Suggested by AI based on …") is read out
                // when the badge receives focus or is announced inline.
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5",
                    "bg-blue-600/90 text-white",
                  )}
                  role="img"
                  aria-label="AI recommended — suggested by AI based on dedup, flight roll, and POI coverage"
                  title="AI recommended — suggested by AI based on dedup, flight roll, and POI coverage"
                  tabIndex={0}
                >
                  <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                  AI Recommended
                </span>
              )}
              {item.status && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 text-white/70">
                  {item.status}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

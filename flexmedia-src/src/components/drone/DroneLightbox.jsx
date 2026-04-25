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
 *   }
 *
 * Props:
 *   items         - array of items as above (length >= 1)
 *   initialIndex  - integer index into items
 *   groupLabel    - string shown next to the counter ("Raw Proposed", "Orbital", "All roles")
 *   onClose       - close handler
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Loader2,
  Image as ImageIcon,
} from "lucide-react";
import {
  SHARED_THUMB_CACHE,
  enqueueFetch,
  fetchMediaProxy,
} from "@/utils/mediaPerf";
import { cn } from "@/lib/utils";

const SWIPE_THRESHOLD_PX = 50;

// Single source of truth for the proxy fetch — keeps cache-key parity with
// DroneThumbnail. Returns the cached blob URL synchronously when available so
// flicking through pre-loaded items feels instant.
function getCachedProxyUrl(path) {
  if (!path) return null;
  const key = `proxy::default::${path}`;
  return SHARED_THUMB_CACHE.get(key) || null;
}

async function fetchProxyUrl(path) {
  if (!path) return null;
  const url = await enqueueFetch(() =>
    fetchMediaProxy(SHARED_THUMB_CACHE, path, "proxy"),
  );
  return url || null;
}

export default function DroneLightbox({
  items,
  initialIndex = 0,
  groupLabel = "",
  onClose,
}) {
  const total = items?.length || 0;
  const safeInitial = Math.max(0, Math.min(initialIndex, Math.max(0, total - 1)));
  const [index, setIndex] = useState(safeInitial);
  const safeIndex = total > 0 ? Math.max(0, Math.min(index, total - 1)) : 0;
  const item = total > 0 ? items[safeIndex] : null;

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
  // Walks the wrap-around so the last item preloads index 0 too. Cache writes
  // are dedup'd by mediaPerf — cheap to call repeatedly.
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

  const counter =
    total > 0
      ? `${safeIndex + 1} of ${total}${groupLabel ? ` — ${groupLabel}` : ""}`
      : "";

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/95 select-none"
      onClick={handleOverlayClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Top bar — counter + close */}
      <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-4 py-3 z-10">
        <div className="text-white/80 text-xs sm:text-sm tabular-nums">
          {counter}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-2 rounded-lg text-white/70 hover:text-white hover:bg-white/10 transition-colors"
          title="Close (Esc)"
          aria-label="Close lightbox"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Nav arrows (only meaningful when >1 item) */}
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
                <span
                  className={cn(
                    "text-[10px] px-1.5 py-0.5 rounded inline-flex items-center gap-0.5",
                    "bg-blue-600/90 text-white",
                  )}
                  title="Suggested by AI"
                >
                  <Sparkles className="h-2.5 w-2.5" />
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

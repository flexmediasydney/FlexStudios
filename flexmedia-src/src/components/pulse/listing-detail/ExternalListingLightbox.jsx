/**
 * ExternalListingLightbox — W15b.8
 *
 * Lightweight lightbox for external listing images (REA / Domain CDN URLs).
 * The shortlisting `DroneLightbox` is hardcoded to fetch via the Dropbox proxy,
 * which doesn't apply here — but its `BoundingBoxOverlay` *is* reusable, so
 * this component handles the navigation + image loading and delegates the
 * overlay rendering to the shared component.
 *
 * Behaviour:
 *   - Esc closes
 *   - ←/→ + buttons walk forward/backward with wrap
 *   - Eye toggle on the toolbar enables BoundingBoxOverlay when the current
 *     image has observed_objects
 *   - Click a box → opens CanonicalObjectPanel (same UX as the W11.6.20 drone
 *     flow)
 *
 * Items shape: { id, src, title, observed_objects? }
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import BoundingBoxOverlay from "@/components/projects/shortlisting/BoundingBoxOverlay";
import CanonicalObjectPanel from "@/components/projects/shortlisting/CanonicalObjectPanel";

export default function ExternalListingLightbox({ images = [], index = 0, onIndexChange, onClose }) {
  const total = images.length;
  const safeIndex = Math.max(0, Math.min(index, Math.max(0, total - 1)));
  const item = total > 0 ? images[safeIndex] : null;

  const [imgLoading, setImgLoading] = useState(true);
  const [imgErr, setImgErr] = useState(false);
  const [overlayOn, setOverlayOn] = useState(true);
  const [selectedObject, setSelectedObject] = useState(null);
  const imageContainerRef = useRef(null);

  // Reset load state on image change
  useEffect(() => {
    setImgLoading(true);
    setImgErr(false);
    setSelectedObject(null);
  }, [item?.id]);

  const goPrev = useCallback(() => {
    if (total <= 1) return;
    const next = safeIndex > 0 ? safeIndex - 1 : total - 1;
    onIndexChange?.(next);
  }, [total, safeIndex, onIndexChange]);

  const goNext = useCallback(() => {
    if (total <= 1) return;
    const next = safeIndex < total - 1 ? safeIndex + 1 : 0;
    onIndexChange?.(next);
  }, [total, safeIndex, onIndexChange]);

  // Keyboard nav
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose?.();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNext();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goPrev, goNext, onClose]);

  if (!total || !item) return null;

  const observedObjects = Array.isArray(item.observed_objects) ? item.observed_objects : [];
  const hasObjects = observedObjects.length > 0;

  const overlayContent = (
    <div
      className="fixed inset-0 z-[200] bg-black/95 flex flex-col"
      data-testid="external-listing-lightbox"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        // Click on backdrop closes; clicks on inner content (handled by their
        // own stopPropagation) don't.
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-3 z-10 gap-3">
        <div className="text-white/80 text-sm font-mono truncate flex-1 min-w-0" title={item.title}>
          {item.title || `Image ${safeIndex + 1}`}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-white/60 text-xs tabular-nums">
            {safeIndex + 1} / {total}
          </span>
          {hasObjects && (
            <button
              type="button"
              onClick={() => setOverlayOn((v) => !v)}
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs",
                overlayOn ? "bg-white/20 text-white" : "bg-white/5 text-white/70"
              )}
              data-testid="overlay-toggle"
              aria-pressed={overlayOn}
              title={overlayOn ? "Hide annotations" : "Show annotations"}
            >
              {overlayOn ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {observedObjects.length}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center h-8 w-8 rounded-full bg-white/10 hover:bg-white/20 text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Image area */}
      <div
        className="flex-1 flex items-center justify-center px-4 sm:px-16 py-4 relative"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose?.();
        }}
      >
        {/* Prev button */}
        {total > 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goPrev(); }}
            className="absolute left-2 sm:left-6 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white"
            aria-label="Previous"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
        )}

        {/* Image container */}
        <div ref={imageContainerRef} className="relative max-h-full max-w-full">
          {imgErr ? (
            <div className="flex flex-col items-center gap-2 text-white/70 p-8">
              <ImageIcon className="h-10 w-10" />
              <span className="text-sm">Failed to load image</span>
            </div>
          ) : (
            <>
              {imgLoading && (
                <div className="absolute inset-0 flex items-center justify-center text-white/70">
                  <Loader2 className="h-8 w-8 animate-spin" />
                </div>
              )}
              <img
                src={item.src}
                alt={item.title || ""}
                className="max-h-[80vh] max-w-full object-contain"
                onLoad={() => setImgLoading(false)}
                onError={() => { setImgErr(true); setImgLoading(false); }}
              />
              {/* Bounding box overlay */}
              {overlayOn && hasObjects && (
                <BoundingBoxOverlay
                  observedObjects={observedObjects}
                  imageContainerRef={imageContainerRef}
                  onObjectClick={(obj) => setSelectedObject(obj)}
                />
              )}
            </>
          )}
        </div>

        {/* Next button */}
        {total > 1 && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); goNext(); }}
            className="absolute right-2 sm:right-6 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-10 w-10 rounded-full bg-white/10 hover:bg-white/20 text-white"
            aria-label="Next"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Canonical object side panel */}
      {selectedObject && (
        <CanonicalObjectPanel
          object={selectedObject}
          allClassificationsInRound={[]}
          onClose={() => setSelectedObject(null)}
        />
      )}
    </div>
  );

  // Render via portal to escape any parent overflow constraints.
  if (typeof document === "undefined") return null;
  return createPortal(overlayContent, document.body);
}

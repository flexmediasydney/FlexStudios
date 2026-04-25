/**
 * DroneThumbnail — Drone Phase 7 (UX gap fix)
 *
 * Reusable thumbnail tile for drone shots and renders. Reuses the existing
 * FlexStudios media-proxy infrastructure (`getDeliveryMediaFeed` Edge Function +
 * `mediaPerf.js` LRU cache / concurrency limiter / dedup) — same pattern as
 * ProjectMediaGallery, LiveMediaFeed, DeliveryFeed.
 *
 * Why a dedicated component? The drone tab + renders pipeline both need cards
 * with a thumbnail header that:
 *   1. lazy-loads via an intersection observer (only fetches when scrolled into view)
 *   2. shows a shimmer while loading
 *   3. falls back to an icon on error
 *   4. respects React's strict-mode double-mount (mountedRef pattern)
 *
 * The full-resolution variant (`mode='proxy'`) is used by PinEditor to load
 * the source drone JPEG into the canvas at native quality.
 *
 * Props:
 *   - dropboxPath  (required) — full Dropbox path, e.g. "/flexmedia/projects/.../DJI_0001.jpg"
 *   - mode         'thumb' | 'proxy'  (default 'thumb')
 *   - alt          alt text
 *   - className    extra classes for the <img>
 *   - aspectRatio  CSS aspect-ratio class (default 'aspect-[4/3]')
 *   - rounded      bool — round outer container (default false)
 *   - overlay      ReactNode rendered absolutely on top (badges, labels)
 *   - onLoaded     callback fired once the image decodes successfully
 */

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2 } from "lucide-react";
import { SHARED_THUMB_CACHE, enqueueFetch, fetchMediaProxy } from "@/utils/mediaPerf";
import { cn } from "@/lib/utils";

const blobCache = SHARED_THUMB_CACHE;

// #84: Include `size` in the cache key so distinct render-size requests for
// the same path don't collide. The shared media-proxy itself only knows
// 'thumb' vs 'proxy' modes today, but callers may want to differentiate by
// requested display size (e.g. card thumb vs detail dialog) and we don't
// want one consumer's blob to be served in place of another's. The default
// segment 'default' keeps backwards compatibility with existing call sites
// that don't pass `size`.
function cacheKey(path, mode, size) {
  return `${mode}::${size || "default"}::${path}`;
}

/**
 * Fetch a thumbnail (or full-res) blob URL via the existing media proxy.
 * - Layer 1: synchronous LRU cache hit
 * - Layer 2: dedup-aware in-flight tracking (mediaPerf.js)
 * - Layer 3: server-side Supabase Storage CDN cache (7-day TTL)
 */
async function fetchThumb(path, mode = "thumb") {
  const url = await enqueueFetch(() =>
    fetchMediaProxy(SHARED_THUMB_CACHE, path, mode),
  );
  return url || null;
}

export default function DroneThumbnail({
  dropboxPath,
  mode = "thumb",
  // #84: optional size discriminator threaded into the cache key so different
  // call sites requesting the same path at different sizes don't share blobs.
  size,
  alt = "",
  className,
  aspectRatio = "aspect-[4/3]",
  rounded = false,
  overlay = null,
  onLoaded,
}) {
  const [blobUrl, setBlobUrl] = useState(() => {
    // Synchronous cache hit — show immediately, no flash
    if (!dropboxPath) return null;
    return blobCache.get(cacheKey(dropboxPath, mode, size)) || null;
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(Boolean(blobUrl));
  const containerRef = useRef(null);
  const mountedRef = useRef(true);
  const lastPathRef = useRef(blobUrl ? dropboxPath : null);
  const inViewRef = useRef(Boolean(blobUrl));

  // Track mount state so async setStates after unmount are a no-op
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset when path changes
  useEffect(() => {
    if (lastPathRef.current === dropboxPath) return;
    lastPathRef.current = null; // permit re-fetch under new path
    setBlobUrl(null);
    setLoading(false);
    setError(false);
    setImgLoaded(false);
    // If we already have a cached blob for the new path, surface it instantly
    if (dropboxPath) {
      const cached = blobCache.get(cacheKey(dropboxPath, mode, size));
      if (cached) {
        setBlobUrl(cached);
        setImgLoaded(true);
        lastPathRef.current = dropboxPath;
      }
    }
  }, [dropboxPath, mode, size]);

  // IntersectionObserver: only fetch when the tile scrolls into view (or near it).
  // Browsers' native loading="lazy" on <img> doesn't help here because we're
  // proxy-fetching via fetch() — the <img> only renders once we have the blob.
  useEffect(() => {
    if (!dropboxPath) return;
    if (lastPathRef.current === dropboxPath) return;
    if (blobUrl) return;
    const node = containerRef.current;
    if (!node) return;

    // Fast path: when there's no IO support, just fetch immediately
    if (typeof IntersectionObserver === "undefined") {
      inViewRef.current = true;
      kickFetch();
      return;
    }

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            inViewRef.current = true;
            kickFetch();
            io.disconnect();
            break;
          }
        }
      },
      { rootMargin: "200px" }, // pre-fetch slightly before visible
    );
    io.observe(node);
    return () => io.disconnect();

    function kickFetch() {
      if (lastPathRef.current === dropboxPath) return;
      lastPathRef.current = dropboxPath;
      setLoading(true);
      fetchThumb(dropboxPath, mode).then((url) => {
        if (!mountedRef.current) return;
        if (url) {
          setBlobUrl(url);
          setError(false);
          if (typeof onLoaded === "function") {
            try {
              onLoaded(url);
            } catch {
              /* ignore */
            }
          }
        } else {
          setError(true);
        }
        setLoading(false);
      });
    }
  }, [dropboxPath, mode, size, blobUrl, onLoaded]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative bg-muted/40 overflow-hidden flex items-center justify-center text-muted-foreground",
        aspectRatio,
        rounded && "rounded-md",
      )}
    >
      {blobUrl ? (
        <img
          src={blobUrl}
          alt={alt}
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setImgLoaded(true)}
          onError={() => setError(true)}
          className={cn(
            "w-full h-full object-cover transition-opacity duration-200",
            imgLoaded ? "opacity-100" : "opacity-0",
            className,
          )}
        />
      ) : loading ? (
        <Loader2 className="h-5 w-5 animate-spin opacity-50" />
      ) : error ? (
        <div className="flex flex-col items-center gap-1 opacity-40">
          <ImageIcon className="h-7 w-7" />
          <span className="text-[9px] uppercase tracking-wider">No preview</span>
        </div>
      ) : (
        <ImageIcon className="h-7 w-7 opacity-30" />
      )}
      {overlay}
    </div>
  );
}

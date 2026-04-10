import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { LRUBlobCache, enqueueFetch, decodeImage } from "@/utils/mediaPerf";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, FolderOpen, Film, FileText, File,
  ExternalLink, AlertCircle, ImageOff, Camera, Play, Clock,
  Grid2x2, Grid3x3, LayoutGrid, X, ChevronLeft, ChevronRight,
  Download, Loader2, ZoomIn, ZoomOut, ChevronDown, Inbox
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { openInDropbox, downloadFile, buildProxyPath as buildProxyPathUtil, getVideoStreamUrl } from "@/utils/mediaActions";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import { useFavorites } from "@/components/favorites/useFavorites";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Image proxy with concurrent loading + progress tracking ────────
// PERF: LRU blob cache with max 200 entries — revokes oldest blob URLs automatically
const blobCache = new LRUBlobCache(200);
const pending = new Set();

/** Canonical cache key */
function cacheKey(filePath, mode = 'thumb') {
  return `${mode}::${filePath}`;
}

/** Build proxy path from base + file, safely handling undefined file.path */
function buildProxyPath(basePath, file) {
  if (!basePath || !file?.name || !file?.path) return null;
  return `${basePath}${file.path.startsWith('/') ? file.path : '/' + file.path}`;
}

// Observable load-progress counter
let _loadedCount = 0;
let _totalQueued = 0;
const _progressListeners = new Set();
function notifyProgress() { _progressListeners.forEach(fn => fn({ loaded: _loadedCount, total: _totalQueued })); }
function subscribeProgress(fn) { _progressListeners.add(fn); return () => _progressListeners.delete(fn); }
function resetProgress() { _loadedCount = 0; _totalQueued = 0; notifyProgress(); }

// PERF: fetchProxyImage now routes through global concurrency limiter + img.decode()
async function fetchProxyImage(filePath, mode = 'thumb') {
  const key = cacheKey(filePath, mode);
  if (blobCache.has(key)) return blobCache.get(key);
  if (pending.has(key)) return null;
  pending.add(key);
  try {
    const url = await enqueueFetch(async () => {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
        body: JSON.stringify({ action: mode, file_path: filePath }),
      });
      if (!res.ok) return null;
      const blob = await res.blob();
      if (blob.size < 500) return null;
      const blobUrl = URL.createObjectURL(blob);
      // PERF: decode image off main thread before caching to avoid jank
      if (mode === 'thumb') await decodeImage(blobUrl);
      return blobUrl;
    });
    if (url) blobCache.set(key, url);
    // Only count thumbnail fetches toward progress (lightbox full-res fetches shouldn't inflate the count)
    if (mode === 'thumb') { _loadedCount++; notifyProgress(); }
    return url;
  } catch { return null; }
  finally { pending.delete(key); }
}

// ─── Helpers ────────────────────────────────────────────────────────

function FileIcon({ type, className }) {
  switch (type) {
    case "image":    return <Camera className={className} />;
    case "video":    return <Film className={className} />;
    case "document": return <FileText className={className} />;
    default:         return <File className={className} />;
  }
}

function formatSize(bytes) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(dateStr) {
  if (!dateStr) return null;
  try { return formatDistanceToNow(new Date(dateStr), { addSuffix: true }); } catch { return null; }
}

function formatUploadTime(dateStr) {
  if (!dateStr) return null;
  try { return format(new Date(dateStr), "MMM d, yyyy 'at' h:mm a"); } catch { return null; }
}

// ─── CSS: shimmer, fade-in, float, lightbox animations ──────────────

const STYLE_ID = "pmg-gallery-styles";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes pmg-shimmer {
      0%   { background-position: -400px 0; }
      100% { background-position: 400px 0; }
    }
    .pmg-shimmer {
      background: linear-gradient(90deg,
        hsl(var(--muted)) 0%,
        hsl(var(--muted) / 0.4) 40%,
        hsl(var(--muted)) 80%);
      background-size: 800px 100%;
      animation: pmg-shimmer 1.6s ease-in-out infinite;
    }
    .pmg-fade-in {
      opacity: 0;
      transition: opacity 200ms ease-out;
    }
    .pmg-fade-in.pmg-loaded {
      opacity: 1;
    }
    @keyframes pmg-float {
      0%, 100% { transform: translateY(0); }
      50%      { transform: translateY(-6px); }
    }
    .pmg-float { animation: pmg-float 3s ease-in-out infinite; }
    @keyframes pmg-pulse-ring {
      0%   { transform: scale(1);    opacity: 0.4; }
      50%  { transform: scale(1.08); opacity: 0.15; }
      100% { transform: scale(1);    opacity: 0.4; }
    }
    .pmg-pulse-ring { animation: pmg-pulse-ring 2.5s ease-in-out infinite; }
    @keyframes pmg-lightbox-in {
      from { opacity: 0; backdrop-filter: blur(0px); }
      to   { opacity: 1; backdrop-filter: blur(4px); }
    }
    .pmg-lightbox-enter { animation: pmg-lightbox-in 280ms ease-out forwards; }
    @keyframes pmg-lightbox-img-in {
      from { opacity: 0; transform: scale(0.95); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes pmg-empty-dot-pulse {
      0%, 100% { opacity: 0.08; }
      50%      { opacity: 0.18; }
    }
    .pmg-dot-grid {
      background-image: radial-gradient(circle, currentColor 1px, transparent 1px);
      background-size: 20px 20px;
      animation: pmg-empty-dot-pulse 4s ease-in-out infinite;
    }
    .pmg-lightbox-img-enter { animation: pmg-lightbox-img-in 250ms ease-out forwards; }
  `;
  document.head.appendChild(style);
}

// ─── Shimmer skeleton card (matches real card layout) ───────────────

function SkeletonCard() {
  return (
    <div className="rounded-lg border bg-card overflow-hidden" aria-hidden="true">
      <div className="aspect-[4/3] pmg-shimmer" />
      <div className="p-2 space-y-1.5">
        <div className="h-3 w-3/4 rounded pmg-shimmer" />
        <div className="h-2.5 w-1/2 rounded pmg-shimmer" />
      </div>
    </div>
  );
}

// ─── Loading progress indicator ─────────────────────────────────────

function LoadingProgress() {
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  useEffect(() => subscribeProgress(setProgress), []);

  if (progress.total === 0) return null;
  const pct = Math.round((progress.loaded / progress.total) * 100);
  const done = progress.loaded >= progress.total;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 text-xs text-muted-foreground transition-opacity duration-500",
        done && "opacity-0 pointer-events-none"
      )}
      role="progressbar"
      aria-valuenow={progress.loaded}
      aria-valuemin={0}
      aria-valuemax={progress.total}
      aria-label={`Loading thumbnails: ${progress.loaded} of ${progress.total}`}
    >
      <Loader2 className="h-3 w-3 animate-spin shrink-0" />
      <span>Loading {progress.loaded} of {progress.total} images{pct > 0 ? ` (${pct}%)` : ""}...</span>
      <div className="h-1.5 w-24 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary/70 rounded-full transition-all duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── MediaLightbox -- fullscreen viewer with zoom + swipe ───────────

function MediaLightbox({ files, initialIndex, tonomoBasePath, deliverableLink, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [fullResUrl, setFullResUrl] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  const [loadingFullRes, setLoadingFullRes] = useState(false);
  const touchStartRef = useRef(null);

  const safeIndex = files.length > 0 ? Math.max(0, Math.min(index, files.length - 1)) : 0;
  const file = files.length > 0 ? files[safeIndex] : null;

  const isVideo = file?.type === 'video';
  const isImage = file?.type === 'image';
  const proxyPath = buildProxyPath(tonomoBasePath, file);

  // Videos: use streaming URL (browser streams directly, instant playback)
  useEffect(() => {
    if (!isVideo || !proxyPath) { setVideoUrl(null); setVideoLoading(false); return; }
    // Instant — just set the streaming URL, browser handles buffering
    setVideoUrl(getVideoStreamUrl(proxyPath));
    setVideoLoading(false);
  }, [isVideo, proxyPath]);

  // Images: thumb immediate, full-res background upgrade
  useEffect(() => {
    if (!isImage || !proxyPath) { setFullResUrl(null); setLoadingFullRes(false); return; }
    let stale = false;
    setFullResUrl(null);
    setZoomed(false);
    const cached = blobCache.get(cacheKey(proxyPath, 'proxy'));
    if (cached) { setFullResUrl(cached); setLoadingFullRes(false); return; }
    setLoadingFullRes(true);
    fetchProxyImage(proxyPath, 'proxy').then(url => {
      if (!stale) { if (url) setFullResUrl(url); setLoadingFullRes(false); }
    });
    return () => { stale = true; };
  }, [isImage, proxyPath]);

  // ─── Predictive preloading ─────────────────────────────────────────
  // When viewing image N, preload N+1, N+2, N-1 full-res in background.
  // This makes forward/backward navigation feel instant.
  useEffect(() => {
    if (!tonomoBasePath || files.length === 0) return;
    const preloadOffsets = [1, 2, -1]; // next, next+1, previous
    const preloadTasks = [];

    for (const offset of preloadOffsets) {
      const targetIdx = safeIndex + offset;
      if (targetIdx < 0 || targetIdx >= files.length) continue;
      const targetFile = files[targetIdx];
      if (!targetFile || targetFile.type === 'video') continue; // skip videos (too large)
      const targetPath = buildProxyPath(tonomoBasePath, targetFile);
      if (!targetPath) continue;
      const key = cacheKey(targetPath, 'proxy');
      if (blobCache.has(key)) continue; // already cached
      // Preload at low priority — don't block current image
      preloadTasks.push(fetchProxyImage(targetPath, 'proxy'));
    }

    // Fire and forget — these cache themselves
    if (preloadTasks.length > 0) {
      Promise.allSettled(preloadTasks);
    }
  }, [safeIndex, files.length, tonomoBasePath]);

  // Keyboard nav + focus trapping
  const dialogRef = useRef(null);
  useEffect(() => {
    const len = files.length;
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (len === 0) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); setIndex(i => Math.max(0, i - 1)); setZoomed(false); }
      if (e.key === 'ArrowRight') { e.preventDefault(); setIndex(i => Math.min(len - 1, i + 1)); setZoomed(false); }
      // Focus trap: keep Tab within the lightbox dialog
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll('button, [tabindex="0"], a[href]');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', handler);
    // Auto-focus close button on mount for screen readers
    const closeBtn = dialogRef.current?.querySelector('[aria-label="Close lightbox"]');
    if (closeBtn) closeBtn.focus();
    return () => window.removeEventListener('keydown', handler);
  }, [files.length, onClose]);

  // Lock body scroll
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Touch / swipe
  const handleTouchStart = useCallback((e) => {
    if (zoomed) return;
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
  }, [zoomed]);

  const handleTouchEnd = useCallback((e) => {
    if (!touchStartRef.current || zoomed) return;
    const dx = e.changedTouches[0].clientX - touchStartRef.current.x;
    const dy = e.changedTouches[0].clientY - touchStartRef.current.y;
    const dt = Date.now() - touchStartRef.current.time;
    touchStartRef.current = null;
    if (dt > 500 || Math.abs(dy) > Math.abs(dx)) return;
    if (dx < -50 && index < files.length - 1) { setIndex(i => i + 1); setZoomed(false); }
    if (dx > 50 && index > 0) { setIndex(i => i - 1); setZoomed(false); }
  }, [index, files.length, zoomed]);

  const thumbUrl = isImage ? blobCache.get(cacheKey(proxyPath, 'thumb')) : null;
  const imgBlobUrl = fullResUrl || thumbUrl;

  const toggleZoom = useCallback((e) => {
    e.stopPropagation();
    if (isImage) setZoomed(z => !z);
  }, [isImage]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col pmg-lightbox-enter select-none"
      onClick={onClose}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${file?.name || "media"}, ${safeIndex + 1} of ${files.length}`}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 text-white shrink-0" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium truncate max-w-md">{file?.name}</span>
          <span className="text-xs text-white/40">{formatSize(file?.size)}</span>
          <span className="text-xs text-white/40">{safeIndex + 1} / {files.length}</span>
          {loadingFullRes && (
            <span className="flex items-center gap-1.5 text-xs text-white/50">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading full resolution...
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isImage && (
            <button
              onClick={toggleZoom}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
              title={zoomed ? "Fit to screen" : "Zoom to 100%"}
              aria-label={zoomed ? "Fit to screen" : "Zoom to full size"}
            >
              {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
            </button>
          )}
          {proxyPath && (
            <button
              onClick={() => downloadFile(proxyPath, file?.name)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
              title={`Download ${file?.name}`}
              aria-label={`Download ${file?.name}`}
            >
              <Download className="h-4 w-4" />
            </button>
          )}
          {deliverableLink && (
            <button
              onClick={() => openInDropbox(deliverableLink)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
              title="Open in Dropbox"
              aria-label="Open in Dropbox"
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button
            onClick={onClose}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Close lightbox"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 px-16" onClick={e => e.stopPropagation()}>
        {safeIndex > 0 && (
          <button
            onClick={() => { setIndex(i => i - 1); setZoomed(false); }}
            className="absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10 focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {safeIndex < files.length - 1 && (
          <button
            onClick={() => { setIndex(i => i + 1); setZoomed(false); }}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10 focus:outline-none focus:ring-2 focus:ring-white/40"
            aria-label="Next image"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {/* Image with zoom toggle */}
        {isImage && imgBlobUrl && (
          <div
            className={cn(
              "pmg-lightbox-img-enter transition-all duration-300 ease-out relative",
              zoomed ? "cursor-zoom-out overflow-auto max-w-full max-h-full" : "cursor-zoom-in"
            )}
            onClick={toggleZoom}
            onDoubleClick={toggleZoom}
          >
            {loadingFullRes && thumbUrl && (
              <img
                src={thumbUrl}
                alt=""
                className="absolute inset-0 w-full h-full object-contain rounded-lg blur-sm opacity-60 pointer-events-none"
                aria-hidden="true"
                draggable={false}
              />
            )}
            <img
              src={imgBlobUrl}
              alt={file.name}
              className={cn(
                "rounded-lg transition-all duration-300 relative",
                zoomed ? "max-w-none w-auto h-auto" : "max-w-full max-h-[calc(100vh-160px)] object-contain"
              )}
              draggable={false}
            />
            {loadingFullRes && (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur-sm text-white/80 text-xs px-3 py-1.5 rounded-full pointer-events-none">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading full resolution...
              </div>
            )}
          </div>
        )}

        {isImage && !imgBlobUrl && (
          <div className="flex flex-col items-center gap-3 text-white/50 pmg-lightbox-img-enter">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-sm">Loading image...</span>
          </div>
        )}

        {isVideo && (
          videoLoading ? (
            <div className="flex flex-col items-center gap-3 text-white/60 pmg-lightbox-img-enter">
              <Loader2 className="h-10 w-10 animate-spin" />
              <span className="text-sm">Loading video...</span>
            </div>
          ) : videoUrl ? (
            <video src={videoUrl} controls autoPlay className="max-w-full max-h-[calc(100vh-160px)] rounded-lg pmg-lightbox-img-enter" />
          ) : (
            <div className="flex flex-col items-center gap-3 text-white/60 pmg-lightbox-img-enter">
              <Film className="h-16 w-16 text-white/20" />
              <p className="text-sm font-medium">{file?.name}</p>
              <p className="text-xs text-white/30">Video could not be loaded</p>
            </div>
          )
        )}

        {!isImage && !isVideo && (
          <div className="flex flex-col items-center gap-3 text-white/60 pmg-lightbox-img-enter">
            <FileIcon type={file?.type} className="h-16 w-16" />
            <span className="text-sm">{file?.name}</span>
            {deliverableLink && (
              <Button variant="outline" size="sm" onClick={() => openInDropbox(deliverableLink)} className="text-white border-white/30 hover:bg-white/10">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />Open in Dropbox
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Filmstrip */}
      <div className="flex gap-1.5 px-4 py-3 overflow-x-auto justify-center shrink-0" onClick={e => e.stopPropagation()} role="tablist" aria-label="Image filmstrip">
        {files.map((f, i) => {
          const path = buildProxyPath(tonomoBasePath, f);
          const thumbSrc = path ? (blobCache.get(cacheKey(path, 'thumb')) || blobCache.get(cacheKey(path, 'proxy'))) : null;
          return (
            <button
              key={f.path || i}
              onClick={() => { setIndex(i); setZoomed(false); }}
              onMouseEnter={() => {
                // Preload full-res on hover (before user clicks)
                if (path && f.type !== 'video' && !blobCache.has(cacheKey(path, 'proxy'))) {
                  fetchProxyImage(path, 'proxy');
                }
              }}
              role="tab"
              aria-selected={i === safeIndex}
              aria-label={`View ${f.name}`}
              className={cn(
                "w-14 h-10 rounded overflow-hidden shrink-0 border-2 transition-all focus:outline-none focus:ring-2 focus:ring-white/40",
                i === safeIndex ? "border-white ring-1 ring-white/50 scale-105" : "border-transparent opacity-50 hover:opacity-90"
              )}
            >
              {thumbSrc ? (
                <img src={thumbSrc} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-white/10 flex items-center justify-center">
                  <FileIcon type={f.type} className="h-3 w-3 text-white/40" />
                </div>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── MediaThumbnail ─────────────────────────────────────────────────
// PERF: memo prevents re-render when parent re-renders but props haven't changed

const MediaThumbnail = memo(function MediaThumbnail({ file, tonomoBasePath, deliverableLink, onClick, getTagsForFile, gridSize }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const mountedRef = useRef(true);
  const lastPathRef = useRef(null);

  const canThumb = file.type === 'image' || file.type === 'video' || file.type === 'document';
  const proxyPath = buildProxyPath(tonomoBasePath, file);

  // Clean up mounted flag on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!canThumb || !proxyPath) return;
    // Skip if we already started loading this exact path
    if (lastPathRef.current === proxyPath) return;
    const cached = blobCache.get(cacheKey(proxyPath, 'thumb'));
    if (cached) { setBlobUrl(cached); lastPathRef.current = proxyPath; return; }
    lastPathRef.current = proxyPath;
    setLoading(true);
    setError(false);
    setImgLoaded(false);
    _totalQueued++;
    notifyProgress();
    fetchProxyImage(proxyPath).then(url => {
      if (!mountedRef.current) return; // Don't set state on unmounted component
      if (url) setBlobUrl(url);
      else setError(true);
      setLoading(false);
    });
  }, [canThumb, proxyPath]);

  const handleClick = () => {
    if (onClick) onClick();
    else if (deliverableLink) openInDropbox(deliverableLink);
  };

  const uploadTime = timeAgo(file.uploaded_at);
  const formattedTime = formatUploadTime(file.uploaded_at);
  const tags = getTagsForFile ? getTagsForFile(proxyPath) : [];

  return (
    <button
      type="button"
      onClick={handleClick}
      className={cn(
        "group relative rounded-lg border bg-card overflow-hidden text-left w-full",
        "transition-all duration-200 ease-out",
        "hover:shadow-lg hover:-translate-y-0.5",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
      )}
      style={{ willChange: "transform" }}
      aria-label={`${file.name}, ${formatSize(file.size) || file.type}${uploadTime ? `, uploaded ${uploadTime}` : ""}`}
      tabIndex={0}
    >
      {/* Thumbnail area -- aspect ratio adjusts by grid size */}
      <div className={cn(
        "bg-muted flex items-center justify-center overflow-hidden relative",
        gridSize === 'lg' ? "aspect-[16/10]" : gridSize === 'sm' ? "aspect-square" : "aspect-[4/3]"
      )}>
        {blobUrl ? (
          <img
            src={blobUrl}
            alt={file.name}
            className={cn(
              "w-full h-full object-cover group-hover:scale-105 transition-transform duration-300 ease-out pmg-fade-in",
              imgLoaded && "pmg-loaded"
            )}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            draggable={false}
          />
        ) : loading ? (
          <div className="w-full h-full pmg-shimmer flex items-center justify-center">
            <Camera className="h-6 w-6 text-muted-foreground/20" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <FileIcon type={file.type} className="h-8 w-8 opacity-40" />
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">{file.ext || file.type}</span>
          </div>
        )}

        {/* Video play indicator */}
        {file.type === 'video' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/40 backdrop-blur-[2px] rounded-full p-2.5 group-hover:bg-black/60 transition-colors">
              <Play className="h-5 w-5 text-white fill-white" />
            </div>
          </div>
        )}

        {/* Hover overlay: gradient with file name, size, time, action buttons */}
        <div className={cn(
          "absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent",
          "opacity-0 group-hover:opacity-100 transition-opacity duration-200",
          "flex flex-col justify-end p-2.5 pointer-events-none"
        )}>
          <div className="pointer-events-auto">
            <p className="text-[11px] font-medium text-white truncate leading-tight">{file.name}</p>
            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-white/70">
              {file.size > 0 && <span>{formatSize(file.size)}</span>}
              {file.size > 0 && formattedTime && <span className="text-white/30">|</span>}
              {formattedTime && <span>{formattedTime}</span>}
            </div>
          </div>
          {/* Action buttons inside overlay */}
          <div className="flex items-center gap-1 mt-1.5 pointer-events-auto">
            <FavoriteButton
              filePath={proxyPath}
              fileName={file.name}
              fileType={file.type}
              projectId={project?.id}
              projectTitle={project?.title || project?.property_address}
              propertyAddress={project?.property_address || project?.title}
              tonomoBasePath={tonomoBasePath}
              size="sm"
              className="bg-white/15 hover:bg-white/30 rounded-full p-1 text-white backdrop-blur-sm"
            />
            {deliverableLink && (
              <button
                onClick={(e) => { e.stopPropagation(); openInDropbox(deliverableLink); }}
                className="bg-white/15 hover:bg-white/30 rounded-full p-1 text-white backdrop-blur-sm transition-colors"
                title="Open in Dropbox"
                aria-label={`Open ${file.name} in Dropbox`}
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
            {proxyPath && (
              <button
                onClick={(e) => { e.stopPropagation(); downloadFile(proxyPath, file.name); }}
                className="bg-white/15 hover:bg-white/30 rounded-full p-1 text-white backdrop-blur-sm transition-colors"
                title={`Download ${file.name}`}
                aria-label={`Download ${file.name}`}
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Tag pills overlaid at bottom-left (hidden during hover) */}
        {tags.length > 0 && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 pointer-events-none z-[1] group-hover:opacity-0 transition-opacity duration-200">
            {tags.slice(0, 2).map(tag => (
              <span
                key={tag.name}
                className="text-[9px] font-medium px-1.5 py-0.5 rounded-full text-white backdrop-blur-sm shadow-sm"
                style={{ backgroundColor: `${tag.color}cc` }}
              >
                #{tag.name}
              </span>
            ))}
            {tags.length > 2 && (
              <span className="text-[9px] font-medium px-1 py-0.5 rounded-full text-white/90 bg-black/40 backdrop-blur-sm">
                +{tags.length - 2}
              </span>
            )}
          </div>
        )}

        {/* File type badge for non-images */}
        {file.type !== "image" && (
          <div className="absolute top-1.5 left-1.5 z-[1]">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
              {file.type === "video" ? "Video" : file.ext?.toUpperCase() || file.type}
            </Badge>
          </div>
        )}
      </div>

      {/* Minimal footer: just file name (metadata moved to hover overlay) */}
      <div className="p-2">
        <p className="text-xs font-medium truncate leading-tight text-foreground/80" title={file.name}>
          {file.name}
        </p>
      </div>
    </button>
  );
});

// ─── FolderSection with smooth collapse animation ───────────────────

const GRID_SIZES = {
  sm: 'grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-1.5',
  md: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3',
  lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4',
};

function FolderSection({ folder, tonomoBasePath, deliverableLink, gridSize = 'md', onOpenLightbox, getTagsForFile }) {
  const [collapsed, setCollapsed] = useState(false);
  const contentRef = useRef(null);
  const [contentHeight, setContentHeight] = useState("auto");

  const { imageCount, videoCount, docCount } = useMemo(() => {
    let img = 0, vid = 0, doc = 0;
    for (const f of folder.files) {
      if (f.type === 'image') img++;
      else if (f.type === 'video') vid++;
      else if (f.type === 'document') doc++;
    }
    return { imageCount: img, videoCount: vid, docCount: doc };
  }, [folder.files]);

  // Measure + animate height for smooth collapse/expand
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    let rafId1, rafId2;
    if (!collapsed) {
      setContentHeight(`${el.scrollHeight}px`);
      const t = setTimeout(() => setContentHeight("auto"), 320);
      return () => clearTimeout(t);
    } else {
      setContentHeight(`${el.scrollHeight}px`);
      rafId1 = requestAnimationFrame(() => {
        rafId2 = requestAnimationFrame(() => setContentHeight("0px"));
      });
      return () => { cancelAnimationFrame(rafId1); cancelAnimationFrame(rafId2); };
    }
  }, [collapsed]);

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setCollapsed(c => !c)}
        className={cn(
          "flex items-center gap-2 group cursor-pointer w-full text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-md px-1 -mx-1"
        )}
        aria-expanded={!collapsed}
        aria-controls={`folder-${folder.name}`}
      >
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
            collapsed && "-rotate-90"
          )}
        />
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{folder.name}</h3>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">{folder.files.length}</Badge>
        <div className="flex gap-1.5 ml-1">
          {imageCount > 0 && (
            <Badge className="text-[10px] bg-blue-50 text-blue-600 border-blue-200 h-4 px-1.5 py-0 dark:bg-blue-950 dark:text-blue-300 dark:border-blue-800">
              {imageCount} photos
            </Badge>
          )}
          {videoCount > 0 && (
            <Badge className="text-[10px] bg-purple-50 text-purple-600 border-purple-200 h-4 px-1.5 py-0 dark:bg-purple-950 dark:text-purple-300 dark:border-purple-800">
              {videoCount} video
            </Badge>
          )}
          {docCount > 0 && (
            <Badge className="text-[10px] bg-amber-50 text-amber-600 border-amber-200 h-4 px-1.5 py-0 dark:bg-amber-950 dark:text-amber-300 dark:border-amber-800">
              {docCount} docs
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors ml-auto shrink-0">
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>

      <div
        ref={contentRef}
        id={`folder-${folder.name}`}
        className="overflow-hidden transition-[height] duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]"
        style={{ height: contentHeight, willChange: collapsed ? 'height' : 'auto' }}
        aria-hidden={collapsed}
      >
        <div className={cn("grid", GRID_SIZES[gridSize])} role="list" aria-label={`${folder.name} files`}>
          {folder.files.map((file) => (
            <div key={file.path || file.name} role="listitem">
              <MediaThumbnail
                file={file}
                tonomoBasePath={tonomoBasePath}
                deliverableLink={deliverableLink}
                gridSize={gridSize}
                getTagsForFile={getTagsForFile}
                onClick={() => onOpenLightbox(folder.files, folder.files.indexOf(file))}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton: matches final layout during initial load ─────────────

function MediaSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading media gallery">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-32 rounded pmg-shimmer" />
          <div className="h-4 w-24 rounded pmg-shimmer" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-7 w-20 rounded pmg-shimmer" />
          <div className="h-7 w-7 rounded pmg-shimmer" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <div className="h-4 w-4 rounded pmg-shimmer" />
        <div className="h-4 w-36 rounded pmg-shimmer" />
        <div className="h-4 w-12 rounded pmg-shimmer" />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => <SkeletonCard key={i} />)}
      </div>
    </div>
  );
}

// ─── Empty state: folder empty ──────────────────────────────────────

function EmptyFolderState() {
  return (
    <Card className="border-dashed border-2 relative overflow-hidden">
      <div className="absolute inset-0 pmg-dot-grid text-muted-foreground pointer-events-none" aria-hidden="true" />
      <CardContent className="relative flex flex-col items-center justify-center py-20 text-center">
        <div className="relative mb-6">
          <div className="rounded-full bg-muted/60 p-6 pmg-float">
            <Inbox className="h-10 w-10 text-muted-foreground/60" />
          </div>
          <div className="absolute inset-0 rounded-full bg-muted/30 pmg-pulse-ring" />
        </div>
        <h3 className="text-base font-semibold mb-2 text-foreground/80">No files yet</h3>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
          Uploaded media will appear here automatically. Check back once the team starts adding deliverables.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Empty state: not linked ────────────────────────────────────────

function NotLinkedState() {
  return (
    <Card className="border-dashed border-2 relative overflow-hidden">
      <div className="absolute inset-0 pmg-dot-grid text-muted-foreground pointer-events-none" aria-hidden="true" />
      <CardContent className="relative flex flex-col items-center justify-center py-20 text-center">
        <div className="relative mb-6">
          <div className="rounded-full bg-muted/60 p-6 pmg-float">
            <ImageOff className="h-10 w-10 text-muted-foreground/60" />
          </div>
          <div className="absolute inset-0 rounded-full bg-muted/30 pmg-pulse-ring" />
        </div>
        <h3 className="text-base font-semibold mb-2 text-foreground/80">Dropbox folder not linked</h3>
        <p className="text-sm text-muted-foreground max-w-xs leading-relaxed">
          Connect a Dropbox delivery folder to this project to see photos, videos, and documents here.
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export default function ProjectMediaGallery({ project }) {
  const deliverableLink = project?.tonomo_deliverable_link;
  const tonomoBasePath = project?.tonomo_deliverable_path;
  const [gridSize, setGridSize] = useState('md');
  const [lightbox, setLightbox] = useState(null);

  const { favorites, allTags: tagRegistry } = useFavorites();

  // PERF: Pre-index favorites by file_path and tags by name for O(1) lookups
  // instead of O(n) array.find() on every card render
  const favByPath = useMemo(() => {
    const m = new Map();
    for (const f of favorites) {
      if (f.file_path) m.set(f.file_path, f);
    }
    return m;
  }, [favorites]);

  const tagColorMap = useMemo(() => {
    const m = new Map();
    for (const t of tagRegistry) {
      m.set(t.name, t.color || '#3b82f6');
    }
    return m;
  }, [tagRegistry]);

  const getTagsForFile = useCallback((filePath) => {
    if (!filePath) return [];
    const fav = favByPath.get(filePath);
    if (!fav?.tags?.length) return [];
    return fav.tags.map(tagName => ({
      name: tagName,
      color: tagColorMap.get(tagName) || '#3b82f6',
    }));
  }, [favByPath, tagColorMap]);

  const { data: mediaData, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["projectMedia", deliverableLink, tonomoBasePath],
    queryFn: async () => {
      resetProgress();
      const res = await api.functions.invoke("getDeliveryMediaFeed", { share_url: deliverableLink, base_path: tonomoBasePath });
      const data = res?.data || res;
      if (data?.error) {
        const errMsg = typeof data.error === 'object'
          ? (data.error.message || data.error.code || JSON.stringify(data.error))
          : String(data.error);
        throw new Error(errMsg);
      }
      let folders = [];
      if (data?.folders && Array.isArray(data.folders)) folders = data.folders;
      else if (data?.files && Array.isArray(data.files)) folders = [{ name: "All Files", files: data.files }];
      return { folders, fetched_at: data?.fetched_at || new Date().toISOString() };
    },
    enabled: !!deliverableLink,
    staleTime: 0,             // Always treat as stale — edge function returns from server cache (~100ms)
    gcTime: 10 * 60 * 1000,  // PERF: keep cached data 10 min after unmount to avoid refetch on re-mount
    refetchOnWindowFocus: false,
    retry: 1,
    placeholderData: (prev) => prev, // Show previous data while refetching (stale-while-revalidate)
  });

  const handleRefresh = useCallback(() => {
    // PERF: use LRU cache's prefix eviction instead of manual iteration
    if (tonomoBasePath) {
      blobCache.evictByPrefix(`thumb::${tonomoBasePath}`);
      blobCache.evictByPrefix(`proxy::${tonomoBasePath}`);
    }
    resetProgress();
    refetch();
  }, [refetch, tonomoBasePath]);

  // Stable references to avoid re-registering listeners and defeating memo on every render
  const closeLightbox = useCallback(() => setLightbox(null), []);
  const openLightbox = useCallback((files, idx) => setLightbox({ files, index: idx }), []);

  if (!deliverableLink) return <NotLinkedState />;
  if (isLoading) return <MediaSkeleton />;

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-destructive/10 p-4 mb-4">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
          <h3 className="text-base font-semibold mb-1">Failed to load media</h3>
          <p className="text-sm text-muted-foreground mb-5 max-w-sm">{error?.message || "Could not fetch files from Dropbox."}</p>
          <Button variant="outline" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  const folders = mediaData?.folders || [];
  const totalFiles = folders.reduce((sum, f) => sum + (f.files?.length || 0), 0);
  const fetchedAt = mediaData?.fetched_at;

  if (totalFiles === 0) return <EmptyFolderState />;

  return (
    <div className="space-y-6" role="region" aria-label="Project media gallery">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</h3>
          <span className="text-xs text-muted-foreground">across {folders.length} folder{folders.length !== 1 ? "s" : ""}</span>
          <LoadingProgress />
        </div>
        <div className="flex items-center gap-2">
          {fetchedAt && (
            <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Fetched {timeAgo(fetchedAt)}
            </span>
          )}
          <div className="flex items-center border rounded-md overflow-hidden" role="radiogroup" aria-label="Grid size">
            {[
              { key: 'sm', icon: Grid3x3, title: 'Small grid' },
              { key: 'md', icon: Grid2x2, title: 'Medium grid' },
              { key: 'lg', icon: LayoutGrid, title: 'Large grid' },
            ].map(({ key, icon: Icon, title }) => (
              <button
                key={key}
                onClick={() => setGridSize(key)}
                title={title}
                role="radio"
                aria-checked={gridSize === key}
                aria-label={title}
                className={cn(
                  "p-1.5 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
                  gridSize === key ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground"
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => openInDropbox(deliverableLink)} className="text-xs h-7 px-2" aria-label="Open project folder in Dropbox">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />Open in Dropbox
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} className="text-xs h-7 px-2" aria-label="Refresh media files">
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isFetching && "animate-spin")} />Refresh
          </Button>
        </div>
      </div>

      {/* Folders */}
      {folders.map((folder) => (
        <FolderSection
          key={folder.name}
          folder={folder}
          tonomoBasePath={tonomoBasePath}
          deliverableLink={deliverableLink}
          gridSize={gridSize}
          getTagsForFile={getTagsForFile}
          onOpenLightbox={openLightbox}
        />
      ))}

      {/* Lightbox */}
      {lightbox && createPortal(
        <MediaLightbox
          files={lightbox.files}
          initialIndex={lightbox.index}
          tonomoBasePath={tonomoBasePath}
          deliverableLink={deliverableLink}
          onClose={closeLightbox}
        />,
        document.body
      )}
    </div>
  );
}

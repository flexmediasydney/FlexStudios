import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useFavorites } from "@/components/favorites/useFavorites";
import { useQuery } from "@tanstack/react-query";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { downloadFile, preloadAdjacentImages, fetchFullRes, getVideoStreamUrl } from "@/utils/mediaActions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RefreshCw, Camera, Film, FileText, File, ExternalLink, Download,
  ImageOff, Play, Clock, Search, Building2, User, Loader2,
  AlertCircle, FolderOpen, Grid2x2, Grid3x3, LayoutGrid,
  X, ChevronLeft, ChevronRight, Star, ZoomIn, ZoomOut,
  Filter, Hash, TrendingUp, Bell, ArrowUp
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { Link } from "react-router-dom";
import { createPageUrl } from "@/utils";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, differenceInDays, format } from "date-fns";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import TagManager from "@/components/favorites/TagManager";
import { SHARED_THUMB_CACHE, enqueueFetch, fetchMediaProxy } from "@/utils/mediaPerf";

const blobCache = SHARED_THUMB_CACHE;

// ---- Image proxy: delegates to shared fetchMediaProxy with proper dedup ----
function fetchProxyImage(filePath, mode = 'thumb') {
  return enqueueFetch(() => fetchMediaProxy(SHARED_THUMB_CACHE, filePath, mode));
}

// ---- Constants ----
const PROJECT_LIMITS = [
  { value: '10',  label: 'Last 10 projects' },
  { value: '25',  label: 'Last 25 projects' },
  { value: '50',  label: 'Last 50 projects' },
  { value: '100', label: 'Last 100 projects' },
];

const TYPE_FILTERS = [
  { value: 'all',      label: 'All types',  icon: FolderOpen },
  { value: 'image',    label: 'Photos',     icon: Camera },
  { value: 'video',    label: 'Videos',     icon: Film },
  { value: 'document', label: 'Documents',  icon: FileText },
];

const GRID_CONFIGS = {
  sm: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2',
  md: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3',
  lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4',
};

const PAGE_SIZE = 60;

// ---- Helpers ----
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
  try { return format(new Date(dateStr), 'MMM d, h:mm a'); } catch { return null; }
}

const TYPE_BADGE_STYLES = {
  image:    'bg-blue-50 text-blue-600 border-blue-200',
  video:    'bg-purple-50 text-purple-600 border-purple-200',
  document: 'bg-amber-50 text-amber-600 border-amber-200',
  other:    'bg-slate-50 text-slate-600 border-slate-200',
};


// =====================================================================
// AnimatedCounter: ease-out cubic count-up for stat numbers
// =====================================================================
function AnimatedCounter({ value, duration = 800 }) {
  const [display, setDisplay] = useState(0);
  const prevValue = useRef(0);

  useEffect(() => {
    if (value === prevValue.current) return;
    const start = prevValue.current;
    const end = value;
    const diff = end - start;
    const startTime = performance.now();

    function tick(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(Math.round(start + diff * eased));
      if (progress < 1) requestAnimationFrame(tick);
      else prevValue.current = end;
    }
    requestAnimationFrame(tick);
  }, [value, duration]);

  return <span>{display.toLocaleString()}</span>;
}


// =====================================================================
// StatCard: single animated stat card with icon
// =====================================================================
function StatCard({ icon: Icon, label, value, color, delay = 0 }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [delay]);

  const colorMap = {
    blue:    'from-blue-500/10 to-blue-600/5 border-blue-200/60',
    purple:  'from-purple-500/10 to-purple-600/5 border-purple-200/60',
    amber:   'from-amber-500/10 to-amber-600/5 border-amber-200/60',
    emerald: 'from-emerald-500/10 to-emerald-600/5 border-emerald-200/60',
    slate:   'from-slate-500/10 to-slate-600/5 border-slate-200/60',
  };

  const iconBgMap = {
    blue:    'bg-blue-100 text-blue-600',
    purple:  'bg-purple-100 text-purple-600',
    amber:   'bg-amber-100 text-amber-600',
    emerald: 'bg-emerald-100 text-emerald-600',
    slate:   'bg-slate-100 text-slate-600',
  };

  return (
    <div
      className={cn(
        "relative rounded-xl border bg-gradient-to-br p-3.5 transition-all duration-500 shadow-sm hover:shadow-md",
        colorMap[color] || colorMap.slate,
        visible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-2"
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn("rounded-lg p-2 shrink-0", iconBgMap[color] || iconBgMap.slate)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold tracking-tight leading-none">
            <AnimatedCounter value={value} />
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5 font-medium">{label}</div>
        </div>
      </div>
    </div>
  );
}


// =====================================================================
// StatsHeader: row of animated stat cards
// =====================================================================
function StatsHeader({ stats, newestUpload, isLoading }) {
  if (isLoading || stats.total === 0) return null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      <StatCard icon={Hash}      label="Total Files"      value={stats.total}    color="slate"   delay={0} />
      <StatCard icon={Building2} label="Projects Scanned" value={stats.projects} color="emerald" delay={80} />
      <StatCard icon={Camera}    label="Photos"           value={stats.photos}   color="blue"    delay={160} />
      <StatCard icon={Film}      label="Videos"           value={stats.videos}   color="purple"  delay={240} />
      {stats.docs > 0 ? (
        <StatCard icon={FileText} label="Documents" value={stats.docs} color="amber" delay={320} />
      ) : newestUpload ? (
        <div
          className="relative rounded-xl border bg-gradient-to-br from-emerald-500/10 to-emerald-600/5 border-emerald-200/60 p-3.5 shadow-sm"
          style={{ animation: 'fadeSlideIn 0.5s ease-out 320ms both' }}
        >
          <div className="absolute top-2 right-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
            </span>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-lg p-2 bg-emerald-100 text-emerald-600 shrink-0">
              <Clock className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold leading-tight truncate">{formatUploadTime(newestUpload)}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5 font-medium">Newest Upload</div>
            </div>
          </div>
        </div>
      ) : (
        <StatCard icon={FileText} label="Documents" value={stats.docs} color="amber" delay={320} />
      )}
    </div>
  );
}


// =====================================================================
// FeedCardSkeleton: realistic placeholder matching actual card layout
// =====================================================================
function FeedCardSkeleton({ index = 0 }) {
  return (
    <div
      className="rounded-xl overflow-hidden border bg-card"
      style={{ animation: `fadeSlideIn 0.4s ease-out ${index * 50}ms both` }}
    >
      <div className="aspect-[4/3] bg-muted relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
        <div className="absolute inset-0 flex items-center justify-center">
          <Camera className="h-8 w-8 text-muted-foreground/10" />
        </div>
        <div className="absolute top-2.5 left-2.5">
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
      </div>
      <div className="p-2.5 space-y-2">
        <Skeleton className="h-3.5 w-[75%] rounded" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-2.5 w-12 rounded" />
          <Skeleton className="h-2.5 w-8 rounded" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-2.5 w-2.5 rounded-full shrink-0" />
          <Skeleton className="h-2.5 w-[60%] rounded" />
        </div>
        <div className="flex items-center gap-1.5">
          <Skeleton className="h-2.5 w-2.5 rounded-full shrink-0" />
          <Skeleton className="h-2.5 w-[40%] rounded" />
        </div>
      </div>
    </div>
  );
}

function FeedSkeleton({ count = 12, gridSize = 'md', scanProgress = null }) {
  return (
    <div className="space-y-4">
      {scanProgress !== null && (
        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-lg">
          <Loader2 className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-blue-900 dark:text-blue-200">
              Scanning project {scanProgress.current} of {scanProgress.total}...
            </p>
            <div className="mt-1.5 h-1.5 bg-blue-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-500 ease-out"
                style={{ width: `${Math.max(5, (scanProgress.current / Math.max(1, scanProgress.total)) * 100)}%` }}
              />
            </div>
          </div>
          <span className="text-xs text-blue-600 dark:text-blue-400 font-mono font-medium shrink-0 tabular-nums">
            {Math.round((scanProgress.current / Math.max(1, scanProgress.total)) * 100)}%
          </span>
        </div>
      )}
      <div className={cn("grid", GRID_CONFIGS[gridSize])}>
        {Array.from({ length: count }).map((_, i) => (
          <FeedCardSkeleton key={i} index={i} />
        ))}
      </div>
    </div>
  );
}


// =====================================================================
// MediaLightbox: fullscreen viewer with zoom, animations, filmstrip
// =====================================================================
function MediaLightbox({ files, initialIndex, onClose, getFavorite, ensureFavoriteAndTag }) {
  const [index, setIndex] = useState(initialIndex);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const [entering, setEntering] = useState(true);
  const [exiting, setExiting] = useState(false);
  const filmstripRef = useRef(null);
  const file = files[index];

  const isVideo = file?.type === 'video';
  const isImage = file?.type === 'image';
  const proxyPath = file?.proxyPath || null;

  useEffect(() => {
    requestAnimationFrame(() => setEntering(false));
  }, []);

  // Lock body scroll while lightbox is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const handleClose = useCallback(() => {
    setExiting(true);
    setTimeout(() => onClose(), 280);
  }, [onClose]);

  // Videos: instant streaming URL (browser handles buffering)
  useEffect(() => {
    if (!isVideo || !proxyPath) { setVideoUrl(null); setVideoLoading(false); return; }
    setVideoUrl(getVideoStreamUrl(proxyPath));
    setVideoLoading(false);
  }, [isVideo, proxyPath]);

  useEffect(() => { setZoomed(false); }, [index]);

  // Predictive preloading: preload next 2 + previous 1 full-res images
  useEffect(() => {
    if (files.length === 0) return;
    preloadAdjacentImages(
      files, index,
      (f) => f.proxyPath || null,
      fetchProxyImage,
      blobCache,
      (path, mode) => `${mode}::${path}`,
    );
  }, [index, files.length]);

  useEffect(() => {
    if (!filmstripRef.current) return;
    const active = filmstripRef.current.querySelector('[data-active="true"]');
    if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }, [index]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') handleClose();
      if (e.key === 'ArrowLeft' && index > 0) setIndex(i => i - 1);
      if (e.key === 'ArrowRight' && index < files.length - 1) setIndex(i => i + 1);
      if (e.key === ' ' || e.key === 'z') { e.preventDefault(); setZoomed(z => !z); }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, files.length, handleClose]);

  // Full-res image loading for lightbox
  const [fullResUrl, setFullResUrl] = useState(null);
  useEffect(() => {
    if (!isImage || !proxyPath) { setFullResUrl(null); return; }
    setFullResUrl(null);
    const cached = blobCache.get(`proxy::${proxyPath}`);
    if (cached) { setFullResUrl(cached); return; }
    fetchProxyImage(proxyPath, 'proxy').then(url => { if (url) setFullResUrl(url); });
  }, [isImage, proxyPath]);

  const thumbUrl = isImage && proxyPath ? (blobCache.get(`thumb::${proxyPath}`) || blobCache.get(proxyPath)) : null;
  const imgBlobUrl = fullResUrl || thumbUrl;

  return (
    <div
      className={cn(
        "fixed inset-0 z-50 flex flex-col transition-all duration-200",
        entering || exiting ? "bg-black/0 backdrop-blur-none" : "bg-black/90 backdrop-blur-sm"
      )}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Viewing ${file?.name || 'media'}, ${index + 1} of ${files.length}`}
    >
      <div
        className={cn(
          "flex items-center justify-between p-3 text-white transition-all duration-300",
          entering || exiting ? "opacity-0 -translate-y-4" : "opacity-100 translate-y-0"
        )}
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium truncate max-w-md">{file?.name}</span>
          {file?.size > 0 && <span className="text-xs text-white/50 shrink-0">{formatSize(file.size)}</span>}
          <span className="text-xs text-white/50 shrink-0">{index + 1} / {files.length}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {file?.projectName && (
            <span className="text-xs text-white/40 truncate max-w-[200px]">{file.projectName}</span>
          )}
          {isImage && imgBlobUrl && (
            <button
              onClick={() => setZoomed(z => !z)}
              className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              title={zoomed ? "Zoom out (Z)" : "Zoom in (Z)"}
              aria-label={zoomed ? "Zoom out" : "Zoom in"}
            >
              {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
            </button>
          )}
          {/* Favorite + tag — previously missing from this lightbox; only the
              thumbnail card had the wiring. File objects in LiveMediaFeed
              carry their own project metadata (projectId, projectName, etc). */}
          {proxyPath && file && (
            <>
              <FavoriteButton
                filePath={proxyPath}
                fileName={file.name}
                fileType={file.type}
                projectId={file.projectId}
                projectTitle={file.projectName}
                propertyAddress={file.projectName}
                tonomoBasePath={file.tonomoBasePath}
                size="md"
                className="p-2 hover:bg-white/10 rounded-lg text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              />
              {ensureFavoriteAndTag && (
                <div className="[&_button]:p-2 [&_button]:text-white [&_button]:hover:bg-white/10 [&_button]:rounded-lg [&_button]:transition-colors">
                  <TagManager
                    favoriteId={getFavorite?.(proxyPath)?.id}
                    currentTags={getFavorite?.(proxyPath)?.tags || []}
                    onTagsChanged={() => {}}
                    onEnsureAndTag={(newTags) => ensureFavoriteAndTag({
                      filePath: proxyPath,
                      fileName: file.name,
                      fileType: file.type,
                      projectId: file.projectId,
                      projectTitle: file.projectName,
                      propertyAddress: file.projectName,
                      tonomoBasePath: file.tonomoBasePath,
                    }, newTags)}
                    allowCreation={false}
                  />
                </div>
              )}
            </>
          )}
          {proxyPath && (
            <button onClick={() => downloadFile(proxyPath, file?.name)} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" title={`Download ${file?.name}`} aria-label={`Download ${file?.name}`}>
              <Download className="h-4 w-4" />
            </button>
          )}
          {file?.projectLink && (
            <button onClick={() => safeWindowOpen(file.projectLink)} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" title="Open in Dropbox" aria-label="Open in Dropbox">
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button onClick={handleClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" aria-label="Close lightbox">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      <div
        className={cn(
          "flex-1 flex items-center justify-center relative min-h-0 px-16 transition-all duration-300",
          entering || exiting ? "opacity-0 scale-95" : "opacity-100 scale-100"
        )}
        onClick={e => e.stopPropagation()}
      >
        {index > 0 && (
          <button
            onClick={() => setIndex(i => i - 1)}
            className="absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-all z-10 hover:scale-110 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            aria-label="Previous image"
          >
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < files.length - 1 && (
          <button
            onClick={() => setIndex(i => i + 1)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-all z-10 hover:scale-110 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            aria-label="Next image"
          >
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {isImage && imgBlobUrl && (
          <div className="relative">
            <img
              src={imgBlobUrl}
              alt={file.name}
              onClick={() => setZoomed(z => !z)}
              className={cn(
                "max-h-full rounded-lg transition-all duration-300 select-none",
                zoomed ? "max-w-none scale-150 cursor-zoom-out" : "max-w-full object-contain cursor-zoom-in",
                !fullResUrl && thumbUrl && "blur-[1px] opacity-80"
              )}
              draggable={false}
            />
            {!fullResUrl && thumbUrl && (
              <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur-sm text-white/80 text-xs px-3 py-1.5 rounded-full pointer-events-none">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading full resolution...
              </div>
            )}
          </div>
        )}
        {isImage && !imgBlobUrl && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-sm">Loading image...</span>
          </div>
        )}

        {isVideo && (
          videoLoading ? (
            <div className="flex flex-col items-center gap-3 text-white/60">
              <Loader2 className="h-10 w-10 animate-spin" />
              <span className="text-sm">Loading video...</span>
            </div>
          ) : videoUrl ? (
            <video
              src={videoUrl}
              controls
              autoPlay
              className="max-w-full max-h-full rounded-lg"
              style={{ maxHeight: 'calc(100vh - 140px)' }}
            />
          ) : (
            <div className="flex flex-col items-center gap-3 text-white/60">
              <Film className="h-16 w-16 text-white/20" />
              <p className="text-sm font-medium">{file?.name}</p>
              <p className="text-xs text-white/30">Video could not be loaded</p>
            </div>
          )
        )}

        {!isImage && !isVideo && (
          <div className="flex flex-col items-center gap-4 text-white/60">
            <div className="rounded-2xl bg-white/5 p-8 border border-white/10">
              <FileIcon type={file?.type} className="h-16 w-16" />
            </div>
            <span className="text-sm font-medium">{file?.name}</span>
            {file?.projectLink && (
              <button
                onClick={() => safeWindowOpen(file.projectLink)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-white/20 text-white/70 hover:text-white hover:bg-white/10 transition-colors text-sm"
              >
                <ExternalLink className="h-3.5 w-3.5" />Open in Dropbox
              </button>
            )}
          </div>
        )}
      </div>

      <div
        ref={filmstripRef}
        className={cn(
          "flex gap-1.5 p-3 overflow-x-auto justify-center transition-all duration-300",
          entering || exiting ? "opacity-0 translate-y-4" : "opacity-100 translate-y-0"
        )}
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
        onClick={e => e.stopPropagation()}
      >
        {files.slice(0, 60).map((f, i) => {
          const thumbUrl = f.proxyPath ? (blobCache.get(`thumb::${f.proxyPath}`) || blobCache.get(`proxy::${f.proxyPath}`)) : null;
          const isActive = i === index;
          return (
            <button
              key={f.proxyPath || f.path || i}
              data-active={isActive ? "true" : undefined}
              onClick={() => setIndex(i)}
              onMouseEnter={() => {
                if (f.proxyPath && f.type !== 'video' && !blobCache.has(`proxy::${f.proxyPath}`)) {
                  fetchProxyImage(f.proxyPath, 'proxy');
                }
              }}
              className={cn(
                "w-14 h-10 rounded-md overflow-hidden shrink-0 border-2 transition-all duration-200",
                isActive
                  ? "border-white ring-2 ring-white/30 scale-110"
                  : "border-transparent opacity-50 hover:opacity-90 hover:border-white/30"
              )}
            >
              {thumbUrl ? (
                <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
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


// =====================================================================
// FeedCard: media card with hover lift, fade-in, overlays, tag pills
// =====================================================================
const FeedCard = memo(function FeedCard({ item, isVisible, onClick, getTagsForFile, getFavorite, ensureFavoriteAndTag }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const started = useRef(false);

  const canThumb = item.type === 'image' || item.type === 'video' || item.type === 'document';

  useEffect(() => {
    if (!canThumb || !item.proxyPath || started.current) return;
    const cached = blobCache.get(`thumb::${item.proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    if (!isVisible) return;
    started.current = true;
    setLoading(true);
    fetchProxyImage(item.proxyPath).then(url => {
      if (url) setBlobUrl(url);
      else setError(true);
      setLoading(false);
    });
  }, [canThumb, item.proxyPath, isVisible]);

  const handleClick = () => {
    if (onClick) onClick();
  };

  const uploadTime = timeAgo(item.uploaded_at);
  const badgeStyle = TYPE_BADGE_STYLES[item.type] || TYPE_BADGE_STYLES.other;
  const tags = getTagsForFile ? getTagsForFile(item.proxyPath) : [];

  return (
    <div
      className="group relative rounded-xl overflow-hidden border bg-card text-left w-full transition-all duration-200 hover:shadow-xl hover:shadow-black/5 hover:-translate-y-1"
      style={{ contentVisibility: 'auto', containIntrinsicSize: '0 280px' }}
    >
      <button
        type="button"
        onClick={handleClick}
        className="w-full text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-xl"
      >
        <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden relative">
          {blobUrl ? (
            <img
              src={blobUrl}
              alt={item.name}
              onLoad={() => setImgLoaded(true)}
              className={cn(
                "w-full h-full object-cover group-hover:scale-105 transition-all duration-500",
                imgLoaded ? "opacity-100" : "opacity-0"
              )}
              loading="lazy"
            />
          ) : loading ? (
            <div className="w-full h-full bg-muted flex items-center justify-center relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-r from-transparent via-foreground/[0.03] to-transparent -translate-x-full animate-[shimmer_2s_infinite]" />
              <Camera className="h-6 w-6 text-muted-foreground/15" />
            </div>
          ) : (
            <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
              <FileIcon type={item.type} className="h-8 w-8 opacity-40" />
              <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">{item.ext || item.type}</span>
            </div>
          )}

          {item.type === 'video' && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="bg-black/50 rounded-full p-3 backdrop-blur-sm group-hover:scale-110 transition-all duration-300 shadow-lg shadow-black/30 group-hover:shadow-xl group-hover:shadow-black/40">
                <Play className="h-6 w-6 text-white fill-white drop-shadow-sm" />
              </div>
            </div>
          )}

          {item.type === 'document' && (
            <div className="absolute top-0 right-0 pointer-events-none">
              <div className="w-0 h-0 border-t-[28px] border-t-amber-500 border-l-[28px] border-l-transparent drop-shadow-sm" />
              <FileText className="absolute top-0.5 right-0.5 h-3 w-3 text-white drop-shadow-sm" />
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-3 pt-10 opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-1 group-hover:translate-y-0">
            <Link
              to={createPageUrl("ProjectDetails") + `?id=${item.projectId}&tab=media`}
              onClick={e => e.stopPropagation()}
              className="text-white text-xs font-semibold truncate leading-tight block hover:underline"
            >
              {item.projectName}
            </Link>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              {item.agentName && (
                <Link
                  to={item.agentId ? createPageUrl("PersonDetails") + `?id=${item.agentId}` : createPageUrl("People") + `?search=${encodeURIComponent(item.agentName)}`}
                  onClick={e => e.stopPropagation()}
                  className="text-white/70 text-[10px] truncate hover:text-white hover:underline flex items-center gap-0.5"
                >
                  <User className="h-2.5 w-2.5 shrink-0" />{item.agentName}
                </Link>
              )}
              {item.agencyName && (
                <Link
                  to={item.agencyId ? createPageUrl("OrgDetails") + `?id=${item.agencyId}` : '#'}
                  onClick={e => e.stopPropagation()}
                  className="text-white/60 text-[10px] truncate hover:text-white hover:underline flex items-center gap-0.5"
                >
                  <Building2 className="h-2.5 w-2.5 shrink-0" />{item.agencyName}
                </Link>
              )}
            </div>
            {uploadTime && <p className="text-white/50 text-[10px] mt-0.5">{uploadTime}</p>}
          </div>

          {item.type !== 'image' && item.type !== 'document' && (
            <div className="absolute top-2 left-2">
              <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 h-4 backdrop-blur-sm border ${badgeStyle}`}>
                {item.type === 'video' ? 'Video' : item.ext?.toUpperCase() || item.type}
              </Badge>
            </div>
          )}

          <div className="absolute top-2 right-2 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <FavoriteButton
              filePath={item.proxyPath}
              fileName={item.name}
              fileType={item.type}
              projectId={item.projectId}
              projectTitle={item.projectName}
              propertyAddress={item.projectName}
              tonomoBasePath={item.tonomoBasePath}
              size="sm"
              className="bg-black/30 hover:bg-black/50 rounded-full p-1 text-white backdrop-blur-sm"
            />
            {item.proxyPath && (
              <div className="bg-black/30 hover:bg-black/50 rounded-full text-white backdrop-blur-sm [&_button]:p-1 [&_button]:text-white" onClick={(e) => e.stopPropagation()}>
                <TagManager
                  favoriteId={getFavorite?.(item.proxyPath)?.id}
                  currentTags={getFavorite?.(item.proxyPath)?.tags || []}
                  onTagsChanged={() => {}}
                  onEnsureAndTag={(newTags) => ensureFavoriteAndTag?.({ filePath: item.proxyPath, fileName: item.name, fileType: item.type, projectId: item.projectId, projectTitle: item.projectName, propertyAddress: item.projectName, tonomoBasePath: item.tonomoBasePath }, newTags)}
                  allowCreation={false}
                />
              </div>
            )}
            {item.proxyPath && (
              <button
                onClick={(e) => { e.stopPropagation(); downloadFile(item.proxyPath, item.name); }}
                className="bg-black/30 hover:bg-black/50 rounded-full p-1 text-white backdrop-blur-sm"
                title={`Download ${item.name}`}
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            {item.projectLink && (
              <button
                onClick={(e) => { e.stopPropagation(); safeWindowOpen(item.projectLink); }}
                className="bg-black/30 hover:bg-black/50 rounded-full p-1 text-white backdrop-blur-sm"
                title="Open in Dropbox"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {tags.length > 0 && (
            <div className="absolute bottom-2 left-2 flex gap-1 z-10 group-hover:opacity-0 transition-opacity">
              {tags.slice(0, 2).map(tag => (
                <span
                  key={tag.name}
                  className="inline-flex items-center gap-0.5 text-[9px] font-medium px-1.5 py-0.5 rounded-full backdrop-blur-sm bg-black/40 text-white border border-white/10"
                >
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: tag.color }} />
                  {tag.name}
                </span>
              ))}
              {tags.length > 2 && (
                <span className="text-[9px] font-medium px-1 py-0.5 rounded-full backdrop-blur-sm bg-black/40 text-white/70">
                  +{tags.length - 2}
                </span>
              )}
            </div>
          )}
        </div>

        <div className="p-2.5 space-y-1">
          <p className="text-xs font-medium truncate leading-tight" title={item.name}>{item.name}</p>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {item.size > 0 && <span>{formatSize(item.size)}</span>}
            {item.size > 0 && <span className="text-muted-foreground/30">|</span>}
            <span className="uppercase">{item.ext}</span>
          </div>
          <Link
            to={createPageUrl("ProjectDetails") + `?id=${item.projectId}&tab=media`}
            onClick={e => e.stopPropagation()}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate hover:text-primary transition-colors"
          >
            <Camera className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{item.projectName}</span>
          </Link>
          {item.agentName && (
            <Link
              to={item.agentId ? createPageUrl("PersonDetails") + `?id=${item.agentId}` : createPageUrl("People") + `?search=${encodeURIComponent(item.agentName)}`}
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/60 truncate hover:text-primary transition-colors"
            >
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{item.agentName}</span>
            </Link>
          )}
          {item.agencyName && (
            <Link
              to={item.agencyId ? createPageUrl("OrgDetails") + `?id=${item.agencyId}` : '#'}
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/60 truncate hover:text-primary transition-colors"
            >
              <Building2 className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{item.agencyName}</span>
            </Link>
          )}
          {item.photographerName && item.photographerName !== item.agentName && (
            <Link
              to={item.photographerId ? createPageUrl("Users") + `?id=${item.photographerId}` : '#'}
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 text-[10px] text-muted-foreground/60 truncate hover:text-primary transition-colors"
            >
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{item.photographerName}</span>
            </Link>
          )}
        </div>
      </button>
    </div>
  );
});


// =====================================================================
// NewFilesToast: realtime update banner
// =====================================================================
function NewFilesToast({ count, onRefresh, onDismiss }) {
  if (!count) return null;
  return (
    <div className="sticky top-0 z-30" style={{ animation: 'fadeSlideIn 0.3s ease-out' }}>
      <div className="mx-auto max-w-md">
        <div className="flex items-center gap-3 px-4 py-2.5 bg-blue-600 text-white rounded-xl shadow-lg shadow-blue-600/20 border border-blue-500">
          <Bell className="h-4 w-4 shrink-0 animate-pulse" />
          <span className="text-sm font-medium flex-1">
            {count} new file{count !== 1 ? 's' : ''} available
          </span>
          <button
            onClick={onRefresh}
            className="text-xs font-semibold px-3 py-1 rounded-lg bg-white/20 hover:bg-white/30 transition-colors"
          >
            Refresh
          </button>
          <button onClick={onDismiss} className="p-0.5 hover:bg-white/20 rounded transition-colors">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}


// =====================================================================
// ScrollToTop
// =====================================================================
function ScrollToTop() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => setShow(window.scrollY > 600);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!show) return null;
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
      className="fixed bottom-6 right-6 z-40 p-3 rounded-full bg-primary text-primary-foreground shadow-lg hover:shadow-xl transition-all duration-200 hover:scale-105 active:scale-95"
      title="Back to top"
    >
      <ArrowUp className="h-4 w-4" />
    </button>
  );
}


// =====================================================================
// EmptyState
// =====================================================================
function EmptyState({ hasFiles, onClearFilters, typeFilter, search }) {
  if (hasFiles) {
    const hints = [];
    if (search && search.trim()) hints.push(`search "${search.trim()}"`);
    if (typeFilter && typeFilter !== 'all') hints.push(`type "${typeFilter}"`)
    return (
      <Card className="border-dashed border-2">
        <CardContent className="flex flex-col items-center justify-center py-20 text-center">
          <div className="rounded-2xl bg-muted/50 p-6 mb-5 relative">
            <Search className="h-10 w-10 text-muted-foreground/40" />
            <div className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-orange-100 flex items-center justify-center">
              <X className="h-3 w-3 text-orange-500" />
            </div>
          </div>
          <h3 className="text-sm font-semibold mb-1.5">No files match your filters</h3>
          <p className="text-xs text-muted-foreground max-w-sm mb-4">
            {hints.length > 0
              ? `No results for ${hints.join(' + ')}. Try broadening your criteria or clearing the filters below.`
              : 'Try adjusting the date range, type filter, or search query to find what you are looking for.'}
          </p>
          <Button variant="outline" size="sm" onClick={onClearFilters} className="text-xs gap-1.5">
            <X className="h-3 w-3" />Clear all filters
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-dashed border-2">
      <CardContent className="flex flex-col items-center justify-center py-20 text-center">
        <div className="rounded-2xl bg-muted/50 p-6 mb-5 relative">
          <FolderOpen className="h-12 w-12 text-muted-foreground/30" />
          <div className="absolute -bottom-1 -right-1 rounded-full bg-blue-100 p-1.5">
            <Camera className="h-3.5 w-3.5 text-blue-500" />
          </div>
        </div>
        <h3 className="text-sm font-semibold mb-1.5">No delivered media found</h3>
        <p className="text-xs text-muted-foreground max-w-sm leading-relaxed mb-3">
          Files appear here once projects have Dropbox delivery folders linked.
          Delivered photos, videos, and documents will show up automatically.
        </p>
        <div className="flex flex-col gap-1.5 text-[11px] text-muted-foreground/70 max-w-xs">
          <span>1. Link a Dropbox delivery folder to a project</span>
          <span>2. Upload or deliver media files</span>
          <span>3. Files will appear in this feed within minutes</span>
        </div>
      </CardContent>
    </Card>
  );
}


// =====================================================================
// ErrorState
// =====================================================================
function ErrorState({ error, onRetry }) {
  return (
    <Card className="border-dashed border-2 border-red-200">
      <CardContent className="flex flex-col items-center justify-center py-20 text-center">
        <div className="rounded-2xl bg-red-50 p-6 mb-5">
          <AlertCircle className="h-10 w-10 text-red-400" />
        </div>
        <h3 className="text-sm font-semibold text-red-700 mb-1.5">Failed to load media feed</h3>
        <p className="text-xs text-muted-foreground max-w-sm mb-4">
          {error?.message || "Could not load media files. Check your connection and try again."}
        </p>
        <Button variant="outline" size="sm" onClick={onRetry} className="text-xs border-red-200 text-red-600 hover:bg-red-50 gap-1.5">
          <RefreshCw className="h-3 w-3" />Try again
        </Button>
      </CardContent>
    </Card>
  );
}


// =====================================================================
// Main component
// =====================================================================
export default function LiveMediaFeed() {
  const [projectLimit, setProjectLimit] = useState('25');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [gridSize, setGridSize] = useState('md');
  const [visibleCards, setVisibleCards] = useState(new Set());
  const [lightbox, setLightbox] = useState(null);
  const [page, setPage] = useState(1);
  const [newFilesCount, setNewFilesCount] = useState(0);
  const [scanProgress, setScanProgress] = useState(null);
  const gridRef = useRef(null);

  // Favorites + tags
  const { favorites, allTags: tagRegistry, getFavorite, ensureFavoriteAndTag } = useFavorites();

  // PERF: Pre-index favorites and tags for O(1) lookups instead of O(n) find per card
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

  // Load projects
  const { data: allProjects = [], loading: projectsLoading } = useEntityList('Project', '-created_date', 500);
  const { data: allUsers = [] } = useEntityList('User');

  const userMap = useMemo(() => {
    const m = new Map();
    allUsers.forEach(u => { if (u.id) m.set(u.id, u.full_name || u.email || 'Unknown'); });
    return m;
  }, [allUsers]);

  const eligibleProjects = useMemo(() => {
    if (!Array.isArray(allProjects)) return [];
    const limit = parseInt(projectLimit, 10) || 25;
    return allProjects
      .filter(p => p?.tonomo_deliverable_link && p?.tonomo_deliverable_path)
      .sort((a, b) => {
        const aDate = a.tonomo_delivered_at || a.updated_at || a.created_at || '';
        const bDate = b.tonomo_delivered_at || b.updated_at || b.created_at || '';
        try { return new Date(fixTimestamp(bDate)) - new Date(fixTimestamp(aDate)); } catch { return 0; }
      })
      .slice(0, limit);
  }, [allProjects, projectLimit]);

  // Fetch file listings
  const { data: projectFiles, isLoading: filesLoading, isError, error: fetchError, isFetching, refetch } = useQuery({
    queryKey: ['liveMediaFeed', eligibleProjects.map(p => p.id).join(',')],
    queryFn: async () => {
      if (eligibleProjects.length === 0) return [];
      setScanProgress({ current: 0, total: eligibleProjects.length });

      let completed = 0;
      const results = [];
      const queue = [...eligibleProjects];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const project = queue.shift();
          try {
            const useForce = forceRefreshRef.current;
            const res = await api.functions.invoke("getDeliveryMediaFeed", {
              share_url: project.tonomo_deliverable_link,
              base_path: project.tonomo_deliverable_path || undefined,
              ...(useForce && { force_refresh: true }),
            });
            const data = res?.data || res;
            if (data?.error) {
              completed++;
              setScanProgress({ current: completed, total: eligibleProjects.length });
              continue;
            }
            let folders = [];
            if (data?.folders && Array.isArray(data.folders)) folders = data.folders;
            else if (data?.files && Array.isArray(data.files)) folders = [{ name: "All Files", files: data.files }];

            const files = folders.flatMap(folder =>
              (folder.files || []).map(file => ({
                ...file,
                projectId: project.id,
                projectName: project.property_address || project.title || 'Unknown Project',
                projectLink: project.tonomo_deliverable_link,
                tonomoBasePath: project.tonomo_deliverable_path,
                folderName: folder.name,
                photographerName: userMap.get(project.photographer_id) || userMap.get(project.project_owner_id) || project.agent_name || null,
                photographerId: project.photographer_id || project.project_owner_id || null,
                agentName: project.agent_name || null,
                agentId: project.agent_id || null,
                agencyName: project.agency_name || null,
                agencyId: project.agency_id || null,
                proxyPath: project.tonomo_deliverable_path
                  ? `${project.tonomo_deliverable_path}${file.path?.startsWith('/') ? file.path : '/' + file.path}`
                  : null,
              }))
            );
            results.push(...files);
          } catch (err) {
            console.warn('[LiveMediaFeed] Failed to load project:', project.property_address, err?.message);
          }
          completed++;
          setScanProgress({ current: completed, total: eligibleProjects.length });
        }
      });

      await Promise.all(workers);
      setScanProgress(null);
      forceRefreshRef.current = false; // Reset force flag after scan
      return results;
    },
    enabled: eligibleProjects.length > 0,
    staleTime: 5 * 60 * 1000,
    gcTime: 15 * 60 * 1000, // PERF: keep cached data 15 min after unmount (heavy scan)
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Supabase realtime: watch for project updates
  useEffect(() => {
    if (!eligibleProjects.length) return;
    const projectIds = new Set(eligibleProjects.map(p => p.id));

    const unsub = api.entities.Project.subscribe((event) => {
      if (event.type === 'update' && projectIds.has(event.id)) {
        const proj = event.data;
        if (proj?.tonomo_deliverable_link && proj?.tonomo_deliverable_path) {
          setNewFilesCount(prev => prev + 1);
        }
      }
    });

    return () => { if (typeof unsub === 'function') unsub(); };
  }, [eligibleProjects]);

  const hasActiveFilters = projectLimit !== '25' || typeFilter !== 'all' || search.trim() !== '';
  const activeFilterCount = (projectLimit !== '25' ? 1 : 0) + (typeFilter !== 'all' ? 1 : 0) + (search.trim() !== '' ? 1 : 0);

  const clearFilters = useCallback(() => {
    setProjectLimit('25');
    setTypeFilter('all');
    setSearch('');
    setPage(1);
  }, []);

  const feedItems = useMemo(() => {
    if (!projectFiles || !Array.isArray(projectFiles)) return [];

    return projectFiles
      .filter(f => {
        if (typeFilter !== 'all' && f.type !== typeFilter) return false;
        if (search.trim()) {
          const q = search.toLowerCase();
          const matches = (
            f.name?.toLowerCase().includes(q) ||
            f.projectName?.toLowerCase().includes(q) ||
            f.folderName?.toLowerCase().includes(q) ||
            f.photographerName?.toLowerCase().includes(q) ||
            f.agencyName?.toLowerCase().includes(q) ||
            f.agentName?.toLowerCase().includes(q)
          );
          if (!matches) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aDate = a.uploaded_at || a.modified || '';
        const bDate = b.uploaded_at || b.modified || '';
        try { return new Date(bDate) - new Date(aDate); } catch { return 0; }
      });
  }, [projectFiles, typeFilter, search]);

  // Paginated items
  const paginatedItems = useMemo(() => feedItems.slice(0, page * PAGE_SIZE), [feedItems, page]);
  const hasMore = paginatedItems.length < feedItems.length;

  useEffect(() => { setPage(1); }, [projectLimit, typeFilter, search]);

  // Stats over ALL files
  const stats = useMemo(() => {
    const all = projectFiles || [];
    const photos = all.filter(f => f.type === 'image').length;
    const videos = all.filter(f => f.type === 'video').length;
    const docs = all.filter(f => f.type === 'document').length;
    const projects = new Set(all.map(f => f.projectId)).size;
    const newest = all.reduce((latest, f) => {
      if (!f.uploaded_at) return latest;
      return (!latest || new Date(f.uploaded_at) > new Date(latest)) ? f.uploaded_at : latest;
    }, null);
    return { photos, videos, docs, projects, total: all.length, newest };
  }, [projectFiles]);

  // IntersectionObserver for lazy-loading
  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleCards(prev => {
          const next = new Set(prev);
          entries.forEach(entry => {
            const id = entry.target.dataset.feedId;
            if (!id) return;
            if (entry.isIntersecting) next.add(id);
          });
          if (next.size === prev.size) return prev;
          return next;
        });
      },
      { root: null, rootMargin: '300px', threshold: 0 }
    );

    const cards = gridRef.current.querySelectorAll('[data-feed-id]');
    cards.forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, [paginatedItems]);

  const forceRefreshRef = useRef(false);
  const handleRefresh = useCallback(() => {
    // PERF: use LRU cache's prefix eviction instead of manual iteration
    eligibleProjects.forEach(p => {
      if (p.tonomo_deliverable_path) {
        blobCache.evictByPrefix(`thumb::${p.tonomo_deliverable_path}`);
        blobCache.evictByPrefix(`proxy::${p.tonomo_deliverable_path}`);
      }
    });
    setNewFilesCount(0);
    forceRefreshRef.current = true; // Tell next fetch to bypass server cache
    refetch();
  }, [refetch, eligibleProjects]);

  const isLoading = projectsLoading || filesLoading;

  return (
    <div className="space-y-5">
      {/* Keyframes */}
      <style>{`
        @keyframes shimmer { 100% { transform: translateX(100%); } }
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes cardEnter { from { opacity: 0; transform: scale(0.97); } to { opacity: 1; transform: scale(1); } }
        [data-feed-id] { animation: cardEnter 0.3s ease-out both; contain: layout style paint; }
      `}</style>

      {/* New files toast */}
      <NewFilesToast
        count={newFilesCount}
        onRefresh={handleRefresh}
        onDismiss={() => setNewFilesCount(0)}
      />

      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            Live Media Feed
            {isFetching && !isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLoading
              ? 'Scanning delivery folders across projects...'
              : `${stats.total.toLocaleString()} files across ${stats.projects} project${stats.projects !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="text-xs h-8 px-3 gap-1.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* Animated stat cards */}
      <StatsHeader stats={stats} newestUpload={stats.newest} isLoading={isLoading} />

      {/* Compact filter bar */}
      <div className="flex flex-wrap gap-2 items-center bg-muted/30 rounded-xl p-2 border">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search files, projects, photographers..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-background border-0 shadow-sm"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 hover:bg-muted rounded"
            >
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          )}
        </div>

        <Select value={projectLimit} onValueChange={v => { setProjectLimit(v); setPage(1); }}>
          <SelectTrigger className="w-40 h-8 text-xs bg-background border-0 shadow-sm">
            <FolderOpen className="h-3 w-3 mr-1 text-muted-foreground shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROJECT_LIMITS.map(d => (
              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={v => { setTypeFilter(v); setPage(1); }}>
          <SelectTrigger className="w-32 h-8 text-xs bg-background border-0 shadow-sm">
            <Filter className="h-3 w-3 mr-1 text-muted-foreground shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_FILTERS.map(t => {
              const TIcon = t.icon;
              return (
                <SelectItem key={t.value} value={t.value}>
                  <span className="flex items-center gap-1.5">
                    <TIcon className="h-3 w-3" />{t.label}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>

        <div className="flex items-center bg-background rounded-lg overflow-hidden shadow-sm shrink-0" role="radiogroup" aria-label="Grid size">
          {[
            { key: 'sm', icon: Grid3x3, title: 'Small grid' },
            { key: 'md', icon: Grid2x2, title: 'Medium grid' },
            { key: 'lg', icon: LayoutGrid, title: 'Large grid' },
          ].map(({ key, icon: GIcon, title }) => (
            <button
              key={key}
              onClick={() => setGridSize(key)}
              title={title}
              role="radio"
              aria-checked={gridSize === key}
              aria-label={title}
              className={cn(
                "p-1.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset",
                gridSize === key
                  ? 'bg-primary text-primary-foreground'
                  : 'hover:bg-muted text-muted-foreground'
              )}
            >
              <GIcon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            className="h-8 px-2.5 text-xs text-orange-600 hover:text-orange-700 hover:bg-orange-50 gap-1.5"
          >
            <X className="h-3 w-3" />
            Clear
            <span className="inline-flex items-center justify-center h-4 w-4 rounded-full bg-orange-100 text-[10px] font-bold text-orange-700">
              {activeFilterCount}
            </span>
          </Button>
        )}

        <span className="text-[11px] text-muted-foreground shrink-0 ml-auto">
          {feedItems.length === stats.total
            ? `${feedItems.length.toLocaleString()} file${feedItems.length !== 1 ? 's' : ''}`
            : `${feedItems.length.toLocaleString()} of ${stats.total.toLocaleString()}`}
        </span>
      </div>

      {/* Content */}
      {isLoading ? (
        <FeedSkeleton gridSize={gridSize} scanProgress={scanProgress} />
      ) : isError ? (
        <ErrorState error={fetchError} onRetry={handleRefresh} />
      ) : feedItems.length === 0 ? (
        <EmptyState hasFiles={projectFiles && projectFiles.length > 0} onClearFilters={clearFilters} typeFilter={typeFilter} search={search} />
      ) : (
        <>
          <div
            ref={gridRef}
            className={cn("grid transition-all duration-300 ease-in-out", GRID_CONFIGS[gridSize])}
          >
            {paginatedItems.map((item, idx) => {
              const feedId = `${item.projectId}-${item.path || item.name}-${idx}`;
              return (
                <div key={feedId} data-feed-id={feedId}>
                  <FeedCard
                    item={item}
                    isVisible={visibleCards.has(feedId)}
                    onClick={() => setLightbox({ files: feedItems, index: idx })}
                    getTagsForFile={getTagsForFile}
                    getFavorite={getFavorite}
                    ensureFavoriteAndTag={ensureFavoriteAndTag}
                  />
                </div>
              );
            })}
          </div>

          {hasMore && (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <div className="h-px w-12 bg-border" />
                Showing {paginatedItems.length.toLocaleString()} of {feedItems.length.toLocaleString()}
                <div className="h-px w-12 bg-border" />
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage(p => p + 1)}
                className="text-xs h-9 px-6 gap-2"
              >
                <TrendingUp className="h-3.5 w-3.5" />
                Load {Math.min(PAGE_SIZE, feedItems.length - paginatedItems.length).toLocaleString()} more
              </Button>
            </div>
          )}

          {!hasMore && feedItems.length > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
              <div className="h-px w-12 bg-border" />
              All {feedItems.length.toLocaleString()} files loaded
              <div className="h-px w-12 bg-border" />
            </div>
          )}
        </>
      )}

      <ScrollToTop />

      {lightbox && createPortal(
        <MediaLightbox
          files={lightbox.files}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
          getFavorite={getFavorite}
          ensureFavoriteAndTag={ensureFavoriteAndTag}
        />,
        document.body
      )}
    </div>
  );
}

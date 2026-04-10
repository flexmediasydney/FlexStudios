import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { LRUBlobCache, enqueueFetch, decodeImage } from "@/utils/mediaPerf";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Heart, Star, Search, Camera, Film, FileText, File,
  ExternalLink, Clock, Grid2x2, Grid3x3, LayoutGrid,
  Tag, FolderOpen, Building2, ImageOff, Play, User,
  Activity, Filter, X, Plus, Trash2, Palette, Check,
  ArrowUpDown, ChevronDown, Sparkles, StarOff
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { formatDistanceToNow, format } from "date-fns";
import { useNavigate, useSearchParams } from "react-router-dom";
import { createPageUrl } from "@/utils";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ---- CSS keyframes injected once ----
const STYLE_ID = '__favorites-page-animations';
if (typeof document !== 'undefined' && !document.getElementById(STYLE_ID)) {
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes favFadeInUp {
      from { opacity: 0; transform: translateY(12px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes favPulse {
      0%, 100% { transform: scale(1); }
      50%      { transform: scale(1.15); }
    }
    @keyframes favSlideIn {
      from { opacity: 0; transform: translateX(-16px); }
      to   { opacity: 1; transform: translateX(0); }
    }
    @keyframes favCountUp {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes favShimmer {
      0%   { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes favHeartBeat {
      0%   { transform: scale(1); }
      14%  { transform: scale(1.2); }
      28%  { transform: scale(1); }
      42%  { transform: scale(1.15); }
      70%  { transform: scale(1); }
    }
    @keyframes favImageFadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    .fav-card-enter {
      animation: favFadeInUp 0.4s ease-out both;
    }
    .fav-timeline-enter {
      animation: favSlideIn 0.35s ease-out both;
    }
    .fav-stat-enter {
      animation: favCountUp 0.5s ease-out both;
    }
    .fav-heart-beat {
      animation: favHeartBeat 1.2s ease-in-out;
    }
    .fav-image-loaded {
      animation: favImageFadeIn 0.4s ease-out both;
    }
    .fav-grid-transition > * {
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
  `;
  document.head.appendChild(style);
}


// ---- Image proxy with concurrency limiter + LRU blob cache ----
// PERF: Reduced from 400 to 200 max entries; uses shared LRU class with proper URL.revokeObjectURL
const blobCache = new LRUBlobCache(200);
const pending = new Set();

// PERF: Uses global concurrency limiter + img.decode() before caching
async function fetchProxyImage(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  if (blobCache.has(cacheKey)) return blobCache.get(cacheKey);
  if (pending.has(cacheKey)) return null;
  pending.add(cacheKey);
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
      if (mode === 'thumb') await decodeImage(blobUrl);
      return blobUrl;
    });
    if (url) blobCache.set(cacheKey, url);
    return url;
  } catch { return null; }
  finally { pending.delete(cacheKey); }
}

// ---- Dropbox preview URL builder ----
const DROPBOX_SHARE_BASE = 'https://www.dropbox.com/scl/fo/7wnvxwd9722243256h33m/ANBWjH-I1_RZbjyWt0n4Agg';
const DROPBOX_RLKEY = 'jhdry20jttkrn0o1v8bpmcsmf';
const TONOMO_PREFIX = '/flex media team folder/tonomo';

function buildDropboxPreviewUrl(fullPath) {
  if (!fullPath) return null;
  const lowerPath = fullPath.toLowerCase();
  const lowerPrefix = TONOMO_PREFIX.toLowerCase();
  let relativePath = fullPath;
  if (lowerPath.startsWith(lowerPrefix)) {
    relativePath = fullPath.slice(TONOMO_PREFIX.length);
  }
  if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;
  // Filter out empty segments to avoid double slashes from trailing/consecutive slashes in paths
  const encodedPath = relativePath.split('/').filter(seg => seg.length > 0).map(seg => encodeURIComponent(seg)).join('/');
  return `${DROPBOX_SHARE_BASE}/${encodedPath}?rlkey=${DROPBOX_RLKEY}&dl=0`;
}

// ---- Helpers ----
function FileIcon({ type, className }) {
  switch (type) {
    case "image":    return <Camera className={className} />;
    case "video":    return <Film className={className} />;
    case "document": return <FileText className={className} />;
    default:         return <File className={className} />;
  }
}

function timeAgo(dateStr) {
  if (!dateStr) return null;
  try { return formatDistanceToNow(new Date(dateStr), { addSuffix: true }); } catch { return null; }
}

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

// ---- Grid sizes ----
const GRID_SIZES = {
  sm: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2',
  md: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3',
  lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4',
};

// ---- Type filter options ----
const TYPE_FILTERS = [
  { value: 'all',      label: 'All' },
  { value: 'file',     label: 'Files' },
  { value: 'project',  label: 'Projects' },
];

// ---- Tag color lookup helper ----
function useTagColorMap(mediaTags) {
  return useMemo(() => {
    const map = {};
    (mediaTags || []).forEach(t => { map[t.name] = t.color || '#3b82f6'; });
    return map;
  }, [mediaTags]);
}


// ================ FILE FAVORITE CARD ================

function FileFavoriteCard({ favorite, isVisible, tagColorMap, onUnfavorite, animDelay = 0 }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);
  const started = useRef(false);

  const canThumb = favorite.file_type === 'image' || favorite.file_type === 'video' || favorite.file_type === 'document';
  // file_path is stored as the full proxy path (basePath + relativePath) at favorite-time.
  // Do NOT re-prepend tonomo_base_path — it is already baked into file_path.
  const proxyPath = favorite.file_path || null;

  useEffect(() => {
    if (!canThumb || !proxyPath || started.current) return;
    const cached = blobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    if (!isVisible) return;
    started.current = true;
    setLoading(true);
    fetchProxyImage(proxyPath, 'thumb').then(url => {
      if (url) setBlobUrl(url);
      else setThumbFailed(true);
      setLoading(false);
    });
  }, [canThumb, proxyPath, isVisible]);

  const handleClick = () => {
    if (proxyPath) {
      const dropboxUrl = buildDropboxPreviewUrl(proxyPath);
      if (dropboxUrl) { safeWindowOpen(dropboxUrl); return; }
    }
    if (favorite.preview_url) safeWindowOpen(favorite.preview_url);
  };

  const handleUnfavorite = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onUnfavorite) onUnfavorite(favorite);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="fav-card-enter group relative rounded-xl overflow-hidden border bg-card text-left w-full focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-300 hover:shadow-xl hover:shadow-primary/5 hover:-translate-y-1"
      style={{ animationDelay: `${animDelay}ms` }}
    >
      {/* Thumbnail */}
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden relative">
        {blobUrl ? (
          <img
            src={blobUrl}
            alt={favorite.file_name}
            className={cn(
              "w-full h-full object-cover transition-transform duration-500 group-hover:scale-110",
              imageLoaded ? "fav-image-loaded" : "opacity-0"
            )}
            loading="lazy"
            onLoad={() => setImageLoaded(true)}
          />
        ) : loading ? (
          <div className="w-full h-full bg-muted flex items-center justify-center">
            <div className="relative">
              <Camera className="h-6 w-6 text-muted-foreground/20" />
              <div className="absolute inset-0 rounded-full border-2 border-primary/20 border-t-primary/60 animate-spin" style={{ width: 32, height: 32, left: -4, top: -4 }} />
            </div>
          </div>
        ) : thumbFailed && canThumb ? (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <ImageOff className="h-8 w-8 opacity-40 text-amber-500/60" />
            <span className="text-[10px] font-medium uppercase tracking-wider text-amber-600/70">Re-star to fix</span>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <FileIcon type={favorite.file_type} className="h-8 w-8 opacity-40" />
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">{favorite.file_type || 'file'}</span>
          </div>
        )}

        {/* Video overlay */}
        {favorite.file_type === 'video' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/40 rounded-full p-2.5 backdrop-blur-sm"><Play className="h-5 w-5 text-white fill-white" /></div>
          </div>
        )}

        {/* Always-visible star */}
        <div className="absolute top-2 left-2 drop-shadow-lg">
          <Star className="h-5 w-5 text-yellow-400 fill-yellow-400 filter drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        </div>

        {/* Hover overlay with details */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3 pointer-events-none">
          <div className="pointer-events-auto space-y-1.5">
            <p className="text-white text-xs font-semibold truncate drop-shadow-sm">{favorite.file_name}</p>
            {favorite.project_title && (
              <p className="text-white/70 text-[10px] truncate">{favorite.project_title}</p>
            )}
            {favorite.tags?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {favorite.tags.slice(0, 4).map(tag => (
                  <span
                    key={tag}
                    className="text-[9px] px-1.5 py-0.5 rounded-full text-white font-medium"
                    style={{ backgroundColor: (tagColorMap[tag] || '#3b82f6') + 'cc' }}
                  >
                    #{tag}
                  </span>
                ))}
                {favorite.tags.length > 4 && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-white/20 text-white/80">
                    +{favorite.tags.length - 4}
                  </span>
                )}
              </div>
            )}
            {favorite.created_date && (
              <p className="text-white/50 text-[9px]">{timeAgo(favorite.created_date)}</p>
            )}
            {/* Unfavorite button */}
            <button
              type="button"
              onClick={handleUnfavorite}
              className="inline-flex items-center gap-1 text-[10px] text-white/70 hover:text-red-300 transition-colors mt-1"
            >
              <StarOff className="h-3 w-3" />
              Unfavorite
            </button>
          </div>
        </div>

        {/* External link hint on hover */}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="bg-black/40 backdrop-blur-sm rounded-full p-1">
            <ExternalLink className="h-3 w-3 text-white" />
          </div>
        </div>

        {/* Type badge for non-images */}
        {favorite.file_type !== 'image' && (
          <div className="absolute bottom-2 left-2 group-hover:opacity-0 transition-opacity">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
              {favorite.file_type === 'video' ? 'Video' : (favorite.file_type || 'File')}
            </Badge>
          </div>
        )}
      </div>

      {/* Info below card */}
      <div className="p-2.5 space-y-1">
        <p className="text-xs font-medium truncate leading-tight" title={favorite.file_name}>{favorite.file_name}</p>
        {favorite.property_address && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate">
            <Building2 className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{favorite.property_address}</span>
          </div>
        )}
        {/* Tag pills with registry colors */}
        {favorite.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {favorite.tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border"
                style={{
                  color: tagColorMap[tag] || '#3b82f6',
                  borderColor: (tagColorMap[tag] || '#3b82f6') + '40',
                  backgroundColor: (tagColorMap[tag] || '#3b82f6') + '10',
                }}
              >
                #{tag}
              </span>
            ))}
            {favorite.tags.length > 3 && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                +{favorite.tags.length - 3}
              </span>
            )}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          {(favorite.favorited_by_name || favorite.created_by_name) && (
            <>
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{favorite.favorited_by_name || favorite.created_by_name}</span>
            </>
          )}
          {favorite.created_date && (
            <>
              <span className="text-muted-foreground/30">|</span>
              <Clock className="h-2.5 w-2.5 shrink-0 opacity-50" />
              <span className="opacity-70">{timeAgo(favorite.created_date)}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}


// ================ PROJECT FAVORITE CARD ================

function ProjectFavoriteCard({ favorite, tagColorMap, onUnfavorite, animDelay = 0 }) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (favorite.project_id) {
      navigate(createPageUrl("ProjectDetails") + `?id=${favorite.project_id}`);
    }
  };

  const handleUnfavorite = (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (onUnfavorite) onUnfavorite(favorite);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="fav-card-enter group relative rounded-xl overflow-hidden border bg-card text-left w-full focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all duration-300 hover:shadow-xl hover:shadow-primary/5 hover:-translate-y-1"
      style={{ animationDelay: `${animDelay}ms` }}
    >
      {/* Project visual */}
      <div className="aspect-[4/3] bg-gradient-to-br from-primary/10 via-muted to-primary/5 flex items-center justify-center relative overflow-hidden">
        {/* Decorative pattern */}
        <div className="absolute inset-0 opacity-[0.03]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)', backgroundSize: '20px 20px' }} />

        <div className="text-center p-4 relative z-10">
          <div className="mx-auto mb-2 w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
            <FolderOpen className="h-6 w-6 text-primary/60" />
          </div>
          <p className="text-sm font-semibold text-foreground/80 line-clamp-2">{favorite.project_title || 'Untitled Project'}</p>
        </div>

        {/* Star */}
        <div className="absolute top-2 left-2 drop-shadow-lg">
          <Star className="h-5 w-5 text-yellow-400 fill-yellow-400 filter drop-shadow-[0_1px_2px_rgba(0,0,0,0.3)]" />
        </div>

        <div className="absolute top-2 right-2">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
            Project
          </Badge>
        </div>

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex flex-col justify-end p-3 pointer-events-none">
          <div className="pointer-events-auto">
            <button
              type="button"
              onClick={handleUnfavorite}
              className="inline-flex items-center gap-1 text-[10px] text-white/70 hover:text-red-300 transition-colors"
            >
              <StarOff className="h-3 w-3" />
              Unfavorite
            </button>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1">
        <p className="text-xs font-medium truncate leading-tight" title={favorite.project_title}>{favorite.project_title || 'Untitled'}</p>
        {favorite.property_address && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate">
            <Building2 className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{favorite.property_address}</span>
          </div>
        )}
        {/* Tags */}
        {favorite.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {favorite.tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="text-[9px] px-1.5 py-0.5 rounded-full font-medium border"
                style={{
                  color: tagColorMap[tag] || '#3b82f6',
                  borderColor: (tagColorMap[tag] || '#3b82f6') + '40',
                  backgroundColor: (tagColorMap[tag] || '#3b82f6') + '10',
                }}
              >
                #{tag}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          {(favorite.favorited_by_name || favorite.created_by_name) && (
            <>
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{favorite.favorited_by_name || favorite.created_by_name}</span>
            </>
          )}
          {favorite.created_date && (
            <>
              <span className="text-muted-foreground/30">|</span>
              <Clock className="h-2.5 w-2.5 shrink-0 opacity-50" />
              <span className="opacity-70">{timeAgo(favorite.created_date)}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}


// ================ SKELETON ================

function FavoriteSkeleton({ count = 8, gridSize = 'md' }) {
  return (
    <div className={cn("grid", GRID_SIZES[gridSize])}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden border bg-card">
          <Skeleton className="aspect-[4/3] w-full" />
          <div className="p-2.5 space-y-1.5">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
            <div className="flex gap-1">
              <Skeleton className="h-3 w-10 rounded-full" />
              <Skeleton className="h-3 w-12 rounded-full" />
            </div>
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}


// ================ ACTIVITY TIMELINE ================

const ACTION_CONFIG = {
  favorited:    { icon: Star,    color: 'text-yellow-500', bg: 'bg-yellow-100 dark:bg-yellow-900/30', dotColor: 'bg-yellow-400', lineColor: 'border-yellow-200 dark:border-yellow-800', verb: 'favorited' },
  unfavorited:  { icon: Heart,   color: 'text-red-400',    bg: 'bg-red-100 dark:bg-red-900/30',      dotColor: 'bg-red-400',    lineColor: 'border-red-200 dark:border-red-800',      verb: 'unfavorited' },
  tags_updated: { icon: Tag,     color: 'text-blue-500',   bg: 'bg-blue-100 dark:bg-blue-900/30',    dotColor: 'bg-blue-400',   lineColor: 'border-blue-200 dark:border-blue-800',    verb: 'updated tags on' },
};

function TimelineEntry({ entry, index }) {
  const actor = entry.performed_by_name || entry.user_name || 'Unknown';
  const action = entry.action || 'favorited';
  const details = typeof entry.details === 'object' && entry.details !== null ? entry.details : {};
  const detailStr = typeof entry.details === 'string' ? entry.details : null;

  const target = entry.entity_name || details.file_name || details.project_title || detailStr || 'an item';
  const isFile = !!(details.file_path || details.file_name);
  const isProject = !!(details.project_id || details.project_title);

  const config = ACTION_CONFIG[action] || ACTION_CONFIG.favorited;
  const ActionIcon = config.icon;

  const addedTags = details.added_tags || [];
  const removedTags = details.removed_tags || [];

  // file_path in audit details is already the full proxy path (basePath + relative).
  // Do NOT re-prepend tonomo_base_path.
  const thumbPath = details.file_path || null;

  const [thumbUrl, setThumbUrl] = useState(null);
  const thumbStarted = useRef(false);

  useEffect(() => {
    if (!thumbPath || details.file_type !== 'image' || thumbStarted.current) return;
    const cached = blobCache.get(`thumb::${thumbPath}`);
    if (cached) { setThumbUrl(cached); return; }
    thumbStarted.current = true;
    fetchProxyImage(thumbPath, 'thumb').then(url => {
      if (url) setThumbUrl(url);
    });
  }, [thumbPath, details.file_type]);

  return (
    <div
      className="fav-timeline-enter relative flex gap-4 pb-6 last:pb-0"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      {/* Vertical line */}
      <div className="absolute left-[15px] top-9 bottom-0 w-px bg-border/60 last:hidden" />

      {/* Timeline dot + avatar */}
      <div className="relative z-10 flex-shrink-0">
        <div className={cn(
          "w-8 h-8 rounded-full flex items-center justify-center ring-4 ring-background",
          config.bg
        )}>
          {actor !== 'Unknown' ? (
            <span className={cn("text-[10px] font-bold", config.color)}>
              {getInitials(actor)}
            </span>
          ) : (
            <ActionIcon className={cn("h-3.5 w-3.5", config.color)} />
          )}
        </div>
      </div>

      {/* Content card */}
      <div className="flex-1 min-w-0">
        <div className={cn(
          "rounded-lg border p-3 transition-colors hover:bg-muted/30",
          config.lineColor
        )}>
          <div className="flex items-start gap-3">
            <div className="flex-1 min-w-0 space-y-1.5">
              <p className="text-xs text-foreground leading-relaxed">
                <span className="font-semibold">{actor}</span>
                {' '}<span className="text-muted-foreground">{config.verb}</span>{' '}
                <span className="font-medium">{target}</span>
              </p>

              {/* Tag changes */}
              {action === 'tags_updated' && (addedTags.length > 0 || removedTags.length > 0) && (
                <div className="flex flex-wrap gap-1">
                  {addedTags.map(t => (
                    <Badge key={`+${t}`} variant="outline" className="text-[9px] px-1 py-0 h-3.5 bg-green-50 text-green-600 border-green-200 dark:bg-green-900/20 dark:text-green-400 dark:border-green-800">
                      +#{t}
                    </Badge>
                  ))}
                  {removedTags.map(t => (
                    <Badge key={`-${t}`} variant="outline" className="text-[9px] px-1 py-0 h-3.5 bg-red-50 text-red-600 border-red-200 dark:bg-red-900/20 dark:text-red-400 dark:border-red-800 line-through">
                      #{t}
                    </Badge>
                  ))}
                </div>
              )}

              {/* Property context */}
              {details.property_address && (
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60">
                  <Building2 className="h-2.5 w-2.5" />
                  <span className="truncate">{details.property_address}</span>
                </div>
              )}

              {entry.created_date && (
                <p className="text-[10px] text-muted-foreground/50 flex items-center gap-1">
                  <Clock className="h-2.5 w-2.5" />
                  {timeAgo(entry.created_date)}
                </p>
              )}
            </div>

            {/* Thumbnail */}
            {isFile && (
              <div className="w-10 h-10 rounded-lg overflow-hidden bg-muted flex-shrink-0 flex items-center justify-center border">
                {thumbUrl ? (
                  <img src={thumbUrl} alt="" className="w-full h-full object-cover" />
                ) : (
                  <FileIcon type={details.file_type} className="h-4 w-4 text-muted-foreground/30" />
                )}
              </div>
            )}

            {/* Project icon */}
            {isProject && !isFile && (
              <div className="w-10 h-10 rounded-lg overflow-hidden bg-primary/5 flex-shrink-0 flex items-center justify-center border">
                <FolderOpen className="h-4 w-4 text-primary/40" />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


// ================ TAG FILTER MULTI-SELECT ================

function TagFilterSelect({ availableTags, selectedTags, onToggle, tagColorMap }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (availableTags.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className={cn("h-8 text-xs gap-1.5", selectedTags.length > 0 && "border-primary/50 bg-primary/5")}
      >
        <Tag className="h-3 w-3" />
        Tags
        {selectedTags.length > 0 && (
          <Badge variant="secondary" className="text-[10px] px-1 py-0 h-4 ml-0.5">{selectedTags.length}</Badge>
        )}
        <ChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} />
      </Button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-56 bg-popover border rounded-lg shadow-xl p-2 space-y-0.5 max-h-60 overflow-y-auto">
          {selectedTags.length > 0 && (
            <button
              onClick={() => { selectedTags.forEach(t => onToggle(t)); }}
              className="w-full text-left text-[11px] text-red-500 hover:text-red-600 px-2 py-1.5 rounded hover:bg-red-50 dark:hover:bg-red-900/20 mb-1 flex items-center gap-1.5 font-medium"
            >
              <X className="h-3 w-3" />
              Clear all filters
            </button>
          )}
          {availableTags.map(tag => (
            <button
              key={tag.name}
              onClick={() => onToggle(tag.name)}
              className={cn(
                "w-full text-left text-xs px-2 py-1.5 rounded flex items-center gap-2.5 transition-colors",
                selectedTags.includes(tag.name) ? "bg-primary/10 text-primary" : "hover:bg-muted/50 text-foreground"
              )}
            >
              {/* Color dot */}
              <span
                className="w-3 h-3 rounded-full shrink-0 border border-black/10"
                style={{ backgroundColor: tag.color || '#3b82f6' }}
              />
              <span className={cn(
                "w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0",
                selectedTags.includes(tag.name) ? "bg-primary border-primary" : "border-muted-foreground/30"
              )}>
                {selectedTags.includes(tag.name) && (
                  <svg className="w-2 h-2 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
              <span className="flex-1 truncate">#{tag.name}</span>
              {tag.usage_count > 0 && (
                <span className="text-[10px] text-muted-foreground/50 tabular-nums">{tag.usage_count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}


// ================ EMPTY STATE ================

function EmptyFavoritesState({ hasFilters, onClearFilters }) {
  if (hasFilters) {
    return (
      <Card className="border-dashed border-2">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-2xl bg-muted/50 p-5 mb-5">
            <Search className="h-10 w-10 text-muted-foreground/40" />
          </div>
          <h3 className="text-base font-semibold mb-2">No favorites match your filters</h3>
          <p className="text-sm text-muted-foreground max-w-sm mb-4">
            Try adjusting the type filter, tags, or search query to find what you are looking for.
          </p>
          <Button variant="outline" size="sm" onClick={onClearFilters} className="gap-1.5">
            <X className="h-3.5 w-3.5" />
            Clear all filters
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-dashed border-2">
      <CardContent className="flex flex-col items-center justify-center py-20 text-center">
        {/* Illustration-style empty state */}
        <div className="relative mb-6">
          {/* Background glow */}
          <div className="absolute inset-0 blur-2xl opacity-20 bg-gradient-to-br from-yellow-300 via-red-200 to-purple-300 rounded-full scale-150" />

          {/* Layered icons */}
          <div className="relative">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-muted to-muted/50 flex items-center justify-center border-2 border-dashed border-muted-foreground/20 rotate-3">
              <Camera className="h-8 w-8 text-muted-foreground/25" />
            </div>
            <div className="absolute -bottom-2 -right-3 w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-100 to-amber-100 dark:from-yellow-900/40 dark:to-amber-900/40 flex items-center justify-center border border-yellow-200 dark:border-yellow-800 shadow-sm -rotate-6">
              <Star className="h-5 w-5 text-yellow-500 fill-yellow-500" />
            </div>
            <div className="absolute -top-2 -left-3 w-8 h-8 rounded-lg bg-gradient-to-br from-red-100 to-pink-100 dark:from-red-900/40 dark:to-pink-900/40 flex items-center justify-center border border-red-200 dark:border-red-800 shadow-sm rotate-12">
              <Heart className="h-4 w-4 text-red-400 fill-red-400" />
            </div>
          </div>
        </div>

        <h3 className="text-lg font-bold mb-2 bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">
          No favorites yet
        </h3>
        <p className="text-sm text-muted-foreground max-w-md leading-relaxed">
          Start exploring media from your projects and star your favorites.
          Your starred files and projects will appear here for quick access.
        </p>
        <div className="flex items-center gap-2 mt-6 text-xs text-muted-foreground/60">
          <Sparkles className="h-3.5 w-3.5" />
          <span>Tip: Click the star icon on any file or project to add it here</span>
        </div>
      </CardContent>
    </Card>
  );
}


// ================ TAG COLOR PRESETS ================

const TAG_COLOR_PRESETS = [
  { name: 'Blue', value: '#3b82f6' },
  { name: 'Red', value: '#ef4444' },
  { name: 'Green', value: '#22c55e' },
  { name: 'Yellow', value: '#eab308' },
  { name: 'Purple', value: '#8b5cf6' },
  { name: 'Pink', value: '#ec4899' },
  { name: 'Orange', value: '#f97316' },
  { name: 'Cyan', value: '#06b6d4' },
];


// ================ TAG MANAGEMENT SUBTAB ================

function TagManagementTab() {
  const { data: user } = useCurrentUser();
  const { data: mediaTags = [], loading: tagsLoading } = useEntityList('MediaTag', 'name', 200);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [colorPickerOpen, setColorPickerOpen] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [sortBy, setSortBy] = useState('name'); // name | usage | date
  const [sortDir, setSortDir] = useState('asc');

  const sortedTags = useMemo(() => {
    const arr = [...mediaTags];
    arr.sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'name') cmp = (a.name || '').localeCompare(b.name || '');
      else if (sortBy === 'usage') cmp = (a.usage_count || 0) - (b.usage_count || 0);
      else if (sortBy === 'date') cmp = new Date(a.created_date || 0) - new Date(b.created_date || 0);
      return sortDir === 'desc' ? -cmp : cmp;
    });
    return arr;
  }, [mediaTags, sortBy, sortDir]);

  const maxUsage = useMemo(() => Math.max(1, ...mediaTags.map(t => t.usage_count || 0)), [mediaTags]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('asc'); }
  };

  const startEdit = useCallback((tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
  }, []);

  const saveEdit = useCallback(async (tag) => {
    const trimmed = editName.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed === tag.name) {
      setEditingId(null);
      return;
    }
    // Check for duplicate name before saving
    const duplicate = mediaTags.find(t => t.name === trimmed && t.id !== tag.id);
    if (duplicate) {
      toast.error('Duplicate tag name', { description: `A tag named "#${trimmed}" already exists.` });
      setEditingId(null);
      return;
    }
    try {
      await api.entities.MediaTag.update(tag.id, { name: trimmed });

      // Propagate rename into all media_favorites that reference the old tag name.
      // Without this, favorites would keep stale tag references in their tags[] array.
      try {
        const { data: allFavs } = await api.entities.MediaFavorite.list();
        const affectedFavs = (allFavs || []).filter(f =>
          Array.isArray(f.tags) && f.tags.includes(tag.name)
        );
        await Promise.all(
          affectedFavs.map(f =>
            api.entities.MediaFavorite.update(f.id, {
              tags: f.tags.map(t => t === tag.name ? trimmed : t),
            })
          )
        );
      } catch (e) {
        console.error('Failed to propagate tag rename to favorites:', e);
      }

      await Promise.all([
        refetchEntityList('MediaTag'),
        refetchEntityList('MediaFavorite'),
      ]);
      toast.success('Tag renamed', { description: `"#${tag.name}" renamed to "#${trimmed}".`, duration: 2500 });
    } catch (err) {
      toast.error('Failed to rename tag', { description: err?.message || 'Please try again.' });
    }
    setEditingId(null);
  }, [editName, mediaTags]);

  const updateColor = useCallback(async (tag, color) => {
    try {
      await api.entities.MediaTag.update(tag.id, { color });
      await refetchEntityList('MediaTag');
      toast.success('Tag color updated', { description: `Color changed for "#${tag.name}".`, duration: 2000 });
    } catch (err) {
      toast.error('Failed to update color', { description: err?.message || 'Please try again.' });
    }
    setColorPickerOpen(null);
  }, []);

  const createTag = useCallback(async () => {
    const trimmed = newTagName.trim().toLowerCase().replace(/[^a-z0-9-_ ]/g, '').replace(/\s+/g, ' ').trim();
    if (!trimmed) return;
    const existing = mediaTags.find(t => t.name === trimmed);
    if (existing) {
      toast.error('Tag already exists', { description: `"#${trimmed}" is already in the registry.` });
      return;
    }
    try {
      await api.entities.MediaTag.create({
        name: trimmed,
        color: newTagColor,
        usage_count: 0,
        created_by_id: user?.id,
        created_by_name: user?.full_name || user?.email || 'Unknown',
      });
      await refetchEntityList('MediaTag');
      toast.success('Tag created', { description: `"#${trimmed}" has been added to the registry.`, duration: 2500 });
      setNewTagName('');
      setNewTagColor('#3b82f6');
      setCreating(false);
    } catch (err) {
      toast.error('Failed to create tag', { description: err?.message || 'Please try again.' });
    }
  }, [newTagName, newTagColor, mediaTags, user]);

  const deleteTag = useCallback(async (tagId) => {
    // Find the tag name before deleting so we can clean up favorites
    const tagRecord = mediaTags.find(t => t.id === tagId);
    const tagName = tagRecord?.name;

    try {
      await api.entities.MediaTag.delete(tagId);

      // Remove this tag from all favorites that reference it.
      // Without this, favorites keep ghost tag names in their tags[] array.
      if (tagName) {
        try {
          const { data: allFavs } = await api.entities.MediaFavorite.list();
          const affectedFavs = (allFavs || []).filter(f =>
            Array.isArray(f.tags) && f.tags.includes(tagName)
          );
          await Promise.all(
            affectedFavs.map(f =>
              api.entities.MediaFavorite.update(f.id, {
                tags: f.tags.filter(t => t !== tagName),
              })
            )
          );
        } catch (e) {
          console.error('Failed to clean up tag references from favorites:', e);
        }
      }

      await Promise.all([
        refetchEntityList('MediaTag'),
        refetchEntityList('MediaFavorite'),
      ]);
      toast.success('Tag deleted', { description: tagName ? `"#${tagName}" has been removed.` : 'Tag removed.', duration: 2500 });
    } catch (err) {
      toast.error('Failed to delete tag', { description: err?.message || 'Please try again.' });
    }
    setDeleteConfirm(null);
  }, [mediaTags]);

  if (tagsLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 rounded" />
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-4 w-16 ml-auto" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg bg-primary/10">
            <Palette className="h-4 w-4 text-primary" />
          </div>
          <h2 className="text-sm font-semibold">Tag Registry</h2>
          <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
            {mediaTags.length}
          </Badge>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setCreating(true)}
          className="text-xs h-7 gap-1.5"
        >
          <Plus className="h-3 w-3" />
          Create Tag
        </Button>
      </div>

      {/* Create tag inline form */}
      {creating && (
        <Card className="border-primary/20 shadow-sm">
          <CardContent className="p-3 flex items-center gap-3">
            <div className="relative">
              <button
                type="button"
                className="w-8 h-8 rounded-md border-2 border-border shrink-0 transition-transform hover:scale-110"
                style={{ backgroundColor: newTagColor }}
                onClick={() => setColorPickerOpen(colorPickerOpen === 'new' ? null : 'new')}
              />
              {colorPickerOpen === 'new' && (
                <div className="absolute top-full left-0 mt-1 z-50 bg-popover border rounded-lg shadow-lg p-2 grid grid-cols-4 gap-1.5">
                  {TAG_COLOR_PRESETS.map(c => (
                    <button
                      key={c.value}
                      onClick={() => { setNewTagColor(c.value); setColorPickerOpen(null); }}
                      className={cn("w-7 h-7 rounded-md transition-all hover:scale-110", newTagColor === c.value && "ring-2 ring-offset-1 ring-primary")}
                      style={{ backgroundColor: c.value }}
                      title={c.name}
                    />
                  ))}
                </div>
              )}
            </div>
            <Input
              value={newTagName}
              onChange={e => setNewTagName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') createTag(); if (e.key === 'Escape') setCreating(false); }}
              placeholder="Tag name..."
              className="h-8 text-sm flex-1"
              autoFocus
            />
            <Button size="sm" onClick={createTag} disabled={!newTagName.trim()} className="h-8 text-xs gap-1">
              <Check className="h-3 w-3" /> Save
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)} className="h-8 text-xs">
              Cancel
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Tag table */}
      {mediaTags.length === 0 && !creating ? (
        <Card className="border-dashed border-2">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <div className="relative mb-4">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
                <Tag className="h-7 w-7 text-muted-foreground/30" />
              </div>
              <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center border">
                <Plus className="h-3.5 w-3.5 text-primary/60" />
              </div>
            </div>
            <h3 className="text-sm font-semibold mb-1">No tags yet</h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              Create tags to categorize and organize your favorited media files.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          {/* Column headers */}
          <div className="flex items-center gap-3 px-3 py-2 bg-muted/40 border-b text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <span className="w-7" />
            <button onClick={() => toggleSort('name')} className="flex items-center gap-1 hover:text-foreground transition-colors">
              Name
              {sortBy === 'name' && <ArrowUpDown className="h-2.5 w-2.5" />}
            </button>
            <div className="flex-1" />
            <button onClick={() => toggleSort('usage')} className="flex items-center gap-1 hover:text-foreground transition-colors w-28 justify-end">
              Usage
              {sortBy === 'usage' && <ArrowUpDown className="h-2.5 w-2.5" />}
            </button>
            <span className="hidden sm:inline w-20 text-right">Creator</span>
            <button onClick={() => toggleSort('date')} className="hidden md:flex items-center gap-1 hover:text-foreground transition-colors w-24 justify-end">
              Created
              {sortBy === 'date' && <ArrowUpDown className="h-2.5 w-2.5" />}
            </button>
            <span className="w-8" />
          </div>

          {/* Tag rows */}
          <div className="divide-y">
            {sortedTags.map(tag => (
              <div key={tag.id} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 transition-colors group">
                {/* Color swatch */}
                <div className="relative">
                  <button
                    type="button"
                    className="w-7 h-7 rounded-full border-2 border-white dark:border-gray-800 shrink-0 transition-all hover:scale-110 shadow-sm"
                    style={{ backgroundColor: tag.color || '#3b82f6' }}
                    onClick={() => setColorPickerOpen(colorPickerOpen === tag.id ? null : tag.id)}
                    title="Change color"
                  />
                  {colorPickerOpen === tag.id && (
                    <div className="absolute top-full left-0 mt-1 z-50 bg-popover border rounded-lg shadow-xl p-2 grid grid-cols-4 gap-1.5">
                      {TAG_COLOR_PRESETS.map(c => (
                        <button
                          key={c.value}
                          onClick={() => updateColor(tag, c.value)}
                          className={cn("w-7 h-7 rounded-full transition-all hover:scale-110", (tag.color || '#3b82f6') === c.value && "ring-2 ring-offset-1 ring-primary")}
                          style={{ backgroundColor: c.value }}
                          title={c.name}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Tag name (editable) */}
                {editingId === tag.id ? (
                  <Input
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') saveEdit(tag); if (e.key === 'Escape') setEditingId(null); }}
                    onBlur={() => saveEdit(tag)}
                    className="h-7 text-sm flex-1 max-w-[200px]"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => startEdit(tag)}
                    className="text-sm font-medium text-foreground hover:text-primary transition-colors cursor-text"
                    title="Click to edit"
                  >
                    #{tag.name}
                  </button>
                )}

                <div className="flex-1" />

                {/* Usage count with mini bar */}
                <div className="flex items-center gap-2 w-28 justify-end">
                  <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden hidden sm:block">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{
                        width: `${Math.max(4, ((tag.usage_count || 0) / maxUsage) * 100)}%`,
                        backgroundColor: tag.color || '#3b82f6',
                        opacity: 0.7,
                      }}
                    />
                  </div>
                  <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal text-muted-foreground tabular-nums">
                    {tag.usage_count || 0}
                  </Badge>
                </div>

                {/* Created by */}
                {tag.created_by_name && (
                  <span className="text-[10px] text-muted-foreground/60 hidden sm:inline truncate max-w-[80px] text-right w-20">
                    {tag.created_by_name}
                  </span>
                )}

                {/* Created date */}
                {tag.created_date && (
                  <span className="text-[10px] text-muted-foreground/50 hidden md:inline w-24 text-right tabular-nums">
                    {(() => { try { return format(new Date(tag.created_date), 'd MMM yyyy'); } catch { return ''; } })()}
                  </span>
                )}

                {/* Delete button */}
                {deleteConfirm === tag.id ? (
                  <div className="flex items-center gap-1 w-8 justify-end">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => deleteTag(tag.id)}
                      className="h-6 text-[10px] px-2"
                    >
                      Yes
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteConfirm(null)}
                      className="h-6 text-[10px] px-1"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(tag.id)}
                    className="p-1 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100 w-8 flex justify-end"
                    title="Delete tag"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


// ================ PREMIUM HEADER ================

function FavoritesHeader({ stats, isLoading }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border bg-gradient-to-br from-background via-background to-muted/30 p-6 sm:p-8">
      {/* Background decoration */}
      <div className="absolute top-0 right-0 w-64 h-64 opacity-[0.03] pointer-events-none">
        <Heart className="w-full h-full" />
      </div>
      <div className="absolute -bottom-8 -left-8 w-32 h-32 rounded-full bg-gradient-to-br from-yellow-200/20 to-transparent pointer-events-none" />
      <div className="absolute top-4 right-4 w-20 h-20 rounded-full bg-gradient-to-br from-red-200/10 to-transparent pointer-events-none" />

      <div className="relative z-10 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-3">
            <div className="fav-heart-beat">
              <Heart className="h-7 w-7 text-red-500 fill-red-500" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight bg-gradient-to-r from-foreground via-foreground to-foreground/60 bg-clip-text text-transparent">
              Favorites
            </h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {isLoading
              ? 'Loading your collection...'
              : `Your curated collection of ${stats.total} starred item${stats.total !== 1 ? 's' : ''}`}
          </p>
        </div>

        {/* Animated stat badges */}
        {!isLoading && stats.total > 0 && (
          <div className="flex flex-wrap gap-2 sm:gap-3">
            <div className="fav-stat-enter flex items-center gap-2 px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-100 dark:border-blue-800" style={{ animationDelay: '0ms' }}>
              <Camera className="h-4 w-4 text-blue-500" />
              <div>
                <span className="text-lg font-bold text-blue-600 dark:text-blue-400 tabular-nums">{stats.files}</span>
                <span className="text-[10px] text-blue-500/70 block leading-none">file{stats.files !== 1 ? 's' : ''}</span>
              </div>
            </div>
            <div className="fav-stat-enter flex items-center gap-2 px-3 py-2 rounded-xl bg-purple-50 dark:bg-purple-900/20 border border-purple-100 dark:border-purple-800" style={{ animationDelay: '80ms' }}>
              <FolderOpen className="h-4 w-4 text-purple-500" />
              <div>
                <span className="text-lg font-bold text-purple-600 dark:text-purple-400 tabular-nums">{stats.projects}</span>
                <span className="text-[10px] text-purple-500/70 block leading-none">project{stats.projects !== 1 ? 's' : ''}</span>
              </div>
            </div>
            <div className="fav-stat-enter flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800" style={{ animationDelay: '160ms' }}>
              <Tag className="h-4 w-4 text-amber-500" />
              <div>
                <span className="text-lg font-bold text-amber-600 dark:text-amber-400 tabular-nums">{stats.tags}</span>
                <span className="text-[10px] text-amber-500/70 block leading-none">tag{stats.tags !== 1 ? 's' : ''}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


// ================ MAIN COMPONENT ================

export default function SocialMedia() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState('favorites');
  const [search, setSearch] = useState(() => searchParams.get('q') || '');
  const [typeFilter, setTypeFilter] = useState(() => {
    const t = searchParams.get('type');
    return t === 'file' || t === 'project' ? t : 'all';
  });
  const [gridSize, setGridSize] = useState('md');
  // URL param pre-filtering: ?tag=hero-shot or ?tag=hero-shot&tag=portfolio
  const [selectedTags, setSelectedTags] = useState(() => {
    const tags = searchParams.getAll('tag');
    return tags.length > 0 ? tags : [];
  });
  const [visibleCards, setVisibleCards] = useState(new Set());
  const gridRef = useRef(null);

  // Load data
  const { data: favorites = [], loading: favoritesLoading } = useEntityList('MediaFavorite', '-created_date', 500);
  const { data: mediaTags = [] } = useEntityList('MediaTag', 'name', 200);
  const { data: auditLogs = [], loading: auditLoading } = useEntityList('AuditLog', '-created_date', 200);

  const tagColorMap = useTagColorMap(mediaTags);

  // Filter audit logs to media_favorite entity type
  const favoriteAuditLogs = useMemo(() => {
    return auditLogs
      .filter(log => log.entity_type === 'media_favorite')
      .slice(0, 20);
  }, [auditLogs]);

  // Tag toggle handler
  const toggleTag = useCallback((tagName) => {
    setSelectedTags(prev =>
      prev.includes(tagName) ? prev.filter(t => t !== tagName) : [...prev, tagName]
    );
  }, []);

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    setSearch('');
    setTypeFilter('all');
    setSelectedTags([]);
  }, []);

  // Sync filter state back to URL so bookmarking/sharing links works
  useEffect(() => {
    const params = new URLSearchParams();
    if (search.trim()) params.set('q', search.trim());
    if (typeFilter !== 'all') params.set('type', typeFilter);
    selectedTags.forEach(t => params.append('tag', t));
    const str = params.toString();
    const current = new URLSearchParams(window.location.search).toString();
    if (str !== current) {
      window.history.replaceState(null, '', str ? `${window.location.pathname}?${str}` : window.location.pathname);
    }
  }, [search, typeFilter, selectedTags]);

  // Unfavorite handler with confirmation
  const handleUnfavorite = useCallback(async (fav) => {
    if (!fav.id) return;
    const displayName = fav.file_name || fav.project_title || 'this item';
    if (!window.confirm(`Remove "${displayName}" from favorites?`)) return;
    try {
      await api.entities.MediaFavorite.delete(fav.id);
      await refetchEntityList('MediaFavorite');
      toast.success('Removed from favorites', {
        description: `"${displayName}" has been unfavorited.`,
        duration: 2500,
      });
    } catch (err) {
      console.error('Failed to unfavorite:', err);
      toast.error('Failed to remove favorite', {
        description: err?.message || 'Something went wrong. Please try again.',
      });
    }
  }, []);

  // Filter favorites
  const filteredFavorites = useMemo(() => {
    return favorites.filter(fav => {
      if (typeFilter === 'file' && !fav.file_path) return false;
      if (typeFilter === 'project' && !fav.project_id) return false;

      if (selectedTags.length > 0) {
        const favTags = fav.tags || [];
        if (!selectedTags.some(t => favTags.includes(t))) return false;
      }

      if (search.trim()) {
        const q = search.toLowerCase();
        const matches = (
          fav.file_name?.toLowerCase().includes(q) ||
          fav.project_title?.toLowerCase().includes(q) ||
          fav.property_address?.toLowerCase().includes(q) ||
          (fav.tags || []).some(t => t.toLowerCase().includes(q))
        );
        if (!matches) return false;
      }

      return true;
    });
  }, [favorites, typeFilter, selectedTags, search]);

  // Stats
  const stats = useMemo(() => {
    const files = favorites.filter(f => f.file_path).length;
    const projects = favorites.filter(f => f.project_id).length;
    const allTags = new Set(favorites.flatMap(f => f.tags || []));
    return { files, projects, tags: allTags.size, total: favorites.length };
  }, [favorites]);

  const hasActiveFilters = search.trim() || typeFilter !== 'all' || selectedTags.length > 0;

  // IntersectionObserver for lazy-loading images
  useEffect(() => {
    if (!gridRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisibleCards(prev => {
          const next = new Set(prev);
          entries.forEach(entry => {
            const id = entry.target.dataset.favId;
            if (!id) return;
            if (entry.isIntersecting) next.add(id);
          });
          if (next.size === prev.size) return prev;
          return next;
        });
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    );

    const cards = gridRef.current.querySelectorAll('[data-fav-id]');
    cards.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [filteredFavorites]);

  // Page title
  useEffect(() => {
    document.title = `Favorites · ${stats.total} items`;
  }, [stats.total]);

  const isLoading = favoritesLoading;

  return (
    <div className="p-4 lg:p-6 space-y-5 max-w-[1600px] mx-auto">

      {/* ---- Premium Header ---- */}
      <FavoritesHeader stats={stats} isLoading={isLoading} />

      {/* ---- Tab bar ---- */}
      <div className="flex items-center gap-1 border-b">
        {[
          { key: 'favorites', label: 'Favorites', icon: Star, count: stats.total },
          { key: 'tags', label: 'Tags', icon: Tag, count: mediaTags.length },
        ].map(({ key, label, icon: TabIcon, count }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={cn(
              "flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
              activeTab === key
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/30"
            )}
          >
            <TabIcon className="h-3.5 w-3.5" />
            {label}
            <Badge variant={activeTab === key ? "default" : "secondary"} className="text-[10px] px-1.5 py-0 h-4 ml-1">
              {count}
            </Badge>
          </button>
        ))}
      </div>

      {/* ---- Tags subtab ---- */}
      {activeTab === 'tags' && <TagManagementTab />}

      {/* ---- Favorites subtab ---- */}
      {activeTab === 'favorites' && (<>

      {/* ---- Filter bar ---- */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search files, projects, addresses, tags..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Tag filter */}
        <TagFilterSelect
          availableTags={mediaTags}
          selectedTags={selectedTags}
          onToggle={toggleTag}
          tagColorMap={tagColorMap}
        />

        {/* Type filter */}
        <div className="flex items-center border rounded-lg overflow-hidden shrink-0">
          {TYPE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                typeFilter === value
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Grid size toggle */}
        <div className="flex items-center border rounded-lg overflow-hidden shrink-0">
          {[
            { key: 'sm', icon: Grid3x3, title: 'Small' },
            { key: 'md', icon: Grid2x2, title: 'Medium' },
            { key: 'lg', icon: LayoutGrid, title: 'Large' },
          ].map(({ key, icon: Icon, title }) => (
            <button
              key={key}
              onClick={() => setGridSize(key)}
              title={title}
              className={cn(
                "p-1.5 transition-colors",
                gridSize === key
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted text-muted-foreground"
              )}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>

        {/* Result count */}
        <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">
          {filteredFavorites.length} result{filteredFavorites.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Active tag filters as removable pills */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] text-muted-foreground mr-1">Filtering:</span>
          {selectedTags.map(tag => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-[11px] gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors pl-1.5"
              onClick={() => toggleTag(tag)}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: tagColorMap[tag] || '#3b82f6' }}
              />
              #{tag}
              <X className="h-2.5 w-2.5" />
            </Badge>
          ))}
          <button
            onClick={() => setSelectedTags([])}
            className="text-[11px] text-red-500 hover:text-red-600 font-medium ml-1 transition-colors"
          >
            Clear all
          </button>
        </div>
      )}

      {/* ---- Grid ---- */}
      {isLoading ? (
        <FavoriteSkeleton gridSize={gridSize} />
      ) : filteredFavorites.length === 0 ? (
        <EmptyFavoritesState
          hasFilters={hasActiveFilters}
          onClearFilters={clearAllFilters}
        />
      ) : (
        <div
          ref={gridRef}
          className={cn("grid fav-grid-transition", GRID_SIZES[gridSize])}
        >
          {filteredFavorites.map((fav, idx) => {
            const favId = fav.id || `${fav.file_path || fav.project_id}-${idx}`;
            const isFile = !!fav.file_path;

            return (
              <div key={favId} data-fav-id={favId}>
                {isFile ? (
                  <FileFavoriteCard
                    favorite={fav}
                    isVisible={visibleCards.has(favId)}
                    tagColorMap={tagColorMap}
                    onUnfavorite={handleUnfavorite}
                    animDelay={Math.min(idx * 40, 400)}
                  />
                ) : (
                  <ProjectFavoriteCard
                    favorite={fav}
                    tagColorMap={tagColorMap}
                    onUnfavorite={handleUnfavorite}
                    animDelay={Math.min(idx * 40, 400)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Activity Timeline ---- */}
      {!isLoading && (
        <div className="space-y-4 pt-6">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Activity className="h-4 w-4 text-primary" />
            </div>
            <h2 className="text-sm font-semibold">Recent Activity</h2>
            {favoriteAuditLogs.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                {favoriteAuditLogs.length}
              </Badge>
            )}
          </div>

          {auditLoading ? (
            <div className="space-y-4 pl-4">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-start gap-4">
                  <Skeleton className="w-8 h-8 rounded-full shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-12 w-full rounded-lg" />
                  </div>
                </div>
              ))}
            </div>
          ) : favoriteAuditLogs.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center py-8 text-center">
                <Activity className="h-6 w-6 text-muted-foreground/30 mb-2" />
                <p className="text-xs text-muted-foreground">
                  No favorite or tag activity recorded yet.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="pl-0">
              {favoriteAuditLogs.map((entry, idx) => (
                <TimelineEntry key={entry.id} entry={entry} index={idx} />
              ))}
            </div>
          )}
        </div>
      )}

      </>)}
    </div>
  );
}

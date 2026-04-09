import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useFavorites } from '@/components/favorites/useFavorites';
import { LRUBlobCache, enqueueFetch, decodeImage } from '@/utils/mediaPerf';
import { downloadFile, preloadAdjacentImages, getVideoStreamUrl } from "@/utils/mediaActions";
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  Camera, Film, FileText, Image as ImageIcon, ExternalLink, Loader2,
  Search, Building2, ChevronDown, ChevronUp, Clock,
  CheckCircle2, Package, Play, Zap, X, ChevronLeft, ChevronRight,
  ArrowRight, Eye, RefreshCw, DollarSign, Timer, AlertTriangle, CreditCard,
  FolderOpen, Download, Map as MapIcon, Video, Folder, Star, Send,
  Inbox, FilterX
} from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import { format, formatDistanceToNow, differenceInDays, differenceInHours, isToday, isYesterday } from 'date-fns';
import FavoriteButton from '@/components/favorites/FavoriteButton';

// ─── CSS-in-JS animations injected once ──────────────────────────────────────
const DELIVERY_STYLES_ID = 'delivery-feed-animations';
if (typeof document !== 'undefined' && !document.getElementById(DELIVERY_STYLES_ID)) {
  const style = document.createElement('style');
  style.id = DELIVERY_STYLES_ID;
  style.textContent = `
    @keyframes df-fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes df-pulse-dot { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.7); } }
    @keyframes df-shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
    @keyframes df-backdropIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes df-imgFadeIn { from { opacity: 0; } to { opacity: 1; } }
    @keyframes df-partial-border { 0%, 100% { border-color: rgba(251, 146, 60, 0.5); } 50% { border-color: rgba(251, 146, 60, 1); } }
    @keyframes df-pill-in { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }

    .df-stat-enter { animation: df-fadeIn 0.4s ease-out both; }
    .df-stat-enter:nth-child(1) { animation-delay: 0.00s; }
    .df-stat-enter:nth-child(2) { animation-delay: 0.06s; }
    .df-stat-enter:nth-child(3) { animation-delay: 0.12s; }
    .df-stat-enter:nth-child(4) { animation-delay: 0.18s; }
    .df-stat-enter:nth-child(5) { animation-delay: 0.24s; }
    .df-stat-enter:nth-child(6) { animation-delay: 0.30s; }

    .df-stat-card {
      position: relative;
      overflow: hidden;
    }
    .df-stat-card::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--df-stat-accent, hsl(var(--muted)));
      opacity: 0.7;
      border-radius: 0 0 2px 2px;
    }

    .df-skeleton-pill {
      background: linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground) / 0.08) 50%, hsl(var(--muted)) 75%);
      background-size: 200% 100%;
      animation: df-shimmer 1.5s ease-in-out infinite;
      border-radius: 9999px;
    }

    .df-pill-enter {
      animation: df-pill-in 0.25s ease-out both;
    }
    .df-pill-enter:nth-child(1) { animation-delay: 0.00s; }
    .df-pill-enter:nth-child(2) { animation-delay: 0.08s; }
    .df-pill-enter:nth-child(3) { animation-delay: 0.16s; }
    .df-pill-enter:nth-child(4) { animation-delay: 0.24s; }

    .df-pulse-dot {
      animation: df-pulse-dot 1.5s ease-in-out infinite;
    }

    .df-partial-card {
      animation: df-partial-border 2.5s ease-in-out infinite;
    }

    .df-lightbox-backdrop {
      animation: df-backdropIn 0.2s ease-out forwards;
    }

    .df-img-loaded {
      animation: df-imgFadeIn 0.3s ease-out forwards;
    }
    .df-img-loading {
      opacity: 0;
    }

    .df-expand-panel {
      display: grid;
      grid-template-rows: 0fr;
      transition: grid-template-rows 0.3s ease-out, opacity 0.3s ease-out;
      opacity: 0;
    }
    .df-expand-panel[data-open="true"] {
      grid-template-rows: 1fr;
      opacity: 1;
    }
    .df-expand-inner {
      overflow: hidden;
    }
  `;
  document.head.appendChild(style);
}

// ─── Proxy image loading (uses shared LRU cache + global concurrency limiter) ─
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
// PERF: Replaced ad-hoc Map + manual eviction with shared LRUBlobCache (max 200)
const imgBlobCache = new LRUBlobCache(200);
const imgPending = new Set();

// PERF: Uses global concurrency limiter + img.decode() before caching
async function fetchProxyImage(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  if (imgBlobCache.has(cacheKey)) return imgBlobCache.get(cacheKey);
  if (imgPending.has(cacheKey)) return null;
  imgPending.add(cacheKey);
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
    if (url) imgBlobCache.set(cacheKey, url);
    return url;
  } catch { return null; }
  finally { imgPending.delete(cacheKey); }
}

const TYPE_CONFIG = {
  image: { label: 'Photos', icon: ImageIcon, color: 'bg-blue-100 text-blue-700' },
  video: { label: 'Video', icon: Film, color: 'bg-purple-100 text-purple-700' },
  document: { label: 'Floorplan', icon: FileText, color: 'bg-amber-100 text-amber-700' },
  // Additional types from tonomo_delivered_files objects
  photos: { label: 'Photos', icon: Camera, color: 'bg-blue-100 text-blue-700' },
  pdf: { label: 'PDF', icon: FileText, color: 'bg-red-100 text-red-700' },
  floorplan: { label: 'Floor Plan', icon: MapIcon, color: 'bg-amber-100 text-amber-700' },
  'floor plan': { label: 'Floor Plan', icon: MapIcon, color: 'bg-amber-100 text-amber-700' },
  drone: { label: 'Drone', icon: Send, color: 'bg-sky-100 text-sky-700' },
};

// Folder-specific icons and colors for the grouped gallery
const FOLDER_STYLE = {
  'sales images': { icon: Camera, color: 'text-blue-600', bg: 'bg-blue-50' },
  'drone images': { icon: Send, color: 'text-sky-600', bg: 'bg-sky-50' },
  'drone': { icon: Send, color: 'text-sky-600', bg: 'bg-sky-50' },
  'floorplan': { icon: FileText, color: 'text-amber-600', bg: 'bg-amber-50' },
  'floor plan': { icon: FileText, color: 'text-amber-600', bg: 'bg-amber-50' },
  'video': { icon: Film, color: 'text-purple-600', bg: 'bg-purple-50' },
  'videos': { icon: Film, color: 'text-purple-600', bg: 'bg-purple-50' },
};

function getFolderStyle(folderName) {
  const lower = (folderName || '').toLowerCase();
  for (const [key, style] of Object.entries(FOLDER_STYLE)) {
    if (lower.includes(key)) return style;
  }
  return { icon: Folder, color: 'text-gray-600', bg: 'bg-gray-50' };
}

function classifyUrl(url) {
  if (!url || typeof url !== 'string') return 'image';
  const lower = url.toLowerCase();
  if (['.mp4', '.mov', '.avi', '.webm'].some(e => lower.includes(e))) return 'video';
  if (['.pdf', '.ai', '.eps'].some(e => lower.includes(e))) return 'document';
  return 'image';
}

/** Normalize a tonomo_delivered_files type string to a TYPE_CONFIG key */
function normalizeDeliveredType(typeStr) {
  if (!typeStr) return 'photos';
  const lower = typeStr.toLowerCase().trim();
  if (lower === 'photos' || lower === 'photo') return 'photos';
  if (lower === 'pdf') return 'pdf';
  if (lower === 'video' || lower === 'videos') return 'video';
  if (lower === 'floor plan' || lower === 'floorplan') return 'floorplan';
  if (lower === 'drone' || lower.includes('drone')) return 'drone';
  return 'photos';
}

/** Get the best link for a delivered file object (prefers Firebase PDF URLs) */
function getDeliveredFileUrl(item) {
  if (!item) return null;
  if (item.pdfUrl) return item.pdfUrl;
  return item.url || null;
}

/** Parse delivered_files safely */
function parseDeliveredFiles(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function projectRevenue(p) {
  return p.tonomo_invoice_amount ?? p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
}

function projectTitle(p) {
  return p.title || p.property_address || p.tonomo_address || p.tonomo_order_name || 'Untitled project';
}

function deliveredFileCount(p) {
  return parseDeliveredFiles(p.tonomo_delivered_files).length;
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  try {
    const d = new Date(fixTimestamp(dateStr));
    if (isToday(d)) return formatDistanceToNow(d, { addSuffix: true });
    if (isYesterday(d)) return 'Yesterday ' + format(d, 'h:mm a');
    if (differenceInDays(new Date(), d) < 7) return format(d, 'EEEE h:mm a');
    return format(d, 'd MMM yyyy h:mm a');
  } catch { return dateStr; }
}

function fmtRevenue(amount) {
  if (amount == null || amount === 0) return '$0';
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `$${Math.round(amount).toLocaleString()}`;
}

function fmtFileSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Build a Dropbox preview URL from shared link + filename.
 *  Preserves rlkey so the link works without Dropbox auth. */
function buildDropboxPreviewUrl(shareUrl, filePath) {
  if (!shareUrl) return '#';
  if (!filePath) return shareUrl;
  const fileName = filePath.split('/').pop();
  const base = shareUrl.split('?')[0];
  const rlMatch = shareUrl.match(/rlkey=([^&]+)/);
  const rlPart = rlMatch ? `&rlkey=${rlMatch[1]}` : '';
  return `${base}?preview=${encodeURIComponent(fileName)}${rlPart}`;
}

// ─── Thumbnail fetching ──────────────────────────────────────────────────────
const thumbCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 3;

function getCachedResult(key) {
  const entry = thumbCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { thumbCache.delete(key); return null; }
  return entry.data;
}
function setCachedResult(key, data) { thumbCache.set(key, { data, timestamp: Date.now() }); }

let activeCount = 0;
const queue = [];
function processThumbnailQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    activeCount++;
    job().finally(() => { activeCount--; processThumbnailQueue(); });
  }
}

// ─── Lazy thumbnail fetching (on-demand per file card) ──────────────────────
const THUMB_MAX_CONCURRENT = 8;
let thumbActiveCount = 0;
const thumbQueue = [];

function processThumbQueue() {
  while (thumbActiveCount < THUMB_MAX_CONCURRENT && thumbQueue.length > 0) {
    const job = thumbQueue.shift();
    thumbActiveCount++;
    job().finally(() => { thumbActiveCount--; processThumbQueue(); });
  }
}

/**
 * fetchSingleThumbnail is deprecated -- the edge function does not have a
 * 'get_thumbnail' action (only 'thumb', 'proxy', 'stream_url').  Proxy-based
 * thumbnails in LazyThumbFileCard/ProxyFileCard handle this correctly.
 * Kept as a no-op to avoid breaking useLazyThumbnail callers.
 */
function fetchSingleThumbnail(_shareUrl, _filePath) {
  return Promise.resolve(null);
}

/**
 * Hook: lazily fetches a thumbnail when the element is visible in the viewport.
 * Only fetches for image-type files that have no existing thumbnail.
 * Returns { ref, thumbnail, loading }.
 */
function useLazyThumbnail(file, shareUrl, folderName) {
  const elRef = useRef(null);
  const [thumbnail, setThumbnail] = useState(file.thumbnail || null);
  const [loading, setLoading] = useState(false);
  const fetchedRef = useRef(false);

  const shouldFetch = !thumbnail && file.type === 'image' && !!shareUrl;

  useEffect(() => {
    if (!shouldFetch || fetchedRef.current) return;
    const el = elRef.current;
    if (!el) return;

    // Check if already cached
    const filePath = file.path || `/${folderName}/${file.name}`;
    const cacheKey = `thumb::${shareUrl}::${filePath}`;
    const cached = getCachedResult(cacheKey);
    if (cached !== null) {
      if (cached) setThumbnail(cached);
      fetchedRef.current = true;
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || fetchedRef.current) return;
        fetchedRef.current = true;
        observer.disconnect();
        setLoading(true);
        fetchSingleThumbnail(shareUrl, filePath).then((thumb) => {
          if (thumb) setThumbnail(thumb);
          setLoading(false);
        });
      },
      { rootMargin: '200px' }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [shouldFetch, file.path, file.name, shareUrl, folderName]);

  return { ref: elRef, thumbnail, loading };
}

let dropboxFailCount = 0;

/**
 * Fetch media feed for a delivery.
 * Returns either:
 *   { folders: [{ name, files: [...] }] }  -- grouped (shared link mode)
 *   { files: [...] }                        -- flat (direct path mode)
 */
async function fetchMediaFeed(pathOrUrl, isShareUrl = false, basePath = null) {
  const cacheKey = pathOrUrl;
  const cached = getCachedResult(cacheKey);
  // Only return cached result if it had actual content (don't cache failures)
  if (cached && cached.folders?.length > 0) return cached;
  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);
  const promise = new Promise((resolve) => {
    queue.push(async () => {
      try {
        const params = isShareUrl ? { share_url: pathOrUrl } : { path: pathOrUrl };
        if (basePath) params.base_path = basePath;
        const res = await api.functions.invoke('getDeliveryMediaFeed', params);
        // invokeFunction wraps response: { data: <edge_fn_body> }
        const data = res?.data || res;

        // Check for error in response body
        if (data?.error) {
          const errMsg = typeof data.error === 'object' ? (data.error.message || data.error.code || JSON.stringify(data.error)) : String(data.error);
          console.error('[DeliveryFeed] Dropbox edge function error:', errMsg, '| URL/path:', pathOrUrl);
          dropboxFailCount++;
          resolve({ folders: [], _error: errMsg });
          return;
        }

        // Normalize response: if it has folders, use grouped; else wrap files in a single group
        let result;
        if (data?.folders && Array.isArray(data.folders)) {
          result = { folders: data.folders };
        } else if (data?.files && Array.isArray(data.files)) {
          result = { folders: [{ name: 'All Files', files: data.files }] };
        } else {
          console.error('[DeliveryFeed] Unexpected response shape from getDeliveryMediaFeed:', JSON.stringify(data)?.slice(0, 200), '| URL/path:', pathOrUrl);
          result = { folders: [] };
          dropboxFailCount++;
        }

        // Attach fetch timestamp (from edge function or local)
        result._fetched_at = data?.fetched_at || new Date().toISOString();

        // Only cache successful results with actual content
        if (result.folders.length > 0) {
          setCachedResult(cacheKey, result);
        }
        resolve(result);
      } catch (err) {
        dropboxFailCount++;
        console.error('[DeliveryFeed] Dropbox fetch failed:', err?.message, '| URL/path:', pathOrUrl);
        resolve({ folders: [], _error: err?.message });
      }
    });
    processThumbnailQueue();
  });
  pendingRequests.set(cacheKey, promise);
  promise.finally(() => pendingRequests.delete(cacheKey));
  return promise;
}

// ─── SkeletonGrid ───────────────────────────────────────────────────────────
function SkeletonGrid() {
  return (
    <div className="space-y-4 animate-pulse">
      {[1, 2].map(g => (
        <div key={g}>
          <div className="h-4 w-32 bg-muted rounded mb-3" />
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="aspect-[4/3] rounded-lg bg-muted" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── LightboxImage: loads proxy blob for a single lightbox slide ─────────────
function LightboxImage({ file, tonomoBase, shareUrl }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const isImage = file.type === 'image';
  const isVideo = file.type === 'video';
  const proxyPath = tonomoBase && file.path
    ? tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path)
    : null;

  useEffect(() => {
    if ((!isImage && !isVideo) || !proxyPath) return;
    // Show thumbnail immediately if cached
    const thumbCached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (thumbCached && !blobUrl) setBlobUrl(thumbCached);
    // For videos: use streaming URL (instant, browser handles buffering)
    if (isVideo) {
      setBlobUrl(getVideoStreamUrl(proxyPath));
      setLoading(false);
      return;
    }
    // For images: fetch full-res via proxy
    if (!started.current) {
      started.current = true;
      setLoading(true);
      fetchProxyImage(proxyPath, 'proxy').then(url => {
        if (!mountedRef.current) return;
        if (url) setBlobUrl(url);
        setLoading(false);
      });
    }
  }, [isImage, isVideo, proxyPath]);

  // Reset when file changes
  useEffect(() => {
    started.current = false;
    const cached = proxyPath
      ? (imgBlobCache.get(`proxy::${proxyPath}`) || imgBlobCache.get(`thumb::${proxyPath}`))
      : null;
    setBlobUrl(cached || null);
    setLoading(false);
  }, [file.path, proxyPath]);

  const imgSrc = blobUrl || (file.thumbnail ? `data:image/jpeg;base64,${file.thumbnail}` : null);

  // Video playback
  if (isVideo) {
    if (loading) {
      return (
        <div className="flex flex-col items-center gap-4 text-white/50">
          <div className="relative">
            <Film className="h-12 w-12 text-white/20" />
            <Loader2 className="h-6 w-6 animate-spin absolute -bottom-1 -right-1 text-white/60" />
          </div>
          <p className="text-sm font-medium">Loading video...</p>
          <p className="text-xs text-white/30">{file.name}</p>
        </div>
      );
    }
    if (blobUrl) {
      return (
        <video
          src={blobUrl}
          controls
          autoPlay
          playsInline
          controlsList="nodownload"
          className="max-w-full max-h-full rounded-lg shadow-2xl"
          style={{ maxHeight: 'calc(100vh - 140px)' }}
        />
      );
    }
    return (
      <div className="flex flex-col items-center gap-3 text-white/60">
        <Film className="h-16 w-16 text-white/20" />
        <p className="text-sm font-medium">{file.name}</p>
        <p className="text-xs text-white/30">Video could not be loaded</p>
      </div>
    );
  }

  // Image display — show thumb immediately with full-res upgrade indicator
  if (isImage && imgSrc) {
    const thumbOnly = loading && file.thumbnail; // showing thumb while loading full-res
    return (
      <div className="relative">
        <img
          src={imgSrc}
          alt={file.name}
          className={cn("df-img-loaded max-w-full max-h-full object-contain p-4 rounded-lg", thumbOnly && "blur-[1px] opacity-80")}
          style={{ maxHeight: 'calc(100vh - 140px)' }}
        />
        {loading && (
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-black/60 backdrop-blur-sm text-white/80 text-xs px-3 py-1.5 rounded-full pointer-events-none">
            <Loader2 className="h-3 w-3 animate-spin" />
            Loading full resolution...
          </div>
        )}
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex flex-col items-center gap-4 text-white/50">
        <div className="relative">
          <ImageIcon className="h-12 w-12 text-white/20" />
          <Loader2 className="h-6 w-6 animate-spin absolute -bottom-1 -right-1 text-white/60" />
        </div>
        <p className="text-sm font-medium">Loading image...</p>
        <p className="text-xs text-white/30">{file.name}</p>
      </div>
    );
  }

  // Document / other — show placeholder with Open in Dropbox
  return (
    <div className="flex flex-col items-center gap-3 text-white/60">
      <FileText className="h-16 w-16" />
      <p className="text-sm">{file.name}</p>
      {shareUrl && (
        <button
          onClick={() => window.open(shareUrl, '_blank', 'noopener,noreferrer')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs">
          <ExternalLink className="h-3.5 w-3.5" /> Open in Dropbox
        </button>
      )}
    </div>
  );
}

// ─── LightboxThumb: filmstrip thumbnail with proxy support ──────────────────
function LightboxThumb({ file, tonomoBase }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const started = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const canThumb = file.type === 'image' || file.type === 'video' || file.type === 'document';

  useEffect(() => {
    if (!canThumb || !tonomoBase || started.current) return;
    const proxyPath = tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path);
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    fetchProxyImage(proxyPath).then(url => {
      if (!mountedRef.current) return;
      if (url) setBlobUrl(url);
    });
  }, [canThumb, tonomoBase, file.path]);

  const imgSrc = blobUrl || (file.thumbnail ? `data:image/jpeg;base64,${file.thumbnail}` : null);

  if (imgSrc) return <img src={imgSrc} alt="" className="w-full h-full object-cover" />;
  return (
    <div className="w-full h-full bg-white/10 flex items-center justify-center">
      {file.type === 'video' ? <Film className="h-3 w-3 text-white/40" /> : <FileText className="h-3 w-3 text-white/40" />}
    </div>
  );
}

// ─── MiniLightbox (fullscreen image/video viewer) ───────────────────────────
function MiniLightbox({ files, initialIndex, onClose, shareUrl, project }) {
  const [index, setIndex] = useState(initialIndex);
  const file = files[index];
  const tonomoBase = project?.tonomo_deliverable_path;

  // Lock body scroll while lightbox is open
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  // Predictive preloading: preload next 2 + previous 1 full-res images
  useEffect(() => {
    if (!tonomoBase || files.length === 0) return;
    preloadAdjacentImages(
      files, index,
      (f) => tonomoBase + (f.path?.startsWith('/') ? f.path : '/' + f.path),
      fetchProxyImage,
      imgBlobCache,
      (path, mode) => `${mode}::${path}`,
    );
  }, [index, files.length, tonomoBase]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight') setIndex(i => Math.min(i + 1, files.length - 1));
      if (e.key === 'ArrowLeft') setIndex(i => Math.max(i - 1, 0));
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [files.length, onClose]);
  if (!file) return null;
  // Use shareUrl directly (per-project Tonomo link) — always works
  const dropboxUrl = shareUrl || null;
  const currentProxyPath = tonomoBase && file.path
    ? tonomoBase + (file.path.startsWith('/') ? file.path : '/' + file.path)
    : null;
  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col df-lightbox-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label="Media lightbox">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 text-white border-b border-white/10" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-medium truncate max-w-md">{file.name}</span>
          {file.size > 0 && <span className="text-xs text-white/40">{fmtFileSize(file.size)}</span>}
          <span className="text-xs text-white/40 tabular-nums">{index + 1} / {files.length}</span>
        </div>
        <div className="flex items-center gap-1">
          {currentProxyPath && (
            <button onClick={() => downloadFile(currentProxyPath, file.name)} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" title={`Download ${file.name}`} aria-label={`Download ${file.name}`}>
              <Download className="h-4 w-4" />
            </button>
          )}
          {dropboxUrl && (
            <button onClick={() => window.open(dropboxUrl, '_blank', 'noopener,noreferrer')} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" title="Open in Dropbox" aria-label="Open in Dropbox">
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" aria-label="Close lightbox">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 px-16" onClick={e => e.stopPropagation()}>
        {/* Nav arrows */}
        {index > 0 && (
          <button onClick={() => setIndex(i => i - 1)} className="absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-black/60 hover:bg-black/80 rounded-full text-white transition-all hover:scale-105 z-10 backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" aria-label="Previous image">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < files.length - 1 && (
          <button onClick={() => setIndex(i => i + 1)} className="absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-black/60 hover:bg-black/80 rounded-full text-white transition-all hover:scale-105 z-10 backdrop-blur-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40" aria-label="Next image">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
        <LightboxImage key={`${file.path}-${index}`} file={file} tonomoBase={tonomoBase} shareUrl={shareUrl} />
      </div>

      {/* Filmstrip */}
      <div className="flex gap-1.5 px-4 py-3 overflow-x-auto justify-center border-t border-white/10" onClick={e => e.stopPropagation()}>
        {files.slice(0, 40).map((f, i) => (
          <button key={f.path || i} onClick={() => setIndex(i)} className={cn('shrink-0 w-14 h-10 rounded overflow-hidden border-2 transition-all duration-150', i === index ? 'border-white ring-1 ring-white/50 scale-105' : 'border-transparent opacity-50 hover:opacity-90')} aria-label={`View ${f.name}`}>
            <LightboxThumb file={f} tonomoBase={tonomoBase} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── LazyThumbFileCard: a single file card with on-demand thumbnail loading ──
function LazyThumbFileCard({ file, index, folder, shareUrl, onOpenLightbox, project, getTagsForFile }) {
  const { ref: cardRef, thumbnail, loading } = useLazyThumbnail(file, shareUrl, folder.name);
  const [blobUrl, setBlobUrl] = useState(null);
  const [proxyLoading, setProxyLoading] = useState(false);
  const proxyStarted = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const isImage = file.type === 'image';
  const isVideo = file.type === 'video';
  const isDoc = file.type === 'document';
  const previewUrl = buildDropboxPreviewUrl(shareUrl, file.path);
  const cfg = TYPE_CONFIG[file.type] || TYPE_CONFIG.image;
  const Icon = cfg.icon;

  // Proxy-based thumbnail loading (real Dropbox thumbnails for images, videos, and documents)
  const canThumb = isImage || isVideo || isDoc;
  const tonomoBase = project?.tonomo_deliverable_path;
  useEffect(() => {
    if (!canThumb || !tonomoBase || proxyStarted.current) return;
    const proxyPath = tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path);
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    proxyStarted.current = true;
    setProxyLoading(true);
    fetchProxyImage(proxyPath).then(url => {
      if (!mountedRef.current) return;
      if (url) setBlobUrl(url);
      setProxyLoading(false);
    });
  }, [canThumb, tonomoBase, file.path]);

  const hasVisual = blobUrl || thumbnail || file.thumbnail;
  const imgSrc = blobUrl || (thumbnail ? `data:image/jpeg;base64,${thumbnail}` : file.thumbnail ? `data:image/jpeg;base64,${file.thumbnail}` : null);
  const isLoading = proxyLoading || loading;
  const uploadTime = file.uploaded_at ? relativeTime(file.uploaded_at) : null;

  return (
    <button
      ref={cardRef}
      role="listitem"
      onClick={() => {
        onOpenLightbox(folder.files, index);
      }}
      className="group relative aspect-[4/3] rounded-lg overflow-hidden bg-muted border border-border/30 hover:ring-2 hover:ring-primary/30 transition-all focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
      title={file.name}
      aria-label={`View ${file.name}${file.size > 0 ? ` (${fmtFileSize(file.size)})` : ''}`}
    >
      {hasVisual ? (
        <img
          src={imgSrc}
          alt={file.name}
          className="df-img-loading w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
          loading="lazy"
          onLoad={(e) => { e.target.classList.remove('df-img-loading'); e.target.classList.add('df-img-loaded'); }}
        />
      ) : isLoading ? (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
          <Loader2 className="h-5 w-5 text-muted-foreground/30 animate-spin" />
        </div>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-1.5">
          <Icon className="h-8 w-8 text-muted-foreground/30" />
          <span className="text-[9px] text-muted-foreground/50 px-1 truncate max-w-full">{file.ext?.toUpperCase()}</span>
        </div>
      )}

      {/* Video play overlay */}
      {isVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="bg-black/40 rounded-full p-2.5 group-hover:bg-black/60 transition-colors backdrop-blur-[2px]">
            <Play className="h-4 w-4 text-white fill-white" />
          </div>
        </div>
      )}

      {/* Document badge overlay */}
      {isDoc && (
        <div className="absolute top-1.5 right-1.5">
          <Badge className="text-[8px] bg-amber-500/80 text-white border-0 px-1 py-0">{file.ext?.toUpperCase()}</Badge>
        </div>
      )}

      {/* Tag pills at bottom-left */}
      {(() => {
        const fullPath = tonomoBase && file.path
          ? tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path)
          : null;
        const tags = getTagsForFile ? getTagsForFile(fullPath) : [];
        if (!tags.length) return null;
        return (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 pointer-events-none z-10">
            {tags.slice(0, 2).map(tag => (
              <span key={tag.name} className="text-[8px] px-1 py-0.5 rounded-full text-white backdrop-blur-sm" style={{ backgroundColor: `${tag.color}cc` }}>
                #{tag.name}
              </span>
            ))}
            {tags.length > 2 && <span className="text-[8px] text-white/70">+{tags.length - 2}</span>}
          </div>
        );
      })()}

      {/* Hover filename overlay */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 pt-6 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <p className="text-[10px] text-white font-medium truncate">{file.name}</p>
        <div className="flex items-center gap-1.5 text-[8px] text-white/60 mt-0.5">
          {file.size > 0 && <span>{fmtFileSize(file.size)}</span>}
          {uploadTime && (
            <>
              <span className="text-white/30">|</span>
              <Clock className="h-2 w-2 opacity-60" />
              <span>{uploadTime}</span>
            </>
          )}
        </div>
      </div>

      {/* Hover actions top-right */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {tonomoBase && file.path && (
          <FavoriteButton
            filePath={tonomoBase + (file.path.startsWith('/') ? file.path : '/' + file.path)}
            fileName={file.name}
            fileType={file.type}
            tonomoBasePath={tonomoBase}
            propertyAddress={project?.property_address || project?.title}
            size="sm"
            className="bg-black/40 hover:bg-black/60 rounded-full p-1 text-white backdrop-blur-sm"
          />
        )}
        {tonomoBase && file.path && (
          <button
            onClick={(e) => { e.stopPropagation(); downloadFile(tonomoBase + (file.path.startsWith('/') ? file.path : '/' + file.path), file.name); }}
            className="bg-black/40 hover:bg-black/60 rounded-full p-1 text-white backdrop-blur-sm"
            title={`Download ${file.name}`}
          >
            <Download className="h-3 w-3" />
          </button>
        )}
      </div>
    </button>
  );
}

// ─── ProxyFileCard: inline file card with proxy image support ───────────────
function ProxyFileCard({ file, project, getTagsForFile }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const canThumb = file.type === 'image' || file.type === 'video' || file.type === 'document';
  const tonomoBase = project?.tonomo_deliverable_path;

  useEffect(() => {
    if (!canThumb || !tonomoBase || started.current) return;
    const proxyPath = tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path);
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    setLoading(true);
    fetchProxyImage(proxyPath).then(url => {
      if (!mountedRef.current) return;
      if (url) setBlobUrl(url);
      setLoading(false);
    });
  }, [canThumb, tonomoBase, file.path]);

  const imgSrc = blobUrl || (file.thumbnail ? `data:image/jpeg;base64,${file.thumbnail}` : null);
  const uploadTime = file.uploaded_at ? relativeTime(file.uploaded_at) : null;
  const cfg = TYPE_CONFIG[file.type] || TYPE_CONFIG.image;
  const Icon = cfg.icon;

  return (
    <a href={file.preview_url || file.url || '#'} target="_blank" rel="noopener noreferrer"
      className="aspect-[4/3] rounded-lg border overflow-hidden bg-muted/50 hover:shadow-md transition-shadow flex items-center justify-center group relative">
      {imgSrc ? (
        <img src={imgSrc} alt={file.name} className="df-img-loading w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" loading="lazy" onLoad={(e) => { e.target.classList.remove('df-img-loading'); e.target.classList.add('df-img-loaded'); }} />
      ) : loading ? (
        <div className="w-full h-full flex items-center justify-center">
          <Loader2 className="h-5 w-5 text-muted-foreground/30 animate-spin" />
        </div>
      ) : (
        <div className="text-center p-2">
          <Icon className="h-6 w-6 mx-auto text-muted-foreground/40 mb-1" />
          <p className="text-[9px] text-muted-foreground truncate">{file.name}</p>
        </div>
      )}
      {file.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/40 rounded-full p-2.5 backdrop-blur-[2px]"><Play className="h-4 w-4 text-white fill-white" /></div>
        </div>
      )}
      {/* Tag pills at bottom-left */}
      {(() => {
        const fullPath = tonomoBase && file.path
          ? tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path)
          : null;
        const tags = getTagsForFile ? getTagsForFile(fullPath) : [];
        if (!tags.length) return null;
        return (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-0.5 pointer-events-none z-10">
            {tags.slice(0, 2).map(tag => (
              <span key={tag.name} className="text-[8px] px-1 py-0.5 rounded-full text-white backdrop-blur-sm" style={{ backgroundColor: `${tag.color}cc` }}>
                #{tag.name}
              </span>
            ))}
            {tags.length > 2 && <span className="text-[8px] text-white/70">+{tags.length - 2}</span>}
          </div>
        );
      })()}
      {/* Hover actions top-right */}
      {tonomoBase && file.path && (
        <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
          <FavoriteButton
            filePath={tonomoBase + (file.path.startsWith('/') ? file.path : '/' + file.path)}
            fileName={file.name}
            fileType={file.type}
            tonomoBasePath={tonomoBase}
            propertyAddress={project?.property_address || project?.title}
            size="sm"
            className="bg-black/40 hover:bg-black/60 rounded-full p-1 text-white backdrop-blur-sm"
          />
          <button
            onClick={(e) => { e.stopPropagation(); downloadFile(tonomoBase + (file.path.startsWith('/') ? file.path : '/' + file.path), file.name); }}
            className="bg-black/40 hover:bg-black/60 rounded-full p-1 text-white backdrop-blur-sm"
            title={`Download ${file.name}`}
          >
            <Download className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1.5 opacity-0 group-hover:opacity-100 transition-colors">
        <p className="text-white text-[9px] truncate">{file.name}</p>
        <div className="flex items-center gap-1.5 text-[7px] text-white/60">
          {file.size > 0 && <span>{fmtFileSize(file.size)}</span>}
          {uploadTime && (
            <>
              <span className="text-white/30">|</span>
              <Clock className="h-2 w-2 opacity-60" />
              <span>{uploadTime}</span>
            </>
          )}
        </div>
      </div>
    </a>
  );
}

// ─── FolderGallery: renders a subfolder's files as a thumbnail grid ─────────
function FolderGallery({ folder, shareUrl, onOpenLightbox, project, getTagsForFile }) {
  const style = getFolderStyle(folder.name);
  const FolderIcon = style.icon;
  const totalSize = folder.files.reduce((s, f) => s + (f.size || 0), 0);
  const imageCount = folder.files.filter(f => f.type === 'image').length;
  const videoCount = folder.files.filter(f => f.type === 'video').length;
  const docCount = folder.files.filter(f => f.type === 'document').length;

  return (
    <div>
      {/* Subfolder heading */}
      <div className="flex items-center gap-2 mb-2">
        <div className={cn('w-6 h-6 rounded flex items-center justify-center', style.bg)}>
          <FolderIcon className={cn('h-3.5 w-3.5', style.color)} />
        </div>
        <span className="text-sm font-semibold">{folder.name}</span>
        <span className="text-xs text-muted-foreground">
          {folder.files.length} file{folder.files.length !== 1 ? 's' : ''}
        </span>
        {totalSize > 0 && (
          <span className="text-[10px] text-muted-foreground/60">{fmtFileSize(totalSize)}</span>
        )}
        <div className="flex-1" />
        <div className="flex gap-1.5">
          {imageCount > 0 && <Badge className="text-[10px] bg-blue-50 text-blue-600 border-blue-200">{imageCount} photos</Badge>}
          {videoCount > 0 && <Badge className="text-[10px] bg-purple-50 text-purple-600 border-purple-200">{videoCount} video</Badge>}
          {docCount > 0 && <Badge className="text-[10px] bg-amber-50 text-amber-600 border-amber-200">{docCount} doc</Badge>}
        </div>
      </div>

      {/* Thumbnail grid */}
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2" role="list" aria-label={`${folder.name} gallery`}>
        {folder.files.map((file, i) => (
          <LazyThumbFileCard
            key={file.path || i}
            file={file}
            index={i}
            folder={folder}
            shareUrl={shareUrl}
            onOpenLightbox={onOpenLightbox}
            project={project}
            getTagsForFile={getTagsForFile}
          />
        ))}
      </div>
    </div>
  );
}

// All stages that appear in the delivery feed
const ALL_DELIVERY_STAGES = ['ready_for_partial', 'in_revision', 'delivered'];

/**
 * Primary delivery state (mutually exclusive):
 * - 'delivered': has tonomo_delivered_at (official Tonomo completion)
 * - 'partial': has files in Dropbox but NO tonomo_delivered_at
 */
function getPrimaryState(project) {
  return project.tonomo_delivered_at ? 'delivered' : 'partial';
}

// ─── DeliveryCard ────────────────────────────────────────────────────────────
function DeliveryCard({ project, isNew, onFileCountKnown, getTagsForFile, newestFileDateMap, projectRevisions }) {
  const [expanded, setExpanded] = useState(false);
  const [mediaResult, setMediaResult] = useState(null); // { folders: [...] } or null
  const [flatFiles, setFlatFiles] = useState([]); // backward compat for flat response
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const hasFetchedRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const primaryState = getPrimaryState(project); // 'delivered' | 'partial'
  const isPartial = primaryState === 'partial';
  const isDelivered = primaryState === 'delivered';

  // Secondary: request badge from project_revisions
  const revData = projectRevisions || { active: [], completed: [] };
  const hasActiveRequest = revData.active.length > 0;
  const hasCompletedRequest = revData.completed.length > 0;
  const hasAnyRequest = hasActiveRequest || hasCompletedRequest;
  const deliveredAt = project.tonomo_delivered_at || project.updated_date || project.created_date;
  const deliverableLink = project.tonomo_deliverable_link;
  const deliverablePath = project.tonomo_deliverable_path;
  const deliveredFiles = useMemo(() => parseDeliveredFiles(project.tonomo_delivered_files), [project.tonomo_delivered_files]);
  const hasDeliveredFiles = deliveredFiles.length > 0;
  const value = projectRevenue(project);
  const isPaid = project.tonomo_payment_status === 'paid';
  const packageName = project.tonomo_package;

  const turnaroundHrs = useMemo(() => {
    if (!project.shoot_date || !project.tonomo_delivered_at) return null;
    try {
      const shoot = new Date(fixTimestamp(project.shoot_date));
      const delivered = new Date(fixTimestamp(project.tonomo_delivered_at));
      const hrs = differenceInHours(delivered, shoot);
      return hrs > 0 ? hrs : null;
    } catch { return null; }
  }, [project.shoot_date, project.tonomo_delivered_at]);

  // Request turnaround: time from request creation to completion (for completed requests)
  const requestTurnaroundHrs = useMemo(() => {
    if (!hasCompletedRequest) return null;
    // Use the most recently completed request
    const sorted = [...revData.completed].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
    const latest = sorted[0];
    if (!latest?.requested_date || !latest?.updated_at) return null;
    try {
      const requested = new Date(fixTimestamp(latest.requested_date));
      const completed = new Date(fixTimestamp(latest.updated_at));
      const hrs = differenceInHours(completed, requested);
      return hrs > 0 ? hrs : null;
    } catch { return null; }
  }, [hasCompletedRequest, revData.completed]);

  // Determine Dropbox source -- always try Dropbox API when link exists (shows individual files)
  const dropboxSource = deliverableLink || deliverablePath || null;
  const isShareUrl = !!deliverableLink;

  // Eager fetch: scan Dropbox immediately for ALL cards with a link (not just on expand)
  // This lets us detect empty folders and report file counts to parent
  useEffect(() => {
    if (!dropboxSource || hasFetchedRef.current) return;
    hasFetchedRef.current = true;
    setLoadingMedia(true);
    fetchMediaFeed(dropboxSource, isShareUrl, deliverablePath).then(result => {
      if (!mountedRef.current) return;
      setMediaResult(result);
      const allFiles = (result?.folders || []).flatMap(f => f.files);
      setFlatFiles(allFiles);
      setLoadingMedia(false);
      // Report file count + newest file timestamp to parent
      const newestUpload = allFiles.reduce((latest, f) => {
        if (!f.uploaded_at) return latest;
        return !latest || f.uploaded_at > latest ? f.uploaded_at : latest;
      }, null);
      if (onFileCountKnown) onFileCountKnown(project.id, allFiles.length, newestUpload);
    });
  }, [dropboxSource, isShareUrl, deliverablePath]);

  const handleRefresh = async (e) => {
    e.stopPropagation();
    if (!dropboxSource) return;
    setLoadingMedia(true);
    thumbCache.delete(dropboxSource);
    pendingRequests.delete(dropboxSource);
    // Clear stale image blob cache entries for this project's files
    if (deliverablePath) {
      for (const key of [...imgBlobCache.keys()]) {
        if (key.includes(deliverablePath)) {
          URL.revokeObjectURL(imgBlobCache.get(key));
          imgBlobCache.delete(key);
        }
      }
    }
    const result = await fetchMediaFeed(dropboxSource, isShareUrl, deliverablePath);
    if (!mountedRef.current) return;
    setMediaResult(result);
    const refreshedFiles = (result?.folders || []).flatMap(f => f.files);
    setFlatFiles(refreshedFiles);
    setLoadingMedia(false);
    // Re-report file count so parent can un-hide cards that gained files
    if (onFileCountKnown) onFileCountKnown(project.id, refreshedFiles.length);
  };

  // Compute total file count and type counts for the badges
  const { totalFileCount, fileTypeCounts } = useMemo(() => {
    const c = { image: 0, video: 0, document: 0, photos: 0, pdf: 0, floorplan: 0, drone: 0 };
    if (hasDeliveredFiles) {
      deliveredFiles.forEach(item => {
        if (typeof item === 'object' && item !== null) {
          const typeKey = normalizeDeliveredType(item.type);
          if (c[typeKey] !== undefined) c[typeKey]++;
          else c.photos++;
        } else if (typeof item === 'string') {
          c[classifyUrl(item)]++;
        }
      });
    } else if (flatFiles.length > 0) {
      flatFiles.forEach(f => { if (c[f.type] !== undefined) c[f.type]++; });
    }
    const total = hasDeliveredFiles ? deliveredFiles.length : flatFiles.length;
    return { totalFileCount: total, fileTypeCounts: c };
  }, [flatFiles, deliveredFiles, hasDeliveredFiles]);

  const folderCount = mediaResult?.folders?.length || 0;
  const allGalleryFiles = useMemo(() => (mediaResult?.folders || []).flatMap(f => f.files), [mediaResult]);

  return (
    <div role="article" aria-label={projectTitle(project)} className={cn(
      'border rounded-xl overflow-hidden transition-all duration-200 bg-card hover:shadow-lg hover:-translate-y-[1px]',
      'border-l-[3px]',
      isPartial ? 'border-l-orange-400 df-partial-card' : 'border-l-emerald-400',
      isNew && 'ring-2 ring-green-300 ring-opacity-50',
      expanded && 'shadow-md'
    )}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset rounded-xl"
        aria-expanded={expanded}
        aria-controls={`delivery-panel-${project.id}`}
        aria-label={`${projectTitle(project)} delivery (${primaryState}) \u2014 ${expanded ? 'collapse' : 'expand'} details`}
      >
        <div className="flex items-start gap-3 p-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5',
            isPartial ? 'bg-orange-100' : 'bg-emerald-100'
          )}>
            {isPartial
              ? <Loader2 className="h-5 w-5 text-orange-600 animate-spin" />
              : <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            }
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[15px] leading-tight">{projectTitle(project)}</span>
              {isNew && <Badge className="text-[9px] bg-green-100 text-green-700 border-green-200">NEW</Badge>}
              {/* Primary state badge */}
              {isPartial ? (
                <Badge className="text-[9px] bg-orange-100 text-orange-700 border-orange-200 gap-1.5">
                  <span className="df-pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-orange-500" />
                  Partially Delivered
                </Badge>
              ) : (
                <Badge className="text-[9px] bg-emerald-100 text-emerald-700 border-emerald-200">
                  <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />
                  Delivered
                </Badge>
              )}
              {/* Secondary: request badge from project_revisions */}
              {hasActiveRequest && (
                <Badge className="text-[9px] bg-violet-100 text-violet-700 border-violet-200 gap-1">
                  <Send className="h-2.5 w-2.5" />
                  {revData.active.length} Request{revData.active.length !== 1 ? 's' : ''} In Progress
                </Badge>
              )}
              {!hasActiveRequest && hasCompletedRequest && (
                <Badge className="text-[9px] bg-blue-100 text-blue-700 border-blue-200 gap-1">
                  <CheckCircle2 className="h-2.5 w-2.5" />
                  {revData.completed.length} Request{revData.completed.length !== 1 ? 's' : ''} Completed
                </Badge>
              )}
              {packageName && <Badge variant="outline" className="text-[9px] bg-muted/50">{packageName}</Badge>}
            </div>
            <div className="flex items-center gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
              {project.agent_name && <span className="font-medium text-foreground/70">{project.agent_name}</span>}
              {project.agency_name && <span className="flex items-center gap-1"><Building2 className="h-3 w-3" />{project.agency_name}</span>}
              {deliveredAt && <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{relativeTime(deliveredAt)}</span>}
              {turnaroundHrs != null && (
                <span className="flex items-center gap-1 text-blue-600">
                  <Timer className="h-3 w-3" />
                  {turnaroundHrs < 24 ? `${turnaroundHrs}h` : `${Math.round(turnaroundHrs / 24)}d`} turnaround
                </span>
              )}
              {requestTurnaroundHrs != null && (
                <span className="flex items-center gap-1 text-violet-600">
                  <Send className="h-3 w-3" />
                  {requestTurnaroundHrs < 24 ? `${requestTurnaroundHrs}h` : `${Math.round(requestTurnaroundHrs / 24)}d`} request turnaround
                </span>
              )}
              {value > 0 && <span className="font-semibold text-foreground">${value.toLocaleString()}</span>}
              {value > 0 && (
                <span className={cn('flex items-center gap-0.5 text-[10px] font-medium', isPaid ? 'text-green-600' : 'text-orange-500')}>
                  <CreditCard className="h-2.5 w-2.5" />{isPaid ? 'Paid' : 'Unpaid'}
                </span>
              )}
            </div>
            {(totalFileCount > 0 || mediaResult?.folders?.length > 0 || loadingMedia) && (
              <div className="flex gap-2 mt-2 flex-wrap items-center">
                {/* Skeleton pill placeholders while gallery is loading */}
                {loadingMedia ? (
                  <>
                    <div className="df-skeleton-pill h-5 w-24" aria-hidden="true" />
                    <div className="df-skeleton-pill h-5 w-20" style={{ animationDelay: '0.2s' }} aria-hidden="true" />
                    <div className="df-skeleton-pill h-5 w-16" style={{ animationDelay: '0.4s' }} aria-hidden="true" />
                    <span className="sr-only">Loading file information...</span>
                  </>
                ) : mediaResult?.folders?.length > 0 ? (
                  /* Folder-based pills from Dropbox gallery (preferred source) */
                  <>
                    {mediaResult.folders.filter(f => f.files?.length > 0).map((folder, idx) => {
                      const style = getFolderStyle(folder.name);
                      const FIcon = style.icon;
                      return (
                        <Badge key={folder.name} className={cn('df-pill-enter text-[10px] gap-1 border', style.bg, style.color)} style={{ animationDelay: `${idx * 0.08}s` }}>
                          <FIcon className="h-2.5 w-2.5" />{folder.files.length} {folder.name}
                        </Badge>
                      );
                    })}
                    <span className="df-pill-enter text-[10px] text-muted-foreground" style={{ animationDelay: `${(mediaResult.folders.filter(f => f.files?.length > 0).length) * 0.08}s` }}>
                      {allGalleryFiles.length} files
                    </span>
                  </>
                ) : totalFileCount > 0 ? (
                  /* Fallback: generic type pills from tonomo_delivered_files (when gallery has no folders or never loaded) */
                  <>
                    {Object.entries(fileTypeCounts).filter(([_, c]) => c > 0).map(([type, count], idx) => {
                      const cfg = TYPE_CONFIG[type]; const Icon = cfg.icon;
                      return <Badge key={type} className={cn('df-pill-enter text-[10px] gap-1', cfg.color)} style={{ animationDelay: `${idx * 0.08}s` }}><Icon className="h-2.5 w-2.5" />{count} {cfg.label}</Badge>;
                    })}
                    <span className="df-pill-enter text-[10px] text-muted-foreground">
                      {totalFileCount} files
                    </span>
                  </>
                ) : null}
              </div>
            )}
          </div>

          {/* Collapsed preview: thumbnails from gallery or delivered_files icons */}
          {!expanded && (flatFiles.length > 0 ? (
            <div className="hidden sm:flex gap-1 shrink-0 mr-1">
              {flatFiles.filter(f => f.thumbnail).slice(0, 5).map((file, i) => (
                <div key={file.path || i} className="w-11 h-11 rounded-md overflow-hidden bg-muted border border-border/40 shrink-0">
                  <img src={`data:image/jpeg;base64,${file.thumbnail}`} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
              ))}
              {flatFiles.length > 5 && (
                <div className="w-11 h-11 rounded-md bg-muted/60 border border-border/40 flex items-center justify-center text-[10px] text-muted-foreground font-semibold shrink-0">+{flatFiles.length - 5}</div>
              )}
            </div>
          ) : hasDeliveredFiles && (
            <div className="hidden sm:flex gap-1 shrink-0 mr-1">
              {deliveredFiles.slice(0, 4).map((item, i) => {
                if (typeof item !== 'object' || !item) return null;
                const typeKey = normalizeDeliveredType(item.type);
                const cfg = TYPE_CONFIG[typeKey] || TYPE_CONFIG.photos;
                const Icon = cfg.icon;
                return (
                  <div key={i} className={cn('w-11 h-11 rounded-md flex items-center justify-center shrink-0 border border-border/40', cfg.color)}>
                    <Icon className="h-4 w-4" />
                  </div>
                );
              })}
              {deliveredFiles.length > 4 && (
                <div className="w-11 h-11 rounded-md bg-muted/60 border border-border/40 flex items-center justify-center text-[10px] text-muted-foreground font-semibold shrink-0">+{deliveredFiles.length - 4}</div>
              )}
            </div>
          ))}

          <div className="flex items-center gap-2 shrink-0">
            {deliverableLink && <a href={deliverableLink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Open delivery folder"><ExternalLink className="h-4 w-4" /></a>}
            <Link to={createPageUrl('ProjectDetails') + `?id=${project.id}`} onClick={(e) => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Open project"><ArrowRight className="h-4 w-4" /></Link>
            <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform duration-200', expanded && 'rotate-180')} />
          </div>
        </div>
      </button>

      <div className="df-expand-panel" data-open={expanded} id={`delivery-panel-${project.id}`} role="region" aria-labelledby={`delivery-btn-${project.id}`}>
        <div className="df-expand-inner">
        {expanded && (
        <div className="border-t px-4 py-3">
          {/* Priority: Dropbox API gallery > delivered_files fallback */}
          {loadingMedia ? (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2" role="status" aria-label="Loading gallery">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] bg-muted rounded-lg animate-pulse" aria-hidden="true" />
              ))}
              <span className="sr-only">Loading gallery thumbnails...</span>
            </div>
          ) : mediaResult?.folders?.length > 0 ? (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {mediaResult.folders.reduce((s, f) => s + (f.files?.length || 0), 0)} files across {mediaResult.folders.length} folder{mediaResult.folders.length !== 1 ? 's' : ''}
                  </span>
                  {mediaResult._fetched_at && (
                    <span className="text-[9px] text-muted-foreground/50 flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" /> fetched {relativeTime(mediaResult._fetched_at)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {deliverableLink && (
                    <a href={deliverableLink} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> Open in Dropbox
                    </a>
                  )}
                  <button onClick={handleRefresh} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </button>
                </div>
              </div>
              {mediaResult.folders.map((folder, fi) => (
                <FolderGallery
                  key={folder.name || fi}
                  folder={folder}
                  shareUrl={deliverableLink}
                  onOpenLightbox={(files, index) => setLightbox({ files, index })}
                  project={project}
                  getTagsForFile={getTagsForFile}
                />
              ))}
            </div>
          ) : hasDeliveredFiles ? (
            <div className="space-y-1.5">
              {/* Show Dropbox error hint + retry when API failed but we have fallback data */}
              {mediaResult?._error && dropboxSource && (
                <div className="flex items-center gap-2 mb-2 px-2 py-1.5 rounded-md bg-amber-50 border border-amber-200 text-amber-700">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span className="text-[10px] flex-1 truncate">Dropbox gallery unavailable: {mediaResult._error}</span>
                  <button onClick={handleRefresh} className="text-[10px] font-medium hover:underline flex items-center gap-1 shrink-0">
                    <RefreshCw className="h-3 w-3" /> Retry
                  </button>
                </div>
              )}
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                  {deliveredFiles.length} deliverable{deliveredFiles.length !== 1 ? 's' : ''}
                </span>
                <div className="flex items-center gap-2">
                  {dropboxSource && (
                    <button onClick={handleRefresh} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                      <RefreshCw className="h-3 w-3" /> Refresh
                    </button>
                  )}
                  {deliverableLink && (
                    <a href={deliverableLink} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> Open in Dropbox
                    </a>
                  )}
                </div>
              </div>
              {deliveredFiles.map((item, i) => {
                if (typeof item === 'string') {
                  return (
                    <a key={i} href={item} target="_blank" rel="noopener noreferrer"
                      className="flex items-center gap-3 px-3 py-2 rounded-lg border border-border/40 bg-muted/30 hover:bg-muted/60 transition-colors group">
                      <ExternalLink className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="text-xs truncate flex-1">{item.split('/').pop() || item}</span>
                    </a>
                  );
                }

                const typeKey = normalizeDeliveredType(item.type);
                const cfg = TYPE_CONFIG[typeKey] || TYPE_CONFIG.photos;
                const Icon = cfg.icon;
                const fileUrl = getDeliveredFileUrl(item);
                const isFolder = typeKey === 'photos' || typeKey === 'drone';
                const itemName = item.name || 'Untitled';

                return (
                  <a key={i} href={fileUrl || '#'} target="_blank" rel="noopener noreferrer"
                    className={cn(
                      'flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border/40 transition-colors group',
                      fileUrl ? 'bg-muted/30 hover:bg-muted/60 cursor-pointer' : 'bg-muted/20 cursor-default'
                    )}
                    onClick={fileUrl ? undefined : (e) => e.preventDefault()}>
                    <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center shrink-0', cfg.color)}>
                      {isFolder ? <FolderOpen className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{itemName}</p>
                      {item.path_lower && (
                        <p className="text-[10px] text-muted-foreground truncate">{item.path_lower}</p>
                      )}
                    </div>
                    <Badge className={cn('text-[10px] shrink-0', cfg.color)}>
                      {item.type || 'File'}
                    </Badge>
                    <div className="flex items-center gap-1 shrink-0">
                      {fileUrl && (
                        <span className="text-muted-foreground group-hover:text-primary transition-colors">
                          {typeKey === 'pdf' ? (
                            <Eye className="h-3.5 w-3.5" />
                          ) : isFolder ? (
                            <Download className="h-3.5 w-3.5" />
                          ) : (
                            <ExternalLink className="h-3.5 w-3.5" />
                          )}
                        </span>
                      )}
                    </div>
                  </a>
                );
              })}
            </div>
          ) : loadingMedia ? (
            /* Case 2: Loading skeleton */
            <SkeletonGrid />
          ) : mediaResult && allGalleryFiles.length > 0 ? (
            /* Case 3: Visual gallery grouped by subfolder */
            <div>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {allGalleryFiles.length} files across {folderCount} folder{folderCount !== 1 ? 's' : ''}
                  </span>
                  {mediaResult._fetched_at && (
                    <span className="text-[9px] text-muted-foreground/50 flex items-center gap-1">
                      <Clock className="h-2.5 w-2.5" /> fetched {relativeTime(mediaResult._fetched_at)}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {deliverableLink && (
                    <a href={deliverableLink} target="_blank" rel="noopener noreferrer"
                      className="text-[10px] text-primary hover:underline flex items-center gap-1">
                      <FolderOpen className="h-3 w-3" /> Open in Dropbox
                    </a>
                  )}
                  <button onClick={handleRefresh} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <RefreshCw className="h-3 w-3" /> Refresh
                  </button>
                </div>
              </div>
              <div className="space-y-5">
                {mediaResult.folders.filter(f => f.files.length > 0).map((folder, fi) => (
                  <FolderGallery
                    key={folder.name || fi}
                    folder={folder}
                    shareUrl={deliverableLink}
                    onOpenLightbox={(files, index) => setLightbox({ files, index })}
                    project={project}
                    getTagsForFile={getTagsForFile}
                  />
                ))}
              </div>
            </div>
          ) : dropboxSource ? (
            /* Case 4: Dropbox source exists but nothing returned */
            <div className="flex flex-col items-center py-8 gap-2">
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center">
                <FolderOpen className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No files found yet</p>
              <p className="text-xs text-muted-foreground/60 max-w-xs text-center">The delivery folder exists but appears empty. Files may still be uploading.</p>
              <div className="flex items-center gap-2 mt-1">
                <button onClick={handleRefresh} className="text-xs text-primary hover:underline flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
                {deliverableLink && (
                  <a href={deliverableLink} target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1">
                    <ExternalLink className="h-3 w-3" /> Open in Dropbox
                  </a>
                )}
              </div>
            </div>
          ) : (
            /* Case 5: No data at all */
            <div className="flex flex-col items-center py-8 gap-2">
              <div className="w-10 h-10 rounded-xl bg-muted/60 flex items-center justify-center">
                <Inbox className="h-5 w-5 text-muted-foreground/40" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">No delivery data available</p>
              <p className="text-xs text-muted-foreground/60 max-w-xs text-center">This project does not have a delivery folder linked yet.</p>
            </div>
          )}
        </div>
      )}
        </div>
      </div>
      {lightbox && createPortal(<MiniLightbox files={lightbox.files} initialIndex={lightbox.index} shareUrl={deliverableLink} onClose={() => setLightbox(null)} project={project} />, document.body)}
    </div>
  );
}

// ─── Main DeliveryFeed ───────────────────────────────────────────────────────
export default function DeliveryFeed() {
  const [dateFilter, setDateFilter] = useState('30');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [newDeliveryIds, setNewDeliveryIds] = useState(new Set());
  const [dropboxWarning, setDropboxWarning] = useState(false);
  const [emptyProjectIds, setEmptyProjectIds] = useState(new Set()); // Projects with 0 Dropbox files
  const [newestFileDate, setNewestFileDate] = useState(new Map()); // projectId → newest file uploaded_at
  const [scannedCount, setScannedCount] = useState(0); // How many Dropbox folders have reported back
  const scannedIdsRef = useRef(new Set()); // Track which project IDs have been scanned

  // Load project revisions for request badges
  const { data: allRevisions = [] } = useEntityList('ProjectRevision', '-created_date');

  // Build a map: projectId → { hasActive, hasCompleted, activeCount, completedCount }
  const revisionsByProject = useMemo(() => {
    const map = new Map();
    allRevisions.forEach(rev => {
      if (!rev.project_id) return;
      if (!map.has(rev.project_id)) map.set(rev.project_id, { active: [], completed: [] });
      const bucket = map.get(rev.project_id);
      if (rev.status === 'completed' || rev.status === 'delivered') {
        bucket.completed.push(rev);
      } else if (rev.status !== 'cancelled' && rev.status !== 'rejected') {
        bucket.active.push(rev);
      }
    });
    return map;
  }, [allRevisions]);

  // Favorites + tags: call once at parent level, pass helper down
  const { favorites, allTags: tagRegistry } = useFavorites();

  const getTagsForFile = useCallback((filePath) => {
    if (!filePath) return [];
    const fav = favorites.find(f => f.file_path === filePath);
    if (!fav?.tags?.length) return [];
    return fav.tags.map(tagName => {
      const reg = tagRegistry.find(t => t.name === tagName);
      return { name: tagName, color: reg?.color || '#3b82f6' };
    });
  }, [favorites, tagRegistry]);

  // Callback from DeliveryCard when file count is known
  const handleFileCountKnown = useCallback((projectId, count, newestUploadAt) => {
    if (count === 0) {
      setEmptyProjectIds(prev => { const next = new Set(prev); next.add(projectId); return next; });
    } else {
      setEmptyProjectIds(prev => { if (!prev.has(projectId)) return prev; const next = new Set(prev); next.delete(projectId); return next; });
    }
    // Track the newest file upload date — used for date grouping
    if (newestUploadAt) {
      setNewestFileDate(prev => { const next = new Map(prev); next.set(projectId, newestUploadAt); return next; });
    }
    // Track scan progress for the loading indicator
    if (!scannedIdsRef.current.has(projectId)) {
      scannedIdsRef.current.add(projectId);
      setScannedCount(scannedIdsRef.current.size);
    }
  }, []);

  const { data: allProjects = [], loading } = useEntityList('Project', '-tonomo_delivered_at');

  useEffect(() => {
    const timer = setTimeout(() => {
      if (dropboxFailCount >= 3) setDropboxWarning(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const highlightTimers = new Set();
    const unsub = api.entities.Project.subscribe((event) => {
      if (event.type === 'update' && event.data?.tonomo_delivered_at && event.data?.status === 'delivered') {
        setNewDeliveryIds(prev => new Set([...prev, event.id]));
        const timer = setTimeout(() => {
          highlightTimers.delete(timer);
          setNewDeliveryIds(prev => { const next = new Set(prev); next.delete(event.id); return next; });
        }, 60000);
        highlightTimers.add(timer);
      }
    });
    return () => {
      unsub();
      highlightTimers.forEach(clearTimeout);
    };
  }, []);

  const deliveries = useMemo(() => {
    const days = parseInt(dateFilter, 10);
    const now = new Date();
    // Use the module-level ALL_DELIVERY_STAGES constant for consistency
    return allProjects
      .filter(p => {
        // Fully delivered projects
        if (ALL_DELIVERY_STAGES.includes(p.status)) return true;
        // ANY project with a Dropbox link is a partial delivery (media exists)
        if (p.tonomo_deliverable_link) return true;
        return false;
      })
      .filter(p => p.tonomo_delivered_at || p.tonomo_deliverable_link || p.tonomo_delivered_files || p.tonomo_deliverable_path)
      .filter(p => {
        if (days === 0) return true;
        // Partial deliveries always show (media may be uploading right now)
        if (!ALL_DELIVERY_STAGES.includes(p.status) && p.tonomo_deliverable_link) return true;
        const delivered = p.tonomo_delivered_at || p.updated_date;
        if (!delivered) return false;
        return differenceInDays(now, new Date(fixTimestamp(delivered))) <= days;
      })
      .filter(p => agencyFilter === 'all' || p.agency_id === agencyFilter)
      .filter(p => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (p.title || '').toLowerCase().includes(q)
          || (p.property_address || '').toLowerCase().includes(q)
          || (p.agency_name || '').toLowerCase().includes(q)
          || (p.agent_name || '').toLowerCase().includes(q);
      })
      .sort((a, b) => {
        // Sort fully delivered projects before partial deliveries
        const aDelivered = ALL_DELIVERY_STAGES.includes(a.status);
        const bDelivered = ALL_DELIVERY_STAGES.includes(b.status);
        if (aDelivered && !bDelivered) return -1;
        if (!aDelivered && bDelivered) return 1;
        // Within the same group, sort by date descending, then by id for stability
        const aDate = a.tonomo_delivered_at || a.updated_date;
        const bDate = b.tonomo_delivered_at || b.updated_date;
        // Handle missing dates: projects with dates come before those without
        if (aDate && !bDate) return -1;
        if (!aDate && bDate) return 1;
        if (aDate && bDate) {
          const dateDiff = new Date(fixTimestamp(bDate)) - new Date(fixTimestamp(aDate));
          if (dateDiff !== 0) return dateDiff;
        }
        // Stable tiebreaker: compare by id so order is deterministic across re-renders
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
  }, [allProjects, dateFilter, agencyFilter, search]);

  const grouped = useMemo(() => {
    const groups = {};
    deliveries.forEach(p => {
      // Use the newest file's upload timestamp if available (from Dropbox scan).
      // This is the source of truth — files uploaded today should group under TODAY
      // even if the project record wasn't updated today.
      const fileDate = newestFileDate.get(p.id);
      const projectDate = p.tonomo_delivered_at || p.updated_date;
      // Pick whichever is more recent
      let raw = projectDate;
      if (fileDate) {
        if (!raw || new Date(fileDate) > new Date(fixTimestamp(raw))) {
          raw = fileDate;
        }
      }
      let label;
      if (!raw) {
        label = 'No Date';
      } else {
        const d = new Date(fixTimestamp(raw));
        if (isToday(d)) label = 'Today';
        else if (isYesterday(d)) label = 'Yesterday';
        else if (differenceInDays(new Date(), d) < 7) label = format(d, 'EEEE');
        else label = format(d, 'd MMMM yyyy');
      }
      if (!groups[label]) groups[label] = [];
      groups[label].push(p);
    });
    return Object.entries(groups);
  }, [deliveries, newestFileDate]);

  const agencyOptions = useMemo(() => {
    const seen = new Map();
    allProjects.filter(p => p.tonomo_delivered_at).forEach(p => {
      if (p.agency_id && p.agency_name) seen.set(p.agency_id, p.agency_name);
    });
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allProjects]);

  const stats = useMemo(() => {
    // Filter to only visible (non-empty) deliveries for accurate counts
    const visible = deliveries.filter(p => !emptyProjectIds.has(p.id) || parseDeliveredFiles(p.tonomo_delivered_files).length > 0);

    // "Delivered today" = projects with files uploaded today OR tonomo_delivered_at today
    const today = visible.filter(p => {
      const fileDate = newestFileDate.get(p.id);
      if (fileDate && isToday(new Date(fileDate))) return true;
      if (p.tonomo_delivered_at && isToday(new Date(fixTimestamp(p.tonomo_delivered_at)))) return true;
      return false;
    }).length;

    const totalFiles = visible.reduce((s, p) => s + deliveredFileCount(p), 0);
    const totalRevenue = visible.reduce((s, p) => s + projectRevenue(p), 0);
    const paidCount = visible.filter(p => p.tonomo_payment_status === 'paid').length;

    let turnaroundSum = 0;
    let turnaroundCount = 0;
    visible.forEach(p => {
      if (p.shoot_date && p.tonomo_delivered_at) {
        try {
          const hrs = differenceInHours(new Date(fixTimestamp(p.tonomo_delivered_at)), new Date(fixTimestamp(p.shoot_date)));
          if (hrs > 0 && hrs < 720) { turnaroundSum += hrs; turnaroundCount++; }
        } catch { /* skip */ }
      }
    });
    const avgTurnaroundHrs = turnaroundCount > 0 ? Math.round(turnaroundSum / turnaroundCount) : null;

    return { today, total: visible.length, totalFiles, totalRevenue, paidCount, avgTurnaroundHrs };
  }, [deliveries, emptyProjectIds, newestFileDate]);

  return (
    <div className="p-6 space-y-4">
      {dropboxWarning && (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-800 text-xs">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Dropbox media previews unavailable — check that <code className="bg-amber-100 px-1 rounded text-[10px]">DROPBOX_API_TOKEN</code> is configured in backend environment variables.</span>
          <button onClick={() => setDropboxWarning(false)} className="ml-auto shrink-0 hover:text-amber-950"><X className="h-3.5 w-3.5" /></button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          { label: 'Delivered today', value: stats.today, icon: Zap, accent: 'text-green-600', bg: 'bg-green-50', bar: '#22c55e' },
          { label: 'Total deliveries', value: stats.total, icon: Package, accent: 'text-foreground', bg: 'bg-muted/50', bar: 'hsl(var(--muted-foreground))' },
          { label: 'Total files', value: stats.totalFiles.toLocaleString(), icon: Camera, accent: 'text-blue-600', bg: 'bg-blue-50', bar: '#3b82f6' },
          { label: 'Revenue', value: fmtRevenue(stats.totalRevenue), icon: DollarSign, accent: 'text-emerald-600', bg: 'bg-emerald-50', bar: '#10b981' },
          { label: 'Paid', value: `${stats.paidCount}/${stats.total}`, icon: CreditCard, accent: stats.paidCount === stats.total ? 'text-green-600' : 'text-orange-500', bg: stats.paidCount === stats.total ? 'bg-green-50' : 'bg-orange-50', bar: stats.paidCount === stats.total ? '#22c55e' : '#f97316' },
          { label: 'Avg turnaround', value: stats.avgTurnaroundHrs != null ? (stats.avgTurnaroundHrs < 24 ? `${stats.avgTurnaroundHrs}h` : `${Math.round(stats.avgTurnaroundHrs / 24)}d`) : '\u2014', icon: Timer, accent: 'text-blue-600', bg: 'bg-blue-50', bar: '#3b82f6' },
        ].map((s, i) => (
          <Card key={i} className="df-stat-enter df-stat-card p-3 hover:shadow-md transition-shadow duration-200" style={{ '--df-stat-accent': s.bar }}>
            <div className="flex items-center gap-2.5">
              <div className={cn('w-9 h-9 rounded-xl flex items-center justify-center shrink-0', s.bg)}>
                <s.icon className={cn('h-4 w-4', s.accent || 'text-muted-foreground')} />
              </div>
              <div className="min-w-0">
                <div className={cn('text-lg font-bold leading-tight tabular-nums', s.accent)}>{s.value}</div>
                <div className="text-[9px] text-muted-foreground uppercase tracking-wider leading-tight">{s.label}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Scan progress */}
      {scannedCount > 0 && scannedCount < deliveries.length && (
        <div className="flex items-center gap-3">
          <div className="flex-1 h-1 bg-muted rounded-full overflow-hidden">
            <div className="h-full bg-primary/60 rounded-full transition-all duration-500" style={{ width: `${Math.round((scannedCount / deliveries.length) * 100)}%` }} />
          </div>
          <span className="text-[10px] text-muted-foreground shrink-0 flex items-center gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Scanning {scannedCount} of {deliveries.length} folders...
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search project, agent, or agency..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 pr-8 h-9 text-sm rounded-lg"
            aria-label="Search deliveries"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors" aria-label="Clear search">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <Select value={dateFilter} onValueChange={setDateFilter}>
          <SelectTrigger className="w-36 h-9 text-xs rounded-lg"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[{ v: '7', l: 'Last 7 days' }, { v: '30', l: 'Last 30 days' }, { v: '90', l: 'Last 3 months' }, { v: '0', l: 'All time' }].map(d => <SelectItem key={d.v} value={d.v}>{d.l}</SelectItem>)}
          </SelectContent>
        </Select>
        {agencyOptions.length > 0 && (
          <Select value={agencyFilter} onValueChange={setAgencyFilter}>
            <SelectTrigger className="w-44 h-9 text-xs rounded-lg"><SelectValue placeholder="All agencies" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All agencies</SelectItem>{agencyOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        {(search || dateFilter !== '30' || agencyFilter !== 'all') && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSearch(''); setDateFilter('30'); setAgencyFilter('all'); }}
            className="h-9 px-3 text-xs text-muted-foreground hover:text-foreground gap-1.5"
          >
            <FilterX className="h-3.5 w-3.5" />
            Clear filters
          </Button>
        )}
      </div>

      {loading ? (
        <div className="space-y-3" role="status" aria-label="Loading deliveries">
          {[...Array(4)].map((_, i) => <div key={i} className="h-24 rounded-xl border border-border/30 df-skeleton-pill" style={{ animationDelay: `${i * 0.1}s`, borderRadius: '0.75rem' }} />)}
          <span className="sr-only">Loading delivery feed...</span>
        </div>
      ) : deliveries.length === 0 ? (
        <Card className="p-16 text-center border-dashed">
          <div className="w-14 h-14 rounded-2xl bg-muted/60 flex items-center justify-center mx-auto mb-4">
            {search || agencyFilter !== 'all'
              ? <Search className="h-7 w-7 text-muted-foreground/40" />
              : <Inbox className="h-7 w-7 text-muted-foreground/40" />
            }
          </div>
          <p className="text-base font-semibold text-muted-foreground">
            {search || agencyFilter !== 'all' ? 'No matching deliveries' : 'No deliveries yet'}
          </p>
          <p className="text-xs text-muted-foreground/60 mt-1.5 max-w-sm mx-auto leading-relaxed">
            {search
              ? `No results for "${search}". Try a different search term or broaden your filters.`
              : agencyFilter !== 'all'
                ? 'No deliveries found for this agency in the selected time range.'
                : dateFilter !== '0' && dateFilter !== '30'
                  ? `No deliveries in the last ${dateFilter} days. Try expanding the date range.`
                  : 'Deliveries will appear here automatically when Tonomo marks a booking as delivered.'}
          </p>
          {(search || dateFilter !== '30' || agencyFilter !== 'all') && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setSearch(''); setDateFilter('30'); setAgencyFilter('all'); }}
              className="mt-4 text-xs gap-1.5"
            >
              <FilterX className="h-3.5 w-3.5" />
              Clear all filters
            </Button>
          )}
        </Card>
      ) : (
        <div className="space-y-6" role="feed" aria-label={`Delivery feed, ${deliveries.length} total`}>
          {grouped.map(([dateLabel, projects]) => (
            <section key={dateLabel} aria-label={`${dateLabel} deliveries`}>
              <div className="flex items-center gap-3 mb-3 pt-1 pb-2" role="heading" aria-level="3">
                <div className="flex items-center gap-2.5">
                  <div className="w-2 h-2 rounded-full bg-primary/60 ring-2 ring-primary/15" />
                  <span className="text-xs font-bold text-foreground/80 uppercase tracking-widest">{dateLabel}</span>
                </div>
                <div className="flex-1 border-b border-border/40" />
                <span className="text-[10px] font-medium text-muted-foreground bg-muted/60 px-2.5 py-0.5 rounded-full tabular-nums">
                  {projects.filter(p => !emptyProjectIds.has(p.id) || parseDeliveredFiles(p.tonomo_delivered_files).length > 0).length} deliver{projects.filter(p => !emptyProjectIds.has(p.id) || parseDeliveredFiles(p.tonomo_delivered_files).length > 0).length !== 1 ? 'ies' : 'y'}
                </span>
              </div>
              <div className="space-y-2" role="list">
                {projects.filter(p => !emptyProjectIds.has(p.id) || parseDeliveredFiles(p.tonomo_delivered_files).length > 0).map(p => <DeliveryCard key={p.id} project={p} isNew={newDeliveryIds.has(p.id)} onFileCountKnown={handleFileCountKnown} getTagsForFile={getTagsForFile} newestFileDateMap={newestFileDate} projectRevisions={revisionsByProject.get(p.id)} />)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

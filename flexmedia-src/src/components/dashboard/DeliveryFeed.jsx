import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useFavorites } from '@/components/favorites/useFavorites';
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

    .df-stat-enter { animation: df-fadeIn 0.4s ease-out both; }
    .df-stat-enter:nth-child(1) { animation-delay: 0.00s; }
    .df-stat-enter:nth-child(2) { animation-delay: 0.06s; }
    .df-stat-enter:nth-child(3) { animation-delay: 0.12s; }
    .df-stat-enter:nth-child(4) { animation-delay: 0.18s; }
    .df-stat-enter:nth-child(5) { animation-delay: 0.24s; }
    .df-stat-enter:nth-child(6) { animation-delay: 0.30s; }

    .df-skeleton-pill {
      background: linear-gradient(90deg, hsl(var(--muted)) 25%, hsl(var(--muted-foreground) / 0.08) 50%, hsl(var(--muted)) 75%);
      background-size: 200% 100%;
      animation: df-shimmer 1.5s ease-in-out infinite;
      border-radius: 9999px;
    }

    .df-pulse-dot {
      animation: df-pulse-dot 1.5s ease-in-out infinite;
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

// ─── Proxy image loading (mirrors ProjectMediaGallery approach) ─────────────
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
const imgBlobCache = new Map();
const imgPending = new Set();
let imgActiveLoads = 0;
const imgLoadQueue = [];

function processImgQueue() {
  while (imgActiveLoads < 8 && imgLoadQueue.length > 0) {
    const job = imgLoadQueue.shift();
    imgActiveLoads++;
    job().finally(() => { imgActiveLoads--; processImgQueue(); });
  }
}

const IMG_BLOB_CACHE_MAX = 200; // Max blob URLs to keep in memory

function evictOldBlobEntries() {
  if (imgBlobCache.size <= IMG_BLOB_CACHE_MAX) return;
  // Map preserves insertion order — delete oldest entries first
  const excess = imgBlobCache.size - IMG_BLOB_CACHE_MAX;
  let removed = 0;
  for (const [key, url] of imgBlobCache) {
    if (removed >= excess) break;
    URL.revokeObjectURL(url);
    imgBlobCache.delete(key);
    removed++;
  }
}

async function fetchProxyImage(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  if (imgBlobCache.has(cacheKey)) return imgBlobCache.get(cacheKey);
  if (imgPending.has(cacheKey)) return null;
  imgPending.add(cacheKey);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ action: mode, file_path: filePath }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 500) return null;
    const url = URL.createObjectURL(blob);
    imgBlobCache.set(cacheKey, url);
    evictOldBlobEntries();
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

/** Build a Dropbox preview URL from shared link + filename */
function buildDropboxPreviewUrl(shareUrl, filePath) {
  if (!shareUrl || !filePath) return shareUrl || '#';
  const fileName = filePath.split('/').pop();
  // Remove query params from share URL, then add preview param
  const base = shareUrl.split('?')[0];
  return `${base}?preview=${encodeURIComponent(fileName)}`;
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
          console.error('[DeliveryFeed] Dropbox edge function error:', data.error, '| URL/path:', pathOrUrl);
          dropboxFailCount++;
          resolve({ folders: [], _error: data.error });
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

  const isImage = file.type === 'image';
  const isVideo = file.type === 'video';
  const proxyPath = tonomoBase && file.path
    ? tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path)
    : null;

  useEffect(() => {
    if ((!isImage && !isVideo) || !proxyPath || started.current) return;
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    setLoading(true);
    imgLoadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath);
      if (url) setBlobUrl(url);
      setLoading(false);
    });
    processImgQueue();
  }, [isImage, isVideo, proxyPath]);

  // Reset when file changes
  useEffect(() => {
    started.current = false;
    const cached = proxyPath ? imgBlobCache.get(`thumb::${proxyPath}`) : null;
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

  // Image display
  if (isImage && imgSrc) {
    return <img src={imgSrc} alt={file.name} className="df-img-loaded max-w-full max-h-full object-contain p-4 rounded-lg" style={{ maxHeight: 'calc(100vh - 140px)' }} />;
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
  const previewUrl = shareUrl && file.path ? buildDropboxPreviewUrl(shareUrl, file.path) : file.preview_url;
  return (
    <div className="flex flex-col items-center gap-3 text-white/60">
      <FileText className="h-16 w-16" />
      <p className="text-sm">{file.name}</p>
      {previewUrl && previewUrl !== '#' && (
        <a href={previewUrl} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs">
          <ExternalLink className="h-3.5 w-3.5" /> Open in Dropbox
        </a>
      )}
    </div>
  );
}

// ─── LightboxThumb: filmstrip thumbnail with proxy support ──────────────────
function LightboxThumb({ file, tonomoBase }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const started = useRef(false);

  const canThumb = file.type === 'image' || file.type === 'video' || file.type === 'document';

  useEffect(() => {
    if (!canThumb || !tonomoBase || started.current) return;
    const proxyPath = tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path);
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    imgLoadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath);
      if (url) setBlobUrl(url);
    });
    processImgQueue();
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
  const previewUrl = buildDropboxPreviewUrl(shareUrl, file.path);
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
          {previewUrl && previewUrl !== '#' && (
            <button onClick={() => window.open(previewUrl, '_blank')} className="p-2 hover:bg-white/10 rounded-lg transition-colors" title="Open in Dropbox" aria-label="Open in Dropbox">
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors" aria-label="Close lightbox">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 px-16" onClick={e => e.stopPropagation()}>
        {/* Nav arrows */}
        {index > 0 && (
          <button onClick={() => setIndex(i => i - 1)} className="absolute left-3 top-1/2 -translate-y-1/2 p-3 bg-black/60 hover:bg-black/80 rounded-full text-white transition-all hover:scale-105 z-10 backdrop-blur-sm" aria-label="Previous image">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < files.length - 1 && (
          <button onClick={() => setIndex(i => i + 1)} className="absolute right-3 top-1/2 -translate-y-1/2 p-3 bg-black/60 hover:bg-black/80 rounded-full text-white transition-all hover:scale-105 z-10 backdrop-blur-sm" aria-label="Next image">
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
    imgLoadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath);
      if (url) setBlobUrl(url);
      setProxyLoading(false);
    });
    processImgQueue();
  }, [canThumb, tonomoBase, file.path]);

  const hasVisual = blobUrl || thumbnail || file.thumbnail;
  const imgSrc = blobUrl || (thumbnail ? `data:image/jpeg;base64,${thumbnail}` : file.thumbnail ? `data:image/jpeg;base64,${file.thumbnail}` : null);
  const isLoading = proxyLoading || loading;
  const uploadTime = file.uploaded_at ? relativeTime(file.uploaded_at) : null;

  return (
    <button
      ref={cardRef}
      onClick={() => {
        onOpenLightbox(folder.files, index);
      }}
      className="group relative aspect-[4/3] rounded-lg overflow-hidden bg-muted border border-border/30 hover:ring-2 hover:ring-primary/30 transition-all"
      title={file.name}
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

      {/* Hover eye icon top-right */}
      <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        <div className="bg-black/50 backdrop-blur-sm rounded-full p-1">
          <Eye className="h-3 w-3 text-white" />
        </div>
      </div>
    </button>
  );
}

// ─── ProxyFileCard: inline file card with proxy image support ───────────────
function ProxyFileCard({ file, project, getTagsForFile }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  const canThumb = file.type === 'image' || file.type === 'video' || file.type === 'document';
  const tonomoBase = project?.tonomo_deliverable_path;

  useEffect(() => {
    if (!canThumb || !tonomoBase || started.current) return;
    const proxyPath = tonomoBase + (file.path?.startsWith('/') ? file.path : '/' + file.path);
    const cached = imgBlobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    setLoading(true);
    imgLoadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath);
      if (url) setBlobUrl(url);
      setLoading(false);
    });
    processImgQueue();
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
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
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

const FULL_DELIVERY_STAGES = ['ready_for_partial', 'in_revision', 'delivered'];

function isPartialDelivery(project) {
  return !FULL_DELIVERY_STAGES.includes(project.status) && !!project.tonomo_deliverable_link;
}

// ─── DeliveryCard ────────────────────────────────────────────────────────────
function DeliveryCard({ project, isNew, onFileCountKnown, getTagsForFile }) {
  const [expanded, setExpanded] = useState(false);
  const [mediaResult, setMediaResult] = useState(null); // { folders: [...] } or null
  const [flatFiles, setFlatFiles] = useState([]); // backward compat for flat response
  const [loadingMedia, setLoadingMedia] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const hasFetchedRef = useRef(false);

  const isPartial = isPartialDelivery(project);
  const deliveredAt = project.tonomo_delivered_at || project.updated_date || project.created_date;
  const deliverableLink = project.tonomo_deliverable_link;
  const deliverablePath = project.tonomo_deliverable_path;
  const deliveredFiles = useMemo(() => parseDeliveredFiles(project.tonomo_delivered_files), [project.tonomo_delivered_files]);
  const hasDeliveredFiles = deliveredFiles.length > 0;
  const value = projectRevenue(project);
  const isPaid = project.tonomo_payment_status === 'paid';
  const packageName = project.tonomo_package;

  const turnaroundHrs = useMemo(() => {
    if (!project.shoot_date || !deliveredAt) return null;
    try {
      const shoot = new Date(fixTimestamp(project.shoot_date));
      const delivered = new Date(fixTimestamp(deliveredAt));
      const hrs = differenceInHours(delivered, shoot);
      return hrs > 0 ? hrs : null;
    } catch { return null; }
  }, [project.shoot_date, deliveredAt]);

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
      setMediaResult(result);
      const allFiles = (result?.folders || []).flatMap(f => f.files);
      setFlatFiles(allFiles);
      setLoadingMedia(false);
      // Report file count to parent — used to hide empty cards
      if (onFileCountKnown) onFileCountKnown(project.id, allFiles.length);
    });
  }, [dropboxSource, isShareUrl]);

  const handleRefresh = async (e) => {
    e.stopPropagation();
    if (!dropboxSource) return;
    setLoadingMedia(true);
    thumbCache.delete(dropboxSource);
    pendingRequests.delete(dropboxSource);
    const result = await fetchMediaFeed(dropboxSource, isShareUrl, deliverablePath);
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
    <div className={cn(
      'border rounded-xl overflow-hidden transition-all duration-200 bg-card hover:shadow-lg hover:-translate-y-[1px]',
      'border-l-[3px]',
      isPartial ? 'border-l-orange-400' : project.status === 'delivered' ? 'border-l-emerald-400' : 'border-l-blue-400',
      isNew && 'ring-2 ring-green-300 ring-opacity-50'
    )}>
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-inset rounded-xl"
        aria-expanded={expanded}
        aria-controls={`delivery-panel-${project.id}`}
      >
        <div className="flex items-start gap-3 p-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5', isPartial ? 'bg-orange-100' : project.status === 'delivered' ? 'bg-emerald-100' : 'bg-blue-100')}>
            {isPartial ? <Loader2 className="h-5 w-5 text-orange-600 animate-spin" /> : project.status === 'delivered' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Package className="h-5 w-5 text-blue-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[15px] leading-tight">{projectTitle(project)}</span>
              {isNew && <Badge className="text-[9px] bg-green-100 text-green-700 border-green-200">NEW</Badge>}
              {isPartial ? (
                <Badge className="text-[9px] bg-orange-100 text-orange-700 border-orange-200 gap-1.5">
                  <span className="df-pulse-dot inline-block w-1.5 h-1.5 rounded-full bg-orange-500" />
                  In Progress
                </Badge>
              ) : (
                <Badge variant="outline" className="text-[9px]">{stageLabel(project.status)}</Badge>
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
                    <div className="df-skeleton-pill h-5 w-24" />
                    <div className="df-skeleton-pill h-5 w-20" style={{ animationDelay: '0.2s' }} />
                    <div className="df-skeleton-pill h-5 w-16" style={{ animationDelay: '0.4s' }} />
                  </>
                ) : mediaResult?.folders?.length > 0 ? (
                  /* Folder-based pills from Dropbox gallery (preferred source) */
                  <>
                    {mediaResult.folders.filter(f => f.files?.length > 0).map(folder => {
                      const style = getFolderStyle(folder.name);
                      const FIcon = style.icon;
                      return (
                        <Badge key={folder.name} className={cn('text-[10px] gap-1 border', style.bg, style.color)}>
                          <FIcon className="h-2.5 w-2.5" />{folder.files.length} {folder.name}
                        </Badge>
                      );
                    })}
                    <span className="text-[10px] text-muted-foreground">
                      {allGalleryFiles.length} files
                    </span>
                  </>
                ) : !mediaResult && totalFileCount > 0 ? (
                  /* Fallback: generic type pills from tonomo_delivered_files (only when gallery never loaded) */
                  <>
                    {Object.entries(fileTypeCounts).filter(([_, c]) => c > 0).map(([type, count]) => {
                      const cfg = TYPE_CONFIG[type]; const Icon = cfg.icon;
                      return <Badge key={type} className={cn('text-[10px] gap-1', cfg.color)}><Icon className="h-2.5 w-2.5" />{count} {cfg.label}</Badge>;
                    })}
                    <span className="text-[10px] text-muted-foreground">
                      {totalFileCount} files
                    </span>
                  </>
                ) : mediaResult && allGalleryFiles.length > 0 ? (
                  /* Gallery loaded but folders array was empty — show total count */
                  <span className="text-[10px] text-muted-foreground">
                    {allGalleryFiles.length} files
                  </span>
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
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="aspect-[4/3] bg-muted rounded-lg animate-pulse" />
              ))}
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
            <div className="text-center py-4 text-xs text-muted-foreground">
              No files found in Dropbox — <a href={deliverableLink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">open in Dropbox</a>
            </div>
          ) : (
            /* Case 5: No data at all */
            <div className="text-center py-4 text-xs text-muted-foreground">No delivery data available</div>
          )}
        </div>
      )}
        </div>
      </div>
      {lightbox && <MiniLightbox files={lightbox.files} initialIndex={lightbox.index} shareUrl={deliverableLink} onClose={() => setLightbox(null)} project={project} />}
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
  const handleFileCountKnown = useCallback((projectId, count) => {
    if (count === 0) {
      setEmptyProjectIds(prev => { const next = new Set(prev); next.add(projectId); return next; });
    } else {
      setEmptyProjectIds(prev => { if (!prev.has(projectId)) return prev; const next = new Set(prev); next.delete(projectId); return next; });
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
    const DELIVERY_STAGES = ['ready_for_partial', 'in_revision', 'delivered'];
    return allProjects
      .filter(p => {
        // Fully delivered projects
        if (DELIVERY_STAGES.includes(p.status)) return true;
        // ANY project with a Dropbox link is a partial delivery (media exists)
        if (p.tonomo_deliverable_link) return true;
        return false;
      })
      .filter(p => p.tonomo_delivered_at || p.tonomo_deliverable_link || p.tonomo_delivered_files || p.tonomo_deliverable_path)
      .filter(p => {
        if (days === 0) return true;
        // Partial deliveries always show (media may be uploading right now)
        if (!DELIVERY_STAGES.includes(p.status) && p.tonomo_deliverable_link) return true;
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
        const aDelivered = DELIVERY_STAGES.includes(a.status);
        const bDelivered = DELIVERY_STAGES.includes(b.status);
        if (aDelivered && !bDelivered) return -1;
        if (!aDelivered && bDelivered) return 1;
        // Within the same group, sort by date descending
        return new Date(fixTimestamp(b.tonomo_delivered_at || b.updated_date || '')) - new Date(fixTimestamp(a.tonomo_delivered_at || a.updated_date || ''));
      });
  }, [allProjects, dateFilter, agencyFilter, search]);

  const grouped = useMemo(() => {
    const groups = {};
    deliveries.forEach(p => {
      const raw = p.tonomo_delivered_at || p.updated_date;
      if (!raw) return;
      const d = new Date(fixTimestamp(raw));
      let label;
      if (isToday(d)) label = 'Today';
      else if (isYesterday(d)) label = 'Yesterday';
      else if (differenceInDays(new Date(), d) < 7) label = format(d, 'EEEE');
      else label = format(d, 'd MMMM yyyy');
      if (!groups[label]) groups[label] = [];
      groups[label].push(p);
    });
    return Object.entries(groups);
  }, [deliveries]);

  const agencyOptions = useMemo(() => {
    const seen = new Map();
    allProjects.filter(p => p.tonomo_delivered_at).forEach(p => {
      if (p.agency_id && p.agency_name) seen.set(p.agency_id, p.agency_name);
    });
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allProjects]);

  const stats = useMemo(() => {
    const today = deliveries.filter(p => p.tonomo_delivered_at && isToday(new Date(fixTimestamp(p.tonomo_delivered_at)))).length;
    const totalFiles = deliveries.reduce((s, p) => s + deliveredFileCount(p), 0);
    const totalRevenue = deliveries.reduce((s, p) => s + projectRevenue(p), 0);
    const paidCount = deliveries.filter(p => p.tonomo_payment_status === 'paid').length;

    let turnaroundSum = 0;
    let turnaroundCount = 0;
    deliveries.forEach(p => {
      if (p.shoot_date && p.tonomo_delivered_at) {
        try {
          const hrs = differenceInHours(new Date(fixTimestamp(p.tonomo_delivered_at)), new Date(fixTimestamp(p.shoot_date)));
          if (hrs > 0 && hrs < 720) { turnaroundSum += hrs; turnaroundCount++; }
        } catch { /* skip */ }
      }
    });
    const avgTurnaroundHrs = turnaroundCount > 0 ? Math.round(turnaroundSum / turnaroundCount) : null;

    return { today, total: deliveries.length, totalFiles, totalRevenue, paidCount, avgTurnaroundHrs };
  }, [deliveries]);

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
          { label: 'Delivered today', value: stats.today, icon: Zap, accent: 'text-green-600' },
          { label: 'Total deliveries', value: stats.total, icon: Package, accent: '' },
          { label: 'Total files', value: stats.totalFiles.toLocaleString(), icon: Camera, accent: '' },
          { label: 'Revenue', value: fmtRevenue(stats.totalRevenue), icon: DollarSign, accent: 'text-emerald-600' },
          { label: 'Paid', value: `${stats.paidCount}/${stats.total}`, icon: CreditCard, accent: stats.paidCount === stats.total ? 'text-green-600' : 'text-orange-500' },
          { label: 'Avg turnaround', value: stats.avgTurnaroundHrs != null ? (stats.avgTurnaroundHrs < 24 ? `${stats.avgTurnaroundHrs}h` : `${Math.round(stats.avgTurnaroundHrs / 24)}d`) : '—', icon: Timer, accent: 'text-blue-600' },
        ].map((s, i) => (
          <Card key={i} className="p-3">
            <div className="flex items-center gap-2">
              <s.icon className={cn('h-4 w-4 text-muted-foreground', s.accent)} />
              <div>
                <div className={cn('text-lg font-bold', s.accent)}>{s.value}</div>
                <div className="text-[9px] text-muted-foreground uppercase">{s.label}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Search project, agent, or agency..." value={search} onChange={e => setSearch(e.target.value)} className="pl-8 h-8 text-sm" />
        </div>
        <Select value={dateFilter} onValueChange={setDateFilter}>
          <SelectTrigger className="w-36 h-8 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {[{ v: '7', l: 'Last 7 days' }, { v: '30', l: 'Last 30 days' }, { v: '90', l: 'Last 3 months' }, { v: '0', l: 'All time' }].map(d => <SelectItem key={d.v} value={d.v}>{d.l}</SelectItem>)}
          </SelectContent>
        </Select>
        {agencyOptions.length > 0 && (
          <Select value={agencyFilter} onValueChange={setAgencyFilter}>
            <SelectTrigger className="w-44 h-8 text-xs"><SelectValue placeholder="All agencies" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All agencies</SelectItem>{agencyOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </div>

      {loading ? (
        <div className="space-y-3">{[...Array(4)].map((_, i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-xl" />)}</div>
      ) : deliveries.length === 0 ? (
        <Card className="p-12 text-center">
          <Package className="h-10 w-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No deliveries match your filters</p>
          <p className="text-xs text-muted-foreground/60 mt-1">Deliveries appear here when Tonomo marks a booking as complete</p>
        </Card>
      ) : (
        <div className="space-y-6">
          {grouped.map(([dateLabel, projects]) => (
            <div key={dateLabel}>
              <div className="flex items-center gap-3 mb-3">
                <span className="text-xs font-bold text-muted-foreground uppercase tracking-widest">{dateLabel}</span>
                <div className="flex-1 h-px bg-border" />
                <span className="text-xs text-muted-foreground">{projects.length} deliver{projects.length !== 1 ? 'ies' : 'y'}</span>
              </div>
              <div className="space-y-2">
                {projects.filter(p => !emptyProjectIds.has(p.id)).map(p => <DeliveryCard key={p.id} project={p} isNew={newDeliveryIds.has(p.id)} onFileCountKnown={handleFileCountKnown} getTagsForFile={getTagsForFile} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

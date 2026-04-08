import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { useQuery } from "@tanstack/react-query";
import { fixTimestamp } from "@/components/utils/dateUtils";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  RefreshCw, Camera, Film, FileText, File, ExternalLink,
  ImageOff, Play, Clock, Search, Building2, User, Loader2,
  AlertCircle, FolderOpen, Grid2x2, Grid3x3, LayoutGrid,
  X, ChevronLeft, ChevronRight
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, differenceInDays } from "date-fns";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ---- Image proxy with concurrency limiter + blob cache ----
const blobCache = new Map();
const pending = new Set();
let activeLoads = 0;
const loadQueue = [];

function processQueue() {
  while (activeLoads < 8 && loadQueue.length > 0) {
    const job = loadQueue.shift();
    activeLoads++;
    job().finally(() => { activeLoads--; processQueue(); });
  }
}

async function fetchProxyImage(filePath, mode = 'thumb') {
  const cacheKey = `${mode}::${filePath}`;
  if (blobCache.has(cacheKey)) return blobCache.get(cacheKey);
  if (pending.has(cacheKey)) return null;
  pending.add(cacheKey);
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
    blobCache.set(cacheKey, url);
    return url;
  } catch { return null; }
  finally { pending.delete(cacheKey); }
}

// ---- Constants ----
const DATE_RANGES = [
  { value: '7',   label: 'Last 7 days' },
  { value: '30',  label: 'Last 30 days' },
  { value: '90',  label: 'Last 3 months' },
  { value: '0',   label: 'All time' },
];

const TYPE_FILTERS = [
  { value: 'all',      label: 'All types' },
  { value: 'image',    label: 'Photos' },
  { value: 'video',    label: 'Videos' },
  { value: 'document', label: 'Documents' },
];

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

const TYPE_BADGE_STYLES = {
  image:    'bg-blue-50 text-blue-600 border-blue-200',
  video:    'bg-purple-50 text-purple-600 border-purple-200',
  document: 'bg-amber-50 text-amber-600 border-amber-200',
  other:    'bg-slate-50 text-slate-600 border-slate-200',
};

// ---- MediaLightbox: fullscreen image/video viewer ----
function MediaLightbox({ files, initialIndex, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const file = files[index];

  const isVideo = file?.type === 'video';
  const isImage = file?.type === 'image';
  const proxyPath = file?.proxyPath || null;

  // Load video blob when a video file is selected
  useEffect(() => {
    if (!isVideo || !proxyPath) { setVideoUrl(null); return; }
    setVideoLoading(true);
    setVideoUrl(null);
    const cached = blobCache.get(proxyPath);
    if (cached) { setVideoUrl(cached); setVideoLoading(false); return; }
    fetchProxyImage(proxyPath).then(url => {
      setVideoUrl(url);
      setVideoLoading(false);
    });
  }, [isVideo, proxyPath]);

  // Keyboard nav
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && index > 0) setIndex(i => i - 1);
      if (e.key === 'ArrowRight' && index < files.length - 1) setIndex(i => i + 1);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [index, files.length, onClose]);

  const imgBlobUrl = isImage ? blobCache.get(proxyPath) : null;

  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={onClose}>
      {/* Header */}
      <div className="flex items-center justify-between p-3 text-white" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium truncate max-w-md">{file?.name}</span>
          {file?.size > 0 && <span className="text-xs text-white/50">{formatSize(file.size)}</span>}
          <span className="text-xs text-white/50">{index + 1} / {files.length}</span>
        </div>
        <div className="flex items-center gap-2">
          {file?.projectName && (
            <span className="text-xs text-white/40 truncate max-w-[200px]">{file.projectName}</span>
          )}
          {file?.preview_url && (
            <button onClick={() => safeWindowOpen(file.preview_url)} className="p-2 hover:bg-white/10 rounded-lg transition-colors" title="Open in Dropbox">
              <ExternalLink className="h-4 w-4" />
            </button>
          )}
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-lg transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center relative min-h-0 px-16" onClick={e => e.stopPropagation()}>
        {/* Nav arrows */}
        {index > 0 && (
          <button onClick={() => setIndex(i => i - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}
        {index < files.length - 1 && (
          <button onClick={() => setIndex(i => i + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 p-3 bg-black/50 hover:bg-black/70 rounded-full text-white transition-colors z-10">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}

        {/* Image */}
        {isImage && imgBlobUrl && (
          <img src={imgBlobUrl} alt={file.name} className="max-w-full max-h-full object-contain rounded-lg" />
        )}
        {isImage && !imgBlobUrl && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <Loader2 className="h-10 w-10 animate-spin" />
            <span className="text-sm">Loading image...</span>
          </div>
        )}

        {/* Video */}
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
              style={{ maxHeight: 'calc(100vh - 120px)' }}
            />
          ) : (
            <div className="text-white/60 text-sm">Video unavailable</div>
          )
        )}

        {/* Document / other */}
        {!isImage && !isVideo && (
          <div className="flex flex-col items-center gap-3 text-white/60">
            <FileIcon type={file?.type} className="h-16 w-16" />
            <span className="text-sm">{file?.name}</span>
            {file?.preview_url && (
              <button
                onClick={() => safeWindowOpen(file.preview_url)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/20 text-white/70 hover:text-white hover:bg-white/10 transition-colors text-xs"
              >
                <ExternalLink className="h-3.5 w-3.5" />Open in Dropbox
              </button>
            )}
          </div>
        )}
      </div>

      {/* Filmstrip */}
      <div className="flex gap-1.5 p-3 overflow-x-auto justify-center" onClick={e => e.stopPropagation()}>
        {files.slice(0, 40).map((f, i) => {
          const thumbUrl = f.proxyPath ? blobCache.get(f.proxyPath) : null;
          return (
            <button
              key={f.proxyPath || f.path || i}
              onClick={() => setIndex(i)}
              className={cn("w-14 h-10 rounded overflow-hidden shrink-0 border-2 transition-all",
                i === index ? "border-white ring-1 ring-white/50" : "border-transparent opacity-60 hover:opacity-100")}
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

// ---- FeedCard: single media card in the grid ----
function FeedCard({ item, isVisible, onClick }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const started = useRef(false);
  const cardRef = useRef(null);

  const isImage = item.type === 'image';

  // Only load images once visible (IntersectionObserver)
  useEffect(() => {
    if (!isImage || !item.proxyPath || started.current) return;
    const cached = blobCache.get(item.proxyPath);
    if (cached) { setBlobUrl(cached); return; }

    if (!isVisible) return;
    started.current = true;
    setLoading(true);
    loadQueue.push(async () => {
      const url = await fetchProxyImage(item.proxyPath);
      if (url) setBlobUrl(url);
      else setError(true);
      setLoading(false);
    });
    processQueue();
  }, [isImage, item.proxyPath, isVisible]);

  const handleClick = () => {
    if (onClick) onClick();
    else if (item.preview_url) safeWindowOpen(item.preview_url);
  };

  const uploadTime = timeAgo(item.uploaded_at);
  const badgeStyle = TYPE_BADGE_STYLES[item.type] || TYPE_BADGE_STYLES.other;

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={handleClick}
      className="group relative rounded-xl overflow-hidden border bg-card transition-all hover:shadow-lg hover:-translate-y-0.5 text-left w-full focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {/* Thumbnail area */}
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden relative">
        {blobUrl ? (
          <img
            src={blobUrl}
            alt={item.name}
            className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
            loading="lazy"
          />
        ) : loading ? (
          <div className="w-full h-full animate-pulse bg-muted flex items-center justify-center">
            <Camera className="h-6 w-6 text-muted-foreground/20 animate-pulse" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <FileIcon type={item.type} className="h-8 w-8 opacity-40" />
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">{item.ext || item.type}</span>
          </div>
        )}

        {/* Video play overlay */}
        {item.type === 'video' && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-black/40 rounded-full p-2.5"><Play className="h-5 w-5 text-white fill-white" /></div>
          </div>
        )}

        {/* Project overlay at bottom of thumbnail */}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent p-2.5 pt-6 opacity-0 group-hover:opacity-100 transition-opacity">
          <p className="text-white text-[11px] font-medium truncate leading-tight">{item.projectName}</p>
          {uploadTime && <p className="text-white/60 text-[10px]">{uploadTime}</p>}
        </div>

        {/* Type badge */}
        {item.type !== 'image' && (
          <div className="absolute top-2 left-2">
            <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 h-4 backdrop-blur-sm ${badgeStyle}`}>
              {item.type === 'video' ? 'Video' : item.ext?.toUpperCase() || item.type}
            </Badge>
          </div>
        )}

        {/* External link icon on hover */}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <ExternalLink className="h-3.5 w-3.5 text-white drop-shadow-md" />
        </div>
      </div>

      {/* Info below thumbnail */}
      <div className="p-2.5 space-y-1">
        <p className="text-xs font-medium truncate leading-tight" title={item.name}>{item.name}</p>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {item.size > 0 && <span>{formatSize(item.size)}</span>}
          {item.size > 0 && <span className="text-muted-foreground/30">|</span>}
          <span className="uppercase">{item.ext}</span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate">
          <Building2 className="h-2.5 w-2.5 shrink-0" />
          <span className="truncate">{item.projectName}</span>
        </div>
        {item.photographerName && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/60 truncate">
            <User className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{item.photographerName}</span>
          </div>
        )}
      </div>
    </button>
  );
}

// ---- Shimmer loading skeleton ----
function FeedSkeleton({ count = 12 }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl overflow-hidden border bg-card">
          <Skeleton className="aspect-[4/3] w-full" />
          <div className="p-2.5 space-y-1.5">
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-2.5 w-1/2" />
            <Skeleton className="h-2.5 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Main component ----
export default function LiveMediaFeed() {
  const [dateRange, setDateRange] = useState('30');
  const [typeFilter, setTypeFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [gridSize, setGridSize] = useState('md');
  const [visibleCards, setVisibleCards] = useState(new Set());
  const [lightbox, setLightbox] = useState(null); // { files, index }
  const gridRef = useRef(null);

  // Load projects
  const { data: allProjects = [], loading: projectsLoading } = useEntityList('Project', '-created_date', 500);
  const { data: allUsers = [] } = useEntityList('User');

  // Build a user lookup for photographer names
  const userMap = useMemo(() => {
    const m = new Map();
    allUsers.forEach(u => { if (u.id) m.set(u.id, u.full_name || u.email || 'Unknown'); });
    return m;
  }, [allUsers]);

  // Filter projects that have deliverable links (up to 20 most recent)
  const eligibleProjects = useMemo(() => {
    if (!Array.isArray(allProjects)) return [];
    return allProjects
      .filter(p => p?.tonomo_deliverable_link && p?.tonomo_deliverable_path)
      .sort((a, b) => {
        const aDate = a.tonomo_delivered_at || a.updated_date || a.created_date || '';
        const bDate = b.tonomo_delivered_at || b.updated_date || b.created_date || '';
        try { return new Date(fixTimestamp(bDate)) - new Date(fixTimestamp(aDate)); } catch { return 0; }
      })
      .slice(0, 20);
  }, [allProjects]);

  // Fetch file listings for all eligible projects (batched in one react-query)
  const { data: projectFiles, isLoading: filesLoading, isFetching, refetch } = useQuery({
    queryKey: ['liveMediaFeed', eligibleProjects.map(p => p.id).join(',')],
    queryFn: async () => {
      if (eligibleProjects.length === 0) return [];

      // Fetch up to 4 projects concurrently
      const results = [];
      const queue = [...eligibleProjects];
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          const project = queue.shift();
          try {
            const res = await api.functions.invoke("getDeliveryMediaFeed", {
              share_url: project.tonomo_deliverable_link,
            });
            const data = res?.data || res;
            if (data?.error) continue;
            let folders = [];
            if (data?.folders && Array.isArray(data.folders)) folders = data.folders;
            else if (data?.files && Array.isArray(data.files)) folders = [{ name: "All Files", files: data.files }];

            // Flatten files and attach project metadata
            const files = folders.flatMap(folder =>
              (folder.files || []).map(file => ({
                ...file,
                projectId: project.id,
                projectName: project.property_address || project.title || 'Unknown Project',
                projectLink: project.tonomo_deliverable_link,
                tonomoBasePath: project.tonomo_deliverable_path,
                folderName: folder.name,
                photographerName: userMap.get(project.photographer_id) || userMap.get(project.project_owner_id) || project.agent_name || null,
                agentName: project.agent_name || null,
                // Build proxy path for image loading
                proxyPath: project.tonomo_deliverable_path
                  ? `${project.tonomo_deliverable_path}${file.path?.startsWith('/') ? file.path : '/' + file.path}`
                  : null,
              }))
            );
            results.push(...files);
          } catch (err) {
            console.warn('[LiveMediaFeed] Failed to load project:', project.property_address, err?.message);
          }
        }
      });

      await Promise.all(workers);
      return results;
    },
    enabled: eligibleProjects.length > 0,
    staleTime: 5 * 60 * 1000, // 5 minutes
    refetchOnWindowFocus: false,
    retry: 1,
  });

  // Merge, filter, and sort all files into a unified feed
  const feedItems = useMemo(() => {
    if (!projectFiles || !Array.isArray(projectFiles)) return [];
    const now = new Date();
    const days = parseInt(dateRange, 10);

    return projectFiles
      .filter(f => {
        // Date range filter
        if (days > 0 && f.uploaded_at) {
          try {
            if (differenceInDays(now, new Date(f.uploaded_at)) > days) return false;
          } catch { /* keep it */ }
        }
        // Type filter
        if (typeFilter !== 'all' && f.type !== typeFilter) return false;
        // Search filter
        if (search.trim()) {
          const q = search.toLowerCase();
          const matches = (
            f.name?.toLowerCase().includes(q) ||
            f.projectName?.toLowerCase().includes(q) ||
            f.folderName?.toLowerCase().includes(q) ||
            f.photographerName?.toLowerCase().includes(q)
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
  }, [projectFiles, dateRange, typeFilter, search]);

  // Stats
  const stats = useMemo(() => {
    const photos = feedItems.filter(f => f.type === 'image').length;
    const videos = feedItems.filter(f => f.type === 'video').length;
    const docs = feedItems.filter(f => f.type === 'document').length;
    const projects = new Set(feedItems.map(f => f.projectId)).size;
    return { photos, videos, docs, projects, total: feedItems.length };
  }, [feedItems]);

  // IntersectionObserver for lazy-loading images only when cards are visible
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
            // Do NOT remove -- once loaded we keep the blob
          });
          if (next.size === prev.size) return prev;
          return next;
        });
      },
      { root: null, rootMargin: '200px', threshold: 0 }
    );

    const cards = gridRef.current.querySelectorAll('[data-feed-id]');
    cards.forEach(el => observer.observe(el));

    return () => observer.disconnect();
  }, [feedItems]);

  const handleRefresh = useCallback(() => {
    // Clear blob cache for all eligible projects
    eligibleProjects.forEach(p => {
      if (p.tonomo_deliverable_path) {
        for (const [k, v] of blobCache.entries()) {
          if (k.startsWith(p.tonomo_deliverable_path)) {
            URL.revokeObjectURL(v);
            blobCache.delete(k);
          }
        }
      }
    });
    refetch();
  }, [refetch, eligibleProjects]);

  const isLoading = projectsLoading || filesLoading;

  return (
    <div className="space-y-5">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight flex items-center gap-2">
            Live Media Feed
            {isFetching && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLoading
              ? 'Loading files across projects...'
              : `${stats.total} files across ${stats.projects} project${stats.projects !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={isFetching}
          className="text-xs h-7 px-2.5"
        >
          <RefreshCw className={cn("h-3.5 w-3.5 mr-1.5", isFetching && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {/* ---- Stat badges ---- */}
      {!isLoading && stats.total > 0 && (
        <div className="flex flex-wrap gap-2">
          {stats.photos > 0 && (
            <Badge variant="outline" className="text-[11px] bg-blue-50 text-blue-600 border-blue-200 gap-1">
              <Camera className="h-3 w-3" /> {stats.photos} photos
            </Badge>
          )}
          {stats.videos > 0 && (
            <Badge variant="outline" className="text-[11px] bg-purple-50 text-purple-600 border-purple-200 gap-1">
              <Film className="h-3 w-3" /> {stats.videos} videos
            </Badge>
          )}
          {stats.docs > 0 && (
            <Badge variant="outline" className="text-[11px] bg-amber-50 text-amber-600 border-amber-200 gap-1">
              <FileText className="h-3 w-3" /> {stats.docs} documents
            </Badge>
          )}
        </div>
      )}

      {/* ---- Filters ---- */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by project, file name, photographer..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        <Select value={dateRange} onValueChange={setDateRange}>
          <SelectTrigger className="w-36 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_RANGES.map(d => (
              <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-32 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TYPE_FILTERS.map(t => (
              <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center border rounded-md overflow-hidden shrink-0">
          {[
            { key: 'sm', icon: Grid3x3, title: 'Small' },
            { key: 'md', icon: Grid2x2, title: 'Medium' },
            { key: 'lg', icon: LayoutGrid, title: 'Large' },
          ].map(({ key, icon: Icon, title }) => (
            <button
              key={key}
              onClick={() => setGridSize(key)}
              title={title}
              className={`p-1.5 transition-colors ${gridSize === key ? 'bg-primary text-primary-foreground' : 'hover:bg-muted text-muted-foreground'}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground shrink-0">
          {feedItems.length} result{feedItems.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ---- Content ---- */}
      {isLoading ? (
        <FeedSkeleton />
      ) : feedItems.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              {projectFiles && projectFiles.length > 0 ? (
                <Search className="h-8 w-8 text-muted-foreground" />
              ) : (
                <ImageOff className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <h3 className="text-sm font-semibold mb-1">
              {projectFiles && projectFiles.length > 0
                ? 'No files match your filters'
                : 'No delivered media found'}
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              {projectFiles && projectFiles.length > 0
                ? 'Try adjusting the date range, type filter, or search query.'
                : 'Files appear here once projects have Dropbox delivery folders linked.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div
          ref={gridRef}
          className={`grid ${gridSize === 'sm' ? 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2' : gridSize === 'lg' ? 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3'}`}
        >
          {feedItems.map((item, idx) => {
            const feedId = `${item.projectId}-${item.path || item.name}-${idx}`;
            return (
              <div key={feedId} data-feed-id={feedId}>
                <FeedCard
                  item={item}
                  isVisible={visibleCards.has(feedId)}
                  onClick={() => setLightbox({ files: feedItems, index: idx })}
                />
              </div>
            );
          })}
        </div>
      )}

      {/* Fullscreen lightbox */}
      {lightbox && (
        <MediaLightbox
          files={lightbox.files}
          initialIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

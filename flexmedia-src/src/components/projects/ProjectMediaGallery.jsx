import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, FolderOpen, Image, Film, FileText, File,
  ExternalLink, AlertCircle, ImageOff, Camera, Play, Clock,
  Grid2x2, Grid3x3, LayoutGrid, X, ChevronLeft, ChevronRight,
  Download, Loader2
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";
import { formatDistanceToNow, format } from "date-fns";
import FavoriteButton from "@/components/favorites/FavoriteButton";
import TagManager from "@/components/favorites/TagManager";
import { useFavorites } from "@/components/favorites/useFavorites";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;

// ─── Image proxy ────────────────────────────────────────────────────
const blobCache = new Map();
const pending = new Set();
let activeLoads = 0;
const loadQueue = [];

function processQueue() {
  while (activeLoads < 4 && loadQueue.length > 0) {
    const job = loadQueue.shift();
    activeLoads++;
    job().finally(() => { activeLoads--; processQueue(); });
  }
}

async function fetchProxyImage(filePath) {
  if (blobCache.has(filePath)) return blobCache.get(filePath);
  if (pending.has(filePath)) return null;
  pending.add(filePath);
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPABASE_ANON}` },
      body: JSON.stringify({ action: 'proxy', file_path: filePath }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size < 500) return null;
    const url = URL.createObjectURL(blob);
    blobCache.set(filePath, url);
    return url;
  } catch { return null; }
  finally { pending.delete(filePath); }
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

// ─── MediaLightbox — fullscreen image/video viewer ──────────────────

function MediaLightbox({ files, initialIndex, tonomoBasePath, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const file = files[index];

  const isVideo = file?.type === 'video';
  const isImage = file?.type === 'image';
  const proxyPath = tonomoBasePath && file?.name
    ? `${tonomoBasePath}${file.path?.startsWith('/') ? file.path : '/' + file.path}`
    : null;

  // Load video blob when a video file is selected
  useEffect(() => {
    if (!isVideo || !proxyPath) { setVideoUrl(null); return; }
    setVideoLoading(true);
    setVideoUrl(null);
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
          <span className="text-xs text-white/50">{formatSize(file?.size)}</span>
          <span className="text-xs text-white/50">{index + 1} / {files.length}</span>
        </div>
        <div className="flex items-center gap-2">
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
              <Button variant="outline" size="sm" onClick={() => safeWindowOpen(file.preview_url)} className="text-white border-white/30 hover:bg-white/10">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />Open in Dropbox
              </Button>
            )}
          </div>
        )}
      </div>

      {/* Filmstrip */}
      <div className="flex gap-1.5 p-3 overflow-x-auto justify-center" onClick={e => e.stopPropagation()}>
        {files.map((f, i) => {
          const thumbUrl = blobCache.get(tonomoBasePath + (f.path?.startsWith('/') ? f.path : '/' + f.path));
          return (
            <button
              key={f.path || i}
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

// ─── MediaThumbnail ─────────────────────────────────────────────────

function MediaThumbnail({ file, tonomoBasePath, onClick }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const started = useRef(false);

  const isImage = file.type === 'image';
  const proxyPath = tonomoBasePath && file.name
    ? `${tonomoBasePath}${file.path?.startsWith('/') ? file.path : '/' + file.path}`
    : null;

  useEffect(() => {
    if (!isImage || !proxyPath || started.current) return;
    const cached = blobCache.get(proxyPath);
    if (cached) { setBlobUrl(cached); return; }
    started.current = true;
    setLoading(true);
    loadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath);
      if (url) setBlobUrl(url);
      else setError(true);
      setLoading(false);
    });
    processQueue();
  }, [isImage, proxyPath]);

  const handleClick = () => {
    if (onClick) onClick();
    else if (file.preview_url) safeWindowOpen(file.preview_url);
  };

  const uploadTime = timeAgo(file.uploaded_at);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative rounded-lg border bg-card overflow-hidden transition-all hover:shadow-md hover:-translate-y-0.5 text-left w-full"
    >
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
        {blobUrl ? (
          <img src={blobUrl} alt={file.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" loading="lazy" />
        ) : loading ? (
          <div className="w-full h-full animate-pulse bg-muted flex items-center justify-center">
            <Camera className="h-6 w-6 text-muted-foreground/20 animate-pulse" />
          </div>
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <FileIcon type={file.type} className="h-8 w-8 opacity-40" />
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">{file.ext || file.type}</span>
          </div>
        )}
      </div>

      {file.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/40 rounded-full p-2.5"><Play className="h-5 w-5 text-white fill-white" /></div>
        </div>
      )}

      <div className="p-2 space-y-0.5">
        <p className="text-xs font-medium truncate leading-tight" title={file.name}>{file.name}</p>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {file.size > 0 && <span>{formatSize(file.size)}</span>}
          <span className="uppercase">{file.ext}</span>
          {uploadTime && (
            <>
              <span className="text-muted-foreground/30">|</span>
              <Clock className="h-2.5 w-2.5 opacity-50" />
              <span className="opacity-70">{uploadTime}</span>
            </>
          )}
        </div>
      </div>

      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none" />

      {/* Top-right: star + external link on hover */}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <FavoriteButton
          filePath={proxyPath}
          fileName={file.name}
          fileType={file.type}
          tonomoBasePath={tonomoBasePath}
          size="sm"
          className="bg-black/40 hover:bg-black/60 rounded-full p-1 text-white"
        />
      </div>

      {file.type !== "image" && (
        <div className="absolute top-1.5 left-1.5">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
            {file.type === "video" ? "Video" : file.ext?.toUpperCase() || file.type}
          </Badge>
        </div>
      )}
    </button>
  );
}

// ─── FolderSection ──────────────────────────────────────────────────

const GRID_SIZES = {
  sm: 'grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2',
  md: 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3',
  lg: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4',
};

function FolderSection({ folder, tonomoBasePath, gridSize = 'md', onOpenLightbox }) {
  const [collapsed, setCollapsed] = useState(false);
  const imageCount = folder.files.filter(f => f.type === 'image').length;
  const videoCount = folder.files.filter(f => f.type === 'video').length;
  const docCount   = folder.files.filter(f => f.type === 'document').length;

  return (
    <div className="space-y-3">
      <button type="button" onClick={() => setCollapsed(!collapsed)} className="flex items-center gap-2 group cursor-pointer">
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{folder.name}</h3>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">{folder.files.length}</Badge>
        <div className="flex gap-1.5 ml-1">
          {imageCount > 0 && <Badge className="text-[10px] bg-blue-50 text-blue-600 border-blue-200 h-4 px-1.5 py-0">{imageCount} photos</Badge>}
          {videoCount > 0 && <Badge className="text-[10px] bg-purple-50 text-purple-600 border-purple-200 h-4 px-1.5 py-0">{videoCount} video</Badge>}
          {docCount > 0 && <Badge className="text-[10px] bg-amber-50 text-amber-600 border-amber-200 h-4 px-1.5 py-0">{docCount} docs</Badge>}
        </div>
        <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors ml-auto">{collapsed ? "Show" : "Hide"}</span>
      </button>
      {!collapsed && (
        <div className={cn("grid", GRID_SIZES[gridSize])}>
          {folder.files.map((file) => (
            <MediaThumbnail key={file.path || file.name} file={file} tonomoBasePath={tonomoBasePath} onClick={() => onOpenLightbox(folder.files, folder.files.indexOf(file))} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Skeletons & empty states ───────────────────────────────────────

function MediaSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between"><Skeleton className="h-5 w-40" /><Skeleton className="h-8 w-24" /></div>
      <Skeleton className="h-5 w-32" />
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 8 }).map((_, i) => (<Skeleton key={i} className="aspect-[4/3] w-full rounded-lg" />))}
      </div>
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────

export default function ProjectMediaGallery({ project }) {
  const deliverableLink = project?.tonomo_deliverable_link;
  const tonomoBasePath = project?.tonomo_deliverable_path;
  const [gridSize, setGridSize] = useState('md');
  const [lightbox, setLightbox] = useState(null); // { files, index }

  const { data: mediaData, isLoading, isError, error, refetch, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["projectMedia", deliverableLink],
    queryFn: async () => {
      const res = await api.functions.invoke("getDeliveryMediaFeed", { share_url: deliverableLink, base_path: tonomoBasePath });
      const data = res?.data || res;
      if (data?.error) throw new Error(data.error);
      let folders = [];
      if (data?.folders && Array.isArray(data.folders)) folders = data.folders;
      else if (data?.files && Array.isArray(data.files)) folders = [{ name: "All Files", files: data.files }];
      return { folders, fetched_at: data?.fetched_at || new Date().toISOString() };
    },
    enabled: !!deliverableLink,
    staleTime: 120_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const handleRefresh = useCallback(() => {
    if (tonomoBasePath) {
      for (const [k, v] of blobCache.entries()) {
        if (k.startsWith(tonomoBasePath)) { URL.revokeObjectURL(v); blobCache.delete(k); }
      }
    }
    refetch();
  }, [refetch, tonomoBasePath]);

  if (!deliverableLink) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4"><ImageOff className="h-8 w-8 text-muted-foreground" /></div>
          <h3 className="text-sm font-semibold mb-1">Dropbox folder not linked</h3>
          <p className="text-xs text-muted-foreground max-w-sm">Files appear once the Dropbox delivery folder is shared.</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) return <MediaSkeleton />;

  if (isError) {
    return (
      <Card><CardContent className="flex flex-col items-center justify-center py-12 text-center">
        <AlertCircle className="h-8 w-8 text-destructive mb-3" />
        <h3 className="text-sm font-semibold mb-1">Failed to load media</h3>
        <p className="text-xs text-muted-foreground mb-4 max-w-sm">{error?.message || "Could not fetch files."}</p>
        <Button variant="outline" size="sm" onClick={handleRefresh}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Retry</Button>
      </CardContent></Card>
    );
  }

  const folders = mediaData?.folders || [];
  const totalFiles = folders.reduce((sum, f) => sum + (f.files?.length || 0), 0);
  const fetchedAt = mediaData?.fetched_at;

  if (totalFiles === 0) {
    return (
      <Card className="border-dashed"><CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <div className="rounded-full bg-muted p-4 mb-4"><FolderOpen className="h-8 w-8 text-muted-foreground" /></div>
        <h3 className="text-sm font-semibold mb-1">Folder is empty</h3>
        <p className="text-xs text-muted-foreground max-w-sm">Files appear as the team uploads.</p>
      </CardContent></Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</h3>
          <span className="text-xs text-muted-foreground">across {folders.length} folder{folders.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          {fetchedAt && (
            <span className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
              <Clock className="h-3 w-3" />
              Fetched {timeAgo(fetchedAt)}
            </span>
          )}
          <div className="flex items-center border rounded-md overflow-hidden">
            {[
              { key: 'sm', icon: Grid3x3, title: 'Small' },
              { key: 'md', icon: Grid2x2, title: 'Medium' },
              { key: 'lg', icon: LayoutGrid, title: 'Large' },
            ].map(({ key, icon: Icon, title }) => (
              <button
                key={key}
                onClick={() => setGridSize(key)}
                title={title}
                className={cn("p-1.5 transition-colors", gridSize === key ? "bg-primary text-primary-foreground" : "hover:bg-muted text-muted-foreground")}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => safeWindowOpen(deliverableLink)} className="text-xs h-7 px-2">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />Open in Dropbox
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} className="text-xs h-7 px-2">
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isFetching && "animate-spin")} />Refresh
          </Button>
        </div>
      </div>

      {/* Folders */}
      {folders.map((folder) => (
        <FolderSection key={folder.name} folder={folder} tonomoBasePath={tonomoBasePath} gridSize={gridSize} onOpenLightbox={(files, idx) => setLightbox({ files, index: idx })} />
      ))}

      {/* Lightbox */}
      {lightbox && (
        <MediaLightbox
          files={lightbox.files}
          initialIndex={lightbox.index}
          tonomoBasePath={tonomoBasePath}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

import { useState, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  RefreshCw, FolderOpen, Image, Film, FileText, File,
  ExternalLink, AlertCircle, ImageOff, Camera, Play
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";

// File-type icon
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

// ─── Thumbnail card ─────────────────────────────────────────────────
function MediaThumbnail({ file, deliverableLink }) {
  const [imgError, setImgError] = useState(false);

  // Use raw_url from edge function for direct image display
  const isImage = file.type === 'image';
  const imgSrc = isImage && file.raw_url && !imgError ? file.raw_url : null;

  const handleClick = () => {
    const url = file.preview_url || deliverableLink;
    if (url) safeWindowOpen(url);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative rounded-lg border bg-card overflow-hidden transition-all hover:shadow-md hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring text-left w-full"
    >
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden">
        {imgSrc ? (
          <img
            src={imgSrc}
            alt={file.name}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
            onError={() => setImgError(true)}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex flex-col items-center gap-1.5 text-muted-foreground p-4">
            <FileIcon type={file.type} className="h-8 w-8 opacity-40" />
            <span className="text-[10px] font-medium uppercase tracking-wider opacity-50">
              {file.ext || file.type}
            </span>
          </div>
        )}
      </div>

      {/* Video play overlay */}
      {file.type === 'video' && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/40 rounded-full p-2.5">
            <Play className="h-5 w-5 text-white fill-white" />
          </div>
        </div>
      )}

      <div className="p-2 space-y-0.5">
        <p className="text-xs font-medium truncate leading-tight" title={file.name}>
          {file.name}
        </p>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {file.size > 0 && <span>{formatSize(file.size)}</span>}
          <span className="uppercase">{file.ext}</span>
        </div>
      </div>

      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors pointer-events-none" />
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
        <ExternalLink className="h-3.5 w-3.5 text-white drop-shadow-md" />
      </div>

      {file.type !== "image" && (
        <div className="absolute top-2 left-2">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
            {file.type === "video" ? "Video" : file.ext?.toUpperCase() || file.type}
          </Badge>
        </div>
      )}
    </button>
  );
}

function FolderSection({ folder, deliverableLink }) {
  const [collapsed, setCollapsed] = useState(false);
  const imageCount = folder.files.filter(f => f.type === 'image').length;
  const videoCount = folder.files.filter(f => f.type === 'video').length;
  const docCount   = folder.files.filter(f => f.type === 'document').length;

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-2 group cursor-pointer"
      >
        <FolderOpen className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">{folder.name}</h3>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
          {folder.files.length}
        </Badge>
        <div className="flex gap-1.5 ml-1">
          {imageCount > 0 && <Badge className="text-[10px] bg-blue-50 text-blue-600 border-blue-200 h-4 px-1.5 py-0">{imageCount} photos</Badge>}
          {videoCount > 0 && <Badge className="text-[10px] bg-purple-50 text-purple-600 border-purple-200 h-4 px-1.5 py-0">{videoCount} video</Badge>}
          {docCount > 0 && <Badge className="text-[10px] bg-amber-50 text-amber-600 border-amber-200 h-4 px-1.5 py-0">{docCount} docs</Badge>}
        </div>
        <span className="text-xs text-muted-foreground group-hover:text-foreground transition-colors ml-auto">
          {collapsed ? "Show" : "Hide"}
        </span>
      </button>

      {!collapsed && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {folder.files.map((file) => (
            <MediaThumbnail
              key={file.path || file.name}
              file={file}
              deliverableLink={deliverableLink}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MediaSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-8 w-24" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-5 w-32" />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="space-y-2">
              <Skeleton className="aspect-[4/3] w-full rounded-lg" />
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function ProjectMediaGallery({ project }) {
  const deliverableLink = project?.tonomo_deliverable_link;

  const { data: mediaData, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["projectMedia", deliverableLink],
    queryFn: async () => {
      const res = await api.functions.invoke("getDeliveryMediaFeed", { share_url: deliverableLink });
      const data = res?.data || res;
      if (data?.error) throw new Error(data.error);
      if (data?.folders && Array.isArray(data.folders)) return { folders: data.folders };
      if (data?.files && Array.isArray(data.files)) return { folders: [{ name: "All Files", files: data.files }] };
      return { folders: [] };
    },
    enabled: !!deliverableLink,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  const handleRefresh = useCallback(() => refetch(), [refetch]);

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
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-8 w-8 text-destructive mb-3" />
          <h3 className="text-sm font-semibold mb-1">Failed to load media</h3>
          <p className="text-xs text-muted-foreground mb-4 max-w-sm">{error?.message || "Could not fetch files."}</p>
          <Button variant="outline" size="sm" onClick={handleRefresh}><RefreshCw className="h-3.5 w-3.5 mr-1.5" />Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const folders = mediaData?.folders || [];
  const totalFiles = folders.reduce((sum, f) => sum + (f.files?.length || 0), 0);

  if (totalFiles === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-16 text-center">
          <div className="rounded-full bg-muted p-4 mb-4"><FolderOpen className="h-8 w-8 text-muted-foreground" /></div>
          <h3 className="text-sm font-semibold mb-1">Folder is empty</h3>
          <p className="text-xs text-muted-foreground max-w-sm">Files appear as the team uploads.</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{totalFiles} file{totalFiles !== 1 ? "s" : ""}</h3>
          <span className="text-xs text-muted-foreground">across {folders.length} folder{folders.length !== 1 ? "s" : ""}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => safeWindowOpen(deliverableLink)} className="text-xs h-7 px-2">
            <ExternalLink className="h-3.5 w-3.5 mr-1" />Open in Dropbox
          </Button>
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isFetching} className="text-xs h-7 px-2">
            <RefreshCw className={cn("h-3.5 w-3.5 mr-1", isFetching && "animate-spin")} />Refresh
          </Button>
        </div>
      </div>

      {folders.map((folder) => (
        <FolderSection key={folder.name} folder={folder} deliverableLink={deliverableLink} />
      ))}
    </div>
  );
}

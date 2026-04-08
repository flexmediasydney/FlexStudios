import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Heart, Star, Search, Camera, Film, FileText, File,
  ExternalLink, Clock, Grid2x2, Grid3x3, LayoutGrid,
  Tag, FolderOpen, Building2, ImageOff, Play, User,
  Activity, Filter, X
} from "lucide-react";
import { safeWindowOpen } from "@/utils/sanitizeHtml";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { createPageUrl } from "@/utils";

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

// ---- Dropbox preview URL builder ----
// Parent share link for the Tonomo delivery folder
const DROPBOX_SHARE_BASE = 'https://www.dropbox.com/scl/fo/7wnvxwd9722243256h33m/ANBWjH-I1_RZbjyWt0n4Agg';
const DROPBOX_RLKEY = 'jhdry20jttkrn0o1v8bpmcsmf';
const TONOMO_PREFIX = '/flex media team folder/tonomo';

function buildDropboxPreviewUrl(fullPath) {
  if (!fullPath) return null;
  // Strip the shared-folder prefix to get the relative path within the share
  const lowerPath = fullPath.toLowerCase();
  const lowerPrefix = TONOMO_PREFIX.toLowerCase();
  let relativePath = fullPath;
  if (lowerPath.startsWith(lowerPrefix)) {
    relativePath = fullPath.slice(TONOMO_PREFIX.length);
  }
  // Ensure leading slash
  if (!relativePath.startsWith('/')) relativePath = '/' + relativePath;
  // Encode each path segment individually
  const encodedPath = relativePath.split('/').map(seg => encodeURIComponent(seg)).join('/');
  return `${DROPBOX_SHARE_BASE}${encodedPath}?rlkey=${DROPBOX_RLKEY}&dl=0`;
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

// ---- File Favorite Card ----
function FileFavoriteCard({ favorite, isVisible }) {
  const [blobUrl, setBlobUrl] = useState(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  const isImage = favorite.file_type === 'image';
  const proxyPath = favorite.tonomo_base_path && favorite.file_path
    ? `${favorite.tonomo_base_path}${favorite.file_path.startsWith('/') ? favorite.file_path : '/' + favorite.file_path}`
    : null;

  useEffect(() => {
    if (!isImage || !proxyPath || started.current) return;
    // fetchProxyImage stores blobs under "thumb::path", so look up with the same key
    const cached = blobCache.get(`thumb::${proxyPath}`);
    if (cached) { setBlobUrl(cached); return; }
    if (!isVisible) return;
    started.current = true;
    setLoading(true);
    loadQueue.push(async () => {
      const url = await fetchProxyImage(proxyPath, 'thumb');
      if (url) setBlobUrl(url);
      setLoading(false);
    });
    processQueue();
  }, [isImage, proxyPath, isVisible]);

  const handleClick = () => {
    // Construct Dropbox preview URL on the fly from the share link pattern
    // The full dropbox path = tonomo_base_path + file_path, minus the shared folder prefix
    if (proxyPath) {
      const dropboxUrl = buildDropboxPreviewUrl(proxyPath);
      if (dropboxUrl) { safeWindowOpen(dropboxUrl); return; }
    }
    if (favorite.preview_url) safeWindowOpen(favorite.preview_url);
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative rounded-xl overflow-hidden border bg-card transition-all hover:shadow-lg hover:-translate-y-0.5 text-left w-full focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {/* Thumbnail */}
      <div className="aspect-[4/3] bg-muted flex items-center justify-center overflow-hidden relative">
        {blobUrl ? (
          <img src={blobUrl} alt={favorite.file_name} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" loading="lazy" />
        ) : loading ? (
          <div className="w-full h-full animate-pulse bg-muted flex items-center justify-center">
            <Camera className="h-6 w-6 text-muted-foreground/20 animate-pulse" />
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
            <div className="bg-black/40 rounded-full p-2.5"><Play className="h-5 w-5 text-white fill-white" /></div>
          </div>
        )}

        {/* Favorite star */}
        <div className="absolute top-2 left-2">
          <Star className="h-4 w-4 text-yellow-400 fill-yellow-400 drop-shadow-md" />
        </div>

        {/* External link on hover */}
        <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <ExternalLink className="h-3.5 w-3.5 text-white drop-shadow-md" />
        </div>

        {/* Type badge for non-images */}
        {favorite.file_type !== 'image' && (
          <div className="absolute bottom-2 left-2">
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
              {favorite.file_type === 'video' ? 'Video' : (favorite.file_type || 'File')}
            </Badge>
          </div>
        )}
      </div>

      {/* Info */}
      <div className="p-2.5 space-y-1">
        <p className="text-xs font-medium truncate leading-tight" title={favorite.file_name}>{favorite.file_name}</p>
        {favorite.property_address && (
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground/70 truncate">
            <Building2 className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{favorite.property_address}</span>
          </div>
        )}
        {/* Tags */}
        {favorite.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {favorite.tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-[9px] px-1 py-0 h-3.5 bg-primary/5 text-primary border-primary/20">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          {favorite.created_by_name && (
            <>
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{favorite.created_by_name}</span>
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

// ---- Project Favorite Card ----
function ProjectFavoriteCard({ favorite }) {
  const navigate = useNavigate();

  const handleClick = () => {
    if (favorite.project_id) {
      navigate(createPageUrl("ProjectDetails") + `?id=${favorite.project_id}`);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className="group relative rounded-xl overflow-hidden border bg-card transition-all hover:shadow-lg hover:-translate-y-0.5 text-left w-full focus:outline-none focus:ring-2 focus:ring-primary"
    >
      {/* Project visual */}
      <div className="aspect-[4/3] bg-gradient-to-br from-primary/10 via-muted to-primary/5 flex items-center justify-center relative">
        <div className="text-center p-4">
          <FolderOpen className="h-10 w-10 text-primary/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground/80 line-clamp-2">{favorite.project_title || 'Untitled Project'}</p>
        </div>

        {/* Favorite star */}
        <div className="absolute top-2 left-2">
          <Star className="h-4 w-4 text-yellow-400 fill-yellow-400 drop-shadow-md" />
        </div>

        <div className="absolute top-2 right-2">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-background/80 backdrop-blur-sm">
            Project
          </Badge>
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
            {favorite.tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-[9px] px-1 py-0 h-3.5 bg-primary/5 text-primary border-primary/20">
                #{tag}
              </Badge>
            ))}
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground/60">
          {favorite.created_by_name && (
            <>
              <User className="h-2.5 w-2.5 shrink-0" />
              <span className="truncate">{favorite.created_by_name}</span>
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

// ---- Skeleton ----
function FavoriteSkeleton({ count = 8 }) {
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

// ---- Audit Log Entry ----
function AuditLogEntry({ entry }) {
  const actor = entry.performed_by_name || entry.user_name || 'Unknown';
  const action = entry.action || 'favorited';
  const target = entry.entity_name || entry.details?.file_name || entry.details?.project_title || 'an item';
  const tagInfo = entry.details?.tag ? ` with #${entry.details.tag}` : '';

  return (
    <div className="flex items-start gap-3 py-2 border-b border-border/40 last:border-0">
      <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Activity className="h-3 w-3 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-xs text-foreground">
          <span className="font-medium">{actor}</span>
          {' '}{action}{' '}
          <span className="font-medium">{target}</span>
          {tagInfo}
        </p>
        {entry.created_date && (
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">{timeAgo(entry.created_date)}</p>
        )}
      </div>
    </div>
  );
}

// ---- Tag Filter Multi-Select ----
function TagFilterSelect({ availableTags, selectedTags, onToggle }) {
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
      </Button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-50 w-52 bg-popover border rounded-lg shadow-lg p-2 space-y-0.5 max-h-60 overflow-y-auto">
          {selectedTags.length > 0 && (
            <button
              onClick={() => { selectedTags.forEach(t => onToggle(t)); }}
              className="w-full text-left text-[11px] text-muted-foreground hover:text-foreground px-2 py-1 rounded hover:bg-muted/50 mb-1"
            >
              Clear all
            </button>
          )}
          {availableTags.map(tag => (
            <button
              key={tag.name}
              onClick={() => onToggle(tag.name)}
              className={cn(
                "w-full text-left text-xs px-2 py-1.5 rounded flex items-center gap-2 transition-colors",
                selectedTags.includes(tag.name) ? "bg-primary/10 text-primary" : "hover:bg-muted/50 text-foreground"
              )}
            >
              <span className={cn(
                "w-3 h-3 rounded border flex items-center justify-center shrink-0",
                selectedTags.includes(tag.name) ? "bg-primary border-primary" : "border-muted-foreground/30"
              )}>
                {selectedTags.includes(tag.name) && (
                  <svg className="w-2 h-2 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </span>
              <span>#{tag.name}</span>
              {tag.usage_count > 0 && (
                <span className="ml-auto text-[10px] text-muted-foreground/50">{tag.usage_count}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ================ MAIN COMPONENT ================

export default function SocialMedia() {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [gridSize, setGridSize] = useState('md');
  const [selectedTags, setSelectedTags] = useState([]);
  const [visibleCards, setVisibleCards] = useState(new Set());
  const gridRef = useRef(null);

  // Load data
  const { data: favorites = [], loading: favoritesLoading } = useEntityList('MediaFavorite', '-created_date', 500);
  const { data: mediaTags = [] } = useEntityList('MediaTag', 'name', 200);
  const { data: auditLogs = [], loading: auditLoading } = useEntityList('AuditLog', '-created_date', 200);

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

  // Filter favorites
  const filteredFavorites = useMemo(() => {
    return favorites.filter(fav => {
      // Type filter
      if (typeFilter === 'file' && !fav.file_path) return false;
      if (typeFilter === 'project' && !fav.project_id) return false;

      // Tag filter
      if (selectedTags.length > 0) {
        const favTags = fav.tags || [];
        if (!selectedTags.some(t => favTags.includes(t))) return false;
      }

      // Search filter
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
    <div className="p-4 lg:p-6 space-y-6 max-w-[1600px] mx-auto">
      {/* ---- Header ---- */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight flex items-center gap-2">
            <Heart className="h-5 w-5 text-red-500" />
            Favorites
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {isLoading
              ? 'Loading your favorites...'
              : `${stats.total} favorited item${stats.total !== 1 ? 's' : ''}`}
          </p>
        </div>

        {/* Stat badges */}
        {!isLoading && stats.total > 0 && (
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="text-[11px] bg-blue-50 text-blue-600 border-blue-200 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800 gap-1">
              <Camera className="h-3 w-3" /> {stats.files} file{stats.files !== 1 ? 's' : ''}
            </Badge>
            <Badge variant="outline" className="text-[11px] bg-purple-50 text-purple-600 border-purple-200 dark:bg-purple-900/20 dark:text-purple-400 dark:border-purple-800 gap-1">
              <FolderOpen className="h-3 w-3" /> {stats.projects} project{stats.projects !== 1 ? 's' : ''}
            </Badge>
            <Badge variant="outline" className="text-[11px] bg-amber-50 text-amber-600 border-amber-200 dark:bg-amber-900/20 dark:text-amber-400 dark:border-amber-800 gap-1">
              <Tag className="h-3 w-3" /> {stats.tags} tag{stats.tags !== 1 ? 's' : ''}
            </Badge>
          </div>
        )}
      </div>

      {/* ---- Filter bar ---- */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Search */}
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search by file name, project, address, tags..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {/* Tag filter */}
        <TagFilterSelect
          availableTags={mediaTags}
          selectedTags={selectedTags}
          onToggle={toggleTag}
        />

        {/* Type filter */}
        <div className="flex items-center border rounded-md overflow-hidden shrink-0">
          {TYPE_FILTERS.map(({ value, label }) => (
            <button
              key={value}
              onClick={() => setTypeFilter(value)}
              className={cn(
                "px-2.5 py-1 text-xs transition-colors",
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
        <span className="text-[11px] text-muted-foreground shrink-0">
          {filteredFavorites.length} result{filteredFavorites.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Active tag filters display */}
      {selectedTags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[11px] text-muted-foreground">Filtering by:</span>
          {selectedTags.map(tag => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-[11px] gap-1 cursor-pointer hover:bg-destructive/10 hover:text-destructive transition-colors"
              onClick={() => toggleTag(tag)}
            >
              #{tag}
              <X className="h-2.5 w-2.5" />
            </Badge>
          ))}
        </div>
      )}

      {/* ---- Grid ---- */}
      {isLoading ? (
        <FavoriteSkeleton />
      ) : filteredFavorites.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="rounded-full bg-muted p-4 mb-4">
              {favorites.length > 0 ? (
                <Search className="h-8 w-8 text-muted-foreground" />
              ) : (
                <Heart className="h-8 w-8 text-muted-foreground" />
              )}
            </div>
            <h3 className="text-sm font-semibold mb-1">
              {favorites.length > 0
                ? 'No favorites match your filters'
                : 'No favorites yet'}
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm">
              {favorites.length > 0
                ? 'Try adjusting the type filter, tags, or search query.'
                : 'Star files or projects from the Media tab to see them here.'}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div
          ref={gridRef}
          className={cn("grid", GRID_SIZES[gridSize])}
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
                  />
                ) : (
                  <ProjectFavoriteCard favorite={fav} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ---- Audit Log Section ---- */}
      {!isLoading && (
        <div className="space-y-3 pt-4 border-t">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Recent Activity</h2>
            {favoriteAuditLogs.length > 0 && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                {favoriteAuditLogs.length}
              </Badge>
            )}
          </div>

          {auditLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 py-2">
                  <Skeleton className="w-6 h-6 rounded-full" />
                  <div className="flex-1 space-y-1">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : favoriteAuditLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">
              No favorite/tag activity recorded yet.
            </p>
          ) : (
            <div className="divide-y-0">
              {favoriteAuditLogs.map(entry => (
                <AuditLogEntry key={entry.id} entry={entry} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

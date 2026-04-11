import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Zap, Search, Image, Film, FileText, File, ChevronDown, ChevronRight,
  RefreshCw, Table2, FolderOpen, ArrowUpDown, Clock
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return "—";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function getTypeColor(ext) {
  const e = ext?.toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "heic", "tiff"].includes(e))
    return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  if (["mp4", "mov", "avi", "mkv", "wmv"].includes(e))
    return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  if (["pdf", "doc", "docx"].includes(e))
    return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
  return "bg-muted text-muted-foreground";
}

function getSourceBadge(file) {
  // Source = which Dropbox working directory the file comes from
  if (file.source === "video") {
    return { label: "Video Files", icon: Film, color: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-400" };
  }
  return { label: "Images/Other", icon: Image, color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" };
}

function getTypeBadge(ext) {
  const e = ext?.toLowerCase();
  if (["jpg", "jpeg", "png", "webp", "heic", "tiff"].includes(e)) return { label: "IMG", color: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400" };
  if (["mp4", "mov", "avi", "mkv", "wmv", "mxf", "prores"].includes(e)) return { label: "VID", color: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-400" };
  if (["pdf", "doc", "docx"].includes(e)) return { label: "DOC", color: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400" };
  if (["zip", "rar", "7z"].includes(e)) return { label: "ZIP", color: "bg-muted text-muted-foreground" };
  return { label: e?.toUpperCase() || "FILE", color: "bg-muted text-muted-foreground" };
}

function isImageExt(ext) {
  return ["jpg", "jpeg", "png", "webp", "heic", "tiff", "raw", "cr2", "nef", "arw"].includes(ext?.toLowerCase());
}

function isVideoExt(ext) {
  return ["mp4", "mov", "avi", "mkv", "wmv", "mxf", "prores"].includes(ext?.toLowerCase());
}

const PAGE_SIZE = 100;

// ── Sort comparator ──────────────────────────────────────────────────────────

function buildComparator(sortBy, sortDir) {
  const dir = sortDir === "asc" ? 1 : -1;
  return (a, b) => {
    let av, bv;
    switch (sortBy) {
      case "name":
        av = (a.name || "").toLowerCase();
        bv = (b.name || "").toLowerCase();
        return dir * av.localeCompare(bv);
      case "size":
        av = a.size ?? 0;
        bv = b.size ?? 0;
        return dir * (av - bv);
      case "property":
        av = (a.property || "").toLowerCase();
        bv = (b.property || "").toLowerCase();
        return dir * av.localeCompare(bv);
      case "type":
        av = (a.extension || "").toLowerCase();
        bv = (b.extension || "").toLowerCase();
        return dir * av.localeCompare(bv);
      case "source":
        av = (a.source || "").toLowerCase();
        bv = (b.source || "").toLowerCase();
        return dir * av.localeCompare(bv);
      case "client_modified":
        av = a.client_modified ? new Date(a.client_modified).getTime() : 0;
        bv = b.client_modified ? new Date(b.client_modified).getTime() : 0;
        return dir * (av - bv);
      case "server_modified":
      default:
        av = a.server_modified ? new Date(a.server_modified).getTime() : 0;
        bv = b.server_modified ? new Date(b.server_modified).getTime() : 0;
        return dir * (av - bv);
    }
  };
}

// ── Sortable column header ───────────────────────────────────────────────────

function SortHeader({ label, field, sortBy, sortDir, onSort, className }) {
  const active = sortBy === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold text-muted-foreground hover:text-foreground transition-colors select-none",
        active && "text-foreground",
        className
      )}
    >
      {label}
      <ArrowUpDown className={cn("h-3 w-3 shrink-0", active ? "opacity-100" : "opacity-30")} />
      {active && (
        <span className="text-[8px] opacity-60">{sortDir === "asc" ? "\u25B2" : "\u25BC"}</span>
      )}
    </button>
  );
}

// ── File row ─────────────────────────────────────────────────────────────────

function FileRow({ file, idx }) {
  const source = getSourceBadge(file);
  const SourceIcon = source.icon;
  const typeBadge = getTypeBadge(file.extension);
  const created = file.client_modified
    ? formatDistanceToNow(new Date(file.client_modified), { addSuffix: true })
    : "—";
  const modified = file.server_modified
    ? formatDistanceToNow(new Date(file.server_modified), { addSuffix: true })
    : "—";

  return (
    <tr className={cn(
      "group border-b border-border/30 hover:bg-muted/30 transition-colors",
      idx % 2 === 0 && "bg-muted/10"
    )}>
      {/* Source Directory */}
      <td className="px-3 py-2">
        <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold whitespace-nowrap", source.color)}>
          <SourceIcon className="h-3 w-3" />
          {source.label}
        </span>
      </td>
      {/* Property */}
      <td className="px-3 py-2 max-w-[160px]">
        <span className="text-xs font-mono truncate block" title={file.property || "—"}>
          {file.property || "Root"}
        </span>
      </td>
      {/* File Name */}
      <td className="px-3 py-2 max-w-[220px]">
        <span className="text-xs truncate block" title={file.name || "—"}>
          {file.name || "—"}
        </span>
      </td>
      {/* Type */}
      <td className="px-3 py-2">
        <span className={cn("inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold", typeBadge.color)}>
          {typeBadge.label}
        </span>
      </td>
      {/* Size */}
      <td className="px-3 py-2 text-right">
        <span className="text-xs font-mono tabular-nums">{formatSize(file.size)}</span>
      </td>
      {/* Created */}
      <td className="px-3 py-2 text-right hidden lg:table-cell">
        <span className="text-xs font-mono text-muted-foreground tabular-nums" title={file.client_modified || ""}>{created}</span>
      </td>
      {/* Modified */}
      <td className="px-3 py-2 text-right">
        <span className="text-xs font-mono text-muted-foreground tabular-nums" title={file.server_modified || ""}>{modified}</span>
      </td>
    </tr>
  );
}

// ── Property group row (collapsible) ─────────────────────────────────────────

function PropertyGroup({ property, files, sortBy, sortDir, onSort }) {
  const [expanded, setExpanded] = useState(false);

  const imageCount = files.filter(f => isImageExt(f.extension)).length;
  const videoCount = files.filter(f => isVideoExt(f.extension)).length;
  const totalSize = files.reduce((s, f) => s + (f.size || 0), 0);
  const latestMod = files.reduce((latest, f) => {
    const t = f.modified ? new Date(f.modified).getTime() : 0;
    return t > latest ? t : latest;
  }, 0);

  const sorted = useMemo(
    () => [...files].sort(buildComparator(sortBy, sortDir)),
    [files, sortBy, sortDir]
  );

  return (
    <div className="border border-border/40 rounded-lg mb-2 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded(p => !p)}
        className="w-full flex items-center gap-3 px-4 py-2.5 bg-muted/20 hover:bg-muted/40 transition-colors text-left"
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        }
        <span className="font-semibold text-sm truncate flex-1">{property}</span>
        <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-muted-foreground shrink-0">
          <span>{files.length} files</span>
          {imageCount > 0 && (
            <span className="flex items-center gap-1">
              <Image className="h-3 w-3 text-blue-400" /> {imageCount}
            </span>
          )}
          {videoCount > 0 && (
            <span className="flex items-center gap-1">
              <Film className="h-3 w-3 text-purple-400" /> {videoCount}
            </span>
          )}
          <span>{formatSize(totalSize)}</span>
          {latestMod > 0 && (
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {formatDistanceToNow(new Date(latestMod), { addSuffix: false })}
            </span>
          )}
        </div>
      </button>

      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="bg-muted/50 border-b border-border/50">
                <th className="px-3 py-1.5 w-[70px]">
                  <SortHeader label="Source" field="type" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                </th>
                <th className="px-3 py-1.5">
                  <SortHeader label="File Name" field="name" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                </th>
                <th className="px-3 py-1.5 w-[70px]">
                  <SortHeader label="Type" field="type" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
                </th>
                <th className="px-3 py-1.5 w-[80px] text-right">
                  <SortHeader label="Size" field="size" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="justify-end" />
                </th>
                <th className="px-3 py-1.5 w-[90px] text-right">
                  <SortHeader label="Modified" field="modified" sortBy={sortBy} sortDir={sortDir} onSort={onSort} className="justify-end" />
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((file, idx) => (
                <FileRow key={file.id || `${file.name}-${idx}`} file={file} idx={idx} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Skeleton table rows ──────────────────────────────────────────────────────

function TableSkeleton({ rows = 8 }) {
  return (
    <div className="space-y-0">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className={cn("flex items-center gap-3 px-3 py-2.5 border-b border-border/30", i % 2 === 0 && "bg-muted/10")}>
          <Skeleton className="h-5 w-12 rounded" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-4 flex-1 max-w-[180px]" />
          <Skeleton className="h-5 w-10 rounded" />
          <Skeleton className="h-4 w-14 ml-auto" />
          <Skeleton className="h-4 w-12" />
        </div>
      ))}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function WorkingFilesPulse() {
  const [view, setView] = useState("transaction"); // "transaction" | "property"
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all"); // "all" | "images" | "video"
  const [typeFilter, setTypeFilter] = useState("all"); // "all" | "photos" | "videos" | "documents"
  const [sortBy, setSortBy] = useState("server_modified");
  const [sortDir, setSortDir] = useState("desc");
  const [visibleRows, setVisibleRows] = useState(PAGE_SIZE);
  const [countdown, setCountdown] = useState(45);
  const countdownRef = useRef(null);

  // ── Data fetching ────────────────────────────────────────────────────────

  const { data, isLoading, isError, dataUpdatedAt, refetch } = useQuery({
    queryKey: ["working-files-feed"],
    queryFn: async () => {
      const res = await api.functions.invoke("getWorkingFilesFeed", {});
      return res?.data || res || {};
    },
    refetchInterval: 45_000,
    staleTime: 30_000,
  });

  const files = useMemo(() => data?.files || [], [data]);

  // ── Auto-refresh countdown ───────────────────────────────────────────────

  useEffect(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(45);
    countdownRef.current = setInterval(() => {
      setCountdown(prev => (prev <= 1 ? 45 : prev - 1));
    }, 1000);
    return () => clearInterval(countdownRef.current);
  }, [dataUpdatedAt]);

  // ── Sorting handler ──────────────────────────────────────────────────────

  const handleSort = useCallback((field) => {
    setSortBy(prev => {
      if (prev === field) {
        setSortDir(d => (d === "asc" ? "desc" : "asc"));
        return field;
      }
      setSortDir("desc");
      return field;
    });
  }, []);

  // ── Filtering ────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    let result = files;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(f =>
        (f.name || "").toLowerCase().includes(q) ||
        (f.property || "").toLowerCase().includes(q) ||
        (f.extension || "").toLowerCase().includes(q)
      );
    }

    // Source filter (which Dropbox directory)
    if (sourceFilter === "images") {
      result = result.filter(f => f.source === "images");
    } else if (sourceFilter === "video") {
      result = result.filter(f => f.source === "video");
    }

    // Type filter
    if (typeFilter === "photos") {
      result = result.filter(f => isImageExt(f.extension));
    } else if (typeFilter === "videos") {
      result = result.filter(f => isVideoExt(f.extension));
    } else if (typeFilter === "documents") {
      result = result.filter(f => ["pdf", "doc", "docx"].includes(f.extension?.toLowerCase()));
    }

    return result;
  }, [files, search, sourceFilter, typeFilter]);

  // ── Sorted results ──────────────────────────────────────────────────────

  const sorted = useMemo(
    () => [...filtered].sort(buildComparator(sortBy, sortDir)),
    [filtered, sortBy, sortDir]
  );

  const visible = sorted.slice(0, visibleRows);
  const hasMore = sorted.length > visibleRows;

  // ── Stats ────────────────────────────────────────────────────────────────

  const stats = useMemo(() => {
    const total = files.length;
    const images = files.filter(f => isImageExt(f.extension)).length;
    const videos = files.filter(f => isVideoExt(f.extension)).length;
    const properties = new Set(files.map(f => f.property).filter(Boolean)).size;
    return { total, images, videos, properties };
  }, [files]);

  // ── Property grouping ──────────────────────────────────────────────────

  const propertyGroups = useMemo(() => {
    const groups = {};
    for (const f of filtered) {
      const key = f.property || "Ungrouped";
      if (!groups[key]) groups[key] = [];
      groups[key].push(f);
    }
    // Sort groups by latest modified
    return Object.entries(groups).sort(([, a], [, b]) => {
      const la = Math.max(...a.map(f => f.modified ? new Date(f.modified).getTime() : 0));
      const lb = Math.max(...b.map(f => f.modified ? new Date(f.modified).getTime() : 0));
      return lb - la;
    });
  }, [filtered]);

  // ── Filter pill helper ────────────────────────────────────────────────

  const pillClass = (active) =>
    cn(
      "px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wide transition-colors cursor-pointer select-none",
      active
        ? "bg-primary text-primary-foreground"
        : "bg-muted/50 text-muted-foreground hover:bg-muted"
    );

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <Card className="bg-card border rounded-lg overflow-hidden">
      <CardHeader className="pb-3 space-y-3">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4 text-yellow-500" />
            Working Files Feed
          </CardTitle>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground font-mono tabular-nums">
            <Clock className="h-3 w-3" />
            <span>Refreshing in {countdown}s</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              onClick={() => refetch()}
              title="Refresh now"
            >
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        </div>

        {/* Stats strip */}
        <div className="flex items-center gap-3 flex-wrap">
          <StatPill label="Total Files" value={stats.total} icon={File} />
          <StatPill label="Images" value={stats.images} icon={Image} color="text-blue-400" />
          <StatPill label="Videos" value={stats.videos} icon={Film} color="text-purple-400" />
          <StatPill label="Properties" value={stats.properties} icon={FolderOpen} color="text-green-400" />
        </div>

        {/* Controls row */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 flex-wrap">
          {/* View toggle */}
          <div className="flex items-center gap-1 bg-muted/30 rounded-lg p-0.5">
            <button
              type="button"
              onClick={() => setView("transaction")}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                view === "transaction" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Table2 className="h-3.5 w-3.5" /> Transaction
            </button>
            <button
              type="button"
              onClick={() => setView("property")}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors",
                view === "property" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <FolderOpen className="h-3.5 w-3.5" /> Property
            </button>
          </div>

          {/* Search */}
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search files, properties, types..."
              className="pl-8 h-8 text-xs"
            />
          </div>

          {/* Source filter pills */}
          <div className="flex items-center gap-1">
            <button type="button" className={pillClass(sourceFilter === "all")} onClick={() => setSourceFilter("all")}>All</button>
            <button type="button" className={pillClass(sourceFilter === "images")} onClick={() => setSourceFilter("images")}>
              <span className="flex items-center gap-1"><Image className="h-3 w-3" /> Images</span>
            </button>
            <button type="button" className={pillClass(sourceFilter === "video")} onClick={() => setSourceFilter("video")}>
              <span className="flex items-center gap-1"><Film className="h-3 w-3" /> Video</span>
            </button>
          </div>

          {/* Type filter pills */}
          <div className="flex items-center gap-1">
            <button type="button" className={pillClass(typeFilter === "all")} onClick={() => setTypeFilter("all")}>All</button>
            <button type="button" className={pillClass(typeFilter === "photos")} onClick={() => setTypeFilter("photos")}>Photos</button>
            <button type="button" className={pillClass(typeFilter === "videos")} onClick={() => setTypeFilter("videos")}>Videos</button>
            <button type="button" className={pillClass(typeFilter === "documents")} onClick={() => setTypeFilter("documents")}>Docs</button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {/* Loading */}
        {isLoading && <TableSkeleton />}

        {/* Error */}
        {isError && !isLoading && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Zap className="h-8 w-8 text-destructive mb-2" />
            <p className="text-sm font-medium text-destructive">Failed to connect to Dropbox. Check configuration.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => refetch()}>
              <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
            </Button>
          </div>
        )}

        {/* Empty */}
        {!isLoading && !isError && files.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <FolderOpen className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No files found in working directories</p>
          </div>
        )}

        {/* No filter results */}
        {!isLoading && !isError && files.length > 0 && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Search className="h-8 w-8 text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">No files match your filters</p>
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => { setSearch(""); setSourceFilter("all"); setTypeFilter("all"); }}>
              Clear filters
            </Button>
          </div>
        )}

        {/* Transaction view */}
        {!isLoading && !isError && filtered.length > 0 && view === "transaction" && (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="bg-muted/50 border-b border-border/50">
                  <th className="px-3 py-2 w-[100px]">
                    <SortHeader label="Source" field="source" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-3 py-2">
                    <SortHeader label="Property" field="property" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-3 py-2">
                    <SortHeader label="File Name" field="name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-3 py-2 w-[60px]">
                    <SortHeader label="Type" field="type" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                  </th>
                  <th className="px-3 py-2 w-[80px] text-right">
                    <SortHeader label="Size" field="size" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="justify-end" />
                  </th>
                  <th className="px-3 py-2 w-[100px] text-right hidden lg:table-cell">
                    <SortHeader label="Created" field="client_modified" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="justify-end" />
                  </th>
                  <th className="px-3 py-2 w-[100px] text-right">
                    <SortHeader label="Modified" field="server_modified" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} className="justify-end" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((file, idx) => (
                  <FileRow key={file.id || `${file.name}-${idx}`} file={file} idx={idx} />
                ))}
              </tbody>
            </table>

            {/* Load more */}
            {hasMore && (
              <div className="flex items-center justify-center py-3 border-t border-border/30">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs font-mono"
                  onClick={() => setVisibleRows(prev => prev + PAGE_SIZE)}
                >
                  Load more ({sorted.length - visibleRows} remaining)
                </Button>
              </div>
            )}

            {/* Row count footer */}
            <div className="flex items-center justify-between px-3 py-2 bg-muted/20 border-t border-border/30 text-[10px] text-muted-foreground font-mono tabular-nums">
              <span>Showing {Math.min(visibleRows, sorted.length)} of {sorted.length} files</span>
              <span>{filtered.length !== files.length && `${files.length} total \u00B7 `}{filtered.length} matched</span>
            </div>
          </div>
        )}

        {/* Property view */}
        {!isLoading && !isError && filtered.length > 0 && view === "property" && (
          <div className="p-3 space-y-0">
            {propertyGroups.map(([property, groupFiles]) => (
              <PropertyGroup
                key={property}
                property={property}
                files={groupFiles}
                sortBy={sortBy}
                sortDir={sortDir}
                onSort={handleSort}
              />
            ))}
            <div className="text-center py-2 text-[10px] text-muted-foreground font-mono tabular-nums">
              {propertyGroups.length} properties \u00B7 {filtered.length} files
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Stat pill ────────────────────────────────────────────────────────────────

function StatPill({ label, value, icon: Icon, color }) {
  return (
    <div className="flex items-center gap-1.5 bg-muted/30 rounded-full px-3 py-1">
      <Icon className={cn("h-3.5 w-3.5", color || "text-muted-foreground")} />
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <span className="text-xs font-mono font-bold tabular-nums">{value}</span>
    </div>
  );
}

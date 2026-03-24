import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useQuery } from '@tanstack/react-query';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { motion, AnimatePresence } from 'framer-motion';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import {
  X, ChevronLeft, ChevronRight, Download, ZoomIn, ZoomOut,
  Play, Film, FileText, Image as ImageIcon, Loader2, RefreshCw,
  Maximize2, Minimize2, Search, Filter, Camera, Building2
} from 'lucide-react';
import { differenceInDays, format } from 'date-fns';

// ─── Constants ────────────────────────────────────────────────────────────────
const STAGES_WITH_MEDIA = [
  { value: 'all',              label: 'All stages' },
  { value: 'delivered',        label: 'Delivered' },
  { value: 'ready_for_partial',label: 'Ready for Partial' },
  { value: 'in_revision',      label: 'In Revision' },
  { value: 'in_progress',      label: 'In Progress' },
  { value: 'submitted',        label: 'Submitted' },
  { value: 'uploaded',         label: 'Uploaded' },
];

const DATE_RANGES = [
  { value: '7',   label: 'Last 7 days' },
  { value: '30',  label: 'Last 30 days' },
  { value: '90',  label: 'Last 3 months' },
  { value: '180', label: 'Last 6 months' },
  { value: '0',   label: 'All time' },
];

const TYPE_LABELS = {
  image:    { label: 'Photo',     color: 'bg-blue-100 text-blue-700',   icon: ImageIcon },
  video:    { label: 'Video',     color: 'bg-purple-100 text-purple-700', icon: Film },
  document: { label: 'Floorplan', color: 'bg-amber-100 text-amber-700', icon: FileText },
  other:    { label: 'File',      color: 'bg-slate-100 text-slate-600', icon: FileText },
};

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function fmtDuration(ms) {
  if (!ms) return null;
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// ─── Lightbox ─────────────────────────────────────────────────────────────────
function Lightbox({ files, initialIndex, projectName, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const [zoom, setZoom] = useState(1);
  const [tempUrl, setTempUrl] = useState(null);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const file = files[index];
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const fetchTempUrl = useCallback(async (path) => {
    setLoadingUrl(true);
    setTempUrl(null);
    try {
      const res = await api.functions.invoke('getDeliveryMediaFeed', {
        action: 'get_temp_link', path
      });
      // BUG FIX: guard setState with mounted check so navigating away
      // mid-fetch doesn't trigger a memory leak / React warning.
      if (mountedRef.current) setTempUrl(res?.url || null);
    } catch { if (mountedRef.current) setTempUrl(null); }
    finally { if (mountedRef.current) setLoadingUrl(false); }
  }, []);

  useEffect(() => {
    setZoom(1);
    setTempUrl(null);
    if (file && (file.type === 'video' || !file.thumbnail)) {
      fetchTempUrl(file.path);
    }
  }, [index, file]);

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight') setIndex(i => Math.min(i + 1, files.length - 1));
      if (e.key === 'ArrowLeft')  setIndex(i => Math.max(i - 1, 0));
      if (e.key === 'Escape')     onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [files.length, onClose]);

  if (!file) return null;
  const typeInfo = TYPE_LABELS[file.type] || TYPE_LABELS.other;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-50 bg-black/95 flex flex-col"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/60 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Badge className={`text-xs shrink-0 ${typeInfo.color}`}>{typeInfo.label}</Badge>
          <p className="text-white text-sm font-medium truncate">{file.name}</p>
          {file.size && <span className="text-white/40 text-xs shrink-0">{fmtSize(file.size)}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0 ml-3">
          {file.type === 'image' && (
            <>
              <button onClick={() => setZoom(z => Math.max(0.5, z - 0.25))}
                className="text-white/60 hover:text-white p-1.5 rounded hover:bg-card/10">
                <ZoomOut className="h-4 w-4" />
              </button>
              <span className="text-white/40 text-xs w-10 text-center">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(4, z + 0.25))}
                className="text-white/60 hover:text-white p-1.5 rounded hover:bg-card/10">
                <ZoomIn className="h-4 w-4" />
              </button>
            </>
          )}
          {(tempUrl || file.thumbnail) && (
            <a href={tempUrl || `data:image/jpeg;base64,${file.thumbnail}`}
              download={file.name}
              className="text-white/60 hover:text-white p-1.5 rounded hover:bg-card/10">
              <Download className="h-4 w-4" />
            </a>
          )}
          <button onClick={onClose}
            className="text-white/60 hover:text-white p-1.5 rounded hover:bg-card/10">
            <X className="h-5 w-5" />
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center min-h-0 relative overflow-hidden">
        {/* Prev */}
        {index > 0 && (
          <button onClick={() => setIndex(i => i - 1)}
            className="absolute left-3 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors">
            <ChevronLeft className="h-6 w-6" />
          </button>
        )}

        {/* Content area */}
        <div className="flex items-center justify-center w-full h-full p-4 overflow-auto">
          {file.type === 'video' ? (
            loadingUrl ? (
              <div className="flex flex-col items-center gap-3 text-white/50">
                <Loader2 className="h-8 w-8 animate-spin" />
                <p className="text-sm">Loading video…</p>
              </div>
            ) : tempUrl ? (
              <video
                src={tempUrl}
                controls
                autoPlay
                className="max-w-full max-h-full rounded-lg shadow-2xl"
                style={{ maxHeight: 'calc(100vh - 140px)' }}
              >
                Your browser does not support video playback.
              </video>
            ) : (
              <div className="text-white/40 text-sm">Could not load video</div>
            )
          ) : file.type === 'document' ? (
            <div className="flex flex-col items-center gap-4">
              {file.thumbnail ? (
                <img
                  src={`data:image/jpeg;base64,${file.thumbnail}`}
                  alt={file.name}
                  className="max-w-full rounded-lg shadow-2xl"
                  style={{ maxHeight: 'calc(100vh - 200px)' }}
                />
              ) : (
                <FileText className="h-24 w-24 text-white/20" />
              )}
              {tempUrl && (
                <a href={tempUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="outline" size="sm" className="text-white border-white/30 hover:bg-card/10">
                    Open PDF <Download className="h-3 w-3 ml-1.5" />
                  </Button>
                </a>
              )}
            </div>
          ) : (
            /* Image */
            file.thumbnail ? (
              <div
                className="transition-transform duration-200 cursor-zoom-in"
                style={{ transform: `scale(${zoom})`, transformOrigin: 'center' }}
                onClick={() => setZoom(z => z < 2 ? z + 0.5 : 1)}
              >
                <img
                  src={tempUrl ? tempUrl : `data:image/jpeg;base64,${file.thumbnail}`}
                  alt={file.name}
                  className="max-w-full rounded shadow-2xl select-none"
                  style={{ maxHeight: 'calc(100vh - 140px)' }}
                />
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 text-white/30">
                <ImageIcon className="h-16 w-16" />
                <p className="text-sm">{file.name}</p>
              </div>
            )
          )}
        </div>

        {/* Next */}
        {index < files.length - 1 && (
          <button onClick={() => setIndex(i => i + 1)}
            className="absolute right-3 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/80 transition-colors">
            <ChevronRight className="h-6 w-6" />
          </button>
        )}
      </div>

      {/* Bottom strip: project info + thumbnail strip */}
      <div className="shrink-0 bg-black/60 border-t border-white/10">
        <div className="px-4 py-2 flex items-center justify-between">
          <p className="text-white/50 text-xs">{projectName}</p>
          <p className="text-white/30 text-xs">{index + 1} / {files.length}</p>
        </div>
        {/* Thumbnail filmstrip */}
        <div className="flex gap-1.5 px-4 pb-3 overflow-x-auto">
          {files.map((f, i) => (
            <button
              key={f.path}
              onClick={() => setIndex(i)}
              className={cn(
                'shrink-0 w-12 h-12 rounded overflow-hidden border-2 transition-all',
                i === index ? 'border-white' : 'border-transparent opacity-50 hover:opacity-75'
              )}
            >
              {f.thumbnail ? (
                <img src={`data:image/jpeg;base64,${f.thumbnail}`} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full bg-card/10 flex items-center justify-center">
                  {f.type === 'video' ? <Film className="h-4 w-4 text-white/40" /> : <FileText className="h-4 w-4 text-white/40" />}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </motion.div>
  );
}

// ─── Media tile ───────────────────────────────────────────────────────────────
function MediaTile({ file, onClick }) {
  const typeInfo = TYPE_LABELS[file.type] || TYPE_LABELS.other;
  const Icon = typeInfo.icon;

  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.02 }}
      transition={{ duration: 0.15 }}
      onClick={onClick}
      className="relative group rounded-xl overflow-hidden bg-muted border border-border/40 aspect-square focus:outline-none focus:ring-2 focus:ring-primary"
      title={file.name}
    >
      {file.thumbnail ? (
        <>
          <img
            src={`data:image/jpeg;base64,${file.thumbnail}`}
            alt={file.name}
            className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
            loading="lazy"
          />
          {/* Video play overlay */}
          {file.type === 'video' && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="bg-black/50 rounded-full p-3 group-hover:bg-black/70 transition-colors">
                <Play className="h-6 w-6 text-white fill-white" />
              </div>
              {file.duration && (
                <span className="absolute bottom-2 right-2 bg-black/70 text-white text-[10px] px-1.5 py-0.5 rounded font-mono">
                  {fmtDuration(file.duration)}
                </span>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="w-full h-full flex flex-col items-center justify-center gap-2 bg-muted/50">
          <Icon className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-[10px] text-muted-foreground/60 px-2 text-center line-clamp-2">{file.name}</p>
        </div>
      )}

      {/* Type badge on hover */}
      <div className="absolute top-1.5 left-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <Badge className={`text-[10px] py-0 px-1.5 ${typeInfo.color}`}>{typeInfo.label}</Badge>
      </div>

      {/* Filename tooltip on hover */}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-2
        opacity-0 group-hover:opacity-100 transition-opacity">
        <p className="text-white text-[10px] truncate">{file.name}</p>
      </div>
    </motion.button>
  );
}

// ─── Project media block ───────────────────────────────────────────────────────
function ProjectMediaBlock({ project, onOpenLightbox }) {
  const [status, setStatus] = useState('idle'); // idle | loading | done | error
  const [files, setFiles] = useState([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const blockMountedRef = useRef(true);

  useEffect(() => {
    blockMountedRef.current = true;
    return () => { blockMountedRef.current = false; };
  }, []);

  // BUG FIX: guard setState calls with mounted check so unmounting mid-fetch
  // doesn't cause setState-after-unmount warnings and memory leaks.
  const load = useCallback(async () => {
    if (!project.tonomo_deliverable_path) return;
    setStatus('loading');
    setErrorMsg('');
    try {
      const res = await api.functions.invoke('getDeliveryMediaFeed', {
        path: project.tonomo_deliverable_path
      });
      if (!blockMountedRef.current) return;
      setFiles(res?.files || []);
      setStatus('done');
    } catch (e) {
      if (!blockMountedRef.current) return;
      setErrorMsg(e?.message || 'Failed to load media');
      setStatus('error');
    }
  }, [project.tonomo_deliverable_path]);

  // Auto-load on mount
  useEffect(() => { load(); }, [load]);

  const visibleFiles = useMemo(() =>
    typeFilter === 'all' ? files : files.filter(f => f.type === typeFilter),
  [files, typeFilter]);

  const counts = useMemo(() => ({
    image:    files.filter(f => f.type === 'image').length,
    video:    files.filter(f => f.type === 'video').length,
    document: files.filter(f => f.type === 'document').length,
  }), [files]);

  const stageConfig = {
    delivered:         { color: 'bg-emerald-100 text-emerald-700', label: 'Delivered' },
    ready_for_partial: { color: 'bg-indigo-100 text-indigo-700',  label: 'Ready for Partial' },
    in_revision:       { color: 'bg-amber-100 text-amber-700',    label: 'In Revision' },
    in_progress:       { color: 'bg-violet-100 text-violet-700',  label: 'In Progress' },
    submitted:         { color: 'bg-purple-100 text-purple-700',  label: 'Submitted' },
    uploaded:          { color: 'bg-orange-100 text-orange-700',  label: 'Uploaded' },
  };
  const stageCfg = stageConfig[project.status] || { color: 'bg-muted text-muted-foreground', label: project.status };

  return (
    <div className="space-y-3">
      {/* Project header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 min-w-0">
          <Camera className="h-4 w-4 text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">
              {project.title || project.property_address}
            </p>
            {project.title && project.property_address && (
              <p className="text-xs text-muted-foreground truncate">{project.property_address}</p>
            )}
          </div>
          <Badge className={`text-[10px] shrink-0 ${stageCfg.color}`}>{stageCfg.label}</Badge>
          {project.tonomo_delivered_at && (
            <span className="text-xs text-muted-foreground shrink-0">
              {format(new Date(fixTimestamp(project.tonomo_delivered_at)), 'd MMM yyyy')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {status === 'done' && (
            <div className="flex gap-1.5">
              {(['all', 'image', 'video', 'document']).map(t => {
                const count = t === 'all' ? files.length : counts[t];
                if (t !== 'all' && count === 0) return null;
                return (
                  <button key={t}
                    onClick={() => setTypeFilter(t)}
                    className={cn(
                      'text-[10px] px-2 py-1 rounded-full border transition-colors font-medium',
                      typeFilter === t
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-muted text-muted-foreground border-transparent hover:border-border'
                    )}>
                    {t === 'all' ? `All (${count})` :
                     t === 'image' ? `📷 ${count}` :
                     t === 'video' ? `🎬 ${count}` : `📐 ${count}`}
                  </button>
                );
              })}
            </div>
          )}
          <button onClick={load}
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="Reload">
            <RefreshCw className={cn('h-3.5 w-3.5', status === 'loading' && 'animate-spin')} />
          </button>
          {project.tonomo_deliverable_link && (
            <a href={project.tonomo_deliverable_link} target="_blank" rel="noopener noreferrer"
              className="text-xs text-primary hover:underline">
              Open folder ↗
            </a>
          )}
        </div>
      </div>

      {/* Media grid */}
      {status === 'loading' && (
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="aspect-square rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      )}

      {status === 'error' && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg p-3">
          <span className="text-destructive">⚠</span>
          {errorMsg || 'Could not load media from Dropbox'}
          <button onClick={load} className="ml-auto text-xs text-primary hover:underline">Retry</button>
        </div>
      )}

      {status === 'done' && visibleFiles.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-4">
          {typeFilter === 'all' ? 'No media files found in this folder' : `No ${typeFilter} files`}
        </p>
      )}

      {status === 'done' && visibleFiles.length > 0 && (
        <div className="grid grid-cols-4 sm:grid-cols-6 lg:grid-cols-8 gap-2">
          <AnimatePresence mode="popLayout">
            {visibleFiles.map((file, i) => (
              <MediaTile
                key={file.path}
                file={file}
                onClick={() => onOpenLightbox(visibleFiles, i, project.title || project.property_address)}
              />
            ))}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function DropboxFileFeed() {
  const [stageFilter, setStageFilter] = useState('delivered');
  const [dateRange, setDateRange]     = useState('30');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [staffFilter, setStaffFilter]   = useState('all');
  const [search, setSearch]             = useState('');
  const [lightbox, setLightbox]         = useState(null); // { files, index, projectName }

  const { data: allProjects = [] } = useEntityList('Project');
  const { data: allUsers = [] }    = useEntityList('User');

  // ── Filter projects: must have a deliverable path ──────────────────────────
  const eligibleProjects = useMemo(() => {
    if (!Array.isArray(allProjects)) return [];
    const now = new Date();
    const days = parseInt(dateRange, 10);

    return allProjects
      .filter(p => p?.tonomo_deliverable_path)
      .filter(p => {
        if (stageFilter !== 'all') return p.status === stageFilter;
        return true;
      })
      .filter(p => {
        if (days === 0) return true;
        const raw = p?.tonomo_delivered_at || p?.updated_date || p?.created_date;
        if (!raw) return false;
        try {
          return differenceInDays(now, new Date(fixTimestamp(raw))) <= days;
        } catch {
          return false;
        }
      })
      .filter(p => {
        if (agencyFilter !== 'all') return p.agency_id === agencyFilter || p.agency_name === agencyFilter;
        return true;
      })
      .filter(p => {
        if (staffFilter !== 'all') return (
          p.project_owner_id === staffFilter ||
          p.photographer_id === staffFilter ||
          p.videographer_id === staffFilter ||
          p.onsite_staff_1_id === staffFilter ||
          p.onsite_staff_2_id === staffFilter
        );
        return true;
      })
      .filter(p => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (
          p.title?.toLowerCase().includes(q) ||
          p.property_address?.toLowerCase().includes(q) ||
          p.agency_name?.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const aDate = a.tonomo_delivered_at || a.updated_date || a.created_date || '';
        const bDate = b.tonomo_delivered_at || b.updated_date || b.created_date || '';
        return new Date(fixTimestamp(bDate)) - new Date(fixTimestamp(aDate));
      });
  }, [allProjects, stageFilter, dateRange, agencyFilter, staffFilter, search]);

  // ── Agency options ──────────────────────────────────────────────────────────
  const agencyOptions = useMemo(() => {
    const seen = new Map();
    allProjects.filter(p => p.tonomo_deliverable_path).forEach(p => {
      if (p.agency_id && p.agency_name) seen.set(p.agency_id, p.agency_name);
      else if (p.agency_name) seen.set(p.agency_name, p.agency_name);
    });
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [allProjects]);

  // ── Staff options (photographers/contractors with delivered projects) ────────
  const staffOptions = useMemo(() => {
    const ids = new Set(
      allProjects
        .filter(p => p.tonomo_deliverable_path)
        .flatMap(p => [...new Set([p.project_owner_id, p.photographer_id, p.videographer_id, p.onsite_staff_1_id, p.onsite_staff_2_id].filter(Boolean))])
    );
    return allUsers
      .filter(u => ids.has(u.id))
      .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  }, [allProjects, allUsers]);

  const openLightbox = useCallback((files, index, projectName) => {
    setLightbox({ files, index, projectName });
  }, []);

  const closeLightbox = useCallback(() => setLightbox(null), []);

  return (
    <div className="p-6 space-y-6">
      {/* ── Filter bar ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search project or address…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>

        <Select value={stageFilter} onValueChange={setStageFilter}>
          <SelectTrigger className="w-44 h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STAGES_WITH_MEDIA.map(s => (
              <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

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

        {agencyOptions.length > 0 && (
          <Select value={agencyFilter} onValueChange={setAgencyFilter}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="All agencies" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agencies</SelectItem>
              {agencyOptions.map(([id, name]) => (
                <SelectItem key={id} value={id}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {staffOptions.length > 0 && (
          <Select value={staffFilter} onValueChange={setStaffFilter}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="All photographers" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All photographers</SelectItem>
              {staffOptions.map(u => (
                <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <span className="text-xs text-muted-foreground ml-auto shrink-0">
          {eligibleProjects.length} project{eligibleProjects.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Feed ────────────────────────────────────────────────────────── */}
      {eligibleProjects.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground space-y-2">
          <Camera className="h-12 w-12 mx-auto opacity-20" />
          <p className="text-sm">No projects match your filters</p>
          <p className="text-xs opacity-60">
            Only Tonomo-sourced projects with a delivery folder path appear here
          </p>
        </div>
      ) : (
        <div className="space-y-8 divide-y divide-border/50">
          {eligibleProjects.map(project => (
            <div key={project.id} className="pt-6 first:pt-0">
              <ProjectMediaBlock
                project={project}
                onOpenLightbox={openLightbox}
              />
            </div>
          ))}
        </div>
      )}

      {/* ── Lightbox ────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {lightbox && (
          <Lightbox
            files={lightbox.files}
            initialIndex={lightbox.index}
            projectName={lightbox.projectName}
            onClose={closeLightbox}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
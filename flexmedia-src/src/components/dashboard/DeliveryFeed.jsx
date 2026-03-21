import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { api } from '@/api/supabaseClient';
import { useEntityList } from '@/components/hooks/useEntityData';
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
  ArrowRight, Eye, RefreshCw, DollarSign, Timer, AlertTriangle, CreditCard
} from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import { format, formatDistanceToNow, differenceInDays, differenceInHours, isToday, isYesterday } from 'date-fns';

const TYPE_CONFIG = {
  image: { label: 'Photos', icon: ImageIcon, color: 'bg-blue-100 text-blue-700' },
  video: { label: 'Video', icon: Film, color: 'bg-purple-100 text-purple-700' },
  document: { label: 'Floorplan', icon: FileText, color: 'bg-amber-100 text-amber-700' },
};

function classifyUrl(url) {
  if (!url || typeof url !== 'string') return 'image';
  const lower = url.toLowerCase();
  if (['.mp4', '.mov', '.avi', '.webm'].some(e => lower.includes(e))) return 'video';
  if (['.pdf', '.ai', '.eps'].some(e => lower.includes(e))) return 'document';
  return 'image';
}

function projectRevenue(p) {
  return p.tonomo_invoice_amount ?? p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;
}

function projectTitle(p) {
  return p.title || p.property_address || p.tonomo_address || p.tonomo_order_name || 'Untitled project';
}

function deliveredFileCount(p) {
  try { return JSON.parse(p.tonomo_delivered_files || '[]').length; } catch { return 0; }
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
  if (!amount || amount === 0) return '$0';
  if (amount >= 1000) return `$${(amount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `$${Math.round(amount).toLocaleString()}`;
}

// ─── Thumbnail fetching ──────────────────────────────────────────────────────
const thumbCache = new Map();
const pendingRequests = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CONCURRENT = 3;

function getCachedThumbnails(path) {
  const entry = thumbCache.get(path);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) { thumbCache.delete(path); return null; }
  return entry.files;
}
function setCachedThumbnails(path, files) { thumbCache.set(path, { files, timestamp: Date.now() }); }

let activeCount = 0;
const queue = [];
function processThumbnailQueue() {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const job = queue.shift();
    activeCount++;
    job().finally(() => { activeCount--; processThumbnailQueue(); });
  }
}

let dropboxFailCount = 0;

async function fetchThumbnails(pathOrUrl, isShareUrl = false) {
  const cacheKey = pathOrUrl;
  const cached = getCachedThumbnails(cacheKey);
  if (cached) return cached;
  if (pendingRequests.has(cacheKey)) return pendingRequests.get(cacheKey);
  const promise = new Promise((resolve) => {
    queue.push(async () => {
      try {
        const params = isShareUrl ? { share_url: pathOrUrl } : { path: pathOrUrl };
        const res = await api.functions.invoke('getDeliveryMediaFeed', params);
        const data = res?.data || res;
        const files = data?.files || [];
        if (files.length === 0) dropboxFailCount++;
        setCachedThumbnails(cacheKey, files);
        resolve(files);
      } catch (err) {
        dropboxFailCount++;
        console.warn('Dropbox fetch failed:', err?.message);
        setCachedThumbnails(cacheKey, []);
        resolve([]);
      }
    });
    processThumbnailQueue();
  });
  pendingRequests.set(cacheKey, promise);
  return promise;
}

// ─── MiniLightbox ────────────────────────────────────────────────────────────
function MiniLightbox({ files, initialIndex, onClose }) {
  const [index, setIndex] = useState(initialIndex);
  const file = files[index];
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
  return (
    <div className="fixed inset-0 z-50 bg-black/90 flex flex-col" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 shrink-0">
        <span className="text-white/70 text-sm">{file.name}</span>
        <div className="flex items-center gap-2">
          <span className="text-white/40 text-xs">{index + 1}/{files.length}</span>
          <button onClick={onClose} className="text-white/60 hover:text-white p-1"><X className="h-5 w-5" /></button>
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center relative min-h-0">
        {index > 0 && <button onClick={() => setIndex(i => i - 1)} className="absolute left-3 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/80"><ChevronLeft className="h-5 w-5" /></button>}
        {file.thumbnail ? (
          <img src={`data:image/jpeg;base64,${file.thumbnail}`} alt={file.name} className="max-w-full max-h-full object-contain p-4" />
        ) : (
          <div className="flex flex-col items-center gap-3 text-white/40">
            {file.type === 'video' ? <Film className="h-16 w-16" /> : <FileText className="h-16 w-16" />}
            <p className="text-sm">{file.name}</p>
          </div>
        )}
        {index < files.length - 1 && <button onClick={() => setIndex(i => i + 1)} className="absolute right-3 z-10 p-2 rounded-full bg-black/50 text-white hover:bg-black/80"><ChevronRight className="h-5 w-5" /></button>}
      </div>
      <div className="flex gap-1 px-4 py-2 overflow-x-auto border-t border-white/10 shrink-0">
        {files.slice(0, 30).map((f, i) => (
          <button key={f.path || i} onClick={() => setIndex(i)} className={cn('shrink-0 w-10 h-10 rounded overflow-hidden border-2 transition-all', i === index ? 'border-white' : 'border-transparent opacity-40 hover:opacity-70')}>
            {f.thumbnail ? <img src={`data:image/jpeg;base64,${f.thumbnail}`} alt="" className="w-full h-full object-cover" /> : <div className="w-full h-full bg-white/10 flex items-center justify-center">{f.type === 'video' ? <Film className="h-3 w-3 text-white/40" /> : <FileText className="h-3 w-3 text-white/40" />}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── DeliveryCard ────────────────────────────────────────────────────────────
function DeliveryCard({ project, isNew }) {
  const [expanded, setExpanded] = useState(false);
  const [files, setFiles] = useState([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  const deliveredAt = project.tonomo_delivered_at || project.updated_date || project.created_date;
  const deliverableLink = project.tonomo_deliverable_link;
  const deliverablePath = project.tonomo_deliverable_path;
  const deliveredFiles = useMemo(() => { try { return JSON.parse(project.tonomo_delivered_files || '[]'); } catch { return []; } }, [project.tonomo_delivered_files]);
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

  const dropboxSource = deliverablePath || deliverableLink || null;
  const isShareUrl = !deliverablePath && !!deliverableLink;

  useEffect(() => {
    if (!dropboxSource || files.length > 0) return;
    let mounted = true;
    setLoadingFiles(true);
    fetchThumbnails(dropboxSource, isShareUrl).then(result => {
      if (mounted) { setFiles(result); setLoadingFiles(false); }
    });
    return () => { mounted = false; };
  }, [dropboxSource, isShareUrl]);

  const fileTypeCounts = useMemo(() => {
    const c = { image: 0, video: 0, document: 0 };
    if (files.length > 0) { files.forEach(f => { if (c[f.type] !== undefined) c[f.type]++; }); }
    else { deliveredFiles.forEach(url => { c[classifyUrl(url)]++; }); }
    return c;
  }, [files, deliveredFiles]);

  const totalFileCount = files.length > 0 ? files.length : deliveredFiles.length;

  return (
    <div className={cn('border rounded-xl overflow-hidden transition-all hover:shadow-md bg-card', isNew && 'ring-2 ring-green-300 ring-opacity-50')}>
      <button onClick={() => setExpanded(e => !e)} className="w-full text-left">
        <div className="flex items-start gap-3 p-4">
          <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5', project.status === 'delivered' ? 'bg-emerald-100' : 'bg-blue-100')}>
            {project.status === 'delivered' ? <CheckCircle2 className="h-5 w-5 text-emerald-600" /> : <Package className="h-5 w-5 text-blue-600" />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm">{projectTitle(project)}</span>
              {isNew && <Badge className="text-[9px] bg-green-100 text-green-700 border-green-200">NEW</Badge>}
              <Badge variant="outline" className="text-[9px]">{stageLabel(project.status)}</Badge>
              {packageName && <Badge variant="outline" className="text-[9px] bg-slate-50">{packageName}</Badge>}
            </div>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground flex-wrap">
              {project.agent_name && <span>{project.agent_name}</span>}
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
            {totalFileCount > 0 && (
              <div className="flex gap-2 mt-2 flex-wrap items-center">
                {Object.entries(fileTypeCounts).filter(([_, c]) => c > 0).map(([type, count]) => {
                  const cfg = TYPE_CONFIG[type]; const Icon = cfg.icon;
                  return <Badge key={type} className={cn('text-[10px] gap-1', cfg.color)}><Icon className="h-2.5 w-2.5" />{count} {cfg.label}</Badge>;
                })}
                <span className="text-[10px] text-muted-foreground">{totalFileCount} files</span>
                {loadingFiles && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              </div>
            )}
          </div>

          {files.length > 0 && !expanded && (
            <div className="hidden sm:flex gap-1 shrink-0 mr-1">
              {files.filter(f => f.thumbnail).slice(0, 5).map((file, i) => (
                <div key={file.path || i} className="w-11 h-11 rounded-md overflow-hidden bg-muted border border-border/40 shrink-0">
                  <img src={`data:image/jpeg;base64,${file.thumbnail}`} alt="" className="w-full h-full object-cover" loading="lazy" />
                </div>
              ))}
              {files.length > 5 && (
                <div className="w-11 h-11 rounded-md bg-muted/60 border border-border/40 flex items-center justify-center text-[10px] text-muted-foreground font-semibold shrink-0">+{files.length - 5}</div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2 shrink-0">
            {deliverableLink && <a href={deliverableLink} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Open delivery folder"><ExternalLink className="h-4 w-4" /></a>}
            <Link to={createPageUrl('ProjectDetails') + `?id=${project.id}`} onClick={(e) => e.stopPropagation()} className="p-1.5 rounded-lg hover:bg-muted text-muted-foreground hover:text-primary transition-colors" title="Open project"><ArrowRight className="h-4 w-4" /></Link>
            {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
          </div>
        </div>
      </button>

      {expanded && (
        <div className="border-t px-4 py-3">
          {loadingFiles ? (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /><span className="text-xs">Loading media from Dropbox...</span></div>
          ) : files.length > 0 ? (
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground">{files.length} files from Dropbox</span>
                <button onClick={async (e) => {
                  e.stopPropagation();
                  setLoadingFiles(true);
                  thumbCache.delete(dropboxSource);
                  pendingRequests.delete(dropboxSource);
                  const result = await fetchThumbnails(dropboxSource, isShareUrl);
                  setFiles(result);
                  setLoadingFiles(false);
                }} className="text-[10px] text-muted-foreground hover:text-foreground flex items-center gap-1">
                  <RefreshCw className="h-3 w-3" /> Refresh
                </button>
              </div>
              <div className="grid grid-cols-5 sm:grid-cols-8 lg:grid-cols-10 gap-1.5">
                {files.slice(0, 60).map((file, i) => {
                  const cfg = TYPE_CONFIG[file.type] || TYPE_CONFIG.image; const Icon = cfg.icon;
                  return (
                    <button key={file.path || i} onClick={() => setLightbox({ files, index: i })} className="relative aspect-square rounded-lg overflow-hidden bg-muted border border-border/30 group hover:ring-2 hover:ring-primary/30 transition-all">
                      {file.thumbnail ? <img src={`data:image/jpeg;base64,${file.thumbnail}`} alt={file.name} className="w-full h-full object-cover group-hover:scale-105 transition-transform" loading="lazy" /> : <div className="w-full h-full flex items-center justify-center"><Icon className="h-5 w-5 text-muted-foreground/40" /></div>}
                      {file.type === 'video' && <div className="absolute inset-0 flex items-center justify-center"><div className="bg-black/40 rounded-full p-1.5"><Play className="h-3 w-3 text-white fill-white" /></div></div>}
                    </button>
                  );
                })}
                {files.length > 60 && <div className="aspect-square rounded-lg bg-muted/50 flex items-center justify-center text-xs text-muted-foreground font-medium">+{files.length - 60}</div>}
              </div>
            </div>
          ) : dropboxSource ? (
            <div className="text-center py-4 text-xs text-muted-foreground">No files found in Dropbox — <a href={deliverableLink} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">open in Dropbox</a></div>
          ) : deliveredFiles.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-1">Delivery links</div>
              {deliveredFiles.slice(0, 10).filter(url => typeof url === 'string').map((url, i) => (
                <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-xs text-primary hover:underline truncate"><ExternalLink className="h-3 w-3 shrink-0" /><span className="truncate">{url.split('/').pop() || url}</span></a>
              ))}
            </div>
          ) : (
            <div className="text-center py-4 text-xs text-muted-foreground">No delivery data available</div>
          )}
        </div>
      )}
      {lightbox && <MiniLightbox files={lightbox.files} initialIndex={lightbox.index} onClose={() => setLightbox(null)} />}
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

  const { data: allProjects = [], loading } = useEntityList('Project', '-tonomo_delivered_at');

  useEffect(() => {
    const timer = setTimeout(() => {
      if (dropboxFailCount >= 3) setDropboxWarning(true);
    }, 8000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const unsub = api.entities.Project.subscribe((event) => {
      if (event.type === 'update' && event.data?.tonomo_delivered_at && event.data?.status === 'delivered') {
        setNewDeliveryIds(prev => new Set([...prev, event.id]));
        setTimeout(() => setNewDeliveryIds(prev => { const next = new Set(prev); next.delete(event.id); return next; }), 60000);
      }
    });
    return unsub;
  }, []);

  const deliveries = useMemo(() => {
    const days = parseInt(dateFilter, 10);
    const now = new Date();
    const DELIVERY_STAGES = ['ready_for_partial', 'in_revision', 'delivered'];
    return allProjects
      .filter(p => DELIVERY_STAGES.includes(p.status))
      .filter(p => p.tonomo_delivered_at || p.tonomo_deliverable_link || p.tonomo_delivered_files || p.tonomo_deliverable_path)
      .filter(p => { if (days === 0) return true; const delivered = p.tonomo_delivered_at || p.updated_date; if (!delivered) return false; return differenceInDays(now, new Date(fixTimestamp(delivered))) <= days; })
      .filter(p => agencyFilter === 'all' || p.agency_id === agencyFilter)
      .filter(p => {
        if (!search.trim()) return true;
        const q = search.toLowerCase();
        return (p.title || '').toLowerCase().includes(q)
          || (p.property_address || '').toLowerCase().includes(q)
          || (p.agency_name || '').toLowerCase().includes(q)
          || (p.agent_name || '').toLowerCase().includes(q);
      })
      .sort((a, b) => new Date(fixTimestamp(b.tonomo_delivered_at || b.updated_date || '')) - new Date(fixTimestamp(a.tonomo_delivered_at || a.updated_date || '')));
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
                {projects.map(p => <DeliveryCard key={p.id} project={p} isNew={newDeliveryIds.has(p.id)} />)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
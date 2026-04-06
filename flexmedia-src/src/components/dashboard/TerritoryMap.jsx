import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { Link, useNavigate } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  X, ChevronRight, MapPin, DollarSign, TrendingUp, TrendingDown,
  Building2, Play, Pause, Layers, BarChart3, Eye, Clock,
  Loader2, Crosshair, List, Calendar, AlertTriangle, Filter,
  ChevronDown, Check, Search, RotateCcw, User, Briefcase,
  Sun, Moon, Zap
} from 'lucide-react';
import { MapContainer, TileLayer, useMap, CircleMarker, Tooltip as LTooltip, ZoomControl } from 'react-leaflet';
import { fixTimestamp, fmtDate, todaySydney, parseDate } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import MarkerClusterLayer from './MarkerClusterLayer';
import { format, subMonths, differenceInDays, startOfMonth, endOfMonth, eachMonthOfInterval, isToday, isFuture, isPast } from 'date-fns';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR  = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const SYDNEY     = [-33.8688, 151.2093];

const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

const STAGE_COLORS = {
  pending_review:    '#f59e0b',
  to_be_scheduled:   '#94a3b8',
  scheduled:         '#3b82f6',
  onsite:            '#eab308',
  uploaded:          '#f97316',
  submitted:         '#8b5cf6',
  in_progress:       '#7c3aed',
  in_production:     '#06b6d4',
  ready_for_partial: '#6366f1',
  in_revision:       '#d97706',
  delivered:         '#10b981',
};
function getStageColor(status) { return STAGE_COLORS[status] || '#94a3b8'; }

// Gradient colors for territory bubbles based on dominant status
function getBubbleGradientColor(projects) {
  if (!projects.length) return '#6366f1';
  const counts = {};
  projects.forEach(p => { counts[p.status] = (counts[p.status] || 0) + 1; });
  const dominant = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return getStageColor(dominant);
}

// ─── Time filter definitions ──────────────────────────────────────────
const ACTIVE_STAGES = ['onsite', 'uploaded', 'submitted', 'in_production', 'in_progress', 'ready_for_partial', 'in_revision'];
const UPCOMING_STAGES = ['scheduled', 'to_be_scheduled', 'pending_review'];

function matchesTimeFilter(project, timeFilter) {
  if (timeFilter === 'all') return true;
  const shootDate = project.shoot_date ? parseDate(project.shoot_date) : null;
  const todayStr = todaySydney();
  const today = parseDate(todayStr);
  switch (timeFilter) {
    case 'today':
      return shootDate && today && shootDate.getTime() === today.getTime();
    case 'upcoming':
      return UPCOMING_STAGES.includes(project.status) && shootDate && today && shootDate > today;
    case 'active':
      return ACTIVE_STAGES.includes(project.status);
    case 'completed':
      return project.status === 'delivered';
    default:
      return true;
  }
}

// ─── Cluster by proximity ────────────────────────────────────────────
function clusterByProximity(projects, radiusKm = 0.8) {
  const clusters = [];
  const used = new Set();
  const sorted = [...projects].sort((a, b) => {
    if (a.property_suburb && b.property_suburb) return a.property_suburb.localeCompare(b.property_suburb);
    return (a.lat || 0) - (b.lat || 0);
  });
  for (const p of sorted) {
    if (used.has(p.id)) continue;
    const cluster = { projects: [p], lat: p.lat, lng: p.lng, suburb: p.property_suburb || null };
    used.add(p.id);
    for (const other of sorted) {
      if (used.has(other.id)) continue;
      if (p.property_suburb && other.property_suburb && p.property_suburb === other.property_suburb) {
        cluster.projects.push(other);
        used.add(other.id);
        continue;
      }
      const dLat = (other.lat - p.lat) * 111;
      const dLng = (other.lng - p.lng) * 111 * Math.cos(p.lat * Math.PI / 180);
      const dist = Math.sqrt(dLat * dLat + dLng * dLng);
      if (dist < radiusKm) {
        cluster.projects.push(other);
        used.add(other.id);
      }
    }
    cluster.lat = cluster.projects.reduce((s, pp) => s + pp.lat, 0) / cluster.projects.length;
    cluster.lng = cluster.projects.reduce((s, pp) => s + pp.lng, 0) / cluster.projects.length;
    if (!cluster.suburb) {
      const suburbs = cluster.projects.map(pp => pp.property_suburb).filter(Boolean);
      if (suburbs.length > 0) {
        const counts = {};
        suburbs.forEach(s => counts[s] = (counts[s] || 0) + 1);
        cluster.suburb = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      } else {
        const addr = cluster.projects[0]?.property_address || '';
        const parts = addr.split(',').map(s => s.trim());
        cluster.suburb = parts.length > 1 ? parts[parts.length - 2] : parts[0];
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

// ─── Searchable multi-select filter dropdown ──────────────────────────
function FilterDropdown({ label, icon: Icon, options, selected, onChange, searchable = false }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = searchable && search
    ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()))
    : options;

  const toggle = (val) => {
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-all',
          selected.length > 0
            ? 'bg-primary/10 text-primary border-primary/30'
            : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
        )}>
          <Icon className="h-3 w-3" />
          {label}
          {selected.length > 0 && (
            <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[9px] font-bold">{selected.length}</Badge>
          )}
          <ChevronDown className="h-3 w-3 ml-0.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-0" align="start">
        {searchable && (
          <div className="p-2 border-b">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
              <Input
                placeholder={`Search ${label.toLowerCase()}...`}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-7 text-xs pl-7"
              />
            </div>
          </div>
        )}
        <div className="max-h-56 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="text-xs text-muted-foreground text-center py-3">No matches</div>
          )}
          {filtered.map(opt => (
            <button
              key={opt.value}
              onClick={() => toggle(opt.value)}
              className="flex items-center gap-2 w-full px-2 py-1.5 rounded text-xs hover:bg-muted transition-colors text-left"
            >
              <div className={cn(
                'h-3.5 w-3.5 rounded border flex items-center justify-center shrink-0',
                selected.includes(opt.value) ? 'bg-primary border-primary' : 'border-border'
              )}>
                {selected.includes(opt.value) && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
              </div>
              {opt.color && <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: opt.color }} />}
              <span className="truncate flex-1">{opt.label}</span>
              {opt.count != null && <span className="text-[10px] text-muted-foreground">{opt.count}</span>}
            </button>
          ))}
        </div>
        {selected.length > 0 && (
          <div className="p-1.5 border-t">
            <button
              onClick={() => { onChange([]); setSearch(''); }}
              className="w-full text-xs text-center py-1 rounded hover:bg-muted text-muted-foreground"
            >
              Clear selection
            </button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ─── Suburb detail panel ──────────────────────────────────────────────
function SuburbPanel({ cluster, onClose }) {
  if (!cluster) return null;
  const projects = cluster.projects;
  const totalRevenue = projects.reduce((s, p) => s + projectValue(p), 0);
  const agencies = {};
  projects.forEach(p => { if (p.agency_name) agencies[p.agency_name] = (agencies[p.agency_name] || 0) + 1; });
  const topAgencies = Object.entries(agencies).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const stages = {};
  projects.forEach(p => { stages[p.status] = (stages[p.status] || 0) + 1; });

  const now = new Date();
  const sixMonthsAgo = subMonths(now, 6);
  const twelveMonthsAgo = subMonths(now, 12);
  const recent = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= sixMonthsAgo).length;
  const prior = projects.filter(p => { if (!p.created_date) return false; const d = new Date(fixTimestamp(p.created_date)); return d >= twelveMonthsAgo && d < sixMonthsAgo; }).length;
  const growth = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : recent > 0 ? 100 : 0;

  return (
    <div className="absolute top-0 right-0 h-full w-80 bg-background border-l shadow-xl z-20 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0 bg-primary/5">
        <div>
          <h3 className="font-bold text-sm">{cluster.suburb}</h3>
          <p className="text-xs text-muted-foreground">{projects.length} projects &middot; ${totalRevenue.toLocaleString()}</p>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="h-4 w-4" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <div className="grid grid-cols-3 gap-2">
          <div className="bg-muted/50 rounded-lg p-2.5 text-center">
            <div className="text-lg font-bold">{projects.length}</div>
            <div className="text-[9px] text-muted-foreground uppercase">Projects</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2.5 text-center">
            <div className="text-lg font-bold">${Math.round(totalRevenue / 1000)}k</div>
            <div className="text-[9px] text-muted-foreground uppercase">Revenue</div>
          </div>
          <div className="bg-muted/50 rounded-lg p-2.5 text-center">
            <div className={cn("text-lg font-bold", growth > 0 ? "text-green-600" : growth < 0 ? "text-red-600" : "")}>
              {growth > 0 ? '+' : ''}{growth}%
            </div>
            <div className="text-[9px] text-muted-foreground uppercase">6mo Growth</div>
          </div>
        </div>
        {topAgencies.length > 0 && (
          <div>
            <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Top agencies</div>
            {topAgencies.map(([name, count]) => (
              <div key={name} className="flex items-center justify-between py-1.5 border-b border-border/30 last:border-0">
                <div className="flex items-center gap-2"><Building2 className="h-3 w-3 text-muted-foreground" /><span className="text-xs font-medium">{name}</span></div>
                <Badge variant="outline" className="text-[10px] h-5">{count}</Badge>
              </div>
            ))}
          </div>
        )}
        <div>
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Pipeline</div>
          <div className="space-y-1">
            {Object.entries(stages).sort((a, b) => b[1] - a[1]).map(([stage, count]) => (
              <div key={stage} className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: getStageColor(stage) }} />
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full" style={{ width: `${(count / projects.length) * 100}%`, backgroundColor: getStageColor(stage) }} /></div>
                <span className="text-[10px] text-muted-foreground w-20 text-right">{stageLabel(stage)}</span>
                <span className="text-[10px] font-bold w-6 text-right">{count}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Volume over time</div>
          <MonthlySparkline projects={projects} />
        </div>
        <div>
          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest mb-2">Projects</div>
          <div className="space-y-1">
            {projects.sort((a, b) => new Date(fixTimestamp(b.created_date || '')) - new Date(fixTimestamp(a.created_date || ''))).slice(0, 20).map(p => (
              <Link key={p.id} to={createPageUrl('ProjectDetails') + `?id=${p.id}`} className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted transition-colors text-left w-full">
                <div className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: getStageColor(p.status) }} />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium truncate">{p.title || p.property_address}</div>
                  <div className="text-[10px] text-muted-foreground">{p.agency_name} &middot; {p.shoot_date ? fmtDate(p.shoot_date, 'd MMM yy') : 'No date'}</div>
                </div>
                {projectValue(p) > 0 && <span className="text-[10px] font-medium text-muted-foreground">${projectValue(p).toLocaleString()}</span>}
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Monthly sparkline chart ──────────────────────────────────────────
function MonthlySparkline({ projects }) {
  const months = useMemo(() => {
    const now = new Date();
    const start = subMonths(now, 11);
    return eachMonthOfInterval({ start, end: now }).map(m => {
      const mStart = startOfMonth(m);
      const mEnd = endOfMonth(m);
      const count = projects.filter(p => { if (!p.created_date) return false; const d = new Date(fixTimestamp(p.created_date)); return d >= mStart && d <= mEnd; }).length;
      return { label: format(m, 'MMM'), count };
    });
  }, [projects]);
  const max = Math.max(...months.map(m => m.count), 1);
  return (
    <div className="flex items-end gap-1 h-12">
      {months.map((m, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
          <div className="w-full rounded-t bg-primary/40 transition-all hover:bg-primary/70" style={{ height: `${(m.count / max) * 36}px`, minHeight: m.count > 0 ? 3 : 0 }} title={`${m.label}: ${m.count} projects`} />
          <span className="text-[7px] text-muted-foreground">{m.label.charAt(0)}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Territory bubbles (with suburb labels and status-based color) ────
function TerritoryBubbles({ clusters, metric, onSelect, selectedSuburb }) {
  return clusters.map((cluster, i) => {
    const value = metric === 'revenue'
      ? cluster.projects.reduce((s, p) => s + projectValue(p), 0)
      : cluster.projects.length;
    const maxVal = metric === 'revenue' ? 100000 : 30;
    const radius = Math.max(14, Math.min(55, (value / maxVal) * 55));
    const isSelected = selectedSuburb === cluster.suburb;
    const bubbleColor = getBubbleGradientColor(cluster.projects);
    return (
      <CircleMarker
        key={`${cluster.suburb}-${i}`}
        center={[cluster.lat, cluster.lng]}
        radius={radius}
        pathOptions={{
          fillColor: isSelected ? '#2563eb' : bubbleColor,
          fillOpacity: isSelected ? 0.9 : 0.6,
          color: '#fff',
          weight: isSelected ? 3 : 2,
          opacity: 0.95,
        }}
        eventHandlers={{ click: () => onSelect(cluster) }}
      >
        <LTooltip direction="top" offset={[0, -radius]} permanent={radius >= 22}>
          <div className="text-center px-1">
            <div className="font-bold text-xs leading-tight">{cluster.suburb}</div>
            <div className="text-[10px] text-muted-foreground">
              {cluster.projects.length} projects &middot; ${cluster.projects.reduce((s, p) => s + projectValue(p), 0).toLocaleString()}
            </div>
          </div>
        </LTooltip>
      </CircleMarker>
    );
  });
}

// ─── Timeline slider + playback ───────────────────────────────────────
function TimelineControls({ months, currentIndex, onChange, playing, onTogglePlay, stats }) {
  if (!months.length) return null;
  const currentMonth = months[currentIndex] || months[0];
  return (
    <div className="absolute bottom-4 left-4 right-4 z-20">
      <div className="bg-background/95 backdrop-blur-sm border rounded-xl shadow-lg p-3">
        {/* Stats bar */}
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <button
              onClick={onTogglePlay}
              className={cn(
                'h-8 w-8 rounded-full flex items-center justify-center transition-all shadow-sm',
                playing
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-primary hover:bg-primary/90 text-primary-foreground'
              )}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 ml-0.5" />}
            </button>
            <div>
              <div className="text-base font-bold tabular-nums">
                {currentMonth ? format(currentMonth, 'MMMM yyyy') : '--'}
              </div>
              <div className="text-xs text-muted-foreground flex items-center gap-2">
                <span className="font-semibold">{stats.projects} projects</span>
                <span>&middot;</span>
                <span className="font-semibold text-green-600">${stats.revenue.toLocaleString()} revenue</span>
              </div>
            </div>
          </div>
          <div className="text-right text-[10px] text-muted-foreground">
            {currentIndex + 1} / {months.length} months
          </div>
        </div>
        {/* Slider */}
        <div className="relative">
          <input
            type="range"
            min={0}
            max={months.length - 1}
            value={currentIndex}
            onChange={(e) => onChange(parseInt(e.target.value))}
            className="w-full h-2 appearance-none rounded-full bg-muted cursor-pointer
              [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4
              [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-md
              [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-white
              [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:transition-transform
              [&::-webkit-slider-thumb]:hover:scale-125
              [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4
              [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-md
              [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-white
              [&::-moz-range-thumb]:cursor-pointer"
            style={{
              background: `linear-gradient(to right, hsl(var(--primary)) ${(currentIndex / Math.max(months.length - 1, 1)) * 100}%, hsl(var(--muted)) ${(currentIndex / Math.max(months.length - 1, 1)) * 100}%)`
            }}
          />
          {/* Month tick marks */}
          <div className="flex justify-between mt-1 px-0.5">
            {months.filter((_, i) => {
              // Show every 3rd or 6th label depending on total count
              const step = months.length > 24 ? 6 : months.length > 12 ? 3 : 1;
              return i % step === 0 || i === months.length - 1;
            }).map((m, i) => (
              <span key={i} className="text-[8px] text-muted-foreground tabular-nums">
                {format(m, months.length > 12 ? "MMM ''yy" : 'MMM')}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────
export default function TerritoryMap() {
  const navigate = useNavigate();

  // Mode & display state
  const [mode, setMode] = useState('territory');
  const [metric, setMetric] = useState('count');
  const [monthsBack, setMonthsBack] = useState(0);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [mapTheme, setMapTheme] = useState('light');
  const [mapKey, setMapKey] = useState(0);

  // Time-based filter
  const [timeFilter, setTimeFilter] = useState('all');

  // Advanced filters
  const [typeFilter, setTypeFilter] = useState([]);
  const [orgFilter, setOrgFilter] = useState([]);
  const [personFilter, setPersonFilter] = useState([]);

  // Timeline state
  const [playing, setPlaying] = useState(false);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const timelineRef = useRef(null);

  // Geocoding
  const [geocoding, setGeocoding] = useState(false);
  const [geocodeResult, setGeocodeResult] = useState(null);

  // Data
  const { data: allProjects = [], loading, refetch: refreshProjects } = useEntityList('Project', '-created_date', 1000);
  const { data: allUsers = [] } = useEntityList('User');

  // Geocode handler
  const handleGeocodeNow = useCallback(async () => {
    setGeocoding(true);
    setGeocodeResult(null);
    try {
      const ungeocodedIds = allProjects
        .filter(p => p.property_address && !p.geocoded_lat && !p.latitude)
        .map(p => p.id)
        .slice(0, 100);
      if (ungeocodedIds.length === 0) {
        setGeocodeResult({ ok: false, message: 'No un-geocoded projects with addresses found.' });
        return;
      }
      const result = await api.functions.invoke('geocodeProject', { projectIds: ungeocodedIds });
      setGeocodeResult({ ok: true, message: `Geocoded ${result?.geocoded ?? 0} of ${result?.total ?? ungeocodedIds.length} projects.` });
      if (refreshProjects) refreshProjects();
    } catch (err) {
      setGeocodeResult({ ok: false, message: err?.message || 'Geocoding failed. Check that GOOGLE_PLACES_API_KEY is configured.' });
    } finally {
      setGeocoding(false);
    }
  }, [allProjects, refreshProjects]);

  // Mappable projects (have geocoded lat/lng)
  const mappable = useMemo(() => allProjects.filter(p => {
    const lat = p?.geocoded_lat || p?.latitude;
    const lng = p?.geocoded_lng || p?.longitude;
    return lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
  }).map(p => ({
    ...p,
    lat: parseFloat(p.geocoded_lat || p.latitude),
    lng: parseFloat(p.geocoded_lng || p.longitude),
  })), [allProjects]);

  // Filter options (computed from data)
  const filterOptions = useMemo(() => {
    const types = {};
    const orgs = {};
    const persons = {};
    mappable.forEach(p => {
      if (p.project_type_name) types[p.project_type_name] = (types[p.project_type_name] || 0) + 1;
      if (p.agency_name && p.agency_id) orgs[p.agency_id] = { label: p.agency_name, count: (orgs[p.agency_id]?.count || 0) + 1 };
      if (p.agent_name && p.agent_id) persons[p.agent_id] = { label: p.agent_name, count: (persons[p.agent_id]?.count || 0) + 1 };
    });
    return {
      types: Object.entries(types).map(([name, count]) => ({ value: name, label: name, count })).sort((a, b) => b.count - a.count),
      orgs: Object.entries(orgs).map(([id, o]) => ({ value: id, label: o.label, count: o.count })).sort((a, b) => a.label.localeCompare(b.label)),
      persons: Object.entries(persons).map(([id, o]) => ({ value: id, label: o.label, count: o.count })).sort((a, b) => a.label.localeCompare(b.label)),
    };
  }, [mappable]);

  // Time filter counts (for badge display)
  const timeFilterCounts = useMemo(() => {
    const counts = { all: mappable.length, today: 0, upcoming: 0, active: 0, completed: 0 };
    mappable.forEach(p => {
      if (matchesTimeFilter(p, 'today')) counts.today++;
      if (matchesTimeFilter(p, 'upcoming')) counts.upcoming++;
      if (matchesTimeFilter(p, 'active')) counts.active++;
      if (matchesTimeFilter(p, 'completed')) counts.completed++;
    });
    return counts;
  }, [mappable]);

  // Apply all filters
  const filtered = useMemo(() => {
    const now = new Date();
    const cutoff = monthsBack > 0 ? subMonths(now, monthsBack) : null;
    return mappable.filter(p => {
      // Period filter
      if (cutoff && p.created_date) {
        const d = new Date(fixTimestamp(p.created_date));
        if (d < cutoff) return false;
      }
      // Time-based filter
      if (!matchesTimeFilter(p, timeFilter)) return false;
      // Type filter
      if (typeFilter.length > 0 && !typeFilter.includes(p.project_type_name)) return false;
      // Org filter
      if (orgFilter.length > 0 && !orgFilter.includes(p.agency_id)) return false;
      // Person filter
      if (personFilter.length > 0 && !personFilter.includes(p.agent_id)) return false;
      return true;
    });
  }, [mappable, monthsBack, timeFilter, typeFilter, orgFilter, personFilter]);

  const activeFilterCount = typeFilter.length + orgFilter.length + personFilter.length;

  const clearAllFilters = () => {
    setTypeFilter([]);
    setOrgFilter([]);
    setPersonFilter([]);
    setTimeFilter('all');
    setMonthsBack(0);
  };

  // Clusters for territory mode
  const clusters = useMemo(() => clusterByProximity(filtered), [filtered]);

  // Top suburbs leaderboard
  const topSuburbs = useMemo(() =>
    [...clusters]
      .sort((a, b) => {
        if (metric === 'revenue')
          return b.projects.reduce((s, p) => s + projectValue(p), 0) - a.projects.reduce((s, p) => s + projectValue(p), 0);
        return b.projects.length - a.projects.length;
      })
      .slice(0, 10),
    [clusters, metric]
  );

  // Timeline months array
  const timelineMonths = useMemo(() => {
    const datedProjects = mappable.filter(p => p.created_date);
    if (datedProjects.length === 0) return [];
    const sorted = datedProjects.sort((a, b) =>
      new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date))
    );
    return eachMonthOfInterval({
      start: new Date(fixTimestamp(sorted[0].created_date)),
      end: new Date(),
    });
  }, [mappable]);

  // Timeline auto-play
  useEffect(() => {
    if (playing && timelineMonths.length > 0) {
      timelineRef.current = setInterval(() => {
        setTimelineIndex(prev => {
          if (prev >= timelineMonths.length - 1) {
            setPlaying(false);
            return prev;
          }
          return prev + 1;
        });
      }, 350);
      return () => clearInterval(timelineRef.current);
    }
    return () => clearInterval(timelineRef.current);
  }, [playing, timelineMonths.length]);

  // Reset timeline index when entering timeline mode
  useEffect(() => {
    if (mode === 'timeline') {
      setTimelineIndex(0);
    } else {
      setPlaying(false);
    }
  }, [mode]);

  // Timeline filtered data
  const timelineFiltered = useMemo(() => {
    if (mode !== 'timeline' || !timelineMonths.length) return filtered;
    const cutoff = timelineMonths[timelineIndex];
    if (!cutoff) return [];
    return mappable.filter(p =>
      p.created_date && new Date(fixTimestamp(p.created_date)) <= cutoff
    );
  }, [mode, timelineIndex, timelineMonths, mappable, filtered]);

  // Timeline stats
  const timelineStats = useMemo(() => ({
    projects: timelineFiltered.length,
    revenue: timelineFiltered.reduce((s, p) => s + projectValue(p), 0),
  }), [timelineFiltered]);

  // Choose active data
  const activeData = mode === 'timeline' ? timelineFiltered : filtered;
  const activeClusters = useMemo(() => clusterByProximity(activeData), [activeData]);

  // Summary stats
  const totalRevenue = filtered.reduce((s, p) => s + projectValue(p), 0);
  const geocodedPct = allProjects.length > 0 ? Math.round((mappable.length / allProjects.length) * 100) : 0;

  // Handle pin click -> navigate to project
  const handleProjectClick = useCallback((project) => {
    navigate(createPageUrl('ProjectDetails') + `?id=${project.id}`);
  }, [navigate]);

  // ─── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col h-full">
      {/* ── Top toolbar: mode selector, metric toggle, theme toggle ── */}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-background shrink-0">
        <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
          {[
            { v: 'territory', l: 'Territory', icon: Layers },
            { v: 'pins', l: 'All Pins', icon: MapPin },
            { v: 'timeline', l: 'Timeline', icon: Clock },
          ].map(({ v, l, icon: Icon }) => (
            <button
              key={v}
              onClick={() => { setMode(v); if (v !== 'timeline') setPlaying(false); }}
              className={cn(
                'text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5',
                mode === v ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-3 w-3" />{l}
            </button>
          ))}
        </div>

        {mode === 'territory' && (
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            {[{ v: 'count', l: 'Volume' }, { v: 'revenue', l: 'Revenue' }].map(({ v, l }) => (
              <button key={v} onClick={() => setMetric(v)} className={cn('text-xs px-2.5 py-1 rounded-md font-medium transition-all', metric === v ? 'bg-background shadow-sm' : 'text-muted-foreground')}>{l}</button>
            ))}
          </div>
        )}

        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span className="font-medium tabular-nums">{filtered.length} projects &middot; ${totalRevenue.toLocaleString()} &middot; {geocodedPct}% geocoded</span>
          <button
            onClick={() => setMapTheme(t => t === 'light' ? 'dark' : 'light')}
            className="p-1.5 rounded-lg border hover:bg-muted transition-colors"
            title={mapTheme === 'light' ? 'Dark mode' : 'Light mode'}
          >
            {mapTheme === 'light' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {/* ── Filter bar: time chips + period chips + advanced filters ── */}
      {mode !== 'timeline' && (
        <div className="px-3 py-2 border-b bg-muted/20 flex flex-wrap items-center gap-2 shrink-0">
          {/* Time-based filter chips */}
          <div className="flex items-center gap-1">
            {[
              { v: 'all', l: 'All' },
              { v: 'today', l: 'Today' },
              { v: 'upcoming', l: 'Upcoming' },
              { v: 'active', l: 'Active' },
              { v: 'completed', l: 'Completed' },
            ].map(({ v, l }) => (
              <button
                key={v}
                onClick={() => setTimeFilter(v)}
                className={cn(
                  'text-[10px] px-2 py-1 rounded-full font-medium border transition-all flex items-center gap-1',
                  timeFilter === v
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
                )}
              >
                {l}
                {v !== 'all' && timeFilterCounts[v] > 0 && (
                  <span className={cn(
                    'text-[9px] min-w-3.5 h-3.5 rounded-full inline-flex items-center justify-center px-1 font-bold',
                    timeFilter === v ? 'bg-primary-foreground/20' : 'bg-muted'
                  )}>
                    {timeFilterCounts[v]}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-border" />

          {/* Period chips */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] font-medium text-muted-foreground mr-0.5">Period:</span>
            {[
              { v: 0, l: 'All time' }, { v: 24, l: '2yr' }, { v: 12, l: '1yr' },
              { v: 6, l: '6mo' }, { v: 3, l: '3mo' }, { v: 1, l: '1mo' },
            ].map(({ v, l }) => (
              <button
                key={v}
                onClick={() => setMonthsBack(v)}
                className={cn(
                  'text-[10px] px-2 py-1 rounded-full font-medium border transition-all',
                  monthsBack === v
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground border-border hover:border-foreground/30'
                )}
              >
                {l}
              </button>
            ))}
          </div>

          <div className="w-px h-5 bg-border" />

          {/* Advanced filter dropdowns */}
          <div className="flex items-center gap-1.5">
            {filterOptions.types.length > 0 && (
              <FilterDropdown
                label="Type"
                icon={Briefcase}
                options={filterOptions.types}
                selected={typeFilter}
                onChange={setTypeFilter}
              />
            )}
            {filterOptions.orgs.length > 0 && (
              <FilterDropdown
                label="Organisation"
                icon={Building2}
                options={filterOptions.orgs}
                selected={orgFilter}
                onChange={setOrgFilter}
                searchable
              />
            )}
            {filterOptions.persons.length > 0 && (
              <FilterDropdown
                label="Person"
                icon={User}
                options={filterOptions.persons}
                selected={personFilter}
                onChange={setPersonFilter}
                searchable
              />
            )}
            {activeFilterCount > 0 && (
              <button
                onClick={clearAllFilters}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-medium text-red-600 hover:bg-red-50 transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
                Clear all ({activeFilterCount + (timeFilter !== 'all' ? 1 : 0) + (monthsBack > 0 ? 1 : 0)})
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Map area ── */}
      <div className="relative flex-1" style={{ minHeight: 600 }}>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/20 z-10">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : mappable.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/10">
            <div className="text-center max-w-md px-6">
              <div className="mx-auto w-16 h-16 rounded-full bg-muted/60 flex items-center justify-center mb-4">
                <MapPin className="h-8 w-8 text-muted-foreground" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No geocoded projects yet</h3>
              <p className="text-sm text-muted-foreground mb-1">
                {allProjects.filter(p => p.property_address).length} projects have addresses but none have been geocoded.
              </p>
              <p className="text-xs text-muted-foreground mb-5">
                Projects are geocoded automatically when created. You can also trigger batch geocoding manually.
              </p>
              <Button onClick={handleGeocodeNow} disabled={geocoding} className="gap-2">
                {geocoding
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Geocoding...</>
                  : <><Crosshair className="h-4 w-4" /> Geocode Now</>}
              </Button>
              {geocodeResult && (
                <div className={cn('mt-3 text-xs px-3 py-2 rounded-lg', geocodeResult.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-amber-50 text-amber-700 border border-amber-200')}>
                  {geocodeResult.message}
                </div>
              )}
            </div>
          </div>
        ) : (
          <MapContainer
            key={mapKey}
            center={SYDNEY}
            zoom={11}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            zoomControl={false}
            className="z-0"
          >
            <TileLayer attribution={TILE_ATTR} url={mapTheme === 'dark' ? TILE_DARK : TILE_LIGHT} key={mapTheme} />
            <ZoomControl position="bottomright" />

            {(mode === 'territory' || mode === 'timeline') && (
              <TerritoryBubbles
                clusters={activeClusters}
                metric={metric}
                onSelect={(c) => setSelectedCluster(c)}
                selectedSuburb={selectedCluster?.suburb}
              />
            )}

            {mode === 'pins' && (
              <MarkerClusterLayer
                projects={filtered}
                users={allUsers}
                mode="pipeline"
                onSelectProject={handleProjectClick}
              />
            )}
          </MapContainer>
        )}

        {/* Top suburbs leaderboard (territory & timeline modes) */}
        {(mode === 'territory' || mode === 'timeline') && topSuburbs.length > 0 && (
          <div className="absolute top-3 left-3 w-56 bg-background/95 backdrop-blur-sm border rounded-xl shadow-lg z-20 overflow-hidden">
            <div className="px-3 py-2 border-b bg-muted/30">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
                  {metric === 'revenue' ? 'Revenue by area' : 'Project volume'}
                </span>
                <BarChart3 className="h-3 w-3 text-muted-foreground" />
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto">
              {topSuburbs.map((cluster, i) => {
                const val = metric === 'revenue'
                  ? cluster.projects.reduce((s, p) => s + projectValue(p), 0)
                  : cluster.projects.length;
                const maxVal = metric === 'revenue'
                  ? topSuburbs[0].projects.reduce((s, p) => s + projectValue(p), 0)
                  : topSuburbs[0].projects.length;
                return (
                  <button
                    key={`${cluster.suburb}-${i}`}
                    onClick={() => setSelectedCluster(cluster)}
                    className={cn(
                      'w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0',
                      selectedCluster?.suburb === cluster.suburb && 'bg-primary/5'
                    )}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold flex items-center gap-1.5">
                        <span className="text-muted-foreground w-4 text-right font-mono text-[10px]">{i + 1}</span>
                        {cluster.suburb}
                      </span>
                      <span className="text-xs font-bold tabular-nums">{metric === 'revenue' ? `$${Math.round(val / 1000)}k` : val}</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${(val / maxVal) * 100}%`,
                          backgroundColor: getBubbleGradientColor(cluster.projects),
                        }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Timeline controls */}
        {mode === 'timeline' && timelineMonths.length > 0 && (
          <TimelineControls
            months={timelineMonths}
            currentIndex={timelineIndex}
            onChange={setTimelineIndex}
            playing={playing}
            onTogglePlay={() => {
              if (!playing && timelineIndex >= timelineMonths.length - 1) {
                setTimelineIndex(0);
              }
              setPlaying(p => !p);
            }}
            stats={timelineStats}
          />
        )}

        {/* Suburb detail panel */}
        {selectedCluster && <SuburbPanel cluster={selectedCluster} onClose={() => setSelectedCluster(null)} />}
      </div>
    </div>
  );
}

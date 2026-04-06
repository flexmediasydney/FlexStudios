import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  X, ChevronRight, MapPin, DollarSign, TrendingUp, TrendingDown,
  Building2, Play, Pause, Layers, BarChart3, Eye, Clock,
  Loader2, Crosshair, List, Calendar, AlertTriangle
} from 'lucide-react';
import { MapContainer, TileLayer, useMap, CircleMarker, Tooltip as LTooltip, ZoomControl } from 'react-leaflet';
import { fixTimestamp, fmtDate } from '@/components/utils/dateUtils';
import { stageLabel } from '@/components/projects/projectStatuses';
import MarkerClusterLayer from './MarkerClusterLayer';
import { format, subMonths, differenceInDays, startOfMonth, endOfMonth, eachMonthOfInterval } from 'date-fns';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
});

const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_DARK = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';
const SYDNEY = [-33.8688, 151.2093];

const projectValue = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

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

function SuburbPanel({ cluster, allProjects, onClose }) {
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
          <p className="text-xs text-muted-foreground">{projects.length} projects · ${totalRevenue.toLocaleString()}</p>
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
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary/60 rounded-full" style={{ width: `${(count / projects.length) * 100}%` }} /></div>
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
                  <div className="text-[10px] text-muted-foreground">{p.agency_name} · {p.shoot_date ? fmtDate(p.shoot_date, 'd MMM yy') : 'No date'}</div>
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

const STAGE_COLORS = { pending_review: '#f59e0b', to_be_scheduled: '#94a3b8', scheduled: '#3b82f6', onsite: '#eab308', uploaded: '#f97316', submitted: '#8b5cf6', in_progress: '#7c3aed', in_production: '#06b6d4', ready_for_partial: '#6366f1', in_revision: '#d97706', delivered: '#10b981' };
function getStageColor(status) { return STAGE_COLORS[status] || '#94a3b8'; }

function TerritoryBubbles({ clusters, metric, onSelect, selectedSuburb }) {
  return clusters.map((cluster, i) => {
    const value = metric === 'revenue' ? cluster.projects.reduce((s, p) => s + projectValue(p), 0) : cluster.projects.length;
    const maxVal = metric === 'revenue' ? 100000 : 30;
    const radius = Math.max(12, Math.min(50, (value / maxVal) * 50));
    const isSelected = selectedSuburb === cluster.suburb;
    return (
      <CircleMarker key={`${cluster.suburb}-${i}`} center={[cluster.lat, cluster.lng]} radius={radius}
        pathOptions={{ fillColor: isSelected ? '#2563eb' : '#6366f1', fillOpacity: isSelected ? 0.9 : 0.55, color: '#fff', weight: isSelected ? 3 : 1.5, opacity: 0.9 }}
        eventHandlers={{ click: () => onSelect(cluster) }}>
        <LTooltip direction="top" offset={[0, -radius]}>
          <div className="text-center px-1">
            <div className="font-bold text-sm">{cluster.suburb}</div>
            <div className="text-xs text-muted-foreground">{cluster.projects.length} projects · ${cluster.projects.reduce((s, p) => s + projectValue(p), 0).toLocaleString()}</div>
          </div>
        </LTooltip>
      </CircleMarker>
    );
  });
}

function useTimelinePlayback(projects, playing, speed = 200) {
  const [currentDate, setCurrentDate] = useState(null);
  const intervalRef = useRef(null);
  const dates = useMemo(() => {
    if (!projects.length) return [];
    const sorted = projects.filter(p => p.created_date).sort((a, b) => new Date(fixTimestamp(a.created_date)) - new Date(fixTimestamp(b.created_date)));
    if (sorted.length === 0) return [];
    return eachMonthOfInterval({ start: new Date(fixTimestamp(sorted[0].created_date)), end: new Date() });
  }, [projects]);

  useEffect(() => {
    if (playing && dates.length > 0) {
      let idx = 0;
      setCurrentDate(dates[0]);
      intervalRef.current = setInterval(() => { idx++; if (idx >= dates.length) { clearInterval(intervalRef.current); return; } setCurrentDate(dates[idx]); }, speed);
      return () => clearInterval(intervalRef.current);
    } else { clearInterval(intervalRef.current); }
  }, [playing, dates, speed]);
  return { currentDate, totalMonths: dates.length };
}

export default function TerritoryMap() {
  const [mode, setMode] = useState('territory');
  const [metric, setMetric] = useState('count');
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [monthsBack, setMonthsBack] = useState(0);
  const [selectedCluster, setSelectedCluster] = useState(null);
  const [mapTheme, setMapTheme] = useState('light');
  const [playing, setPlaying] = useState(false);
  const [mapKey, setMapKey] = useState(0);

  const [geocoding, setGeocoding] = useState(false);
  const [geocodeResult, setGeocodeResult] = useState(null);

  const { data: allProjects = [], loading, refetch: refreshProjects } = useEntityList('Project', '-created_date', 1000);
  const { data: allUsers = [] } = useEntityList('User');

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

  const mappable = useMemo(() => allProjects.filter(p => {
    const lat = p?.geocoded_lat || p?.latitude;
    const lng = p?.geocoded_lng || p?.longitude;
    return lat && lng && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng));
  }).map(p => ({
    ...p,
    lat: parseFloat(p.geocoded_lat || p.latitude),
    lng: parseFloat(p.geocoded_lng || p.longitude),
  })), [allProjects]);

  const filtered = useMemo(() => {
    const now = new Date();
    const cutoff = monthsBack > 0 ? subMonths(now, monthsBack) : null;
    return mappable.filter(p => {
      if (cutoff && p.created_date) { const d = new Date(fixTimestamp(p.created_date)); if (d < cutoff) return false; }
      if (agencyFilter !== 'all' && p.agency_id !== agencyFilter) return false;
      return true;
    });
  }, [mappable, monthsBack, agencyFilter]);

  const clusters = useMemo(() => clusterByProximity(filtered), [filtered]);
  const agencyOptions = useMemo(() => { const seen = new Map(); mappable.forEach(p => { if (p.agency_id && p.agency_name) seen.set(p.agency_id, p.agency_name); }); return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1])); }, [mappable]);
  const topSuburbs = useMemo(() => [...clusters].sort((a, b) => { if (metric === 'revenue') return b.projects.reduce((s, p) => s + projectValue(p), 0) - a.projects.reduce((s, p) => s + projectValue(p), 0); return b.projects.length - a.projects.length; }).slice(0, 10), [clusters, metric]);

  const { currentDate } = useTimelinePlayback(mappable, playing);
  const timelineFiltered = useMemo(() => { if (!playing || !currentDate) return filtered; return mappable.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) <= currentDate); }, [playing, currentDate, mappable, filtered]);
  const activeClusters = playing ? clusterByProximity(timelineFiltered) : clusters;
  const totalRevenue = filtered.reduce((s, p) => s + projectValue(p), 0);
  const geocodedPct = allProjects.length > 0 ? Math.round((mappable.length / allProjects.length) * 100) : 0;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-background shrink-0">
        <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
          {[{ v: 'territory', l: 'Territory', icon: Layers }, { v: 'pins', l: 'All Pins', icon: MapPin }, { v: 'timeline', l: 'Timeline', icon: Clock }].map(({ v, l, icon: Icon }) => (
            <button key={v} onClick={() => { setMode(v); if (v !== 'timeline') setPlaying(false); }} className={cn('text-xs px-3 py-1.5 rounded-md font-medium transition-all flex items-center gap-1.5', mode === v ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground')}><Icon className="h-3 w-3" />{l}</button>
          ))}
        </div>
        {mode === 'territory' && (
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            {[{ v: 'count', l: 'Volume' }, { v: 'revenue', l: 'Revenue' }].map(({ v, l }) => (
              <button key={v} onClick={() => setMetric(v)} className={cn('text-xs px-2.5 py-1 rounded-md font-medium transition-all', metric === v ? 'bg-background shadow-sm' : 'text-muted-foreground')}>{l}</button>
            ))}
          </div>
        )}
        {mode === 'timeline' && (
          <button onClick={() => setPlaying(p => !p)} className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all', playing ? 'bg-red-100 text-red-700 border border-red-200' : 'bg-green-100 text-green-700 border border-green-200')}>
            {playing ? <><Pause className="h-3 w-3" /> Pause</> : <><Play className="h-3 w-3" /> Play history</>}
          </button>
        )}
        {agencyOptions.length > 0 && (
          <Select value={agencyFilter} onValueChange={setAgencyFilter}>
            <SelectTrigger className="w-44 h-7 text-xs"><SelectValue placeholder="All agencies" /></SelectTrigger>
            <SelectContent><SelectItem value="all">All agencies</SelectItem>{agencyOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          {playing && currentDate && <span className="font-mono font-bold text-primary">{format(currentDate, 'MMM yyyy')}</span>}
          <span>{filtered.length} projects · ${totalRevenue.toLocaleString()} · {geocodedPct}% geocoded</span>
          <button onClick={() => setMapTheme(t => t === 'light' ? 'dark' : 'light')} className="px-2 py-1 rounded border hover:bg-muted">{mapTheme === 'light' ? '🌙' : '☀️'}</button>
        </div>
      </div>
      {!playing && (
        <div className="px-4 py-2 border-b bg-muted/20 flex items-center gap-2 shrink-0">
          <span className="text-[10px] font-medium text-muted-foreground">Period:</span>
          {[{ v: 0, l: 'All time' }, { v: 24, l: '2 years' }, { v: 12, l: '1 year' }, { v: 6, l: '6 months' }, { v: 3, l: '3 months' }, { v: 1, l: 'This month' }].map(({ v, l }) => (
            <button key={v} onClick={() => setMonthsBack(v)} className={cn('text-[10px] px-2.5 py-1 rounded-full font-medium border transition-all', monthsBack === v ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-foreground/30')}>{l}</button>
          ))}
        </div>
      )}
      <div className="relative flex-1" style={{ minHeight: 500 }}>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/20 z-10"><Loader2 className="h-8 w-8 animate-spin text-primary" /></div>
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
              <Button
                onClick={handleGeocodeNow}
                disabled={geocoding}
                className="gap-2"
              >
                {geocoding ? <><Loader2 className="h-4 w-4 animate-spin" /> Geocoding...</> : <><Crosshair className="h-4 w-4" /> Geocode Now</>}
              </Button>
              {geocodeResult && (
                <div className={cn('mt-3 text-xs px-3 py-2 rounded-lg', geocodeResult.ok ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-amber-50 text-amber-700 border border-amber-200')}>
                  {geocodeResult.message}
                </div>
              )}
            </div>
          </div>
        ) : (
          <MapContainer key={mapKey} center={SYDNEY} zoom={11} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} zoomControl={false} className="z-0">
            <TileLayer attribution={TILE_ATTR} url={mapTheme === 'dark' ? TILE_DARK : TILE_LIGHT} key={mapTheme} />
            <ZoomControl position="bottomright" />
            {(mode === 'territory' || mode === 'timeline') && <TerritoryBubbles clusters={activeClusters} metric={metric} onSelect={(c) => setSelectedCluster(c)} selectedSuburb={selectedCluster?.suburb} />}
            {mode === 'pins' && <MarkerClusterLayer projects={filtered} users={allUsers} mode="pipeline" onSelectProject={() => {}} />}
          </MapContainer>
        )}
        {(mode === 'territory' || mode === 'timeline') && topSuburbs.length > 0 && (
          <div className="absolute top-3 left-3 w-56 bg-background/95 backdrop-blur-sm border rounded-xl shadow-lg z-20 overflow-hidden">
            <div className="px-3 py-2 border-b bg-muted/30"><div className="flex items-center justify-between"><span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{metric === 'revenue' ? 'Revenue by area' : 'Project volume'}</span><BarChart3 className="h-3 w-3 text-muted-foreground" /></div></div>
            <div className="max-h-80 overflow-y-auto">
              {topSuburbs.map((cluster, i) => {
                const val = metric === 'revenue' ? cluster.projects.reduce((s, p) => s + projectValue(p), 0) : cluster.projects.length;
                const maxVal = metric === 'revenue' ? topSuburbs[0].projects.reduce((s, p) => s + projectValue(p), 0) : topSuburbs[0].projects.length;
                return (
                  <button key={`${cluster.suburb}-${i}`} onClick={() => setSelectedCluster(cluster)} className={cn('w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors border-b border-border/30 last:border-0', selectedCluster?.suburb === cluster.suburb && 'bg-primary/5')}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-semibold flex items-center gap-1.5"><span className="text-muted-foreground w-4 text-right font-mono text-[10px]">{i + 1}</span>{cluster.suburb}</span>
                      <span className="text-xs font-bold tabular-nums">{metric === 'revenue' ? `$${Math.round(val / 1000)}k` : val}</span>
                    </div>
                    <div className="h-1 bg-muted rounded-full overflow-hidden"><div className="h-full bg-primary/50 rounded-full transition-all" style={{ width: `${(val / maxVal) * 100}%` }} /></div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
        {selectedCluster && <SuburbPanel cluster={selectedCluster} allProjects={allProjects} onClose={() => setSelectedCluster(null)} />}
      </div>
    </div>
  );
}
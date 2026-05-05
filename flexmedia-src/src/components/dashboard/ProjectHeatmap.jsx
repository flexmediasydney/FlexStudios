import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { api } from '@/api/supabaseClient';
import { MapContainer, TileLayer, useMap, useMapEvents, ZoomControl } from 'react-leaflet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import {
  X, ChevronRight, MapPin, Calendar, Building2, User,
  DollarSign, ExternalLink, Loader2, RefreshCw, AlertTriangle,
  CheckCircle, Clock, List, Layers, Crosshair
} from 'lucide-react';
import { fmtDate, parseDate, todaySydney, fixTimestamp } from '@/components/utils/dateUtils';
import { differenceInDays, format } from 'date-fns';
import { stageLabel } from '@/components/projects/projectStatuses';
import MarkerClusterLayer from './MarkerClusterLayer';
import { LEAFLET_ICON_OPTIONS } from '@/lib/constants';
import 'leaflet/dist/leaflet.css';
import L from 'leaflet';

// Fix leaflet default icons
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions(LEAFLET_ICON_OPTIONS);

// ─── Carto Positron — fast CDN, designed for data overlays ───────────────────
const TILE_LIGHT = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';
const TILE_DARK  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR  = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

const SYDNEY = [-33.8688, 151.2093];
const DEFAULT_ZOOM = 11;

// ─── Stage colors and labels ──────────────────────────────────────────────────
const STAGE_HEX = {
  pending_review:    '#f59e0b', to_be_scheduled: '#94a3b8',
  scheduled:        '#3b82f6', onsite:           '#eab308',
  uploaded:         '#f97316', in_progress:      '#7c3aed',
  in_production:    '#06b6d4',
  in_revision:      '#d97706', delivered:        '#10b981',
};

function shootTimingLabel(shootDate) {
  if (!shootDate) return { label: 'No date', color: 'bg-slate-100 text-slate-600', hex: '#94a3b8' };
  const shoot = parseDate(shootDate);
  const today = parseDate(todaySydney());
  if (!shoot || !today) return { label: 'No date', color: 'bg-slate-100 text-slate-600', hex: '#94a3b8' };
  const diff = Math.round((shoot - today) / (1000 * 60 * 60 * 24));
  if (diff < -1)  return { label: `${Math.abs(diff)}d ago`,  color: 'bg-red-100 text-red-700',      hex: '#ef4444' };
  if (diff === 0) return { label: 'Today',                   color: 'bg-green-100 text-green-700',   hex: '#22c55e' };
  if (diff === 1) return { label: 'Tomorrow',                color: 'bg-blue-100 text-blue-700',     hex: '#3b82f6' };
  if (diff <= 7)  return { label: `In ${diff}d`,             color: 'bg-blue-50 text-blue-600',      hex: '#60a5fa' };
  return { label: format(shoot, 'd MMM'), color: 'bg-slate-100 text-slate-500', hex: '#94a3b8' };
}

// ─── Map bounds tracker ───────────────────────────────────────────────────────
function BoundsTracker({ onBoundsChange }) {
  const map = useMapEvents({
    moveend: () => onBoundsChange(map.getBounds()),
    zoomend: () => onBoundsChange(map.getBounds()),
  });
  useEffect(() => { onBoundsChange(map.getBounds()); }, []);
  return null;
}

// ─── Fly-to helper ────────────────────────────────────────────────────────────
function FlyTo({ target }) {
  const map = useMap();
  useEffect(() => {
    if (target) map.flyTo([target.lat, target.lng], Math.max(map.getZoom(), 15), { duration: 0.8 });
  }, [target]);
  return null;
}

// ─── Stat pill ────────────────────────────────────────────────────────────────
function StatPill({ label, value, color, onClick, active }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all border',
        active
          ? 'bg-foreground text-background border-foreground shadow-sm'
          : 'bg-background border-border hover:border-foreground/30 text-foreground'
      )}
    >
      <span className={cn('h-2 w-2 rounded-full shrink-0', color)} />
      {value} {label}
    </button>
  );
}

// ─── Project drawer (right side) ─────────────────────────────────────────────
function ProjectDrawer({ project, onClose }) {
  if (!project) return null;
  const timing = shootTimingLabel(project.shoot_date);
  const stageHex = STAGE_HEX[project.status] || '#94a3b8';
  const value = project.invoiced_amount ?? project.calculated_price ?? project.price ?? null;

  return (
    <div className="absolute top-0 right-0 h-full w-72 bg-background border-l shadow-xl z-20 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <div className="flex items-center gap-2">
          <div className="h-3 w-3 rounded-full shrink-0" style={{ backgroundColor: stageHex }} />
          <span className="text-xs font-semibold">{stageLabel(project.status)}</span>
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-4">
        {/* Address */}
        <div>
          <p className="text-base font-bold leading-tight">
            {project.title || project.property_address}
          </p>
          {project.title && project.property_address && (
            <p className="text-xs text-muted-foreground mt-0.5 flex items-start gap-1">
              <MapPin className="h-3 w-3 mt-0.5 shrink-0" />
              {project.property_address}
            </p>
          )}
        </div>

        {/* Key facts grid */}
        <div className="grid grid-cols-2 gap-2 text-xs">
          {project.shoot_date && (
            <div className="bg-muted/50 rounded-lg p-2.5">
              <p className="text-muted-foreground mb-0.5">Shoot date</p>
              <p className="font-semibold">{fmtDate(project.shoot_date, 'd MMM yyyy')}</p>
              <Badge className={cn('text-[10px] mt-1 py-0', timing.color)}>{timing.label}</Badge>
            </div>
          )}
          {project.delivery_date && (
            <div className="bg-muted/50 rounded-lg p-2.5">
              <p className="text-muted-foreground mb-0.5">Delivery</p>
              <p className="font-semibold">{fmtDate(project.delivery_date, 'd MMM yyyy')}</p>
            </div>
          )}
          {value != null && (
            <div className="bg-muted/50 rounded-lg p-2.5">
              <p className="text-muted-foreground mb-0.5">Value</p>
              <p className="font-semibold">${value.toLocaleString()}</p>
            </div>
          )}
          {project.property_type && (
            <div className="bg-muted/50 rounded-lg p-2.5">
              <p className="text-muted-foreground mb-0.5">Type</p>
              <p className="font-semibold capitalize">{project.property_type}</p>
            </div>
          )}
        </div>

        {/* Agent / Agency */}
        {(project.agent_name || project.agency_name) && (
          <div className="space-y-1.5">
            {project.agent_name && (
              <div className="flex items-center gap-2 text-xs">
                <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span>{project.agent_name}</span>
              </div>
            )}
            {project.agency_name && (
              <div className="flex items-center gap-2 text-xs">
                <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-muted-foreground">{project.agency_name}</span>
              </div>
            )}
          </div>
        )}

        {/* Delivery link */}
        {project.tonomo_deliverable_link && (
          <a
            href={project.tonomo_deliverable_link}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            View delivery folder
          </a>
        )}
      </div>

      {/* Footer CTA */}
      <div className="p-4 border-t shrink-0">
        <Link
          to={createPageUrl('ProjectDetails') + `?id=${project.id}`}
          className="flex items-center justify-center gap-2 w-full bg-primary text-primary-foreground
            rounded-lg py-2.5 text-sm font-semibold hover:opacity-90 transition-opacity"
        >
          Open project <ChevronRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

// ─── Side list panel ──────────────────────────────────────────────────────────
function ProjectListPanel({ projects, selectedId, onSelect, loading }) {
  return (
    <div className="absolute top-0 left-0 h-full w-64 bg-background/95 backdrop-blur-sm border-r z-20 flex flex-col">
      <div className="px-3 py-2.5 border-b shrink-0">
        <p className="text-xs font-semibold text-muted-foreground">
          {loading ? 'Loading…' : `${projects.length} project${projects.length !== 1 ? 's' : ''} in view`}
        </p>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {projects.length === 0 && !loading && (
          <div className="p-4 text-center text-xs text-muted-foreground">
            No projects in current map view
          </div>
        )}
        {projects.map(p => {
          const timing = shootTimingLabel(p.shoot_date);
          const stageHex = STAGE_HEX[p.status] || '#94a3b8';
          return (
            <button
              key={p.id}
              onClick={() => onSelect(p)}
              className={cn(
                'w-full text-left px-3 py-2.5 border-b border-border/50 hover:bg-muted/50 transition-colors',
                selectedId === p.id && 'bg-primary/5 border-l-2 border-l-primary'
              )}
            >
              <div className="flex items-start gap-2">
                <div className="h-2.5 w-2.5 rounded-full mt-1 shrink-0" style={{ backgroundColor: stageHex }} />
                <div className="min-w-0">
                  <p className="text-xs font-medium truncate">
                    {p.title || p.property_address}
                  </p>
                  {p.shoot_date && (
                    <p className={cn('text-[10px] mt-0.5', timing.color.replace('bg-', 'text-').split(' ')[0])}>
                      {timing.label}
                    </p>
                  )}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ProjectHeatmap() {
  const [mapMode, setMapMode]           = useState('shoots');   // 'shoots' | 'pipeline'
  const [timingFilter, setTimingFilter] = useState('all');       // 'today' | 'week' | 'active' | 'all'
  const [agencyFilter, setAgencyFilter] = useState('all');
  const [staffFilter, setStaffFilter]   = useState('all');
  const [selectedProject, setSelectedProject] = useState(null);
  const [showList, setShowList]         = useState(true);
  const [mapBounds, setMapBounds]       = useState(null);
  const [flyTarget, setFlyTarget]       = useState(null);
  const [geocoding, setGeocoding]       = useState(false);
  const [geocodeError, setGeocodeError] = useState(null);
  const [mapTheme, setMapTheme]         = useState('light');
  const [mapKey, setMapKey]             = useState(0);

  const { data: allProjects = [], loading } = useEntityList('Project', '-created_date', 500);
  const { data: allUsers = [] }             = useEntityList('User');

  // ── Geocode projects that are missing lat/lng ────────────────────────────
  const geocodeMissing = useCallback(async (projects) => {
    if (!Array.isArray(projects)) return;
    const missing = projects.filter(p => p?.property_address && p?.id && (p.lat == null || p.lng == null));
    if (missing.length === 0) return;

    setGeocoding(true);
    setGeocodeError(null);
    let mounted = true;
    try {
      // Batch into chunks of 50 to avoid function timeout
      const CHUNK = 50;
      for (let i = 0; i < missing.length; i += CHUNK) {
        if (!mounted) break;
        const chunk = missing.slice(i, i + CHUNK);
        const response = await api.functions.invoke('geocodeProject', {
          projectIds: chunk.map(p => p.id)
        });
        // Force refresh the projects list after each batch
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (e) {
      console.error('Geocoding error:', e);
      if (mounted) setGeocodeError('Geocoding failed — some pins may be missing');
    } finally {
      if (mounted) setGeocoding(false);
    }
    return () => { mounted = false; };
  }, []);

  // Run geocoder once when projects load
  const geocodedOnce = useRef(false);
  useEffect(() => {
    let mounted = true;
    if (Array.isArray(allProjects) && allProjects.length && !geocodedOnce.current && mounted) {
      geocodedOnce.current = true;
      geocodeMissing(allProjects);
    }
    return () => { mounted = false; };
  }, [allProjects, geocodeMissing]);

  // ── Projects with coordinates ────────────────────────────────────────────
  const mappableProjects = useMemo(() => {
    if (!Array.isArray(allProjects)) return [];
    return allProjects.filter(p => p?.lat != null && p?.lng != null && !isNaN(p.lat) && !isNaN(p.lng));
  }, [allProjects]);

  // ── Apply filters ────────────────────────────────────────────────────────
  const filteredProjects = useMemo(() => {
    const today = parseDate(todaySydney());
    return mappableProjects.filter(p => {
      // Timing filter
      if (timingFilter !== 'all') {
        const shoot = parseDate(p.shoot_date);
        if (timingFilter === 'today') {
          if (!shoot || !today || shoot.getTime() !== today.getTime()) return false;
        } else if (timingFilter === 'week') {
          if (!shoot || !today) return false;
          const diff = Math.round((shoot - today) / (1000 * 60 * 60 * 24));
          if (diff < 0 || diff > 7) return false;
        } else if (timingFilter === 'active') {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
        }
      }
      // Agency
      if (agencyFilter !== 'all' && p.agency_id !== agencyFilter && p.agency_name !== agencyFilter) return false;
      // Staff
      if (staffFilter !== 'all') {
        const inStaff = [p.project_owner_id, p.photographer_id, p.videographer_id, p.onsite_staff_1_id, p.onsite_staff_2_id].includes(staffFilter);
        if (!inStaff) return false;
      }
      return true;
    });
  }, [mappableProjects, timingFilter, agencyFilter, staffFilter]);

  // ── Projects visible in current map bounds ───────────────────────────────
  const visibleProjects = useMemo(() => {
    if (!mapBounds) return filteredProjects;
    return filteredProjects.filter(p =>
      mapBounds.contains([p.lat, p.lng])
    );
  }, [filteredProjects, mapBounds]);

  // ── Quick stats ──────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    if (!Array.isArray(filteredProjects)) return { today: 0, week: 0, active: 0, overdue: 0 };
    const today = parseDate(todaySydney());
    return {
      today:    filteredProjects.filter(p => { const s = parseDate(p?.shoot_date); return s && today && s.getTime() === today.getTime(); }).length,
      week:     filteredProjects.filter(p => { const s = parseDate(p?.shoot_date); if (!s || !today) return false; const d = Math.round((s - today) / 86400000); return d >= 0 && d <= 7; }).length,
      active:   filteredProjects.filter(p => !['delivered','cancelled'].includes(p?.status)).length,
      overdue:  filteredProjects.filter(p => { if (!p?.delivery_date) return false; try { return new Date(fixTimestamp(p.delivery_date)) < new Date() && p.status !== 'delivered'; } catch { return false; } }).length,
    };
  }, [filteredProjects]);

  // ── Agencies / Staff for filter dropdowns ───────────────────────────────
  const agencyOptions = useMemo(() => {
    const seen = new Map();
    mappableProjects.forEach(p => {
      if (p.agency_id && p.agency_name) seen.set(p.agency_id, p.agency_name);
      else if (p.agency_name) seen.set(p.agency_name, p.agency_name);
    });
    return Array.from(seen.entries()).sort((a, b) => a[1].localeCompare(b[1]));
  }, [mappableProjects]);

  const staffOptions = useMemo(() => {
    const ids = new Set(mappableProjects.flatMap(p =>
      [...new Set([p.project_owner_id, p.photographer_id, p.videographer_id, p.onsite_staff_1_id, p.onsite_staff_2_id].filter(Boolean))]
    ));
    return allUsers.filter(u => ids.has(u.id)).sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
  }, [mappableProjects, allUsers]);

  const handleSelectProject = useCallback((p) => {
    setSelectedProject(p);
    setFlyTarget(p);
  }, []);

  const handleBoundsChange = useCallback((bounds) => setMapBounds(bounds), []);

  const missingCount = allProjects.filter(p => p.property_address && (p.lat == null || p.lng == null)).length;

  return (
    <div className="flex flex-col space-y-0">

      {/* ── Control bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-background shrink-0">

        {/* Mode toggle */}
        <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
          {[
            { v: 'shoots',   l: '📅 Shoots',   title: 'Color by shoot timing' },
            { v: 'pipeline', l: '⚙️ Pipeline',  title: 'Color by workflow stage' },
          ].map(({ v, l, title }) => (
            <button key={v} title={title} onClick={() => setMapMode(v)}
              className={cn(
                'text-xs px-3 py-1.5 rounded-md font-medium transition-all',
                mapMode === v ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}>
              {l}
            </button>
          ))}
        </div>

        {/* Timing quick-filter pills */}
        <div className="flex gap-1.5 flex-wrap">
          <StatPill label="today" value={stats.today}  color="bg-green-500"  onClick={() => setTimingFilter(f => f === 'today'  ? 'all' : 'today')}  active={timingFilter === 'today'} />
          <StatPill label="this week" value={stats.week}   color="bg-blue-500"  onClick={() => setTimingFilter(f => f === 'week'   ? 'all' : 'week')}   active={timingFilter === 'week'} />
          <StatPill label="active" value={stats.active} color="bg-violet-500" onClick={() => setTimingFilter(f => f === 'active' ? 'all' : 'active')} active={timingFilter === 'active'} />
          {stats.overdue > 0 && (
            <StatPill label="overdue" value={stats.overdue} color="bg-red-500" onClick={() => {}} active={false} />
          )}
        </div>

        {/* Agency + Staff dropdowns */}
        {agencyOptions.length > 0 && (
          <Select value={agencyFilter} onValueChange={setAgencyFilter}>
            <SelectTrigger className="w-40 h-7 text-xs"><SelectValue placeholder="All agencies" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All agencies</SelectItem>
              {agencyOptions.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        {staffOptions.length > 0 && (
          <Select value={staffFilter} onValueChange={setStaffFilter}>
            <SelectTrigger className="w-40 h-7 text-xs"><SelectValue placeholder="All photographers" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All photographers</SelectItem>
              {staffOptions.map(u => <SelectItem key={u.id} value={u.id}>{u.full_name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}

        {/* Right side controls */}
        <div className="ml-auto flex items-center gap-2">
          {geocoding && (
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Geocoding {missingCount} addresses…
            </div>
          )}
          {geocodeError && (
            <span className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />{geocodeError}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {filteredProjects.length} pins · {mappableProjects.length}/{allProjects.length} geocoded
          </span>
          <button
            onClick={() => setMapKey(k => k + 1)}
            className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
            title="Recenter map to Sydney"
          >
            <Crosshair className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => setMapTheme(t => t === 'light' ? 'dark' : 'light')}
            className="text-xs px-2 py-1 rounded border hover:bg-muted transition-colors"
            title="Toggle map theme"
          >
            {mapTheme === 'light' ? '🌙' : '☀️'}
          </button>
          <button
            onClick={() => setShowList(v => !v)}
            className={cn('text-xs px-2 py-1 rounded border transition-colors flex items-center gap-1',
              showList ? 'bg-foreground text-background' : 'hover:bg-muted')}
            title="Toggle project list"
          >
            <List className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* ── Legend ──────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3 py-1.5 bg-muted/30 border-b text-[10px] text-muted-foreground shrink-0 flex-wrap">
        {mapMode === 'shoots' ? (
          <>
            <span className="font-medium text-foreground">Shoots:</span>
            {[
              { color: '#22c55e', label: 'Today' },
              { color: '#3b82f6', label: 'This week' },
              { color: '#94a3b8', label: 'Future' },
              { color: '#ef4444', label: 'Past / overdue' },
            ].map(l => (
              <span key={l.label} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </span>
            ))}
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">Stage:</span>
            {[
              { color: '#3b82f6', label: 'Scheduled' },
              { color: '#7c3aed', label: 'In Progress' },
              { color: '#d97706', label: 'In Revision' },
              { color: '#10b981', label: 'Delivered' },
              { color: '#f59e0b', label: 'Pending Review' },
            ].map(l => (
              <span key={l.label} className="flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                {l.label}
              </span>
            ))}
          </>
        )}
      </div>

      {/* ── Map container ───────────────────────────────────────────── */}
      <div className="relative" style={{ height: 600 }}>
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/20 z-10">
            <div className="text-center space-y-2">
              <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
              <p className="text-sm text-muted-foreground">Loading projects…</p>
            </div>
          </div>
        ) : (
          <MapContainer
            key={mapKey}
            center={SYDNEY}
            zoom={DEFAULT_ZOOM}
            style={{ height: 600, width: '100%' }}
            className="z-0"
            zoomControl={false}
          >
            <TileLayer
              attribution={TILE_ATTR}
              url={mapTheme === 'dark' ? TILE_DARK : TILE_LIGHT}
              key={mapTheme}
            />
            <ZoomControl position="bottomright" />

            <BoundsTracker onBoundsChange={handleBoundsChange} />
            {flyTarget && <FlyTo target={flyTarget} key={flyTarget.id} />}

            <MarkerClusterLayer
              projects={filteredProjects}
              users={allUsers}
              mode={mapMode}
              onSelectProject={handleSelectProject}
            />
          </MapContainer>
        )}

        {/* Left project list */}
        {showList && !loading && (
          <ProjectListPanel
            projects={visibleProjects}
            selectedId={selectedProject?.id}
            onSelect={handleSelectProject}
            loading={geocoding && mappableProjects.length === 0}
          />
        )}

        {/* Right project drawer */}
        {selectedProject && (
          <ProjectDrawer
            project={selectedProject}
            onClose={() => setSelectedProject(null)}
          />
        )}

        {/* Empty state overlay */}
        {!loading && filteredProjects.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-background/90 backdrop-blur-sm rounded-xl border p-6 text-center shadow-xl max-w-xs">
              <MapPin className="h-10 w-10 mx-auto text-muted-foreground/30 mb-3" />
              <p className="text-sm font-medium mb-1">No projects to show</p>
              <p className="text-xs text-muted-foreground">
                {mappableProjects.length === 0
                  ? 'Geocoding addresses… pins will appear shortly'
                  : 'Try changing your filters'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
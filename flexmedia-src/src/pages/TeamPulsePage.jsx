import { useState, useEffect, useRef, useMemo } from "react";
import ErrorBoundary from "@/components/common/ErrorBoundary";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import {
  Activity, LayoutGrid, BarChart2, RefreshCw, Search,
  AlertCircle, AlertTriangle, Info, ChevronRight, Users,
  TrendingUp, Pause, Play, X, Clock
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { createPageUrl } from "@/utils";
import { base44 } from "@/api/base44Client";
import { useCurrentUser } from "@/components/auth/PermissionGuard";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import EffortTimersTab from "@/components/team-pulse/EffortTimersTab";

// ── Constants ─────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 15_000; // 15 seconds

const CATEGORY_CONFIG = {
  project:    { label: "Projects",        icon: "📁", color: "bg-violet-100 text-violet-700 border-violet-200" },
  task:       { label: "Tasks",           icon: "📋", color: "bg-cyan-100 text-cyan-700 border-cyan-200" },
  requests:   { label: "Requests",        icon: "🔄", color: "bg-amber-100 text-amber-700 border-amber-200" },
  revision:   { label: "Requests",        icon: "🔄", color: "bg-amber-100 text-amber-700 border-amber-200" }, // legacy alias
  tonomo:     { label: "Tonomo",          icon: "⚡", color: "bg-emerald-100 text-emerald-700 border-emerald-200" },
  financial:  { label: "Financial",       icon: "💰", color: "bg-green-100 text-green-700 border-green-200" },
  scheduling: { label: "Scheduling",      icon: "📅", color: "bg-blue-100 text-blue-700 border-blue-200" },
  automation: { label: "Automation",      icon: "⚙️", color: "bg-slate-100 text-slate-600 border-slate-200" },
  system:     { label: "System",          icon: "🔧", color: "bg-gray-100 text-gray-600 border-gray-200" },
};

const SEVERITY_CONFIG = {
  critical: { icon: <AlertCircle className="h-3.5 w-3.5 text-red-500" />,    dot: "bg-red-500",   bar: "bg-red-500" },
  warning:  { icon: <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />, dot: "bg-amber-400", bar: "bg-amber-400" },
  info:     { icon: <Info className="h-3.5 w-3.5 text-blue-400" />,          dot: "bg-blue-400",  bar: "bg-blue-400" },
};

// ── Helpers ───────────────────────────────────────────────────────────────
const normalizeTimestamp = (ts) => {
  if (!ts) return null;
  return ts.endsWith("Z") ? ts : ts + "Z";
};

function relTime(ts) {
  if (!ts) return "";
  const normalized = normalizeTimestamp(ts);
  if (!normalized) return "";
  
  const ms = Date.now() - new Date(normalized).getTime();
  const s = Math.floor(ms / 1000);
  
  if (s < 0) return "just now"; // Future timestamps
  if (s < 60)  return `${s}s ago`;
  
  const m = Math.floor(s / 60);
  if (m < 60)  return `${m}m ago`;
  
  const h = Math.floor(m / 60);
  if (h < 24)  return `${h}h ago`;
  
  return `${Math.floor(h / 24)}d ago`;
}

function getInitials(name) {
  if (!name || typeof name !== 'string') return "?";
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return words.map(w => w[0]?.toUpperCase() || "").join("").slice(0, 2) || "?";
}

function parseMetadata(raw) {
  if (!raw || typeof raw !== 'string') return {};
  try { 
    return JSON.parse(raw); 
  } catch (err) { 
    console.warn('[parseMetadata] Invalid JSON:', err);
    return {}; 
  }
}

// ── Live Feed ─────────────────────────────────────────────────────────────
function LiveFeedView({ events, loading, paused, onTogglePause, newCount }) {
  const navigate = useNavigate();
  const [catFilter, setCatFilter] = useState("all");
  const [sevFilter, setSevFilter] = useState("all");
  const [search, setSearch]       = useState("");
  const feedRef = useRef(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Keyboard shortcut: Esc to clear search
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && search) {
        e.preventDefault();
        setSearch('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [search]);

  // Auto-scroll to top when new events arrive (if not paused and autoScroll on)
  useEffect(() => {
    if (!paused && autoScroll && feedRef.current) {
      feedRef.current.scrollTop = 0;
    }
  }, [events.length, paused, autoScroll]);

  const filtered = useMemo(() => {
    if (!events || events.length === 0) return [];
    
    const searchQuery = search.trim().toLowerCase();
    
    return events.filter(e => {
      // Category filter
      if (catFilter !== "all" && e.category !== catFilter) return false;
      
      // Severity filter
      if (sevFilter !== "all" && e.severity !== sevFilter) return false;
      
      // Search filter
      if (searchQuery) {
        const searchText = [
          e.title || "",
          e.description || "",
          e.project_name || "",
          e.project_address || ""
        ].join(" ").toLowerCase();
        
        if (!searchText.includes(searchQuery)) return false;
      }
      
      return true;
    });
  }, [events, catFilter, sevFilter, search]);

  function handleEventClick(event) {
    if (event.project_id) {
      navigate(createPageUrl("ProjectDetails") + `?id=${event.project_id}`);
    }
  }

  return (
    <div className="flex flex-col h-full gap-3">
      {/* Controls */}
      <div className="flex gap-2 flex-wrap items-center shrink-0">
        <div className="relative flex-1 min-w-40">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search feed... (press Esc to clear)"
            className="pl-8 pr-8 h-8 text-xs transition-all focus-visible:ring-primary/50"
            value={search}
            onChange={e => setSearch(e.target.value)}
            autoComplete="off"
            spellCheck="false"
            title="Search by title, project, or description (Esc to clear)"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full p-1 transition-colors"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <Select value={catFilter} onValueChange={setCatFilter}>
          <SelectTrigger className="w-36 h-8 text-xs shadow-sm"><SelectValue placeholder="All categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-medium">All categories</SelectItem>
            {Object.entries(CATEGORY_CONFIG)
              .filter(([v]) => v !== 'revision') // hide legacy alias from UI
              .map(([v, c]) => (
                <SelectItem key={v} value={v} className="font-medium">{c.icon} {c.label}</SelectItem>
              ))}
          </SelectContent>
        </Select>
        <Select value={sevFilter} onValueChange={setSevFilter}>
          <SelectTrigger className="w-32 h-8 text-xs shadow-sm"><SelectValue placeholder="All severities" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="font-medium">All severities</SelectItem>
            <SelectItem value="critical" className="font-medium">🔴 Critical</SelectItem>
            <SelectItem value="warning" className="font-medium">🟡 Warning</SelectItem>
            <SelectItem value="info" className="font-medium">🔵 Info</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 ml-auto">
          {newCount > 0 && !paused && (
            <Badge className="bg-blue-100 text-blue-700 text-[10px] font-bold animate-pulse shadow-sm">
              +{newCount} new
            </Badge>
          )}
          <Button
            variant={paused ? "default" : "outline"}
            size="sm"
            className="h-8 text-xs gap-1.5 shadow-sm"
            onClick={onTogglePause}
            title={paused ? "Resume live updates" : "Pause live updates"}
          >
            {paused
              ? <><Play className="h-3.5 w-3.5" /> Resume</>
              : <><Pause className="h-3.5 w-3.5" /> Pause</>
            }
          </Button>
        </div>
      </div>

      {/* Paused banner */}
      {paused && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-2.5 text-xs text-amber-700 flex items-center gap-2 shrink-0 shadow-sm animate-in slide-in-from-top">
          <Pause className="h-4 w-4 flex-shrink-0" />
          <span className="font-medium">Feed paused</span>
          <span className="text-amber-600">—</span>
          {newCount > 0 ? (
            <Badge className="bg-amber-100 text-amber-700 text-[10px] h-4 font-bold animate-pulse">{newCount} new event{newCount > 1 ? "s" : ""} waiting</Badge>
          ) : (
            <span>no new events</span>
          )}
        </div>
      )}

      {/* Feed */}
      <div
        ref={feedRef}
        className="flex-1 overflow-y-auto space-y-1.5 pr-1"
        onScroll={e => {
          const el = e.currentTarget;
          setAutoScroll(el.scrollTop < 100);
        }}
      >
        {loading && filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <RefreshCw className="h-8 w-8 mx-auto mb-3 animate-spin text-primary/30" />
            <p className="text-sm font-medium">Loading feed…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-muted-foreground">
            <Activity className="h-10 w-10 mx-auto mb-3 opacity-20" />
            <p className="text-sm font-medium">No events match the current filters</p>
            <p className="text-xs mt-1 opacity-70">Adjust your filters or check back later</p>
          </div>
        ) : (
          filtered.map((event, idx) => {
            const catCfg = CATEGORY_CONFIG[event.category] || CATEGORY_CONFIG.system;
            const sevCfg = SEVERITY_CONFIG[event.severity] || SEVERITY_CONFIG.info;
            const meta = parseMetadata(event.metadata);

            return (
              <div
                key={event.id || idx}
                className={`group flex items-start gap-3 p-3 rounded-lg border cursor-pointer
                  hover:bg-muted/40 transition-all duration-150
                  ${event.severity === "critical"
                    ? "border-red-200 bg-red-50/20 dark:bg-red-950/10"
                    : event.severity === "warning"
                    ? "border-amber-100 bg-amber-50/10"
                    : "border-border/50 bg-background"}
                `}
                onClick={() => handleEventClick(event)}
              >
                {/* Severity dot + category icon */}
                <div className="flex flex-col items-center gap-1.5 pt-0.5 shrink-0">
                  <div className={`w-2 h-2 rounded-full ${sevCfg.dot} ${event.severity === 'critical' ? 'animate-pulse' : ''}`} />
                  <span className="text-base leading-none">{catCfg.icon}</span>
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug group-hover:text-primary transition-colors">{event.title}</p>
                    <div className="flex items-center gap-1.5 shrink-0">
                      {sevCfg.icon}
                      <span className="text-xs text-muted-foreground font-medium tabular-nums">{relTime(event.created_date)}</span>
                    </div>
                  </div>

                  {event.description && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1 leading-relaxed">{event.description}</p>
                  )}

                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    {(event.project_name || event.project_address) && (
                      <Badge className="text-[10px] h-4 bg-slate-100 text-slate-600 max-w-[180px] truncate font-medium shadow-sm" title={event.project_name || event.project_address}>
                        {event.project_name || event.project_address}
                      </Badge>
                    )}
                    {event.project_stage && (
                      <Badge variant="outline" className="text-[10px] h-4 capitalize">
                        {event.project_stage.replace(/_/g, " ")}
                      </Badge>
                    )}
                    {meta.old_stage && meta.new_stage && (
                      <span className="text-[10px] text-muted-foreground font-medium">
                        {meta.old_stage.replace(/_/g, " ")} → {meta.new_stage.replace(/_/g, " ")}
                      </span>
                    )}
                    {event.actor_name && (
                      <div className="flex items-center gap-1.5 ml-auto bg-muted/40 px-2 py-0.5 rounded-full">
                        <div className="w-5 h-5 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center
                          text-[9px] font-bold text-slate-700 shrink-0 shadow-sm">
                          {getInitials(event.actor_name)}
                        </div>
                        <span className="text-[10px] text-muted-foreground font-medium">{event.actor_name.split(" ")[0]}</span>
                      </div>
                    )}
                    {event.project_id && (
                      <ChevronRight className="h-3.5 w-3.5 text-primary ml-auto
                        opacity-0 group-hover:opacity-100 transition-opacity" />
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Board View ─────────────────────────────────────────────────────────────
function BoardView({ events }) {
  const navigate = useNavigate();

  // Group events by project
  const byProject = useMemo(() => {
    if (!events || events.length === 0) return [];
    
    const projectMap = new Map();
    
    for (const event of events) {
      if (!event.project_id) continue; // Skip non-project events
      
      const key = event.project_id;
      
      if (!projectMap.has(key)) {
        projectMap.set(key, {
          project_id:      event.project_id,
          project_name:    event.project_name,
          project_address: event.project_address,
          project_stage:   event.project_stage,
          events:          [],
          latest:          event.created_date,
          has_critical:    false,
          has_warning:     false,
        });
      }
      
      const project = projectMap.get(key);
      project.events.push(event);
      
      if (event.severity === "critical") project.has_critical = true;
      if (event.severity === "warning")  project.has_warning  = true;
    }
    
    return Array.from(projectMap.values())
      .sort((a, b) => {
        const aTime = new Date(normalizeTimestamp(b.latest) || 0).getTime();
        const bTime = new Date(normalizeTimestamp(a.latest) || 0).getTime();
        return bTime - aTime;
      });
  }, [events]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {byProject.length === 0 ? (
        <div className="col-span-3 py-16 text-center text-muted-foreground">
          <LayoutGrid className="h-10 w-10 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium">No project activity yet</p>
          <p className="text-xs mt-1 opacity-70">Events will appear here as projects are updated</p>
        </div>
      ) : (
        byProject.map(proj => (
          <Card
            key={proj.project_id}
            className={`cursor-pointer hover:shadow-lg transition-all active:scale-[0.98]
              ${proj.has_critical ? "border-red-300 ring-2 ring-red-200/50 bg-red-50/20 shadow-md" :
                proj.has_warning  ? "border-amber-200 bg-amber-50/10" : "hover:border-primary/30"}`}
            onClick={() => navigate(createPageUrl("ProjectDetails") + `?id=${proj.project_id}`)}
          >
            <CardContent className="pt-4 pb-3 px-4">
              {/* Project header */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm leading-tight truncate" title={proj.project_name || proj.project_address || proj.project_id}>
                    {proj.project_name || proj.project_address || proj.project_id}
                  </p>
                  {proj.project_name && proj.project_address && (
                    <p className="text-xs text-muted-foreground truncate mt-0.5" title={proj.project_address}>{proj.project_address}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {proj.has_critical && <AlertCircle className="h-4 w-4 text-red-500 animate-pulse" />}
                  {proj.has_warning  && !proj.has_critical && <AlertTriangle className="h-4 w-4 text-amber-500" />}
                </div>
              </div>

              {/* Stage badge */}
              {proj.project_stage && (
                <Badge variant="outline" className="text-[10px] h-4 mb-2 capitalize font-medium">
                  {proj.project_stage.replace(/_/g, " ")}
                </Badge>
              )}

              {/* Recent events */}
              <div className="space-y-1.5 mt-2">
                {proj.events.slice(0, 3).map((e, i) => {
                  const catCfg = CATEGORY_CONFIG[e.category] || CATEGORY_CONFIG.system;
                  const sevCfg = SEVERITY_CONFIG[e.severity] || SEVERITY_CONFIG.info;
                  return (
                    <div key={e.id || i} className="flex items-center gap-2 text-xs">
                      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${sevCfg.dot}`} />
                      <span className="shrink-0">{catCfg.icon}</span>
                      <span className="text-muted-foreground truncate flex-1">{e.title}</span>
                      <span className="text-muted-foreground shrink-0 text-[10px]">{relTime(e.created_date)}</span>
                    </div>
                  );
                })}
                {proj.events.length > 3 && (
                  <p className="text-[10px] text-muted-foreground pl-4 font-semibold">
                    +{proj.events.length - 3} more event{proj.events.length - 3 > 1 ? 's' : ''}
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

// ── Stats View ─────────────────────────────────────────────────────────────
function StatsView({ events, users }) {
  const [window, setWindow] = useState("24h");

  const WINDOW_MS = {
    "24h": 86400000,     // 24 hours
    "7d":  604800000,    // 7 days
    "30d": 2592000000    // 30 days
  };

  const windowed = useMemo(() => {
    if (!events || events.length === 0) return [];
    
    const ms = WINDOW_MS[window] || WINDOW_MS["24h"];
    const cutoff = Date.now() - ms;
    
    return events.filter(e => {
      const normalized = normalizeTimestamp(e.created_date);
      if (!normalized) return false;
      
      const ts = new Date(normalized).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
  }, [events, window]);

  const userMap = useMemo(() => {
    if (!users || users.length === 0) return new Map();
    
    const map = new Map();
    users.forEach(u => {
      if (u?.id) {
        map.set(u.id, u.full_name || u.email || u.id);
      }
    });
    return map;
  }, [users]);

  // By category
  const byCategory = useMemo(() => {
    const counts = new Map();
    windowed.forEach(e => {
      if (!e.category) return;
      counts.set(e.category, (counts.get(e.category) || 0) + 1);
    });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [windowed]);

  // By actor (human-triggered events only)
  const byActor = useMemo(() => {
    const counts = new Map();
    windowed
      .filter(e => e.actor_id)
      .forEach(e => {
        const name = e.actor_name || userMap.get(e.actor_id) || e.actor_id;
        counts.set(name, (counts.get(name) || 0) + 1);
      });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
  }, [windowed, userMap]);

  // By event type
  const byType = useMemo(() => {
    const counts = new Map();
    windowed.forEach(e => {
      if (!e.event_type) return;
      counts.set(e.event_type, (counts.get(e.event_type) || 0) + 1);
    });
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
  }, [windowed]);

  // Severity breakdown
  const bySeverity = useMemo(() => ({
    critical: windowed.filter(e => e.severity === "critical").length,
    warning:  windowed.filter(e => e.severity === "warning").length,
    info:     windowed.filter(e => e.severity === "info").length,
  }), [windowed]);

  // Hourly cadence (last 24h only)
  const hourlyBuckets = useMemo(() => {
    if (window !== "24h" || windowed.length === 0) return [];
    
    const buckets = Array.from({ length: 24 }, (_, i) => ({ hour: i, count: 0 }));
    const cutoff = Date.now() - 86400000;
    
    windowed.forEach(e => {
      const normalized = normalizeTimestamp(e.created_date);
      if (!normalized) return;
      
      const ts = new Date(normalized);
      if (isNaN(ts.getTime()) || ts.getTime() < cutoff) return;
      
      const hour = ts.getHours();
      if (hour >= 0 && hour < 24) {
        buckets[hour].count++;
      }
    });
    
    return buckets;
  }, [windowed, window]);

  const maxHourly = Math.max(...hourlyBuckets.map(b => b.count), 1);
  const maxCat = byCategory[0]?.[1] || 1;
  const maxType = byType[0]?.[1] || 1;
  const maxActor = byActor[0]?.[1] || 1;

  return (
    <div className="space-y-4">
      {/* Window selector */}
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Time window:</span>
        {["24h", "7d", "30d"].map(w => (
          <Button
            key={w}
            variant={window === w ? "default" : "outline"}
            size="sm"
            className="h-7 text-xs font-bold shadow-sm transition-all"
            onClick={() => setWindow(w)}
            title={`View ${w} time window`}
          >
            {w}
          </Button>
        ))}
        <Badge variant="secondary" className="text-xs font-bold ml-2 tabular-nums">
          {windowed.length.toLocaleString()} events
        </Badge>
      </div>

      {/* Severity cards */}
      <div className="grid grid-cols-3 gap-3">
        <Card className="border-red-200 bg-red-50/30 shadow-sm hover:shadow-md transition-shadow">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-red-600 tabular-nums">{bySeverity.critical}</p>
            <p className="text-xs text-red-600/70 flex items-center gap-1 font-medium mt-1">
              <AlertCircle className="h-3.5 w-3.5" /> Critical events
            </p>
          </CardContent>
        </Card>
        <Card className="border-amber-200 bg-amber-50/30 shadow-sm hover:shadow-md transition-shadow">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-amber-600 tabular-nums">{bySeverity.warning}</p>
            <p className="text-xs text-amber-600/70 flex items-center gap-1 font-medium mt-1">
              <AlertTriangle className="h-3.5 w-3.5" /> Warnings
            </p>
          </CardContent>
        </Card>
        <Card className="border-blue-200 bg-blue-50/30 shadow-sm hover:shadow-md transition-shadow">
          <CardContent className="pt-4 pb-3">
            <p className="text-3xl font-bold text-blue-600 tabular-nums">{bySeverity.info}</p>
            <p className="text-xs text-blue-600/70 flex items-center gap-1 font-medium mt-1">
              <Info className="h-3.5 w-3.5" /> Info events
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Hourly cadence chart (24h only) */}
      {window === "24h" && hourlyBuckets.length > 0 && (
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 font-bold">
              <TrendingUp className="h-4 w-4 text-primary" /> Activity cadence — last 24 hours
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-end gap-0.5 h-16">
              {hourlyBuckets.map(b => {
                const height = maxHourly > 0 ? Math.max(4, Math.round((b.count / maxHourly) * 64)) : 4;
                const isNow = new Date().getHours() === b.hour;
                return (
                  <div key={b.hour} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                    <div
                      className={`w-full rounded-sm transition-all ${isNow ? "bg-blue-500" : "bg-slate-200 dark:bg-slate-700"}`}
                      style={{ height: `${height}px` }}
                    />
                    {/* Tooltip */}
                    <div className="absolute bottom-full mb-1 hidden group-hover:flex bg-foreground text-background
                      text-[10px] rounded px-1.5 py-0.5 whitespace-nowrap z-10">
                      {b.hour.toString().padStart(2, "0")}:00 — {b.count} events
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
              <span>12am</span><span>6am</span><span>12pm</span><span>6pm</span><span>now</span>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* By category */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">By Category</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byCategory.length === 0
              ? <p className="text-xs text-muted-foreground">No events in this window</p>
              : byCategory.map(([cat, count]) => {
                  const cfg = CATEGORY_CONFIG[cat] || { icon: "🔔", label: cat, color: "bg-slate-100 text-slate-600" };
                  return (
                    <div key={cat} className="flex items-center gap-2 text-xs">
                      <span className="w-5 shrink-0">{cfg.icon}</span>
                      <span className="flex-1 text-muted-foreground">{cfg.label}</span>
                      <div className="w-20 bg-muted rounded-full h-1.5">
                        <div
                          className="h-1.5 rounded-full bg-blue-400"
                          style={{ width: `${Math.round((count / maxCat) * 100)}%` }}
                        />
                      </div>
                      <span className="font-mono w-6 text-right">{count}</span>
                    </div>
                  );
                })
            }
          </CardContent>
        </Card>

        {/* By event type */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-bold">Top Event Types</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byType.length === 0
              ? <p className="text-xs text-muted-foreground">No events in this window</p>
              : byType.map(([type, count]) => (
                  <div key={type} className="flex items-center gap-2 text-xs">
                    <span className="flex-1 text-muted-foreground truncate">{type.replace(/_/g, " ")}</span>
                    <div className="w-16 bg-muted rounded-full h-1.5 shrink-0">
                      <div
                        className="h-1.5 rounded-full bg-violet-400"
                        style={{ width: `${Math.round((count / maxType) * 100)}%` }}
                      />
                    </div>
                    <span className="font-mono w-6 text-right shrink-0">{count}</span>
                  </div>
                ))
            }
          </CardContent>
        </Card>

        {/* By actor */}
        <Card className="shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-1.5 font-bold">
              <Users className="h-4 w-4 text-primary" /> Most Active Users
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {byActor.length === 0
              ? <p className="text-xs text-muted-foreground">No user-triggered events</p>
              : byActor.map(([name, count]) => (
                  <div key={name} className="flex items-center gap-2 text-xs">
                    <div className="w-5 h-5 rounded-full bg-slate-200 flex items-center justify-center
                      text-[9px] font-bold text-slate-600 shrink-0">
                      {getInitials(name)}
                    </div>
                    <span className="flex-1 text-muted-foreground truncate">{name.split(" ")[0]}</span>
                    <div className="w-16 bg-muted rounded-full h-1.5 shrink-0">
                      <div
                        className="h-1.5 rounded-full bg-emerald-400"
                        style={{ width: `${Math.round((count / maxActor) * 100)}%` }}
                      />
                    </div>
                    <span className="font-mono w-6 text-right shrink-0">{count}</span>
                  </div>
                ))
            }
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────
export default function TeamPulsePage() {
  const { data: currentUser } = useCurrentUser();
  const queryClient = useQueryClient();
  const [view, setView] = useState("feed"); // 'feed' | 'board' | 'effort' | 'stats' | 'notifications'
  const [paused, setPaused] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const [frozenEvents, setFrozenEvents] = useState(null);
  const prevCountRef = useRef(0);

  const { data: liveEvents = [], isLoading } = useQuery({
    queryKey: ["teamActivityFeed", currentUser?.role],
    queryFn: async () => {
      const all = await base44.entities.TeamActivityFeed.list("-created_date", 300);

      // Filter by visible_to_roles: if empty, all roles see it;
      // if set, only show if currentUser role is included
      if (!currentUser?.role) return all;

      return all.filter(event => {
        if (!event.visible_to_roles || event.visible_to_roles.trim() === "") {
          return true; // Visible to all
        }

        const allowedRoles = event.visible_to_roles
          .split(",")
          .map(r => r.trim())
          .filter(Boolean);

        return allowedRoles.includes(currentUser.role);
      });
    },
    refetchInterval: paused ? false : 60_000, // Reduced from 15s — realtime handles instant updates
    enabled: !!currentUser?.id,
    staleTime: 10_000,
  });

  // Realtime subscription for TeamActivityFeed — triggers react-query refetch on new events
  useEffect(() => {
    if (!currentUser?.id) return;

    const unsubscribe = base44.entities.TeamActivityFeed.subscribe((event) => {
      if (!event) return;
      if (event.type === 'create') {
        // Invalidate the query to trigger a refetch with fresh data
        queryClient.invalidateQueries({ queryKey: ["teamActivityFeed"] });
      }
    });

    return unsubscribe;
  }, [currentUser?.id, queryClient]);

  // Realtime subscription for Notification table — update pulse notifications tab
  useEffect(() => {
    if (!currentUser?.id || view !== 'notifications') return;

    const unsubscribe = base44.entities.Notification.subscribe((event) => {
      if (!event) return;
      if (event.type === 'create' || event.type === 'update') {
        queryClient.invalidateQueries({ queryKey: ["pulse-notifications"] });
      }
    });

    return unsubscribe;
  }, [currentUser?.id, view, queryClient]);

  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => base44.entities.User.list(),
    staleTime: 5 * 60 * 1000,
  });

  const { data: allProjects = [] } = useQuery({
    queryKey: ['pulse-projects-summary'],
    queryFn: () => base44.entities.Project.filter({}, null, 500),
    refetchInterval: 60_000,
  });

  const { data: allNotifications = [] } = useQuery({
    queryKey: ['pulse-notifications'],
    queryFn: () => base44.entities.Notification.list('-created_date', 200),
    refetchInterval: 30_000,
    enabled: view === 'notifications',
  });

  const { data: pulseUsers = [] } = useQuery({
    queryKey: ['pulse-users-map'],
    queryFn: () => base44.entities.User.list('-created_date', 200),
    staleTime: 5 * 60_000,
    enabled: view === 'notifications',
  });

  const pulseUserMap = useMemo(() => {
    const m = new Map();
    pulseUsers.forEach(u => m.set(u.id, u));
    return m;
  }, [pulseUsers]);

  const liveStats = useMemo(() => {
    const pendingReview = allProjects.filter(p => p.status === 'pending_review').length;
    const onsite       = allProjects.filter(p => p.status === 'onsite').length;
    const inProgress   = allProjects.filter(p => ['in_progress', 'submitted', 'uploaded'].includes(p.status)).length;
    const overdue      = allProjects.filter(p =>
      p.shoot_date &&
      new Date(p.shoot_date) < new Date() &&
      !['delivered', 'cancelled', 'pending_review'].includes(p.status)
    ).length;
    return { pendingReview, onsite, inProgress, overdue };
  }, [allProjects]);

  // Track new events while paused
  useEffect(() => {
    if (!liveEvents) return;
    
    if (paused) {
      const diff = liveEvents.length - prevCountRef.current;
      if (diff > 0) {
        setNewCount(prev => prev + diff);
        prevCountRef.current = liveEvents.length;
      }
    } else {
      prevCountRef.current = liveEvents.length;
      setNewCount(0);
      setFrozenEvents(null);
    }
  }, [liveEvents, paused]);

  function handleTogglePause() {
    if (!paused) {
      setFrozenEvents(liveEvents);
      prevCountRef.current = liveEvents.length;
      setNewCount(0);
    } else {
      setFrozenEvents(null);
      setNewCount(0);
    }
    setPaused(v => !v);
  }

  const displayEvents = paused && frozenEvents ? frozenEvents : liveEvents;

  // Stats for the header
  const { last24h, criticalToday } = useMemo(() => {
    if (!liveEvents || liveEvents.length === 0) {
      return { last24h: [], criticalToday: 0 };
    }
    
    const cutoff = Date.now() - 86400000;
    const recent = liveEvents.filter(e => {
      const normalized = normalizeTimestamp(e.created_date);
      if (!normalized) return false;
      const ts = new Date(normalized).getTime();
      return !isNaN(ts) && ts >= cutoff;
    });
    
    const critical = recent.filter(e => e.severity === "critical").length;
    
    return { last24h: recent, criticalToday: critical };
  }, [liveEvents]);

  return (
    <ErrorBoundary>
    <div className="flex flex-col h-[calc(100vh-4rem)] p-6 lg:p-8 gap-5">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-3">
            <div className="relative">
              <Activity className="h-7 w-7 text-primary" />
              {!paused && (
                <span className="absolute -top-1 -right-1 flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-green-500" />
                </span>
              )}
            </div>
            Team Pulse
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Live activity across all projects and users
          </p>
        </div>

        {/* Live indicator + stats */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-sm">
            <div className="text-right bg-muted/30 px-3 py-2 rounded-lg">
              <p className="font-bold text-lg tabular-nums">{last24h.length}</p>
              <p className="text-xs text-muted-foreground">events today</p>
            </div>
            {criticalToday > 0 && (
              <div className="text-right bg-red-50 border border-red-200 px-3 py-2 rounded-lg">
                <p className="font-bold text-lg text-red-600 tabular-nums">{criticalToday}</p>
                <p className="text-xs text-red-600/70">critical</p>
              </div>
            )}
            <div className="text-right bg-muted/30 px-3 py-2 rounded-lg">
              <p className="font-bold text-lg tabular-nums">{liveEvents.length}</p>
              <p className="text-xs text-muted-foreground">total loaded</p>
            </div>
          </div>

          {/* Live dot */}
          <div className="flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-full bg-muted/50">
            <div className={`w-2.5 h-2.5 rounded-full ${
              paused ? "bg-amber-400" : "bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50"
            }`} />
            {paused ? "Paused" : "Live"}
          </div>
        </div>
      </div>

      {/* Live stats bar */}
       {view !== 'notifications' && (
         <div className="grid grid-cols-4 gap-3 px-4 py-3 border-b bg-muted/20 shrink-0 rounded-lg">
           {[
             { label: 'Pending review', value: liveStats.pendingReview, color: 'text-amber-600', urgent: liveStats.pendingReview > 0 },
             { label: 'Onsite now',     value: liveStats.onsite,       color: 'text-green-600',  urgent: false },
             { label: 'In production',  value: liveStats.inProgress,   color: 'text-blue-600',   urgent: false },
             { label: 'Overdue',        value: liveStats.overdue,       color: 'text-red-600',    urgent: liveStats.overdue > 0 },
           ].map(({ label, value, color, urgent }) => (
             <div key={label} className={`text-center p-2 rounded-lg ${urgent && value > 0 ? 'bg-amber-50 dark:bg-amber-950/20' : ''}`}>
               <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
               <p className={`text-2xl font-semibold mt-0.5 ${color}`}>{value}</p>
             </div>
           ))}
         </div>
       )}

       {/* View toggle */}
       <div className="flex items-center gap-2 shrink-0 flex-wrap">
         <div className="flex border rounded-lg overflow-hidden shadow-sm bg-muted/30">
           {[
             { id: "feed",  label: "Live Feed",  icon: <Activity className="h-4 w-4" /> },
             { id: "board", label: "By Project", icon: <LayoutGrid className="h-4 w-4" /> },
             { id: "effort", label: "Effort & Timers", icon: <Clock className="h-4 w-4" /> },
             { id: "stats", label: "Stats",      icon: <BarChart2 className="h-4 w-4" /> },
           ].map(v => (
             <button
               key={v.id}
               className={`flex items-center gap-1.5 px-4 py-2 text-sm transition-all font-medium
                 ${view === v.id
                   ? "bg-primary text-primary-foreground shadow-sm"
                   : "hover:bg-muted/60 text-muted-foreground"}`}
               onClick={() => setView(v.id)}
               title={v.label}
             >
               {v.icon} <span className="hidden sm:inline">{v.label}</span>
             </button>
           ))}
         </div>

         <button
           onClick={() => setView('notifications')}
           className={`text-xs px-3 py-1.5 rounded-lg border transition-all ${
             view === 'notifications'
               ? 'bg-primary text-primary-foreground border-primary'
               : 'border-border text-muted-foreground hover:bg-muted'
           }`}
         >
           Notifications
         </button>

        <span className="text-xs text-muted-foreground ml-1 bg-muted/30 px-2 py-1 rounded-full">
          ⟳ Realtime + polling fallback
        </span>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {view === "feed" && (
          <LiveFeedView
            events={displayEvents}
            loading={isLoading}
            paused={paused}
            onTogglePause={handleTogglePause}
            newCount={newCount}
          />
        )}
        {view === "board" && (
          <div className="h-full overflow-y-auto pb-4">
            <BoardView events={displayEvents} />
          </div>
        )}
        {view === "effort" && (
          <div className="h-full overflow-y-auto pb-4">
            <EffortTimersTab />
          </div>
        )}
        {view === "stats" && (
           <div className="h-full overflow-y-auto pb-4">
             <StatsView events={liveEvents} users={users} />
           </div>
         )}
         {view === 'notifications' && (
           <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
             {allNotifications.length === 0 ? (
               <p className="text-sm text-muted-foreground text-center py-12">No notifications yet</p>
             ) : allNotifications.map(n => {
               const u = pulseUserMap.get(n.user_id);
               return (
                 <div key={n.id} className={`flex items-start gap-3 p-3 rounded-lg border transition-colors
                   ${!n.is_read ? 'bg-blue-50/30 border-blue-100 dark:bg-blue-950/10' : 'border-border/40'}`}>
                   <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${
                     n.severity === 'critical' ? 'bg-red-500' :
                     n.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-400'
                   }`} />
                   <div className="flex-1 min-w-0">
                     <p className="text-sm font-medium truncate">{n.title}</p>
                     <p className="text-xs text-muted-foreground line-clamp-1">{n.message}</p>
                     <div className="flex items-center gap-2 mt-0.5">
                       <span className="text-[10px] text-muted-foreground/70">
                         → {u?.full_name || u?.email || n.user_id?.slice(0, 8)}
                       </span>
                       {n.project_name && (
                         <span className="text-[10px] text-muted-foreground/70 truncate">
                           · {n.project_name}
                         </span>
                       )}
                     </div>
                   </div>
                   <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
                     {(() => {
                       if (!n.created_date) return '';
                       const ms = Date.now() - new Date(n.created_date).getTime();
                       const m = Math.floor(ms / 60000);
                       if (m < 1) return 'now';
                       if (m < 60) return `${m}m`;
                       const h = Math.floor(m / 60);
                       if (h < 24) return `${h}h`;
                       return `${Math.floor(h / 24)}d`;
                     })()}
                   </span>
                 </div>
               );
             })}
           </div>
         )}
        </div>
        </div>
    </ErrorBoundary>
        );
        }
import { useState, useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Users, AlertTriangle, CheckCircle, Clock, TrendingUp, TrendingDown,
  Minus, BookOpen, Zap, Moon, Battery
} from 'lucide-react';
import { cn } from '@/lib/utils';
import EmployeeDetailModal from '@/components/utilization/EmployeeDetailModal';
import EmployeeUtilizationRulebook from '@/components/utilization/EmployeeUtilizationRulebook';
import TeamComparisonView from '@/components/utilization/TeamComparisonView';
import RoleAnalysisView from '@/components/utilization/RoleAnalysisView';
import UtilizationHeatmap from '@/components/utilization/UtilizationHeatmap';
import {
  getPeriodBounds, buildPeriodBuckets, buildEmployeeUtilization,
  fmtHoursMins, calcActualSeconds, logSeconds
} from '@/components/utilization/utilizationUtils';
import { fixTimestamp } from '@/components/utils/dateUtils';

// ─── Tiny SVG sparkline ───────────────────────────────────────────────────────
function Sparkline({ values = [], color = '#6366f1', height = 24, width = 64 }) {
  if (!values.length || values.every(v => v === 0)) {
    return <span className="text-xs text-muted-foreground/40 inline-block w-16 text-center">—</span>;
  }
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - (v / max) * (height - 4) - 2;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={width} height={height} className="inline-block">
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinejoin="round" strokeLinecap="round" />
      {values.map((v, i) => {
        if (i !== values.length - 1) return null;
        const x = (i / (values.length - 1)) * width;
        const y = height - (v / max) * (height - 4) - 2;
        return <circle key={i} cx={x} cy={y} r="2.5" fill={color} />;
      })}
    </svg>
  );
}

// ─── Tiny ring gauge ─────────────────────────────────────────────────────────
function UtilRing({ percent, size = 36 }) {
  const r = (size - 6) / 2;
  const circ = 2 * Math.PI * r;
  const capped = Math.min(percent, 100);
  const dash = (capped / 100) * circ;
  const color = percent > 120 ? '#f97316' : percent >= 80 ? '#10b981' : '#60a5fa';
  const trackColor = 'rgba(0,0,0,0.06)';
  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={trackColor} strokeWidth="5" />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="5"
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        fill="currentColor" fontSize="9" fontWeight="600"
        style={{ transform: 'rotate(90deg)', transformOrigin: 'center' }}>
        {percent > 0 ? `${Math.min(percent, 999)}` : '—'}
      </text>
    </svg>
  );
}

// ─── Live pulse dot ───────────────────────────────────────────────────────────
function LiveDot() {
  return (
    <span className="relative flex h-2 w-2">
      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
      <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
    </span>
  );
}

// ─── Section label ────────────────────────────────────────────────────────────
function SectionLabel({ children }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/60 mb-2">
      {children}
    </p>
  );
}

// ─── Attention card ───────────────────────────────────────────────────────────
function AttentionCard({ icon: Icon, label, color, people, onSelect }) {
  if (!people.length) return null;
  return (
    <div className={cn('rounded-xl border p-3', color)}>
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="h-3.5 w-3.5" />
        <span className="text-xs font-semibold">{label}</span>
        <Badge className="ml-auto text-[10px] h-4 px-1.5">{people.length}</Badge>
      </div>
      <div className="space-y-1">
        {people.slice(0, 4).map(p => (
          <button key={p.user_id} onClick={() => onSelect(p)}
            className="block w-full text-left text-xs truncate hover:underline opacity-80 hover:opacity-100">
            {p.user_name}
          </button>
        ))}
        {people.length > 4 && (
          <p className="text-[10px] opacity-60">+{people.length - 4} more</p>
        )}
      </div>
    </div>
  );
}

import { usePermissions } from '@/components/auth/PermissionGuard';

export default function EmployeeUtilization() {
  const { canSeeUtilization } = usePermissions();
  const [period, setPeriod] = useState('week');

  if (!canSeeUtilization) {
    return <div className="p-8 text-center text-muted-foreground">Access denied — admin only</div>;
  }
  const [viewType, setViewType] = useState('roster');
  const [showRulebook, setShowRulebook] = useState(false);
  const [selectedEmployee, setSelectedEmployee] = useState(null);
  const [filterTeam, setFilterTeam] = useState('all');
  const [filterRole, setFilterRole] = useState('all');
  const [sortBy, setSortBy] = useState('utilization');
  const [sortDir, setSortDir] = useState('desc');

  // ─── Data ─────────────────────────────────────────────────────────────────
  const { data: allUsers = [] }           = useEntityList('User');
  const { data: allEmployeeRoles = [] }   = useEntityList('EmployeeRole');
  const { data: allUtilizations = [] }    = useEntityList('EmployeeUtilization', '-period_date');
  const { data: teams = [] }              = useEntityList('InternalTeam');
  const { data: allTimeLogs = [] }        = useEntityList('TaskTimeLog', '-created_date', 1000);
  const { data: allProjects = [] }        = useEntityList('Project', '-shoot_date', 500);

  // ─── Live active timers poll (30s) ────────────────────────────────────────
  const { data: liveTimers = [] } = useQuery({
    queryKey: ['liveActiveTimers'],
    queryFn: () => base44.entities.TaskTimeLog.filter({ is_active: true, status: 'running' }),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  // ─── Period bounds ─────────────────────────────────────────────────────────
  const periodBounds = useMemo(() => getPeriodBounds(period), [period]);

  const periodLogs = useMemo(() => {
    const { start, end } = periodBounds;
    return allTimeLogs.filter(log => {
      const raw = log.end_time || log.start_time || log.created_date;
      const d = new Date(fixTimestamp(raw));
      return d >= start && d <= end;
    });
  }, [allTimeLogs, periodBounds]);

  // ─── Sparkline history (last 5 periods) ───────────────────────────────────
  const historyBuckets = useMemo(() => buildPeriodBuckets(period, 5), [period]);

  const sparklineByUser = useMemo(() => {
    const map = {};
    allTimeLogs.forEach(log => {
      const uid = log.user_id;
      if (!uid) return;
      if (!map[uid]) map[uid] = new Array(5).fill(0);
      const raw = log.end_time || log.start_time || log.created_date;
      const d = new Date(fixTimestamp(raw));
      historyBuckets.forEach((b, i) => {
        if (d >= b.start && d <= b.end) {
          map[uid][i] += logSeconds(log) / 3600;
        }
      });
    });
    return map;
  }, [allTimeLogs, historyBuckets]);

  // ─── Build employee list ───────────────────────────────────────────────────
  const mergedEmployees = useMemo(() => {
    const results = [];
    const seen = new Set();

    allEmployeeRoles.forEach(empRole => {
      const user = allUsers.find(u => u.id === empRole.user_id);
      if (!user) return;
      seen.add(user.id);
      const utilRecord = allUtilizations
        .filter(u => u.user_id === user.id && u.period === period)
        .sort((a, b) => new Date(b.period_date) - new Date(a.period_date))[0] || null;
      const userLogs = periodLogs.filter(l => l.user_id === user.id);
      const rec = buildEmployeeUtilization({ user, empRole, utilRecord, userLogs, period });
      if (rec) results.push(rec);
    });

    [...new Set(periodLogs.map(l => l.user_id))].forEach(uid => {
      if (seen.has(uid)) return;
      const user = allUsers.find(u => u.id === uid);
      if (!user) return;
      seen.add(uid);
      const utilRecord = allUtilizations
        .filter(u => u.user_id === user.id && u.period === period)
        .sort((a, b) => new Date(b.period_date) - new Date(a.period_date))[0] || null;
      const userLogs = periodLogs.filter(l => l.user_id === user.id);
      const rec = buildEmployeeUtilization({ user, empRole: null, utilRecord, userLogs, period });
      if (rec) results.push(rec);
    });

    return results;
  }, [allUsers, allEmployeeRoles, allUtilizations, periodLogs, period]);

  // ─── Apply filters ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    let r = mergedEmployees;
    if (filterTeam !== 'all') r = r.filter(u => u.team_id === filterTeam);
    if (filterRole !== 'all') r = r.filter(u => u.role === filterRole);
    return r;
  }, [mergedEmployees, filterTeam, filterRole]);

  // ─── Sort ──────────────────────────────────────────────────────────────────
  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortBy === 'name')        return dir * (a.user_name || '').localeCompare(b.user_name || '');
      if (sortBy === 'utilization') return dir * (a.utilization_percent - b.utilization_percent);
      if (sortBy === 'actual')      return dir * (a.actual_seconds - b.actual_seconds);
      if (sortBy === 'estimated')   return dir * (a.estimated_seconds - b.estimated_seconds);
      return 0;
    });
  }, [filtered, sortBy, sortDir]);

  const toggleSort = (col) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const SortIcon = ({ col }) => {
    if (sortBy !== col) return <span className="opacity-20">↕</span>;
    return <span className="text-primary">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  // ─── Live timer enrichment ─────────────────────────────────────────────────
  const liveTimerByUser = useMemo(() => {
    const map = {};
    liveTimers.forEach(t => { map[t.user_id] = t; });
    return map;
  }, [liveTimers]);

  // ─── Company KPIs ──────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const withData   = filtered.filter(u => u.has_data);
    const overutil   = withData.filter(u => u.utilization_percent > 120);
    const underutil  = withData.filter(u => u.utilization_percent < 80);
    const balanced   = withData.filter(u => u.utilization_percent >= 80 && u.utilization_percent <= 120);
    const totalEst   = filtered.reduce((s, u) => s + u.estimated_seconds, 0);
    const totalAct   = filtered.reduce((s, u) => s + u.actual_seconds, 0);
    const avgUtil    = withData.length ? Math.round(withData.reduce((s, u) => s + u.utilization_percent, 0) / withData.length) : 0;
    const liveCount  = liveTimers.filter(t => filtered.some(u => u.user_id === t.user_id)).length;

    return { withData: withData.length, overutil, underutil, balanced, totalEst, totalAct, avgUtil, liveCount, headcount: filtered.length };
  }, [filtered, liveTimers]);

  // ─── Attention signals ─────────────────────────────────────────────────────
  const attentionSignals = useMemo(() => {
    const burnoutRisk = filtered.filter(u => u.utilization_percent > 120 && u.has_data);
    const dark        = filtered.filter(u => !u.has_data && u.estimated_seconds > 0);
    const available   = filtered.filter(u => u.has_data && u.utilization_percent < 60 && !liveTimerByUser[u.user_id]);
    return { burnoutRisk, dark, available };
  }, [filtered, liveTimerByUser]);

  // ─── Grouped by team (for team view) ──────────────────────────────────────
  const groupedByTeam = useMemo(() => {
    const groups = {};
    teams.forEach(team => {
      const teamUtils = sorted.filter(u => u.team_id === team.id);
      if (teamUtils.length) groups[team.id] = { team, utilizations: teamUtils };
    });
    const unassigned = sorted.filter(u => !u.team_id);
    if (unassigned.length) groups['unassigned'] = { team: { id: 'unassigned', name: 'No Team' }, utilizations: unassigned };
    return groups;
  }, [sorted, teams]);

  const uniqueRoles = useMemo(() => [...new Set(allEmployeeRoles.map(r => r.role))].filter(Boolean).sort(), [allEmployeeRoles]);
  const periodLabel = period === 'day' ? 'Today' : period === 'week' ? 'This Week' : 'This Month';

  // ─── Capacity bar pct ─────────────────────────────────────────────────────
  const capacityPct = kpis.totalEst > 0 ? Math.round((kpis.totalAct / kpis.totalEst) * 100) : null;

  // ─── Revenue attribution by user ───────────────────────────────────────────
  const revenueByUser = useMemo(() => {
    const now = new Date();
    const start = period === 'day'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
      : period === 'week'
      ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7)
      : new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());

    const projectValue = p => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

    const map = new Map();
    allProjects.forEach(p => {
      const d = new Date(p.shoot_date || p.created_date || 0);
      if (d < start) return;
      const val = projectValue(p);
      if (val <= 0) return;
      // Attribute to photographer (primary) and project owner
      [p.photographer_id, p.onsite_staff_1_id].filter(Boolean).forEach(uid => {
        const cur = map.get(uid) || { revenue: 0, projects: 0 };
        cur.revenue += val;
        cur.projects++;
        map.set(uid, cur);
      });
    });
    return map;
  }, [allProjects, period]);

  return (
    <div className="p-6 lg:p-8 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Staff Utilisation</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {kpis.headcount} people · {periodLabel}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowRulebook(v => !v)}>
          <BookOpen className="h-4 w-4 mr-2" />
          {showRulebook ? 'Hide' : 'How it works'}
        </Button>
      </div>

      {showRulebook && <div className="border-t pt-6"><EmployeeUtilizationRulebook /></div>}

      {/* ── Command Strip ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">

        {/* Live now */}
        <Card className="p-4 bg-emerald-50 border-emerald-200">
          <div className="flex items-center gap-2 mb-1">
            <LiveDot />
            <p className="text-xs font-semibold text-emerald-700">Active now</p>
          </div>
          <p className="text-3xl font-bold text-emerald-700">{kpis.liveCount}</p>
          <p className="text-xs text-emerald-600 mt-0.5">
            {kpis.liveCount === 1 ? 'timer running' : 'timers running'}
          </p>
        </Card>

        {/* Capacity */}
        <Card className="p-4 col-span-2 sm:col-span-1">
          <p className="text-xs font-semibold text-muted-foreground mb-1">Team capacity</p>
          <p className="text-3xl font-bold">{capacityPct !== null ? `${capacityPct}%` : '—'}</p>
          {kpis.totalEst > 0 && (
            <>
              <div className="mt-2 h-1.5 bg-muted rounded-full">
                <div
                  className={cn('h-1.5 rounded-full transition-all',
                    capacityPct > 120 ? 'bg-orange-500' : capacityPct >= 80 ? 'bg-emerald-500' : 'bg-blue-400'
                  )}
                  style={{ width: `${Math.min(capacityPct, 100)}%` }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {fmtHoursMins(kpis.totalAct)} of {fmtHoursMins(kpis.totalEst)}
              </p>
            </>
          )}
        </Card>

        {/* Avg util */}
        <Card className="p-4">
          <p className="text-xs font-semibold text-muted-foreground mb-1">Avg utilisation</p>
          <p className={cn('text-3xl font-bold',
            kpis.avgUtil > 120 ? 'text-orange-600' : kpis.avgUtil >= 80 ? 'text-emerald-600' : 'text-blue-600'
          )}>
            {kpis.withData > 0 ? `${kpis.avgUtil}%` : '—'}
          </p>
          <p className="text-[10px] text-muted-foreground mt-0.5">{kpis.withData} active</p>
        </Card>

        {/* Balanced */}
        <Card className="p-4">
          <p className="text-xs font-semibold text-muted-foreground mb-1">Status breakdown</p>
          <div className="flex items-end gap-3 mt-1">
            <div className="text-center">
              <p className="text-xl font-bold text-emerald-600">{kpis.balanced.length}</p>
              <p className="text-[10px] text-muted-foreground">on track</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-orange-500">{kpis.overutil.length}</p>
              <p className="text-[10px] text-muted-foreground">over</p>
            </div>
            <div className="text-center">
              <p className="text-xl font-bold text-blue-400">{kpis.underutil.length}</p>
              <p className="text-[10px] text-muted-foreground">under</p>
            </div>
          </div>
        </Card>

        {/* Total hours */}
        <Card className="p-4">
          <p className="text-xs font-semibold text-muted-foreground mb-1">Total logged</p>
          <p className="text-3xl font-bold">{fmtHoursMins(kpis.totalAct)}</p>
          <p className="text-[10px] text-muted-foreground mt-0.5">
            of {fmtHoursMins(kpis.totalEst)} estimated
          </p>
        </Card>
      </div>

      {/* ── Period summary ────────────────────────────────────────────── */}
      <div className="grid grid-cols-4 gap-3 px-4 py-3 border rounded-lg bg-muted/20">
        {[
          {
            label: 'Total hours logged',
            value: (() => {
              const secs = periodLogs.reduce((s, l) => s + (l.total_seconds || 0), 0);
              const h = Math.floor(secs / 3600);
              return `${h}h`;
            })(),
          },
          {
            label: 'Active staff',
            value: sorted.filter(u => (u.actual_seconds || 0) > 0).length,
          },
          {
            label: 'Avg utilisation',
            value: (() => {
              const active = sorted.filter(u => u.utilization_percent > 0);
              if (active.length === 0) return '—';
              return `${Math.round(active.reduce((s, u) => s + u.utilization_percent, 0) / active.length)}%`;
            })(),
          },
          {
            label: 'At-capacity staff',
            value: sorted.filter(u => u.utilization_percent >= 80).length,
          },
        ].map(({ label, value }) => (
          <div key={label} className="text-center">
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
            <p className="text-xl font-semibold mt-0.5">{value}</p>
          </div>
        ))}
      </div>

      {/* ── Controls ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <Tabs value={period} onValueChange={setPeriod}>
          <TabsList>
            <TabsTrigger value="day">Today</TabsTrigger>
            <TabsTrigger value="week">This Week</TabsTrigger>
            <TabsTrigger value="month">This Month</TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {[
            { v: 'roster',  l: 'Roster' },
            { v: 'heatmap', l: 'Heatmap' },
            { v: 'teams',   l: 'Teams' },
            { v: 'roles',   l: 'Roles' },
          ].map(({ v, l }) => (
            <button key={v} onClick={() => setViewType(v)}
              className={cn('text-xs px-3 py-1.5 rounded-md transition-all font-medium',
                viewType === v ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
              )}>
              {l}
            </button>
          ))}
        </div>

        <div className="ml-auto flex gap-2">
          <Select value={filterTeam} onValueChange={setFilterTeam}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="All teams" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All teams</SelectItem>
              {teams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filterRole} onValueChange={setFilterRole}>
            <SelectTrigger className="w-36 h-8 text-xs">
              <SelectValue placeholder="All roles" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All roles</SelectItem>
              {uniqueRoles.map(r => (
                <SelectItem key={r} value={r}>{r.replace(/_/g, ' ')}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* ── Main content ───────────────────────────────────────────────── */}
      <div className="flex gap-6">
        {/* Roster / other views */}
        <div className="flex-1 min-w-0">
          {viewType === 'roster' && (
            <div className="space-y-4">
              {sorted.length === 0 ? (
                <Card className="p-12 text-center border-dashed">
                  <Users className="h-10 w-10 mx-auto text-muted-foreground opacity-30 mb-3" />
                  <p className="text-muted-foreground text-sm">No employees match your filters</p>
                </Card>
              ) : (
                <div className="rounded-xl border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-muted/40 border-b">
                        <th className="text-left px-4 py-3">
                          <button className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1"
                            onClick={() => toggleSort('name')}>
                            Staff <SortIcon col="name" />
                          </button>
                        </th>
                        <th className="text-left px-3 py-3 hidden md:table-cell">
                          <span className="text-xs font-semibold text-muted-foreground">Trend (5 periods)</span>
                        </th>
                        <th className="text-right px-3 py-3">
                          <button className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 ml-auto"
                            onClick={() => toggleSort('actual')}>
                            Logged <SortIcon col="actual" />
                          </button>
                        </th>
                        <th className="text-right px-3 py-3 hidden sm:table-cell">
                          <button className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 ml-auto"
                            onClick={() => toggleSort('estimated')}>
                            Est. <SortIcon col="estimated" />
                          </button>
                        </th>
                        <th className="text-center px-3 py-3">
                          <button className="text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1 mx-auto"
                            onClick={() => toggleSort('utilization')}>
                            Util <SortIcon col="utilization" />
                          </button>
                        </th>
                        <th className="text-left px-3 py-3 hidden lg:table-cell">
                          <span className="text-xs font-semibold text-muted-foreground">Status</span>
                        </th>
                        <th className="text-right px-3 py-3 hidden xl:table-cell">
                          <span className="text-xs font-semibold text-muted-foreground">Revenue</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {sorted.map(emp => {
                        const live = liveTimerByUser[emp.user_id];
                        const sparkVals = sparklineByUser[emp.user_id] || [];
                        const sparkColor = emp.utilization_percent > 120
                          ? '#f97316' : emp.utilization_percent >= 80
                          ? '#10b981' : '#60a5fa';

                        return (
                          <tr key={emp.user_id}
                            className="hover:bg-muted/20 cursor-pointer transition-colors"
                            onClick={() => setSelectedEmployee(emp)}>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-2.5">
                                <div className={cn(
                                  'h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0',
                                  emp.has_data ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                                )}>
                                  {(emp.user_name || '?').charAt(0).toUpperCase()}
                                </div>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-1.5">
                                    <p className="font-medium text-sm truncate">{emp.user_name}</p>
                                    {live && <LiveDot />}
                                  </div>
                                  <p className="text-[10px] text-muted-foreground capitalize truncate">
                                    {emp.role?.replace(/_/g, ' ')}
                                    {emp.team_name && <span> · {emp.team_name}</span>}
                                  </p>
                                </div>
                              </div>
                            </td>
                            <td className="px-3 py-3 hidden md:table-cell">
                              <Sparkline values={sparkVals} color={sparkColor} />
                            </td>
                            <td className="px-3 py-3 text-right">
                              <span className={cn('font-semibold text-sm',
                                !emp.has_data ? 'text-muted-foreground' : ''
                              )}>
                                {emp.has_data ? fmtHoursMins(emp.actual_seconds) : '—'}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-right hidden sm:table-cell">
                              <span className="text-muted-foreground text-sm">
                                {emp.estimated_seconds > 0 ? fmtHoursMins(emp.estimated_seconds) : '—'}
                              </span>
                            </td>
                            <td className="px-3 py-3 text-center">
                              <div className="flex justify-center">
                                <UtilRing
                                  percent={emp.has_data ? emp.utilization_percent : 0}
                                />
                              </div>
                            </td>
                            <td className="px-3 py-3 hidden lg:table-cell">
                              {!emp.has_data ? (
                                <Badge variant="outline" className="text-[10px] text-muted-foreground/60">idle</Badge>
                              ) : emp.utilization_percent > 120 ? (
                                <Badge className="text-[10px] bg-orange-100 text-orange-700 border-orange-200">overloaded</Badge>
                              ) : emp.utilization_percent >= 80 ? (
                                <Badge className="text-[10px] bg-emerald-100 text-emerald-700 border-emerald-200">on track</Badge>
                              ) : (
                                <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-200">under</Badge>
                              )}
                            </td>
                            {revenueByUser.has(emp.user_id) && (
                              <td className="px-3 py-3 text-right hidden xl:table-cell">
                                <div className="flex flex-col items-end">
                                  <span className="text-[10px] text-muted-foreground">Revenue</span>
                                  <span className="text-xs font-semibold text-green-700">
                                    ${(revenueByUser.get(emp.user_id).revenue / 1000).toFixed(0)}k
                                  </span>
                                  <span className="text-[9px] text-muted-foreground">
                                    {revenueByUser.get(emp.user_id).projects} jobs
                                  </span>
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {viewType === 'heatmap' && (
            <UtilizationHeatmap utilizations={sorted} onEmployeeClick={setSelectedEmployee} />
          )}
          {viewType === 'teams' && (
            <TeamComparisonView groupedByTeam={groupedByTeam} />
          )}
          {viewType === 'roles' && (
            <RoleAnalysisView utilizations={sorted} />
          )}
        </div>

        {/* ── Attention sidebar ─────────────────────────────────────── */}
        {viewType === 'roster' && (attentionSignals.burnoutRisk.length > 0 || attentionSignals.dark.length > 0 || attentionSignals.available.length > 0) && (
          <div className="w-52 shrink-0 space-y-3">
            <SectionLabel>Attention</SectionLabel>
            <AttentionCard
              icon={AlertTriangle}
              label="Burnout risk"
              color="bg-orange-50 border-orange-200 text-orange-700"
              people={attentionSignals.burnoutRisk}
              onSelect={setSelectedEmployee}
            />
            <AttentionCard
              icon={Moon}
              label="No hours logged"
              color="bg-slate-50 border-slate-200 text-slate-600"
              people={attentionSignals.dark}
              onSelect={setSelectedEmployee}
            />
            <AttentionCard
              icon={Battery}
              label="Available bandwidth"
              color="bg-blue-50 border-blue-200 text-blue-700"
              people={attentionSignals.available}
              onSelect={setSelectedEmployee}
            />
          </div>
        )}
      </div>

      {/* Employee detail modal */}
      <EmployeeDetailModal
        employee={selectedEmployee}
        open={!!selectedEmployee}
        onOpenChange={open => !open && setSelectedEmployee(null)}
        period={period}
        allTimeLogs={allTimeLogs}
        allProjects={allProjects}
      />
    </div>
  );
}
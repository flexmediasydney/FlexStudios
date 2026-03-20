import React, { useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, Briefcase, TrendingUp, DollarSign, Clock, CheckCircle2, Zap } from 'lucide-react';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Link } from 'react-router-dom';
import Org2MetricsCard, { calculateMetrics } from './Org2MetricsCard';
import { createPageUrl } from '@/utils';
import { differenceInDays, parseISO, startOfMonth, endOfMonth, format } from 'date-fns';
import { fixTimestamp } from '@/components/utils/dateUtils';

// ─── Formatters ───────────────────────────────────────────────────────────────
const fmtCurrency = (n) => {
  if (!n || isNaN(n)) return '$0';
  return Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${Math.round(n)}`;
};
const fmtDate = (d) => { try { return d ? format(parseISO(d), 'dd MMM') : '—'; } catch { return '—'; } };

// ─── Colour maps ──────────────────────────────────────────────────────────────
const STATE_CLS = {
  Active: 'bg-green-100 text-green-700',
  Prospecting: 'bg-blue-100 text-blue-700',
  Dormant: 'bg-amber-100 text-amber-700',
  'Do Not Contact': 'bg-red-100 text-red-700',
};
const OUTCOME_CLS = {
  open: 'bg-blue-100 text-blue-700',
  won: 'bg-green-100 text-green-700',
  lost: 'bg-gray-100 text-gray-600',
};
const STATUS_CLS = {
  completed: 'text-green-700',
  identified: 'text-blue-700',
  in_progress: 'text-amber-700',
  cancelled: 'text-gray-500',
  pending: 'text-purple-700',
  rejected: 'text-red-700',
};

// ─── Micro UI helpers ─────────────────────────────────────────────────────────
function Chip({ label, cls }) {
  return <span className={`text-[9px] px-1.5 py-0.5 rounded font-semibold ${cls}`}>{label}</span>;
}

function DrillHeader({ title, count }) {
  return (
    <div className="flex items-center justify-between mb-3 pb-2 border-b">
      <h4 className="font-semibold text-sm text-foreground">{title}</h4>
      {count !== undefined && (
        <span className="text-[10px] bg-muted text-muted-foreground px-2 py-0.5 rounded-full font-medium">{count}</span>
      )}
    </div>
  );
}

function DrillGroup({ title, count, colorClass = 'text-muted-foreground' }) {
  return (
    <div className={`text-[10px] font-semibold uppercase tracking-wide flex items-center justify-between mt-3 mb-1 ${colorClass}`}>
      <span>{title}</span>
      {count !== undefined && <span className="bg-muted text-muted-foreground px-1.5 py-0.5 rounded font-medium">{count}</span>}
    </div>
  );
}

function Row({ href, label, sub, right }) {
  const inner = (
    <div className="flex items-center justify-between py-1.5 px-1 rounded hover:bg-muted/50 transition-colors group cursor-pointer">
      <div className="flex-1 min-w-0 pr-2">
        <p className="text-xs font-medium truncate text-foreground/80 group-hover:text-foreground">{label}</p>
        {sub && <p className="text-[10px] text-muted-foreground truncate mt-0.5">{sub}</p>}
      </div>
      {right && <div className="flex items-center gap-1.5 shrink-0">{right}</div>}
    </div>
  );
  if (href) return <Link to={href}>{inner}</Link>;
  return inner;
}

function RecordList({ items = [], limit = 8, renderItem, emptyText = 'No records', title = 'All Records' }) {
  const [open, setOpen] = useState(false);
  const shown = items.slice(0, limit);
  const extra = items.length - shown.length;
  if (items.length === 0) return <p className="text-xs text-muted-foreground py-2 text-center italic">{emptyText}</p>;
  return (
    <div>
      {shown.map(renderItem)}
      {extra > 0 && (
        <>
          <button
            onClick={() => setOpen(true)}
            className="w-full text-center text-[10px] text-primary hover:text-primary/80 font-medium py-1.5 hover:bg-primary/5 rounded transition-colors"
          >
            +{extra} more — view all
          </button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="max-w-md max-h-[75vh] flex flex-col">
              <DialogHeader className="shrink-0">
                <DialogTitle className="text-sm font-semibold">{title} <span className="text-muted-foreground font-normal">({items.length})</span></DialogTitle>
              </DialogHeader>
              <div className="overflow-y-auto flex-1 pr-1">
                {items.map(renderItem)}
              </div>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function Org2Dashboard({ agency, agents, teams, projects, revisions = [], projectTasks = [], taskTimeLogs = [] }) {
  const metrics = calculateMetrics(projects, projectTasks, revisions, taskTimeLogs);

  const now = new Date();
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);

  // Pre-computed record-level arrays for drill-downs
  const drill = useMemo(() => {
    const thisMonth = projects
      .filter(p => { try { const d = parseISO(p.created_date); return d >= monthStart && d <= monthEnd; } catch { return false; } })
      .sort((a, b) => new Date(fixTimestamp(b.created_date)) - new Date(fixTimestamp(a.created_date)));

    const paid = projects.filter(p => p.payment_status === 'paid')
      .sort((a, b) => (b.calculated_price || b.price || 0) - (a.calculated_price || a.price || 0));

    const unpaid = projects.filter(p => p.payment_status !== 'paid')
      .sort((a, b) => (b.calculated_price || b.price || 0) - (a.calculated_price || a.price || 0));

    const wonProjects = projects.filter(p => p.outcome === 'won')
      .sort((a, b) => (b.calculated_price || b.price || 0) - (a.calculated_price || a.price || 0));

    const turnaroundProjects = projects
      .filter(p => p.status === 'delivered' && p.shooting_started_at && p.delivery_date)
      .map(p => { try { return { ...p, turnaroundDays: Math.max(0, differenceInDays(parseISO(p.delivery_date), parseISO(p.shooting_started_at))) }; } catch { return null; } })
      .filter(Boolean)
      .sort((a, b) => a.turnaroundDays - b.turnaroundDays);

    const effortByProject = taskTimeLogs
      .filter(l => l.status === 'completed')
      .reduce((acc, l) => { acc[l.project_id] = (acc[l.project_id] || 0) + (l.total_seconds || 0); return acc; }, {});
    const projectsWithEffort = projects
      .map(p => ({ ...p, effortSeconds: effortByProject[p.id] || 0 }))
      .filter(p => p.effortSeconds > 0)
      .sort((a, b) => b.effortSeconds - a.effortSeconds);

    const delivered = projects.filter(p => p.status === 'delivered')
      .sort((a, b) => new Date(fixTimestamp(b.delivery_date || b.updated_date) || 0) - new Date(fixTimestamp(a.delivery_date || a.updated_date) || 0));

    const revByStatus = revisions.reduce((acc, r) => {
      const s = r.status || 'unknown';
      if (!acc[s]) acc[s] = [];
      acc[s].push(r);
      return acc;
    }, {});

    const revisionsWithCycle = revisions
      .filter(r => r.created_date && r.updated_date)
      .map(r => ({ ...r, cycleDays: (new Date(fixTimestamp(r.updated_date)) - new Date(fixTimestamp(r.created_date))) / (1000 * 60 * 60 * 24) }))
      .sort((a, b) => b.cycleDays - a.cycleDays);

    const agentsByState = agents.reduce((acc, a) => {
      const s = a.relationship_state || 'Unknown';
      if (!acc[s]) acc[s] = [];
      acc[s].push(a);
      return acc;
    }, {});

    return { thisMonth, paid, unpaid, wonProjects, turnaroundProjects, projectsWithEffort, delivered, revByStatus, revisionsWithCycle, agentsByState };
  }, [projects, revisions, taskTimeLogs, agents]);

  const pUrl = (p) => createPageUrl(`ProjectDetails?id=${p.id}`);
  const aUrl = (a) => createPageUrl(`PersonDetails?id=${a.id}`);
  const revUrl = (r) => createPageUrl(`ProjectDetails?id=${r.project_id}&tab=requests&revisionId=${r.id}`);

  // ─── Drill-down content for the 4 top stat cards ──────────────────────────
  const getStatDrillContent = (label) => {
    switch (label) {
      case 'People':
        return (
          <div>
            <DrillHeader title="People" count={agents.length} />
            {['Active', 'Prospecting', 'Dormant', 'Do Not Contact'].map(state => {
              const group = drill.agentsByState[state] || [];
              if (!group.length) return null;
              const cls = state === 'Active' ? 'text-green-700' : state === 'Prospecting' ? 'text-blue-700' : state === 'Dormant' ? 'text-amber-700' : 'text-red-700';
              return (
                <div key={state}>
                  <DrillGroup title={state} count={group.length} colorClass={cls} />
                  <RecordList
                    items={group} limit={8} title={`${state} People`}
                    renderItem={a => (
                      <Row key={a.id} href={aUrl(a)} label={a.name} sub={a.title || a.email || ''}
                        right={<Chip label={a.relationship_state} cls={STATE_CLS[a.relationship_state] || 'bg-gray-100 text-gray-600'} />}
                      />
                    )}
                  />
                </div>
              );
            })}
          </div>
        );

      case 'Teams':
        return (
          <div>
            <DrillHeader title="Teams" count={teams.length} />
            <RecordList
              items={teams} limit={8} emptyText="No teams" title="Teams"
              renderItem={t => {
                const count = agents.filter(a => a.current_team_id === t.id).length;
                return (
                  <Row key={t.id} label={t.name} sub={t.email || ''}
                    right={<span className="text-[10px] text-muted-foreground">{count} {count === 1 ? 'person' : 'people'}</span>}
                  />
                );
              }}
            />
          </div>
        );

      case 'Projects': {
        return (
          <div>
            <DrillHeader title="All Projects" count={projects.length} />
            {['open', 'won', 'lost'].map(outcome => {
              const group = projects.filter(p => (p.outcome || 'open') === outcome);
              if (!group.length) return null;
              const cls = outcome === 'won' ? 'text-green-700' : outcome === 'lost' ? 'text-gray-500' : 'text-blue-700';
              return (
                <div key={outcome}>
                  <DrillGroup title={outcome.charAt(0).toUpperCase() + outcome.slice(1)} count={group.length} colorClass={cls} />
                  <RecordList
                    items={group} limit={7} title={`${outcome.charAt(0).toUpperCase() + outcome.slice(1)} Projects`}
                    renderItem={p => (
                      <Row key={p.id} href={pUrl(p)} label={p.title} sub={p.property_address || ''}
                        right={
                          (p.calculated_price || p.price) > 0
                            ? <span className="text-xs font-semibold">{fmtCurrency(p.calculated_price || p.price)}</span>
                            : null
                        }
                      />
                    )}
                  />
                </div>
              );
            })}
          </div>
        );
      }

      case 'Revenue': {
        const wonRev = drill.wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
        const paidWonRev = drill.wonProjects.filter(p => p.payment_status === 'paid').reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
        return (
          <div>
            <DrillHeader title="Won Revenue" count={fmtCurrency(wonRev)} />
            <div className="flex gap-3 mb-3 text-xs">
              <span className="text-green-700">Paid: <strong>{fmtCurrency(paidWonRev)}</strong></span>
              <span className="text-orange-600">Outstanding: <strong>{fmtCurrency(wonRev - paidWonRev)}</strong></span>
            </div>
            <RecordList
              items={drill.wonProjects} limit={8} emptyText="No won projects" title="Won Projects"
              renderItem={p => (
                <Row key={p.id} href={pUrl(p)} label={p.title} sub={fmtDate(p.created_date)}
                  right={
                    <>
                      <Chip
                        label={p.payment_status === 'paid' ? 'Paid' : 'Unpaid'}
                        cls={p.payment_status === 'paid' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}
                      />
                      <span className="text-xs font-semibold">{fmtCurrency(p.calculated_price || p.price || 0)}</span>
                    </>
                  }
                />
              )}
            />
          </div>
        );
      }

      default:
        return null;
    }
  };

  const stats = [
    { label: 'People', value: agents.length, icon: Users, color: 'bg-blue-100 text-blue-700' },
    { label: 'Teams', value: teams.length, icon: Users, color: 'bg-purple-100 text-purple-700' },
    { label: 'Projects', value: projects.length, icon: Briefcase, color: 'bg-amber-100 text-amber-700' },
    {
      label: 'Revenue',
      value: fmtCurrency(drill.wonProjects.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0)),
      icon: DollarSign,
      color: 'bg-green-100 text-green-700',
    },
  ];

  const projectStats = [
    { label: 'Open', value: projects.filter(p => p.outcome === 'open').length, color: 'text-blue-600' },
    { label: 'Won', value: projects.filter(p => p.outcome === 'won').length, color: 'text-green-600' },
    { label: 'Lost', value: projects.filter(p => p.outcome === 'lost').length, color: 'text-red-600' },
  ];

  return (
    <div className="space-y-4">
      {/* Main Stats Grid */}
      <div className="grid grid-cols-2 gap-2">
        {stats.map((stat) => {
          const StatIcon = stat.icon;
          const drillContent = getStatDrillContent(stat.label);
          return (
            <HoverCard key={stat.label} openDelay={250} closeDelay={100}>
              <HoverCardTrigger asChild>
                <Card className="hover:shadow-md hover:border-primary/30 transition-all cursor-pointer group">
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-[10px] text-muted-foreground font-semibold uppercase tracking-wide">{stat.label}</p>
                      <div className={`p-1.5 rounded-md ${stat.color} shrink-0 group-hover:scale-110 transition-transform`}>
                        <StatIcon className="h-3 w-3" />
                      </div>
                    </div>
                    <p className="text-xl font-bold leading-none">{stat.value}</p>
                  </CardContent>
                </Card>
              </HoverCardTrigger>
              {drillContent && (
                <HoverCardContent className="w-72 max-h-[400px] overflow-y-auto p-3" side="right" align="start">
                  {drillContent}
                </HoverCardContent>
              )}
            </HoverCard>
          );
        })}
      </div>

      {/* Project Outcomes */}
      {projects.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Project Outcomes</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            <div className="space-y-1.5">
              {projectStats.map(stat => {
                const pct = projects.length > 0 ? Math.round((stat.value / projects.length) * 100) : 0;
                return (
                  <div key={stat.label}>
                    <div className="flex items-center justify-between text-xs mb-0.5">
                      <span className="text-muted-foreground">{stat.label}</span>
                      <span className={`font-bold ${stat.color}`}>{stat.value}</span>
                    </div>
                    <div className="h-1 rounded-full bg-muted overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${stat.label === 'Won' ? 'bg-green-500' : stat.label === 'Lost' ? 'bg-red-400' : 'bg-blue-400'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
              {projects.filter(p => p.outcome !== 'open').length > 0 && (
                <div className="pt-1.5 mt-1 border-t flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Win Rate</span>
                  <span className="font-bold text-green-600">
                    {Math.round((projects.filter(p => p.outcome === 'won').length / projects.filter(p => p.outcome !== 'open').length) * 100)}%
                  </span>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Payment Status */}
      {projects.length > 0 && (
        <Card>
          <CardHeader className="pb-2 pt-3 px-4">
            <CardTitle className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Payment Status</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-3">
            {(() => {
              const paid = projects.filter(p => p.payment_status === 'paid');
              const unpaid = projects.filter(p => p.payment_status === 'unpaid');
              const paidRev = paid.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
              const unpaidRev = unpaid.reduce((s, p) => s + (p.calculated_price || p.price || 0), 0);
              const total = paid.length + unpaid.length;
              const paidPct = total > 0 ? Math.round((paid.length / total) * 100) : 0;
              return (
                <div className="space-y-2">
                  <div className="flex h-2 rounded-full overflow-hidden bg-orange-100">
                    <div className="bg-green-500 transition-all" style={{ width: `${paidPct}%` }} />
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-2 rounded-full bg-green-500" />
                      <span className="text-muted-foreground">Paid</span>
                      <span className="font-bold text-green-700">{paid.length}</span>
                      {paidRev > 0 && <span className="text-green-600">{fmtCurrency(paidRev)}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <div className="h-2 w-2 rounded-full bg-orange-400" />
                      <span className="text-muted-foreground">Unpaid</span>
                      <span className="font-bold text-orange-700">{unpaid.length}</span>
                      {unpaidRev > 0 && <span className="text-orange-600">{fmtCurrency(unpaidRev)}</span>}
                    </div>
                  </div>
                </div>
              );
            })()}
          </CardContent>
        </Card>
      )}

      {/* Performance Metrics */}
      <div className="pt-3 border-t space-y-2.5 text-xs">
        <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Performance Metrics</p>

        {/* Paid vs Unpaid */}
        <Org2MetricsCard
          label="Paid vs Unpaid"
          icon={DollarSign}
          color="bg-emerald-100 text-emerald-700"
          mainValue={`${metrics.paidCount}/${metrics.unpaidCount}`}
          subValue={`${fmtCurrency(metrics.paidRevenue)} / ${fmtCurrency(metrics.unpaidRevenue)}`}
          detailsRender={() => (
            <div>
              <DrillHeader title="Payment Breakdown" />
              <DrillGroup title={`Paid (${drill.paid.length})`} colorClass="text-green-700" />
              <RecordList
                items={drill.paid} limit={6} emptyText="No paid projects" title="Paid Projects"
                renderItem={p => (
                  <Row key={p.id} href={pUrl(p)} label={p.title}
                    right={<span className="text-xs font-semibold text-green-700">{fmtCurrency(p.calculated_price || p.price || 0)}</span>}
                  />
                )}
              />
              <DrillGroup title={`Unpaid (${drill.unpaid.length})`} colorClass="text-orange-700" />
              <RecordList
                items={drill.unpaid} limit={6} emptyText="No unpaid projects" title="Unpaid Projects"
                renderItem={p => (
                  <Row key={p.id} href={pUrl(p)} label={p.title}
                    right={<span className="text-xs font-semibold text-orange-700">{fmtCurrency(p.calculated_price || p.price || 0)}</span>}
                  />
                )}
              />
            </div>
          )}
        />

        {/* This Month */}
        <Org2MetricsCard
          label="This Month"
          icon={TrendingUp}
          color="bg-blue-100 text-blue-700"
          mainValue={metrics.thisMonthCount}
          subValue={`${fmtCurrency(metrics.thisMonthRevenue)} revenue`}
          detailsRender={() => (
            <div>
              <DrillHeader title="This Month's Projects" count={drill.thisMonth.length} />
              <RecordList
                items={drill.thisMonth} limit={8} emptyText="No projects created this month" title="This Month's Projects"
                renderItem={p => (
                  <Row
                    key={p.id} href={pUrl(p)} label={p.title} sub={fmtDate(p.created_date)}
                    right={
                      <>
                        <Chip label={p.outcome || 'open'} cls={OUTCOME_CLS[p.outcome || 'open']} />
                        {(p.calculated_price || p.price) > 0 && (
                          <span className="text-xs font-semibold">{fmtCurrency(p.calculated_price || p.price)}</span>
                        )}
                      </>
                    }
                  />
                )}
              />
            </div>
          )}
        />

        {/* Avg Turnaround */}
        {metrics.projectsWithBothDatesCount > 0 && (
          <Org2MetricsCard
            label="Avg Turnaround"
            icon={Clock}
            color="bg-purple-100 text-purple-700"
            mainValue={`${metrics.avgTurnaround}d`}
            subValue={`${metrics.minTurnaround}–${metrics.maxTurnaround}d range`}
            detailsRender={() => (
              <div>
                <DrillHeader title="Turnaround by Project" count={drill.turnaroundProjects.length} />
                <div className="flex gap-3 mb-3 text-xs border-b pb-2">
                  <span className="text-green-700">Best: <strong>{metrics.minTurnaround}d</strong></span>
                  <span className="text-red-600">Worst: <strong>{metrics.maxTurnaround}d</strong></span>
                  <span className="text-muted-foreground">Avg: <strong>{metrics.avgTurnaround}d</strong></span>
                </div>
                <RecordList
                  items={drill.turnaroundProjects} limit={8} emptyText="No turnaround data" title="Turnaround by Project"
                  renderItem={p => (
                    <Row
                      key={p.id} href={pUrl(p)} label={p.title}
                      sub={p.delivery_date ? `Delivered ${fmtDate(p.delivery_date)}` : ''}
                      right={
                        <span className={`text-xs font-bold ${p.turnaroundDays <= metrics.avgTurnaround ? 'text-green-600' : 'text-orange-600'}`}>
                          {p.turnaroundDays}d
                        </span>
                      }
                    />
                  )}
                />
              </div>
            )}
          />
        )}

        {/* Total Effort */}
        <Org2MetricsCard
          label="Total Effort"
          icon={Zap}
          color="bg-amber-100 text-amber-700"
          mainValue={`${(metrics.totalEffort / 3600).toFixed(0)}h`}
          subValue={`W: ${(metrics.weekEffort / 3600).toFixed(0)}h | M: ${(metrics.monthEffort / 3600).toFixed(0)}h`}
          detailsRender={() => (
            <div>
              <DrillHeader title="Effort by Project" />
              <div className="flex gap-3 mb-3 text-xs border-b pb-2">
                <span className="text-muted-foreground">Total: <strong>{(metrics.totalEffort / 3600).toFixed(1)}h</strong></span>
                <span className="text-muted-foreground">Month: <strong>{(metrics.monthEffort / 3600).toFixed(1)}h</strong></span>
                <span className="text-muted-foreground">Week: <strong>{(metrics.weekEffort / 3600).toFixed(1)}h</strong></span>
              </div>
              {drill.projectsWithEffort.length > 0 ? (
                <RecordList
                  items={drill.projectsWithEffort} limit={8} title="Effort by Project"
                  renderItem={p => (
                    <Row key={p.id} href={pUrl(p)} label={p.title}
                      right={<span className="text-xs font-semibold text-amber-700">{(p.effortSeconds / 3600).toFixed(1)}h</span>}
                    />
                  )}
                />
              ) : (
                <p className="text-xs text-muted-foreground text-center py-2 italic">No time logs recorded yet</p>
              )}
            </div>
          )}
        />

        {/* Completed Projects */}
        {projects.filter(p => p.status === 'delivered' && p.delivery_date).length > 0 && (
          <Org2MetricsCard
            label="Completed Projects"
            icon={CheckCircle2}
            color="bg-cyan-100 text-cyan-700"
            mainValue={projects.filter(p => p.status === 'delivered').length}
            subValue={`${projects.filter(p => p.status === 'delivered' && p.delivery_date).length} with delivery dates`}
            detailsRender={() => (
              <div>
                <DrillHeader title="Delivered Projects" count={drill.delivered.length} />
                <RecordList
                  items={drill.delivered} limit={8} emptyText="No delivered projects" title="Delivered Projects"
                  renderItem={p => (
                    <Row key={p.id} href={pUrl(p)} label={p.title}
                      sub={p.delivery_date ? `Delivered ${fmtDate(p.delivery_date)}` : ''}
                      right={
                        (p.calculated_price || p.price) > 0
                          ? <span className="text-xs font-semibold">{fmtCurrency(p.calculated_price || p.price)}</span>
                          : null
                      }
                    />
                  )}
                />
              </div>
            )}
          />
        )}

        {/* Revision Requests */}
        {(() => {
          const revisionReqs = revisions.filter(r => r.request_kind === 'revision');
          const openRevReqs = revisionReqs.filter(r => !['completed', 'delivered', 'cancelled'].includes(r.status));
          const closedRevReqs = revisionReqs.filter(r => ['completed', 'delivered', 'cancelled'].includes(r.status));
          const openByStatus = openRevReqs.reduce((acc, r) => { const s = r.status || 'unknown'; if (!acc[s]) acc[s] = []; acc[s].push(r); return acc; }, {});
          const closedByStatus = closedRevReqs.reduce((acc, r) => { const s = r.status || 'unknown'; if (!acc[s]) acc[s] = []; acc[s].push(r); return acc; }, {});
          return (
            <Org2MetricsCard
              label="Revision Requests"
              icon={CheckCircle2}
              color="bg-violet-100 text-violet-700"
              mainValue={revisionReqs.length}
              subValue={revisionReqs.length > 0 ? `${openRevReqs.length} open · ${closedRevReqs.length} closed` : 'No revision requests'}
              detailsRender={() => {
                if (!revisionReqs.length) return <p className="text-xs text-muted-foreground py-2 text-center italic">No revision requests yet</p>;
                return (
                  <div>
                    <DrillHeader title="Revision Requests" count={revisionReqs.length} />
                    {openRevReqs.length > 0 && (
                      <>
                        <DrillGroup title={`Open (${openRevReqs.length})`} colorClass="text-violet-700" />
                        {Object.entries(openByStatus).sort((a, b) => b[1].length - a[1].length).map(([status, items]) => (
                          <div key={status}>
                            <DrillGroup title={status.replace(/_/g, ' ')} count={items.length} colorClass={STATUS_CLS[status] || 'text-muted-foreground'} />
                            <RecordList
                              items={items} limit={4} title={`${status.replace(/_/g, ' ')} Revision Requests`}
                              renderItem={r => (
                                <Row key={r.id} href={revUrl(r)}
                                  label={r.title || `Revision ${r.id?.slice(-6) || ''}`}
                                  sub={r.project_title || fmtDate(r.created_date)}
                                  right={<Chip label={r.priority || 'normal'} cls="bg-violet-100 text-violet-700" />}
                                />
                              )}
                            />
                          </div>
                        ))}
                      </>
                    )}
                    {closedRevReqs.length > 0 && (
                      <>
                        <DrillGroup title={`Closed (${closedRevReqs.length})`} colorClass="text-muted-foreground" />
                        {Object.entries(closedByStatus).sort((a, b) => b[1].length - a[1].length).map(([status, items]) => (
                          <div key={status}>
                            <DrillGroup title={status.replace(/_/g, ' ')} count={items.length} colorClass={STATUS_CLS[status] || 'text-muted-foreground'} />
                            <RecordList
                              items={items} limit={4} title={`${status.replace(/_/g, ' ')} Revision Requests`}
                              renderItem={r => (
                                <Row key={r.id} href={revUrl(r)}
                                  label={r.title || `Revision ${r.id?.slice(-6) || ''}`}
                                  sub={r.project_title || fmtDate(r.created_date)}
                                />
                              )}
                            />
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              }}
            />
          );
        })()}

        {/* Change Requests */}
        <Org2MetricsCard
          label="Change Requests"
          icon={CheckCircle2}
          color="bg-rose-100 text-rose-700"
          mainValue={revisions.length}
          subValue={revisions.length > 0 ? `${revisions.filter(r => r.status === 'completed').length} completed` : 'No requests'}
          detailsRender={() => {
            if (!revisions.length) return <p className="text-xs text-muted-foreground py-2 text-center italic">No change requests yet</p>;
            const doneRevs = revisions.filter(r => r.created_date && r.updated_date);
            const avgCycle = doneRevs.length
              ? doneRevs.reduce((s, r) => s + (new Date(fixTimestamp(r.updated_date)) - new Date(fixTimestamp(r.created_date))) / (1000 * 60 * 60 * 24), 0) / doneRevs.length
              : 0;
            return (
              <div>
                <DrillHeader title="Change Requests" count={revisions.length} />
                {Object.entries(drill.revByStatus)
                  .sort((a, b) => b[1].length - a[1].length)
                  .map(([status, items]) => (
                    <div key={status}>
                      <DrillGroup
                        title={status.replace(/_/g, ' ')}
                        count={items.length}
                        colorClass={STATUS_CLS[status] || 'text-muted-foreground'}
                      />
                      <RecordList
                        items={items} limit={4} title={`${status.replace(/_/g, ' ')} Requests`}
                        renderItem={r => (
                          <Row key={r.id} href={revUrl(r)}
                            label={r.title || r.description || `Request ${r.id?.slice(-6) || ''}`}
                            sub={r.project_title || fmtDate(r.created_date)}
                          />
                        )}
                      />
                    </div>
                  ))}
                {doneRevs.length > 0 && (
                  <div className="mt-3 pt-2 border-t flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Avg Cycle Time:</span>
                    <span className="font-semibold">{avgCycle.toFixed(1)} days</span>
                  </div>
                )}
              </div>
            );
          }}
        />
      </div>
    </div>
  );
}
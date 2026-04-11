import { useMemo, useState } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DollarSign, TrendingUp, TrendingDown, Minus, Building2, AlertTriangle, BarChart3, ArrowRight, User } from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { format, subWeeks, subMonths, startOfWeek, endOfWeek, eachWeekOfInterval, startOfMonth, endOfMonth, isWithinInterval, differenceInDays } from 'date-fns';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';

const pv = (p) => p.invoiced_amount ?? p.calculated_price ?? p.price ?? 0;

export default function RevenueIntelligence() {
  const [period, setPeriod] = useState('weekly');
  const { data: projects = [], loading } = useEntityList('Project', '-created_date', 1000);
  const { data: agencies = [] } = useEntityList('Agency', 'name');
  const { data: efforts = [] } = useEntityList('ProjectEffort');

  const now = new Date();

  // Weekly revenue heatmap
  const weeklyData = useMemo(() => {
    const weeks = eachWeekOfInterval({ start: subWeeks(now, 11), end: now }, { weekStartsOn: 1 });
    const topAgencyIds = (() => {
      const counts = {};
      projects.forEach(p => { if (p.agency_id) counts[p.agency_id] = (counts[p.agency_id] || 0) + pv(p); });
      return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => id);
    })();

    return weeks.map(weekStart => {
      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
      const weekProjects = projects.filter(p => {
        if (!p.created_date) return false;
        const d = new Date(fixTimestamp(p.created_date));
        return isWithinInterval(d, { start: weekStart, end: weekEnd });
      });
      const total = weekProjects.reduce((s, p) => s + pv(p), 0);
      const byAgency = {};
      topAgencyIds.forEach(id => { byAgency[id] = weekProjects.filter(p => p.agency_id === id).reduce((s, p) => s + pv(p), 0); });
      byAgency._other = weekProjects.filter(p => !topAgencyIds.includes(p.agency_id)).reduce((s, p) => s + pv(p), 0);
      return { label: format(weekStart, 'dd MMM'), total, count: weekProjects.length, byAgency };
    });
  }, [projects]);

  const topAgencies = useMemo(() => {
    const stats = {};
    projects.forEach(p => {
      if (!p.agency_id) return;
      if (!stats[p.agency_id]) stats[p.agency_id] = { id: p.agency_id, name: p.agency_name || 'Unknown', revenue: 0, count: 0, recent: 0, prior: 0 };
      stats[p.agency_id].revenue += pv(p);
      stats[p.agency_id].count++;
      if (p.created_date) {
        const d = new Date(fixTimestamp(p.created_date));
        if (d >= subMonths(now, 3)) stats[p.agency_id].recent++;
        else if (d >= subMonths(now, 6)) stats[p.agency_id].prior++;
      }
    });
    return Object.values(stats).sort((a, b) => b.revenue - a.revenue).slice(0, 10).map(a => ({
      ...a,
      growth: a.prior > 0 ? Math.round(((a.recent - a.prior) / a.prior) * 100) : a.recent > 0 ? 100 : 0,
    }));
  }, [projects]);

  // Revenue at risk
  const atRisk = useMemo(() => {
    const unpaid = projects.filter(p =>
      p.status === 'delivered' && p.payment_status !== 'paid' &&
      p.tonomo_delivered_at && differenceInDays(now, new Date(fixTimestamp(p.tonomo_delivered_at))) > 14
    );
    const stale = projects.filter(p =>
      p.outcome === 'open' && !['delivered'].includes(p.status) &&
      p.last_status_change && differenceInDays(now, new Date(fixTimestamp(p.last_status_change))) > 30
    );
    const churning = topAgencies.filter(a => a.growth < -50 && a.prior > 2);
    return { unpaid, stale, churning, totalAtRisk: unpaid.reduce((s, p) => s + pv(p), 0) + stale.reduce((s, p) => s + pv(p), 0) };
  }, [projects, topAgencies]);

  // Quote vs invoice gap
  const quoteGap = useMemo(() => {
    const withBoth = projects.filter(p => p.invoiced_amount > 0 && p.calculated_price > 0);
    if (withBoth.length === 0) return null;
    const totalQuoted = withBoth.reduce((s, p) => s + p.calculated_price, 0);
    const totalInvoiced = withBoth.reduce((s, p) => s + p.invoiced_amount, 0);
    return { gap: totalInvoiced - totalQuoted, pct: Math.round(((totalInvoiced - totalQuoted) / totalQuoted) * 100), count: withBoth.length };
  }, [projects]);

  // Summary stats
  const stats = useMemo(() => {
    const thisMonth = projects.filter(p => p.created_date && new Date(fixTimestamp(p.created_date)) >= startOfMonth(now));
    const lastMonth = projects.filter(p => {
      if (!p.created_date) return false;
      const d = new Date(fixTimestamp(p.created_date));
      const lm = subMonths(now, 1);
      return d >= startOfMonth(lm) && d <= endOfMonth(lm);
    });
    const mtdRevenue = thisMonth.reduce((s, p) => s + pv(p), 0);
    const lmRevenue = lastMonth.reduce((s, p) => s + pv(p), 0);
    const totalRevenue = projects.reduce((s, p) => s + pv(p), 0);
    const avgValue = projects.length > 0 ? totalRevenue / projects.length : 0;
    return { mtdRevenue, lmRevenue, totalRevenue, avgValue, growth: lmRevenue > 0 ? Math.round(((mtdRevenue - lmRevenue) / lmRevenue) * 100) : 0 };
  }, [projects]);

  const maxWeekly = Math.max(...weeklyData.map(w => w.total), 1);

  if (loading) return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-28 bg-muted animate-pulse rounded-xl" />)}</div>;

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'MTD Revenue', value: `$${Math.round(stats.mtdRevenue / 1000)}k`, sub: `${stats.growth > 0 ? '+' : ''}${stats.growth}% vs last month`, color: stats.growth > 0 ? 'text-green-600' : stats.growth < 0 ? 'text-red-600' : '' },
          { label: 'Total Revenue', value: `$${Math.round(stats.totalRevenue / 1000)}k`, sub: `${projects.length} projects`, color: '' },
          { label: 'Avg Project Value', value: `$${Math.round(stats.avgValue).toLocaleString()}`, sub: 'per project', color: '' },
          { label: 'Revenue at Risk', value: `$${Math.round(atRisk.totalAtRisk / 1000)}k`, sub: `${atRisk.unpaid.length} unpaid + ${atRisk.stale.length} stale`, color: atRisk.totalAtRisk > 0 ? 'text-red-600' : 'text-green-600' },
        ].map((kpi, i) => (
          <Card key={i} className="p-4 hover:shadow-md transition-shadow duration-200">
            <div className="text-xs font-medium text-muted-foreground">{kpi.label}</div>
            <div className={cn('text-2xl font-bold mt-1', kpi.color)}>{kpi.value}</div>
            <div className="text-[10px] text-muted-foreground mt-0.5">{kpi.sub}</div>
          </Card>
        ))}
      </div>

      {/* Weekly revenue bars */}
      <Card className="p-4 hover:shadow-md transition-shadow duration-200">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-muted-foreground" /><span className="text-sm font-bold">Weekly revenue</span></div>
        </div>
        <div className="flex items-end gap-1.5 h-40" role="img" aria-label="Weekly revenue bar chart">
          {weeklyData.map((week, i) => (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <div className="text-[9px] font-bold tabular-nums">{week.total > 0 ? `$${Math.round(week.total / 1000)}k` : ''}</div>
              <div className="w-full rounded-t bg-primary/50 hover:bg-primary/70 transition-colors cursor-default"
                style={{ height: `${Math.max((week.total / maxWeekly) * 120, week.total > 0 ? 4 : 0)}px` }}
                title={`${week.label}: $${week.total.toLocaleString()} (${week.count} projects)`} />
              <div className="text-[8px] text-muted-foreground">{week.label}</div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-4">
        {/* Top agencies */}
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b flex items-center gap-2">
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-bold">Top agencies by revenue</span>
          </div>
          <div className="divide-y max-h-80 overflow-y-auto scrollbar-thin">
            {topAgencies.map((agency, i) => (
              <div key={agency.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-muted/30">
                <span className="text-xs text-muted-foreground w-5 text-right font-mono">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{agency.name}</div>
                  <div className="text-[10px] text-muted-foreground">{agency.count} projects</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-sm font-bold tabular-nums">${Math.round(agency.revenue / 1000)}k</div>
                  {agency.growth !== 0 && (
                    <div className={cn('text-[10px] font-medium flex items-center justify-end gap-0.5',
                      agency.growth > 0 ? 'text-green-600' : 'text-red-600')}>
                      {agency.growth > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
                      {Math.abs(agency.growth)}%
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* Risk + Quote gap */}
        <div className="space-y-4">
          {/* Revenue at risk */}
          {(atRisk.unpaid.length > 0 || atRisk.churning.length > 0) && (
            <Card className="overflow-hidden">
              <div className="px-4 py-3 border-b bg-red-50/50 dark:bg-red-950/30 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-red-600" />
                <span className="text-sm font-bold text-red-900">Revenue at risk</span>
              </div>
              <div className="divide-y">
                {atRisk.unpaid.slice(0, 5).map(p => (
                  <Link key={p.id} to={createPageUrl('ProjectDetails') + `?id=${p.id}`} className="block">
                    <div className="flex items-center gap-3 px-4 py-2 hover:bg-muted/30">
                      <DollarSign className="h-3.5 w-3.5 text-red-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-medium truncate">{p.title || p.property_address}</div>
                        <div className="text-[10px] text-muted-foreground">Unpaid · {differenceInDays(now, new Date(fixTimestamp(p.tonomo_delivered_at)))}d since delivery</div>
                      </div>
                      <span className="text-xs font-bold text-red-600">${pv(p).toLocaleString()}</span>
                    </div>
                  </Link>
                ))}
                {atRisk.churning.map(a => (
                  <div key={a.id} className="flex items-center gap-3 px-4 py-2 bg-amber-50/30">
                    <Building2 className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-medium">{a.name}</div>
                      <div className="text-[10px] text-muted-foreground">Bookings dropped {Math.abs(a.growth)}% vs prior quarter</div>
                    </div>
                    <Badge className="text-[9px] bg-amber-100 text-amber-700">Churn risk</Badge>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Quote vs invoice gap */}
          {quoteGap && (
            <Card className="p-4 hover:shadow-md transition-shadow duration-200">
              <div className="flex items-center gap-2 mb-2">
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm font-bold">Quote → Invoice Gap</span>
                <Badge variant="outline" className="text-[9px] ml-auto">{quoteGap.count} projects</Badge>
              </div>
              <div className={cn('text-2xl font-bold', quoteGap.gap >= 0 ? 'text-green-600' : 'text-red-600')}>
                {quoteGap.gap >= 0 ? '+' : ''}{quoteGap.pct}%
              </div>
              <div className="text-xs text-muted-foreground mt-1">
                {quoteGap.gap >= 0 ? 'Invoicing above' : 'Invoicing below'} quoted price across {quoteGap.count} projects
                {quoteGap.gap < 0 && <span className="text-red-600 font-medium"> — potential revenue leak of ${Math.abs(Math.round(quoteGap.gap)).toLocaleString()}</span>}
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
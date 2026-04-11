import { useMemo } from 'react';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Link } from 'react-router-dom';
import { createPageUrl } from '@/utils';
import { AlertTriangle, ArrowRight, Clock, TrendingUp, TrendingDown, Minus, User, CheckCircle2, BarChart3 } from 'lucide-react';
import { fixTimestamp } from '@/components/utils/dateUtils';
import { PROJECT_STAGES, stageLabel } from '@/components/projects/projectStatuses';
import { differenceInDays, differenceInHours, subDays, subMonths, format } from 'date-fns';

const ACTIVE_STAGES = PROJECT_STAGES.filter(s => !['delivered'].includes(s.value)).map(s => s.value);

function fmtDuration(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

export default function PipelineAnalyzer() {
  const { data: projects = [], loading: pLoading } = useEntityList('Project', '-created_date', 1000);
  const { data: stageTimers = [], loading: tLoading } = useEntityList('ProjectStageTimer', '-entry_time', 2000);

  const loading = pLoading || tLoading;
  const now = new Date();

  // Stage averages from historical data
  const stageStats = useMemo(() => {
    const stats = {};
    const thisMonth = subMonths(now, 1);
    const lastMonth = subMonths(now, 2);

    ACTIVE_STAGES.forEach(stage => {
      const completed = stageTimers.filter(t => t.stage === stage && t.exit_time && t.duration_seconds > 0);
      const recentCompleted = completed.filter(t => new Date(fixTimestamp(t.exit_time)) >= thisMonth);
      const priorCompleted = completed.filter(t => {
        const d = new Date(fixTimestamp(t.exit_time));
        return d >= lastMonth && d < thisMonth;
      });

      const avgSeconds = completed.length > 0 ? completed.reduce((s, t) => s + t.duration_seconds, 0) / completed.length : 0;
      const recentAvg = recentCompleted.length > 0 ? recentCompleted.reduce((s, t) => s + t.duration_seconds, 0) / recentCompleted.length : avgSeconds;
      const priorAvg = priorCompleted.length > 0 ? priorCompleted.reduce((s, t) => s + t.duration_seconds, 0) / priorCompleted.length : avgSeconds;
      const trend = priorAvg > 0 ? Math.round(((recentAvg - priorAvg) / priorAvg) * 100) : 0;

      // Current projects in this stage
      const currentInStage = projects.filter(p => p.status === stage && !['delivered'].includes(p.status));

      stats[stage] = {
        avgHours: avgSeconds / 3600,
        recentAvgHours: recentAvg / 3600,
        trend,
        count: currentInStage.length,
        volume: completed.length,
        projects: currentInStage,
      };
    });
    return stats;
  }, [projects, stageTimers]);

  // Bottleneck detection
  const bottlenecks = useMemo(() => {
    const items = [];
    Object.entries(stageStats).forEach(([stage, stats]) => {
      if (stats.avgHours === 0 || stats.count === 0) return;

      stats.projects.forEach(project => {
        const daysInStage = project.last_status_change
          ? differenceInHours(now, new Date(fixTimestamp(project.last_status_change))) / 24
          : 0;
        const avgDays = stats.avgHours / 24;
        const ratio = avgDays > 0 ? daysInStage / avgDays : 0;

        if (ratio >= 1.5) {
          items.push({
            project,
            stage,
            daysInStage: Math.round(daysInStage * 10) / 10,
            avgDays: Math.round(avgDays * 10) / 10,
            ratio: Math.round(ratio * 10) / 10,
            severity: ratio >= 3 ? 'critical' : ratio >= 2 ? 'warning' : 'slow',
          });
        }
      });
    });
    return items.sort((a, b) => b.ratio - a.ratio);
  }, [stageStats]);

  // Flow visualization data
  const flowData = useMemo(() => {
    return ACTIVE_STAGES.map(stage => {
      const stats = stageStats[stage] || {};
      const config = PROJECT_STAGES.find(s => s.value === stage);
      return {
        stage,
        label: config?.label || stage,
        color: config?.textColor?.replace('text-', '') || 'slate-600',
        count: stats.count || 0,
        avgHours: stats.avgHours || 0,
        trend: stats.trend || 0,
        volume: stats.volume || 0,
        hasBottleneck: bottlenecks.some(b => b.stage === stage),
      };
    }).filter(s => s.count > 0 || s.volume > 10);
  }, [stageStats, bottlenecks]);

  // Total lifecycle
  const totalLifecycle = useMemo(() => {
    const delivered = projects.filter(p => p.status === 'delivered' && p.created_date && p.updated_date);
    if (delivered.length === 0) return { avgDays: 0, count: 0 };
    const totalDays = delivered.reduce((s, p) => s + differenceInDays(new Date(fixTimestamp(p.updated_date)), new Date(fixTimestamp(p.created_date))), 0);
    return { avgDays: Math.round(totalDays / delivered.length), count: delivered.length };
  }, [projects]);

  if (loading) {
    return <div className="space-y-4">{[...Array(3)].map((_, i) => <div key={i} className="h-28 bg-muted animate-pulse rounded-xl" />)}</div>;
  }

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex gap-3">
        <Card className="flex-1 p-3" title="Projects currently in the pipeline (excluding delivered)">
          <div className="text-xs text-muted-foreground">Active Projects</div>
          <div className="text-2xl font-bold">{projects.filter(p => !['delivered'].includes(p.status)).length}</div>
          <div className="text-[9px] text-muted-foreground">in pipeline</div>
        </Card>
        <Card className="flex-1 p-3" title="Average days from creation to delivery across all completed projects">
          <div className="text-xs text-muted-foreground">Avg Lifecycle</div>
          <div className="text-2xl font-bold">{totalLifecycle.avgDays}d</div>
          <div className="text-[9px] text-muted-foreground">from {totalLifecycle.count} delivered</div>
        </Card>
        <Card className={cn('flex-1 p-3', bottlenecks.length > 0 && 'border-amber-300 bg-amber-50/30')} title="Projects taking 1.5x or longer than the stage average">
          <div className="text-xs text-muted-foreground">Bottlenecks</div>
          <div className={cn('text-2xl font-bold', bottlenecks.length > 0 ? 'text-amber-700' : 'text-green-600')}>{bottlenecks.length}</div>
          <div className="text-[9px] text-muted-foreground">projects slower than normal</div>
        </Card>
        <Card className="flex-1 p-3" title="Total recorded stage transitions used for velocity calculations">
          <div className="text-xs text-muted-foreground">Stage Timers</div>
          <div className="text-2xl font-bold">{stageTimers.length.toLocaleString()}</div>
          <div className="text-[9px] text-muted-foreground">historical data points</div>
        </Card>
      </div>

      {/* Pipeline flow */}
      <Card className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-bold">Pipeline flow</span>
        </div>
        <div className="flex items-center gap-1 overflow-x-auto pb-2">
          {flowData.map((stage, i) => (
            <div key={stage.stage} className="flex items-center">
              <div
                className={cn(
                  'rounded-xl border-2 p-3 min-w-[120px] text-center transition-all',
                  stage.hasBottleneck ? 'border-amber-400 bg-amber-50/50 shadow-sm' : 'border-border bg-card'
                )}
                title={`${stage.label}: ${stage.count} project${stage.count !== 1 ? 's' : ''} in stage, avg time ${fmtDuration(stage.avgHours)}, ${stage.volume} completed historically`}
              >
                <div className="text-xs font-bold mb-1">{stage.label}</div>
                <div className="text-2xl font-black">{stage.count}</div>
                <div className="text-[10px] text-muted-foreground mt-1">
                  avg: {fmtDuration(stage.avgHours)}
                </div>
                {stage.trend !== 0 && (
                  <div className={cn('text-[10px] font-medium flex items-center justify-center gap-0.5 mt-0.5',
                    stage.trend > 10 ? 'text-red-600' : stage.trend < -10 ? 'text-green-600' : 'text-muted-foreground')}>
                    {stage.trend > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : stage.trend < 0 ? <TrendingDown className="h-2.5 w-2.5" /> : <Minus className="h-2.5 w-2.5" />}
                    {Math.abs(stage.trend)}% vs last month
                  </div>
                )}
                {stage.hasBottleneck && <Badge className="text-[8px] bg-amber-100 text-amber-700 mt-1">BOTTLENECK</Badge>}
              </div>
              {i < flowData.length - 1 && <ArrowRight className="h-4 w-4 text-muted-foreground mx-1 shrink-0" />}
            </div>
          ))}
        </div>
      </Card>

      {/* Bottleneck detail */}
      {bottlenecks.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b bg-amber-50/50 flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <span className="text-sm font-bold text-amber-900">Bottleneck detail — projects slower than average</span>
          </div>
          <div className="divide-y">
            {bottlenecks.slice(0, 15).map((item, i) => (
              <Link key={item.project.id} to={createPageUrl('ProjectDetails') + `?id=${item.project.id}`} className="block">
                <div className={cn('flex items-center gap-3 p-3 hover:bg-muted/50 transition-colors',
                  item.severity === 'critical' ? 'bg-red-50/30' : item.severity === 'warning' ? 'bg-amber-50/30' : '')}>
                  <div className={cn('w-2 h-2 rounded-full shrink-0',
                    item.severity === 'critical' ? 'bg-red-500' : item.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-400')} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{item.project.title || item.project.property_address}</div>
                    <div className="text-xs text-muted-foreground">
                      In <strong>{stageLabel(item.stage)}</strong> for {Math.round(item.daysInStage)}d (avg: {item.avgDays}d) — <strong>{item.ratio}× slower</strong>
                      {item.project.agency_name && ` · ${item.project.agency_name}`}
                    </div>
                  </div>
                  <Badge className={cn('text-[9px] shrink-0',
                    item.severity === 'critical' ? 'bg-red-100 text-red-700' : item.severity === 'warning' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                    {item.ratio}× avg
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Stage velocity table */}
      <Card className="overflow-hidden">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Clock className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-bold">Stage velocity (last 30 days)</span>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/30">
              <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Stage</th>
              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Current</th>
              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Avg time</th>
              <th className="text-center px-3 py-2 text-xs text-muted-foreground font-medium">Trend</th>
              <th className="text-right px-3 py-2 text-xs text-muted-foreground font-medium">Volume (30d)</th>
            </tr>
          </thead>
          <tbody>
            {ACTIVE_STAGES.map(stage => {
              const stats = stageStats[stage];
              if (!stats || (stats.count === 0 && stats.volume === 0)) return null;
              const config = PROJECT_STAGES.find(s => s.value === stage);
              return (
                <tr key={stage} className="border-b last:border-0 hover:bg-muted/20">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <div className={cn('w-2 h-2 rounded-full', config?.color || 'bg-slate-200')} />
                      <span className="text-sm font-medium">{config?.label || stage}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={cn('text-sm font-bold', stats.count > 0 ? '' : 'text-muted-foreground')}>{stats.count}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm tabular-nums">{stats.avgHours > 0 ? fmtDuration(stats.avgHours) : '—'}</td>
                  <td className="px-3 py-2.5 text-center">
                    {stats.trend !== 0 ? (
                      <span className={cn('text-xs font-medium inline-flex items-center gap-0.5',
                        stats.trend > 10 ? 'text-red-600' : stats.trend < -10 ? 'text-green-600' : 'text-muted-foreground')}>
                        {stats.trend > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                        {Math.abs(stats.trend)}%
                      </span>
                    ) : <Minus className="h-3 w-3 text-muted-foreground mx-auto" />}
                  </td>
                  <td className="px-3 py-2.5 text-right text-sm text-muted-foreground tabular-nums">{stats.volume}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
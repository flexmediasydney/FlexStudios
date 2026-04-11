import { useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Card } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEntityList } from '@/components/hooks/useEntityData';
import { Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fmtTimestampCustom, fixTimestamp } from '@/components/utils/dateUtils';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  logSeconds, fmtHoursMins, buildPeriodBuckets, getPeriodBounds,
} from '@/components/utilization/utilizationUtils';

export default function EmployeeDetailModal({
  employee,
  open,
  onOpenChange,
  period = 'week',
  allTimeLogs: externalTimeLogs,
  allProjects: externalProjects,
}) {
  // Hooks must always be called (rules of hooks), but we prefer parent data when provided.
  // Always call hooks unconditionally; use external data when available (avoids double fetching)
  const { data: ownTimeLogs = [] } = useEntityList(externalTimeLogs ? null : 'TaskTimeLog');
  const { data: ownProjects = [] } = useEntityList(externalProjects ? null : 'Project');

  const allTimeLogs = externalTimeLogs ?? ownTimeLogs;
  const projects = externalProjects ?? ownProjects;

  // ─── All logs for this employee ───────────────────────────────────────────
  const timeLogs = useMemo(() =>
    employee?.user_id ? allTimeLogs.filter(l => l.user_id === employee.user_id) : [],
  [allTimeLogs, employee?.user_id]);

  // ─── Current period logs ──────────────────────────────────────────────────
  const periodBounds = useMemo(() => getPeriodBounds(period), [period]);

  const currentPeriodLogs = useMemo(() => {
    const { start, end } = periodBounds;
    return timeLogs.filter(l => {
      const raw = l.end_time || l.start_time || l.created_date;
      const d = new Date(fixTimestamp(raw));
      return d >= start && d <= end;
    });
  }, [timeLogs, periodBounds]);

  const currentActualSeconds = useMemo(
    () => currentPeriodLogs.reduce((s, l) => s + logSeconds(l), 0),
    [currentPeriodLogs],
  );

  const totalAllTime = useMemo(
    () => timeLogs.reduce((s, l) => s + logSeconds(l), 0),
    [timeLogs],
  );

  // ─── Historical trend chart ───────────────────────────────────────────────
  const chartData = useMemo(() => {
    const buckets = buildPeriodBuckets(period, period === 'day' ? 7 : 5);
    return buckets.map(b => {
      const logsInBucket = timeLogs.filter(l => {
        const raw = l.end_time || l.start_time || l.created_date;
        const d = new Date(fixTimestamp(raw));
        return d >= b.start && d <= b.end;
      });
      const actual = logsInBucket.reduce((s, l) => s + logSeconds(l), 0);
      return {
        period: b.label,
        actual: parseFloat((actual / 3600).toFixed(2)),
      };
    });
  }, [timeLogs, period]);

  // ─── Projects breakdown ───────────────────────────────────────────────────
  const projectsList = useMemo(() => {
    const byProject = {};
    timeLogs.forEach(log => {
      const pid = log.project_id;
      if (!pid) return;
      if (!byProject[pid]) {
        const proj = projects.find(p => p.id === pid);
        byProject[pid] = {
          project_id: pid,
          title: proj?.title || proj?.property_address || `Project …${pid.slice(-6)}`,
          total: 0,
          periodTotal: 0,
          entries: 0,
        };
      }
      const secs = logSeconds(log);
      byProject[pid].total += secs;
      byProject[pid].entries += 1;

      // Also track current-period contribution
      const raw = log.end_time || log.start_time || log.created_date;
      const d = new Date(fixTimestamp(raw));
      if (d >= periodBounds.start && d <= periodBounds.end) {
        byProject[pid].periodTotal += secs;
      }
    });
    return Object.values(byProject).sort((a, b) => b.total - a.total).slice(0, 15);
  }, [timeLogs, projects, periodBounds]);

  // ─── Recent activity ──────────────────────────────────────────────────────
  const recentLogs = useMemo(
    () => [...timeLogs].sort((a, b) => new Date(fixTimestamp(b.start_time)) - new Date(fixTimestamp(a.start_time))).slice(0, 25),
    [timeLogs],
  );

  if (!employee) return null;

  const periodLabel = period === 'day' ? 'Today' : period === 'week' ? 'This Week' : 'This Month';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
              <span className="text-sm font-semibold text-primary">
                {(employee.user_name || '?').charAt(0).toUpperCase()}
              </span>
            </div>
            <div>
              <p className="text-base font-semibold">{employee.user_name}</p>
              <p className="text-xs font-normal text-muted-foreground capitalize mt-0.5">
                {employee.role?.replace(/_/g, ' ')}
                {employee.team_name && <span className="ml-2">· {employee.team_name}</span>}
              </p>
            </div>
          </DialogTitle>
        </DialogHeader>

        {/* Quick stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">{periodLabel}</p>
            <p className="text-xl font-semibold text-primary">{fmtHoursMins(currentActualSeconds)}</p>
            {employee.estimated_seconds > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                of {fmtHoursMins(employee.estimated_seconds)} est.
              </p>
            )}
          </Card>
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">All Time</p>
            <p className="text-xl font-semibold">{fmtHoursMins(totalAllTime)}</p>
          </Card>
          <Card className="p-3 text-center">
            <p className="text-xs text-muted-foreground">Log Entries</p>
            <p className="text-xl font-semibold">{timeLogs.length}</p>
            {currentPeriodLogs.length > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {currentPeriodLogs.length} this period
              </p>
            )}
          </Card>
        </div>

        {/* Utilization bar if estimated > 0 */}
        {employee.estimated_seconds > 0 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>Utilization</span>
              <span className="font-medium">{employee.utilization_percent}%</span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={cn(
                  'h-2 rounded-full transition-all',
                  employee.utilization_percent > 120
                    ? 'bg-orange-500'
                    : employee.utilization_percent > 80
                    ? 'bg-green-500'
                    : 'bg-blue-400',
                )}
                style={{ width: `${Math.min(employee.utilization_percent, 100)}%` }}
              />
            </div>
          </div>
        )}

        <Tabs defaultValue="activity" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="projects">Projects ({projectsList.length})</TabsTrigger>
            <TabsTrigger value="trend">Trend</TabsTrigger>
          </TabsList>

          {/* ── Activity Tab ─────────────────────────────────────────── */}
          <TabsContent value="activity" className="space-y-2 mt-4">
            {recentLogs.length > 0 ? (
              recentLogs.map(log => {
                const secs = logSeconds(log);
                const isRunning = log.is_active && log.status === 'running';
                const isPaused = log.status === 'paused';
                return (
                  <Card
                    key={log.id}
                    className={cn(
                      'p-3 flex items-center gap-3',
                      isRunning && 'border-emerald-300 bg-emerald-50',
                      isPaused && 'border-amber-200 bg-amber-50',
                    )}
                  >
                    <Clock className={cn(
                      'h-4 w-4 flex-shrink-0',
                      isRunning ? 'text-emerald-500 animate-pulse' : 'text-muted-foreground',
                    )} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-muted-foreground">
                        {fmtTimestampCustom(log.start_time, { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false })}
                        {isRunning && <span className="ml-2 text-emerald-600 font-medium">● Running</span>}
                        {isPaused && <span className="ml-2 text-amber-600 font-medium">⏸ Paused</span>}
                      </p>
                      <p className="text-xs text-muted-foreground capitalize">
                        {log.role?.replace(/_/g, ' ')}
                      </p>
                    </div>
                    <p className={cn(
                      'text-sm font-bold flex-shrink-0',
                      isRunning ? 'text-emerald-600' : '',
                    )}>
                      {fmtHoursMins(secs)}
                    </p>
                  </Card>
                );
              })
            ) : (
              <Card className="p-8 text-center">
                <p className="text-sm text-muted-foreground">No time logs found for this employee</p>
              </Card>
            )}
          </TabsContent>

          {/* ── Projects Tab ─────────────────────────────────────────── */}
          <TabsContent value="projects" className="space-y-2 mt-4">
            {projectsList.length > 0 ? (
              projectsList.map(p => (
                <Card key={p.project_id} className="p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.title}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {p.entries} {p.entries === 1 ? 'entry' : 'entries'}
                        {p.periodTotal > 0 && (
                          <span className="ml-2 text-primary font-medium">
                            {fmtHoursMins(p.periodTotal)} this period
                          </span>
                        )}
                      </p>
                    </div>
                    <p className="text-sm font-bold text-blue-600 ml-2 flex-shrink-0">
                      {fmtHoursMins(p.total)}
                    </p>
                  </div>
                </Card>
              ))
            ) : (
              <Card className="p-8 text-center">
                <p className="text-sm text-muted-foreground">No project time logs found</p>
              </Card>
            )}
          </TabsContent>

          {/* ── Trend Tab ────────────────────────────────────────────── */}
          <TabsContent value="trend" className="mt-4">
            <Card className="p-4">
              <p className="text-sm font-semibold mb-3">Hours Logged per Period</p>
              {chartData.some(d => d.actual > 0) ? (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="period" tick={{ fontSize: 11 }} />
                    <YAxis
                      label={{ value: 'Hours', angle: -90, position: 'insideLeft', style: { fontSize: 11 } }}
                      tickFormatter={v => `${v}h`}
                    />
                    <Tooltip formatter={v => [`${v}h`, 'Actual']} />
                    <Bar dataKey="actual" fill="#3b82f6" name="Actual (h)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <p className="text-sm text-muted-foreground text-center py-12">No trend data available yet</p>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
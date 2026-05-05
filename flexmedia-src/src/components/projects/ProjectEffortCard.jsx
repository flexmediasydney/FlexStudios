import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { HoverCard, HoverCardTrigger, HoverCardContent } from '@/components/ui/hover-card';
import { Clock, Timer, Users, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useProjectEffortSummary } from './ProjectEffortSummaryV2';

function formatTime(seconds) {
  const s = Math.max(0, typeof seconds === 'number' ? seconds : 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function getProgressColor(pct) {
  if (pct <= 80) return 'green';
  if (pct <= 100) return 'amber';
  return 'red';
}

const BAR_CLASSES = { green: 'bg-green-500', amber: 'bg-amber-500', red: 'bg-red-500' };
const TEXT_CLASSES = { green: 'text-green-600 dark:text-green-400', amber: 'text-amber-600 dark:text-amber-400', red: 'text-red-600 dark:text-red-400' };

function ProjectEffortCard({ projectId, project, onNavigateToEffort }) {
  const data = useProjectEffortSummary(projectId, project);

  if (!projectId) return null;

  const hasData = data.totalEstimated > 0 || data.totalActual > 0;
  const utilPct = data.totalUtilization;
  const color = hasData ? getProgressColor(utilPct) : 'green';
  const variance = data.totalEstimated > 0 ? data.totalActual - data.totalEstimated : 0;
  const runningCount = data.runningTimers?.length || 0;

  const handleClick = () => {
    if (onNavigateToEffort) onNavigateToEffort();
  };

  // Combined role list from tasks + revisions for the popover
  const allRoles = {};
  [...(data.taskRoleList || []), ...(data.revisionRoleList || [])].forEach(r => {
    if (!allRoles[r.role]) {
      allRoles[r.role] = { role: r.role, name: r.name, estimated: 0, actual: 0 };
    }
    allRoles[r.role].estimated += r.estimated;
    allRoles[r.role].actual += r.actual;
  });
  const combinedRoles = Object.values(allRoles)
    .filter(r => r.estimated > 0 || r.actual > 0)
    .sort((a, b) => b.actual - a.actual);

  return (
    <HoverCard openDelay={300} closeDelay={200}>
      <HoverCardTrigger asChild>
        <Card
          className="cursor-pointer hover:shadow-md transition-all duration-200 hover:border-primary/20"
          onClick={handleClick}
          title="Click to view detailed effort breakdown"
        >
          <CardContent className="py-4 px-4">
            {/* Header */}
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-amber-100 dark:bg-amber-900/40">
                <Zap className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              </div>
              <p className="text-sm font-semibold">Project Effort</p>
              {data.hasRunning && (
                <span className="ml-auto flex items-center gap-1 text-xs text-green-600 dark:text-green-400 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                  {runningCount} active
                </span>
              )}
            </div>

            {!hasData && (
              <p className="text-xs text-muted-foreground py-2 text-center">No effort tracked yet</p>
            )}

            {hasData && (
              <>
                {/* Stats row */}
                <div className="grid grid-cols-3 gap-3 mb-3">
                  <div className="text-center p-2 rounded-lg bg-muted/50">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Estimated</p>
                    <p className="text-sm font-bold tabular-nums">
                      {data.totalEstimated > 0 ? formatTime(data.totalEstimated) : '--'}
                    </p>
                  </div>
                  <div className="text-center p-2 rounded-lg bg-muted/50">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Actual</p>
                    <p className="text-sm font-bold tabular-nums">{formatTime(data.totalActual)}</p>
                  </div>
                  <div className={cn(
                    'text-center p-2 rounded-lg',
                    color === 'green' ? 'bg-green-50 dark:bg-green-950/30' : color === 'amber' ? 'bg-amber-50 dark:bg-amber-950/30' : 'bg-red-50 dark:bg-red-950/30'
                  )}>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-1">Progress</p>
                    <p className={cn('text-sm font-bold tabular-nums', TEXT_CLASSES[color])}>
                      {data.totalEstimated > 0 ? `${utilPct}%` : '--'}
                    </p>
                  </div>
                </div>

                {/* Progress bar */}
                {data.totalEstimated > 0 && (
                  <div>
                    <div className="relative h-2 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn('h-full rounded-full transition-all duration-500', BAR_CLASSES[color])}
                        style={{ width: `${Math.min(utilPct, 100)}%` }}
                      />
                    </div>
                    {variance !== 0 && (
                      <p className={cn('text-xs mt-1.5', variance > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400')}>
                        {variance > 0 ? '+' : ''}{formatTime(Math.abs(variance))} {variance > 0 ? 'over' : 'under'} estimate
                      </p>
                    )}
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </HoverCardTrigger>

      {/* Detailed breakdown popover on hover */}
      {(combinedRoles.length > 0 || (data.perTaskBreakdown?.length > 0) || runningCount > 0) && (
        <HoverCardContent side="left" align="start" className="w-80 max-h-[28rem] overflow-y-auto p-0">
          <div className="p-4 space-y-4">
            {/* Active timers */}
            {runningCount > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Timer className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-green-700 dark:text-green-300">
                    Active Timers ({runningCount})
                  </h4>
                </div>
                <div className="space-y-1.5">
                  {data.runningTimers.map(timer => (
                    <div key={timer.id} className="flex items-center justify-between text-xs bg-green-50 dark:bg-green-950/30 rounded px-2 py-1.5">
                      <span className="font-medium truncate mr-2">{timer.taskTitle}</span>
                      <span className="text-green-700 dark:text-green-300 font-bold tabular-nums whitespace-nowrap flex items-center gap-1">
                        <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
                        {formatTime(timer.elapsed)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-role breakdown */}
            {combinedRoles.length > 0 && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Users className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By Role</h4>
                </div>
                <div className="space-y-2">
                  {combinedRoles.map(role => {
                    const pct = role.estimated > 0 ? Math.min(Math.round((role.actual / role.estimated) * 100), 999) : 0;
                    const c = role.estimated > 0 ? getProgressColor(pct) : 'green';
                    return (
                      <div key={role.role} className="text-xs">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className="font-medium">{role.name}</span>
                          <span className="text-muted-foreground">
                            {formatTime(role.actual)}
                            {role.estimated > 0 && <> / {formatTime(role.estimated)}</>}
                            {role.estimated > 0 && (
                              <span className={cn('ml-1 font-bold', TEXT_CLASSES[c])}>{pct}%</span>
                            )}
                          </span>
                        </div>
                        {role.estimated > 0 && (
                          <div className="h-1 w-full rounded-full bg-muted">
                            <div
                              className={cn('h-1 rounded-full transition-all', BAR_CLASSES[c])}
                              style={{ width: `${Math.min(pct, 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Tasks + Revisions split */}
            {(data.task.actualTotal > 0 || data.revision.actualTotal > 0) && (
              <div>
                <div className="flex items-center gap-1.5 mb-2">
                  <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Split</h4>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md bg-muted/50 p-2">
                    <p className="text-muted-foreground mb-0.5">Tasks</p>
                    <p className="font-bold">{formatTime(data.task.actualTotal)}</p>
                    {data.task.estimatedTotal > 0 && (
                      <p className="text-muted-foreground">of {formatTime(data.task.estimatedTotal)}</p>
                    )}
                  </div>
                  <div className="rounded-md bg-muted/50 p-2">
                    <p className="text-muted-foreground mb-0.5">Requests</p>
                    <p className="font-bold">{formatTime(data.revision.actualTotal)}</p>
                    {data.revision.estimatedTotal > 0 && (
                      <p className="text-muted-foreground">of {formatTime(data.revision.estimatedTotal)}</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Per-task breakdown */}
            {data.perTaskBreakdown?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">By Task</h4>
                <div className="space-y-1.5 max-h-40 overflow-y-auto">
                  {data.perTaskBreakdown.map(task => {
                    const pct = task.estimated > 0 ? Math.min(Math.round((task.actual / task.estimated) * 100), 999) : 0;
                    const c = task.estimated > 0 ? getProgressColor(pct) : 'green';
                    return (
                      <div key={task.id} className="text-xs">
                        <div className="flex items-center justify-between">
                          <span className="truncate mr-2 font-medium">{task.title}</span>
                          <span className="whitespace-nowrap text-muted-foreground">
                            {formatTime(task.actual)}
                            {task.estimated > 0 && <> / {formatTime(task.estimated)}</>}
                            {task.estimated > 0 && (
                              <span className={cn('ml-1 font-bold', TEXT_CLASSES[c])}>{pct}%</span>
                            )}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </HoverCardContent>
      )}
    </HoverCard>
  );
}

export default React.memo(ProjectEffortCard);

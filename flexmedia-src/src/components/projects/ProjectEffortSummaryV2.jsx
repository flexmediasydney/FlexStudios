import React, { useState, useEffect, useMemo } from 'react';
import { Card } from '@/components/ui/card';
import { Zap, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/api/supabaseClient';

const ROLE_LABELS = {
  photographer: 'Photographer',
  videographer: 'Videographer',
  image_editor: 'Image Editor',
  video_editor: 'Video Editor',
  floorplan_editor: 'Floorplan Editor',
  drone_editor: 'Drone Editor',
};

function formatTime(seconds) {
  const s = Math.max(0, typeof seconds === 'number' ? seconds : 0);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function computeLogSeconds(log) {
  if (!log) return 0;
  if (log.status === 'completed' || !log.is_active) return Math.max(0, log.total_seconds || 0);
  if (log.status === 'paused') return Math.max(0, log.total_seconds || 0);
  if (log.status === 'running' && log.start_time) {
    return Math.max(0, Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000) - (log.paused_duration || 0));
  }
  return Math.max(0, log.total_seconds || 0);
}

function useProjectEffortData(projectId, project = null) {
   const [timeLogs, setTimeLogs] = useState([]);
   const [projectTasks, setProjectTasks] = useState([]);
   const [projectRevisions, setProjectRevisions] = useState([]);

  // Fetch time logs with retry
  useEffect(() => {
    if (!projectId) return;
    let mounted = true;
    let retries = 0;

    const fetchTimeLogs = async () => {
      try {
        const items = await api.entities.TaskTimeLog.filter({ project_id: projectId });
        if (mounted) setTimeLogs(items);
      } catch (err) {
        if (retries < 2 && err.message?.includes('Rate limit')) {
          retries++;
          setTimeout(fetchTimeLogs, 2000);
        }
      }
    };

    fetchTimeLogs();
    const unsub = api.entities.TaskTimeLog.subscribe(ev => {
      if (!mounted) return;
      if (ev.type === 'create' && ev.data?.project_id === projectId) {
        setTimeLogs(prev => [...prev, ev.data]);
      } else if (ev.type === 'update') {
        setTimeLogs(prev => prev.map(l => l.id === ev.id ? ev.data : l));
      } else if (ev.type === 'delete') {
        setTimeLogs(prev => prev.filter(l => l.id !== ev.id));
      }
    });
    return () => { mounted = false; unsub(); };
  }, [projectId]);

  // Fetch project tasks with retry (re-fetches when products change)
   useEffect(() => {
     if (!projectId) return;
     let mounted = true;
     let retries = 0;

     const fetchTasks = async () => {
       try {
         const items = await api.entities.ProjectTask.filter({ project_id: projectId });
         if (mounted) setProjectTasks(items.filter(t => !t.is_deleted));
       } catch (err) {
         if (retries < 2 && err.message?.includes('Rate limit')) {
           retries++;
           setTimeout(fetchTasks, 2000);
         }
       }
     };

     fetchTasks(); // initial load + fires again if products/packages change via dep below
     const unsub = api.entities.ProjectTask.subscribe(ev => {
       if (!mounted) return;
       if (ev.type === 'create' && ev.data?.project_id === projectId && !ev.data?.is_deleted) {
         setProjectTasks(prev => [...prev, ev.data]);
       } else if (ev.type === 'update') {
         setProjectTasks(prev => {
           const filtered = prev.filter(t => t.id !== ev.id);
           if (!ev.data?.is_deleted && ev.data?.project_id === projectId) return [...filtered, ev.data];
           return filtered;
         });
       } else if (ev.type === 'delete') {
         setProjectTasks(prev => prev.filter(t => t.id !== ev.id));
       }
     });
     return () => { mounted = false; unsub(); };
   }, [projectId, JSON.stringify(
     (project?.products || []).map(p => p.product_id + ':' + (p.quantity || 1)).sort().join(',') +
     (project?.packages || []).map(p => p.package_id).sort().join(',')
   )]);

  // Fetch revisions with retry
  useEffect(() => {
    if (!projectId) return;
    let mounted = true;
    let retries = 0;

    const fetchRevisions = async () => {
      try {
        const items = await api.entities.ProjectRevision.filter({ project_id: projectId });
        if (mounted) setProjectRevisions(items);
      } catch (err) {
        if (retries < 2 && err.message?.includes('Rate limit')) {
          retries++;
          setTimeout(fetchRevisions, 2000);
        }
      }
    };

    fetchRevisions();
    const unsub = api.entities.ProjectRevision.subscribe(ev => {
      if (!mounted) return;
      if (ev.type === 'create' && ev.data?.project_id === projectId) {
        setProjectRevisions(prev => [...prev, ev.data]);
      } else if (ev.type === 'update') {
        setProjectRevisions(prev => prev.map(r => r.id === ev.id ? ev.data : r));
      } else if (ev.type === 'delete') {
        setProjectRevisions(prev => prev.filter(r => r.id !== ev.id));
      }
    });
    return () => { mounted = false; unsub(); };
  }, [projectId]);

  return { timeLogs, projectTasks, projectRevisions };
}

function calculateEffortMetrics(timeLogs, projectTasks, projectRevisions) {
  // Build set of revision task IDs
  const revisionTaskIds = new Set();
  projectRevisions.forEach(revision => {
    if (revision.status === 'completed' || revision.status === 'rejected') return;
    projectTasks.forEach(task => {
      if (task.title?.startsWith(`[Revision #${revision.revision_number}]`)) {
        revisionTaskIds.add(task.id);
      }
    });
  });

  // Calculate estimated effort by role for tasks
   const taskEstByRole = {};
   projectTasks.forEach(task => {
     if (task.is_deleted) return;                   // Filter out deleted tasks
     if (revisionTaskIds.has(task.id)) return;
     if (!task.auto_assign_role || task.auto_assign_role === 'none') return;
     const mins = typeof task.estimated_minutes === 'number' ? task.estimated_minutes : 0;
     if (mins > 0) {
       taskEstByRole[task.auto_assign_role] = (taskEstByRole[task.auto_assign_role] || 0) + mins * 60;
     }
   });

  // Calculate estimated effort by role for revisions
   const revisionEstByRole = {};
   projectTasks.forEach(task => {
     if (task.is_deleted) return;                   // Filter out deleted tasks
     if (!revisionTaskIds.has(task.id)) return;
     if (!task.auto_assign_role || task.auto_assign_role === 'none') return;
     const mins = typeof task.estimated_minutes === 'number' ? task.estimated_minutes : 0;
     if (mins > 0) {
       revisionEstByRole[task.auto_assign_role] = (revisionEstByRole[task.auto_assign_role] || 0) + mins * 60;
     }
   });

  // Calculate actual effort by role for tasks vs revisions
  const taskActByRole = {};
  const revisionActByRole = {};
  timeLogs.filter(log => !log.task_deleted).forEach(log => {
    const role = log.role || 'admin';
    const seconds = computeLogSeconds(log);
    if (revisionTaskIds.has(log.task_id)) {
      revisionActByRole[role] = (revisionActByRole[role] || 0) + seconds;
    } else {
      taskActByRole[role] = (taskActByRole[role] || 0) + seconds;
    }
  });

  const taskEstTotal = Object.values(taskEstByRole).reduce((a, b) => a + b, 0);
  const taskActTotal = Object.values(taskActByRole).reduce((a, b) => a + b, 0);
  const revisionEstTotal = Object.values(revisionEstByRole).reduce((a, b) => a + b, 0);
  const revisionActTotal = Object.values(revisionActByRole).reduce((a, b) => a + b, 0);

  return {
    task: {
      estimatedByRole: taskEstByRole,
      estimatedTotal: taskEstTotal,
      actualByRole: taskActByRole,
      actualTotal: taskActTotal,
      utilization: taskEstTotal > 0 ? Math.min(Math.round((taskActTotal / taskEstTotal) * 100), 999) : 0,
    },
    revision: {
      estimatedByRole: revisionEstByRole,
      estimatedTotal: revisionEstTotal,
      actualByRole: revisionActByRole,
      actualTotal: revisionActTotal,
      utilization: revisionEstTotal > 0 ? Math.min(Math.round((revisionActTotal / revisionEstTotal) * 100), 999) : 0,
    },
  };
}

function buildRoleList(actualByRole, estimatedByRole) {
  const allRoles = new Set([...Object.keys(actualByRole), ...Object.keys(estimatedByRole)]);
  return Array.from(allRoles)
    .map(role => {
      const actual = actualByRole[role] || 0;
      const estimated = estimatedByRole[role] || 0;
      return {
        role,
        name: ROLE_LABELS[role] || role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        actual,
        estimated,
        utilization: estimated > 0 ? Math.min(Math.round((actual / estimated) * 100), 999) : 0,
      };
    })
    .filter(r => r.actual > 0 || r.estimated > 0)
    .sort((a, b) => b.actual - a.actual);
}

export function useProjectEffortSummary(projectId, project = null) {
   const [tick, setTick] = useState(0);
   const { timeLogs, projectTasks, projectRevisions } = useProjectEffortData(projectId, project);

  // Calculate running timers to trigger re-render
  useEffect(() => {
    const hasRunning = timeLogs.some(l => l.is_active && l.status === 'running');
    if (!hasRunning) return;
    const id = setInterval(() => setTick(t => t + 1), 1000);
    return () => clearInterval(id);
  }, [timeLogs]);

  // Include `tick` in deps so that running-timer live seconds (computed via Date.now()
  // inside computeLogSeconds) are recalculated every second instead of returning stale
  // memoized values until the next real subscription event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const metrics = useMemo(() => calculateEffortMetrics(timeLogs, projectTasks, projectRevisions), [timeLogs, projectTasks, projectRevisions, tick]);

  const taskRoleList = useMemo(() => buildRoleList(metrics.task.actualByRole, metrics.task.estimatedByRole), [metrics]);
  const revisionRoleList = useMemo(() => buildRoleList(metrics.revision.actualByRole, metrics.revision.estimatedByRole), [metrics]);

  const hasRunning = timeLogs.some(l => l.is_active && l.status === 'running');
  const totalEst = metrics.task.estimatedTotal + metrics.revision.estimatedTotal;
  const totalAct = metrics.task.actualTotal + metrics.revision.actualTotal;

  return {
    task: metrics.task,
    revision: metrics.revision,
    taskRoleList,
    revisionRoleList,
    totalEstimated: totalEst,
    totalActual: totalAct,
    totalUtilization: totalEst > 0 ? Math.min(Math.round((totalAct / totalEst) * 100), 999) : 0,
    hasRunning,
  };
}

export default function ProjectEffortSummaryV2({ projectId, project = null }) {
   const [showBreakdown, setShowBreakdown] = useState(false);
   const data = useProjectEffortSummary(projectId, project);

  if (!projectId) {
    return null;
  }

  // Show card even with no data
  const hasData = data.task.estimatedTotal > 0 || data.revision.estimatedTotal > 0;

  return (
    <Card
      className="p-4 cursor-pointer hover:shadow-md transition-shadow relative"
      onMouseEnter={() => setShowBreakdown(true)}
      onMouseLeave={() => setShowBreakdown(false)}
    >
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-amber-500" />
          <p className="text-xs text-muted-foreground font-medium">Project Effort</p>
          {data.hasRunning && (
            <span className="ml-auto flex items-center gap-1 text-xs text-green-600 font-medium">
              <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          )}
        </div>

        {!hasData && (
          <p className="text-xs text-muted-foreground py-4 text-center">No effort tracked yet</p>
        )}

        {/* Total */}
        {data.totalEstimated > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Total</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Actual</p>
                <p className="text-sm font-bold">{formatTime(data.totalActual)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Estimated</p>
                <p className="text-sm font-bold">{formatTime(data.totalEstimated)}</p>
              </div>
            </div>
            <div className="pt-1.5 border-t">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-muted-foreground">Util</p>
                <p className={cn('text-xs font-bold', data.totalUtilization >= 100 ? 'text-orange-600' : 'text-green-600')}>
                  {data.totalUtilization}%
                </p>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className={cn('h-1.5 rounded-full transition-all', data.totalUtilization >= 100 ? 'bg-orange-500' : 'bg-green-500')}
                  style={{ width: `${Math.min(data.totalUtilization, 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Tasks */}
        {data.task.estimatedTotal > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground">Tasks</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Actual</p>
                <p className="text-sm font-bold">{formatTime(data.task.actualTotal)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Estimated</p>
                <p className="text-sm font-bold">{formatTime(data.task.estimatedTotal)}</p>
              </div>
            </div>
            <div className="pt-1.5 border-t">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-muted-foreground">Util</p>
                <p className={cn('text-xs font-bold', data.task.utilization >= 100 ? 'text-orange-600' : 'text-green-600')}>
                  {data.task.utilization}%
                </p>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className={cn('h-1.5 rounded-full transition-all', data.task.utilization >= 100 ? 'bg-orange-500' : 'bg-green-500')}
                  style={{ width: `${Math.min(data.task.utilization, 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Requests */}
        {data.revision.estimatedTotal > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <p className="text-xs font-medium text-muted-foreground">Requests</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs text-muted-foreground mb-1">Actual</p>
                <p className="text-sm font-bold">{formatTime(data.revision.actualTotal)}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-1">Estimated</p>
                <p className="text-sm font-bold">{formatTime(data.revision.estimatedTotal)}</p>
              </div>
            </div>
            <div className="pt-1.5 border-t">
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs font-medium text-muted-foreground">Util</p>
                <p className={cn('text-xs font-bold', data.revision.utilization >= 100 ? 'text-orange-600' : 'text-green-600')}>
                  {data.revision.utilization}%
                </p>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-1.5">
                <div
                  className={cn('h-1.5 rounded-full transition-all', data.revision.utilization >= 100 ? 'bg-orange-500' : 'bg-green-500')}
                  style={{ width: `${Math.min(data.revision.utilization, 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}

        {/* Role count */}
        {(data.taskRoleList.length > 0 || data.revisionRoleList.length > 0) && (
          <div className="pt-2 border-t">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Users className="h-3 w-3" />
              <span>{(new Set([...data.taskRoleList.map(r => r.role), ...data.revisionRoleList.map(r => r.role)])).size} role{(new Set([...data.taskRoleList.map(r => r.role), ...data.revisionRoleList.map(r => r.role)])).size !== 1 ? 's' : ''}</span>
            </div>
          </div>
        )}
      </div>

      {/* Breakdown Tooltip */}
      {showBreakdown && (data.taskRoleList.length > 0 || data.revisionRoleList.length > 0) && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-card border rounded-lg shadow-lg p-4 z-20 max-h-96 overflow-y-auto">
          {data.taskRoleList.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold mb-3">Tasks - By Role</h3>
              <div className="space-y-2">
                {data.taskRoleList.map(role => (
                  <div key={`task-${role.role}`} className="text-xs border-b pb-2 last:border-b-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-medium text-sm">{role.name}</p>
                      {role.estimated > 0 && (
                        <p className={cn('font-bold text-xs', role.utilization >= 100 ? 'text-orange-600' : 'text-green-600')}>
                          {role.utilization}%
                        </p>
                      )}
                    </div>
                    <div className="flex gap-3 text-muted-foreground text-xs">
                      <span>Act: {formatTime(role.actual)}</span>
                      {role.estimated > 0 && <span>Est: {formatTime(role.estimated)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.revisionRoleList.length > 0 && (
            <div className={data.taskRoleList.length > 0 ? 'border-t pt-3 mt-3' : ''}>
              <h3 className="text-sm font-semibold mb-3">Requests - By Role</h3>
              <div className="space-y-2">
                {data.revisionRoleList.map(role => (
                  <div key={`rev-${role.role}`} className="text-xs border-b pb-2 last:border-b-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-medium text-sm">{role.name}</p>
                      {role.estimated > 0 && (
                        <p className={cn('font-bold text-xs', role.utilization >= 100 ? 'text-orange-600' : 'text-green-600')}>
                          {role.utilization}%
                        </p>
                      )}
                    </div>
                    <div className="flex gap-3 text-muted-foreground text-xs">
                      <span>Act: {formatTime(role.actual)}</span>
                      {role.estimated > 0 && <span>Est: {formatTime(role.estimated)}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
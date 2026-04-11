import { useState, useEffect, useMemo } from "react";
import { Zap } from "lucide-react";

function computeLogSeconds(log) {
  if (!log) return 0;
  if (log.status === "completed" || !log.is_active) return Math.max(0, log.total_seconds || 0);
  if (log.status === "paused") return Math.max(0, log.total_seconds || 0);
  if (log.status === "running" && log.start_time) {
    return Math.max(
      0,
      Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000) -
        (log.paused_duration || 0)
    );
  }
  return Math.max(0, log.total_seconds || 0);
}

function formatTime(seconds) {
  const s = Math.max(0, seconds || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h === 0 && m === 0) return "0m";
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Renders actual/estimated effort for use inside a project card field.
 * timeLogs must be pre-filtered by projectId and passed from the parent
 * to avoid N×1 subscription blowups across many project cards.
 */
export default function ProjectCardEffort({ projectId, tasks = [], timeLogs = [], revisions = [] }) {
   const [tick, setTick] = useState(0);

   const hasRunning = timeLogs.some(l => l.is_active && l.status === "running");

   useEffect(() => {
     if (!hasRunning) return;
     const id = setInterval(() => setTick(t => t + 1), 1000);
     return () => clearInterval(id);
   }, [hasRunning]);

   // eslint-disable-next-line no-unused-vars
   const _tick = tick;

   const actualSeconds = useMemo(
     () => timeLogs.reduce((sum, log) => sum + computeLogSeconds(log), 0),
     // eslint-disable-next-line react-hooks/exhaustive-deps
     [timeLogs, tick]
   );

   const estimatedSeconds = useMemo(() => {
     return tasks.reduce((sum, task) => {
       const role = task.auto_assign_role;
       if (!role || role === "none") return sum;
       const mins = typeof task.estimated_minutes === "number" ? task.estimated_minutes : 0;
       return sum + mins * 60;
     }, 0);
   }, [tasks]);

   // Revision effort tracking: actual from revision tasks, estimated from template
   const revisionActualSeconds = useMemo(() => {
     return revisions.reduce((sum, rev) => {
       const revisionTasks = tasks.filter(t => t.title?.startsWith(`[Revision #${rev.revision_number}]`));
       return sum + revisionTasks.reduce((taskSum, task) => {
         const revisionLogs = timeLogs.filter(l => l.task_id === task.id);
         return taskSum + revisionLogs.reduce((logSum, log) => logSum + computeLogSeconds(log), 0);
       }, 0);
     }, 0);
   }, [revisions, tasks, timeLogs]);

   const revisionEstimatedSeconds = useMemo(() => {
     return revisions.reduce((sum, rev) => {
       const template = rev.template_id ? tasks.filter(t => t.title?.startsWith(`[Revision #${rev.revision_number}]`)) : [];
       const estimatedMins = template.reduce((tSum, task) => {
         const mins = typeof task.estimated_minutes === "number" ? task.estimated_minutes : 0;
         return tSum + (task.auto_assign_role && task.auto_assign_role !== "none" ? mins : 0);
       }, 0);
       return sum + estimatedMins * 60;
     }, 0);
   }, [revisions, tasks]);

   if (actualSeconds === 0 && estimatedSeconds === 0 && revisionActualSeconds === 0 && revisionEstimatedSeconds === 0) return null;

   return (
     <div className="space-y-1.5">
       {/* Core Task Effort */}
       {(actualSeconds > 0 || estimatedSeconds > 0) && (
         <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
           <Zap className="h-3.5 w-3.5 flex-shrink-0 text-amber-500" />
           <span className="font-medium text-foreground tabular-nums">{formatTime(actualSeconds)}</span>
           {estimatedSeconds > 0 && (
             <span className="text-muted-foreground tabular-nums">/ {formatTime(estimatedSeconds)}</span>
           )}
           {hasRunning && (
             <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse flex-shrink-0" />
           )}
         </div>
       )}

       {/* Revision Effort */}
       {(revisionActualSeconds > 0 || revisionEstimatedSeconds > 0) && (
         <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
           <Zap className="h-3.5 w-3.5 flex-shrink-0 text-violet-500" />
           <span className="text-xs text-muted-foreground">Revisions:</span>
           <span className="font-medium text-foreground tabular-nums">{formatTime(revisionActualSeconds)}</span>
           {revisionEstimatedSeconds > 0 && (
             <span className="text-muted-foreground tabular-nums">/ {formatTime(revisionEstimatedSeconds)}</span>
           )}
         </div>
       )}
     </div>
   );
}
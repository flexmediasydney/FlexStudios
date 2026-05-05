import { useState, useEffect, useMemo, useCallback } from "react";
import { Zap } from "lucide-react";
import { useVisibleInterval } from "@/components/hooks/useVisibleInterval";

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

   // Belt-and-braces: parent groups timeLogs by `l.project_id`, but a few
   // historical logs were created without `project_id` set (only `task_id`).
   // Those rows were getting dropped from the parent map and the card showed
   // "0m / 5h" — actual side empty even though Timer entries existed for the
   // project's tasks. Re-include them here by matching on task_id ∈ tasks
   // so the actual side reflects every log linked to this project's work.
   const projectLogs = useMemo(() => {
     const taskIds = new Set(tasks.map(t => t.id));
     return timeLogs.filter(l =>
       l.project_id === projectId || (l.task_id && taskIds.has(l.task_id))
     );
   }, [timeLogs, tasks, projectId]);

   const hasRunning = projectLogs.some(l => l.is_active && l.status === "running");

   const onTick = useCallback(() => setTick(t => t + 1), []);
   useVisibleInterval(onTick, 1000, { enabled: hasRunning });

   // eslint-disable-next-line no-unused-vars
   const _tick = tick;

   const actualSeconds = useMemo(
     () => projectLogs.reduce((sum, log) => sum + computeLogSeconds(log), 0),
     // eslint-disable-next-line react-hooks/exhaustive-deps
     [projectLogs, tick]
   );

   const estimatedSeconds = useMemo(() => {
     return tasks.reduce((sum, task) => {
       // Exclude deleted/archived (match ProjectDetails EffortLoggingTab filter)
       if (task.is_deleted || task.is_archived) return sum;
       // Exclude revision tasks — counted separately below.
       // Use revision_id FK; fall back to title prefix for any unbackfilled rows.
       if (task.revision_id || /^\[Revision #\d+\]/.test(task.title || "")) return sum;
       const role = task.auto_assign_role;
       if (!role || role === "none") return sum;
       const mins = typeof task.estimated_minutes === "number" ? task.estimated_minutes : 0;
       return sum + mins * 60;
     }, 0);
   }, [tasks]);

   // Revision effort tracking: actual + estimated from revision tasks on the project
   const matchesRevision = (task, rev) => (
     task.revision_id === rev.id ||
     (!task.revision_id && task.title?.startsWith(`[Revision #${rev.revision_number}]`))
   );

   const revisionActualSeconds = useMemo(() => {
     return revisions.reduce((sum, rev) => {
       const revisionTasks = tasks.filter(t =>
         !t.is_deleted && !t.is_archived && matchesRevision(t, rev)
       );
       return sum + revisionTasks.reduce((taskSum, task) => {
         const revisionLogs = projectLogs.filter(l => l.task_id === task.id);
         return taskSum + revisionLogs.reduce((logSum, log) => logSum + computeLogSeconds(log), 0);
       }, 0);
     }, 0);
   }, [revisions, tasks, projectLogs]);

   const revisionEstimatedSeconds = useMemo(() => {
     return revisions.reduce((sum, rev) => {
       const revisionTasks = tasks.filter(t =>
         !t.is_deleted && !t.is_archived && matchesRevision(t, rev)
       );
       const estimatedMins = revisionTasks.reduce((tSum, task) => {
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
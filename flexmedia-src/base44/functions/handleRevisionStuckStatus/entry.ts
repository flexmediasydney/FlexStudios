import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { revision_id, is_stuck } = await req.json();

    if (!revision_id) {
      return Response.json({ error: 'Missing revision_id' }, { status: 400 });
    }

    const revision = await base44.entities.ProjectRevision.filter({ id: revision_id });
    if (!revision || revision.length === 0) {
      return Response.json({ error: 'Revision not found' }, { status: 404 });
    }

    const rev = revision[0];

    // Get all tasks for the revision
    const tasks = await base44.entities.ProjectTask.filter({ project_id: rev.project_id });
    const revisionTasks = tasks.filter(t =>
      t.revision_id === rev.id ||
      (!t.revision_id && t.title?.startsWith(`[Revision #${rev.revision_number}]`))
    );

    // Get all time logs for revision tasks
    const timeLogs = await base44.entities.TaskTimeLog.filter({ project_id: rev.project_id });
    const taskIds = new Set(revisionTasks.map(t => t.id));
    const relevantLogs = timeLogs.filter(log => taskIds.has(log.task_id));

    let stoppedCount = 0;

    if (is_stuck) {
      // Pause all active timers
      for (const log of relevantLogs) {
        if (log.status === 'running') {
          await base44.entities.TaskTimeLog.update(log.id, {
            status: 'paused',
            pause_time: new Date().toISOString(),
          });
          stoppedCount++;
        }
      }
    } else {
      // Resume paused timers by setting status back to 'running' (if they were paused by stuck)
      for (const log of relevantLogs) {
        if (log.status === 'paused' && log.pause_time) {
          // Calculate how long this timer was frozen in the stuck state
          const frozenDuration = Math.floor(
            (Date.now() - new Date(log.pause_time).getTime()) / 1000
          );
          await base44.entities.TaskTimeLog.update(log.id, {
            status: 'running',
            pause_time: null,
            paused_duration: (log.paused_duration || 0) + frozenDuration,
          });
          stoppedCount++;
        }
      }
    }

    return Response.json({ 
      status: is_stuck ? 'stuck' : 'resumed',
      timers_affected: stoppedCount 
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
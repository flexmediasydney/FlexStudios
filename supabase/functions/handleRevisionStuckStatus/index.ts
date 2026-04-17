import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('handleRevisionStuckStatus', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth check — callable by service-role (from other functions) or authenticated users
    const user = await getUserFromReq(req);
    if (!user) return errorResponse('Unauthorized', 401);

    const { revision_id, is_stuck } = await req.json();

    if (!revision_id) return errorResponse('Missing revision_id', 400);

    const revision = await entities.ProjectRevision.filter({ id: revision_id });
    if (!revision || revision.length === 0) return errorResponse('Revision not found', 404);

    const rev = revision[0];

    // Get all tasks for the revision
    const tasks = await entities.ProjectTask.filter({ project_id: rev.project_id });
    const revisionTasks = tasks.filter((t: any) => t.title?.startsWith(`[Revision #${rev.revision_number}]`));

    // Get all time logs for revision tasks
    const timeLogs = await entities.TaskTimeLog.filter({ project_id: rev.project_id });
    const taskIds = new Set(revisionTasks.map((t: any) => t.id));
    const relevantLogs = timeLogs.filter((log: any) => taskIds.has(log.task_id));

    let stoppedCount = 0;

    if (is_stuck) {
      // Pause all active timers
      for (const log of relevantLogs) {
        if (log.status === 'running') {
          await entities.TaskTimeLog.update(log.id, {
            status: 'paused',
            pause_time: new Date().toISOString(),
          });
          stoppedCount++;
        }
      }
    } else {
      // Resume paused timers
      for (const log of relevantLogs) {
        if (log.status === 'paused' && log.pause_time) {
          const frozenDuration = Math.floor(
            (Date.now() - new Date(log.pause_time).getTime()) / 1000
          );
          await entities.TaskTimeLog.update(log.id, {
            status: 'running',
            pause_time: null,
            paused_duration: (log.paused_duration || 0) + frozenDuration,
          });
          stoppedCount++;
        }
      }
    }

    return jsonResponse({
      status: is_stuck ? 'stuck' : 'resumed',
      timers_affected: stoppedCount,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

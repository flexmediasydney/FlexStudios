import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('updateTaskEffortRealtimeRobust', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // Auth: allow service-role (internal/cron calls) or authenticated users
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json();
    // Support create/update payloads (data), delete payloads (old_data), and direct calls
    const data = body.data || body.old_data || body;
    const taskId = data?.task_id;
    const projectId = data?.project_id;

    if (!taskId) {
      return jsonResponse({ success: true });
    }

    if (!projectId) {
      return jsonResponse({ success: true });
    }

    // Fetch task and logs in parallel
    const [taskArr, taskLogs] = await Promise.all([
      entities.ProjectTask.filter({ project_id: projectId }, null, 1000),
      entities.TaskTimeLog.filter({ task_id: taskId, status: 'completed' }, '-created_date', 500),
    ]);

    const task = taskArr.find((t: any) => t.id === taskId) || null;

    if (!task) {
      console.warn(`Task ${taskId} not found, skipping effort update`);
      return jsonResponse({ success: true });
    }

    // Filter: only count completed, non-active logs
    const validLogs = taskLogs.filter((log: any) =>
      !log.is_active &&
      typeof log.total_seconds === 'number' &&
      log.total_seconds >= 0 &&
      log.total_seconds < 86400 // max 24 hours per log
    );

    // Calculate total effort with safety checks
    let totalEffortSeconds = 0;
    for (const log of validLogs) {
      const seconds = Math.floor(log.total_seconds);
      if (seconds >= 0 && seconds < 86400) {
        totalEffortSeconds += seconds;
      }
    }

    // Prevent overflow (max 1000 hours per task)
    if (totalEffortSeconds > 3600000) {
      console.warn(`Task ${taskId} effort exceeds safety limit, clamping to 1000h`);
      totalEffortSeconds = 3600000;
    }

    // Update task with calculated total
    await entities.ProjectTask.update(taskId, {
      total_effort_logged: totalEffortSeconds,
    });

    return jsonResponse({
      success: true,
      taskId,
      totalEffortSeconds,
      logCount: validLogs.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error: any) {
    console.error('Task effort update failed:', error.message);
    return errorResponse(error.message);
  }
});

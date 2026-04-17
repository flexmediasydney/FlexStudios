import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

const retryWithBackoff = async <T>(fn: () => Promise<T>, maxRetries = 2): Promise<T> => {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      if (err?.status === 429 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 50;
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Retry exhausted');
};

serveWithAudit('updateProjectEffortRealtimeRobust', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({} as any));
    const { event, data, old_data } = body;

    // Resolve the projectId from whichever entity triggered this
    let projectId: string | null = null;
    if (data?.project_id) projectId = data.project_id;
    else if (old_data?.project_id) projectId = old_data.project_id;
    else if (event?.data?.project_id) projectId = event.data.project_id;
    else if (event?.old_data?.project_id) projectId = event.old_data.project_id;
    else if (event?.entity_name === 'Project' && event?.entity_id) projectId = event.entity_id;
    else if (data?.id && !data?.project_id && event?.entity_name === 'Project') projectId = data.id;

    if (!projectId) {
      return jsonResponse({ success: true, message: 'No project_id found' });
    }

    const [project, allTimeLogs, allTasks, existingEffortArr] = await Promise.all([
      retryWithBackoff(() => entities.Project.get(projectId!)),
      retryWithBackoff(() => entities.TaskTimeLog.filter({ project_id: projectId }, null, 1000)),
      retryWithBackoff(() => entities.ProjectTask.filter({ project_id: projectId }, null, 1000)),
      retryWithBackoff(() => entities.ProjectEffort.filter({ project_id: projectId })),
    ]);

    const existingEffort = existingEffortArr[0] || null;

    if (!project) {
      return jsonResponse({ success: true, message: 'Project not found' });
    }

    // === CALCULATE ESTIMATED EFFORT ===
    const estimatedByRole: Record<string, number> = {};
    const activeTasks = allTasks.filter((t: any) => !t.is_deleted);
    activeTasks.forEach((task: any) => {
      const role = task.auto_assign_role;
      if (!role || role === 'none') return;
      const estSecs = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0
        ? task.estimated_minutes * 60
        : 0;
      if (estSecs > 0) {
        estimatedByRole[role] = (estimatedByRole[role] || 0) + estSecs;
      }
    });

    // === CALCULATE ACTUAL EFFORT (from time logs) ===
    const actualByRole: Record<string, number> = {};
    allTimeLogs
      .filter((log: any) => !log.task_deleted && (log.status === 'completed' || log.is_active === true))
      .forEach((log: any) => {
        if (log.status === 'completed' || (!log.is_active && log.total_seconds > 0)) {
          const role = log.role || 'admin';
          actualByRole[role] = (actualByRole[role] || 0) + (log.total_seconds || 0);
        } else if (log.is_active && log.status === 'running' && log.start_time) {
          const role = log.role || 'admin';
          // Ensure timestamp is treated as UTC (Supabase may omit the Z suffix)
          const startStr = String(log.start_time).endsWith('Z') ? log.start_time : log.start_time + 'Z';
          const elapsed = Math.floor((Date.now() - new Date(startStr).getTime()) / 1000);
          const net = Math.max(0, elapsed - (log.paused_duration || 0));
          actualByRole[role] = (actualByRole[role] || 0) + net;
        } else if (log.is_active && log.status === 'paused') {
          const role = log.role || 'admin';
          actualByRole[role] = (actualByRole[role] || 0) + (log.total_seconds || 0);
        }
      });

    // === BUILD BREAKDOWN ===
    const allRoles = new Set([...Object.keys(estimatedByRole), ...Object.keys(actualByRole)]);
    const effortBreakdown = Array.from(allRoles).map(role => ({
      role,
      estimated_seconds: Math.round(estimatedByRole[role] || 0),
      actual_seconds: Math.round(actualByRole[role] || 0),
    }));

    const totalEstimated = Math.round(
      Object.values(estimatedByRole).reduce((a: number, b: number) => a + b, 0)
    );
    const totalActual = Math.round(
      Object.values(actualByRole).reduce((a: number, b: number) => a + b, 0)
    );

    const effortData = {
      project_id: projectId,
      project_title: project.title,
      effort_breakdown: effortBreakdown,
      total_estimated_seconds: totalEstimated,
      total_actual_seconds: totalActual,
      last_updated: new Date().toISOString(),
    };

    if (existingEffort) {
      await entities.ProjectEffort.update(existingEffort.id, effortData);
    } else {
      await entities.ProjectEffort.create(effortData);
    }

    return jsonResponse({ success: true, projectId, totalEstimated, totalActual });
  } catch (error: any) {
    console.error('ProjectEffort update error:', error);
    return errorResponse(error.message);
  }
});

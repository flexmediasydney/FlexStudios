import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('calculateProjectEffort', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json().catch(() => ({} as any));
    const { projectId } = body;
    if (!projectId) return errorResponse('projectId required', 400, req);

    const [allProjects, tasks, timeLogs] = await Promise.all([
      entities.Project.filter({ id: projectId }),
      entities.ProjectTask.filter({ project_id: projectId }),
      entities.TaskTimeLog.filter({ project_id: projectId }),
    ]);

    const project = allProjects[0];
    if (!project) {
      return jsonResponse({ error: 'Project not found' }, 404);
    }

    const effortByRole: Record<string, number> = {};

    tasks.forEach((task: any) => {
      const role = task.auto_assign_role;
      if (!role || role === 'none') return;
      const estimatedSeconds = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0
        ? task.estimated_minutes * 60
        : 0;
      if (estimatedSeconds > 0) {
        if (!effortByRole[role]) effortByRole[role] = 0;
        effortByRole[role] += estimatedSeconds;
      }
    });

    const actualByRole: Record<string, number> = {};
    timeLogs.forEach((log: any) => {
      if (!actualByRole[log.role]) actualByRole[log.role] = 0;
      actualByRole[log.role] += log.total_seconds || 0;
    });

    const effortBreakdown: any[] = [];
    const allRoles = new Set([...Object.keys(effortByRole), ...Object.keys(actualByRole)]);

    allRoles.forEach(role => {
      effortBreakdown.push({
        role,
        estimated_seconds: effortByRole[role] || 0,
        actual_seconds: actualByRole[role] || 0
      });
    });

    const totalEstimated = Object.values(effortByRole).reduce((a: number, b: number) => a + b, 0);
    const totalActual = Object.values(actualByRole).reduce((a: number, b: number) => a + b, 0);

    const existing = await entities.ProjectEffort
      .filter({ project_id: projectId }, null, 1)
      .then((items: any[]) => items[0] || null);

    const effortData = {
      project_id: projectId,
      project_title: project.title,
      effort_breakdown: effortBreakdown,
      total_estimated_seconds: totalEstimated,
      total_actual_seconds: totalActual,
      last_updated: new Date().toISOString()
    };

    if (existing) {
      await entities.ProjectEffort.update(existing.id, effortData);
    } else {
      await entities.ProjectEffort.create(effortData);
    }

    return jsonResponse({
      success: true,
      effort: effortData
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

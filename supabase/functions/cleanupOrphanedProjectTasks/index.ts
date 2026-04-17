import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, serveWithAudit } from '../_shared/supabase.ts';

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

serveWithAudit('cleanupOrphanedProjectTasks', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth: allow service-role (internal/cron calls) or authenticated users with sufficient role
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
      if (!['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
        return errorResponse('Forbidden: insufficient permissions', 403);
      }
    }

    const body = await req.json().catch(() => null);

    if (!body) return errorResponse('Invalid JSON in request body', 400);

    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.1', _fn: 'cleanupOrphanedProjectTasks', _ts: '2026-03-17' });
    }

    const { project_id } = body;
    if (!project_id) return errorResponse('project_id is required', 400);

    const [project, allTasks] = await Promise.all([
      retryWithBackoff(() => entities.Project.get(project_id)),
      retryWithBackoff(() => entities.ProjectTask.filter({ project_id }, null, 1000)),
    ]);

    if (!project) return errorResponse('Project not found', 404);

    // Build set of valid IDs from current products/packages
    const rootProducts = (project.products || []).map((p: any) => p.product_id);
    const packagedProducts = (project.packages || []).flatMap((pkg: any) =>
      (pkg.products || []).map((p: any) => p.product_id)
    );
    const validProductIds = new Set([...rootProducts, ...packagedProducts]);
    const validPackageIds = new Set((project.packages || []).map((p: any) => p.package_id));

    // Find auto-generated tasks whose source product/package no longer exists
    const orphanedTasks = allTasks.filter((task: any) => {
      if (!task.auto_generated) return false;
      if (task.is_deleted) return false;
      if (task.template_id?.startsWith('onsite:')) return false;

      const hasValidSource =
        (task.product_id && validProductIds.has(task.product_id)) ||
        (task.package_id && validPackageIds.has(task.package_id));
      return !hasValidSource;
    });

    // Soft-delete orphaned tasks
    let softDeletedCount = 0;
    const batchSize = 5;
    for (let i = 0; i < orphanedTasks.length; i += batchSize) {
      const batch = orphanedTasks.slice(i, i + batchSize);
      await Promise.all(
        batch.map((task: any) =>
          retryWithBackoff(() => entities.ProjectTask.update(task.id, { is_deleted: true }))
            .then(() => { softDeletedCount++; })
            .catch((err: any) => console.error(`Failed to soft-delete task ${task.id}:`, err.message))
        )
      );
    }

    // Deactivate time logs for orphaned tasks so they don't skew utilization
    if (orphanedTasks.length > 0) {
      const orphanedIds = orphanedTasks.map((t: any) => t.id);
      try {
        const allLogs = await entities.TaskTimeLog.filter({ project_id }, null, 2000);
        const orphanedLogs = allLogs.filter((l: any) => l.is_active && orphanedIds.includes(l.task_id));
        for (const log of orphanedLogs) {
          await entities.TaskTimeLog.update(log.id, {
            is_active: false, status: 'completed',
            end_time: new Date().toISOString(),
          }).catch(() => {});
        }
      } catch (err: any) {
        console.warn('Failed to deactivate orphaned task logs:', err?.message);
      }
    }

    // Trigger onsite task sync (fire-and-forget)
    invokeFunction('syncOnsiteEffortTasks', { project_id })
      .catch((err: any) => console.warn('syncOnsiteEffortTasks skipped:', err?.message));

    return jsonResponse({
      success: true,
      deleted_count: softDeletedCount,
      message: `Soft-removed ${softDeletedCount} orphaned task(s)`,
    });
  } catch (error: any) {
    console.error('Error cleaning up orphaned tasks:', error);
    return errorResponse(error.message);
  }
});

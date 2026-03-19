import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    let fixedCount = 0;
    const errors: any[] = [];

    // Fetch all data
    const [projects, projectTasks, projectEfforts] = await Promise.all([
      entities.Project.list(),
      entities.ProjectTask.list(),
      entities.ProjectEffort.list(),
    ]);

    // FLAW 1: Auto-generated tasks without product_id or package_id should be hard-deleted
    const orphanedTasks = projectTasks.filter((t: any) =>
      t.auto_generated && !t.product_id && !t.package_id
    );

    if (orphanedTasks.length > 0) {
      for (const task of orphanedTasks) {
        try {
          await entities.ProjectTask.delete(task.id);
          fixedCount++;
        } catch (err: any) {
          errors.push({ type: 'DELETE_ORPHANED_TASK_FAILED', task_id: task.id, error: err.message });
        }
      }
    }

    // FLAW 2: ProjectEffort records with no active tasks should be deleted
    const projectsWithTasks = new Map<string, any[]>();
    for (const task of projectTasks.filter((t: any) => !t.is_deleted)) {
      if (task.project_id) {
        if (!projectsWithTasks.has(task.project_id)) {
          projectsWithTasks.set(task.project_id, []);
        }
        projectsWithTasks.get(task.project_id)!.push(task);
      }
    }

    const orphanedEfforts = projectEfforts.filter((effort: any) =>
      !projectsWithTasks.has(effort.project_id)
    );

    if (orphanedEfforts.length > 0) {
      for (const effort of orphanedEfforts) {
        try {
          await entities.ProjectEffort.delete(effort.id);
          fixedCount++;
        } catch (err: any) {
          errors.push({ type: 'DELETE_ORPHANED_EFFORT_FAILED', effort_id: effort.id, error: err.message });
        }
      }
    }

    // FLAW 3: Projects with active tasks but no ProjectEffort should have one created
    const projectsNeedingEffort: any[] = [];
    for (const [projId] of projectsWithTasks) {
      const hasEffort = projectEfforts.some((e: any) => e.project_id === projId);
      if (!hasEffort) {
        const proj = projects.find((p: any) => p.id === projId);
        if (proj) {
          projectsNeedingEffort.push(proj);
        }
      }
    }

    if (projectsNeedingEffort.length > 0) {
      for (const proj of projectsNeedingEffort) {
        try {
          const projTasks = projectsWithTasks.get(proj.id) || [];

          // Calculate effort breakdown
          const estimatedByRole: Record<string, number> = {};
          projTasks.forEach((task: any) => {
            const role = task.auto_assign_role;
            if (!role || role === 'none') return;
            const estSecs = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0
              ? task.estimated_minutes * 60 : 0;
            if (estSecs > 0) estimatedByRole[role] = (estimatedByRole[role] || 0) + estSecs;
          });

          const allRoles = Object.keys(estimatedByRole);
          const effortBreakdown = allRoles.map(role => ({
            role,
            estimated_seconds: Math.round(estimatedByRole[role] || 0),
            actual_seconds: 0,
          }));

          await entities.ProjectEffort.create({
            project_id: proj.id,
            project_title: proj.title,
            effort_breakdown: effortBreakdown,
            total_estimated_seconds: Math.round(
              Object.values(estimatedByRole).reduce((a: number, b: number) => a + b, 0)
            ),
            total_actual_seconds: 0,
            last_updated: new Date().toISOString(),
          });
          fixedCount++;
        } catch (err: any) {
          errors.push({ type: 'CREATE_EFFORT_FAILED', project_id: proj.id, error: err.message });
        }
      }
    }

    return jsonResponse({
      success: true,
      fixed_count: fixedCount,
      fixes_applied: {
        orphaned_tasks_deleted: orphanedTasks.length,
        orphaned_efforts_deleted: orphanedEfforts.length,
        missing_efforts_created: projectsNeedingEffort.length,
      },
      errors: errors.length > 0 ? errors : null,
    });

  } catch (error: any) {
    return errorResponse(error.message);
  }
});

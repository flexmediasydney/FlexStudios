import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Master admin only', 403);
    }

    const allProjects = await entities.Project.filter({}, null, 2000);
    const allTasks = await entities.ProjectTask.filter({}, null, 5000);

    // Build a set of project IDs that already have active (non-deleted) tasks
    const projectsWithTasks = new Set<string>();
    allTasks.forEach((t: any) => {
      if (!t.is_deleted && t.project_id) {
        projectsWithTasks.add(t.project_id);
      }
    });

    // Find projects that have products/packages but no tasks
    const candidates = allProjects.filter((p: any) => {
      if (['delivered', 'cancelled'].includes(p.status)) return false;
      const hasItems = (p.products?.length > 0) || (p.packages?.length > 0);
      const hasTasks = projectsWithTasks.has(p.id);
      return hasItems && !hasTasks;
    });

    const results: any[] = [];
    for (const project of candidates) {
      try {
        await invokeFunction('syncProjectTasksFromProducts', { project_id: project.id });
        results.push({ id: project.id, title: project.title, status: 'synced' });
      } catch (err: any) {
        results.push({ id: project.id, title: project.title, status: 'failed', error: err.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Also sync projects that DO have tasks (to pick up any new templates)
    const projectsToRefresh = allProjects.filter((p: any) => {
      if (['delivered', 'cancelled'].includes(p.status)) return false;
      const hasItems = (p.products?.length > 0) || (p.packages?.length > 0);
      return hasItems && projectsWithTasks.has(p.id);
    });

    for (const project of projectsToRefresh) {
      try {
        await invokeFunction('syncProjectTasksFromProducts', { project_id: project.id });
        results.push({ id: project.id, title: project.title, status: 'refreshed' });
      } catch (err: any) {
        results.push({ id: project.id, title: project.title, status: 'refresh_failed', error: err.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const synced = results.filter(r => r.status === 'synced').length;
    const refreshed = results.filter(r => r.status === 'refreshed').length;
    const failed = results.filter(r => r.status.includes('failed')).length;

    return jsonResponse({
      success: true,
      total_candidates: candidates.length,
      total_refreshed: projectsToRefresh.length,
      synced,
      refreshed,
      failed,
      results,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * One-time utility: scans all non-delivered/non-cancelled projects and fires
 * syncProjectTasksFromProducts for any that have products/packages but zero tasks.
 * 
 * Call from the browser console:
 *   base44.functions.invoke('bulkSyncAllProjectTasks', {})
 *
 * Safe to run multiple times — syncProjectTasksFromProducts is idempotent
 * (skips tasks that already exist based on template_id).
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Master admin only' }, { status: 403 });
    }

    const allProjects = await base44.asServiceRole.entities.Project.filter({}, null, 2000);
    const allTasks = await base44.asServiceRole.entities.ProjectTask.filter({}, null, 5000);

    // Build a set of project IDs that already have active (non-deleted) tasks
    const projectsWithTasks = new Set();
    allTasks.forEach(t => {
      if (!t.is_deleted && t.project_id) {
        projectsWithTasks.add(t.project_id);
      }
    });

    // Find projects that have products/packages but no tasks
    const candidates = allProjects.filter(p => {
      if (['delivered', 'cancelled'].includes(p.status)) return false;
      const hasItems = (p.products?.length > 0) || (p.packages?.length > 0);
      const hasTasks = projectsWithTasks.has(p.id);
      return hasItems && !hasTasks;
    });

    const results = [];
    for (const project of candidates) {
      try {
        await base44.functions.invoke('syncProjectTasksFromProducts', {
          project_id: project.id,
        });
        results.push({ id: project.id, title: project.title, status: 'synced' });
      } catch (err) {
        results.push({ id: project.id, title: project.title, status: 'failed', error: err.message });
      }
      // Throttle: 200ms between projects to avoid rate limits
      await new Promise(r => setTimeout(r, 200));
    }

    // Also sync projects that DO have tasks (to pick up any new templates)
    const projectsToRefresh = allProjects.filter(p => {
      if (['delivered', 'cancelled'].includes(p.status)) return false;
      const hasItems = (p.products?.length > 0) || (p.packages?.length > 0);
      return hasItems && projectsWithTasks.has(p.id);
    });

    for (const project of projectsToRefresh) {
      try {
        await base44.functions.invoke('syncProjectTasksFromProducts', {
          project_id: project.id,
        });
        results.push({ id: project.id, title: project.title, status: 'refreshed' });
      } catch (err) {
        results.push({ id: project.id, title: project.title, status: 'refresh_failed', error: err.message });
      }
      await new Promise(r => setTimeout(r, 200));
    }

    const synced = results.filter(r => r.status === 'synced').length;
    const refreshed = results.filter(r => r.status === 'refreshed').length;
    const failed = results.filter(r => r.status.includes('failed')).length;

    return Response.json({
      success: true,
      total_candidates: candidates.length,
      total_refreshed: projectsToRefresh.length,
      synced,
      refreshed,
      failed,
      results,
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
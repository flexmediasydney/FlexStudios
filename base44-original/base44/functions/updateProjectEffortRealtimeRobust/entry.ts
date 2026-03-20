import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Real-time project effort calculator.
 * Triggered on: TaskTimeLog create/update/delete, ProjectTask create/update/delete, Project update.
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    const { event, data, old_data } = body;

    // Resolve the projectId from whichever entity triggered this
    let projectId = null;
    if (data?.project_id) projectId = data.project_id;
    else if (old_data?.project_id) projectId = old_data.project_id;
    else if (event?.data?.project_id) projectId = event.data.project_id;
    else if (event?.old_data?.project_id) projectId = event.old_data.project_id;
    // For Project entity updates, entity_id IS the projectId
    else if (event?.entity_name === 'Project' && event?.entity_id) projectId = event.entity_id;
    else if (data?.id && !data?.project_id && event?.entity_name === 'Project') projectId = data.id;

    if (!projectId) {
      return Response.json({ success: true, message: 'No project_id found' });
    }

    // Retry helper for rate limit handling
     const retryWithBackoff = async (fn, maxRetries = 2) => {
         for (let attempt = 0; attempt <= maxRetries; attempt++) {
             try {
                 return await fn();
             } catch (err) {
                 if (err.status === 429 && attempt < maxRetries) {
                     const delay = Math.pow(2, attempt) * 50;
                     await new Promise(resolve => setTimeout(resolve, delay));
                     continue;
                 }
                 throw err;
             }
         }
     };

     // Fetch everything needed in parallel with pagination and retry
     const [project, allTimeLogs, allTasks, existingEffortArr] = await Promise.all([
       retryWithBackoff(() => base44.asServiceRole.entities.Project.get(projectId)),
       retryWithBackoff(() => base44.asServiceRole.entities.TaskTimeLog.filter({ project_id: projectId }, null, 1000)),
       retryWithBackoff(() => base44.asServiceRole.entities.ProjectTask.filter({ project_id: projectId }, null, 1000)),
       retryWithBackoff(() => base44.asServiceRole.entities.ProjectEffort.filter({ project_id: projectId }))
     ]);

     const existingEffort = existingEffortArr[0] || null;

    if (!project) {
      return Response.json({ success: true, message: 'Project not found' });
    }

    // === CALCULATE ESTIMATED EFFORT ===
    const estimatedByRole = {};

    // Task-level estimated_minutes (back-office: editing, admin, etc.)
    // Onsite effort is now driven entirely by locked onsite tasks created by syncOnsiteEffortTasks
    const activeTasks = allTasks.filter(t => !t.is_deleted);
    activeTasks.forEach(task => {
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
    const actualByRole = {};
    // Only count logs that are either completed, or actively running/paused.
    // Excludes abandoned, errored, and deleted logs which must never appear in effort totals.
    allTimeLogs
      .filter(log => !log.task_deleted && (log.status === 'completed' || log.is_active === true))
      .forEach(log => {
        // Always count completed logs. For active/running logs, count current elapsed time.
        if (log.status === 'completed' || (!log.is_active && log.total_seconds > 0)) {
          const role = log.role || 'admin';
          actualByRole[role] = (actualByRole[role] || 0) + (log.total_seconds || 0);
        } else if (log.is_active && log.status === 'running' && log.start_time) {
          const role = log.role || 'admin';
          const elapsed = Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000);
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
      actual_seconds: Math.round(actualByRole[role] || 0)
    }));

    const totalEstimated = Math.round(Object.values(estimatedByRole).reduce((a, b) => a + b, 0));
    const totalActual = Math.round(Object.values(actualByRole).reduce((a, b) => a + b, 0));

    const effortData = {
      project_id: projectId,
      project_title: project.title,
      effort_breakdown: effortBreakdown,
      total_estimated_seconds: totalEstimated,
      total_actual_seconds: totalActual,
      last_updated: new Date().toISOString()
    };

    if (existingEffort) {
      await base44.asServiceRole.entities.ProjectEffort.update(existingEffort.id, effortData);
    } else {
      await base44.asServiceRole.entities.ProjectEffort.create(effortData);
    }

    return Response.json({ success: true, projectId, totalEstimated, totalActual });
  } catch (error) {
    console.error('ProjectEffort update error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});
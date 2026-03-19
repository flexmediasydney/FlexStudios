import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { projectId } = await req.json();

    const [allProjects, tasks, timeLogs] = await Promise.all([
      base44.entities.Project.filter({ id: projectId }),
      base44.entities.ProjectTask.filter({ project_id: projectId }),
      base44.entities.TaskTimeLog.filter({ project_id: projectId }),
    ]);

    const project = allProjects[0];
    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    // Calculate estimated effort for each role
    // Onsite effort is now driven by locked onsite tasks created by syncOnsiteEffortTasks
    const effortByRole = {};

    // All roles - effort from task-level estimated_minutes
    // Falls back gracefully for old tasks that don't have estimated_minutes
    tasks.forEach(task => {
      const role = task.auto_assign_role;
      if (!role || role === 'none') return;
      // New: use estimated_minutes on task
      const estimatedSeconds = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0
        ? task.estimated_minutes * 60
        : 0;
      if (estimatedSeconds > 0) {
        if (!effortByRole[role]) effortByRole[role] = 0;
        effortByRole[role] += estimatedSeconds;
      }
    });

    // Calculate actual effort from time logs
    const actualByRole = {};
    timeLogs.forEach(log => {
      if (!actualByRole[log.role]) actualByRole[log.role] = 0;
      actualByRole[log.role] += log.total_seconds || 0;
    });

    // Build effort breakdown
    const effortBreakdown = [];
    const allRoles = new Set([...Object.keys(effortByRole), ...Object.keys(actualByRole)]);

    allRoles.forEach(role => {
      effortBreakdown.push({
        role,
        estimated_seconds: effortByRole[role] || 0,
        actual_seconds: actualByRole[role] || 0
      });
    });

    const totalEstimated = Object.values(effortByRole).reduce((a, b) => a + b, 0);
    const totalActual = Object.values(actualByRole).reduce((a, b) => a + b, 0);

    // Update or create ProjectEffort record
    const existing = await base44.entities.ProjectEffort
      .filter({ project_id: projectId }, null, 1)
      .then(items => items[0] || null);

    const effortData = {
      project_id: projectId,
      project_title: project.title,
      effort_breakdown: effortBreakdown,
      total_estimated_seconds: totalEstimated,
      total_actual_seconds: totalActual,
      last_updated: new Date().toISOString()
    };

    if (existing) {
      await base44.entities.ProjectEffort.update(existing.id, effortData);
    } else {
      await base44.entities.ProjectEffort.create(effortData);
    }

    return Response.json({ 
      success: true,
      effort: effortData
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
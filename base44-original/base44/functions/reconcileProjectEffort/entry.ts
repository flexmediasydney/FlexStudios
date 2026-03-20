import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Reconciles ProjectEffort records and ProjectTask.total_effort_logged
 * against actual TaskTimeLog data. Repairs stale denormalised values
 * caused by failed automation runs (rate limits, cold starts, timeouts).
 *
 * Call with { project_id: "..." } to target one project,
 * or with no body to reconcile all projects.
 * Idempotent — safe to run multiple times.
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Allow master_admin manual calls and internal service role calls
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const targetProjectId = body?.project_id || null;

    const retryWithBackoff = async (fn, maxRetries = 3) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          if (err?.status === 429 && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 100));
            continue;
          }
          throw err;
        }
      }
    };

    const projects = targetProjectId
      ? await retryWithBackoff(() => base44.asServiceRole.entities.Project.filter({ id: targetProjectId }, null, 1))
      : await retryWithBackoff(() => base44.asServiceRole.entities.Project.filter({}, null, 1000));

    if (projects.length === 0) {
      return Response.json({ error: 'No projects found' }, { status: 404 });
    }

    let repairedEffortRecords = 0;
    let repairedTaskTotals = 0;
    const errors = [];
    const results = [];

    for (const project of projects) {
      try {
        const projectId = project.id;

        const [tasks, timeLogs, existingEfforts] = await Promise.all([
          retryWithBackoff(() => base44.asServiceRole.entities.ProjectTask.filter({ project_id: projectId }, null, 500)),
          retryWithBackoff(() => base44.asServiceRole.entities.TaskTimeLog.filter({ project_id: projectId }, null, 1000)),
          retryWithBackoff(() => base44.asServiceRole.entities.ProjectEffort.filter({ project_id: projectId }, null, 10)),
        ]);

        // 1. Reconcile ProjectTask.total_effort_logged
        const logsByTask = {};
        for (const log of timeLogs) {
          if (!log.task_id) continue;
          if (log.status === 'completed' || log.status === 'paused') {
            logsByTask[log.task_id] = (logsByTask[log.task_id] || 0) + (log.total_seconds || 0);
          }
        }

        for (const task of tasks) {
          const correctTotal = logsByTask[task.id] || 0;
          if (Math.abs(correctTotal - (task.total_effort_logged || 0)) > 5) {
            try {
              await retryWithBackoff(() =>
                base44.asServiceRole.entities.ProjectTask.update(task.id, { total_effort_logged: correctTotal })
              );
              repairedTaskTotals++;
            } catch (err) {
              errors.push({ type: 'TASK_TOTAL_UPDATE_FAILED', task_id: task.id, error: err.message });
            }
          }
        }

        // 2. Reconcile ProjectEffort
        const estimatedByRole = {};
        const actualByRole = {};

        for (const task of tasks) {
          const role = task.auto_assign_role;
          if (!role || role === 'none') continue;
          const estSecs = (task.estimated_minutes || 0) * 60;
          if (estSecs > 0) estimatedByRole[role] = (estimatedByRole[role] || 0) + estSecs;
        }

        for (const log of timeLogs) {
          if (!log.role) continue;
          if (log.status === 'completed' || log.status === 'paused') {
            actualByRole[log.role] = (actualByRole[log.role] || 0) + (log.total_seconds || 0);
          }
        }

        const allRoles = new Set([...Object.keys(estimatedByRole), ...Object.keys(actualByRole)]);
        const effortBreakdown = Array.from(allRoles).map(role => ({
          role,
          estimated_seconds: Math.round(estimatedByRole[role] || 0),
          actual_seconds: Math.round(actualByRole[role] || 0),
        }));

        const totalEstimatedSeconds = Math.round(Object.values(estimatedByRole).reduce((a, b) => a + b, 0));
        const totalActualSeconds = Math.round(Object.values(actualByRole).reduce((a, b) => a + b, 0));

        const effortPayload = {
          project_id: projectId,
          effort_breakdown: effortBreakdown,
          total_estimated_seconds: totalEstimatedSeconds,
          total_actual_seconds: totalActualSeconds,
          last_updated: new Date().toISOString(),
        };

        const existingEffort = existingEfforts[0] || null;
        const estDrift = Math.abs((existingEffort?.total_estimated_seconds || 0) - totalEstimatedSeconds);
        const actDrift = Math.abs((existingEffort?.total_actual_seconds || 0) - totalActualSeconds);

        try {
          if (existingEffort && (estDrift > 5 || actDrift > 5)) {
            await retryWithBackoff(() =>
              base44.asServiceRole.entities.ProjectEffort.update(existingEffort.id, effortPayload)
            );
            repairedEffortRecords++;
          } else if (!existingEffort && effortBreakdown.length > 0) {
            await retryWithBackoff(() =>
              base44.asServiceRole.entities.ProjectEffort.create(effortPayload)
            );
            repairedEffortRecords++;
          }
        } catch (err) {
          errors.push({ type: 'EFFORT_UPDATE_FAILED', project_id: projectId, error: err.message });
        }

        results.push({ project_id: projectId, title: project.title, status: 'ok' });

      } catch (err) {
        errors.push({ type: 'PROJECT_FAILED', project_id: project.id, error: err.message });
        results.push({ project_id: project.id, status: 'error', error: err.message });
      }
    }

    // Notify project owner of projects where effort was repaired
    if (repairedEffortRecords > 0 && targetProjectId) {
      const reconciledProject = projects[0];
      if (reconciledProject?.project_owner_id) {
        const projectName = reconciledProject.title || reconciledProject.property_address || 'Project';
        await base44.asServiceRole.entities.Notification.create({
          user_id: reconciledProject.project_owner_id,
          type: 'task_completed',
          category: 'task',
          severity: 'info',
          title: `Effort records reconciled — ${projectName}`,
          message: `${repairedEffortRecords} effort record${repairedEffortRecords > 1 ? 's' : ''} were repaired for accuracy.`,
          project_id: targetProjectId,
          project_name: projectName,
          cta_label: 'View Project',
          is_read: false,
          is_dismissed: false,
          source: 'reconcileProjectEffort',
          idempotency_key: `effort_reconciled:${targetProjectId}:${new Date().toISOString().slice(0, 13)}`,
          created_date: new Date().toISOString(),
        }).catch(() => {});
      }
    }

    // After all repairs, trigger a final authoritative effort recalc
    // so ProjectEffort reflects the corrected task state
    if (repairedEffortRecords > 0 || repairedTaskTotals > 0) {
      const projectIdsToRecalc = targetProjectId
        ? [targetProjectId]
        : results.filter(r => r.status === 'ok').map(r => r.project_id);

      for (const pid of projectIdsToRecalc) {
        base44.asServiceRole.functions.invoke('updateProjectEffortRealtimeRobust', {
          data: { project_id: pid },
          event: { entity_name: 'Project', entity_id: pid },
        }).catch(() => {});
      }
    }

    return Response.json({
      success: true,
      projects_processed: projects.length,
      repaired_effort_records: repairedEffortRecords,
      repaired_task_totals: repairedTaskTotals,
      errors: errors.length > 0 ? errors : undefined,
      results,
    });

  } catch (err) {
    console.error('reconcileProjectEffort fatal error:', err);
    return Response.json({ error: err.message }, { status: 500 });
  }
});
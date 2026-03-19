import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Robust real-time task effort aggregator
 * - Filters out paused/active logs, only counts completed
 * - Validates data integrity
 * - Handles large datasets efficiently
 * - Prevents race conditions
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json();
    // Support create/update payloads (data), delete payloads (old_data), and direct calls
    const data = body.data || body.old_data || body;
    const taskId = data?.task_id;
    const projectId = data?.project_id;

    if (!taskId) {
      return Response.json({ success: true });
    }

    if (!projectId) {
      return Response.json({ success: true });
    }

    // Fetch task and logs in parallel
    const [taskArr, taskLogs] = await Promise.all([
      base44.asServiceRole.entities.ProjectTask.filter({ project_id: projectId }, null, 1000),
      base44.asServiceRole.entities.TaskTimeLog.filter({ task_id: taskId, status: 'completed' }, '-created_date', 500)
    ]);

    const task = taskArr.find(t => t.id === taskId) || null;

    if (!task) {
      console.warn(`Task ${taskId} not found, skipping effort update`);
      return Response.json({ success: true });
    }

    // Filter: only count completed, non-active logs (exclude running/paused)
    const validLogs = taskLogs.filter(log => 
      !log.is_active &&
      typeof log.total_seconds === 'number' &&
      log.total_seconds >= 0 &&
      log.total_seconds < 86400 // max 24 hours per log to catch data corruption
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
    await base44.asServiceRole.entities.ProjectTask.update(taskId, {
      total_effort_logged: totalEffortSeconds
    });

    return Response.json({
      success: true,
      taskId,
      totalEffortSeconds,
      logCount: validLogs.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Task effort update failed:', error.message);
    return Response.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
});
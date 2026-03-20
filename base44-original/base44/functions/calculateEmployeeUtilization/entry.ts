import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const { userId, period = 'week' } = await req.json();

    // Retry helper
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

     // Fetch data in parallel with filtered queries
     const [timeLogs, employeeRole, userData] = await Promise.all([
       retryWithBackoff(() => base44.entities.TaskTimeLog.filter({ user_id: userId }, null, 1000)),
       retryWithBackoff(() => base44.entities.EmployeeRole.filter({ user_id: userId }).then(items => items[0])),
       retryWithBackoff(() => base44.entities.User.get(userId))
     ]);

     if (!employeeRole) {
       return Response.json({ error: 'Employee role not found' }, { status: 404 });
     }

    // Calculate period dates
    const now = new Date();
    let periodStart = new Date();

    if (period === 'day') {
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      const day = periodStart.getDay();
      // Monday-start: if Sunday (0) go back 6 days, otherwise go back to Monday
      const diff = periodStart.getDate() - day + (day === 0 ? -6 : 1);
      periodStart = new Date(periodStart.setDate(diff));
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'month') {
      periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const periodEnd = new Date(periodStart);
    if (period === 'day') periodEnd.setDate(periodEnd.getDate() + 1);
    else if (period === 'week') periodEnd.setDate(periodEnd.getDate() + 7);
    else if (period === 'month') periodEnd.setMonth(periodEnd.getMonth() + 1);

    // Filter logs for period
    const periodLogs = timeLogs.filter(log => {
      const logDate = new Date(log.end_time || log.created_date);
      return logDate >= periodStart && logDate < periodEnd;
    });

    // Fetch projects and tasks for period using filtered queries
    const projectIds = new Set(periodLogs.map(log => log.project_id));
    const projectIdArray = Array.from(projectIds);

    // Batch fetch projects (max 1000 at a time, handle in chunks if needed)
    const projects = await retryWithBackoff(() =>
      base44.entities.Project.filter({}, null, 1000).then(items =>
        items.filter(p => projectIds.has(p.id))
      )
    );

    // Fetch tasks only for the relevant projects — avoids full table scan
    const taskChunks = await Promise.all(
      projectIdArray.map(pid =>
        retryWithBackoff(() => base44.entities.ProjectTask.filter({ project_id: pid }, null, 500))
      )
    );
    const tasks = taskChunks.flat();

    // Calculate estimated and actual effort
    let estimatedSeconds = 0;
    let actualSeconds = 0;

    tasks.forEach(task => {
      if (task.auto_assign_role === employeeRole.role) {
        estimatedSeconds += (task.estimated_minutes || 0) * 60;
      }
    });

    periodLogs.forEach(log => {
      actualSeconds += log.total_seconds || 0;
    });

    // Calculate utilization
    const utilizationPercent = estimatedSeconds > 0 
      ? Math.round((actualSeconds / estimatedSeconds) * 100)
      : 0;

    let status = 'balanced';
    if (utilizationPercent < 80) status = 'underutilized';
    else if (utilizationPercent > 120) status = 'overutilized';

    // Find or create utilization record with filtered query
    const periodDateStr = periodStart.toISOString().split('T')[0];
    const existing = await retryWithBackoff(() =>
      base44.entities.EmployeeUtilization
        .filter({ user_id: userId, period, period_date: periodDateStr })
        .then(items => items[0])
    );

    const utilizationData = {
      user_id: userId,
      user_email: userData?.email || employeeRole.user_email,
      user_name: userData?.full_name || employeeRole.user_name,
      role: employeeRole.role,
      team_id: employeeRole.team_id,
      team_name: employeeRole.team_name,
      period,
      period_date: periodDateStr,
      estimated_seconds: estimatedSeconds,
      actual_seconds: actualSeconds,
      utilization_percent: utilizationPercent,
      status,
      project_ids: Array.from(projectIds),
      last_updated: new Date().toISOString()
    };

    if (existing) {
      await retryWithBackoff(() => base44.entities.EmployeeUtilization.update(existing.id, utilizationData));
    } else {
      await retryWithBackoff(() => base44.entities.EmployeeUtilization.create(utilizationData));
    }

    return Response.json({ 
      success: true,
      utilization: utilizationData
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
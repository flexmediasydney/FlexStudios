import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Real-time employee utilization calculator triggered on TaskTimeLog changes
 * Updates EmployeeUtilization entity whenever time logs are created/updated/deleted
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { event } = await req.json();

    if (!event?.data?.user_id) {
      return Response.json({ success: true });
    }

    const userId = event.data.user_id;

    // Get user's employee role
    const employeeRoles = await base44.entities.EmployeeRole.list().then(items =>
      items.filter(er => er.user_id === userId)
    );

    if (employeeRoles.length === 0) {
      return Response.json({ success: true });
    }

    // Process for each period (day, week, month)
    const periods = ['day', 'week', 'month'];
    const updates = [];

    for (const period of periods) {
      for (const employeeRole of employeeRoles) {
        // Calculate period dates
        const now = new Date();
        let periodStart = new Date();

        if (period === 'day') {
          periodStart.setHours(0, 0, 0, 0);
        } else if (period === 'week') {
          // Week starts on Monday (consistent with frontend weekStartsOn: 1)
          const day = periodStart.getDay(); // 0=Sun, 1=Mon ... 6=Sat
          const diff = periodStart.getDate() - ((day + 6) % 7); // shift so Monday=0
          periodStart = new Date(periodStart.setDate(diff));
          periodStart.setHours(0, 0, 0, 0);
        } else if (period === 'month') {
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        }

        // Get all time logs for this user in the period
        const timeLogs = await base44.entities.TaskTimeLog.filter({ user_id: userId });
        const periodLogs = timeLogs.filter(log => {
          const logDate = new Date(log.end_time || log.start_time || log.created_date);
          const periodEnd = new Date(periodStart);
          if (period === 'day') periodEnd.setDate(periodEnd.getDate() + 1);
          else if (period === 'week') periodEnd.setDate(periodEnd.getDate() + 7);
          else if (period === 'month') periodEnd.setMonth(periodEnd.getMonth() + 1);
          return logDate >= periodStart && logDate < periodEnd;
        });

        // Calculate actual effort from logs for this user's role
        let actualSeconds = 0;
        const projectIds = new Set();

        periodLogs.forEach(log => {
          actualSeconds += log.total_seconds || 0;
          if (log.project_id) projectIds.add(log.project_id);
        });

        // Get ProjectEffort records for these projects to find estimated effort
        const projectEfforts = await base44.entities.ProjectEffort.list().then(items =>
          items.filter(pe => Array.from(projectIds).includes(pe.project_id))
        );

        let estimatedSeconds = 0;
        projectEfforts.forEach(effort => {
          if (effort.effort_breakdown && Array.isArray(effort.effort_breakdown)) {
            const roleEffort = effort.effort_breakdown.find(e => e.role === employeeRole.role);
            if (roleEffort) {
              estimatedSeconds += roleEffort.estimated_seconds || 0;
            }
          }
        });

        // Calculate utilization
        const utilizationPercent = estimatedSeconds > 0
          ? Math.round((actualSeconds / estimatedSeconds) * 100)
          : 0;

        let status = 'balanced';
        if (utilizationPercent < 80) status = 'underutilized';
        else if (utilizationPercent > 120) status = 'overutilized';

        // Get user data
        const userData = await base44.entities.User.list().then(items =>
          items.find(u => u.id === userId)
        );

        // Find existing utilization record
        const existing = await base44.entities.EmployeeUtilization.list().then(items =>
          items.find(e =>
            e.user_id === userId &&
            e.period === period &&
            e.period_date === periodStart.toISOString().split('T')[0]
          )
        );

        const utilizationData = {
          user_id: userId,
          user_email: userData?.email || employeeRole.user_email,
          user_name: userData?.full_name || employeeRole.user_name,
          role: employeeRole.role,
          team_id: employeeRole.team_id,
          team_name: employeeRole.team_name,
          period,
          period_date: periodStart.toISOString().split('T')[0],
          estimated_seconds: estimatedSeconds,
          actual_seconds: actualSeconds,
          utilization_percent: utilizationPercent,
          status,
          project_ids: Array.from(projectIds),
          last_updated: new Date().toISOString()
        };

        if (existing) {
          await base44.entities.EmployeeUtilization.update(existing.id, utilizationData);
        } else {
          await base44.entities.EmployeeUtilization.create(utilizationData);
        }

        updates.push({
          userId,
          period,
          role: employeeRole.role,
          status: 'updated'
        });
      }
    }

    return Response.json({
      success: true,
      updates
    });
  } catch (error) {
    console.error('EmployeeUtilization update error:', error);
    return Response.json({
      success: false,
      error: error.message
    }, { status: 500 });
  }
});
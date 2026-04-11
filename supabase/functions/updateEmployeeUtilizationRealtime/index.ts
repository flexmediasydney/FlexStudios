import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Real-time employee utilization calculator triggered on TaskTimeLog changes.
 * Updates EmployeeUtilization entity whenever time logs are created/updated/deleted.
 */
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    // Auth: allow service-role (internal/cron calls) or authenticated users
    const user = await getUserFromReq(req).catch(() => null);
    if (!user) {
      const authHeader = req.headers.get('authorization') || '';
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (!serviceKey || !authHeader.includes(serviceKey)) {
        return errorResponse('Authentication required', 401);
      }
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { event } = await req.json();

    if (!event?.data?.user_id) {
      return jsonResponse({ success: true });
    }

    const userId = event.data.user_id;

    // Get user's employee role
    const allRoles = await entities.EmployeeRole.list();
    const employeeRoles = allRoles.filter((er: any) => er.user_id === userId);

    if (employeeRoles.length === 0) {
      return jsonResponse({ success: true });
    }

    // Process for each period (day, week, month)
    const periods = ['day', 'week', 'month'];
    const updates: any[] = [];

    for (const period of periods) {
      for (const employeeRole of employeeRoles) {
        // Calculate period dates
        const now = new Date();
        let periodStart = new Date();

        if (period === 'day') {
          periodStart.setHours(0, 0, 0, 0);
        } else if (period === 'week') {
          const day = periodStart.getDay();
          const diff = periodStart.getDate() - ((day + 6) % 7);
          periodStart = new Date(periodStart.setDate(diff));
          periodStart.setHours(0, 0, 0, 0);
        } else if (period === 'month') {
          periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
        }

        // Get all time logs for this user in the period
        const timeLogs = await entities.TaskTimeLog.filter({ user_id: userId });
        const periodLogs = timeLogs.filter((log: any) => {
          const logDate = new Date(log.end_time || log.start_time || log.created_date);
          const periodEnd = new Date(periodStart);
          if (period === 'day') periodEnd.setDate(periodEnd.getDate() + 1);
          else if (period === 'week') periodEnd.setDate(periodEnd.getDate() + 7);
          else if (period === 'month') periodEnd.setMonth(periodEnd.getMonth() + 1);
          return logDate >= periodStart && logDate < periodEnd;
        });

        // Calculate actual effort from logs for this user's role
        let actualSeconds = 0;
        const projectIds = new Set<string>();

        periodLogs.forEach((log: any) => {
          actualSeconds += log.total_seconds || 0;
          if (log.project_id) projectIds.add(log.project_id);
        });

        // Get ProjectEffort records for these projects to find estimated effort
        const allEfforts = await entities.ProjectEffort.list();
        const projectEfforts = allEfforts.filter((pe: any) =>
          Array.from(projectIds).includes(pe.project_id)
        );

        let estimatedSeconds = 0;
        projectEfforts.forEach((effort: any) => {
          if (effort.effort_breakdown && Array.isArray(effort.effort_breakdown)) {
            const roleEffort = effort.effort_breakdown.find((e: any) => e.role === employeeRole.role);
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
        const allUsers = await entities.User.list();
        const userData = allUsers.find((u: any) => u.id === userId);

        // Find existing utilization record
        const allUtilizations = await entities.EmployeeUtilization.list();
        const existing = allUtilizations.find((e: any) =>
          e.user_id === userId &&
          e.period === period &&
          e.period_date === periodStart.toISOString().split('T')[0]
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
          last_updated: new Date().toISOString(),
        };

        if (existing) {
          await entities.EmployeeUtilization.update(existing.id, utilizationData);
        } else {
          await entities.EmployeeUtilization.create(utilizationData);
        }

        updates.push({
          userId,
          period,
          role: employeeRole.role,
          status: 'updated',
        });
      }
    }

    return jsonResponse({ success: true, updates });
  } catch (error: any) {
    console.error('EmployeeUtilization update error:', error);
    return errorResponse(error.message);
  }
});

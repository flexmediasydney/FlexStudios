import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (user?.role !== 'master_admin') {
      return errorResponse('Forbidden', 403);
    }

    // Retry helper
    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await fn();
        } catch (err: any) {
          if (err.status === 429 && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    };

    // Fetch all data in parallel with pagination
    const [projectEfforts, timeLogs, employeeRoles, users] = await Promise.all([
      retryWithBackoff(() => entities.ProjectEffort.filter({}, null, 1000)),
      retryWithBackoff(() => entities.TaskTimeLog.filter({}, null, 1000)),
      retryWithBackoff(() => entities.EmployeeRole.filter({}, null, 1000)),
      retryWithBackoff(() => entities.User.filter({}, null, 1000)),
    ]);

    const utilizationRecords: any[] = [];

    // Group time logs by user_id
    const logsByUser: Record<string, any[]> = {};
    timeLogs.forEach((log: any) => {
      if (!logsByUser[log.user_id]) {
        logsByUser[log.user_id] = [];
      }
      logsByUser[log.user_id].push(log);
    });

    // Process each user's logs
    for (const [userId, userLogs] of Object.entries(logsByUser)) {
      const employeeRole = employeeRoles.find((er: any) => er.user_id === userId);
      const userData = users.find((u: any) => u.id === userId);

      if (!employeeRole) continue;

      // Group logs by period (week)
      const logsByPeriod: Record<string, any[]> = {};

      userLogs.forEach((log: any) => {
        const logDate = new Date(log.end_time || log.created_date);
        const periodStart = new Date(logDate);
        const day = periodStart.getDay();
        const diff = periodStart.getDate() - day;
        periodStart.setDate(diff);
        periodStart.setHours(0, 0, 0, 0);

        const periodKey = periodStart.toISOString().split('T')[0];
        if (!logsByPeriod[periodKey]) {
          logsByPeriod[periodKey] = [];
        }
        logsByPeriod[periodKey].push(log);
      });

      // Calculate utilization for each period
      for (const [periodDate, periodLogs] of Object.entries(logsByPeriod)) {
        const projectIds = new Set(periodLogs.map((log: any) => log.project_id));

        // Get effort data for these projects
        const projectEffortData = projectEfforts.filter((pe: any) => projectIds.has(pe.project_id));

        // Calculate estimated effort from ProjectEffort.effort_by_person
        let estimatedSeconds = 0;
        projectEffortData.forEach((pe: any) => {
          const personEffort = pe.effort_by_person?.find((p: any) => p.id === userId);
          if (personEffort) {
            estimatedSeconds += personEffort.estimated_seconds || 0;
          }
        });

        // Calculate actual from logs
        let actualSeconds = 0;
        periodLogs.forEach((log: any) => {
          actualSeconds += log.total_seconds || 0;
        });

        // Only create if there's actual effort logged
        if (actualSeconds > 0 || estimatedSeconds > 0) {
          const utilizationPercent = estimatedSeconds > 0
            ? Math.round((actualSeconds / estimatedSeconds) * 100)
            : 0;

          let status = 'balanced';
          if (utilizationPercent < 80) status = 'underutilized';
          else if (utilizationPercent > 120) status = 'overutilized';

          utilizationRecords.push({
            user_id: userId,
            user_email: userData?.email || employeeRole.user_email,
            user_name: userData?.full_name || employeeRole.user_name,
            role: employeeRole.role,
            team_id: employeeRole.team_id,
            team_name: employeeRole.team_name,
            period: 'week',
            period_date: periodDate,
            estimated_seconds: estimatedSeconds,
            actual_seconds: actualSeconds,
            utilization_percent: utilizationPercent,
            status,
            project_ids: Array.from(projectIds),
            last_updated: new Date().toISOString(),
          });
        }
      }
    }

    // Fetch existing records
    const existingRecords = await retryWithBackoff(() =>
      entities.EmployeeUtilization.filter({}, null, 1000)
    );

    let createdCount = 0;
    let updatedCount = 0;

    // Batch process with controlled concurrency
    const batchSize = 5;
    for (let i = 0; i < utilizationRecords.length; i += batchSize) {
      const batch = utilizationRecords.slice(i, i + batchSize);
      await Promise.all(batch.map(async (record: any) => {
        const existing = existingRecords.find((e: any) =>
          e.user_id === record.user_id &&
          e.period === record.period &&
          e.period_date === record.period_date
        );

        if (existing) {
          await retryWithBackoff(() =>
            entities.EmployeeUtilization.update(existing.id, record)
          );
          updatedCount++;
        } else {
          await retryWithBackoff(() =>
            entities.EmployeeUtilization.create(record)
          );
          createdCount++;
        }
      }));
    }

    return jsonResponse({
      success: true,
      created: createdCount,
      updated: updatedCount,
      total: utilizationRecords.length,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

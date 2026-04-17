import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('calculateEmployeeUtilization', async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (user?.role !== 'master_admin') {
      return errorResponse('Forbidden', 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const { userId, period = 'week' } = body;

    // Guard: userId must be a valid UUID. Without this, undefined/empty values
    // blow up Postgres with "invalid input syntax for type uuid: undefined"
    // and bubble as a 500 — masking a simple caller bug behind an opaque error.
    const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
    if (!userId || !UUID_RE.test(String(userId))) {
      return errorResponse('userId (UUID) is required', 400);
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

    // Fetch data in parallel with filtered queries.
    // entities.User.get() throws when no row exists ("Cannot coerce the result to a
    // single JSON object") — wrap in catch so a missing user surfaces as 404 rather
    // than a 500 that masks the real issue.
    const [timeLogs, employeeRoleResult, userData] = await Promise.all([
      retryWithBackoff(() => entities.TaskTimeLog.filter({ user_id: userId }, null, 1000)),
      retryWithBackoff(() => entities.EmployeeRole.filter({ user_id: userId }).then((items: any[]) => items[0])),
      retryWithBackoff(() => entities.User.get(userId)).catch(() => null),
    ]);

    const employeeRole = employeeRoleResult;

    if (!userData) {
      return errorResponse('User not found', 404);
    }
    if (!employeeRole) {
      return errorResponse('Employee role not found', 404);
    }

    // Calculate period dates
    const now = new Date();
    let periodStart = new Date();

    if (period === 'day') {
      periodStart.setHours(0, 0, 0, 0);
    } else if (period === 'week') {
      const day = periodStart.getDay();
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
    const periodLogs = timeLogs.filter((log: any) => {
      const logDate = new Date(log.end_time || log.created_date);
      return logDate >= periodStart && logDate < periodEnd;
    });

    // Fetch projects and tasks for period
    const projectIds = new Set(periodLogs.map((log: any) => log.project_id));
    const projectIdArray = Array.from(projectIds) as string[];

    const projects = await retryWithBackoff(() =>
      entities.Project.filter({}, null, 1000).then((items: any[]) =>
        items.filter((p: any) => projectIds.has(p.id))
      )
    );

    // Fetch tasks only for the relevant projects
    const taskChunks = await Promise.all(
      projectIdArray.map((pid: string) =>
        retryWithBackoff(() => entities.ProjectTask.filter({ project_id: pid }, null, 500))
      )
    );
    const tasks = taskChunks.flat();

    // Calculate estimated and actual effort
    let estimatedSeconds = 0;
    let actualSeconds = 0;

    tasks.forEach((task: any) => {
      if (task.auto_assign_role === employeeRole.role) {
        estimatedSeconds += (task.estimated_minutes || 0) * 60;
      }
    });

    periodLogs.forEach((log: any) => {
      actualSeconds += log.total_seconds || 0;
    });

    // Calculate utilization
    const utilizationPercent = estimatedSeconds > 0
      ? Math.round((actualSeconds / estimatedSeconds) * 100)
      : 0;

    let status = 'balanced';
    if (utilizationPercent < 80) status = 'underutilized';
    else if (utilizationPercent > 120) status = 'overutilized';

    // Find or create utilization record
    const periodDateStr = periodStart.toISOString().split('T')[0];
    const existing = await retryWithBackoff(() =>
      entities.EmployeeUtilization
        .filter({ user_id: userId, period, period_date: periodDateStr })
        .then((items: any[]) => items[0])
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
      last_updated: new Date().toISOString(),
    };

    if (existing) {
      await retryWithBackoff(() => entities.EmployeeUtilization.update(existing.id, utilizationData));
    } else {
      await retryWithBackoff(() => entities.EmployeeUtilization.create(utilizationData));
    }

    return jsonResponse({
      success: true,
      utilization: utilizationData,
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

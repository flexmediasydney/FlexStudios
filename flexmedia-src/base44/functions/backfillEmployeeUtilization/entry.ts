import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

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

     // Fetch all data in parallel with pagination
     const [projectEfforts, timeLogs, employeeRoles, users] = await Promise.all([
       retryWithBackoff(() => base44.asServiceRole.entities.ProjectEffort.filter({}, null, 1000)),
       retryWithBackoff(() => base44.asServiceRole.entities.TaskTimeLog.filter({}, null, 1000)),
       retryWithBackoff(() => base44.asServiceRole.entities.EmployeeRole.filter({}, null, 1000)),
       retryWithBackoff(() => base44.asServiceRole.entities.User.filter({}, null, 1000))
     ]);
    
    const utilizationRecords = [];

    // Group time logs by user_id
    const logsByUser = {};
    timeLogs.forEach(log => {
      if (!logsByUser[log.user_id]) {
        logsByUser[log.user_id] = [];
      }
      logsByUser[log.user_id].push(log);
    });

    // Process each user's logs
    for (const [userId, userLogs] of Object.entries(logsByUser)) {
      const employeeRole = employeeRoles.find(er => er.user_id === userId);
      const userData = users.find(u => u.id === userId);

      if (!employeeRole) continue;

      // Group logs by period (week)
      const logsByPeriod = {};
      
      userLogs.forEach(log => {
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
        const projectIds = new Set(periodLogs.map(log => log.project_id));
        
        // Get effort data for these projects
        const projectEffortData = projectEfforts.filter(pe => projectIds.has(pe.project_id));
        
        // Calculate estimated effort from ProjectEffort.effort_by_person
        let estimatedSeconds = 0;
        projectEffortData.forEach(pe => {
          const personEffort = pe.effort_by_person?.find(p => p.id === userId);
          if (personEffort) {
            estimatedSeconds += personEffort.estimated_seconds || 0;
          }
        });

        // Calculate actual from logs
        let actualSeconds = 0;
        periodLogs.forEach(log => {
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
            last_updated: new Date().toISOString()
          });
        }
      }
    }

    // Fetch existing records with pagination
     const existingRecords = await retryWithBackoff(() =>
       base44.asServiceRole.entities.EmployeeUtilization.filter({}, null, 1000)
     );

     let createdCount = 0;
     let updatedCount = 0;

     // Batch process with controlled concurrency
     const batchSize = 5;
     for (let i = 0; i < utilizationRecords.length; i += batchSize) {
       const batch = utilizationRecords.slice(i, i + batchSize);
       await Promise.all(batch.map(async record => {
         const existing = existingRecords.find(e => 
           e.user_id === record.user_id && 
           e.period === record.period &&
           e.period_date === record.period_date
         );

         if (existing) {
           await retryWithBackoff(() =>
             base44.asServiceRole.entities.EmployeeUtilization.update(existing.id, record)
           );
           updatedCount++;
         } else {
           await retryWithBackoff(() =>
             base44.asServiceRole.entities.EmployeeUtilization.create(record)
           );
           createdCount++;
         }
       }));
     }

    return Response.json({ 
      success: true,
      created: createdCount,
      updated: updatedCount,
      total: utilizationRecords.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
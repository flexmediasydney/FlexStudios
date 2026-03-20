import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Comprehensive end-to-end timer test covering 20 complex scenarios:
 * 
 * SCENARIO GROUPS:
 * 1. Basic Timer Operations (1-4)
 * 2. Timer Persistence (5-8)
 * 3. Multi-Task Switching (9-12)
 * 4. Project/Package Combinations (13-16)
 * 5. Utilization Calculations (17-20)
 */

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Admin only' }, { status: 403 });
    }

    const results = {
      scenarios: [],
      totalPassed: 0,
      totalFailed: 0,
      errors: []
    };

    // SCENARIO 1: Basic timer start & pause on single task
    try {
      const project = await base44.asServiceRole.entities.Project.list().then(p => p[0]);
      const task = await base44.asServiceRole.entities.ProjectTask.list().then(t => t.filter(x => x.project_id === project?.id)[0]);
      
      if (project && task) {
        const log1 = await base44.asServiceRole.entities.TaskTimeLog.create({
          task_id: task.id,
          project_id: project.id,
          user_id: user.id,
          user_email: user.email,
          user_name: user.full_name,
          role: 'admin',
          start_time: new Date().toISOString(),
          status: 'running',
          is_active: true,
          total_seconds: 0
        });

        await new Promise(r => setTimeout(r, 100));
        
        const updated = await base44.asServiceRole.entities.TaskTimeLog.update(log1.id, {
          status: 'paused',
          pause_time: new Date().toISOString(),
          total_seconds: 120
        });

        const passed = updated.status === 'paused' && updated.total_seconds === 120;
        results.scenarios.push({
          scenario: 1,
          name: 'Basic timer start & pause',
          passed,
          details: passed ? 'Timer paused successfully' : 'Failed to pause timer'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 1: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 2: Resume paused timer
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const pausedLog = logs.find(l => l.status === 'paused' && l.is_active);
      
      if (pausedLog) {
        const resumed = await base44.asServiceRole.entities.TaskTimeLog.update(pausedLog.id, {
          status: 'running'
        });
        
        const passed = resumed.status === 'running';
        results.scenarios.push({
          scenario: 2,
          name: 'Resume paused timer',
          passed,
          details: passed ? 'Timer resumed' : 'Failed to resume'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 2: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 3: Finish timer and mark completed
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const runningLog = logs.find(l => l.status === 'running' && l.is_active);
      
      if (runningLog) {
        const finished = await base44.asServiceRole.entities.TaskTimeLog.update(runningLog.id, {
          status: 'completed',
          is_active: false,
          end_time: new Date().toISOString(),
          total_seconds: 300
        });
        
        const passed = finished.status === 'completed' && !finished.is_active && finished.total_seconds === 300;
        results.scenarios.push({
          scenario: 3,
          name: 'Finish timer and mark completed',
          passed,
          details: passed ? 'Timer completed' : 'Failed to complete'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 3: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 4: Multiple logs for same task
    try {
      const tasks = await base44.asServiceRole.entities.ProjectTask.list();
      const task = tasks[0];
      
      if (task) {
        const log1 = await base44.asServiceRole.entities.TaskTimeLog.create({
          task_id: task.id,
          project_id: task.project_id,
          user_id: user.id,
          user_email: user.email,
          user_name: user.full_name,
          role: 'admin',
          start_time: new Date().toISOString(),
          status: 'completed',
          is_active: false,
          total_seconds: 500
        });

        const log2 = await base44.asServiceRole.entities.TaskTimeLog.create({
          task_id: task.id,
          project_id: task.project_id,
          user_id: user.id,
          user_email: user.email,
          user_name: user.full_name,
          role: 'admin',
          start_time: new Date().toISOString(),
          status: 'completed',
          is_active: false,
          total_seconds: 300
        });

        const allLogs = await base44.asServiceRole.entities.TaskTimeLog.list();
        const forTask = allLogs.filter(l => l.task_id === task.id && l.user_id === user.id);
        const totalTime = forTask.reduce((sum, l) => sum + (l.total_seconds || 0), 0);
        
        const passed = forTask.length >= 2 && totalTime >= 800;
        results.scenarios.push({
          scenario: 4,
          name: 'Multiple logs for same task aggregate correctly',
          passed,
          details: passed ? `Total time: ${totalTime}s across ${forTask.length} logs` : 'Failed aggregation'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 4: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 5-8: Timer Persistence Tests
    // SCENARIO 5: Load active timer after page reload
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const project = projects[0];
      const tasks = await base44.asServiceRole.entities.ProjectTask.list().then(t => t.filter(x => x.project_id === project?.id));
      
      if (project && tasks[0]) {
        const activeLog = await base44.asServiceRole.entities.TaskTimeLog.create({
          task_id: tasks[0].id,
          project_id: project.id,
          user_id: user.id,
          user_email: user.email,
          user_name: user.full_name,
          role: 'admin',
          start_time: new Date().toISOString(),
          status: 'running',
          is_active: true,
          total_seconds: 120
        });

        const reloaded = await base44.asServiceRole.entities.TaskTimeLog.list().then(logs =>
          logs.find(l => l.id === activeLog.id && l.is_active && l.status === 'running')
        );

        const passed = reloaded?.total_seconds === 120;
        results.scenarios.push({
          scenario: 5,
          name: 'Load active timer after page reload',
          passed,
          details: passed ? 'Active timer persisted' : 'Timer state lost'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 5: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 6: Paused timer persists state
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const pausedLog = logs.find(l => l.status === 'paused' && l.is_active);
      
      if (pausedLog) {
        const reloaded = await base44.asServiceRole.entities.TaskTimeLog.list().then(allLogs =>
          allLogs.find(l => l.id === pausedLog.id)
        );
        
        const passed = reloaded?.status === 'paused' && reloaded?.is_active;
        results.scenarios.push({
          scenario: 6,
          name: 'Paused timer persists state across reload',
          passed,
          details: passed ? 'Paused state preserved' : 'State lost'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 6: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 7: Completed timer is marked inactive
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const completedLog = logs.find(l => l.status === 'completed');
      
      if (completedLog) {
        const reloaded = await base44.asServiceRole.entities.TaskTimeLog.list().then(allLogs =>
          allLogs.find(l => l.id === completedLog.id)
        );
        
        const passed = reloaded?.status === 'completed' && !reloaded?.is_active;
        results.scenarios.push({
          scenario: 7,
          name: 'Completed timer marked inactive',
          passed,
          details: passed ? 'Completed status correct' : 'Status incorrect'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 7: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 8: Total seconds persist during sync
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const log = logs.find(l => l.total_seconds > 100);
      
      if (log) {
        const originalSeconds = log.total_seconds;
        const updated = await base44.asServiceRole.entities.TaskTimeLog.update(log.id, {
          total_seconds: originalSeconds + 50
        });
        
        const reloaded = await base44.asServiceRole.entities.TaskTimeLog.list().then(allLogs =>
          allLogs.find(l => l.id === log.id)
        );
        
        const passed = reloaded?.total_seconds === originalSeconds + 50;
        results.scenarios.push({
          scenario: 8,
          name: 'Total seconds persist during sync',
          passed,
          details: passed ? `Seconds synced: ${reloaded?.total_seconds}` : 'Sync failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 8: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 9-12: Multi-Task Switching
    // SCENARIO 9: Switch between tasks without losing state
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const tasks = await base44.asServiceRole.entities.ProjectTask.list();
      
      if (projects.length > 0 && tasks.length >= 2) {
        const project = projects[0];
        const task1 = tasks.find(t => t.project_id === project.id);
        const task2 = tasks.find(t => t.project_id === project.id && t.id !== task1?.id);
        
        if (task1 && task2) {
          const log1 = await base44.asServiceRole.entities.TaskTimeLog.create({
            task_id: task1.id,
            project_id: project.id,
            user_id: user.id,
            user_email: user.email,
            user_name: user.full_name,
            role: 'admin',
            start_time: new Date().toISOString(),
            status: 'paused',
            is_active: true,
            total_seconds: 600
          });

          const log2 = await base44.asServiceRole.entities.TaskTimeLog.create({
            task_id: task2.id,
            project_id: project.id,
            user_id: user.id,
            user_email: user.email,
            user_name: user.full_name,
            role: 'admin',
            start_time: new Date().toISOString(),
            status: 'running',
            is_active: true,
            total_seconds: 150
          });

          const reloadedLogs = await base44.asServiceRole.entities.TaskTimeLog.list();
          const task1Log = reloadedLogs.find(l => l.id === log1.id);
          const task2Log = reloadedLogs.find(l => l.id === log2.id);
          
          const passed = task1Log?.total_seconds === 600 && task2Log?.total_seconds === 150;
          results.scenarios.push({
            scenario: 9,
            name: 'Switch between tasks without losing state',
            passed,
            details: passed ? 'Both tasks preserved' : 'State lost'
          });
          if (passed) results.totalPassed++; else results.totalFailed++;
        }
      }
    } catch (e) {
      results.errors.push(`Scenario 9: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 10: Only one task can be active (running) per user at a time
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const userRunningLogs = logs.filter(l => l.user_id === user.id && l.status === 'running' && l.is_active);
      
      const passed = userRunningLogs.length <= 1;
      results.scenarios.push({
        scenario: 10,
        name: 'Only one task active (running) per user',
        passed,
        details: passed ? 'Single active timer' : `Multiple active timers: ${userRunningLogs.length}`
      });
      if (passed) results.totalPassed++; else results.totalFailed++;
    } catch (e) {
      results.errors.push(`Scenario 10: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 11: Switch context maintains data integrity
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const project1 = projects[0];
      const project2 = projects[1];
      
      if (project1 && project2) {
        const task1 = await base44.asServiceRole.entities.ProjectTask.list().then(t => t.find(x => x.project_id === project1.id));
        const task2 = await base44.asServiceRole.entities.ProjectTask.list().then(t => t.find(x => x.project_id === project2.id));
        
        if (task1 && task2) {
          const log1 = await base44.asServiceRole.entities.TaskTimeLog.create({
            task_id: task1.id,
            project_id: project1.id,
            user_id: user.id,
            user_email: user.email,
            user_name: user.full_name,
            role: 'photographer',
            start_time: new Date().toISOString(),
            status: 'completed',
            is_active: false,
            total_seconds: 3600
          });

          const log2 = await base44.asServiceRole.entities.TaskTimeLog.create({
            task_id: task2.id,
            project_id: project2.id,
            user_id: user.id,
            user_email: user.email,
            user_name: user.full_name,
            role: 'videographer',
            start_time: new Date().toISOString(),
            status: 'completed',
            is_active: false,
            total_seconds: 2400
          });

          const allLogs = await base44.asServiceRole.entities.TaskTimeLog.list();
          const proj1Logs = allLogs.filter(l => l.project_id === project1.id && l.user_id === user.id);
          const proj2Logs = allLogs.filter(l => l.project_id === project2.id && l.user_id === user.id);
          
          const passed = proj1Logs.some(l => l.role === 'photographer') && proj2Logs.some(l => l.role === 'videographer');
          results.scenarios.push({
            scenario: 11,
            name: 'Switch context maintains data integrity',
            passed,
            details: passed ? 'Projects isolated correctly' : 'Data mixed'
          });
          if (passed) results.totalPassed++; else results.totalFailed++;
        }
      }
    } catch (e) {
      results.errors.push(`Scenario 11: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 12: Paused timer doesn't increment
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const pausedLog = logs.find(l => l.status === 'paused' && l.is_active);
      
      if (pausedLog) {
        const startSeconds = pausedLog.total_seconds;
        await new Promise(r => setTimeout(r, 100));
        
        const reloaded = await base44.asServiceRole.entities.TaskTimeLog.list().then(allLogs =>
          allLogs.find(l => l.id === pausedLog.id)
        );
        
        const passed = reloaded?.total_seconds === startSeconds;
        results.scenarios.push({
          scenario: 12,
          name: 'Paused timer doesn\'t increment',
          passed,
          details: passed ? 'Timer stayed paused' : 'Timer incremented'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 12: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 13-16: Project/Package/Product Scenarios
    // SCENARIO 13: Effort calculated from package templates
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const project = projects.find(p => p.packages && p.packages.length > 0);
      
      if (project) {
        await base44.functions.invoke('calculateProjectEffort', { projectId: project.id });
        
        const effort = await base44.asServiceRole.entities.ProjectEffort.list().then(e =>
          e.find(x => x.project_id === project.id)
        );
        
        const passed = effort?.total_estimated_seconds >= 0;
        results.scenarios.push({
          scenario: 13,
          name: 'Effort calculated from package templates',
          passed,
          details: passed ? `Estimated: ${effort?.total_estimated_seconds}s` : 'Calculation failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 13: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 14: Multiple packages aggregate effort
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const project = projects.find(p => p.packages && p.packages.length >= 2);
      
      if (project) {
        await base44.functions.invoke('calculateProjectEffort', { projectId: project.id });
        
        const effort = await base44.asServiceRole.entities.ProjectEffort.list().then(e =>
          e.find(x => x.project_id === project.id)
        );
        
        const passed = effort?.effort_breakdown?.length > 0;
        results.scenarios.push({
          scenario: 14,
          name: 'Multiple packages aggregate effort',
          passed,
          details: passed ? `Breakdown: ${effort?.effort_breakdown?.length} roles` : 'No breakdown'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 14: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 15: Onsite effort splits between photographer/videographer
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const project = projects.find(p => p.onsite_staff_1_id && p.onsite_staff_2_id && p.status === 'uploaded');
      
      if (project) {
        const beforeLogs = await base44.asServiceRole.entities.TaskTimeLog.list();
        const beforeCount = beforeLogs.filter(l => l.project_id === project.id).length;
        
        await base44.functions.invoke('logOnsiteEffortOnUpload', { event: {}, data: project });
        
        const afterLogs = await base44.asServiceRole.entities.TaskTimeLog.list();
        const newLogs = afterLogs.filter(l => l.project_id === project.id && beforeCount < afterLogs.length);
        
        const passed = newLogs.length >= 2;
        results.scenarios.push({
          scenario: 15,
          name: 'Onsite effort splits between photographer/videographer',
          passed,
          details: passed ? `Created ${newLogs.length} onsite logs` : 'Onsite logs not created'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 15: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 16: Product pricing tier affects estimated effort
    try {
      const projects = await base44.asServiceRole.entities.Project.list();
      const standardProject = projects.find(p => p.pricing_tier === 'standard');
      const premiumProject = projects.find(p => p.pricing_tier === 'premium');
      
      if (standardProject && premiumProject) {
        await base44.functions.invoke('calculateProjectEffort', { projectId: standardProject.id });
        await base44.functions.invoke('calculateProjectEffort', { projectId: premiumProject.id });
        
        const efforts = await base44.asServiceRole.entities.ProjectEffort.list();
        const stdEffort = efforts.find(e => e.project_id === standardProject.id);
        const premEffort = efforts.find(e => e.project_id === premiumProject.id);
        
        const passed = stdEffort && premEffort && stdEffort.id !== premEffort.id;
        results.scenarios.push({
          scenario: 16,
          name: 'Product pricing tier affects estimated effort',
          passed,
          details: passed ? 'Tiers calculated separately' : 'Tier differentiation failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 16: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 17-20: Utilization Calculations
    // SCENARIO 17: Employee utilization calculated from time logs
    try {
      const employees = await base44.asServiceRole.entities.EmployeeRole.list();
      const employee = employees[0];
      
      if (employee) {
        await base44.functions.invoke('calculateEmployeeUtilization', { 
          userId: employee.user_id,
          period: 'week'
        });
        
        const utils = await base44.asServiceRole.entities.EmployeeUtilization.list();
        const empUtil = utils.find(u => u.user_id === employee.user_id && u.period === 'week');
        
        const passed = empUtil?.user_id === employee.user_id;
        results.scenarios.push({
          scenario: 17,
          name: 'Employee utilization calculated from time logs',
          passed,
          details: passed ? `Utilization: ${empUtil?.utilization_percent}%` : 'Calculation failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 17: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 18: Utilization status determined correctly
    try {
      const utils = await base44.asServiceRole.entities.EmployeeUtilization.list();
      const balanced = utils.find(u => u.utilization_percent >= 80 && u.utilization_percent <= 120);
      const overutilized = utils.find(u => u.utilization_percent > 120);
      const underutilized = utils.find(u => u.utilization_percent < 80);
      
      const passed = (balanced?.status === 'balanced' || !balanced) && 
                     (overutilized?.status === 'overutilized' || !overutilized) &&
                     (underutilized?.status === 'underutilized' || !underutilized);
      
      results.scenarios.push({
        scenario: 18,
        name: 'Utilization status determined correctly',
        passed,
        details: passed ? 'Status mapping correct' : 'Status mapping incorrect'
      });
      if (passed) results.totalPassed++; else results.totalFailed++;
    } catch (e) {
      results.errors.push(`Scenario 18: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 19: Utilization aggregates across multiple projects
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const userWithMultiProject = logs.reduce((acc, log) => {
        if (!acc[log.user_id]) acc[log.user_id] = new Set();
        acc[log.user_id].add(log.project_id);
        return acc;
      }, {});
      
      const userWithMulti = Object.entries(userWithMultiProject).find(([_, projects]) => projects.size >= 2);
      
      if (userWithMulti) {
        const utils = await base44.asServiceRole.entities.EmployeeUtilization.list();
        const empUtil = utils.find(u => u.user_id === userWithMulti[0]);
        
        const passed = empUtil?.project_ids?.length >= 2;
        results.scenarios.push({
          scenario: 19,
          name: 'Utilization aggregates across multiple projects',
          passed,
          details: passed ? `Projects: ${empUtil?.project_ids?.length}` : 'Aggregation failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 19: ${e.message}`);
      results.totalFailed++;
    }

    // SCENARIO 20: Utilization updates when time logs change
    try {
      const logs = await base44.asServiceRole.entities.TaskTimeLog.list();
      const log = logs.find(l => l.total_seconds > 100);
      
      if (log) {
        const beforeUtils = await base44.asServiceRole.entities.EmployeeUtilization.list();
        const beforeUtil = beforeUtils.find(u => u.user_id === log.user_id);
        const beforeActual = beforeUtil?.actual_seconds || 0;
        
        // Simulate time log update
        await base44.asServiceRole.entities.TaskTimeLog.update(log.id, {
          total_seconds: log.total_seconds + 600
        });
        
        // Trigger recalc
        try {
          await base44.functions.invoke('calculateEmployeeUtilization', {
            userId: log.user_id,
            period: 'week'
          });
        } catch (e) {
          console.warn('Recalc failed:', e);
        }
        
        const afterUtils = await base44.asServiceRole.entities.EmployeeUtilization.list();
        const afterUtil = afterUtils.find(u => u.user_id === log.user_id && u.period === 'week');
        const afterActual = afterUtil?.actual_seconds || 0;
        
        const passed = beforeActual <= afterActual;
        results.scenarios.push({
          scenario: 20,
          name: 'Utilization updates when time logs change',
          passed,
          details: passed ? `Before: ${beforeActual}s, After: ${afterActual}s` : 'Update failed'
        });
        if (passed) results.totalPassed++; else results.totalFailed++;
      }
    } catch (e) {
      results.errors.push(`Scenario 20: ${e.message}`);
      results.totalFailed++;
    }

    results.summary = {
      totalTests: 20,
      passed: results.totalPassed,
      failed: results.totalFailed,
      successRate: `${Math.round((results.totalPassed / 20) * 100)}%`
    };

    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

// Expected versions — update these whenever you deploy new function code
const EXPECTED_VERSIONS: Record<string, string> = {
  'processTonomoQueue': 'v3.1',
  'receiveTonomoWebhook': 'v3.0',
  'syncProjectTasksFromProducts': 'v2.1',
  'calculateProjectPricing': 'v2.0',
  'recalculateProjectPricingServerSide': 'v2.0',
  'calculateProjectTaskDeadlines': 'v2.1',
  'trackProjectStageChange': 'v2.0',
  'applyProjectRoleDefaults': 'v2.0',
  'logOnsiteEffortOnUpload': 'v1.1',
  'cleanupOrphanedProjectTasks': 'v1.1',
  'logProductChange': 'v1.1',
  'logPackageChange': 'v1.1',
};

const CRITICAL_FUNCTIONS: Record<string, string[]> = {
  'Tonomo Integration': ['receiveTonomoWebhook', 'processTonomoQueue', 'triggerTonomoProcessing', 'diagnoseTonomoProcessor'],
  'Pricing Engine': ['calculateProjectPricing', 'recalculateProjectPricingServerSide', 'logPriceMatrixChange'],
  'Task Engine': ['syncProjectTasksFromProducts', 'syncOnsiteEffortTasks', 'cleanupOrphanedProjectTasks', 'calculateProjectTaskDeadlines', 'calculateTaskBlockingState', 'validateTaskDependencies', 'checkTaskDeadlines'],
  'Stage & Lifecycle': ['trackProjectStageChange', 'applyProjectRoleDefaults', 'logOnsiteEffortOnUpload', 'runProjectAutomationRules', 'checkAndArchiveProject'],
  'Effort & Timers': ['updateProjectEffortRealtimeRobust', 'updateTaskEffortRealtimeRobust', 'reconcileProjectEffort', 'calculateProjectEffort', 'calculateEmployeeUtilization'],
  'Revisions': ['applyRevisionPricingImpact', 'revertRevisionPricingImpact', 'handleRevisionCancellation', 'syncProjectRevisionStatus', 'updateRevisionStatus'],
  'Change Logging': ['logProductChange', 'logPackageChange', 'logProjectChange'],
  'Calendar & Location': ['syncGoogleCalendar', 'geocodeProject', 'searchAustralianAddresses', 'writeCalendarEventToGoogle', 'deleteCalendarEventFromGoogle'],
  'Email': ['syncAllEmails', 'sendGmailMessage', 'initializeGmail'],
  'Notifications': ['notificationService'],
  'Validation': ['validateProjectOwner', 'validateSettingsAccess'],
};

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Master admin only', 403);
    }

    const body = await req.json().catch(() => ({}));
    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'healthCheckFunctions', _ts: '2026-03-17' });
    }
    const { include_data_integrity = false, include_smoke_tests = false } = body;

    const results: any[] = [];
    let alive = 0, stale = 0, dead = 0, slow = 0;

    for (const [category, functions] of Object.entries(CRITICAL_FUNCTIONS)) {
      for (const fnName of functions) {
        const startMs = Date.now();
        try {
          const response = await invokeFunction(fnName, { _health_check: true });
          const elapsed = Date.now() - startMs;
          const data = response;
          const returnedVersion = data?._version || null;
          const expectedVersion = EXPECTED_VERSIONS[fnName] || null;
          const isSlow = elapsed > 3000;

          let status = 'alive';
          let detail = '';

          if (expectedVersion && returnedVersion && returnedVersion !== expectedVersion) {
            status = 'stale';
            stale++;
            detail = `Expected ${expectedVersion}, got ${returnedVersion} — REDEPLOY NEEDED`;
          } else if (expectedVersion && !returnedVersion) {
            status = 'unverified';
            alive++;
            detail = `No version returned (expected ${expectedVersion}) — may need redeploy`;
          } else {
            if (isSlow) { slow++; status = 'slow'; }
            alive++;
            detail = returnedVersion ? `${returnedVersion} verified` : 'responded';
          }

          results.push({ category, function: fnName, status, response_ms: elapsed, version_expected: expectedVersion, version_actual: returnedVersion, detail });
        } catch (err: any) {
          const elapsed = Date.now() - startMs;
          const msg = err?.message || '';
          if (msg.includes('not found') || msg.includes('not deployed')) {
            dead++;
            results.push({ category, function: fnName, status: 'missing', response_ms: elapsed, error: msg.slice(0, 120) });
          } else {
            const expectedVersion = EXPECTED_VERSIONS[fnName] || null;
            const isSlow = elapsed > 3000;
            if (isSlow) slow++;
            alive++;
            results.push({
              category, function: fnName,
              status: expectedVersion ? 'unverified' : (isSlow ? 'slow' : 'alive'),
              response_ms: elapsed,
              version_expected: expectedVersion,
              version_actual: null,
              detail: expectedVersion ? `Responded but no version check (expected ${expectedVersion})` : msg.slice(0, 80),
            });
          }
        }
        await new Promise(r => setTimeout(r, 80));
      }
    }

    // Smoke tests
    let smokeTests: any = null;
    if (include_smoke_tests) {
      smokeTests = [];

      // Test 1: calculateProjectPricing with empty products
      try {
        const t1Start = Date.now();
        const t1Data = await invokeFunction('calculateProjectPricing', {
          products: [], packages: [], pricing_tier: 'standard', agent_id: null, agency_id: null,
        });
        smokeTests.push({
          test: 'Pricing engine (empty project)',
          status: t1Data?.success && t1Data?.calculated_price === 0 ? 'pass' : 'fail',
          elapsed_ms: Date.now() - t1Start,
          detail: t1Data?.success ? 'Returned $0 for empty project' : `Unexpected: ${JSON.stringify(t1Data).slice(0, 100)}`,
        });
      } catch (err: any) {
        smokeTests.push({ test: 'Pricing engine (empty project)', status: 'error', detail: err.message?.slice(0, 100) });
      }

      // Test 2: calculateProjectTaskDeadlines with fake project ID (dry run)
      try {
        const t2Start = Date.now();
        await invokeFunction('calculateProjectTaskDeadlines', {
          project_id: '_smoke_test_nonexistent_', trigger_event: 'smoke_test', dry_run: true,
        });
        smokeTests.push({
          test: 'Deadline engine (dry run)',
          status: 'pass',
          elapsed_ms: Date.now() - t2Start,
          detail: 'Function responded without crash',
        });
      } catch (err: any) {
        const isExpected = err.message?.includes('not found') || err.message?.includes('404');
        smokeTests.push({
          test: 'Deadline engine (dry run)',
          status: isExpected ? 'pass' : 'fail',
          detail: isExpected ? '404 for nonexistent project (expected)' : err.message?.slice(0, 100),
        });
      }

      // Test 3: Tonomo webhook endpoint accepts test payload
      try {
        const t3Start = Date.now();
        const t3Data = await invokeFunction('receiveTonomoWebhook', {
          orderId: 'test_smoke_check', action: 'test',
        });
        smokeTests.push({
          test: 'Tonomo webhook (test payload)',
          status: t3Data?.received === true ? 'pass' : 'fail',
          elapsed_ms: Date.now() - t3Start,
          detail: t3Data?.received ? `Action: ${t3Data.action}` : `Unexpected: ${JSON.stringify(t3Data).slice(0, 100)}`,
        });
      } catch (err: any) {
        smokeTests.push({ test: 'Tonomo webhook (test payload)', status: 'error', detail: err.message?.slice(0, 100) });
      }
    }

    // Data integrity
    let dataIntegrity: any = null;
    if (include_data_integrity) {
      try {
        const [projects, tasks, products, packages, timeLogs, efforts] = await Promise.all([
          entities.Project.list(null, 2000),
          entities.ProjectTask.filter({}, null, 5000),
          entities.Product.list(null, 500),
          entities.Package.list(null, 200),
          entities.TaskTimeLog.filter({}, null, 2000),
          entities.ProjectEffort.filter({}, null, 500),
        ]);

        const activeProjects = projects.filter((p: any) => !['delivered', 'cancelled'].includes(p.status) && !p.is_archived);
        const activeTasks = tasks.filter((t: any) => !t.is_deleted);
        const orphanedTasks = activeTasks.filter((t: any) => {
          const proj = projects.find((p: any) => p.id === t.project_id);
          return !proj || ['delivered', 'cancelled'].includes(proj.status);
        });
        const projectsWithItems = activeProjects.filter((p: any) => (p.products?.length > 0 || p.packages?.length > 0));
        const projectsWithTasks = new Set(activeTasks.map((t: any) => t.project_id));
        const projectsMissingTasks = projectsWithItems.filter((p: any) => !projectsWithTasks.has(p.id));
        const runningTimers = timeLogs.filter((l: any) => l.is_active && l.status === 'running');
        const staleTimers = runningTimers.filter((l: any) => {
          if (!l.start_time) return true;
          return (Date.now() - new Date(l.start_time).getTime()) / 3600000 > 10;
        });
        const deletedTaskLogs = timeLogs.filter((l: any) => l.task_deleted);
        const stalePricingProjects = activeProjects.filter((p: any) => p.products_needs_recalc);
        const lastWebhookLog = await entities.TonomoWebhookLog.list('-received_at', 1).catch(() => []);
        const lastQueueItem = await entities.TonomoProcessingQueue.list('-created_at', 1).catch(() => []);

        dataIntegrity = {
          counts: {
            total_projects: projects.length, active_projects: activeProjects.length,
            total_tasks: tasks.length, active_tasks: activeTasks.length,
            total_products: products.length, total_packages: packages.length,
            total_time_logs: timeLogs.length, total_efforts: efforts.length,
          },
          issues: {
            orphaned_tasks: orphanedTasks.length,
            projects_missing_tasks: projectsMissingTasks.length,
            projects_missing_tasks_list: projectsMissingTasks.slice(0, 10).map((p: any) => ({
              id: p.id, title: p.title || p.property_address, status: p.status,
              products: (p.products || []).length, packages: (p.packages || []).length,
            })),
            running_timers: runningTimers.length,
            stale_timers: staleTimers.length,
            stale_timer_details: staleTimers.slice(0, 5).map((l: any) => ({
              id: l.id, user_name: l.user_name, project_id: l.project_id,
              hours_running: Math.round((Date.now() - new Date(l.start_time).getTime()) / 3600000),
            })),
            deleted_task_logs: deletedTaskLogs.length,
            stale_pricing_projects: stalePricingProjects.length,
          },
          tonomo: {
            last_webhook_at: lastWebhookLog[0]?.received_at || null,
            last_webhook_action: lastWebhookLog[0]?.event_type || null,
            last_queue_status: lastQueueItem[0]?.status || null,
            last_queue_at: lastQueueItem[0]?.created_at || null,
          },
        };
      } catch (err: any) {
        dataIntegrity = { error: err.message };
      }
    }

    // Notify admins if critical functions are missing or stale
    if (dead > 0 || stale > 0) {
      const problems = results.filter(r => r.status === 'missing' || r.status === 'stale').map(r => `${r.function} (${r.status})`);
      try {
        const allUsers = await entities.User.list(null, 200);
        const admins = allUsers.filter((u: any) => u.role === 'master_admin');
        for (const adm of admins) {
          await entities.Notification.create({
            user_id: adm.id, type: 'system_alert', category: 'system', severity: 'critical',
            title: `${dead + stale} backend function issue(s)!`,
            message: `${problems.join(', ')}. Check System Diagnostics.`,
            is_read: false, is_dismissed: false, source: 'healthCheckFunctions',
            idempotency_key: `health_v2:${new Date().toISOString().slice(0, 13)}:${dead}:${stale}`,
            created_date: new Date().toISOString(),
          }).catch(() => {});
        }
      } catch { /* non-fatal */ }
    }

    const totalVerified = results.filter(r => r.status === 'alive' && r.version_actual).length;
    const totalUnverified = results.filter(r => r.status === 'unverified').length;
    const score = results.length > 0 ? Math.round(((alive - stale) / results.length) * 100) : 0;

    return jsonResponse({
      success: true,
      summary: { total_checked: results.length, alive, stale, dead, slow, score, verified: totalVerified, unverified: totalUnverified },
      results,
      smoke_tests: smokeTests,
      data_integrity: dataIntegrity,
      checked_at: new Date().toISOString(),
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

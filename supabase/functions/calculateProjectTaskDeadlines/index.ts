import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

// ─── INLINED TIMEZONE + DEADLINE ENGINE ──────────────────────────────────────
const APP_TIMEZONE = 'Australia/Sydney';

function getLocalDateComponents(utcInstant: any, timezone: string) {
  const d = new Date(utcInstant);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '0';
  const hour = parseInt(get('hour')) % 24;
  const wdMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: parseInt(get('year')), month0: parseInt(get('month')) - 1, day: parseInt(get('day')),
    hour, minute: parseInt(get('minute')), second: parseInt(get('second')),
    weekday0: wdMap[get('weekday')] ?? -1
  };
}

function wallClockToUTC(year: number, month0: number, day: number, hours: number, minutes: number, seconds: number, timezone: string) {
  const targetLocalMs = Date.UTC(year, month0, day, hours, minutes, seconds);
  let utcMs = targetLocalMs;
  for (let i = 0; i < 5; i++) {
    const c = getLocalDateComponents(utcMs, timezone);
    const shown = Date.UTC(c.year, c.month0, c.day, c.hour, c.minute, c.second);
    const diff = shown - targetLocalMs;
    if (diff === 0) break;
    utcMs -= diff;
  }
  return new Date(utcMs);
}

function addLocalDays(year: number, month0: number, day: number, n: number) {
  const d = new Date(Date.UTC(year, month0, day, 12, 0, 0));
  d.setUTCDate(d.getUTCDate() + n);
  return { year: d.getUTCFullYear(), month0: d.getUTCMonth(), day: d.getUTCDate() };
}

function localWeekday(year: number, month0: number, day: number) {
  return new Date(Date.UTC(year, month0, day, 12, 0, 0)).getUTCDay();
}

function isBusinessDay(wd: number) { return wd >= 1 && wd <= 5; }

function nextBusinessDay(year: number, month0: number, day: number, n = 1) {
  let cur = { year, month0, day }; let count = 0;
  while (count < n) {
    cur = addLocalDays(cur.year, cur.month0, cur.day, 1);
    if (isBusinessDay(localWeekday(cur.year, cur.month0, cur.day))) count++;
  }
  return cur;
}

function calculatePresetDeadline(preset: string, triggerDate: any, timezone = APP_TIMEZONE) {
  const trigger = new Date(triggerDate);
  if (isNaN(trigger.getTime())) return null;
  const lc = getLocalDateComponents(trigger, timezone);
  const dl = (y: number, m0: number, d: number, h: number, mi: number, s: number) => wallClockToUTC(y, m0, d, h, mi, s, timezone);
  const sameDayOrNext = (h: number, mi: number, s: number) => {
    const c = dl(lc.year, lc.month0, lc.day, h, mi, s);
    if (trigger >= c) { const nx = addLocalDays(lc.year, lc.month0, lc.day, 1); return dl(nx.year, nx.month0, nx.day, h, mi, s); }
    return c;
  };
  switch (preset) {
    case 'tonight': return sameDayOrNext(23, 59, 59);
    case 'tomorrow_night': { const n = addLocalDays(lc.year, lc.month0, lc.day, 1); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case 'tomorrow_am': { const n = addLocalDays(lc.year, lc.month0, lc.day, 1); return dl(n.year, n.month0, n.day, 9, 0, 0); }
    case 'tomorrow_business_am': { const n = nextBusinessDay(lc.year, lc.month0, lc.day, 1); return dl(n.year, n.month0, n.day, 9, 0, 0); }
    case 'in_2_nights': { const n = addLocalDays(lc.year, lc.month0, lc.day, 2); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case 'in_3_nights': { const n = addLocalDays(lc.year, lc.month0, lc.day, 3); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case 'in_4_nights': { const n = addLocalDays(lc.year, lc.month0, lc.day, 4); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case 'next_business_night': { const n = nextBusinessDay(lc.year, lc.month0, lc.day, 1); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case '2_business_nights': { const n = nextBusinessDay(lc.year, lc.month0, lc.day, 2); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    case '3_business_nights': { const n = nextBusinessDay(lc.year, lc.month0, lc.day, 3); return dl(n.year, n.month0, n.day, 23, 59, 59); }
    default: return null;
  }
}

function isTriggerConditionMet(triggerType: string, project: any) {
  if (!triggerType || triggerType === 'none') return false;
  switch (triggerType) {
    case 'project_onsite': return project?.status === 'onsite' || !!project?.shooting_started_at;
    case 'project_uploaded': return project?.status === 'uploaded';
    case 'project_submitted': return project?.status === 'submitted';
    default: return false;
  }
}

function getTriggerTime(triggerType: string, project: any) {
  if (!isTriggerConditionMet(triggerType, project)) return null;
  switch (triggerType) {
    case 'project_onsite': return project?.shooting_started_at || project?.last_status_change || null;
    case 'project_uploaded':
    case 'project_submitted': return project?.last_status_change || null;
    default: return null;
  }
}

function hasCyclicDependency(task: any, allTasks: any[], visited = new Set(), stack = new Set()): boolean {
  visited.add(task.id); stack.add(task.id);
  for (const depId of (task.depends_on_task_ids || [])) {
    if (!visited.has(depId)) {
      const dep = allTasks.find(t => t.id === depId);
      if (dep && hasCyclicDependency(dep, allTasks, visited, stack)) return true;
    } else if (stack.has(depId)) return true;
  }
  stack.delete(task.id); return false;
}

function areDependenciesComplete(task: any, allTasks: any[]) {
  if (!task.depends_on_task_ids?.length) return true;
  if (task.depends_on_task_ids.includes(task.id)) return false;
  if (hasCyclicDependency(task, allTasks)) return false;
  return task.depends_on_task_ids.every((depId: string) => {
    const dep = allTasks.find(t => t.id === depId);
    if (!dep || dep.is_deleted) return true;
    return dep.is_completed === true;
  });
}

function calculateDeadlineForTask(task: any, triggerTime: string, timezone = APP_TIMEZONE) {
  const trigger = new Date(triggerTime);
  if (task.deadline_type === 'preset' && task.deadline_preset) {
    const deadline = calculatePresetDeadline(task.deadline_preset, trigger, timezone);
    return deadline ? deadline.toISOString() : null;
  }
  const hoursToAdd = task.deadline_hours_after_trigger || 0;
  return new Date(trigger.getTime() + hoursToAdd * 60 * 60 * 1000).toISOString();
}

function calculateTaskState(task: any, project: any, allTasks: any[], timezone = APP_TIMEZONE) {
  const result: any = { taskId: task.id, is_blocked: false, due_date: task.due_date, shouldUpdate: false };

  if (task.is_completed) { result.is_blocked = false; return result; }
  if (!task?.id) return result;

  const hasDependencies = task.depends_on_task_ids && task.depends_on_task_ids.length > 0;
  const hasTrigger = task.timer_trigger && task.timer_trigger !== 'none';

  let blockedByDependencies = false;

  if (hasDependencies) {
    if (hasCyclicDependency(task, allTasks)) {
      result.is_blocked = true; result.shouldUpdate = true; return result;
    }
    blockedByDependencies = !areDependenciesComplete(task, allTasks);
  }

  let blockedByTrigger = false;

  if (hasTrigger) {
    if (task.timer_trigger === 'dependencies_cleared') {
      blockedByTrigger = blockedByDependencies;
      if (!blockedByDependencies && !task.due_date) {
        result.due_date = calculateDeadlineForTask(task, new Date().toISOString(), timezone);
        result.shouldUpdate = true;
      }
    } else {
      const triggerMet = isTriggerConditionMet(task.timer_trigger, project);
      blockedByTrigger = !triggerMet;

      if (triggerMet) {
        const triggerTime = getTriggerTime(task.timer_trigger, project);
        if (!triggerTime) {
          blockedByTrigger = true;
        } else if (!task.due_date) {
          const freshDeadline = calculateDeadlineForTask(task, triggerTime, timezone);
          if (freshDeadline !== task.due_date) {
            result.due_date = freshDeadline;
            result.shouldUpdate = true;
          }
        }
      } else if (task.due_date && task.auto_generated) {
        result.due_date = null;
        result.shouldUpdate = true;
      }
    }
  }

  result.is_blocked = blockedByDependencies || blockedByTrigger;
  if (result.is_blocked !== task.is_blocked) result.shouldUpdate = true;

  return result;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.1', _fn: 'calculateProjectTaskDeadlines', _ts: '2026-03-17' });
    }

    const { project_id, trigger_event, dry_run = false } = body;

    if (!project_id) return jsonResponse({ error: 'project_id is required' }, 400);

    let project: any, allTasks: any[];
    try {
      project = await entities.Project.get(project_id);
      if (!project) return jsonResponse({ error: 'Project not found' }, 404);
      allTasks = await entities.ProjectTask.filter({ project_id });
    } catch (err: any) {
      if (err.status === 404) return jsonResponse({ error: 'Project not found' }, 404);
      if (err.status === 429) {
        return jsonResponse({ success: true, updated_count: 0, total_tasks: 0, note: 'Rate limited' });
      }
      throw err;
    }

    const stateChanges: any[] = [];
    const debugInfo: any[] = [];

    for (const task of allTasks) {
      if (!task?.id || !task?.title) { console.warn('Skipping malformed task:', task); continue; }
      if (task.is_manually_set_due_date) continue;
      const newState = calculateTaskState(task, project, allTasks, APP_TIMEZONE);
      if (newState.shouldUpdate) {
        stateChanges.push({
          id: task.id,
          title: task.title,
          data: {
            is_blocked: newState.is_blocked,
            ...(newState.due_date !== task.due_date && { due_date: newState.due_date })
          }
        });
      }
      debugInfo.push({
        taskId: task.id, title: task.title,
        wasBlocked: task.is_blocked, isBlocked: newState.is_blocked,
        hasTrigger: !!(task.timer_trigger && task.timer_trigger !== 'none'),
        triggerType: task.timer_trigger,
        hasDependencies: !!(task.depends_on_task_ids?.length)
      });
    }

    if (dry_run) {
      return jsonResponse({ success: true, dry_run: true, would_update_count: stateChanges.length, changes: stateChanges, debug: debugInfo });
    }

    const results: any = { success: 0, failed: 0, errors: [] as any[] };

    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try { return await fn(); } catch (err: any) {
          if (err.status === 429 && attempt < maxRetries) {
            await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 80));
            continue;
          }
          throw err;
        }
      }
    };

    const batchSize = 5;
    for (let i = 0; i < stateChanges.length; i += batchSize) {
      const batch = stateChanges.slice(i, i + batchSize);
      await Promise.all(batch.map(async (change: any) => {
        try {
          await retryWithBackoff(() => entities.ProjectTask.update(change.id, change.data));
          results.success++;
        } catch (err: any) {
          results.failed++;
          results.errors.push({ taskId: change.id, taskTitle: change.title, error: err.message });
          console.error(`Failed to update task ${change.id}:`, err.message);
        }
      }));
    }

    return jsonResponse({
      success: true,
      trigger_event: trigger_event || 'manual',
      updated_count: results.success,
      failed_count: results.failed,
      total_tasks: allTasks.length,
      errors: results.errors.length > 0 ? results.errors : undefined
    });
  } catch (error: any) {
    console.error('Error calculating task states:', error);
    return errorResponse(error.message);
  }
});

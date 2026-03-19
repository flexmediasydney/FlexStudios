import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

// ============================================================
// INLINE COPIES of core logic (to test exactly what runs)
// ============================================================

function isTriggerConditionMet(triggerType, project) {
  if (!triggerType || triggerType === 'none') return false;
  switch (triggerType) {
    case 'project_onsite':   return project?.status === 'onsite' || !!project?.shooting_started_at;
    case 'project_uploaded': return project?.status === 'uploaded';
    case 'project_submitted':return project?.status === 'submitted';
    case 'dependencies_cleared': return false; // handled separately
    default: return false;
  }
}

function getTriggerTime(triggerType, project) {
  if (!isTriggerConditionMet(triggerType, project)) return null;
  switch (triggerType) {
    case 'project_onsite':   return project?.shooting_started_at || project?.last_status_change || null;
    case 'project_uploaded':
    case 'project_submitted':return project?.last_status_change || null;
    default: return null;
  }
}

function hasCyclicDependency(task, allTasks, visited = new Set(), stack = new Set()) {
  visited.add(task.id);
  stack.add(task.id);
  for (const depId of (task.depends_on_task_ids || [])) {
    if (!visited.has(depId)) {
      const dep = allTasks.find(t => t.id === depId);
      if (dep && hasCyclicDependency(dep, allTasks, visited, stack)) return true;
    } else if (stack.has(depId)) return true;
  }
  stack.delete(task.id);
  return false;
}

function areDependenciesComplete(task, allTasks) {
  if (!task.depends_on_task_ids || task.depends_on_task_ids.length === 0) return true;
  if (task.depends_on_task_ids.includes(task.id)) return false;
  if (hasCyclicDependency(task, allTasks)) return false;
  return task.depends_on_task_ids.every(depId => {
    const dep = allTasks.find(t => t.id === depId);
    return dep && dep.is_completed === true;
  });
}

function calculateTaskState(task, project, allTasks) {
  const result = { taskId: task.id, is_blocked: false, due_date: task.due_date, deadline_set: false };

  if (task.is_completed) return result;

  const hasDependencies = task.depends_on_task_ids && task.depends_on_task_ids.length > 0;

  if (hasDependencies) {
    if (hasCyclicDependency(task, allTasks)) { result.is_blocked = true; result.cycle = true; return result; }
    result.is_blocked = !areDependenciesComplete(task, allTasks);

    if (!result.is_blocked && task.timer_trigger === 'dependencies_cleared' && !task.due_date) {
      result.due_date = new Date().toISOString();
      result.deadline_set = true;
    }
    return result;
  }

  if (!task.timer_trigger || task.timer_trigger === 'none') {
    result.is_blocked = false;
    return result;
  }

  const triggerMet = isTriggerConditionMet(task.timer_trigger, project);
  result.is_blocked = !triggerMet;

  if (triggerMet && !task.due_date) {
    const triggerTime = getTriggerTime(task.timer_trigger, project);
    if (triggerTime) {
      result.due_date = new Date(new Date(triggerTime).getTime() + (task.deadline_hours_after_trigger || 4) * 3600000).toISOString();
      result.deadline_set = true;
    } else {
      result.is_blocked = true;
    }
  }

  return result;
}

// ============================================================
// TEST HARNESS
// ============================================================

function test(name, fn) {
  try {
    const result = fn();
    if (result === true) return { name, pass: true };
    return { name, pass: false, reason: result || 'Returned falsy' };
  } catch (e) {
    return { name, pass: false, reason: e.message };
  }
}

function expect(val, expected, msg) {
  if (JSON.stringify(val) !== JSON.stringify(expected)) {
    throw new Error(`${msg || ''}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(val)}`);
  }
}

Deno.serve(async (req) => {
  const base44 = createClientFromRequest(req);
  const user = await base44.auth.me();
  if (!user) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (user.role !== 'master_admin') return Response.json({ error: 'Admin access required' }, { status: 403 });

  const NOW = new Date().toISOString();
  const results = [];

  // ─── PROJECT FIXTURE HELPERS ───────────────────────────────
  const proj_none        = { id: 'p1', status: 'to_be_scheduled' };
  const proj_onsite      = { id: 'p2', status: 'onsite', shooting_started_at: NOW, last_status_change: NOW };
  const proj_onsite_nostime = { id: 'p3', status: 'onsite', last_status_change: NOW }; // no shooting_started_at
  const proj_uploaded    = { id: 'p4', status: 'uploaded', last_status_change: NOW };
  const proj_submitted   = { id: 'p5', status: 'submitted', last_status_change: NOW };

  // ─── SCENARIO 1: No trigger, no deps → always unblocked ───────
  results.push(test('No trigger + no deps → not blocked', () => {
    const task = { id: 't1', title: 'T1', timer_trigger: 'none', depends_on_task_ids: [], due_date: null };
    const s = calculateTaskState(task, proj_none, [task]);
    expect(s.is_blocked, false, 'should not be blocked');
    return true;
  }));

  // ─── SCENARIO 2: project_onsite trigger, project NOT onsite → blocked ──
  results.push(test('project_onsite trigger + project scheduled → BLOCKED', () => {
    const task = { id: 't2', title: 'Edit Photos', timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, proj_none, [task]);
    expect(s.is_blocked, true, 'should be blocked');
    expect(s.deadline_set, false, 'should not have deadline yet');
    return true;
  }));

  // ─── SCENARIO 3: project_onsite trigger, project IS onsite → unblocked + deadline ──
  results.push(test('project_onsite trigger + project onsite → UNBLOCKED + deadline set', () => {
    const task = { id: 't3', title: 'Edit Photos', timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, proj_onsite, [task]);
    expect(s.is_blocked, false, 'should not be blocked');
    expect(s.deadline_set, true, 'should have deadline');
    if (!s.due_date) throw new Error('due_date not set');
    const diff = new Date(s.due_date) - new Date(NOW);
    if (Math.abs(diff - 4 * 3600000) > 5000) throw new Error(`Deadline should be ~4h after trigger, got ${diff}ms`);
    return true;
  }));

  // ─── SCENARIO 4: project_onsite, shooting_started_at (not last_status_change) ──
  results.push(test('project_onsite uses shooting_started_at as trigger time', () => {
    const earlier = new Date(Date.now() - 2 * 3600000).toISOString(); // 2 hours ago
    const project = { id: 'px', status: 'onsite', shooting_started_at: earlier, last_status_change: NOW };
    const task = { id: 'tx', timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 6 };
    const s = calculateTaskState(task, project, [task]);
    expect(s.is_blocked, false, 'should not be blocked');
    if (!s.due_date) throw new Error('no due_date');
    const expected = new Date(earlier).getTime() + 6 * 3600000;
    const diff = Math.abs(new Date(s.due_date).getTime() - expected);
    if (diff > 5000) throw new Error(`Expected deadline based on shooting_started_at, diff=${diff}ms`);
    return true;
  }));

  // ─── SCENARIO 5: project_uploaded trigger ──────────────────────
  results.push(test('project_uploaded trigger + project NOT uploaded → BLOCKED', () => {
    const task = { id: 't5', timer_trigger: 'project_uploaded', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 8 };
    const s = calculateTaskState(task, proj_onsite, [task]);
    expect(s.is_blocked, true);
    return true;
  }));

  results.push(test('project_uploaded trigger + project uploaded → UNBLOCKED + deadline', () => {
    const task = { id: 't5b', timer_trigger: 'project_uploaded', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 8 };
    const s = calculateTaskState(task, proj_uploaded, [task]);
    expect(s.is_blocked, false);
    expect(s.deadline_set, true);
    return true;
  }));

  // ─── SCENARIO 6: project_submitted trigger ─────────────────────
  results.push(test('project_submitted trigger + project submitted → UNBLOCKED + deadline', () => {
    const task = { id: 't6', timer_trigger: 'project_submitted', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 12 };
    const s = calculateTaskState(task, proj_submitted, [task]);
    expect(s.is_blocked, false);
    expect(s.deadline_set, true);
    return true;
  }));

  // ─── SCENARIO 7: Trigger met but already HAS a due_date → don't overwrite ──
  results.push(test('Trigger met but task already has due_date → no overwrite', () => {
    const existingDate = '2026-03-10T09:00:00.000Z';
    const task = { id: 't7', timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: existingDate, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, proj_onsite, [task]);
    expect(s.is_blocked, false);
    expect(s.deadline_set, false, 'should not overwrite existing deadline');
    expect(s.due_date, existingDate, 'due_date should be unchanged');
    return true;
  }));

  // ─── SCENARIO 8: Completed task → never blocked ────────────────
  results.push(test('Completed task → never blocked regardless of trigger', () => {
    const task = { id: 't8', is_completed: true, timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: null };
    const s = calculateTaskState(task, proj_none, [task]);
    expect(s.is_blocked, false, 'completed tasks are never blocked');
    return true;
  }));

  // ─── SCENARIO 9: Dependency not complete → blocked ─────────────
  results.push(test('Task with incomplete dependency → BLOCKED', () => {
    const dep  = { id: 'dep1', title: 'Dep', is_completed: false, depends_on_task_ids: [] };
    const task = { id: 'child1', timer_trigger: 'none', depends_on_task_ids: ['dep1'], due_date: null };
    const s = calculateTaskState(task, proj_none, [dep, task]);
    expect(s.is_blocked, true, 'should be blocked by dependency');
    return true;
  }));

  // ─── SCENARIO 10: Dependency completed → unblocked ─────────────
  results.push(test('Task with completed dependency → UNBLOCKED', () => {
    const dep  = { id: 'dep2', title: 'Dep', is_completed: true, depends_on_task_ids: [] };
    const task = { id: 'child2', timer_trigger: 'none', depends_on_task_ids: ['dep2'], due_date: null };
    const s = calculateTaskState(task, proj_none, [dep, task]);
    expect(s.is_blocked, false);
    return true;
  }));

  // ─── SCENARIO 11: dependencies_cleared trigger ─────────────────
  results.push(test('dependencies_cleared + deps NOT done → BLOCKED, no deadline', () => {
    const dep  = { id: 'dep3', is_completed: false, depends_on_task_ids: [] };
    const task = { id: 'child3', timer_trigger: 'dependencies_cleared', depends_on_task_ids: ['dep3'], due_date: null, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, proj_none, [dep, task]);
    expect(s.is_blocked, true);
    expect(s.deadline_set, false);
    return true;
  }));

  results.push(test('dependencies_cleared + deps DONE → UNBLOCKED + deadline set NOW', () => {
    const dep  = { id: 'dep4', is_completed: true, depends_on_task_ids: [] };
    const task = { id: 'child4', timer_trigger: 'dependencies_cleared', depends_on_task_ids: ['dep4'], due_date: null, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, proj_none, [dep, task]);
    expect(s.is_blocked, false);
    expect(s.deadline_set, true);
    if (!s.due_date) throw new Error('due_date not set');
    return true;
  }));

  // ─── SCENARIO 12: Circular dependency → blocked ─────────────────
  results.push(test('Circular dependency A→B→A → both blocked', () => {
    const taskA = { id: 'A', timer_trigger: 'none', depends_on_task_ids: ['B'], is_completed: false };
    const taskB = { id: 'B', timer_trigger: 'none', depends_on_task_ids: ['A'], is_completed: false };
    const sA = calculateTaskState(taskA, proj_none, [taskA, taskB]);
    const sB = calculateTaskState(taskB, proj_none, [taskA, taskB]);
    expect(sA.is_blocked, true, 'A should be blocked');
    expect(sB.is_blocked, true, 'B should be blocked');
    return true;
  }));

  // ─── SCENARIO 13: Self-dependency → blocked ─────────────────────
  results.push(test('Self-dependency → blocked', () => {
    const task = { id: 'self1', timer_trigger: 'none', depends_on_task_ids: ['self1'], is_completed: false };
    const s = calculateTaskState(task, proj_none, [task]);
    expect(s.is_blocked, true, 'should be blocked (self-dep)');
    return true;
  }));

  // ─── SCENARIO 14: Chain A→B→C, only A done → C still blocked ───
  results.push(test('Chain A(done)→B(done)→C(pending) → C unblocked', () => {
    const A = { id: 'A', is_completed: true, depends_on_task_ids: [] };
    const B = { id: 'B', is_completed: true, depends_on_task_ids: ['A'] };
    const C = { id: 'C', is_completed: false, timer_trigger: 'none', depends_on_task_ids: ['B'] };
    const s = calculateTaskState(C, proj_none, [A, B, C]);
    expect(s.is_blocked, false, 'C should be unblocked when A and B are done');
    return true;
  }));

  results.push(test('Chain A(done)→B(pending)→C → C blocked by B', () => {
    const A = { id: 'A', is_completed: true, depends_on_task_ids: [] };
    const B = { id: 'B', is_completed: false, depends_on_task_ids: ['A'] };
    const C = { id: 'C', is_completed: false, timer_trigger: 'none', depends_on_task_ids: ['B'] };
    const s = calculateTaskState(C, proj_none, [A, B, C]);
    expect(s.is_blocked, true, 'C should be blocked because B not done');
    return true;
  }));

  // ─── SCENARIO 15: Missing dep task (orphan) → blocked ───────────
  results.push(test('Task depends on nonexistent task → BLOCKED', () => {
    const task = { id: 'orphan-child', timer_trigger: 'none', depends_on_task_ids: ['ghost-id'], is_completed: false };
    const s = calculateTaskState(task, proj_none, [task]);
    expect(s.is_blocked, true, 'should be blocked if dep task missing');
    return true;
  }));

  // ─── SCENARIO 16: project_onsite, no shooting_started_at, no last_status_change → blocked ──
  results.push(test('project_onsite + no trigger timestamp → BLOCKED (no deadline)', () => {
    const project = { id: 'px2', status: 'onsite' }; // no timestamps!
    const task = { id: 'tx2', timer_trigger: 'project_onsite', depends_on_task_ids: [], due_date: null, deadline_hours_after_trigger: 4 };
    const s = calculateTaskState(task, project, [task]);
    expect(s.is_blocked, true, 'should be blocked - no valid trigger time to base deadline on');
    expect(s.deadline_set, false);
    return true;
  }));

  // ─── SUMMARY ────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass);

  return Response.json({
    summary: `${passed}/${results.length} tests passed`,
    all_passed: failed.length === 0,
    results: results.map(r => ({
      name: r.name,
      status: r.pass ? '✅ PASS' : '❌ FAIL',
      ...(r.reason && { reason: r.reason })
    })),
    ...(failed.length > 0 && { failures: failed })
  });
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';
import { calculateTaskState } from './calculateTaskBlockingState.js';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const results = [];

    // =============================================================================
    // SCENARIO 1: Fresh project with no dependencies, trigger = project_onsite
    // Expected: All tasks blocked until project moves to onsite
    // =============================================================================
    results.push(await testScenario1(base44, user.email));

    // =============================================================================
    // SCENARIO 2: Dependencies chain - A -> B -> C
    // Expected: A unlocked, B blocked (waiting on A), C blocked (waiting on B)
    // Then: Complete A, B unlocks. Complete B, C unlocks.
    // =============================================================================
    results.push(await testScenario2(base44, user.email));

    // =============================================================================
    // SCENARIO 3: Multiple tasks with mixed triggers and dependencies
    // =============================================================================
    results.push(await testScenario3(base44, user.email));

    // =============================================================================
    // SCENARIO 4: Task with no trigger and no dependencies
    // Expected: Always unlocked
    // =============================================================================
    results.push(await testScenario4(base44, user.email));

    // =============================================================================
    // SCENARIO 5: Trigger + dependencies together
    // Expected: Task blocked until BOTH trigger is met AND deps complete
    // =============================================================================
    results.push(await testScenario5(base44, user.email));

    return Response.json({
      success: true,
      scenarios_tested: results.length,
      all_passed: results.every(r => r.passed),
      results
    });
  } catch (error) {
    console.error('Test error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function testScenario1(base44, userEmail) {
  const scenario = 'SCENARIO 1: Fresh project, all tasks blocked by trigger';
  
  try {
    // Create test project
    const project = await base44.entities.Project.create({
      title: 'Test Project 1',
      client_id: 'test-client',
      property_address: '123 Test St',
      status: 'to_be_scheduled'
    });

    // Create tasks with project_onsite trigger
    const task1 = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Upload Images',
      timer_trigger: 'project_onsite',
      deadline_type: 'custom',
      deadline_hours_after_trigger: 24
    });

    const task2 = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Edit Photos',
      timer_trigger: 'project_onsite',
      deadline_type: 'custom',
      deadline_hours_after_trigger: 48
    });

    // Calculate states with dry-run
    const checkStates = (step) => {
      const s1 = calculateTaskState(task1, project, [task1, task2]);
      const s2 = calculateTaskState(task2, project, [task1, task2]);
      return { step, task1: s1, task2: s2 };
    };

    const step1 = checkStates('Initial (status=to_be_scheduled)');
    const passed1 = !step1.task1.is_blocked === false && !step1.task2.is_blocked === false;
    
    // Update project to onsite
    await base44.entities.Project.update(project.id, { 
      status: 'onsite',
      shooting_started_at: new Date().toISOString()
    });

    // Reload project to get new state
    const updatedProject = await base44.entities.Project.get(project.id);
    const step2 = checkStates('After status=onsite');
    const s1AfterOnsite = calculateTaskState(task1, updatedProject, [task1, task2]);
    const s2AfterOnsite = calculateTaskState(task2, updatedProject, [task1, task2]);
    
    // After onsite, tasks should be unlocked and have deadlines
    const passed2 = !s1AfterOnsite.is_blocked && s1AfterOnsite.due_date;
    const passed3 = !s2AfterOnsite.is_blocked && s2AfterOnsite.due_date;

    // Cleanup
    await base44.entities.ProjectTask.delete(task1.id);
    await base44.entities.ProjectTask.delete(task2.id);
    await base44.entities.Project.delete(project.id);

    return {
      passed: passed1 && passed2 && passed3,
      scenario,
      steps: [step1, step2],
      assertions: [
        { desc: 'Tasks blocked initially', passed: passed1 },
        { desc: 'Task 1 unlocked after onsite trigger', passed: passed2 },
        { desc: 'Task 2 unlocked after onsite trigger', passed: passed3 }
      ]
    };
  } catch (error) {
    return {
      passed: false,
      scenario,
      error: error.message
    };
  }
}

async function testScenario2(base44, userEmail) {
  const scenario = 'SCENARIO 2: Dependency chain A -> B -> C';
  
  try {
    const project = await base44.entities.Project.create({
      title: 'Test Project 2',
      client_id: 'test-client',
      property_address: '123 Test St'
    });

    // Create tasks with dependencies
    const taskA = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Task A (no deps)',
      timer_trigger: 'none'
    });

    const taskB = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Task B (depends on A)',
      timer_trigger: 'none',
      depends_on_task_ids: [taskA.id]
    });

    const taskC = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Task C (depends on B)',
      timer_trigger: 'none',
      depends_on_task_ids: [taskB.id]
    });

    const allTasks = [taskA, taskB, taskC];

    // Step 1: Initial state
    const step1A = calculateTaskState(taskA, project, allTasks);
    const step1B = calculateTaskState(taskB, project, allTasks);
    const step1C = calculateTaskState(taskC, project, allTasks);

    const passed1A = !step1A.is_blocked; // A has no deps
    const passed1B = step1B.is_blocked && step1B.blocked_reason.includes('Task A');
    const passed1C = step1C.is_blocked && step1C.blocked_reason.includes('Task B');

    // Step 2: Complete A
    await base44.entities.ProjectTask.update(taskA.id, { is_completed: true });
    const completedA = await base44.entities.ProjectTask.get(taskA.id);

    const step2B = calculateTaskState(taskB, project, [completedA, taskB, taskC]);
    const step2C = calculateTaskState(taskC, project, [completedA, taskB, taskC]);

    const passed2B = !step2B.is_blocked; // A is done, B unlocks
    const passed2C = step2C.is_blocked; // B still incomplete

    // Step 3: Complete B
    await base44.entities.ProjectTask.update(taskB.id, { is_completed: true });
    const completedB = await base44.entities.ProjectTask.get(taskB.id);

    const step3C = calculateTaskState(taskC, project, [completedA, completedB, taskC]);
    const passed3C = !step3C.is_blocked; // B is done, C unlocks

    // Cleanup
    await base44.entities.ProjectTask.delete(taskA.id);
    await base44.entities.ProjectTask.delete(taskB.id);
    await base44.entities.ProjectTask.delete(taskC.id);
    await base44.entities.Project.delete(project.id);

    return {
      passed: passed1A && passed1B && passed1C && passed2B && passed2C && passed3C,
      scenario,
      assertions: [
        { desc: 'Task A initially unlocked (no deps)', passed: passed1A },
        { desc: 'Task B initially blocked (waits on A)', passed: passed1B },
        { desc: 'Task C initially blocked (waits on B)', passed: passed1C },
        { desc: 'Task B unlocked after A completes', passed: passed2B },
        { desc: 'Task C still blocked after A completes', passed: passed2C },
        { desc: 'Task C unlocked after B completes', passed: passed3C }
      ]
    };
  } catch (error) {
    return {
      passed: false,
      scenario,
      error: error.message
    };
  }
}

async function testScenario3(base44, userEmail) {
  const scenario = 'SCENARIO 3: Mixed triggers and dependencies';
  
  try {
    const project = await base44.entities.Project.create({
      title: 'Test Project 3',
      client_id: 'test-client',
      property_address: '123 Test St',
      status: 'to_be_scheduled'
    });

    const taskUpload = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Upload Images',
      timer_trigger: 'project_uploaded',
      deadline_type: 'custom',
      deadline_hours_after_trigger: 24
    });

    const taskReview = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Review Images',
      timer_trigger: 'none',
      depends_on_task_ids: [taskUpload.id]
    });

    const allTasks = [taskUpload, taskReview];

    // Both should be blocked initially
    const step1Upload = calculateTaskState(taskUpload, project, allTasks);
    const step1Review = calculateTaskState(taskReview, project, allTasks);

    const passed1Up = step1Upload.is_blocked;
    const passed1Rev = step1Review.is_blocked;

    // Move to uploaded
    await base44.entities.Project.update(project.id, { status: 'uploaded' });
    const updatedProject = await base44.entities.Project.get(project.id);

    const step2Upload = calculateTaskState(taskUpload, updatedProject, allTasks);
    const step2Review = calculateTaskState(taskReview, updatedProject, allTasks);

    const passed2Up = !step2Upload.is_blocked && step2Upload.due_date;
    const passed2Rev = step2Review.is_blocked; // Still blocked, waiting on Upload to complete

    // Complete upload
    await base44.entities.ProjectTask.update(taskUpload.id, { is_completed: true });
    const completedUpload = await base44.entities.ProjectTask.get(taskUpload.id);

    const step3Review = calculateTaskState(taskReview, updatedProject, [completedUpload, taskReview]);
    const passed3Rev = !step3Review.is_blocked; // Now can review

    // Cleanup
    await base44.entities.ProjectTask.delete(taskUpload.id);
    await base44.entities.ProjectTask.delete(taskReview.id);
    await base44.entities.Project.delete(project.id);

    return {
      passed: passed1Up && passed1Rev && passed2Up && passed2Rev && passed3Rev,
      scenario,
      assertions: [
        { desc: 'Upload blocked initially (trigger not met)', passed: passed1Up },
        { desc: 'Review blocked initially (dep + trigger not met)', passed: passed1Rev },
        { desc: 'Upload unlocked after project_uploaded', passed: passed2Up },
        { desc: 'Review still blocked (upload incomplete)', passed: passed2Rev },
        { desc: 'Review unlocked after upload completes', passed: passed3Rev }
      ]
    };
  } catch (error) {
    return {
      passed: false,
      scenario,
      error: error.message
    };
  }
}

async function testScenario4(base44, userEmail) {
  const scenario = 'SCENARIO 4: Task with no trigger, no dependencies';
  
  try {
    const project = await base44.entities.Project.create({
      title: 'Test Project 4',
      client_id: 'test-client',
      property_address: '123 Test St'
    });

    const task = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Manual Task',
      timer_trigger: 'none'
    });

    const state = calculateTaskState(task, project, [task]);
    const passed = !state.is_blocked;

    // Cleanup
    await base44.entities.ProjectTask.delete(task.id);
    await base44.entities.Project.delete(project.id);

    return {
      passed,
      scenario,
      assertions: [
        { desc: 'Manual task always unlocked', passed }
      ]
    };
  } catch (error) {
    return {
      passed: false,
      scenario,
      error: error.message
    };
  }
}

async function testScenario5(base44, userEmail) {
  const scenario = 'SCENARIO 5: Trigger + dependencies together';
  
  try {
    const project = await base44.entities.Project.create({
      title: 'Test Project 5',
      client_id: 'test-client',
      property_address: '123 Test St',
      status: 'to_be_scheduled'
    });

    const taskSetup = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Setup',
      timer_trigger: 'none'
    });

    const taskShoot = await base44.entities.ProjectTask.create({
      project_id: project.id,
      title: 'Shoot',
      timer_trigger: 'project_onsite',
      depends_on_task_ids: [taskSetup.id]
    });

    const allTasks = [taskSetup, taskShoot];

    // Both conditions unmet - task blocked
    const step1 = calculateTaskState(taskShoot, project, allTasks);
    const passed1 = step1.is_blocked;

    // Move to onsite but setup not done - task still blocked
    await base44.entities.Project.update(project.id, { status: 'onsite' });
    const updatedProject = await base44.entities.Project.get(project.id);
    const step2 = calculateTaskState(taskShoot, updatedProject, allTasks);
    const passed2 = step2.is_blocked; // Trigger met but deps not

    // Complete setup - now unlocked
    await base44.entities.ProjectTask.update(taskSetup.id, { is_completed: true });
    const completedSetup = await base44.entities.ProjectTask.get(taskSetup.id);
    const step3 = calculateTaskState(taskShoot, updatedProject, [completedSetup, taskShoot]);
    const passed3 = !step3.is_blocked && step3.due_date;

    // Cleanup
    await base44.entities.ProjectTask.delete(taskSetup.id);
    await base44.entities.ProjectTask.delete(taskShoot.id);
    await base44.entities.Project.delete(project.id);

    return {
      passed: passed1 && passed2 && passed3,
      scenario,
      assertions: [
        { desc: 'Task blocked when both trigger and dep unmet', passed: passed1 },
        { desc: 'Task blocked when only trigger met (dep unmet)', passed: passed2 },
        { desc: 'Task unlocked when both trigger and dep met', passed: passed3 }
      ]
    };
  } catch (error) {
    return {
      passed: false,
      scenario,
      error: error.message
    };
  }
}
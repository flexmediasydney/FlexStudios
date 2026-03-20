import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Validates task dependencies to prevent:
 * - Self-dependencies (bug #3)
 * - Circular dependencies (bug #1, #9, #10)
 * - Orphaned dependencies (bug #15)
 * - Deletes with dependents (bug #4)
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json().catch(() => ({}));
    const { action, task_id, project_id, depends_on_task_ids = [] } = body;

    if (!action || !task_id || !project_id) {
      return Response.json({ error: 'action, task_id, project_id required' }, { status: 400 });
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

    const allTasks = await retryWithBackoff(() =>
      base44.entities.ProjectTask.filter({ project_id }, null, 1000)
    );
    const task = allTasks.find(t => t.id === task_id);

    if (!task) {
      return Response.json({ error: 'Task not found' }, { status: 404 });
    }

    // Action: check_add_dependency
    if (action === 'check_add_dependency') {
      const errors = [];

      if (!depends_on_task_ids || depends_on_task_ids.length === 0) {
        return Response.json({ valid: true });
      }

      for (const depId of depends_on_task_ids) {
        // Bug #3: Self-dependency
        if (depId === task_id) {
          errors.push(`Task cannot depend on itself`);
          continue;
        }

        // Bug #15: Orphaned dependency - use Map for O(1) lookup
          const depTask = allTasks.find(t => t.id === depId);
          if (!depTask) {
            errors.push(`Dependency task ${depId} does not exist`);
            continue;
          }

          // Bug #1: Circular dependency - check if adding this creates a cycle
          // Use taskMap for performance
          if (wouldCreateCycle(task, depId, allTasks, new Map(allTasks.map(t => [t.id, t])))) {
            errors.push(`Adding dependency would create a cycle`);
          }
      }

      if (errors.length > 0) {
        return Response.json({ valid: false, errors });
      }

      return Response.json({ valid: true });
    }

    // Action: check_delete_task
    if (action === 'check_delete_task') {
      // Bug #4: Warn if other tasks depend on this one
      const dependents = allTasks.filter(t => 
        t.depends_on_task_ids && t.depends_on_task_ids.includes(task_id)
      );

      if (dependents.length > 0) {
        return Response.json({ 
          can_delete: true,
          warning: `${dependents.length} task(s) depend on this one. They will become orphaned.`,
          dependent_tasks: dependents.map(t => ({ id: t.id, title: t.title }))
        });
      }

      return Response.json({ can_delete: true });
    }

    return Response.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    console.error('Error validating task dependencies:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});

/**
 * Detect if adding depId as a dependency would create a cycle
 * Returns true if cycle would be created
 * Uses taskMap for O(1) lookup performance
 */
function wouldCreateCycle(task, newDepId, allTasks, taskMap = null) {
   const map = taskMap || new Map(allTasks.map(t => [t.id, t]));
   const visited = new Set();
   const recursionStack = new Set();

   function hasCycleDFS(taskId) {
     visited.add(taskId);
     recursionStack.add(taskId);

     const currentTask = map.get(taskId);
     if (!currentTask || !currentTask.depends_on_task_ids) {
       recursionStack.delete(taskId);
       return false;
     }

     for (const depId of currentTask.depends_on_task_ids) {
       if (!visited.has(depId)) {
         if (hasCycleDFS(depId)) {
           return true;
         }
       } else if (recursionStack.has(depId)) {
         return true; // Back edge = cycle
       }
     }

     recursionStack.delete(taskId);
     return false;
   }

   // Check if newDepId already depends on task (would be a cycle)
   return hasCycleDFS(newDepId);
}

export { wouldCreateCycle };
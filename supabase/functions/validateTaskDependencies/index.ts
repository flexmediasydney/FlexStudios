import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Validates task dependencies to prevent:
 * - Self-dependencies
 * - Circular dependencies
 * - Orphaned dependencies
 * - Deletes with dependents
 */

/**
 * Detect if adding depId as a dependency would create a cycle.
 * Returns true if cycle would be created.
 * Uses taskMap for O(1) lookup performance.
 */
function wouldCreateCycle(task: any, newDepId: string, allTasks: any[], taskMap: Map<string, any> | null = null): boolean {
  const map = taskMap || new Map(allTasks.map((t: any) => [t.id, t]));
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function hasCycleDFS(taskId: string): boolean {
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

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    const body = await req.json().catch(() => ({}));
    const { action, task_id, project_id, depends_on_task_ids = [] } = body;

    if (!action || !task_id || !project_id) {
      return errorResponse('action, task_id, project_id required', 400);
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

    const allTasks = await retryWithBackoff(() =>
      entities.ProjectTask.filter({ project_id }, null, 1000)
    );
    const task = allTasks.find((t: any) => t.id === task_id);

    if (!task) {
      return errorResponse('Task not found', 404);
    }

    // Action: check_add_dependency
    if (action === 'check_add_dependency') {
      const errors: string[] = [];

      if (!depends_on_task_ids || depends_on_task_ids.length === 0) {
        return jsonResponse({ valid: true });
      }

      for (const depId of depends_on_task_ids) {
        // Self-dependency
        if (depId === task_id) {
          errors.push(`Task cannot depend on itself`);
          continue;
        }

        // Orphaned dependency
        const depTask = allTasks.find((t: any) => t.id === depId);
        if (!depTask) {
          errors.push(`Dependency task ${depId} does not exist`);
          continue;
        }

        // Circular dependency check
        if (wouldCreateCycle(task, depId, allTasks, new Map(allTasks.map((t: any) => [t.id, t])))) {
          errors.push(`Adding dependency would create a cycle`);
        }
      }

      if (errors.length > 0) {
        return jsonResponse({ valid: false, errors });
      }

      return jsonResponse({ valid: true });
    }

    // Action: check_delete_task
    if (action === 'check_delete_task') {
      const dependents = allTasks.filter((t: any) =>
        t.depends_on_task_ids && t.depends_on_task_ids.includes(task_id)
      );

      if (dependents.length > 0) {
        return jsonResponse({
          can_delete: true,
          warning: `${dependents.length} task(s) depend on this one. They will become orphaned.`,
          dependent_tasks: dependents.map((t: any) => ({ id: t.id, title: t.title })),
        });
      }

      return jsonResponse({ can_delete: true });
    }

    return errorResponse('Unknown action', 400);
  } catch (error: any) {
    console.error('Error validating task dependencies:', error);
    return errorResponse(error.message);
  }
});

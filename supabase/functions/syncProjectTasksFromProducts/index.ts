import { getAdminClient, getUserFromReq, createEntities, invokeFunction, handleCors, jsonResponse, errorResponse, isQuietHours } from '../_shared/supabase.ts';

function hasCycle(taskId: string, depsMap: Map<string, string[]>, visited = new Set<string>(), stack = new Set<string>()): boolean {
  if (stack.has(taskId)) return true;
  if (visited.has(taskId)) return false;
  visited.add(taskId);
  stack.add(taskId);
  for (const dep of (depsMap.get(taskId) || [])) {
    if (hasCycle(dep, depsMap, visited, stack)) return true;
  }
  stack.delete(taskId);
  return false;
}

async function _canNotify(entities: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    if (await isQuietHours(userId)) return false;
    const prefs = await entities.NotificationPreference.filter({ user_id: userId }, null, 50);
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    let requestBody;
    try { requestBody = await req.json(); } catch (err) {
      return jsonResponse({ error: 'Invalid JSON in request body' }, 400);
    }

    if (requestBody?._health_check) {
      return jsonResponse({ _version: 'v2.1', _fn: 'syncProjectTasksFromProducts', _ts: '2026-03-17' });
    }

    const { project_id } = requestBody;

    if (!project_id || typeof project_id !== 'string' || !project_id.trim()) {
      return jsonResponse({ error: 'project_id is required and must be a non-empty string' }, 400);
    }

    const project = await entities.Project.get(project_id);
    if (!project) {
      return jsonResponse({ error: 'Project not found' }, 404);
    }

    const pricingTier = project.pricing_tier || 'standard';
    const tierKey = pricingTier === 'premium' ? 'premium_task_templates' : 'standard_task_templates';

    const productSources = new Map();
    const packageProductInfo: any[] = [];

    if (project.products && Array.isArray(project.products)) {
      for (const item of project.products) {
        if (!productSources.has(item.product_id)) productSources.set(item.product_id, new Set());
        productSources.get(item.product_id).add('standalone');
      }
    }

    if (project.packages && Array.isArray(project.packages)) {
      for (const pkg of project.packages) {
        if (pkg.products && Array.isArray(pkg.products)) {
          for (const nestedProd of pkg.products) {
            packageProductInfo.push({ packageId: pkg.package_id, productId: nestedProd.product_id });
            if (!productSources.has(nestedProd.product_id)) productSources.set(nestedProd.product_id, new Set());
            productSources.get(nestedProd.product_id).add(pkg.package_id);
          }
        }
      }
    }

    const hasPackages = project.packages && project.packages.length > 0;
    if (productSources.size === 0 && !hasPackages) {
      return jsonResponse({ success: true, created_count: 0, skipped_count: 0 });
    }

    const retryWithBackoff = async (fn: () => Promise<any>, maxRetries = 2) => {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try { return await fn(); } catch (err: any) {
          if (err.status === 429 && attempt < maxRetries) {
            const delay = Math.pow(2, attempt) * 50;
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
          throw err;
        }
      }
    };

    const packageIdSet = new Set<string>();
    if (project.packages && Array.isArray(project.packages)) {
      for (const pkg of project.packages) packageIdSet.add(pkg.package_id);
    }

    const neededProductIds = [...productSources.keys()];
    const neededPackageIds = [...packageIdSet];

    const [fetchedProducts, fetchedPackages] = await Promise.all([
      neededProductIds.length > 0
        ? Promise.all(neededProductIds.map((id: string) => retryWithBackoff(() => entities.Product.get(id)).catch(() => null)))
        : Promise.resolve([]),
      neededPackageIds.length > 0
        ? Promise.all(neededPackageIds.map((id: string) => retryWithBackoff(() => entities.Package.get(id)).catch(() => null)))
        : Promise.resolve([]),
    ]);

    const productDataMap = new Map(fetchedProducts.filter(Boolean).map((p: any) => [p.id, p]));
    const packageDataMap = new Map(fetchedPackages.filter(Boolean).map((p: any) => [p.id, p]));

    const existingTasks = await retryWithBackoff(() => entities.ProjectTask.filter({ project_id }, null, 1000));
    const activeTaskTemplateIds = new Set(existingTasks.filter((t: any) => !t.is_deleted).map((t: any) => t.template_id).filter(Boolean));

    let createdCount = 0;
    let skippedCount = 0;
    const tasksToCreate: any[] = [];
    const pendingDependencies: any[] = [];

    const createTasksFromTemplates = (productId: string, templates: any[]) => {
      for (let idx = 0; idx < templates.length; idx++) {
        const template = templates[idx];
        const canonicalTemplateId = `product:${productId}:${pricingTier}:${idx}`;

        if (activeTaskTemplateIds.has(canonicalTemplateId)) {
          const existingTask = existingTasks.find((t: any) => t.template_id === canonicalTemplateId && !t.is_deleted);
          if (existingTask && typeof template.estimated_minutes === 'number') {
            const newEstimate = template.estimated_minutes;
            if (existingTask.estimated_minutes !== newEstimate) {
              retryWithBackoff(() => entities.ProjectTask.update(existingTask.id, { estimated_minutes: newEstimate }))
                .catch((err: any) => console.warn(`Failed to update estimated_minutes for task ${existingTask.id}:`, err.message));
            }
          }
          skippedCount++;
          continue;
        }

        const deletedTask = existingTasks.find((t: any) => t.template_id === canonicalTemplateId && t.is_deleted);
        if (deletedTask) {
          tasksToCreate.push({ type: 'reactivate', taskId: deletedTask.id });
          createdCount++;
          continue;
        }

        let assignedTo = null; let assignedToName = null;
        let assignedToTeamId = null; let assignedToTeamName = null;

        if (template.auto_assign_role && template.auto_assign_role !== 'none') {
          const roleKey = `${template.auto_assign_role}_id`;
          const roleNameKey = `${template.auto_assign_role}_name`;
          const roleTypeKey = `${template.auto_assign_role}_type`;
          assignedTo = project[roleKey] || null;
          assignedToName = project[roleNameKey] || null;
          if (project[roleTypeKey] === 'team') {
            assignedToTeamId = assignedTo; assignedToTeamName = assignedToName;
            assignedTo = null; assignedToName = null;
          }
          const productionRoles = ['photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
          if (!assignedTo && !assignedToTeamId && productionRoles.includes(template.auto_assign_role)) {
            assignedTo = project.project_owner_id || null;
            assignedToName = project.project_owner_name || null;
            if (project.project_owner_type === 'team') {
              assignedToTeamId = assignedTo; assignedToTeamName = assignedToName;
              assignedTo = null; assignedToName = null;
            }
          }
        }

        const dependsOnIndices = (template.depends_on_indices || []).map((i: number) => Math.round(i));
        if (dependsOnIndices.length > 0) {
          pendingDependencies.push({ taskArrayIndex: tasksToCreate.length, depends_on_template_indices: dependsOnIndices, productId });
        }

        tasksToCreate.push({
          type: 'create', project_id, title: template.title, description: template.description || '',
          assigned_to: assignedTo, assigned_to_name: assignedToName,
          assigned_to_team_id: assignedToTeamId, assigned_to_team_name: assignedToTeamName,
          auto_generated: true, template_id: canonicalTemplateId, product_id: productId,
          order: existingTasks.length + tasksToCreate.length,
          is_completed: false, depends_on_task_ids: [], is_blocked: false,
          auto_assign_role: template.auto_assign_role || 'none',
          estimated_minutes: typeof template.estimated_minutes === 'number' ? template.estimated_minutes : 0,
          timer_trigger: template.timer_trigger || 'none',
          deadline_type: template.deadline_type || 'custom',
          deadline_preset: template.deadline_preset || null,
          deadline_hours_after_trigger: template.deadline_hours_after_trigger || 0
        });
      }
    };

    for (const [productId, sources] of productSources) {
      const product = productDataMap.get(productId);
      if (!product) { console.warn(`Product ${productId} not found`); continue; }
      const templates = product[tierKey] || [];
      createTasksFromTemplates(productId, templates);
    }

    for (const packageId of packageIdSet) {
      const pkg = packageDataMap.get(packageId);
      if (!pkg) { console.warn(`Package ${packageId} not found`); continue; }
      const templates = pkg[tierKey] || [];
      for (let idx = 0; idx < templates.length; idx++) {
        const template = templates[idx];
        const canonicalTemplateId = `package:${packageId}:${pricingTier}:${idx}`;
        if (activeTaskTemplateIds.has(canonicalTemplateId)) {
          const existingTask = existingTasks.find((t: any) => t.template_id === canonicalTemplateId && !t.is_deleted);
          if (existingTask && typeof template.estimated_minutes === 'number') {
            const newEstimate = template.estimated_minutes;
            if (existingTask.estimated_minutes !== newEstimate) {
              retryWithBackoff(() => entities.ProjectTask.update(existingTask.id, { estimated_minutes: newEstimate }))
                .catch((err: any) => console.warn(`Failed to update estimated_minutes for task ${existingTask.id}:`, err.message));
            }
          }
          skippedCount++; continue;
        }
        const deletedPkgTask = existingTasks.find((t: any) => t.template_id === canonicalTemplateId && t.is_deleted);
        if (deletedPkgTask) { tasksToCreate.push({ type: 'reactivate', taskId: deletedPkgTask.id }); createdCount++; continue; }

        let assignedTo = null; let assignedToName = null;
        let assignedToTeamId = null; let assignedToTeamName = null;
        if (template.auto_assign_role && template.auto_assign_role !== 'none') {
          const roleKey = `${template.auto_assign_role}_id`;
          const roleNameKey = `${template.auto_assign_role}_name`;
          const roleTypeKey = `${template.auto_assign_role}_type`;
          assignedTo = project[roleKey] || null; assignedToName = project[roleNameKey] || null;
          if (project[roleTypeKey] === 'team') { assignedToTeamId = assignedTo; assignedToTeamName = assignedToName; assignedTo = null; assignedToName = null; }
          const productionRoles = ['photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
          if (!assignedTo && !assignedToTeamId && productionRoles.includes(template.auto_assign_role)) {
            assignedTo = project.project_owner_id || null; assignedToName = project.project_owner_name || null;
            if (project.project_owner_type === 'team') { assignedToTeamId = assignedTo; assignedToTeamName = assignedToName; assignedTo = null; assignedToName = null; }
          }
        }

        tasksToCreate.push({
          type: 'create', project_id, title: template.title, description: template.description || '',
          assigned_to: assignedTo, assigned_to_name: assignedToName,
          assigned_to_team_id: assignedToTeamId, assigned_to_team_name: assignedToTeamName,
          auto_generated: true, template_id: canonicalTemplateId, package_id: packageId,
          order: existingTasks.length + tasksToCreate.length,
          is_completed: false, depends_on_task_ids: [], is_blocked: false,
          auto_assign_role: template.auto_assign_role || 'none',
          estimated_minutes: typeof template.estimated_minutes === 'number' ? template.estimated_minutes : 0,
          timer_trigger: template.timer_trigger || 'none',
          deadline_type: template.deadline_type || 'custom',
          deadline_preset: template.deadline_preset || null,
          deadline_hours_after_trigger: template.deadline_hours_after_trigger || 0
        });
      }
    }

    // Clean up orphaned tasks
    const currentProductIds = new Set(productSources.keys());
    const currentPackageIds = packageIdSet;
    const orphanedTasks = existingTasks.filter((task: any) => {
      if (!task.auto_generated || task.is_deleted) return false;
      if (task.product_id && !currentProductIds.has(task.product_id)) return true;
      if (task.package_id && !currentPackageIds.has(task.package_id)) return true;
      return false;
    });

    // Tier migration
    const tierFrom = pricingTier === 'premium' ? 'standard' : 'premium';
    const tierMigrationTasks = existingTasks.filter((task: any) => {
      if (!task.auto_generated || task.is_deleted) return false;
      if (!task.template_id) return false;
      const migratedId = task.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`);
      return migratedId !== task.template_id;
    });

    const batchSize = 5;

    if (tierMigrationTasks.length > 0) {
      for (let i = 0; i < tierMigrationTasks.length; i += batchSize) {
        const batch = tierMigrationTasks.slice(i, i + batchSize);
        await Promise.all(batch.map((task: any) => {
          const newTemplateId = task.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`);
          return retryWithBackoff(() => entities.ProjectTask.update(task.id, { template_id: newTemplateId }))
            .catch((err: any) => console.error(`Failed to migrate task tier ${task.id}:`, err.message));
        }));
      }
      const migratedIds = tierMigrationTasks.map((t: any) => t.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`));
      migratedIds.forEach((id: string) => activeTaskTemplateIds.add(id));
      if (tierMigrationTasks.length > 0) {
        invokeFunction('calculateProjectTaskDeadlines', { project_id, trigger_event: 'tier_migration' }).catch(() => {});
      }
    }

    for (let i = 0; i < orphanedTasks.length; i += batchSize) {
      const batch = orphanedTasks.slice(i, i + batchSize);
      await Promise.all(batch.map((task: any) =>
        retryWithBackoff(() => entities.ProjectTask.update(task.id, { is_deleted: true }))
          .catch((err: any) => console.error(`Failed to soft-delete orphaned task ${task.id}:`, err.message))
      ));
    }

    // Unblock tasks that depend on any orphaned (now soft-deleted) task
    const orphanedIds = new Set(orphanedTasks.map((t: any) => t.id));
    if (orphanedIds.size > 0) {
      const dependentTasks = allTasks.filter((t: any) =>
        !t.is_deleted && (t.depends_on_task_ids || []).some((depId: string) => orphanedIds.has(depId))
      );
      for (const task of dependentTasks) {
        const cleaned = (task.depends_on_task_ids || []).filter((id: string) => !orphanedIds.has(id));
        await entities.ProjectTask.update(task.id, { depends_on_task_ids: cleaned }).catch(() => {});
      }
    }

    const tasksOnlyCreate = tasksToCreate.filter((t: any) => t.type === 'create').map(({ type, ...data }: any) => data);
    const tasksToReactivate = tasksToCreate.filter((t: any) => t.type === 'reactivate');

    if (tasksToReactivate.length > 0) {
      for (let i = 0; i < tasksToReactivate.length; i += batchSize) {
        const batch = tasksToReactivate.slice(i, i + batchSize);
        await Promise.all(batch.map((t: any) =>
          retryWithBackoff(() => entities.ProjectTask.update(t.taskId, { is_deleted: false, is_completed: false }))
            .catch((err: any) => console.error(`Failed to reactivate task ${t.taskId}:`, err.message))
        ));
      }
    }

    if (tasksOnlyCreate.length > 0) {
      const created: any[] = [];
      for (let i = 0; i < tasksOnlyCreate.length; i += batchSize) {
        const batch = tasksOnlyCreate.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map((taskData: any) =>
          retryWithBackoff(() => entities.ProjectTask.create(taskData))
            .catch((err: any) => { console.error(`Failed to create task "${taskData.title}":`, err.message); return null; })
        ));
        created.push(...batchResults.filter(Boolean));
        if (i + batchSize < tasksOnlyCreate.length) await new Promise(r => setTimeout(r, 50));
      }
      createdCount = created.length;

      // Resolve dependencies
      if (pendingDependencies.length > 0 && created.length > 0) {
        const templateToCreatedId = new Map(created.map((t: any) => [t.template_id, t.id]));
        const depUpdatePromises: { childId: string; depTaskIds: string[] }[] = [];
        for (const pending of pendingDependencies) {
          const childTemplateId = tasksOnlyCreate[pending.taskArrayIndex]?.template_id;
          const childId = childTemplateId ? templateToCreatedId.get(childTemplateId) : null;
          if (!childId) continue;
          const depTaskIds: string[] = [];
          for (const depIdx of pending.depends_on_template_indices) {
            const depTemplateId = `product:${pending.productId}:${pricingTier}:${depIdx}`;
            const depCreatedId = templateToCreatedId.get(depTemplateId);
            if (depCreatedId) { depTaskIds.push(depCreatedId); }
            else { const existing = existingTasks.find((t: any) => t.template_id === depTemplateId); if (existing) depTaskIds.push(existing.id); }
          }
          if (depTaskIds.length > 0) {
            depUpdatePromises.push({ childId, depTaskIds });
          }
        }
        // Cycle detection: build a dependency map and clear circular deps
        const depsMap = new Map<string, string[]>();
        for (const entry of depUpdatePromises) {
          depsMap.set(entry.childId, entry.depTaskIds);
        }
        for (const entry of depUpdatePromises) {
          if (hasCycle(entry.childId, depsMap)) {
            console.warn(`Circular dependency detected for task ${entry.childId}, clearing depends_on_task_ids`);
            entry.depTaskIds = [];
            depsMap.set(entry.childId, []);
          }
        }
        const depUpdateDbPromises: Promise<any>[] = depUpdatePromises
          .filter(entry => entry.depTaskIds.length > 0)
          .map(entry => entities.ProjectTask.update(entry.childId, { depends_on_task_ids: entry.depTaskIds, is_blocked: true }));
        if (depUpdateDbPromises.length > 0) {
          for (let di = 0; di < depUpdateDbPromises.length; di += batchSize) {
            await Promise.all(depUpdateDbPromises.slice(di, di + batchSize));
            if (di + batchSize < depUpdateDbPromises.length) await new Promise(r => setTimeout(r, 50));
          }
        }
      }

      // Recalculate effort inline
      if (tasksOnlyCreate.length > 0) {
        try {
          const [freshTimeLogs, freshTasks, existingEffortArr] = await Promise.all([
            entities.TaskTimeLog.filter({ project_id }, null, 1000),
            entities.ProjectTask.filter({ project_id }, null, 1000),
            entities.ProjectEffort.filter({ project_id }),
          ]);
          const activeTasks2 = freshTasks.filter((t: any) => !t.is_deleted);
          const estimatedByRole2: Record<string, number> = {};
          activeTasks2.forEach((task: any) => {
            const role = task.auto_assign_role;
            if (!role || role === 'none') return;
            const estSecs = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0 ? task.estimated_minutes * 60 : 0;
            if (estSecs > 0) estimatedByRole2[role] = (estimatedByRole2[role] || 0) + estSecs;
          });
          const actualByRole2: Record<string, number> = {};
          freshTimeLogs.forEach((log: any) => {
            const role = log.role || 'admin';
            if (log.status === 'completed' || (!log.is_active && log.total_seconds > 0)) {
              actualByRole2[role] = (actualByRole2[role] || 0) + (log.total_seconds || 0);
            } else if (log.is_active && log.status === 'running' && log.start_time) {
              const elapsed = Math.floor((Date.now() - new Date(log.start_time).getTime()) / 1000);
              actualByRole2[role] = (actualByRole2[role] || 0) + Math.max(0, elapsed - (log.paused_duration || 0));
            } else if (log.is_active && log.status === 'paused') {
              actualByRole2[role] = (actualByRole2[role] || 0) + (log.total_seconds || 0);
            }
          });
          const allRoles2 = new Set([...Object.keys(estimatedByRole2), ...Object.keys(actualByRole2)]);
          const effortBreakdown2 = Array.from(allRoles2).map(role => ({
            role, estimated_seconds: Math.round(estimatedByRole2[role] || 0), actual_seconds: Math.round(actualByRole2[role] || 0),
          }));
          const effortPayload = {
            project_id, project_title: project.title, effort_breakdown: effortBreakdown2,
            total_estimated_seconds: Math.round(Object.values(estimatedByRole2).reduce((a, b) => a + b, 0)),
            total_actual_seconds: Math.round(Object.values(actualByRole2).reduce((a, b) => a + b, 0)),
            last_updated: new Date().toISOString(),
          };
          const existingEffort = existingEffortArr[0];
          if (existingEffort) { await entities.ProjectEffort.update(existingEffort.id, effortPayload); }
          else { await entities.ProjectEffort.create(effortPayload); }
        } catch (e: any) {
          console.warn('Effort recalc after sync failed:', e.message);
          invokeFunction('reconcileProjectEffort', { project_id }).catch(() => {});
        }
      }
    }

    // Write ProjectActivity
    try {
      await entities.ProjectActivity.create({
        project_id, project_title: project.title || project.property_address || '',
        action: 'system_tasks_generated',
        description: `Tasks generated: ${createdCount} created, ${tasksToReactivate.length} reactivated, ${skippedCount} already existed, ${orphanedTasks.length} orphaned removed.`,
        actor_type: 'system', actor_source: 'syncProjectTasksFromProducts',
        user_name: 'System', user_email: 'system@flexstudios.app',
      });
    } catch { /* non-fatal */ }

    // Check if all tasks complete
    try {
      const allProjectTasks = await entities.ProjectTask.filter({ project_id }, null, 500);
      const activeTasks = allProjectTasks.filter((t: any) => !t.is_deleted && !t.is_archived);
      if (activeTasks.length > 0 && activeTasks.every((t: any) => t.is_completed)) {
        if (project && !['delivered', 'cancelled'].includes(project.status)) {
          const projectName = project.title || project.property_address || 'Project';
          const admins = await entities.User.list('-created_date', 200);
          const notifyUserIds = new Set<string>(
            admins.filter((u: any) => u.role === 'master_admin' || u.role === 'employee').map((u: any) => u.id)
          );
          if (project.project_owner_id) notifyUserIds.add(project.project_owner_id);
          for (const userId of notifyUserIds) {
            const allowed = await _canNotify(entities, userId, 'all_tasks_completed', 'project');
            if (!allowed) continue;
            await entities.Notification.create({
              user_id: userId, type: 'all_tasks_completed', category: 'project', severity: 'info',
              title: `All tasks done — ${projectName}`, message: `All ${activeTasks.length} tasks are complete. Ready to deliver?`,
              project_id, project_name: projectName, cta_label: 'View Project',
              is_read: false, is_dismissed: false, source: 'task_completion',
              idempotency_key: `all_tasks_done:${project_id}:${activeTasks.length}`, created_date: new Date().toISOString(),
            }).catch(() => {});
          }
        }
      }
    } catch { /* non-fatal */ }

    // Notify assignees
    try {
      const perAssigneeNotifs = new Map<string, string[]>();
      for (const taskDef of tasksToCreate) {
        const assigneeId = taskDef.assigned_to || taskDef.data?.assigned_to;
        const taskTitle = taskDef.title || taskDef.data?.title;
        if (!assigneeId || !taskTitle) continue;
        if (assigneeId === project.project_owner_id) continue;
        if (!perAssigneeNotifs.has(assigneeId)) perAssigneeNotifs.set(assigneeId, []);
        perAssigneeNotifs.get(assigneeId)!.push(taskTitle);
      }
      const projName = project.title || project.property_address || 'a project';
      for (const [userId, taskTitles] of perAssigneeNotifs) {
        const allowed = await _canNotify(entities, userId, 'task_assigned', 'task');
        if (!allowed) continue;
        const count = taskTitles.length;
        const preview = taskTitles.slice(0, 2).join(', ') + (count > 2 ? ` +${count - 2} more` : '');
        await entities.Notification.create({
          user_id: userId, type: 'task_assigned', category: 'task', severity: 'info',
          title: `${count} task${count > 1 ? 's' : ''} assigned to you on ${projName}`, message: preview,
          project_id, project_name: projName, cta_label: 'View Project',
          is_read: false, is_dismissed: false, source: 'task_generation',
          idempotency_key: `tasks_assigned_batch:${project_id}:${userId}:${new Date().toISOString().slice(0, 10)}`,
          created_date: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    // FIX #23: Recalculate task deadlines after all tasks are synced (for Tonomo products etc.)
    if (createdCount > 0 || tasksToReactivate.length > 0) {
      invokeFunction('calculateProjectTaskDeadlines', { project_id, trigger_event: 'tasks_synced' }).catch(() => {});
    }

    return jsonResponse({
      success: true,
      created_count: createdCount,
      reactivated_count: tasksToReactivate.length,
      skipped_count: skippedCount,
      orphaned_count: orphanedTasks.length,
      message: `Synced project tasks successfully`
    });
  } catch (error: any) {
    console.error('Error syncing project tasks from products:', error);
    return errorResponse(error.message);
  }
});

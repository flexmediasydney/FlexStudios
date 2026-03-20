import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

async function _canNotify(base44: any, userId: string, type: string, category: string): Promise<boolean> {
  try {
    const prefs = await base44.asServiceRole.entities.NotificationPreference.filter(
      { user_id: userId }, null, 50
    );
    const typePref = prefs.find((p: any) => p.notification_type === type);
    if (typePref !== undefined) return typePref.in_app_enabled !== false;
    const catPref = prefs.find((p: any) => p.category === category && (!p.notification_type || p.notification_type === '*'));
    if (catPref !== undefined) return catPref.in_app_enabled !== false;
    return true;
  } catch { return true; }
}

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me().catch(() => null);

        // Accept both user sessions (frontend calls) and service-role context
        // (backend-to-backend calls via asServiceRole.functions.invoke).
        // Service-role calls have no user but DO have asServiceRole entity access.
        const isSystemCall = !user;
        const db = isSystemCall ? base44.asServiceRole.entities : base44.entities;

        if (!user) {
            // Verify service-role access is actually working — if not, reject
            try {
                await base44.asServiceRole.entities.Project.get('_probe_').catch(() => null);
                // If we got here without a 403, service role is valid
            } catch (authErr: any) {
                if (authErr?.status === 403) {
                    return Response.json({ error: 'Unauthorized' }, { status: 401 });
                }
                // Other errors (404 etc) are fine — service role is working
            }
        }

        let requestBody;
        try {
            requestBody = await req.json();
        } catch (err) {
            return Response.json({ error: 'Invalid JSON in request body' }, { status: 400 });
        }

        // Health check probe
        if (requestBody?._health_check) {
            return Response.json({ _version: 'v2.1', _fn: 'syncProjectTasksFromProducts', _ts: '2026-03-17' });
        }

        const { project_id } = requestBody;

        // Guard: Validate project_id
        if (!project_id || typeof project_id !== 'string' || !project_id.trim()) {
            return Response.json({ error: 'project_id is required and must be a non-empty string' }, { status: 400 });
        }

        // Fetch the project
         const project = await db.Project.get(project_id);
        if (!project) {
            return Response.json({ error: 'Project not found' }, { status: 404 });
        }

        const pricingTier = project.pricing_tier || 'standard';
        const tierKey = pricingTier === 'premium' ? 'premium_task_templates' : 'standard_task_templates';

        // Collect all products from both standalone and package contexts
        const productSources = new Map();
        const packageProductInfo = [];

        // Collect standalone products
        if (project.products && Array.isArray(project.products)) {
            for (const item of project.products) {
                if (!productSources.has(item.product_id)) {
                    productSources.set(item.product_id, new Set());
                }
                productSources.get(item.product_id).add('standalone');
            }
        }

        // Collect nested products from packages
        if (project.packages && Array.isArray(project.packages)) {
            for (const pkg of project.packages) {
                if (pkg.products && Array.isArray(pkg.products)) {
                    for (const nestedProd of pkg.products) {
                        packageProductInfo.push({
                            packageId: pkg.package_id,
                            productId: nestedProd.product_id
                        });
                        if (!productSources.has(nestedProd.product_id)) {
                            productSources.set(nestedProd.product_id, new Set());
                        }
                        productSources.get(nestedProd.product_id).add(pkg.package_id);
                    }
                }
            }
        }

        // Check if there are any products or packages
        const hasPackages = project.packages && project.packages.length > 0;
        if (productSources.size === 0 && !hasPackages) {
            return Response.json({ success: true, created_count: 0, skipped_count: 0 });
        }

        // Retry helper for rate limit handling
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

        // Build package ID set first (before fetching)
        const packageIdSet = new Set();
        if (project.packages && Array.isArray(project.packages)) {
            for (const pkg of project.packages) {
                packageIdSet.add(pkg.package_id);
            }
        }

        // Fetch only the products and packages actually used by this project.
        // This avoids loading the entire catalogue (potentially 1000+ records)
        // for a project that uses 3-5 products.
        const neededProductIds = [...productSources.keys()];
        const neededPackageIds = [...packageIdSet];

        const [fetchedProducts, fetchedPackages] = await Promise.all([
            neededProductIds.length > 0
                ? Promise.all(neededProductIds.map(id =>
                    retryWithBackoff(() => db.Product.get(id)).catch(() => null)
                  ))
                : Promise.resolve([]),
            neededPackageIds.length > 0
                ? Promise.all(neededPackageIds.map(id =>
                    retryWithBackoff(() => db.Package.get(id)).catch(() => null)
                  ))
                : Promise.resolve([]),
        ]);

        const productDataMap = new Map(
            fetchedProducts.filter(Boolean).map(p => [p.id, p])
        );
        const packageDataMap = new Map(
            fetchedPackages.filter(Boolean).map(p => [p.id, p])
        );

        // Fetch existing tasks for this project with pagination and retry
        const existingTasks = await retryWithBackoff(() => 
            db.ProjectTask.filter({ project_id }, null, 1000)
        );
        const activeTaskTemplateIds = new Set(existingTasks.filter(t => !t.is_deleted).map(t => t.template_id).filter(Boolean));

        let createdCount = 0;
        let skippedCount = 0;
        const tasksToCreate = [];
        const pendingDependencies = [];

        // Helper function to create tasks from templates
        const createTasksFromTemplates = (productId, templates) => {
            for (let idx = 0; idx < templates.length; idx++) {
                const template = templates[idx];
                const canonicalTemplateId = `product:${productId}:${pricingTier}:${idx}`;

                // Task already exists — skip creation but update estimated_minutes
                // so quantity changes are reflected in effort estimates
                if (activeTaskTemplateIds.has(canonicalTemplateId)) {
                    const existingTask = existingTasks.find(
                        t => t.template_id === canonicalTemplateId && !t.is_deleted
                    );
                    if (existingTask && typeof template.estimated_minutes === 'number') {
                        const newEstimate = template.estimated_minutes;
                        if (existingTask.estimated_minutes !== newEstimate) {
                            // Only write if value actually changed — avoid spurious updates
                            retryWithBackoff(() =>
                                db.ProjectTask.update(existingTask.id, {
                                    estimated_minutes: newEstimate,
                                })
                            ).catch(err =>
                                console.warn(`Failed to update estimated_minutes for task ${existingTask.id}:`, err.message)
                            );
                        }
                    }
                    skippedCount++;
                    continue;
                }

                // If task exists but is deleted, reactivate it
                const deletedTask = existingTasks.find(t => t.template_id === canonicalTemplateId && t.is_deleted);
                if (deletedTask) {
                    // Mark for later update
                    tasksToCreate.push({ type: 'reactivate', taskId: deletedTask.id });
                    createdCount++;
                    continue;
                }

                // Determine assigned user based on auto_assign_role
                let assignedTo = null;
                let assignedToName = null;
                let assignedToTeamId = null;
                let assignedToTeamName = null;

                if (template.auto_assign_role && template.auto_assign_role !== 'none') {
                    const roleKey = `${template.auto_assign_role}_id`;
                    const roleNameKey = `${template.auto_assign_role}_name`;
                    const roleTypeKey = `${template.auto_assign_role}_type`;

                    assignedTo = project[roleKey] || null;
                    assignedToName = project[roleNameKey] || null;

                    if (project[roleTypeKey] === 'team') {
                        assignedToTeamId = assignedTo;
                        assignedToTeamName = assignedToName;
                        assignedTo = null;
                        assignedToName = null;
                    }

                    // Fallback: if role is unassigned and it's a production role, assign to project owner
                    const productionRoles = ['photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
                    if (!assignedTo && !assignedToTeamId && productionRoles.includes(template.auto_assign_role)) {
                        assignedTo = project.project_owner_id || null;
                        assignedToName = project.project_owner_name || null;
                        if (project.project_owner_type === 'team') {
                            assignedToTeamId = assignedTo;
                            assignedToTeamName = assignedToName;
                            assignedTo = null;
                            assignedToName = null;
                        }
                    }
                }

                // Track depends_on_indices for post-create resolution
                const dependsOnIndices = (template.depends_on_indices || []).map(i => Math.round(i));
                if (dependsOnIndices.length > 0) {
                    pendingDependencies.push({
                        taskArrayIndex: tasksToCreate.length,
                        depends_on_template_indices: dependsOnIndices,
                        productId
                    });
                }

                tasksToCreate.push({
                    type: 'create',
                    project_id,
                    title: template.title,
                    description: template.description || '',
                    assigned_to: assignedTo,
                    assigned_to_name: assignedToName,
                    assigned_to_team_id: assignedToTeamId,
                    assigned_to_team_name: assignedToTeamName,
                    auto_generated: true,
                    template_id: canonicalTemplateId,
                    product_id: productId,
                    order: existingTasks.length + tasksToCreate.length,
                    is_completed: false,
                    depends_on_task_ids: [],
                    is_blocked: false,
                    auto_assign_role: template.auto_assign_role || 'none',
                    estimated_minutes: typeof template.estimated_minutes === 'number' ? template.estimated_minutes : 0,
                    timer_trigger: template.timer_trigger || 'none',
                    deadline_type: template.deadline_type || 'custom',
                    deadline_preset: template.deadline_preset || null,
                    deadline_hours_after_trigger: template.deadline_hours_after_trigger || 0
                });
            }
        };

        // Process all products (whether standalone or in packages)
        for (const [productId, sources] of productSources) {
            const product = productDataMap.get(productId);
            if (!product) {
                console.warn(`Product ${productId} referenced in project but not found in database`);
                continue;
            }
            const templates = product[tierKey] || [];
            createTasksFromTemplates(productId, templates);
        }

        // Process package-level tasks
        for (const packageId of packageIdSet) {
            const pkg = packageDataMap.get(packageId);
            if (!pkg) {
                console.warn(`Package ${packageId} referenced in project but not found in database`);
                continue;
            }
            const templates = pkg[tierKey] || [];

            for (let idx = 0; idx < templates.length; idx++) {
                const template = templates[idx];
                const canonicalTemplateId = `package:${packageId}:${pricingTier}:${idx}`;

                if (activeTaskTemplateIds.has(canonicalTemplateId)) {
                    const existingTask = existingTasks.find(
                        t => t.template_id === canonicalTemplateId && !t.is_deleted
                    );
                    if (existingTask && typeof template.estimated_minutes === 'number') {
                        const newEstimate = template.estimated_minutes;
                        if (existingTask.estimated_minutes !== newEstimate) {
                            retryWithBackoff(() =>
                                db.ProjectTask.update(existingTask.id, {
                                    estimated_minutes: newEstimate,
                                })
                            ).catch(err =>
                                console.warn(`Failed to update estimated_minutes for task ${existingTask.id}:`, err.message)
                            );
                        }
                    }
                    skippedCount++;
                    continue;
                }

                const deletedPkgTask = existingTasks.find(t => t.template_id === canonicalTemplateId && t.is_deleted);
                if (deletedPkgTask) {
                    tasksToCreate.push({ type: 'reactivate', taskId: deletedPkgTask.id });
                    createdCount++;
                    continue;
                }

                let assignedTo = null;
                let assignedToName = null;
                let assignedToTeamId = null;
                let assignedToTeamName = null;

                if (template.auto_assign_role && template.auto_assign_role !== 'none') {
                    const roleKey = `${template.auto_assign_role}_id`;
                    const roleNameKey = `${template.auto_assign_role}_name`;
                    const roleTypeKey = `${template.auto_assign_role}_type`;

                    assignedTo = project[roleKey] || null;
                    assignedToName = project[roleNameKey] || null;

                    if (project[roleTypeKey] === 'team') {
                        assignedToTeamId = assignedTo;
                        assignedToTeamName = assignedToName;
                        assignedTo = null;
                        assignedToName = null;
                    }

                    const productionRoles = ['photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
                    if (!assignedTo && !assignedToTeamId && productionRoles.includes(template.auto_assign_role)) {
                        assignedTo = project.project_owner_id || null;
                        assignedToName = project.project_owner_name || null;
                        if (project.project_owner_type === 'team') {
                            assignedToTeamId = assignedTo;
                            assignedToTeamName = assignedToName;
                            assignedTo = null;
                            assignedToName = null;
                        }
                    }
                }

                tasksToCreate.push({
                    type: 'create',
                    project_id,
                    title: template.title,
                    description: template.description || '',
                    assigned_to: assignedTo,
                    assigned_to_name: assignedToName,
                    assigned_to_team_id: assignedToTeamId,
                    assigned_to_team_name: assignedToTeamName,
                    auto_generated: true,
                    template_id: canonicalTemplateId,
                    package_id: packageId,
                    order: existingTasks.length + tasksToCreate.length,
                    is_completed: false,
                    depends_on_task_ids: [],
                    is_blocked: false,
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

         const orphanedTasks = existingTasks.filter(task => {
             if (!task.auto_generated) return false;
             // A task is orphaned only if its source product/package is no longer on the project.
             // Do NOT orphan tasks where only the pricing tier changed — those get migrated below.
             if (task.product_id && !currentProductIds.has(task.product_id)) return true;
             if (task.package_id && !currentPackageIds.has(task.package_id)) return true;
             return false;
         });

         // Migrate tasks whose template_id has only a tier change (standard ↔ premium).
         // Re-stamp template_id to the new tier so they are not re-created as duplicates
         // and existing progress (completed status, time logs) is preserved.
         const tierFrom = pricingTier === 'premium' ? 'standard' : 'premium';
         const tierMigrationTasks = existingTasks.filter(task => {
             if (!task.auto_generated || task.is_deleted) return false;
             if (!task.template_id) return false;
             // Check if replacing the old tier with new tier produces a template we're about to create
             const migratedId = task.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`);
             return migratedId !== task.template_id;
         });

         const batchSize = 5;

         if (tierMigrationTasks.length > 0) {
             for (let i = 0; i < tierMigrationTasks.length; i += batchSize) {
                 const batch = tierMigrationTasks.slice(i, i + batchSize);
                 await Promise.all(
                     batch.map(task => {
                         const newTemplateId = task.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`);
                         return retryWithBackoff(() =>
                             db.ProjectTask.update(task.id, { template_id: newTemplateId })
                         ).catch(err => console.error(`Failed to migrate task tier ${task.id}:`, err.message));
                     })
                 );
             }
             // Reload active template IDs after migration so we don't re-create the migrated tasks
             const migratedIds = tierMigrationTasks.map(t =>
                 t.template_id.replace(`:${tierFrom}:`, `:${pricingTier}:`)
             );
             migratedIds.forEach(id => activeTaskTemplateIds.add(id));

             // After migrating tasks to new tier templates, recalculate deadlines
             // so they reflect the new tier's timing assumptions
             if (tierMigrationTasks.length > 0) {
               base44.asServiceRole.functions.invoke('calculateProjectTaskDeadlines', {
                 project_id,
                 trigger_event: 'tier_migration',
               }).catch(() => {});
             }
             }
        for (let i = 0; i < orphanedTasks.length; i += batchSize) {
            const batch = orphanedTasks.slice(i, i + batchSize);
            await Promise.all(
                batch.map(task => 
                    retryWithBackoff(() => db.ProjectTask.update(task.id, { is_deleted: true }))
                        .catch(err => console.error(`Failed to soft-delete orphaned task ${task.id}:`, err.message))
                )
            );
        }

        // Process task creations and reactivations
        const tasksOnlyCreate = tasksToCreate.filter(t => t.type === 'create').map(({ type, ...data }) => data);
        const tasksToReactivate = tasksToCreate.filter(t => t.type === 'reactivate');

        // Reactivate previously soft-deleted tasks (product was removed then re-added)
        if (tasksToReactivate.length > 0) {
            for (let i = 0; i < tasksToReactivate.length; i += batchSize) {
                const batch = tasksToReactivate.slice(i, i + batchSize);
                await Promise.all(
                    batch.map(t =>
                        retryWithBackoff(() => db.ProjectTask.update(t.taskId, {
                            is_deleted: false,
                            is_completed: false,
                        })).catch(err => console.error(`Failed to reactivate task ${t.taskId}:`, err.message))
                    )
                );
            }
        }

        if (tasksOnlyCreate.length > 0) {
            // Create tasks individually in batches (bulkCreate is unreliable across auth contexts)
            const created: any[] = [];
            for (let i = 0; i < tasksOnlyCreate.length; i += batchSize) {
                const batch = tasksOnlyCreate.slice(i, i + batchSize);
                const batchResults = await Promise.all(
                    batch.map(taskData =>
                        retryWithBackoff(() => db.ProjectTask.create(taskData))
                            .catch(err => {
                                console.error(`Failed to create task "${taskData.title}":`, err.message);
                                return null;
                            })
                    )
                );
                created.push(...batchResults.filter(Boolean));
                // Small delay between batches to avoid rate limits
                if (i + batchSize < tasksOnlyCreate.length) {
                    await new Promise(r => setTimeout(r, 50));
                }
            }
            createdCount = created.length;

            // Resolve dependencies (map array index → created task ID)
            if (pendingDependencies.length > 0 && created.length > 0) {
                // Build index-to-ID map: for each task in tasksOnlyCreate, find its created counterpart by template_id
                const templateToCreatedId = new Map(
                    created.map(t => [t.template_id, t.id])
                );

                const depUpdatePromises = [];
                for (const pending of pendingDependencies) {
                    // Find the child task we just created
                    const childTemplateId = tasksOnlyCreate[pending.taskArrayIndex]?.template_id;
                    const childId = childTemplateId ? templateToCreatedId.get(childTemplateId) : null;
                    if (!childId) continue;

                    const depTaskIds = [];
                    for (const depIdx of pending.depends_on_template_indices) {
                        const depTemplateId = `product:${pending.productId}:${pricingTier}:${depIdx}`;
                        // Check if dependency was just created
                        const depCreatedId = templateToCreatedId.get(depTemplateId);
                        if (depCreatedId) {
                            depTaskIds.push(depCreatedId);
                        } else {
                            // Check if dependency already existed
                            const existing = existingTasks.find(t => t.template_id === depTemplateId);
                            if (existing) depTaskIds.push(existing.id);
                        }
                    }

                    if (depTaskIds.length > 0) {
                        depUpdatePromises.push(
                            db.ProjectTask.update(childId, {
                                depends_on_task_ids: depTaskIds,
                                is_blocked: true
                            })
                        );
                    }
                }
                if (depUpdatePromises.length > 0) {
                    for (let di = 0; di < depUpdatePromises.length; di += batchSize) {
                        await Promise.all(depUpdatePromises.slice(di, di + batchSize));
                        if (di + batchSize < depUpdatePromises.length) {
                            await new Promise(r => setTimeout(r, 50));
                        }
                    }
                }
            }

            // After creating tasks, recalculate effort inline
             if (tasksOnlyCreate.length > 0) {
                 // Recalculate effort inline (avoid sub-function call to prevent rate limit cascade)
                 try {
                     const [freshTimeLogs, freshTasks, existingEffortArr] = await Promise.all([
                         db.TaskTimeLog.filter({ project_id }, null, 1000),
                         db.ProjectTask.filter({ project_id }, null, 1000),
                         db.ProjectEffort.filter({ project_id }),
                     ]);
                     const activeTasks2 = freshTasks.filter(t => !t.is_deleted);
                     const estimatedByRole2 = {};
                     activeTasks2.forEach(task => {
                         const role = task.auto_assign_role;
                         if (!role || role === 'none') return;
                         const estSecs = typeof task.estimated_minutes === 'number' && task.estimated_minutes > 0
                             ? task.estimated_minutes * 60 : 0;
                         if (estSecs > 0) estimatedByRole2[role] = (estimatedByRole2[role] || 0) + estSecs;
                     });
                     const actualByRole2 = {};
                     freshTimeLogs.forEach(log => {
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
                         role, estimated_seconds: Math.round(estimatedByRole2[role] || 0),
                         actual_seconds: Math.round(actualByRole2[role] || 0),
                     }));
                     const effortPayload = {
                         project_id, project_title: project.title,
                         effort_breakdown: effortBreakdown2,
                         total_estimated_seconds: Math.round(Object.values(estimatedByRole2).reduce((a, b) => a + b, 0)),
                         total_actual_seconds: Math.round(Object.values(actualByRole2).reduce((a, b) => a + b, 0)),
                         last_updated: new Date().toISOString(),
                     };
                     const existingEffort = existingEffortArr[0];
                     if (existingEffort) {
                         await db.ProjectEffort.update(existingEffort.id, effortPayload);
                     } else {
                         await db.ProjectEffort.create(effortPayload);
                     }
                 } catch (e) {
                     console.warn('Effort recalc after sync failed:', e.message);
                     // Auto-trigger reconcile on failure so drift doesn't persist
                     base44.asServiceRole.functions.invoke('reconcileProjectEffort', {
                         project_id,
                     }).catch(() => { /* best-effort */ });
                 }
                 }
                 }

                 // Write ProjectActivity for task generation
                 try {
                 await db.ProjectActivity.create({
                 project_id,
                 project_title: project.title || project.property_address || '',
                 action: 'system_tasks_generated',
                 description: `Tasks generated: ${createdCount + tasksToCreate.filter(t => t.type === 'create').length} created, ${skippedCount} already existed. Source: product/package templates.`,
                 actor_type: 'system',
                 actor_source: 'syncProjectTasksFromProducts',
                 user_name: 'System',
                 user_email: 'system@flexmedia',
                 });
                 } catch { /* non-fatal */ }

                 // Check if all tasks are now complete
                 try {
                   const allProjectTasks = await db.ProjectTask.filter({ project_id }, null, 500);
                   const activeTasks = allProjectTasks.filter((t: any) => !t.is_deleted && !t.is_archived);
                   if (activeTasks.length > 0 && activeTasks.every((t: any) => t.is_completed)) {
                     if (project && !['delivered', 'cancelled'].includes(project.status)) {
                       const projectName = project.title || project.property_address || 'Project';
                       const admins = await db.User.list('-created_date', 200);
                       const notifyUserIds = new Set<string>(
                         admins
                           .filter((u: any) => u.role === 'master_admin' || u.role === 'employee')
                           .map((u: any) => u.id)
                       );
                       if (project.project_owner_id) notifyUserIds.add(project.project_owner_id);

                       for (const userId of notifyUserIds) {
                         const allowed = await _canNotify(base44, userId, 'all_tasks_completed', 'project');
                         if (!allowed) continue;
                         await db.Notification.create({
                           user_id: userId,
                           type: 'all_tasks_completed',
                           category: 'project',
                           severity: 'info',
                           title: `All tasks done — ${projectName}`,
                           message: `All ${activeTasks.length} tasks are complete. Ready to deliver?`,
                           project_id,
                           project_name: projectName,
                           cta_label: 'View Project',
                           is_read: false,
                           is_dismissed: false,
                           source: 'task_completion',
                           idempotency_key: `all_tasks_done:${project_id}:${activeTasks.length}`,
                           created_date: new Date().toISOString(),
                         }).catch(() => {});
                       }
                     }
                   }
                 } catch { /* non-fatal */ }

                 // Notify individual assignees about their specific newly-created tasks
                 try {
                   const perAssigneeNotifs = new Map();
                   for (const taskDef of tasksToCreate) {
                     const assigneeId = taskDef.assigned_to || taskDef.data?.assigned_to;
                     const taskTitle = taskDef.title || taskDef.data?.title;
                     if (!assigneeId || !taskTitle) continue;
                     if (assigneeId === project.project_owner_id) continue;
                     if (!perAssigneeNotifs.has(assigneeId)) perAssigneeNotifs.set(assigneeId, []);
                     perAssigneeNotifs.get(assigneeId).push(taskTitle);
                   }
                   const projName = project.title || project.property_address || 'a project';
                   for (const [userId, taskTitles] of perAssigneeNotifs) {
                     const allowed = await _canNotify(base44, userId, 'task_assigned', 'task');
                     if (!allowed) continue;
                     const count = taskTitles.length;
                     const preview = taskTitles.slice(0, 2).join(', ') + (count > 2 ? ` +${count - 2} more` : '');
                     await db.Notification.create({
                       user_id: userId,
                       type: 'task_assigned',
                       category: 'task',
                       severity: 'info',
                       title: `${count} task${count > 1 ? 's' : ''} assigned to you on ${projName}`,
                       message: preview,
                       project_id,
                       project_name: projName,
                       cta_label: 'View Project',
                       is_read: false,
                       is_dismissed: false,
                       source: 'task_generation',
                       idempotency_key: `tasks_assigned_batch:${project_id}:${userId}:${new Date().toISOString().slice(0, 10)}`,
                       created_date: new Date().toISOString(),
                     }).catch(() => {});
                   }
                 } catch { /* non-fatal */ }

                 return Response.json({
                 success: true,
                 created_count: createdCount + tasksToCreate.filter(t => t.type === 'create').length,
                 reactivated_count: tasksToReactivate.length,
                 skipped_count: skippedCount,
                 message: `Synced project tasks successfully`
                 });
    } catch (error) {
        console.error('Error syncing project tasks from products:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
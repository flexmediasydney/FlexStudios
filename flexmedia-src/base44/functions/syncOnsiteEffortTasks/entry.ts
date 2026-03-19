import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Called whenever project pricing is saved.
 * Calculates the longest onsite duration from products/packages,
 * then upserts UNLOCKED, INCOMPLETE onsite tasks for photographer and videographer.
 * No time logs are created here — those are only added when the project reaches "uploaded" stage.
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const { project_id } = await req.json();

    if (!project_id) {
      return Response.json({ success: false, error: 'project_id required' }, { status: 400 });
    }

    const [project, allProducts, allPackages] = await Promise.all([
      base44.asServiceRole.entities.Project.get(project_id),
      base44.asServiceRole.entities.Product.filter({}, null, 1000),
      base44.asServiceRole.entities.Package.filter({}, null, 1000),
    ]);

    if (!project) {
      return Response.json({ success: false, error: 'Project not found' }, { status: 404 });
    }

    const tierKey = project.pricing_tier === 'premium' ? 'premium_tier' : 'standard_tier';
    const productMap = new Map(allProducts.map(p => [p.id, p]));
    const packageMap = new Map(allPackages.map(p => [p.id, p]));

    // === Find longest onsite duration (same logic as effort engine) ===
    let onsiteMaxMins = 0;

    (project.products || []).forEach(item => {
      const product = productMap.get(item.product_id);
      if (!product) return;
      const tier = product[tierKey] || product.standard_tier || {};
      const qty = item.quantity || 1;
      const base = tier.onsite_time || 0;
      const increment = tier.onsite_time_increment || 0;
      const mins = base + Math.max(0, qty - 1) * increment;
      if (mins > onsiteMaxMins) onsiteMaxMins = mins;
    });

    (project.packages || []).forEach(pkgItem => {
      const pkg = packageMap.get(pkgItem.package_id);
      if (!pkg) return;
      const tier = pkg[tierKey] || pkg.standard_tier || {};
      const schedulingTime = tier.scheduling_time || 0;
      if (schedulingTime > 0) {
        if (schedulingTime > onsiteMaxMins) onsiteMaxMins = schedulingTime;
      } else {
        (pkgItem.products || pkg.products || []).forEach(prodItem => {
          const product = productMap.get(prodItem.product_id);
          if (!product) return;
          const prodTier = product[tierKey] || product.standard_tier || {};
          const qty = prodItem.quantity || 1;
          const base = prodTier.onsite_time || 0;
          const increment = prodTier.onsite_time_increment || 0;
          const mins = base + Math.max(0, qty - 1) * increment;
          if (mins > onsiteMaxMins) onsiteMaxMins = mins;
        });
      }
    });

    // Fetch all existing tasks for this project
    const existingTasks = await base44.asServiceRole.entities.ProjectTask.filter({ project_id }, null, 1000);

    // Roles to generate onsite tasks for (only if the role is staffed on the project)
    // Read new canonical fields (photographer_id, videographer_id) with fallback
    // to legacy fields (onsite_staff_1_id, onsite_staff_2_id) for backward compat.
    const onsiteRoles = [
      {
        role: 'photographer',
        staffId:   project.photographer_id   || project.onsite_staff_1_id   || null,
        staffName: project.photographer_name || project.onsite_staff_1_name || null,
        staffType: project.onsite_staff_1_type || 'user',
      },
      {
        role: 'videographer',
        staffId:   project.videographer_id   || project.onsite_staff_2_id   || null,
        staffName: project.videographer_name || project.onsite_staff_2_name || null,
        staffType: project.onsite_staff_2_type || 'user',
      },
    ];

    // Calculate due_date = shoot_date + shoot_time + onsiteMaxMins
    let dueDate = null;
    if (project.shoot_date && onsiteMaxMins > 0) {
      const shootDateStr = project.shoot_date;
      // Normalise shoot_time: accept HH:MM, HH:MM:SS, or full ISO string
      let shootTimeStr = project.shoot_time || '09:00';
      if (shootTimeStr.includes('T') || shootTimeStr.length > 8) {
        // It's an ISO string — extract just the HH:MM part in Sydney time
        try {
          const t = new Date(shootTimeStr.endsWith('Z') ? shootTimeStr : shootTimeStr + 'Z');
          if (!isNaN(t.getTime())) {
            shootTimeStr = t.toLocaleTimeString('en-AU', {
              timeZone: 'Australia/Sydney',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            }).slice(0, 5); // "HH:MM"
          } else {
            shootTimeStr = '09:00';
          }
        } catch { shootTimeStr = '09:00'; }
      }
      const shootDt = new Date(`${shootDateStr}T${shootTimeStr}:00`);
      if (!isNaN(shootDt.getTime())) {
        dueDate = new Date(shootDt.getTime() + onsiteMaxMins * 60 * 1000).toISOString();
      }
    }

    const onsiteSeconds = onsiteMaxMins * 60;

    for (const { role, staffId, staffName, staffType } of onsiteRoles) {
      const templateId = `onsite:${role}`;
      const existingTask = existingTasks.find(t => t.template_id === templateId);

      if (onsiteMaxMins === 0 || !staffId) {
        // If no onsite time or role not staffed — soft-delete the task if it exists
        if (existingTask && !existingTask.is_deleted) {
          await base44.asServiceRole.entities.ProjectTask.update(existingTask.id, { is_deleted: true });
          // Also close any open time logs for this task
          const timeLogs = await base44.asServiceRole.entities.TaskTimeLog.filter({ task_id: existingTask.id });
          await Promise.all(timeLogs.map(log =>
            base44.asServiceRole.entities.TaskTimeLog.update(log.id, { is_active: false, status: 'completed' })
          ));
        }
        continue;
      }

      // Only update fields that don't affect completion state if already completed/locked
      // (don't un-complete a task that was already completed on upload)
      const alreadyCompleted = existingTask?.is_completed && existingTask?.is_locked;

      const taskData = {
        project_id,
        title: `Onsite - ${role.charAt(0).toUpperCase() + role.slice(1)}`,
        task_type: 'onsite',
        auto_assign_role: role,
        template_id: templateId,
        auto_generated: true,
        // Only set incomplete/unlocked if not already completed
        ...(alreadyCompleted ? {} : { is_completed: false, is_locked: false }),
        is_deleted: false,
        is_blocked: false,
        estimated_minutes: onsiteMaxMins,
        due_date: dueDate,
        assigned_to: staffType !== 'team' ? staffId : null,
        assigned_to_name: staffType !== 'team' ? staffName : null,
        assigned_to_team_id: staffType === 'team' ? staffId : null,
        assigned_to_team_name: staffType === 'team' ? staffName : null,
      };

      if (existingTask) {
        await base44.asServiceRole.entities.ProjectTask.update(existingTask.id, taskData);
      } else {
        await base44.asServiceRole.entities.ProjectTask.create({ ...taskData, is_completed: false, is_locked: false });
      }
      // No time logs created here — logOnsiteEffortOnUpload handles that on "uploaded" stage
    }

    // Effort recalculation is intentionally NOT done here.
    // Any task upsert above triggers updateProjectEffortRealtimeRobust via entity automation.
    // That is the single authoritative effort calculator. Duplicating it here causes a
    // triple-write race condition — removed in the robustness audit.
    console.log(`syncOnsiteEffortTasks: upserted onsite tasks for project ${project_id}. Effort recalc will fire via automation.`);

    return Response.json({ success: true, project_id, onsite_minutes: onsiteMaxMins });
  } catch (error) {
    console.error('syncOnsiteEffortTasks error:', error);
    return Response.json({ success: false, error: error.message }, { status: 500 });
  }
});
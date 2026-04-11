import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    if (!user) {
      const authHeader = req.headers.get('authorization') || '';
      if (!authHeader.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '___')) {
        return errorResponse('Authentication required', 401);
      }
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const { project_id } = await req.json();

    if (!project_id) return jsonResponse({ success: false, error: 'project_id required' }, 400);

    const [project, allProducts, allPackages] = await Promise.all([
      entities.Project.get(project_id),
      entities.Product.filter({}, null, 1000),
      entities.Package.filter({}, null, 1000),
    ]);

    if (!project) return jsonResponse({ success: false, error: 'Project not found' }, 404);

    const tierKey = project.pricing_tier === 'premium' ? 'premium_tier' : 'standard_tier';
    const productMap = new Map(allProducts.map((p: any) => [p.id, p]));
    const packageMap = new Map(allPackages.map((p: any) => [p.id, p]));

    let onsiteMaxMins = 0;

    (project.products || []).forEach((item: any) => {
      const product = productMap.get(item.product_id);
      if (!product) return;
      const tier = product[tierKey] || product.standard_tier || {};
      const qty = item.quantity || 1;
      const base = tier.onsite_time || 0;
      const increment = tier.onsite_time_increment || 0;
      const includedQty = tier.included_qty || product.min_quantity || 1;
      const mins = base + Math.max(0, qty - includedQty) * increment;
      if (mins > onsiteMaxMins) onsiteMaxMins = mins;
    });

    (project.packages || []).forEach((pkgItem: any) => {
      const pkg = packageMap.get(pkgItem.package_id);
      if (!pkg) return;
      const tier = pkg[tierKey] || pkg.standard_tier || {};
      const schedulingTime = tier.scheduling_time || 0;
      if (schedulingTime > 0) {
        if (schedulingTime > onsiteMaxMins) onsiteMaxMins = schedulingTime;
      } else {
        (pkgItem.products || pkg.products || []).forEach((prodItem: any) => {
          const product = productMap.get(prodItem.product_id);
          if (!product) return;
          const prodTier = product[tierKey] || product.standard_tier || {};
          const qty = prodItem.quantity || 1;
          const base = prodTier.onsite_time || 0;
          const increment = prodTier.onsite_time_increment || 0;
          const includedQty = prodTier.included_qty || product.min_quantity || 1;
          const mins = base + Math.max(0, qty - includedQty) * increment;
          if (mins > onsiteMaxMins) onsiteMaxMins = mins;
        });
      }
    });

    const existingTasks = await entities.ProjectTask.filter({ project_id }, null, 1000);

    const onsiteRoles = [
      { role: 'photographer', staffId: project.photographer_id || project.onsite_staff_1_id || null, staffName: project.photographer_name || project.onsite_staff_1_name || null, staffType: project.photographer_type || project.onsite_staff_1_type || 'user' },
      { role: 'videographer', staffId: project.videographer_id || project.onsite_staff_2_id || null, staffName: project.videographer_name || project.onsite_staff_2_name || null, staffType: project.videographer_type || project.onsite_staff_2_type || 'user' },
    ];

    let dueDate: string | null = null;
    if (project.shoot_date && onsiteMaxMins > 0) {
      const shootDateStr = project.shoot_date;
      let shootTimeStr = project.shoot_time || '09:00';
      if (shootTimeStr.includes('T') || shootTimeStr.length > 8) {
        try {
          const t = new Date(shootTimeStr.endsWith('Z') ? shootTimeStr : shootTimeStr + 'Z');
          if (!isNaN(t.getTime())) {
            shootTimeStr = t.toLocaleTimeString('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hour12: false }).slice(0, 5);
          } else { shootTimeStr = '09:00'; }
        } catch { shootTimeStr = '09:00'; }
      }
      const shootDt = new Date(`${shootDateStr}T${shootTimeStr}:00`);
      if (!isNaN(shootDt.getTime())) {
        dueDate = new Date(shootDt.getTime() + onsiteMaxMins * 60 * 1000).toISOString();
      }
    }

    for (const { role, staffId, staffName, staffType } of onsiteRoles) {
      const templateId = `onsite:${role}`;
      const existingTask = existingTasks.find((t: any) => t.template_id === templateId);

      if (onsiteMaxMins === 0 || !staffId) {
        if (existingTask && !existingTask.is_deleted) {
          await entities.ProjectTask.update(existingTask.id, { is_deleted: true });
          const timeLogs = await entities.TaskTimeLog.filter({ task_id: existingTask.id });
          await Promise.all(timeLogs.map((log: any) => entities.TaskTimeLog.update(log.id, { is_active: false, status: 'completed' })));
        }
        continue;
      }

      const alreadyCompleted = existingTask?.is_completed && existingTask?.is_locked;
      const taskData: any = {
        project_id, title: `Onsite - ${role.charAt(0).toUpperCase() + role.slice(1)}`,
        task_type: 'onsite', auto_assign_role: role, template_id: templateId, auto_generated: true,
        ...(alreadyCompleted ? {} : { is_completed: false, is_locked: false }),
        is_deleted: false, is_blocked: false, estimated_minutes: onsiteMaxMins, due_date: dueDate,
        assigned_to: staffType !== 'team' ? staffId : null, assigned_to_name: staffType !== 'team' ? staffName : null,
        assigned_to_team_id: staffType === 'team' ? staffId : null, assigned_to_team_name: staffType === 'team' ? staffName : null,
      };

      if (existingTask) { await entities.ProjectTask.update(existingTask.id, taskData); }
      else { await entities.ProjectTask.create({ ...taskData, is_completed: false, is_locked: false }); }
    }

    console.log(`syncOnsiteEffortTasks: upserted onsite tasks for project ${project_id}.`);
    return jsonResponse({ success: true, project_id, onsite_minutes: onsiteMaxMins });
  } catch (error: any) {
    console.error('syncOnsiteEffortTasks error:', error);
    return errorResponse(error.message);
  }
});

import { getAdminClient, createEntities, handleCors, jsonResponse, errorResponse, getUserFromReq, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('syncOnsiteEffortTasks', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    // ── Auth: require any authenticated user or service role ──
    const user = await getUserFromReq(req).catch(() => null);
    const isServiceRole = user?.id === '__service_role__';
    if (!isServiceRole) {
      if (!user) return errorResponse('Authentication required', 401);
    }

    const admin = getAdminClient();
    const entities = createEntities(admin);
    const body = await req.json().catch(() => ({} as any));
    const { project_id } = body;

    if (!project_id) return jsonResponse({ success: false, error: 'project_id required' }, 400);

    // entities.Project.get() throws on missing row ("Cannot coerce the result to a
    // single JSON object"). Catch it so a stale/wrong project_id is a 404, not a 500.
    const [project, allProducts, allPackages] = await Promise.all([
      entities.Project.get(project_id).catch(() => null),
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

    // Onsite time is MAX across BOTH the package-level scheduling_time AND
    // each nested product's onsite_time. Previously this was if/else — when
    // a package had scheduling_time set, nested products were skipped entirely.
    // Bug: a package with scheduling_time=60 but a nested Dusk Video product
    // needing 90 min onsite would incorrectly estimate 60 min. Now we take
    // the max of both dimensions so the bigger number always wins.
    (project.packages || []).forEach((pkgItem: any) => {
      const pkg = packageMap.get(pkgItem.package_id);
      if (!pkg) return;
      const tier = pkg[tierKey] || pkg.standard_tier || {};
      const schedulingTime = tier.scheduling_time || 0;

      // Package-level contribution
      if (schedulingTime > onsiteMaxMins) onsiteMaxMins = schedulingTime;

      // Product-level contribution — always evaluated, even when the package
      // also has scheduling_time set. Whichever is bigger wins.
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
    });

    const existingTasks = await entities.ProjectTask.filter({ project_id }, null, 1000);

    // ── Determine which onsite roles are actually needed based on products ──
    // Photography categories: Images, Drones, Floorplan (require photographer on-site)
    // Videography categories: Video (requires videographer on-site)
    // Neither: Fees, Editing (post-production only, no onsite presence)
    const PHOTO_CATEGORIES = new Set(['Images', 'Drones', 'Floorplan']);
    const VIDEO_CATEGORIES = new Set(['Video']);

    let needsPhotographer = false;
    let needsVideographer = false;

    const checkProduct = (productId: string) => {
      const product = productMap.get(productId);
      if (!product?.category) return;
      if (PHOTO_CATEGORIES.has(product.category)) needsPhotographer = true;
      if (VIDEO_CATEGORIES.has(product.category)) needsVideographer = true;
    };

    (project.products || []).forEach((item: any) => checkProduct(item.product_id));
    (project.packages || []).forEach((pkgItem: any) => {
      const pkg = packageMap.get(pkgItem.package_id);
      if (!pkg) return;
      // Check nested products within the package — prefer pkgItem.products if non-empty,
      // otherwise fall back to the package definition's products
      const nestedProducts = (pkgItem.products?.length > 0 ? pkgItem.products : pkg.products) || [];
      nestedProducts.forEach((prodItem: any) => checkProduct(prodItem.product_id));
    });

    const onsiteRoles = [
      { role: 'photographer', needed: needsPhotographer, staffId: project.photographer_id || project.onsite_staff_1_id || null, staffName: project.photographer_name || project.onsite_staff_1_name || null, staffType: project.photographer_type || project.onsite_staff_1_type || 'user' },
      { role: 'videographer', needed: needsVideographer, staffId: project.videographer_id || project.onsite_staff_2_id || null, staffName: project.videographer_name || project.onsite_staff_2_name || null, staffType: project.videographer_type || project.onsite_staff_2_type || 'user' },
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

    for (const { role, needed, staffId, staffName, staffType } of onsiteRoles) {
      const templateId = `onsite:${role}`;
      const existingTask = existingTasks.find((t: any) => t.template_id === templateId);

      // Delete task if: no onsite time, no staff assigned, OR role not needed by products
      if (onsiteMaxMins === 0 || !staffId || !needed) {
        if (existingTask && !existingTask.is_deleted) {
          await entities.ProjectTask.update(existingTask.id, { is_deleted: true });
          const timeLogs = await entities.TaskTimeLog.filter({ task_id: existingTask.id });
          await Promise.all(timeLogs.map((log: any) => entities.TaskTimeLog.update(log.id, { is_active: false, status: 'completed' })));
          console.log(`syncOnsiteEffortTasks: removed ${role} onsite task (needed=${needed}, staffId=${!!staffId}, onsiteMaxMins=${onsiteMaxMins})`);
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

    console.log(`syncOnsiteEffortTasks: project ${project_id} — photo=${needsPhotographer}, video=${needsVideographer}, onsiteMaxMins=${onsiteMaxMins}`);
    return jsonResponse({ success: true, project_id, onsite_minutes: onsiteMaxMins });
  } catch (error: any) {
    console.error('syncOnsiteEffortTasks error:', error);
    return errorResponse(error.message);
  }
});

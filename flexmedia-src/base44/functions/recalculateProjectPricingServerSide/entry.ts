import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Thin wrapper that delegates ALL pricing math to calculateProjectPricing.
 * This function only:
 *   1. Fetches the project's current products/packages
 *   2. Calls calculateProjectPricing (the ONE canonical engine)
 *   3. Writes the result back to the project
 *   4. Fires notifications if the price changed significantly
 *   5. Triggers post-save side effects (syncOnsiteEffortTasks)
 *
 * ZERO pricing formulas in this file. If pricing logic needs to change,
 * change it in calculateProjectPricing.ts — this wrapper inherits it automatically.
 *
 * Called by:
 *   - ProjectProductsPackages.jsx (frontend, after batch product/package update)
 *   - applyProjectRoleDefaults.ts (backend, after role assignment generates tasks)
 *   - processTonomoQueue.ts (backend, after Tonomo booking syncs products)
 */

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

    // Auth: accept authenticated users or service-role calls
    const user = await base44.auth.me().catch(() => null);
    if (!user) {
      try {
        await base44.asServiceRole.entities.Project.get('_auth_probe_').catch(() => null);
      } catch (authErr: any) {
        if (authErr?.status === 403) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
      }
    }

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return Response.json({ _version: 'v2.0', _fn: 'recalculateProjectPricingServerSide', _ts: '2026-03-17' });
    }

    const { project_id } = body;

    if (!project_id) {
      return Response.json({ error: 'project_id required' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Step 1: Fetch the project
    const project = await db.Project.get(project_id);
    if (!project) {
      return Response.json({ error: 'Project not found' }, { status: 404 });
    }

    const products = project.products || [];
    const packages = project.packages || [];

    if (products.length === 0 && packages.length === 0) {
      return Response.json({ success: true, skipped: true, reason: 'no products or packages' });
    }

    // Step 2: Call the ONE canonical pricing engine
    let calcResult: any = null;
    try {
      const response = await base44.asServiceRole.functions.invoke('calculateProjectPricing', {
        agent_id: project.agent_id || null,
        agency_id: project.agency_id || null,
        products,
        packages,
        pricing_tier: project.pricing_tier || 'standard',
        project_type_id: project.project_type_id || null,
      });
      calcResult = response?.data || response;
    } catch (invokeErr: any) {
      console.error('calculateProjectPricing invoke failed:', invokeErr?.message);
      return Response.json({
        error: 'Pricing calculation failed',
        detail: invokeErr?.message,
      }, { status: 500 });
    }

    if (!calcResult?.success || calcResult.calculated_price == null) {
      return Response.json({
        error: 'Pricing calculation returned invalid result',
        detail: calcResult?.error || 'No calculated_price in response',
      }, { status: 500 });
    }

    const newPrice = calcResult.calculated_price;
    const tier = calcResult.pricing_tier || project.pricing_tier || 'standard';

    // Step 3: Write result back to project
    await db.Project.update(project_id, {
      calculated_price: newPrice,
      price: newPrice,
      products_needs_recalc: false,
      price_matrix_snapshot: calcResult.price_matrix_snapshot || null,
    });

    // Step 4: Log activity
    const oldPrice = project.calculated_price || 0;
    db.ProjectActivity.create({
      project_id,
      project_title: project.title || project.property_address || '',
      action: 'update',
      description: `Pricing recalculated: $${Math.round(newPrice).toLocaleString()}${oldPrice ? ` (was $${Math.round(oldPrice).toLocaleString()})` : ''}. Tier: ${tier}. Matrix: ${calcResult.price_matrix_snapshot ? 'agent/agency matrix applied' : 'master pricing'}.`,
      actor_type: 'system',
      actor_source: 'recalculateProjectPricingServerSide',
      user_name: 'System',
      user_email: 'system@flexmedia',
      changed_fields: JSON.stringify([{
        field: 'calculated_price',
        old_value: oldPrice?.toString() || '0',
        new_value: Math.round(newPrice).toString(),
      }]),
    }).catch(() => {});

    // Step 5: Notify if price changed significantly (>$50 or >5%)
    const priceDelta = Math.abs(newPrice - oldPrice);
    const pctDelta = oldPrice > 0 ? (priceDelta / oldPrice) * 100 : 0;
    if (oldPrice > 0 && (priceDelta >= 50 || pctDelta >= 5)) {
      const projectName = project.title || project.property_address || 'Project';
      const notifyUsers: string[] = [project.project_owner_id].filter(Boolean);
      db.User.list('-created_date', 200)
        .then(async (users: any[]) => {
          users
            .filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
            .forEach((u: any) => notifyUsers.push(u.id));
          for (const userId of [...new Set(notifyUsers)].filter(Boolean)) {
            const allowed = await _canNotify(base44, userId, 'project_pricing_changed', 'project');
            if (!allowed) continue;
            db.Notification.create({
              user_id: userId,
              type: 'project_pricing_changed',
              category: 'project',
              severity: 'info',
              title: `Pricing updated — ${projectName}`,
              message: `Price updated to $${Math.round(newPrice).toLocaleString()} (was $${Math.round(oldPrice).toLocaleString()}, ${priceDelta >= 50 ? `Δ$${Math.round(priceDelta)}` : `Δ${pctDelta.toFixed(0)}%`}).`,
              project_id,
              project_name: projectName,
              cta_label: 'View Project',
              is_read: false,
              is_dismissed: false,
              source: 'pricing',
              idempotency_key: `pricing_changed:${project_id}:${Math.round(newPrice)}:${userId}`,
              created_date: new Date().toISOString(),
            }).catch(() => {});
          }
          }).catch(() => {});

          // Team feed event for significant price changes
          db.TeamActivityFeed.create({
          event_type: 'pricing_changed',
          category: 'financial',
          severity: 'info',
          actor_id: null,
          actor_name: 'System',
          title: `Pricing recalculated: ${projectName}`,
          description: `$${Math.round(oldPrice).toLocaleString()} → $${Math.round(newPrice).toLocaleString()} (Δ$${Math.round(priceDelta)}).`,
          project_id,
          project_name: projectName,
          project_stage: project.status || '',
          entity_type: 'project',
          entity_id: project_id,
          created_date: new Date().toISOString(),
          }).catch(() => {});
          }

          // Step 6: Sync tasks, onsite effort, and clean up orphans (fire-and-forget)
    base44.asServiceRole.functions.invoke('syncProjectTasksFromProducts', {
      project_id,
    }).catch(() => {});
    base44.asServiceRole.functions.invoke('syncOnsiteEffortTasks', {
      project_id,
    }).catch(() => {});
    base44.asServiceRole.functions.invoke('cleanupOrphanedProjectTasks', {
      project_id,
    }).catch(() => {});

    return Response.json({
      success: true,
      project_id,
      calculated_price: newPrice,
      pricing_tier: tier,
      used_matrix: !!calcResult.price_matrix_snapshot,
      delegated_to: 'calculateProjectPricing',
    });

  } catch (error: any) {
    console.error('recalculateProjectPricingServerSide error:', error);
    return Response.json({ error: error.message }, { status: 500 });
  }
});
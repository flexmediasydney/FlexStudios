import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me().catch(() => null);
    const payload = await req.json();

    if (payload?._health_check) {
      return Response.json({ _version: 'v1.1', _fn: 'logProductChange', _ts: '2026-03-17' });
    }

    const { event, data, old_data } = payload;

    // Accept both user sessions and service-role/automation calls
    // Entity automations may fire without a user session

    const changedFields = [];
    if (event.type === 'update' && old_data && data) {
      for (const key in data) {
        if (JSON.stringify(old_data[key]) !== JSON.stringify(data[key])) {
          changedFields.push({
            field: key,
            old_value: JSON.stringify(old_data[key] || ''),
            new_value: JSON.stringify(data[key] || '')
          });
        }
      }
    }

    await base44.asServiceRole.entities.ProductAuditLog.create({
      product_id: event.entity_id,
      product_name: data?.name || old_data?.name || 'Unknown',
      action: event.type,
      changed_fields: changedFields,
      previous_state: old_data || null,
      new_state: data || null,
      user_name: user?.full_name,
      user_email: user?.email,
      timestamp: new Date().toISOString()
    });

    // Fix 6a — re-sync tasks on open projects when task templates or effort estimates change
    const templateFields = ['standard_task_templates', 'premium_task_templates', 'standard_tier', 'premium_tier'];
    const templateChanged = changedFields.some((f: any) => templateFields.includes(f.field));
    if (templateChanged && event.entity_id) {
      try {
        const productId = event.entity_id;
        const allProjects = await base44.asServiceRole.entities.Project.filter({}, null, 2000);
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          const hasProduct = (p.products || []).some((pr: any) => pr.product_id === productId);
          const hasViaPackage = (p.packages || []).some((pkg: any) =>
            (pkg.products || []).some((pr: any) => pr.product_id === productId)
          );
          return hasProduct || hasViaPackage;
        });
        for (const project of affectedProjects.slice(0, 50)) {
          base44.asServiceRole.functions.invoke('syncProjectTasksFromProducts', {
            project_id: project.id,
          }).catch(() => {});
        }

        // Also recalculate pricing for affected projects when tier pricing changes
        const pricingFields = ['standard_tier', 'premium_tier'];
        const pricingChanged = changedFields.some((f: any) => pricingFields.includes(f.field));
        if (pricingChanged) {
          for (const project of affectedProjects.slice(0, 50)) {
            base44.asServiceRole.functions.invoke('recalculateProjectPricingServerSide', {
              project_id: project.id,
            }).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }
    }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
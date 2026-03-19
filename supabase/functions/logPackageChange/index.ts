import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req).catch(() => null);
    const payload = await req.json();

    if (payload?._health_check) {
      return jsonResponse({ _version: 'v1.1', _fn: 'logPackageChange', _ts: '2026-03-17' });
    }

    const { event, data, old_data } = payload;

    const changedFields: any[] = [];
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

    await entities.PackageAuditLog.create({
      package_id: event.entity_id,
      package_name: data?.name || old_data?.name || 'Unknown',
      action: event.type,
      changed_fields: changedFields,
      previous_state: old_data || null,
      new_state: data || null,
      user_name: user?.full_name,
      user_email: user?.email,
      timestamp: new Date().toISOString()
    });

    // Cascade to affected projects: sync tasks + recalculate pricing when templates or pricing change
    const templateFields = ['standard_task_templates', 'premium_task_templates', 'standard_tier', 'premium_tier', 'products'];
    const templateChanged = changedFields.some((f: any) => templateFields.includes(f.field));
    if (templateChanged && event.entity_id) {
      try {
        const packageId = event.entity_id;
        const allProjects = await entities.Project.filter({}, null, 2000);
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          return (p.packages || []).some((pkg: any) => pkg.package_id === packageId);
        });
        for (const project of affectedProjects.slice(0, 50)) {
          invokeFunction('syncProjectTasksFromProducts', {
            project_id: project.id,
          }).catch(() => {});
        }

        // Recalculate pricing when tier pricing changes
        const pricingFields = ['standard_tier', 'premium_tier'];
        const pricingChanged = changedFields.some((f: any) => pricingFields.includes(f.field));
        if (pricingChanged) {
          for (const project of affectedProjects.slice(0, 50)) {
            invokeFunction('recalculateProjectPricingServerSide', {
              project_id: project.id,
            }).catch(() => {});
          }
        }
      } catch { /* non-fatal */ }
    }

    return jsonResponse({ success: true });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

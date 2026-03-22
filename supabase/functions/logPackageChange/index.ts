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
      return jsonResponse({ _version: 'v1.2', _fn: 'logPackageChange', _ts: '2026-03-22' });
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

    // Build human-readable summary
    let changesSummary = '';
    if (event.type === 'create') {
      changesSummary = `Created package "${data?.name || 'Unnamed'}"`;
    } else if (event.type === 'delete') {
      changesSummary = `Deleted package "${old_data?.name || 'Unnamed'}"`;
    } else {
      const parts: string[] = [];
      for (const cf of changedFields) {
        if (cf.field === 'name') parts.push(`Renamed "${old_data?.name}" → "${data?.name}"`);
        else if (cf.field === 'standard_tier') parts.push('Updated standard pricing');
        else if (cf.field === 'premium_tier') parts.push('Updated premium pricing');
        else if (cf.field === 'products') parts.push('Updated included products');
        else if (cf.field === 'is_active') parts.push(data?.is_active ? 'Reactivated' : 'Deactivated');
        else if (cf.field === 'standard_task_templates') parts.push('Updated standard tasks');
        else if (cf.field === 'premium_task_templates') parts.push('Updated premium tasks');
      }
      changesSummary = parts.length > 0 ? parts.join('. ') : `Updated package "${data?.name || 'Unnamed'}"`;
    }

    await entities.PackageAuditLog.create({
      package_id: event.entity_id,
      package_name: data?.name || old_data?.name || 'Unknown',
      action: event.type,
      changed_fields: changedFields,
      changes_summary: changesSummary,
      previous_state: old_data || null,
      new_state: data || null,
      user_name: user?.full_name,
      user_email: user?.email,
      timestamp: new Date().toISOString()
    });

    // ─── CASCADE: Package rename → update all price matrices ────────────────
    const nameChanged = changedFields.some((f: any) => f.field === 'name');
    if (nameChanged && event.entity_id && data?.name) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.package_pricing || [];
          const idx = pp.findIndex((p: any) => p.package_id === event.entity_id);
          if (idx !== -1 && pp[idx].package_name !== data.name) {
            const updated = [...pp];
            updated[idx] = { ...updated[idx], package_name: data.name };
            await entities.PriceMatrix.update(matrix.id, { package_pricing: updated });
          }
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Package delete → remove from all price matrices ───────────
    if (event.type === 'delete' && event.entity_id) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.package_pricing || [];
          const filtered = pp.filter((p: any) => p.package_id !== event.entity_id);
          if (filtered.length !== pp.length) {
            await entities.PriceMatrix.update(matrix.id, { package_pricing: filtered });
          }
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Package deactivation → remove overrides from matrices ─────
    const activeChanged = changedFields.some((f: any) => f.field === 'is_active');
    if (activeChanged && data?.is_active === false && event.entity_id) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.package_pricing || [];
          const filtered = pp.filter((p: any) => p.package_id !== event.entity_id);
          if (filtered.length !== pp.length) {
            await entities.PriceMatrix.update(matrix.id, { package_pricing: filtered });
          }
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Task/pricing changes → sync projects ──────────────────────
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
        for (const project of affectedProjects.slice(0, 500)) {
          invokeFunction('syncProjectTasksFromProducts', {
            project_id: project.id,
          }).catch(() => {});
        }

        const pricingFields = ['standard_tier', 'premium_tier'];
        const pricingChanged = changedFields.some((f: any) => pricingFields.includes(f.field));
        if (pricingChanged) {
          for (const project of affectedProjects.slice(0, 500)) {
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

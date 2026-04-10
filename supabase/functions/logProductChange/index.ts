import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req).catch(() => null);
    const payload = await req.json().catch(() => null);

    if (!payload) {
      return errorResponse('Invalid JSON in request body', 400);
    }

    if (payload?._health_check) {
      return jsonResponse({ _version: 'v1.2', _fn: 'logProductChange', _ts: '2026-03-22' });
    }

    const { event, data, old_data } = payload;

    if (!event || !event.type) {
      return errorResponse('event.type is required', 400);
    }

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
      changesSummary = `Created product "${data?.name || 'Unnamed'}"`;
    } else if (event.type === 'delete') {
      changesSummary = `Deleted product "${old_data?.name || 'Unnamed'}"`;
    } else {
      const parts: string[] = [];
      for (const cf of changedFields) {
        if (cf.field === 'name') parts.push(`Renamed "${old_data?.name}" → "${data?.name}"`);
        else if (cf.field === 'standard_tier') parts.push('Updated standard pricing');
        else if (cf.field === 'premium_tier') parts.push('Updated premium pricing');
        else if (cf.field === 'category') parts.push(`Category: ${old_data?.category} → ${data?.category}`);
        else if (cf.field === 'is_active') parts.push(data?.is_active ? 'Reactivated' : 'Deactivated');
        else if (cf.field === 'standard_task_templates') parts.push('Updated standard tasks');
        else if (cf.field === 'premium_task_templates') parts.push('Updated premium tasks');
      }
      changesSummary = parts.length > 0 ? parts.join('. ') : `Updated product "${data?.name || 'Unnamed'}"`;
    }

    await entities.ProductAuditLog.create({
      product_id: event.entity_id,
      product_name: data?.name || old_data?.name || 'Unknown',
      action: event.type,
      changed_fields: changedFields,
      changes_summary: changesSummary,
      previous_state: old_data || null,
      new_state: data || null,
      user_name: user?.full_name,
      user_email: user?.email,
      timestamp: new Date().toISOString()
    });

    // ─── CASCADE: Product rename → update all price matrices ────────────────
    const nameChanged = changedFields.some((f: any) => f.field === 'name');
    if (nameChanged && event.entity_id && data?.name) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.product_pricing || [];
          const idx = pp.findIndex((p: any) => p.product_id === event.entity_id);
          if (idx !== -1 && pp[idx].product_name !== data.name) {
            const updated = [...pp];
            updated[idx] = { ...updated[idx], product_name: data.name };
            await entities.PriceMatrix.update(matrix.id, { product_pricing: updated });
          }
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Product delete → remove from all price matrices & recalculate affected projects ──
    if (event.type === 'delete' && event.entity_id) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.product_pricing || [];
          const filtered = pp.filter((p: any) => p.product_id !== event.entity_id);
          if (filtered.length !== pp.length) {
            await entities.PriceMatrix.update(matrix.id, { product_pricing: filtered });
          }
        }
      } catch { /* non-fatal */ }

      // Recalculate pricing for projects that referenced the deleted product
      try {
        const productId = event.entity_id;
        const allProjects = await entities.Project.filter({}, null, 2000);
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          const hasProduct = (p.products || []).some((pr: any) => pr.product_id === productId);
          const hasViaPackage = (p.packages || []).some((pkg: any) =>
            (pkg.products || []).some((pr: any) => pr.product_id === productId)
          );
          return hasProduct || hasViaPackage;
        });
        // Process ALL affected projects in batches of 10 to avoid overwhelming the system
        for (let i = 0; i < affectedProjects.length; i += 10) {
          const batch = affectedProjects.slice(i, i + 10);
          await Promise.allSettled(batch.map((project: any) =>
            invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id })
          ));
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Product deactivation → remove overrides from matrices ─────
    const activeChanged = changedFields.some((f: any) => f.field === 'is_active');
    if (activeChanged && data?.is_active === false && event.entity_id) {
      try {
        const allMatrices = await entities.PriceMatrix.filter({}, null, 1000);
        for (const matrix of allMatrices) {
          const pp = matrix.product_pricing || [];
          const filtered = pp.filter((p: any) => p.product_id !== event.entity_id);
          if (filtered.length !== pp.length) {
            await entities.PriceMatrix.update(matrix.id, { product_pricing: filtered });
          }
        }
      } catch { /* non-fatal */ }

      // Also recalculate pricing for affected projects when product is deactivated
      try {
        const productId = event.entity_id;
        const allProjects = await entities.Project.filter({}, null, 2000);
        const deactivatedAffected = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          const hasProduct = (p.products || []).some((pr: any) => pr.product_id === productId);
          const hasViaPackage = (p.packages || []).some((pkg: any) =>
            (pkg.products || []).some((pr: any) => pr.product_id === productId)
          );
          return hasProduct || hasViaPackage;
        });
        for (let i = 0; i < deactivatedAffected.length; i += 10) {
          const batch = deactivatedAffected.slice(i, i + 10);
          await Promise.allSettled(batch.map((project: any) =>
            invokeFunction('recalculateProjectPricingServerSide', { project_id: project.id })
          ));
        }
      } catch { /* non-fatal */ }
    }

    // ─── CASCADE: Task template / pricing changes → sync projects ───────────
    const templateFields = ['standard_task_templates', 'premium_task_templates', 'standard_tier', 'premium_tier'];
    const templateChanged = changedFields.some((f: any) => templateFields.includes(f.field));
    if (templateChanged && event.entity_id) {
      try {
        const productId = event.entity_id;
        const allProjects = await entities.Project.filter({}, null, 2000);
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          const hasProduct = (p.products || []).some((pr: any) => pr.product_id === productId);
          const hasViaPackage = (p.packages || []).some((pkg: any) =>
            (pkg.products || []).some((pr: any) => pr.product_id === productId)
          );
          return hasProduct || hasViaPackage;
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

import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    const payload = await req.json();

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    // Support both calling conventions:
    //   1. From PriceMatrixEditor (frontend): { price_matrix_id, previous_state, new_state }
    //   2. From realtime triggers (legacy):   { event, data, old_data }
    let priceMatrixId: string | undefined;
    let data: any;
    let oldData: any;
    let action: string;

    if (payload.price_matrix_id) {
      priceMatrixId = payload.price_matrix_id;
      data = payload.new_state;
      oldData = payload.previous_state;
      action = 'update';
    } else {
      priceMatrixId = payload.event?.entity_id;
      data = payload.data;
      oldData = payload.old_data;
      action = payload.event?.type || 'update';
    }

    const changedFields: any[] = [];
    if (oldData && data) {
      for (const key in data) {
        if (JSON.stringify(oldData[key]) !== JSON.stringify(data[key])) {
          changedFields.push({
            field: key,
            old_value: JSON.stringify(oldData[key] || ''),
            new_value: JSON.stringify(data[key] || '')
          });
        }
      }
    }

    // ─── Build human-readable summary with product/package names ────────────
    const summaryParts: string[] = [];
    for (const change of changedFields) {
      if (change.field === 'product_pricing') {
        try {
          const oldPricing = JSON.parse(change.old_value) || [];
          const newPricing = JSON.parse(change.new_value) || [];
          const details: string[] = [];
          for (const np of newPricing) {
            const op = oldPricing.find((o: any) => o.product_id === np.product_id);
            if (!op) {
              details.push(`Added ${np.product_name || 'product'}`);
            } else {
              const priceChanges: string[] = [];
              if (op.standard_base !== np.standard_base) priceChanges.push(`Std $${op.standard_base}→$${np.standard_base}`);
              if (op.premium_base !== np.premium_base) priceChanges.push(`Prm $${op.premium_base}→$${np.premium_base}`);
              if (op.standard_unit !== np.standard_unit) priceChanges.push(`Std/unit $${op.standard_unit}→$${np.standard_unit}`);
              if (op.premium_unit !== np.premium_unit) priceChanges.push(`Prm/unit $${op.premium_unit}→$${np.premium_unit}`);
              if (op.override_enabled !== np.override_enabled) priceChanges.push(np.override_enabled ? 'Override enabled' : 'Override disabled');
              if (priceChanges.length > 0) details.push(`${np.product_name || 'Product'}: ${priceChanges.join(', ')}`);
            }
          }
          for (const op of oldPricing) {
            if (!newPricing.find((n: any) => n.product_id === op.product_id)) {
              details.push(`Removed ${op.product_name || 'product'}`);
            }
          }
          summaryParts.push(details.length > 0 ? details.join('; ') : 'Updated product pricing');
        } catch {
          summaryParts.push('Updated product pricing');
        }
      } else if (change.field === 'package_pricing') {
        try {
          const oldPkg = JSON.parse(change.old_value) || [];
          const newPkg = JSON.parse(change.new_value) || [];
          const details: string[] = [];
          for (const np of newPkg) {
            const op = oldPkg.find((o: any) => o.package_id === np.package_id);
            if (!op) {
              details.push(`Added ${np.package_name || 'package'}`);
            } else {
              const changes: string[] = [];
              if (op.standard_price !== np.standard_price) changes.push(`Std $${op.standard_price}→$${np.standard_price}`);
              if (op.premium_price !== np.premium_price) changes.push(`Prm $${op.premium_price}→$${np.premium_price}`);
              if (op.override_enabled !== np.override_enabled) changes.push(np.override_enabled ? 'Override enabled' : 'Override disabled');
              if (changes.length > 0) details.push(`${np.package_name || 'Package'}: ${changes.join(', ')}`);
            }
          }
          summaryParts.push(details.length > 0 ? details.join('; ') : 'Updated package pricing');
        } catch {
          summaryParts.push('Updated package pricing');
        }
      } else if (change.field === 'blanket_discount') {
        try {
          const oldD = JSON.parse(change.old_value) || {};
          const newD = JSON.parse(change.new_value) || {};
          if (!oldD.enabled && newD.enabled) {
            summaryParts.push(`Enabled blanket discount: Products ${newD.product_percent}%, Packages ${newD.package_percent}%`);
          } else if (oldD.enabled && !newD.enabled) {
            summaryParts.push('Disabled blanket discount');
          } else if (newD.enabled) {
            const parts: string[] = [];
            if (oldD.product_percent !== newD.product_percent) parts.push(`Products ${oldD.product_percent}%→${newD.product_percent}%`);
            if (oldD.package_percent !== newD.package_percent) parts.push(`Packages ${oldD.package_percent}%→${newD.package_percent}%`);
            summaryParts.push(parts.length > 0 ? `Blanket discount: ${parts.join(', ')}` : 'Updated blanket discount');
          }
        } catch {
          summaryParts.push('Updated blanket discount');
        }
      } else if (change.field === 'use_default_pricing') {
        summaryParts.push(data?.use_default_pricing ? 'Switched to default pricing' : 'Switched to custom pricing');
      }
    }
    const changesSummary = summaryParts.length > 0
      ? summaryParts.join('. ')
      : `Updated pricing for ${data?.entity_name || 'entity'}`;

    // ─── Calculate affected projects BEFORE creating audit log ──────────────
    let affectedProjectsCount = 0;
    const entityType = data?.entity_type || oldData?.entity_type;
    const entityId = data?.entity_id || oldData?.entity_id;
    let affectedProjects: any[] = [];

    try {
      if (entityType && entityId) {
        const allProjects = await entities.Project.filter({}, null, 2000);
        const filterField = entityType === 'agent' ? 'agent_id' : 'agency_id';
        affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          if ((p.products || []).length === 0 && (p.packages || []).length === 0) return false;
          return p[filterField] === entityId;
        });
        affectedProjectsCount = affectedProjects.length;
      }
    } catch { /* non-fatal */ }

    // ─── Create audit log entry (now includes affected count) ───────────────
    await entities.PriceMatrixAuditLog.create({
      price_matrix_id: priceMatrixId,
      entity_type: entityType,
      entity_id: entityId,
      entity_name: data?.entity_name || oldData?.entity_name,
      action,
      changed_fields: changedFields,
      changes_summary: changesSummary,
      previous_state: oldData || null,
      new_state: data || null,
      user_name: user.full_name,
      user_email: user.email,
      timestamp: new Date().toISOString(),
      affected_projects_count: affectedProjectsCount
    });

    // ─── Cascade recalculation to affected projects ─────────────────────────
    try {
      for (const project of affectedProjects.slice(0, 100)) {
        invokeFunction('recalculateProjectPricingServerSide', {
          project_id: project.id,
        }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    return jsonResponse({ success: true, affected_projects_count: affectedProjectsCount });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

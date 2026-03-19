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
      // Frontend calling convention
      priceMatrixId = payload.price_matrix_id;
      data = payload.new_state;
      oldData = payload.previous_state;
      action = 'update';
    } else {
      // Legacy/trigger calling convention
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

    // Build a human-readable summary
    const summaryParts: string[] = [];
    for (const change of changedFields) {
      if (['product_pricing', 'package_pricing', 'blanket_discount'].includes(change.field)) {
        summaryParts.push(`Updated ${change.field.replace(/_/g, ' ')}`);
      } else if (change.field === 'use_default_pricing') {
        summaryParts.push(data?.use_default_pricing ? 'Switched to default pricing' : 'Switched to custom pricing');
      }
    }
    const changesSummary = summaryParts.length > 0
      ? summaryParts.join('; ')
      : `Updated pricing for ${data?.entity_name || 'entity'}`;

    await entities.PriceMatrixAuditLog.create({
      price_matrix_id: priceMatrixId,
      entity_type: data?.entity_type || oldData?.entity_type,
      entity_id: data?.entity_id || oldData?.entity_id,
      entity_name: data?.entity_name || oldData?.entity_name,
      action,
      changed_fields: changedFields,
      changes_summary: changesSummary,
      previous_state: oldData || null,
      new_state: data || null,
      user_name: user.full_name,
      user_email: user.email,
      timestamp: new Date().toISOString()
    });

    // Recalculate pricing on active projects affected by this matrix change
    try {
      const entityType = data?.entity_type || oldData?.entity_type;
      const entityId = data?.entity_id || oldData?.entity_id;
      if (entityType && entityId) {
        const allProjects = await entities.Project.filter({}, null, 2000);
        const filterField = entityType === 'agent' ? 'agent_id' : 'agency_id';
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          if ((p.products || []).length === 0 && (p.packages || []).length === 0) return false;
          return p[filterField] === entityId;
        });
        for (const project of affectedProjects.slice(0, 100)) {
          invokeFunction('recalculateProjectPricingServerSide', {
            project_id: project.id,
          }).catch(() => {});
        }
      }
    } catch { /* non-fatal */ }

    return jsonResponse({ success: true });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

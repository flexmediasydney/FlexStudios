import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    const payload = await req.json();

    const { event, data, old_data } = payload;

    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

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

    await base44.asServiceRole.entities.PriceMatrixAuditLog.create({
      price_matrix_id: event.entity_id,
      entity_type: data?.entity_type || old_data?.entity_type,
      entity_id: data?.entity_id || old_data?.entity_id,
      entity_name: data?.entity_name || old_data?.entity_name,
      action: event.type,
      changed_fields: changedFields,
      previous_state: old_data || null,
      new_state: data || null,
      user_name: user.full_name,
      user_email: user.email,
      timestamp: new Date().toISOString()
    });

    // Recalculate pricing on active projects affected by this matrix change
    try {
      const entityType = data?.entity_type || old_data?.entity_type;
      const entityId = data?.entity_id || old_data?.entity_id;
      if (entityType && entityId) {
        const allProjects = await base44.asServiceRole.entities.Project.filter({}, null, 2000);
        const filterField = entityType === 'agent' ? 'agent_id' : 'agency_id';
        const affectedProjects = allProjects.filter((p: any) => {
          if (['delivered', 'cancelled'].includes(p.status)) return false;
          if ((p.products || []).length === 0 && (p.packages || []).length === 0) return false;
          return p[filterField] === entityId;
        });
        for (const project of affectedProjects.slice(0, 100)) {
          base44.asServiceRole.functions.invoke('recalculateProjectPricingServerSide', {
            project_id: project.id,
          }).catch(() => {});
        }
      }
    } catch { /* non-fatal */ }

    return Response.json({ success: true });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
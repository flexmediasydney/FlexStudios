import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Remove duplicate price matrices created during migration
 * Keeps the one with actual pricing data, deletes empty duplicates
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const matrices = await base44.entities.PriceMatrix.list();
    
    // Group by (entity_type, entity_id, project_type_id)
    const groups = {};
    matrices.forEach(m => {
      const key = `${m.entity_type}:${m.entity_id}:${m.project_type_id}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    });

    const deleted = [];
    
    // For each group with duplicates, keep the one with most data
    for (const key in groups) {
      const group = groups[key];
      if (group.length > 1) {
        // Sort by: has product pricing, has package pricing, has discount, most recent
        group.sort((a, b) => {
          const aDataCount = (a.product_pricing?.length || 0) + (a.package_pricing?.length || 0) + (a.blanket_discount?.enabled ? 1 : 0);
          const bDataCount = (b.product_pricing?.length || 0) + (b.package_pricing?.length || 0) + (b.blanket_discount?.enabled ? 1 : 0);
          if (aDataCount !== bDataCount) return bDataCount - aDataCount;
          return new Date(b.updated_date) - new Date(a.updated_date);
        });

        // Delete all but the first (most data-rich)
        for (let i = 1; i < group.length; i++) {
          await base44.entities.PriceMatrix.delete(group[i].id);
          deleted.push({
            id: group[i].id,
            entity_name: group[i].entity_name,
            entity_type: group[i].entity_type,
            project_type: group[i].project_type_name,
            reason: 'Duplicate - empty or less data'
          });
        }
      }
    }

    return Response.json({
      success: true,
      deleted_count: deleted.length,
      deleted: deleted
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
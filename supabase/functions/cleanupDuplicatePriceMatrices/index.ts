import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Remove duplicate price matrices created during migration
 * Keeps the one with actual pricing data, deletes empty duplicates
 */
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    const matrices = await entities.PriceMatrix.list();

    // Group by (entity_type, entity_id, project_type_id)
    const groups: Record<string, any[]> = {};
    matrices.forEach((m: any) => {
      const key = `${m.entity_type}:${m.entity_id}:${m.project_type_id}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    });

    const deleted: any[] = [];

    // For each group with duplicates, keep the one with most data
    for (const key in groups) {
      const group = groups[key];
      if (group.length > 1) {
        // Sort by: has product pricing, has package pricing, has discount, most recent
        group.sort((a: any, b: any) => {
          const aDataCount = (a.product_pricing?.length || 0) + (a.package_pricing?.length || 0) + (a.blanket_discount?.enabled ? 1 : 0);
          const bDataCount = (b.product_pricing?.length || 0) + (b.package_pricing?.length || 0) + (b.blanket_discount?.enabled ? 1 : 0);
          if (aDataCount !== bDataCount) return bDataCount - aDataCount;
          return new Date(b.updated_date).getTime() - new Date(a.updated_date).getTime();
        });

        // Delete all but the first (most data-rich)
        for (let i = 1; i < group.length; i++) {
          await entities.PriceMatrix.delete(group[i].id);
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

    return jsonResponse({
      success: true,
      deleted_count: deleted.length,
      deleted: deleted
    });

  } catch (error: any) {
    return errorResponse(error.message);
  }
});

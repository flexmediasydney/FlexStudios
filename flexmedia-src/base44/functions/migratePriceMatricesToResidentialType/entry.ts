import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Migrate all "global" (null project_type_id) price matrices to Residential Real Estate
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Get Residential Real Estate project type
    const projectTypes = await base44.entities.ProjectType.list();
    const residentialType = projectTypes.find(pt => pt.slug === 'real_estate');

    if (!residentialType) {
      return Response.json({ error: 'Residential Real Estate project type not found' }, { status: 400 });
    }

    // Get all price matrices
    const matrices = await base44.entities.PriceMatrix.list();
    const globalMatrices = matrices.filter(m => !m.project_type_id);

    // Update each global matrix
    const updated = [];
    for (const matrix of globalMatrices) {
      await base44.entities.PriceMatrix.update(matrix.id, {
        project_type_id: residentialType.id,
        project_type_name: residentialType.name
      });
      updated.push({
        id: matrix.id,
        entity_type: matrix.entity_type,
        entity_name: matrix.entity_name
      });
    }

    return Response.json({
      success: true,
      migrated_count: updated.length,
      matrices: updated,
      target_project_type: residentialType.name
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (user && !['master_admin', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const { revision_id, project_id } = await req.json();
    if (!revision_id || !project_id) return errorResponse('Missing revision_id or project_id', 400);

    const [revision, project] = await Promise.all([
      entities.ProjectRevision.get(revision_id),
      entities.Project.get(project_id),
    ]);

    if (!revision || !project) return errorResponse('Revision or project not found', 404);

    const pi = revision.pricing_impact;
    if (!pi || !pi.applied || !pi.pre_impact_products || !pi.pre_impact_price) {
      return errorResponse('No applied pricing impact to revert', 400);
    }

    // Restore original state
    const revertedProducts = pi.pre_impact_products || [];
    const revertedPackages = pi.pre_impact_packages || [];
    const revertedPrice = pi.pre_impact_price;

    await Promise.all([
      entities.Project.update(project_id, {
        products: revertedProducts,
        packages: revertedPackages,
        calculated_price: revertedPrice,
      }),
      entities.ProjectRevision.update(revision_id, {
        pricing_impact: {
          ...revision.pricing_impact,
          applied: false,
          applied_date: null,
          applied_details: null,
          reverted_date: new Date().toISOString(),
        },
      }),
    ]);

    // Sync tasks and effort after pricing revert
    invokeFunction('syncProjectTasksFromProducts', { project_id }).catch(() => {});
    invokeFunction('syncOnsiteEffortTasks', { project_id }).catch(() => {});
    invokeFunction('cleanupOrphanedProjectTasks', { project_id }).catch(() => {});

    return jsonResponse({
      success: true,
      calculated_price: revertedPrice,
      products_count: revertedProducts.length,
      packages_count: revertedPackages.length,
      reverted_details: {
        original_price: pi.pre_impact_price,
        reverted_to_price: revertedPrice,
        reverted_date: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('revertRevisionPricingImpact error:', error);
    return errorResponse(error.message || 'Failed to revert pricing impact');
  }
});

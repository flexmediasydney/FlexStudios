import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    let user = null;
    try { user = await base44.auth.me(); } catch { /* service-role call */ }
    if (user && !['master_admin', 'employee'].includes(user.role)) {
      return Response.json({ error: 'Forbidden: insufficient permissions' }, { status: 403 });
    }

    let { revision_id, project_id } = await req.json();
    
    // Allow service-role calls from other functions
    if (!revision_id || !project_id) {
      return Response.json({ error: 'Missing revision_id or project_id' }, { status: 400 });
    }

    // Fetch revision and project in parallel
    const [revision, project] = await Promise.all([
      base44.entities.ProjectRevision.get(revision_id),
      base44.entities.Project.get(project_id),
    ]);

    if (!revision || !project) {
      return Response.json({ error: 'Revision or project not found' }, { status: 404 });
    }

    const pi = revision.pricing_impact;
    if (!pi || !pi.applied || !pi.pre_impact_products || !pi.pre_impact_price) {
      return Response.json({ error: 'No applied pricing impact to revert' }, { status: 400 });
    }

    // Restore original state
    const revertedProducts = pi.pre_impact_products || [];
    const revertedPackages = pi.pre_impact_packages || [];
    const revertedPrice = pi.pre_impact_price;

    // Batch both updates in parallel
    await Promise.all([
      base44.entities.Project.update(project_id, {
        products: revertedProducts,
        packages: revertedPackages,
        calculated_price: revertedPrice,
      }),
      base44.entities.ProjectRevision.update(revision_id, {
        pricing_impact: {
          ...revision.pricing_impact,
          applied: false,
          applied_date: null,
          applied_details: null,
          reverted_date: new Date().toISOString(),
        },
      }),
    ]);

    // Fix 6b — sync tasks and effort after pricing revert
    base44.functions.invoke('syncProjectTasksFromProducts', { project_id }).catch(() => {});
    base44.functions.invoke('syncOnsiteEffortTasks', { project_id }).catch(() => {});
    base44.functions.invoke('cleanupOrphanedProjectTasks', { project_id }).catch(() => {});

    return Response.json({
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
  } catch (error) {
    console.error('revertRevisionPricingImpact error:', error);
    return Response.json(
      { error: error.message || 'Failed to revert pricing impact' },
      { status: 500 }
    );
  }
});
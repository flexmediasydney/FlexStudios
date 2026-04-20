import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('revertRevisionPricingImpact', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);
    if (user && !['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient permissions', 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const { revision_id, project_id } = body;
    if (!revision_id || !project_id) return errorResponse('Missing revision_id or project_id', 400, req);

    const [revision, project] = await Promise.all([
      entities.ProjectRevision.get(revision_id),
      entities.Project.get(project_id),
    ]);

    if (!revision || !project) return errorResponse('Revision or project not found', 404);

    const pi = revision.pricing_impact;
    if (!pi || !pi.applied || !pi.pre_impact_products || !pi.pre_impact_price) {
      return errorResponse('No applied pricing impact to revert', 400);
    }

    // Restore original state — sequential to prevent partial-success corruption
    const revertedProducts = pi.pre_impact_products || [];
    const revertedPackages = pi.pre_impact_packages || [];
    const revertedPrice = pi.pre_impact_price;

    const preRevertPrice = project.calculated_price;
    const preRevertVersionId = project.price_matrix_version_id || null;

    // Step 1: Update project first (the critical data)
    await entities.Project.update(project_id, {
      products: revertedProducts,
      packages: revertedPackages,
      calculated_price: revertedPrice,
    });

    // Audit log (phase 3d). Non-blocking.
    try {
      await admin.rpc('record_pricing_audit', {
        p_project_id: project_id,
        p_old_price: preRevertPrice,
        p_new_price: revertedPrice,
        p_old_version_id: preRevertVersionId,
        p_new_version_id: preRevertVersionId, // revert doesn't change matrix, only products/discount
        p_reason: 'revision_revert',
        p_triggered_by: 'revision',
        p_actor_id: null,
        p_actor_name: null,
        p_engine_version: 'v2.0.0-shared',
        p_notes: `revision_id=${revision_id} reverted`,
      });
    } catch (auditErr: any) {
      console.warn('pricing audit write failed (non-fatal):', auditErr?.message);
    }

    // Step 2: Mark revision as reverted (if this fails, project is correct but revision flag is stale — safer)
    await entities.ProjectRevision.update(revision_id, {
      pricing_impact: {
        ...revision.pricing_impact,
        applied: false,
        applied_date: null,
        applied_details: null,
        reverted_date: new Date().toISOString(),
      },
    });

    // ProjectActivity audit row — paired with the apply-side write in
    // applyRevisionPricingImpact so the history tab shows both halves of the
    // revision lifecycle with structured before/after state.
    entities.ProjectActivity.create({
      project_id,
      project_title: project.title || project.property_address || 'Project',
      action: 'revision_pricing_reverted',
      description: `Revision #${revision.revision_number || '?'} pricing impact reverted. Price: $${Math.round(preRevertPrice || 0).toLocaleString()} -> $${Math.round(revertedPrice).toLocaleString()}. Items restored.`,
      actor_type: 'system',
      actor_source: 'revertRevisionPricingImpact',
      user_name: 'System',
      user_email: 'system@flexstudios.app',
      previous_state: { products: project.products || [], packages: project.packages || [], calculated_price: preRevertPrice },
      new_state: { products: revertedProducts, packages: revertedPackages, calculated_price: revertedPrice },
      changed_fields: [{ field: 'products_and_packages', reverted_from_revision: revision_id }],
    }).catch(() => {});

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

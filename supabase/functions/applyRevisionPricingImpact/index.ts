import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, invokeFunction } from '../_shared/supabase.ts';

/** Remove standalone products that overlap with package contents. */
function deduplicateProjectItems(products: any[], packages: any[]) {
  const packageProductIds = new Set<string>();
  for (const pkg of packages) {
    (pkg.products || []).forEach((p: any) => { if (p.product_id) packageProductIds.add(p.product_id); });
  }
  return products.filter((p: any) => !packageProductIds.has(p.product_id));
}

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
    if (!pi || !pi.has_impact || pi.applied) {
      return errorResponse('No pricing impact to apply', 400);
    }

    // Store original state for audit trail
    const originalProducts = JSON.parse(JSON.stringify(project.products || []));
    const originalPackages = JSON.parse(JSON.stringify(project.packages || []));
    const originalPrice = project.calculated_price;

    let currentProducts = [...originalProducts];
    let currentPackages = [...originalPackages];

    // 1. Apply quantity changes
    (pi.quantity_changes || []).forEach((change: any) => {
      const idx = currentProducts.findIndex((p: any) => p.product_id === change.product_id);
      if (idx !== -1) {
        const isNestedInPackage = currentPackages.some((pkg: any) =>
          pkg.products?.some((nested: any) => nested.product_id === change.product_id)
        );
        if (!isNestedInPackage) {
          currentProducts[idx] = { ...currentProducts[idx], quantity: change.new_quantity };
        } else {
          currentPackages = currentPackages.map((pkg: any) => ({
            ...pkg,
            products: (pkg.products || []).map((nested: any) =>
              nested.product_id === change.product_id
                ? { ...nested, quantity: change.new_quantity }
                : nested
            ),
          }));
        }
      }
    });

    // 2. Remove products (only standalone)
    const removedIds = new Set((pi.products_removed || []).map((r: any) => r.product_id));
    currentProducts = currentProducts.filter((p: any) => !removedIds.has(p.product_id));

    // 3. Add products (ONLY as standalone)
    (pi.products_added || []).forEach((added: any) => {
      if (!added.product_id) return;
      const standaloneIdx = currentProducts.findIndex((p: any) => p.product_id === added.product_id);
      if (standaloneIdx !== -1) {
        currentProducts[standaloneIdx] = {
          ...currentProducts[standaloneIdx],
          quantity: (currentProducts[standaloneIdx].quantity || 1) + (added.quantity || 1),
        };
      } else {
        currentProducts.push({
          product_id: added.product_id,
          product_name: added.product_name,
          quantity: added.quantity || 1,
        });
      }
    });

    // Normalize: remove standalone products that overlap with package contents
    currentProducts = deduplicateProjectItems(currentProducts, currentPackages);

    // 4. Recalculate price via backend function
    let newCalculatedPrice = project.calculated_price;
    let priceMatrixSnapshot: any = null;
    try {
      const res = await invokeFunction('calculateProjectPricing', {
        agent_id: project.agent_id || null,
        agency_id: project.agency_id || null,
        products: currentProducts,
        packages: currentPackages,
        pricing_tier: project.pricing_tier || 'standard',
        project_type_id: project.project_type_id || null,
      });
      if (res?.calculated_price != null) {
        newCalculatedPrice = res.calculated_price;
      }
      priceMatrixSnapshot = res?.price_matrix_snapshot || null;
    } catch (e: any) {
      console.warn('Price recalculation failed, saving products only:', e.message);
    }

    // 5. Calculate the actual changes for audit trail
    const priceDelta = newCalculatedPrice - originalPrice;
    const appliedDetails = {
      products_added_actual: (pi.products_added || []).filter((p: any) => p.product_id).map((p: any) => ({
        product_id: p.product_id, product_name: p.product_name, quantity: p.quantity || 1,
      })),
      products_removed_actual: (pi.products_removed || []).filter((p: any) => p.product_id).map((p: any) => ({
        product_id: p.product_id, product_name: p.product_name,
      })),
      quantity_changes_actual: (pi.quantity_changes || []).filter((p: any) => p.product_id).map((p: any) => ({
        product_id: p.product_id, product_name: p.product_name,
        old_quantity: p.old_quantity, new_quantity: p.new_quantity,
      })),
      original_price: originalPrice,
      new_price: newCalculatedPrice,
      price_delta: priceDelta,
    };

    // Audit: log revision pricing impact to ProjectActivity
    const projectName = project.title || project.property_address || 'Project';
    const addedCount = (pi.products_added || []).filter((p: any) => p.product_id).length;
    const removedCount = (pi.products_removed || []).filter((p: any) => p.product_id).length;
    const changedCount = (pi.quantity_changes || []).filter((p: any) => p.product_id).length;
    const changeSummary = [
      addedCount > 0 ? `+${addedCount} product${addedCount > 1 ? 's' : ''}` : '',
      removedCount > 0 ? `-${removedCount} product${removedCount > 1 ? 's' : ''}` : '',
      changedCount > 0 ? `${changedCount} qty change${changedCount > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(', ');

    entities.ProjectActivity.create({
      project_id,
      project_title: projectName,
      action: 'revision_pricing_applied',
      description: `Revision #${revision.revision_number || '?'} pricing impact applied: ${changeSummary}. Price: $${Math.round(originalPrice).toLocaleString()} -> $${Math.round(newCalculatedPrice).toLocaleString()} (delta $${Math.round(Math.abs(priceDelta))}).`,
      actor_type: 'system',
      actor_source: 'applyRevisionPricingImpact',
      user_name: 'System',
      user_email: 'system@flexmedia',
    }).catch(() => {});

    // Notify if price changed significantly (>$50 or >5%)
    const absDelta = Math.abs(priceDelta);
    const pctDelta = originalPrice > 0 ? (absDelta / originalPrice) * 100 : 0;
    if (originalPrice > 0 && (absDelta >= 50 || pctDelta >= 5)) {
      const notifyUserIds = [project.project_owner_id].filter(Boolean);
      entities.User.list('-created_date', 200).then(async (users: any[]) => {
        users.filter((u: any) => u.role === 'master_admin' || u.role === 'admin')
          .forEach((u: any) => notifyUserIds.push(u.id));
        for (const userId of [...new Set(notifyUserIds)]) {
          entities.Notification.create({
            user_id: userId,
            type: 'project_pricing_changed',
            category: 'project',
            severity: 'info',
            title: `Revision pricing applied — ${projectName}`,
            message: `Revision #${revision.revision_number || '?'} impact applied. Price: $${Math.round(originalPrice).toLocaleString()} -> $${Math.round(newCalculatedPrice).toLocaleString()} (${changeSummary}).`,
            project_id,
            project_name: projectName,
            cta_label: 'View Project',
            is_read: false,
            is_dismissed: false,
            source: 'pricing',
            idempotency_key: `rev_pricing:${revision_id}:${newCalculatedPrice}:${userId}`,
            created_date: new Date().toISOString(),
          }).catch(() => {});
        }
      }).catch(() => {});
    }

    // 6. Batch both updates in parallel
    await Promise.all([
      entities.Project.update(project_id, {
        products: currentProducts,
        packages: currentPackages,
        calculated_price: newCalculatedPrice,
        price: newCalculatedPrice,
        price_matrix_snapshot: priceMatrixSnapshot,
      }),
      entities.ProjectRevision.update(revision_id, {
        pricing_impact: {
          ...revision.pricing_impact,
          applied: true,
          applied_date: new Date().toISOString(),
          applied_details: appliedDetails,
          pre_impact_products: originalProducts,
          pre_impact_packages: originalPackages,
          pre_impact_price: originalPrice,
        },
      }),
    ]);

    // Sync onsite effort estimates
    invokeFunction('syncOnsiteEffortTasks', { project_id }).catch(() => {});

    // Sync task templates in case products were added/removed
    invokeFunction('syncProjectTasksFromProducts', { project_id }).catch(() => {});

    return jsonResponse({
      success: true,
      calculated_price: newCalculatedPrice,
      price_delta: priceDelta,
      products_count: currentProducts.length,
      packages_count: currentPackages.length,
      applied_details: appliedDetails,
    });
  } catch (error: any) {
    console.error('applyRevisionPricingImpact error:', error);
    return errorResponse(error.message || 'Failed to apply pricing impact');
  }
});

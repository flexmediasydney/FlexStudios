import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/** Remove standalone products that overlap with package contents. */
function deduplicateProjectItems(products: any[], packages: any[]) {
  const packageProductIds = new Set<string>();
  for (const pkg of packages) {
    (pkg.products || []).forEach((p: any) => { if (p.product_id) packageProductIds.add(p.product_id); });
  }
  return products.filter((p: any) => !packageProductIds.has(p.product_id));
}

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
    if (!pi || !pi.has_impact || pi.applied) {
      return Response.json({ error: 'No pricing impact to apply' }, { status: 400 });
    }

    // Store original state for audit trail
    const originalProducts = JSON.parse(JSON.stringify(project.products || []));
    const originalPackages = JSON.parse(JSON.stringify(project.packages || []));
    const originalPrice = project.calculated_price;

    let currentProducts = [...originalProducts];
    let currentPackages = [...originalPackages];

    // IMPORTANT: Only modify products/packages that are NOT part of packages
    // Package-nested products must be modified WITHIN the package object, not as standalone

    // 1. Apply quantity changes (only to standalone products, not nested)
    (pi.quantity_changes || []).forEach(change => {
      const idx = currentProducts.findIndex(p => p.product_id === change.product_id);
      if (idx !== -1) {
        // Verify this product is NOT nested in a package
        const isNestedInPackage = currentPackages.some(pkg =>
          pkg.products?.some(nested => nested.product_id === change.product_id)
        );
        if (!isNestedInPackage) {
          currentProducts[idx] = { ...currentProducts[idx], quantity: change.new_quantity };
        } else {
          // Modify within package instead
          currentPackages = currentPackages.map(pkg => ({
            ...pkg,
            products: (pkg.products || []).map(nested =>
              nested.product_id === change.product_id
                ? { ...nested, quantity: change.new_quantity }
                : nested
            ),
          }));
        }
      }
    });

    // 2. Remove products (only standalone, not nested in packages)
    const removedIds = new Set((pi.products_removed || []).map(r => r.product_id));
    currentProducts = currentProducts.filter(p => !removedIds.has(p.product_id));

    // 3. Add products (ONLY as standalone - never nest into existing packages)
    (pi.products_added || []).forEach(added => {
      if (!added.product_id) return;

      // Check if product already exists standalone
      const standaloneIdx = currentProducts.findIndex(p => p.product_id === added.product_id);
      if (standaloneIdx !== -1) {
        // Increase quantity of existing standalone
        currentProducts[standaloneIdx] = {
          ...currentProducts[standaloneIdx],
          quantity: (currentProducts[standaloneIdx].quantity || 1) + (added.quantity || 1),
        };
      } else {
        // Add as new standalone product only
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
    var priceMatrixSnapshot: any = null;
    try {
     const res = await base44.functions.invoke('calculateProjectPricing', {
       agent_id: project.agent_id || null,
       agency_id: project.agency_id || null,
       products: currentProducts,
       packages: currentPackages,
       pricing_tier: project.pricing_tier || 'standard',
       project_type_id: project.project_type_id || null,
     });
     if (res.data?.calculated_price != null) {
       newCalculatedPrice = res.data.calculated_price;
       // Note: calculateProjectPricing returns line_items, NOT products/packages.
       // currentProducts/currentPackages are already correct from local modifications above.
     }
     // Store the matrix snapshot for audit trail
     priceMatrixSnapshot = res.data?.price_matrix_snapshot || null;
    } catch (e) {
     console.warn('Price recalculation failed, saving products only:', e.message);
     // Continue with best-effort save
    }

    // 5. Calculate the actual changes for audit trail
    const priceDelta = newCalculatedPrice - originalPrice;
    const appliedDetails = {
      products_added_actual: (pi.products_added || []).filter(p => p.product_id).map(p => ({
        product_id: p.product_id,
        product_name: p.product_name,
        quantity: p.quantity || 1,
      })),
      products_removed_actual: (pi.products_removed || []).filter(p => p.product_id).map(p => ({
        product_id: p.product_id,
        product_name: p.product_name,
      })),
      quantity_changes_actual: (pi.quantity_changes || []).filter(p => p.product_id).map(p => ({
        product_id: p.product_id,
        product_name: p.product_name,
        old_quantity: p.old_quantity,
        new_quantity: p.new_quantity,
      })),
      original_price: originalPrice,
      new_price: newCalculatedPrice,
      price_delta: priceDelta,
    };

    // Audit: log revision pricing impact to ProjectActivity
    const projectName = project.title || project.property_address || 'Project';
    const addedCount = (pi.products_added || []).filter(p => p.product_id).length;
    const removedCount = (pi.products_removed || []).filter(p => p.product_id).length;
    const changedCount = (pi.quantity_changes || []).filter(p => p.product_id).length;
    const changeSummary = [
     addedCount > 0 ? `+${addedCount} product${addedCount > 1 ? 's' : ''}` : '',
     removedCount > 0 ? `−${removedCount} product${removedCount > 1 ? 's' : ''}` : '',
     changedCount > 0 ? `${changedCount} qty change${changedCount > 1 ? 's' : ''}` : '',
    ].filter(Boolean).join(', ');

    base44.entities.ProjectActivity.create({
     project_id,
     project_title: projectName,
     action: 'revision_pricing_applied',
     description: `Revision #${revision.revision_number || '?'} pricing impact applied: ${changeSummary}. Price: $${Math.round(originalPrice).toLocaleString()} → $${Math.round(newCalculatedPrice).toLocaleString()} (Δ$${Math.round(Math.abs(priceDelta))}).`,
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
     base44.entities.User.list('-created_date', 200).then(async users => {
       users.filter(u => u.role === 'master_admin' || u.role === 'admin')
         .forEach(u => notifyUserIds.push(u.id));
       for (const userId of [...new Set(notifyUserIds)]) {
         base44.entities.Notification.create({
           user_id: userId,
           type: 'project_pricing_changed',
           category: 'project',
           severity: 'info',
           title: `Revision pricing applied — ${projectName}`,
           message: `Revision #${revision.revision_number || '?'} impact applied. Price: $${Math.round(originalPrice).toLocaleString()} → $${Math.round(newCalculatedPrice).toLocaleString()} (${changeSummary}).`,
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
     base44.entities.Project.update(project_id, {
       products: currentProducts,
       packages: currentPackages,
       calculated_price: newCalculatedPrice,
       price: newCalculatedPrice,
       price_matrix_snapshot: priceMatrixSnapshot,
     }),
      base44.entities.ProjectRevision.update(revision_id, {
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

    // Sync onsite effort estimates — products may have changed
    base44.functions.invoke('syncOnsiteEffortTasks', {
      project_id,
    }).catch(() => {});

    // Sync task templates in case products were added/removed
    base44.functions.invoke('syncProjectTasksFromProducts', {
      project_id,
    }).catch(() => {});

    return Response.json({
      success: true,
      calculated_price: newCalculatedPrice,
      price_delta: priceDelta,
      products_count: currentProducts.length,
      packages_count: currentPackages.length,
      applied_details: appliedDetails,
    });
  } catch (error) {
    console.error('applyRevisionPricingImpact error:', error);
    return Response.json(
      { error: error.message || 'Failed to apply pricing impact' },
      { status: 500 }
    );
  }
});
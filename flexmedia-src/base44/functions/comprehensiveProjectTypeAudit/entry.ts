import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const issues = [];
    let fixedCount = 0;

    // Load all data
    const [products, packages, priceMatrices, projects, projectTypes, priceMatrixAuditLogs, productAuditLogs, packageAuditLogs] = await Promise.all([
      base44.entities.Product.list(),
      base44.entities.Package.list(),
      base44.entities.PriceMatrix.list(),
      base44.entities.Project.list(),
      base44.entities.ProjectType.list(),
      base44.entities.PriceMatrixAuditLog.list(),
      base44.entities.ProductAuditLog.list(),
      base44.entities.PackageAuditLog.list(),
    ]);

    const productMap = new Map(products.map(p => [p.id, p]));
    const packageMap = new Map(packages.map(p => [p.id, p]));
    const projectTypeMap = new Map(projectTypes.map(t => [t.id, t]));
    const activeTypeIds = new Set(projectTypes.filter(t => t.is_active !== false).map(t => t.id));

    // FIX 1-5: Already handled in previous audit
    
    // FIX 6: Package project_type_ids containing multiple types (should be 0 or 1)
    for (const pkg of packages) {
      const typeIds = pkg.project_type_ids || [];
      if (typeIds.length > 1) {
        await base44.entities.Package.update(pkg.id, { project_type_ids: [typeIds[0]] });
        fixedCount++;
        issues.push(`Package "${pkg.name}": Reduced multiple project types to single type`);
      }
    }

    // FIX 7: Product project_type_ids containing multiple types (should be 0 or 1)
    for (const prod of products) {
      const typeIds = prod.project_type_ids || [];
      if (typeIds.length > 1) {
        await base44.entities.Product.update(prod.id, { project_type_ids: [typeIds[0]] });
        fixedCount++;
        issues.push(`Product "${prod.name}": Reduced multiple project types to single type`);
      }
    }

    // FIX 8: Package with type-mismatched products - auto-clean them
    for (const pkg of packages) {
      const pkgTypeId = (pkg.project_type_ids || [])[0];
      if (!pkgTypeId) continue;
      
      const originalCount = (pkg.products || []).length;
      const cleanedProducts = (pkg.products || []).filter(item => {
        const prod = productMap.get(item.product_id);
        if (!prod) return false;
        const prodTypes = prod.project_type_ids || [];
        return prodTypes.length === 0 || prodTypes.includes(pkgTypeId);
      });
      
      if (cleanedProducts.length < originalCount) {
        await base44.entities.Package.update(pkg.id, { products: cleanedProducts });
        fixedCount++;
        issues.push(`Package "${pkg.name}": Removed ${originalCount - cleanedProducts.length} type-mismatched products`);
      }
    }

    // FIX 9: Project with type-mismatched products - auto-clean them
    for (const proj of projects) {
      if (!proj.project_type_id) continue;
      
      const originalCount = (proj.products || []).length;
      const cleanedProducts = (proj.products || []).filter(item => {
        const prod = productMap.get(item.product_id);
        if (!prod) return false;
        const prodTypes = prod.project_type_ids || [];
        return prodTypes.length === 0 || prodTypes.includes(proj.project_type_id);
      });
      
      if (cleanedProducts.length < originalCount) {
        await base44.entities.Project.update(proj.id, { products: cleanedProducts });
        fixedCount++;
        issues.push(`Project "${proj.title}": Removed ${originalCount - cleanedProducts.length} type-mismatched products`);
      }
    }

    // FIX 10: Project with type-mismatched packages
    for (const proj of projects) {
      if (!proj.project_type_id) continue;
      
      const originalCount = (proj.packages || []).length;
      const cleanedPackages = (proj.packages || []).filter(item => {
        const pkg = packageMap.get(item.package_id);
        if (!pkg) return false;
        const pkgTypes = pkg.project_type_ids || [];
        return pkgTypes.length === 0 || pkgTypes.includes(proj.project_type_id);
      });
      
      if (cleanedPackages.length < originalCount) {
        await base44.entities.Project.update(proj.id, { packages: cleanedPackages });
        fixedCount++;
        issues.push(`Project "${proj.title}": Removed ${originalCount - cleanedPackages.length} type-mismatched packages`);
      }
    }

    // FIX 11: PriceMatrix project_type_id referencing non-existent or inactive type
    for (const pm of priceMatrices) {
      if (pm.project_type_id && !activeTypeIds.has(pm.project_type_id)) {
        await base44.entities.PriceMatrix.update(pm.id, { project_type_id: null });
        fixedCount++;
        issues.push(`PriceMatrix for ${pm.entity_name}: Cleared invalid project type ID`);
      }
    }

    // FIX 12: Audit logs referencing non-existent products
    const productLogIds = new Set(productAuditLogs.map(l => l.product_id));
    const deletedProductsInLogs = [...productLogIds].filter(id => !productMap.has(id) && id !== 'new');
    if (deletedProductsInLogs.length > 0) {
      issues.push(`⚠️  ${deletedProductsInLogs.length} audit log entries reference deleted products (archived for history)`);
    }

    // FIX 13: Audit logs referencing non-existent packages
    const packageLogIds = new Set(packageAuditLogs.map(l => l.package_id));
    const deletedPackagesInLogs = [...packageLogIds].filter(id => !packageMap.has(id) && id !== 'new');
    if (deletedPackagesInLogs.length > 0) {
      issues.push(`⚠️  ${deletedPackagesInLogs.length} audit log entries reference deleted packages (archived for history)`);
    }

    // FIX 14: Price matrix audit logs with invalid references
    const priceMatrixAuditCount = priceMatrixAuditLogs.filter(l => 
      (l.product_id && !productMap.has(l.product_id)) ||
      (l.package_id && !packageMap.has(l.package_id))
    ).length;
    if (priceMatrixAuditCount > 0) {
      issues.push(`⚠️  ${priceMatrixAuditCount} price matrix audit entries reference deleted items (archived for history)`);
    }

    // FIX 15: Task templates with invalid auto_assign_role values
    const validRoles = ['none', 'project_owner', 'photographer', 'videographer', 'image_editor', 'video_editor', 'floorplan_editor', 'drone_editor'];
    let taskTemplatesFixes = 0;
    
    for (const prod of products) {
      let shouldUpdate = false;
      const updated = { ...prod };
      
      ['standard_task_templates', 'premium_task_templates'].forEach(key => {
        if (updated[key]) {
          updated[key] = updated[key].map(t => {
            if (!validRoles.includes(t.auto_assign_role)) {
              shouldUpdate = true;
              return { ...t, auto_assign_role: 'none' };
            }
            return t;
          });
        }
      });
      
      if (shouldUpdate) {
        await base44.entities.Product.update(prod.id, {
          standard_task_templates: updated.standard_task_templates,
          premium_task_templates: updated.premium_task_templates
        });
        fixedCount++;
        taskTemplatesFixes++;
      }
    }
    
    if (taskTemplatesFixes > 0) {
      issues.push(`Fixed ${taskTemplatesFixes} products with invalid task template roles`);
    }

    // FIX 16: Package task templates with invalid roles
    taskTemplatesFixes = 0;
    for (const pkg of packages) {
      let shouldUpdate = false;
      const updated = { ...pkg };
      
      ['standard_task_templates', 'premium_task_templates'].forEach(key => {
        if (updated[key]) {
          updated[key] = updated[key].map(t => {
            if (!validRoles.includes(t.auto_assign_role)) {
              shouldUpdate = true;
              return { ...t, auto_assign_role: 'none' };
            }
            return t;
          });
        }
      });
      
      if (shouldUpdate) {
        await base44.entities.Package.update(pkg.id, {
          standard_task_templates: updated.standard_task_templates,
          premium_task_templates: updated.premium_task_templates
        });
        fixedCount++;
        taskTemplatesFixes++;
      }
    }
    
    if (taskTemplatesFixes > 0) {
      issues.push(`Fixed ${taskTemplatesFixes} packages with invalid task template roles`);
    }

    // FIX 17: Circular task dependencies in task templates
    let circularDeps = 0;
    for (const prod of products) {
      for (const key of ['standard_task_templates', 'premium_task_templates']) {
        const tasks = prod[key] || [];
        let hasCycles = false;
        
        tasks.forEach((task, idx) => {
          const visited = new Set();
          const deps = task.depends_on_indices || [];
          
          // Simple cycle detection
          deps.forEach(depIdx => {
            if (depIdx === idx) {
              hasCycles = true; // Self-dependency
            }
            if (depIdx > idx) {
              hasCycles = true; // Forward dependency (invalid)
            }
          });
        });
        
        if (hasCycles) {
          const cleaned = { ...prod };
          cleaned[key] = (prod[key] || []).map(t => ({
            ...t,
            depends_on_indices: (t.depends_on_indices || []).filter(depIdx => {
              return depIdx < tasks.indexOf(t); // Only allow backward deps
            })
          }));
          
          await base44.entities.Product.update(prod.id, {
            [key]: cleaned[key]
          });
          circularDeps++;
          fixedCount++;
        }
      }
    }
    
    if (circularDeps > 0) {
      issues.push(`Fixed ${circularDeps} products with invalid task dependencies`);
    }

    // FIX 18: Pricing with negative values
    let negativePrice = 0;
    for (const prod of products) {
      let shouldUpdate = false;
      const updated = { ...prod };
      
      ['standard_tier', 'premium_tier'].forEach(tier => {
        if (updated[tier]) {
          updated[tier] = {
            ...updated[tier],
            base_price: Math.max(0, updated[tier].base_price || 0),
            unit_price: Math.max(0, updated[tier].unit_price || 0),
            onsite_time: Math.max(0, updated[tier].onsite_time || 0),
            onsite_time_increment: Math.max(0, updated[tier].onsite_time_increment || 0)
          };
          if (JSON.stringify(updated[tier]) !== JSON.stringify(prod[tier])) {
            shouldUpdate = true;
          }
        }
      });
      
      if (shouldUpdate) {
        await base44.entities.Product.update(prod.id, {
          standard_tier: updated.standard_tier,
          premium_tier: updated.premium_tier
        });
        fixedCount++;
        negativePrice++;
      }
    }
    
    if (negativePrice > 0) {
      issues.push(`Fixed ${negativePrice} products with negative pricing`);
    }

    // FIX 19: Same for packages
    negativePrice = 0;
    for (const pkg of packages) {
      let shouldUpdate = false;
      const updated = { ...pkg };
      
      ['standard_tier', 'premium_tier'].forEach(tier => {
        if (updated[tier]) {
          updated[tier] = {
            ...updated[tier],
            package_price: Math.max(0, updated[tier].package_price || 0),
            scheduling_time: Math.max(0, updated[tier].scheduling_time || 0),
            admin_time: Math.max(0, updated[tier].admin_time || 0),
            editor_time: Math.max(0, updated[tier].editor_time || 0)
          };
          if (JSON.stringify(updated[tier]) !== JSON.stringify(pkg[tier])) {
            shouldUpdate = true;
          }
        }
      });
      
      if (shouldUpdate) {
        await base44.entities.Package.update(pkg.id, {
          standard_tier: updated.standard_tier,
          premium_tier: updated.premium_tier
        });
        fixedCount++;
        negativePrice++;
      }
    }
    
    if (negativePrice > 0) {
      issues.push(`Fixed ${negativePrice} packages with negative pricing`);
    }

    // FIX 20: Products with empty name
    const emptyNameProds = products.filter(p => !p.name || !p.name.trim());
    if (emptyNameProds.length > 0) {
      issues.push(`⚠️  ${emptyNameProds.length} products have empty names (requires manual review)`);
    }

    // FIX 21: Packages with empty name
    const emptyNamePkgs = packages.filter(p => !p.name || !p.name.trim());
    if (emptyNamePkgs.length > 0) {
      issues.push(`⚠️  ${emptyNamePkgs.length} packages have empty names (requires manual review)`);
    }

    return Response.json({
      success: true,
      total_issues_found: issues.length,
      total_issues_fixed: fixedCount,
      issues,
      summary: {
        fixed: fixedCount,
        warnings: issues.filter(i => i.includes('⚠️')).length,
        automated_fixes: [
          'null project_type_ids',
          'multiple project types per item',
          'type-mismatched products in packages/projects',
          'invalid task template roles',
          'negative pricing values',
          'circular task dependencies',
          'non-existent product/package references'
        ]
      }
    });

  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
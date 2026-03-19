import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    const issues: string[] = [];
    let fixedCount = 0;

    // Issue 1: Products with null project_type_ids should be empty array
    const products = await entities.Product.list();
    const productsWithNullTypes = products.filter((p: any) => p.project_type_ids === null);
    for (const prod of productsWithNullTypes) {
      await entities.Product.update(prod.id, { project_type_ids: [] });
      fixedCount++;
    }
    if (productsWithNullTypes.length > 0) {
      issues.push(`Fixed ${productsWithNullTypes.length} products with null project_type_ids`);
    }

    // Issue 2: Packages with null project_type_ids
    const packages = await entities.Package.list();
    const packagesWithNullTypes = packages.filter((p: any) => p.project_type_ids === null);
    for (const pkg of packagesWithNullTypes) {
      await entities.Package.update(pkg.id, { project_type_ids: [] });
      fixedCount++;
    }
    if (packagesWithNullTypes.length > 0) {
      issues.push(`Fixed ${packagesWithNullTypes.length} packages with null project_type_ids`);
    }

    // Issue 3: Products in packages that don't exist
    const productMap = new Map(products.map((p: any) => [p.id, p]));
    for (const pkg of packages) {
      const validProducts = (pkg.products || []).filter((p: any) => productMap.has(p.product_id));
      if (validProducts.length < (pkg.products || []).length) {
        await entities.Package.update(pkg.id, { products: validProducts });
        fixedCount++;
        issues.push(`Removed ${(pkg.products || []).length - validProducts.length} non-existent products from package "${pkg.name}"`);
      }
    }

    // Issue 4: Projects with deleted products
    const projects = await entities.Project.list();
    for (const proj of projects) {
      const validProjectProducts = (proj.products || []).filter((p: any) => productMap.has(p.product_id));
      if (validProjectProducts.length < (proj.products || []).length) {
        await entities.Project.update(proj.id, { products: validProjectProducts });
        fixedCount++;
        issues.push(`Cleaned ${(proj.products || []).length - validProjectProducts.length} deleted products from project "${proj.title}"`);
      }
    }

    // Issue 5: PriceMatrix references non-existent products
    const priceMatrices = await entities.PriceMatrix.list();
    for (const pm of priceMatrices) {
      const validProductPricing = (pm.product_pricing || []).filter((pp: any) => productMap.has(pp.product_id));
      if (validProductPricing.length < (pm.product_pricing || []).length) {
        await entities.PriceMatrix.update(pm.id, { product_pricing: validProductPricing });
        fixedCount++;
        issues.push(`Cleaned ${(pm.product_pricing || []).length - validProductPricing.length} deleted products from price matrix`);
      }
    }

    // Issue 6: PriceMatrix references non-existent packages
    const packageMap = new Map(packages.map((p: any) => [p.id, p]));
    for (const pm of priceMatrices) {
      const validPackagePricing = (pm.package_pricing || []).filter((pp: any) => packageMap.has(pp.package_id));
      if (validPackagePricing.length < (pm.package_pricing || []).length) {
        await entities.PriceMatrix.update(pm.id, { package_pricing: validPackagePricing });
        fixedCount++;
        issues.push(`Cleaned ${(pm.package_pricing || []).length - validPackagePricing.length} deleted packages from price matrix`);
      }
    }

    // Issue 7: Inactive ProjectTypes still referenced
    const projectTypes = await entities.ProjectType.list();
    const inactiveTypeIds = new Set(projectTypes.filter((t: any) => t.is_active === false).map((t: any) => t.id));

    for (const prod of products) {
      const validTypeIds = (prod.project_type_ids || []).filter((id: string) => !inactiveTypeIds.has(id));
      if (validTypeIds.length < (prod.project_type_ids || []).length) {
        await entities.Product.update(prod.id, { project_type_ids: validTypeIds });
        fixedCount++;
        issues.push(`Removed ${(prod.project_type_ids || []).length - validTypeIds.length} inactive project types from product "${prod.name}"`);
      }
    }

    for (const pkg of packages) {
      const validTypeIds = (pkg.project_type_ids || []).filter((id: string) => !inactiveTypeIds.has(id));
      if (validTypeIds.length < (pkg.project_type_ids || []).length) {
        await entities.Package.update(pkg.id, { project_type_ids: validTypeIds });
        fixedCount++;
        issues.push(`Removed ${(pkg.project_type_ids || []).length - validTypeIds.length} inactive project types from package "${pkg.name}"`);
      }
    }

    // Issue 8: Projects with invalid project_type_id
    const projectTypeIds = new Set(projectTypes.filter((t: any) => t.is_active !== false).map((t: any) => t.id));
    const invalidProjects = projects.filter((p: any) => p.project_type_id && !projectTypeIds.has(p.project_type_id));
    if (invalidProjects.length > 0) {
      issues.push(`${invalidProjects.length} projects reference non-existent project types (manual review needed)`);
    }

    // Issue 9: Product in package that doesn't match package type
    let typeViolations = 0;
    for (const pkg of packages) {
      const pkgTypeId = (pkg.project_type_ids || [])[0];
      if (!pkgTypeId) continue;

      const violating = (pkg.products || []).filter((item: any) => {
        const prod = products.find((p: any) => p.id === item.product_id);
        const prodTypes = prod?.project_type_ids || [];
        return prodTypes.length > 0 && !prodTypes.includes(pkgTypeId);
      });

      if (violating.length > 0) {
        typeViolations++;
        issues.push(`Package "${pkg.name}" contains ${violating.length} products that don't match its project type`);
      }
    }

    // Issue 10: Product in project that doesn't match project type
    let projTypeViolations = 0;
    for (const proj of projects) {
      if (!proj.project_type_id) continue;

      const violating = (proj.products || []).filter((item: any) => {
        const prod = products.find((p: any) => p.id === item.product_id);
        const prodTypes = prod?.project_type_ids || [];
        return prodTypes.length > 0 && !prodTypes.includes(proj.project_type_id);
      });

      if (violating.length > 0) {
        projTypeViolations++;
        issues.push(`Project "${proj.title}" contains ${violating.length} type-mismatched products`);
      }
    }

    return jsonResponse({
      success: true,
      issues_found: issues.length,
      issues_fixed: fixedCount,
      details: issues,
      warnings: {
        invalid_project_types: invalidProjects.length,
        package_type_violations: typeViolations,
        project_type_violations: projTypeViolations,
      },
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

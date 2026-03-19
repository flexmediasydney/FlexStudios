import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

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

    const [products, categories, projectTypes] = await Promise.all([
      entities.Product.list(),
      entities.ProductCategory.list(),
      entities.ProjectType.list()
    ]);

    const issues: any[] = [];

    // Check 1: Products with invalid category (no matching ProductCategory)
    const orphanedCategories = new Set<string>();
    products.forEach((product: any) => {
      if (product.category) {
        const cat = categories.find((c: any) => c.name === product.category);
        if (!cat) {
          orphanedCategories.add(product.category);
          issues.push({
            type: 'orphaned_category',
            severity: 'high',
            product_id: product.id,
            product_name: product.name,
            category: product.category,
            description: `Product "${product.name}" uses category "${product.category}" which doesn't exist in ProductCategories`,
            fixable: true
          });
        }
      }
    });

    // Check 2: Products with project_type_ids that don't exist
    products.forEach((product: any) => {
      if (product.project_type_ids && product.project_type_ids.length > 0) {
        product.project_type_ids.forEach((typeId: string) => {
          const type = projectTypes.find((t: any) => t.id === typeId);
          if (!type) {
            issues.push({
              type: 'invalid_project_type',
              severity: 'high',
              product_id: product.id,
              product_name: product.name,
              invalid_type_id: typeId,
              description: `Product "${product.name}" references non-existent project type: ${typeId}`,
              fixable: true
            });
          }
        });
      }
    });

    // Check 3: Categories with invalid project_type_id
    categories.forEach((cat: any) => {
      const type = projectTypes.find((t: any) => t.id === cat.project_type_id);
      if (!type) {
        issues.push({
          type: 'category_invalid_project_type',
          severity: 'medium',
          category_id: cat.id,
          category_name: cat.name,
          project_type_id: cat.project_type_id,
          description: `Category "${cat.name}" references non-existent project type: ${cat.project_type_id}`,
          fixable: true
        });
      }
    });

    // Check 4: Products with restricted types but no categories for those types
    products.forEach((product: any) => {
      if (product.project_type_ids && product.project_type_ids.length > 0) {
        product.project_type_ids.forEach((typeId: string) => {
          const typeCatsCount = categories.filter((c: any) => c.project_type_id === typeId && c.is_active !== false).length;
          if (typeCatsCount === 0) {
            issues.push({
              type: 'type_no_categories',
              severity: 'medium',
              product_id: product.id,
              product_name: product.name,
              project_type_id: typeId,
              description: `Product "${product.name}" is restricted to project type but that type has no active categories`,
              fixable: false
            });
          }
        });
      }
    });

    const summary = {
      total_issues: issues.length,
      by_severity: {
        critical: issues.filter((i: any) => i.severity === 'critical').length,
        high: issues.filter((i: any) => i.severity === 'high').length,
        medium: issues.filter((i: any) => i.severity === 'medium').length,
        low: issues.filter((i: any) => i.severity === 'low').length
      },
      by_type: {
        orphaned_categories: issues.filter((i: any) => i.type === 'orphaned_category').length,
        invalid_project_types: issues.filter((i: any) => i.type === 'invalid_project_type').length,
        category_invalid_types: issues.filter((i: any) => i.type === 'category_invalid_project_type').length,
        type_no_categories: issues.filter((i: any) => i.type === 'type_no_categories').length
      },
      orphaned_categories: Array.from(orphanedCategories)
    };

    return jsonResponse({
      status: 'success',
      issues,
      summary,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const [products, categories, projectTypes] = await Promise.all([
      base44.entities.Product.list(),
      base44.entities.ProductCategory.list(),
      base44.entities.ProjectType.list()
    ]);

    const issues = [];

    // Check 1: Products with invalid category (no matching ProjectCategory)
    const orphanedCategories = new Set();
    products.forEach(product => {
      if (product.category) {
        const cat = categories.find(c => c.name === product.category);
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
    products.forEach(product => {
      if (product.project_type_ids && product.project_type_ids.length > 0) {
        product.project_type_ids.forEach(typeId => {
          const type = projectTypes.find(t => t.id === typeId);
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
    categories.forEach(cat => {
      const type = projectTypes.find(t => t.id === cat.project_type_id);
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
    products.forEach(product => {
      if (product.project_type_ids && product.project_type_ids.length > 0) {
        product.project_type_ids.forEach(typeId => {
          const typeCatsCount = categories.filter(c => c.project_type_id === typeId && c.is_active !== false).length;
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
        critical: issues.filter(i => i.severity === 'critical').length,
        high: issues.filter(i => i.severity === 'high').length,
        medium: issues.filter(i => i.severity === 'medium').length,
        low: issues.filter(i => i.severity === 'low').length
      },
      by_type: {
        orphaned_categories: issues.filter(i => i.type === 'orphaned_category').length,
        invalid_project_types: issues.filter(i => i.type === 'invalid_project_type').length,
        category_invalid_types: issues.filter(i => i.type === 'category_invalid_project_type').length,
        type_no_categories: issues.filter(i => i.type === 'type_no_categories').length
      },
      orphaned_categories: Array.from(orphanedCategories)
    };

    return Response.json({
      status: 'success',
      issues,
      summary,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
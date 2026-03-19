import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const { issue_id, action } = await req.json();

    if (!issue_id || !action) {
      return Response.json({ 
        error: 'Missing required fields: issue_id, action' 
      }, { status: 400 });
    }

    const [products, categories, projectTypes] = await Promise.all([
      base44.entities.Product.list(),
      base44.entities.ProductCategory.list(),
      base44.entities.ProjectType.list()
    ]);

    let repaired = [];
    let failed = [];

    // Parse issue_id to extract type and details
    const [issueType, ...idParts] = issue_id.split(':');
    const details = idParts.join(':');

    switch (action) {
      case 'orphaned_category': {
        // Find products with orphaned categories and set to 'other'
        const [productId, categoryName] = details.split('|');
        const product = products.find(p => p.id === productId);
        
        if (product) {
          const fallbackCat = categories.find(c => c.name === 'other');
          if (fallbackCat || !fallbackCat) {
            // Use 'other' or leave as-is if no fallback
            await base44.entities.Product.update(productId, {
              ...product,
              category: 'other'
            });
            repaired.push({ product_id: productId, action: 'category_reset_to_other' });
          } else {
            failed.push({ product_id: productId, reason: 'no_fallback_category' });
          }
        }
        break;
      }

      case 'invalid_project_type': {
        // Remove invalid project type ID from product
        const [productId, invalidTypeId] = details.split('|');
        const product = products.find(p => p.id === productId);
        
        if (product) {
          const cleaned = (product.project_type_ids || []).filter(id => {
            const type = projectTypes.find(t => t.id === id);
            return !!type;
          });
          
          await base44.entities.Product.update(productId, {
            ...product,
            project_type_ids: cleaned
          });
          repaired.push({ 
            product_id: productId, 
            action: 'removed_invalid_type',
            removed_type_id: invalidTypeId 
          });
        }
        break;
      }

      case 'category_invalid_project_type': {
        // Remove or deactivate invalid category
        const [categoryId, invalidTypeId] = details.split('|');
        const category = categories.find(c => c.id === categoryId);
        
        if (category) {
          // Mark as inactive rather than delete (preserve audit trail)
          await base44.entities.ProductCategory.update(categoryId, {
            ...category,
            is_active: false
          });
          repaired.push({ 
            category_id: categoryId, 
            action: 'marked_inactive',
            reason: `project_type_${invalidTypeId}_not_found`
          });
        }
        break;
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }

    return Response.json({
      status: 'success',
      repaired,
      failed,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
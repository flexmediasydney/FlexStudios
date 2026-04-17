import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('repairProductCategoryIssues', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const { issue_id, action } = body;

    if (!issue_id || !action) {
      return errorResponse('Missing required fields: issue_id, action', 400, req);
    }

    const [products, categories, projectTypes] = await Promise.all([
      entities.Product.list(),
      entities.ProductCategory.list(),
      entities.ProjectType.list()
    ]);

    const repaired: any[] = [];
    const failed: any[] = [];

    // Parse issue_id to extract type and details
    const [_issueType, ...idParts] = issue_id.split(':');
    const details = idParts.join(':');

    switch (action) {
      case 'orphaned_category': {
        // Find products with orphaned categories and set to 'other'
        const [productId] = details.split('|');
        const product = products.find((p: any) => p.id === productId);

        if (product) {
          await entities.Product.update(productId, {
            ...product,
            category: 'other'
          });
          repaired.push({ product_id: productId, action: 'category_reset_to_other' });
        }
        break;
      }

      case 'invalid_project_type': {
        // Remove invalid project type ID from product
        const [productId] = details.split('|');
        const product = products.find((p: any) => p.id === productId);

        if (product) {
          const cleaned = (product.project_type_ids || []).filter((id: string) => {
            const type = projectTypes.find((t: any) => t.id === id);
            return !!type;
          });

          await entities.Product.update(productId, {
            ...product,
            project_type_ids: cleaned
          });
          repaired.push({
            product_id: productId,
            action: 'removed_invalid_type',
            removed_type_id: details.split('|')[1]
          });
        }
        break;
      }

      case 'category_invalid_project_type': {
        // Remove or deactivate invalid category
        const [categoryId] = details.split('|');
        const category = categories.find((c: any) => c.id === categoryId);

        if (category) {
          // Mark as inactive rather than delete (preserve audit trail)
          await entities.ProductCategory.update(categoryId, {
            ...category,
            is_active: false
          });
          repaired.push({
            category_id: categoryId,
            action: 'marked_inactive',
            reason: `project_type_${details.split('|')[1]}_not_found`
          });
        }
        break;
      }

      default:
        return errorResponse(`Unknown action: ${action}`, 400);
    }

    return jsonResponse({
      status: 'success',
      repaired,
      failed,
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

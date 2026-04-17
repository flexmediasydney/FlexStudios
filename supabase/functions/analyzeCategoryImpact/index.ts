import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('analyzeCategoryImpact', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    if (user.role !== 'master_admin') {
      return errorResponse('Forbidden: admin only', 403);
    }

    const body = await req.json().catch(() => ({} as any));
    const { categoryId, categoryName } = body;

    if (!categoryId && !categoryName) {
      return errorResponse('Category ID or name required', 400, req);
    }

    // Fetch the category to get definitive name
    let catName = categoryName;
    try {
      const categories = await entities.ProductCategory.filter({ id: categoryId });
      if (categories.length > 0) {
        catName = categories[0].name;
      }
    } catch {
      // If lookup fails, use provided name
      catName = categoryName;
    }

    // Analyze impact across all related entities
    const [products, agencies] = await Promise.all([
      entities.Product.list(),
      entities.Agency.list(),
    ]);

    // Filter for actual references - check both by name and by enum/ID
    const affectedProducts = products.filter((p: any) => {
      return p.category === catName || p.category === catName.toLowerCase().replace(/ /g, '_');
    });

    const affectedAgencies = agencies.filter((a: any) =>
      a.floorplan_product_category === catName ||
      a.images_product_category === catName ||
      a.drone_product_category === catName ||
      a.video_product_category === catName ||
      a.floorplan_product_category === catName.toLowerCase().replace(/ /g, '_') ||
      a.images_product_category === catName.toLowerCase().replace(/ /g, '_') ||
      a.drone_product_category === catName.toLowerCase().replace(/ /g, '_') ||
      a.video_product_category === catName.toLowerCase().replace(/ /g, '_')
    );

    const impact = {
      categoryId,
      categoryName: catName,
      affectedEntities: {
        products: {
          count: affectedProducts.length,
          items: affectedProducts.map((p: any) => ({ id: p.id, name: p.name }))
        },
        agencies: {
          count: affectedAgencies.length,
          items: affectedAgencies.map((a: any) => ({ id: a.id, name: a.name }))
        },
        projects: {
          count: 0, // Projects don't directly reference categories by name
          items: []
        }
      },
      riskLevel: affectedProducts.length > 5 ? 'high' : affectedProducts.length > 0 ? 'medium' : 'low',
      totalAffected: affectedProducts.length + affectedAgencies.length,
      canDelete: true // Always allow delete, but show warnings
    };

    return jsonResponse(impact);
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

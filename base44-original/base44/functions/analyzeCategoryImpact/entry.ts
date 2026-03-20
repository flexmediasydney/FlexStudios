import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: admin only' }, { status: 403 });
    }

    const { categoryId, categoryName } = await req.json();
    
    if (!categoryId && !categoryName) {
      return Response.json({ error: 'Category ID or name required' }, { status: 400 });
    }

    // Fetch the category to get definitive name
    let catName = categoryName;
    try {
      const categories = await base44.entities.ProductCategory.filter({ id: categoryId });
      if (categories.length > 0) {
        catName = categories[0].name;
      }
    } catch (err) {
      // If lookup fails, use provided name
      catName = categoryName;
    }

    // Analyze impact across all related entities
    const [products, agencies, projects] = await Promise.all([
      // Find products using this category
      base44.asServiceRole.entities.Product.list(),
      // Find agencies referencing this category
      base44.asServiceRole.entities.Agency.list(),
      // Find projects using this category
      base44.asServiceRole.entities.Project.list()
    ]);

    // Filter for actual references - check both by name and by enum/ID
    const affectedProducts = products.filter(p => {
      // Match by category name OR by category enum value
      return p.category === catName || p.category === catName.toLowerCase().replace(/ /g, '_');
    });
    
    const affectedAgencies = agencies.filter(a => 
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
          items: affectedProducts.map(p => ({ id: p.id, name: p.name }))
        },
        agencies: {
          count: affectedAgencies.length,
          items: affectedAgencies.map(a => ({ id: a.id, name: a.name }))
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

    return Response.json(impact);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
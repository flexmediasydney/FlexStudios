import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    // Get Commercial Real Estate project type
    const projectTypes = await base44.asServiceRole.entities.ProjectType.list();
    const commercialType = projectTypes.find(pt => pt.name.toLowerCase().includes('commercial'));
    
    if (!commercialType) {
      return Response.json({ error: 'Commercial Real Estate project type not found' }, { status: 400 });
    }

    // Create test category under Commercial Real Estate
    const testCat = await base44.asServiceRole.entities.ProductCategory.create({
      project_type_id: commercialType.id,
      project_type_name: commercialType.name,
      name: 'TEST_VIRTUAL_STAGING',
      color: '#ff6b6b',
      icon: '🛋️',
      is_active: true
    });

    // Also create a product using this category to test deletion with dependencies
    const testProduct = await base44.asServiceRole.entities.Product.create({
      name: 'TEST_PRODUCT_' + Date.now(),
      category: 'virtual_staging',
      project_type_ids: [commercialType.id],
      pricing_type: 'fixed',
      product_type: 'core',
      standard_tier: { base_price: 100 },
      premium_tier: { base_price: 200 }
    });

    return Response.json({
      categoryId: testCat.id,
      categoryName: testCat.name,
      projectTypeId: commercialType.id,
      projectTypeName: commercialType.name,
      testProductId: testProduct.id,
      testProductName: testProduct.name,
      message: 'Test category and product created. Try deleting the category in the UI.'
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
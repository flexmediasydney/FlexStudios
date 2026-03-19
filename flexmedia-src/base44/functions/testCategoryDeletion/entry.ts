import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const results = {
      steps: [],
      success: false
    };

    // Step 1: Get a project type
    const projectTypes = await base44.asServiceRole.entities.ProjectType.list();
    if (projectTypes.length === 0) {
      return Response.json({ error: 'No project types found' }, { status: 400 });
    }
    const projectTypeId = projectTypes[0].id;
    results.steps.push({ step: 'Found project type', projectTypeId });

    // Step 2: Create a test category
    const testCat = await base44.asServiceRole.entities.ProductCategory.create({
      project_type_id: projectTypeId,
      project_type_name: projectTypes[0].name,
      name: 'TEST_DELETE_CATEGORY_' + Date.now(),
      color: '#ff0000',
      icon: '🧪',
      is_active: true
    });
    results.steps.push({ step: 'Created test category', categoryId: testCat.id, categoryName: testCat.name });

    // Step 3: Verify it was created
    const verify1 = await base44.asServiceRole.entities.ProductCategory.list();
    const found1 = verify1.find(c => c.id === testCat.id);
    results.steps.push({ step: 'Verified category created', found: !!found1 });

    // Step 4: Try to delete it
    try {
      await base44.asServiceRole.entities.ProductCategory.delete(testCat.id);
      results.steps.push({ step: 'Delete API call succeeded', categoryId: testCat.id });
    } catch (err) {
      results.steps.push({ step: 'Delete API call failed', error: err.message });
      return Response.json(results);
    }

    // Step 5: Verify deletion
    const verify2 = await base44.asServiceRole.entities.ProductCategory.list();
    const found2 = verify2.find(c => c.id === testCat.id);
    results.steps.push({ step: 'Verified deletion', stillExists: !!found2 });

    results.success = !found2;
    return Response.json(results);
  } catch (error) {
    return Response.json({ error: error.message, stack: error.stack }, { status: 500 });
  }
});
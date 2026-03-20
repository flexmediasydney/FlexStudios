import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();
    
    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Admin access required' }, { status: 403 });
    }

    const report = {
      iterations: 5,
      results: [],
      allPassed: true
    };

    for (let i = 0; i < report.iterations; i++) {
      try {
        const projectTypes = await base44.asServiceRole.entities.ProjectType.list();
        const pt = projectTypes[0];

        // Create category
        const cat = await base44.asServiceRole.entities.ProductCategory.create({
          project_type_id: pt.id,
          project_type_name: pt.name,
          name: `TEST_CAT_${i}_${Date.now()}`,
          color: '#' + Math.floor(Math.random()*16777215).toString(16),
          icon: '🧪',
          is_active: true
        });

        // Verify created
        const before = await base44.asServiceRole.entities.ProductCategory.list();
        const exists1 = before.some(c => c.id === cat.id);

        // Delete it
        await base44.asServiceRole.entities.ProductCategory.delete(cat.id);

        // Verify deleted
        const after = await base44.asServiceRole.entities.ProductCategory.list();
        const exists2 = after.some(c => c.id === cat.id);

        const passed = exists1 && !exists2;
        report.results.push({
          iteration: i + 1,
          categoryId: cat.id,
          categoryName: cat.name,
          existedBeforeDelete: exists1,
          existedAfterDelete: exists2,
          passed
        });

        if (!passed) report.allPassed = false;
      } catch (err) {
        report.results.push({
          iteration: i + 1,
          error: err.message,
          passed: false
        });
        report.allPassed = false;
      }
    }

    return Response.json(report);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
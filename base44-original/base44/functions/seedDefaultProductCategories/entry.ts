import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (user?.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    const DEFAULT_CATEGORIES = [
      { name: 'Photography', icon: '📷', color: '#3b82f6' },
      { name: 'Video', icon: '🎬', color: '#8b5cf6' },
      { name: 'Floorplan', icon: '📐', color: '#06b6d4' },
      { name: 'Drone', icon: '🚁', color: '#ec4899' },
      { name: 'Editing', icon: '✂️', color: '#f97316' },
      { name: 'Virtual Staging', icon: '🛋️', color: '#22c55e' }
    ];

    const projectTypes = await base44.asServiceRole.entities.ProjectType.list();
    const existingCategories = await base44.asServiceRole.entities.ProductCategory.list();

    const categoriesToCreate = [];
    let createdCount = 0;

    for (const projectType of projectTypes) {
      for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
        const cat = DEFAULT_CATEGORIES[i];
        const exists = existingCategories.some(
          ec => ec.project_type_id === projectType.id && ec.name === cat.name
        );

        if (!exists) {
          categoriesToCreate.push({
            project_type_id: projectType.id,
            project_type_name: projectType.name,
            name: cat.name,
            icon: cat.icon,
            color: cat.color,
            order: i
          });
        }
      }
    }

    if (categoriesToCreate.length > 0) {
      await base44.asServiceRole.entities.ProductCategory.bulkCreate(categoriesToCreate);
      createdCount = categoriesToCreate.length;
    }

    return Response.json({
      status: 'success',
      message: `Seeded ${createdCount} default product categories`,
      created: createdCount,
      total: existingCategories.length + createdCount
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
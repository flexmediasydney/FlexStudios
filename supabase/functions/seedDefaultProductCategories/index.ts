import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('seedDefaultProductCategories', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Auth: master_admin only — seed operation
    const user = await getUserFromReq(req).catch(() => null);
    if (!user || user.role !== 'master_admin') {
      return errorResponse('Master admin access required', 403);
    }

    const DEFAULT_CATEGORIES = [
      { name: 'Photography', icon: '📷', color: '#3b82f6' },
      { name: 'Video', icon: '🎬', color: '#8b5cf6' },
      { name: 'Floorplan', icon: '📐', color: '#06b6d4' },
      { name: 'Drone', icon: '🚁', color: '#ec4899' },
      { name: 'Editing', icon: '✂️', color: '#f97316' },
      { name: 'Virtual Staging', icon: '🛋️', color: '#22c55e' }
    ];

    const projectTypes = await entities.ProjectType.list();
    const existingCategories = await entities.ProductCategory.list();

    const categoriesToCreate: any[] = [];
    let createdCount = 0;

    for (const projectType of projectTypes) {
      for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
        const cat = DEFAULT_CATEGORIES[i];
        const exists = existingCategories.some(
          (ec: any) => ec.project_type_id === projectType.id && ec.name === cat.name
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
      for (const cat of categoriesToCreate) {
        await entities.ProductCategory.create(cat);
      }
      createdCount = categoriesToCreate.length;
    }

    return jsonResponse({
      status: 'success',
      message: `Seeded ${createdCount} default product categories`,
      created: createdCount,
      total: existingCategories.length + createdCount
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

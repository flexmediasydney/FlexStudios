import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('resetPackages', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    // Delete all packages
    const allPackages = await entities.Package.list();
    for (const pkg of allPackages) {
      await entities.Package.delete(pkg.id);
    }

    // Seed default packages
    const defaultPackages = [
      {
        name: "Basic Package",
        description: "Basic photography package",
        products: [],
        standard_tier: { package_price: 500, scheduling_time: 60, admin_time: 30, editor_time: 120 },
        premium_tier: { package_price: 750, scheduling_time: 60, admin_time: 30, editor_time: 120 },
        is_active: true
      },
      {
        name: "Standard Package",
        description: "Standard photography and video package",
        products: [],
        standard_tier: { package_price: 1000, scheduling_time: 120, admin_time: 60, editor_time: 240 },
        premium_tier: { package_price: 1500, scheduling_time: 120, admin_time: 60, editor_time: 240 },
        is_active: true
      },
      {
        name: "Premium Package",
        description: "Complete photography, video, and drone package",
        products: [],
        standard_tier: { package_price: 2000, scheduling_time: 180, admin_time: 120, editor_time: 480 },
        premium_tier: { package_price: 3000, scheduling_time: 180, admin_time: 120, editor_time: 480 },
        is_active: true
      }
    ];

    const seeded: any[] = [];
    for (const pkg of defaultPackages) {
      const created = await entities.Package.create(pkg);
      seeded.push(created);
    }

    return jsonResponse({
      success: true,
      deleted: allPackages.length,
      seeded: defaultPackages.length,
      message: `Deleted ${allPackages.length} packages and seeded ${defaultPackages.length} default packages`
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

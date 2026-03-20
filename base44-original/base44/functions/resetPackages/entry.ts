import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== 'master_admin') {
      return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Delete all packages
    const allPackages = await base44.asServiceRole.entities.Package.list();
    for (const pkg of allPackages) {
      await base44.asServiceRole.entities.Package.delete(pkg.id);
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

    await base44.asServiceRole.entities.Package.bulkCreate(defaultPackages);

    return Response.json({ 
      success: true, 
      deleted: allPackages.length,
      seeded: defaultPackages.length,
      message: `Deleted ${allPackages.length} packages and seeded ${defaultPackages.length} default packages`
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('resetPackages', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403, req);
    }

    // Tolerate empty body and require an explicit confirmation. This is a
    // destructive operation (deletes ALL packages and re-seeds defaults).
    // Without the confirm flag, probes / accidental calls fall to a 400 instead
    // of nuking production data.
    const payload = await req.json().catch(() => ({} as any));
    if (payload?.confirm !== true) {
      return errorResponse(
        'Refusing to run destructive reset without { "confirm": true } in payload',
        400,
        req,
      );
    }

    // Delete all packages. Some installs have triggers that cascade into
    // soft-deleted project_tasks and raise; surface those as 409 with a clear
    // message instead of a generic 500.
    const allPackages = await entities.Package.list();
    for (const pkg of allPackages) {
      try {
        await entities.Package.delete(pkg.id);
      } catch (delErr: any) {
        const msg = delErr?.message || String(delErr);
        if (msg.includes('Cannot update a deleted task') || msg.includes('Restore it first')) {
          return errorResponse(
            `Cannot reset packages: package ${pkg.id} is referenced by a soft-deleted project_task. Restore or hard-delete the affected tasks first. (${msg})`,
            409,
            req,
          );
        }
        throw delErr;
      }
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
    }, 200, req);
  } catch (error: any) {
    return errorResponse(error?.message || String(error), 500, req);
  }
});

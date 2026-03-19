import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
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

    // Get all products and packages
    const products = await entities.Product.list();
    const packages = await entities.Package.list();

    // Log all products
    for (const product of products) {
      await entities.ProductAuditLog.create({
        product_id: product.id,
        product_name: product.name,
        action: 'create',
        changed_fields: [],
        new_state: product,
        user_name: user.full_name,
        user_email: user.email
      });
    }

    // Log all packages
    for (const pkg of packages) {
      await entities.PackageAuditLog.create({
        package_id: pkg.id,
        package_name: pkg.name,
        action: 'create',
        changed_fields: [],
        new_state: pkg,
        user_name: user.full_name,
        user_email: user.email
      });
    }

    return jsonResponse({
      success: true,
      products_logged: products.length,
      packages_logged: packages.length
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

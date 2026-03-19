import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

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

    // Get all products and packages
    const products = await base44.asServiceRole.entities.Product.list();
    const packages = await base44.asServiceRole.entities.Package.list();

    // Log all products
    for (const product of products) {
      await base44.asServiceRole.entities.ProductAuditLog.create({
        product_id: product.id,
        product_name: product.data.name,
        action: 'create',
        changed_fields: [],
        new_state: product.data,
        user_name: user.full_name,
        user_email: user.email
      });
    }

    // Log all packages
    for (const pkg of packages) {
      await base44.asServiceRole.entities.PackageAuditLog.create({
        package_id: pkg.id,
        package_name: pkg.data.name,
        action: 'create',
        changed_fields: [],
        new_state: pkg.data,
        user_name: user.full_name,
        user_email: user.email
      });
    }

    return Response.json({
      success: true,
      products_logged: products.length,
      packages_logged: packages.length
    });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
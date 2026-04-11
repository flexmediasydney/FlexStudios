import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // Check if manual (user) or scheduled (cron)
    let userName = null;
    let snapshotType = 'monthly';
    try {
      const user = await getUserFromReq(req);
      if (user?.role !== 'master_admin') {
        return errorResponse('Only master_admin can create snapshots', 403);
      }
      userName = user.full_name;
      snapshotType = 'manual';
    } catch {
      // Called by cron — no user context, that's OK
    }

    const body = await req.json().catch(() => ({}));
    if (body?._health_check) {
      return jsonResponse({ _version: 'v1.0', _fn: 'generateMonthlySnapshots' });
    }

    const label = body?.label || new Intl.DateTimeFormat('en-AU', {
      timeZone: 'Australia/Sydney', month: 'long', year: 'numeric'
    }).format(new Date());

    const now = new Date().toISOString();
    const results = [];

    // 1. Products snapshot
    const products = await entities.Product.list(null, 500);
    await admin.from('product_snapshots').insert({
      snapshot_date: now,
      snapshot_label: label,
      snapshot_type: body?.snapshot_type || snapshotType,
      total_entries: products.length,
      data: products,
      created_by_name: userName,
    });
    results.push({ type: 'products', count: products.length });

    // 2. Packages snapshot
    const packages = await entities.Package.list(null, 200);
    await admin.from('package_snapshots').insert({
      snapshot_date: now,
      snapshot_label: label,
      snapshot_type: body?.snapshot_type || snapshotType,
      total_entries: packages.length,
      data: packages,
      created_by_name: userName,
    });
    results.push({ type: 'packages', count: packages.length });

    // 3. Price matrices snapshot
    const matrices = await entities.PriceMatrix.list(null, 500);
    await admin.from('price_matrix_snapshots').insert({
      snapshot_date: now,
      snapshot_label: label,
      snapshot_type: body?.snapshot_type || snapshotType,
      total_entries: matrices.length,
      data: matrices,
      created_by_name: userName,
    });
    results.push({ type: 'price_matrices', count: matrices.length });

    return jsonResponse({
      success: true,
      label,
      snapshot_type: body?.snapshot_type || snapshotType,
      results,
      created_at: now,
    });
  } catch (err: any) {
    return errorResponse(err.message || 'Failed to generate snapshots', 500);
  }
});

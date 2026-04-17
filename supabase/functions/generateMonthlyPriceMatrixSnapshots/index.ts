import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

serveWithAudit('generateMonthlyPriceMatrixSnapshots', async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);

    // This can be called by admin manually or by scheduler
    let userName = 'Scheduled Job';
    let isManual = false;
    try {
      const user = await getUserFromReq(req);
      if (user) {
        if (user.role !== 'master_admin') {
          return errorResponse('Forbidden: Admin access required', 403);
        }
        userName = user.full_name || user.email;
        isManual = true;
      }
    } catch {
      // Scheduled job - no user context
    }

    const allMatrix = await entities.PriceMatrix.list();

    const now = new Date();
    const label = now.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
    const dateStr = now.toISOString().split('T')[0];

    const snapshot = await entities.PriceMatrixSnapshot.create({
      snapshot_date: dateStr,
      snapshot_label: label,
      snapshot_type: isManual ? 'manual' : 'monthly',
      total_entries: allMatrix.length,
      data: allMatrix,
      created_by_name: isManual ? userName : null
    });

    return jsonResponse({
      success: true,
      snapshot_id: snapshot.id,
      snapshot_label: label,
      total_entries: allMatrix.length
    });
  } catch (error: any) {
    console.error('Error generating snapshot:', error);
    return errorResponse(error.message);
  }
});

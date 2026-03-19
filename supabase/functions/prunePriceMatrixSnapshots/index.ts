import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Prune old price matrix snapshots stored on projects.
 * Keeps only recent snapshots per project to save storage.
 * Run monthly to keep DB lean.
 */
Deno.serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    // Admin-only operation
    if (user?.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    // Fetch all projects with snapshots
    const projects = await entities.Project.list();

    let prunedCount = 0;

    for (const project of projects) {
      // price_matrix_snapshot is a single object, not an array
      if (project.price_matrix_snapshot && typeof project.price_matrix_snapshot === 'object') {
        // If snapshot is very old (older than 6 months), consider clearing it
        const snapshotDate = project.price_matrix_snapshot.applied_date
          ? new Date(project.price_matrix_snapshot.applied_date)
          : null;

        if (snapshotDate) {
          const sixMonthsAgo = new Date();
          sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

          if (snapshotDate < sixMonthsAgo) {
            // Clear old snapshot
            await entities.Project.update(project.id, {
              price_matrix_snapshot: null
            });
            prunedCount++;
          }
        }
      }
    }

    return jsonResponse({
      success: true,
      message: `Pruned ${prunedCount} old price matrix snapshots`,
      prunedCount
    });
  } catch (error: any) {
    console.error('Error pruning snapshots:', error);
    return errorResponse(error.message);
  }
});

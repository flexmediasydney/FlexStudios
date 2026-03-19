import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Cleanup orphaned branding preferences across all agencies
 * Removes preferences that reference deleted or inactive categories
 * Called periodically or when categories are deleted
 */
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (user?.role !== 'master_admin') {
      return errorResponse('Forbidden: Admin access required', 403);
    }

    // Fetch all agencies and categories
    const [agencies, categories] = await Promise.all([
      entities.Agency.list(),
      entities.ProductCategory.list(),
    ]);

    const activeCategoryIds = new Set(
      categories
        .filter((c: any) => c.is_active !== false)
        .map((c: any) => c.id)
    );

    let cleanedCount = 0;
    let agenciesUpdated = 0;

    // Process each agency
    for (const agency of agencies) {
      if (!agency.branding_preferences || agency.branding_preferences.length === 0) {
        continue;
      }

      const prefs = agency.branding_preferences;
      const orphaned = prefs.filter((p: any) => !activeCategoryIds.has(p.category_id));

      if (orphaned.length === 0) {
        continue;
      }

      // Filter to keep only valid preferences
      const cleanedPrefs = prefs.filter((p: any) => activeCategoryIds.has(p.category_id));

      try {
        await entities.Agency.update(agency.id, {
          branding_preferences: cleanedPrefs,
        });

        cleanedCount += orphaned.length;
        agenciesUpdated += 1;
      } catch (err: any) {
        console.error(`Failed to clean agency ${agency.id}:`, err);
      }
    }

    return jsonResponse({
      success: true,
      message: `Cleaned ${cleanedCount} orphaned preferences from ${agenciesUpdated} agencies`,
      stats: {
        orphaned_removed: cleanedCount,
        agencies_updated: agenciesUpdated,
        total_agencies: agencies.length,
        active_categories: activeCategoryIds.size,
      },
    });
  } catch (error: any) {
    console.error('Cleanup error:', error);
    return errorResponse(error.message);
  }
});

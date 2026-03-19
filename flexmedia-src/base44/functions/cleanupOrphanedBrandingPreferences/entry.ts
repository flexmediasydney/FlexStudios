import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Cleanup orphaned branding preferences across all agencies
 * Removes preferences that reference deleted or inactive categories
 * Called periodically or when categories are deleted
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    // Only admin users can run this
    if (user?.role !== 'master_admin') {
      return Response.json(
        { error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    // Fetch all agencies and categories
    const [agencies, categories] = await Promise.all([
      base44.asServiceRole.entities.Agency.list(),
      base44.asServiceRole.entities.ProductCategory.list()
    ]);

    const activeCategoryIds = new Set(
      categories
        .filter(c => c.is_active !== false)
        .map(c => c.id)
    );

    let cleanedCount = 0;
    let agenciesUpdated = 0;

    // Process each agency
    for (const agency of agencies) {
      if (!agency.branding_preferences || agency.branding_preferences.length === 0) {
        continue;
      }

      const prefs = agency.branding_preferences;
      const orphaned = prefs.filter(p => !activeCategoryIds.has(p.category_id));

      if (orphaned.length === 0) {
        continue;
      }

      // Filter to keep only valid preferences
      const cleanedPrefs = prefs.filter(p => activeCategoryIds.has(p.category_id));

      // Update agency
      try {
        await base44.asServiceRole.entities.Agency.update(agency.id, {
          branding_preferences: cleanedPrefs
        });

        cleanedCount += orphaned.length;
        agenciesUpdated += 1;
      } catch (err) {
        console.error(`Failed to clean agency ${agency.id}:`, err);
      }
    }

    return Response.json({
      success: true,
      message: `Cleaned ${cleanedCount} orphaned preferences from ${agenciesUpdated} agencies`,
      stats: {
        orphaned_removed: cleanedCount,
        agencies_updated: agenciesUpdated,
        total_agencies: agencies.length,
        active_categories: activeCategoryIds.size
      }
    });
  } catch (error) {
    console.error('Cleanup error:', error);
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});
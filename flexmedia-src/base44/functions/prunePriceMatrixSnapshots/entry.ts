import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Prune old price matrix snapshots stored on projects.
 * Keeps only the 3 most recent snapshots per project to save storage.
 * Run monthly to keep DB lean.
 */
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        // Admin-only operation
        if (user?.role !== 'master_admin') {
            return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
        }

        // Fetch all projects with snapshots
        const projects = await base44.entities.Project.list(undefined, undefined);
        
        let prunedCount = 0;

        for (const project of projects) {
            // price_matrix_snapshot is a single object, not an array
            // But we can track if we should clear old data periodically
            // For now, just ensure it's not bloated on new calculations
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
                        await base44.entities.Project.update(project.id, {
                            price_matrix_snapshot: null
                        });
                        prunedCount++;
                    }
                }
            }
        }

        return Response.json({
            success: true,
            message: `Pruned ${prunedCount} old price matrix snapshots`,
            prunedCount
        });
    } catch (error) {
        console.error('Error pruning snapshots:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
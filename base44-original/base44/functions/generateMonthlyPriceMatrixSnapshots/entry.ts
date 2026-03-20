import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);

        // This can be called by admin manually or by scheduler
        let userName = 'Scheduled Job';
        let isManual = false;
        try {
            const user = await base44.auth.me();
            if (user) {
                if (user.role !== 'master_admin') {
                    return Response.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
                }
                userName = user.full_name || user.email;
                isManual = true;
            }
        } catch (e) {
            // Scheduled job - no user context
        }

        const allMatrix = await base44.asServiceRole.entities.PriceMatrix.list();

        const now = new Date();
        const label = now.toLocaleString('en-AU', { month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
        const dateStr = now.toISOString().split('T')[0];

        const snapshot = await base44.asServiceRole.entities.PriceMatrixSnapshot.create({
            snapshot_date: dateStr,
            snapshot_label: label,
            snapshot_type: isManual ? 'manual' : 'monthly',
            total_entries: allMatrix.length,
            data: allMatrix,
            created_by_name: isManual ? userName : null
        });

        return Response.json({
            success: true,
            snapshot_id: snapshot.id,
            snapshot_label: label,
            total_entries: allMatrix.length
        });
    } catch (error) {
        console.error('Error generating snapshot:', error);
        return Response.json({ error: error.message }, { status: 500 });
    }
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.6';

/**
 * Gatekeeper function for admin-only settings endpoints.
 * Prevents unauthorized users from accessing pricing, products, users, etc.
 */
Deno.serve(async (req) => {
    try {
        const base44 = createClientFromRequest(req);
        const user = await base44.auth.me();

        if (!user) {
            return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Only master_admin and employee roles can access settings
        if (user.role !== 'master_admin' && user.role !== 'employee') {
            console.warn(`Unauthorized settings access attempt by ${user.email} (role: ${user.role})`);
            return Response.json({ 
                error: 'You do not have permission to access this resource' 
            }, { status: 403 });
        }

        const { endpoint } = await req.json();

        // Per-endpoint permission checks
        const rules = {
            'products': ['master_admin', 'employee'],
            'packages': ['master_admin', 'employee'],
            'price_matrix': ['master_admin', 'employee'],
            'users': ['master_admin'],
            'teams': ['master_admin'],
            'organization': ['master_admin'],
            'integrations': ['master_admin', 'employee'],
        };

        if (rules[endpoint] && !rules[endpoint].includes(user.role)) {
            console.warn(`Permission denied for ${user.email}: endpoint ${endpoint} requires ${rules[endpoint].join(' or ')}`);
            return Response.json({ 
                error: 'Insufficient permissions for this endpoint' 
            }, { status: 403 });
        }

        return Response.json({ allowed: true, user_role: user.role });
    } catch (error) {
        console.error('Settings access validation error:', error);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
    }
});
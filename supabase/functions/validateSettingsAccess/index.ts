import { getUserFromReq, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Gatekeeper function for admin-only settings endpoints.
 * Prevents unauthorized users from accessing pricing, products, users, etc.
 */
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const user = await getUserFromReq(req);

    if (!user) {
      return errorResponse('Unauthorized', 401);
    }

    // Only master_admin and employee roles can access settings
    if (user.role !== 'master_admin' && user.role !== 'employee') {
      console.warn(`Unauthorized settings access attempt by ${user.email} (role: ${user.role})`);
      return errorResponse('You do not have permission to access this resource', 403);
    }

    const { endpoint } = await req.json();

    // Per-endpoint permission checks
    const rules: Record<string, string[]> = {
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
      return errorResponse('Insufficient permissions for this endpoint', 403);
    }

    return jsonResponse({ allowed: true, user_role: user.role });
  } catch (error: any) {
    console.error('Settings access validation error:', error);
    return errorResponse('Internal server error');
  }
});

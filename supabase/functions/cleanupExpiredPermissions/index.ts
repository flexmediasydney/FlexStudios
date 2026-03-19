import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Cleanup expired permissions - run daily
 */
Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;

  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== 'master_admin') {
      return errorResponse('Only master_admin can cleanup expired permissions', 403);
    }

    // Get all active permissions with expiry dates
    const allPerms = await entities.UserPermission.list();

    const now = new Date();
    let deactivatedCount = 0;

    for (const perm of allPerms) {
      if (perm.is_active && perm.expires_at) {
        const expiresAt = new Date(perm.expires_at);
        if (expiresAt <= now) {
          await entities.UserPermission.update(perm.id, {
            is_active: false,
          });
          deactivatedCount++;

          // Log cleanup action
          await entities.PermissionAuditLog.create({
            actor_email: 'system@flexmedia.com',
            action: 'permission_revoked',
            target_user_email: perm.user_email,
            permission_name: perm.permission_name,
            status: 'success',
            reason_denied: 'Automatic expiration',
          });
        }
      }
    }

    return jsonResponse({
      success: true,
      message: `Cleaned up ${deactivatedCount} expired permissions`,
      timestamp: new Date().toISOString(),
    });

  } catch (err: any) {
    console.error('Cleanup error:', err);
    return errorResponse(err.message);
  }
});

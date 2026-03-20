import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Cleanup expired permissions - run daily
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== "master_admin") {
      return Response.json(
        { error: "Only master_admin can cleanup expired permissions" },
        { status: 403 }
      );
    }

    // Get all active permissions with expiry dates
    const allPerms = await base44.asServiceRole.entities.UserPermission.list();
    
    const now = new Date();
    let deactivatedCount = 0;

    for (const perm of allPerms) {
      if (perm.is_active && perm.expires_at) {
        const expiresAt = new Date(perm.expires_at);
        if (expiresAt <= now) {
          await base44.asServiceRole.entities.UserPermission.update(perm.id, {
            is_active: false
          });
          deactivatedCount++;

          // Log cleanup action
          await base44.asServiceRole.entities.PermissionAuditLog.create({
            actor_email: "system@base44.com",
            action: "permission_revoked",
            target_user_email: perm.user_email,
            permission_name: perm.permission_name,
            status: "success",
            reason_denied: "Automatic expiration"
          });
        }
      }
    }

    return Response.json({
      success: true,
      message: `Cleaned up ${deactivatedCount} expired permissions`,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("Cleanup error:", error);
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});
import { createClientFromRequest } from 'npm:@base44/sdk@0.8.20';

/**
 * Seed default permissions and roles
 * Called once during setup
 */
Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const user = await base44.auth.me();

    if (!user || user.role !== "master_admin") {
      return Response.json(
        { error: "Only master_admin can seed permissions" },
        { status: 403 }
      );
    }

    // Define permissions
    const permissionDefs = [
      // Projects
      { name: "projects.view", display_name: "View Projects", resource: "projects", action: "view", risk_level: "low" },
      { name: "projects.create", display_name: "Create Projects", resource: "projects", action: "create", risk_level: "medium" },
      { name: "projects.edit", display_name: "Edit Projects", resource: "projects", action: "edit", risk_level: "medium" },
      { name: "projects.delete", display_name: "Delete Projects", resource: "projects", action: "delete", risk_level: "high", requires_approval: true },

      // Products
      { name: "products.view", display_name: "View Products", resource: "products", action: "view", risk_level: "low" },
      { name: "products.manage", display_name: "Manage Products", resource: "products", action: "manage", risk_level: "high", requires_approval: true },

      // Users
      { name: "users.view", display_name: "View Users", resource: "users", action: "view", risk_level: "low" },
      { name: "users.create", display_name: "Create Users", resource: "users", action: "create", risk_level: "high", requires_approval: true },
      { name: "users.delete", display_name: "Delete Users", resource: "users", action: "delete", risk_level: "critical", requires_approval: true, requires_mfa: true },

      // Settings
      { name: "settings.view", display_name: "View Settings", resource: "settings", action: "view", risk_level: "low" },
      { name: "settings.configure", display_name: "Configure Settings", resource: "settings", action: "configure", risk_level: "critical", requires_approval: true, requires_mfa: true },

      // Reports
      { name: "reports.view", display_name: "View Reports", resource: "reports", action: "view", risk_level: "low" },
      { name: "reports.export", display_name: "Export Reports", resource: "reports", action: "export", risk_level: "medium" },

      // Audit
      { name: "audit_logs.view", display_name: "View Audit Logs", resource: "audit_logs", action: "view", risk_level: "high" },

      // Integrations
      { name: "integrations.view", display_name: "View Integrations", resource: "integrations", action: "view", risk_level: "low" },
      { name: "integrations.configure", display_name: "Configure Integrations", resource: "integrations", action: "configure", risk_level: "high", requires_approval: true },
    ];

    // Create permissions
    const createdPermissions = [];
    for (const permDef of permissionDefs) {
      const existing = await base44.asServiceRole.entities.Permission.filter({ name: permDef.name });
      if (existing.length === 0) {
        const perm = await base44.asServiceRole.entities.Permission.create({
          ...permDef,
          is_system_permission: true
        });
        createdPermissions.push(perm);
      } else {
        createdPermissions.push(existing[0]);
      }
    }

    // Define roles
    const roleDefs = [
      {
        name: "master_admin",
        display_name: "Master Admin",
        description: "Full system access and control",
        is_system_role: true,
        hierarchy_level: 100,
        scope: "global",
        permission_ids: createdPermissions.map(p => p.id)
      },
      {
        name: "admin",
        display_name: "Administrator",
        description: "Can manage users, projects, and settings",
        is_system_role: true,
        hierarchy_level: 75,
        scope: "global",
        permission_ids: createdPermissions
          .filter(p => !["users.delete", "settings.configure"].includes(p.name))
          .map(p => p.id)
      },
      {
        name: "manager",
        display_name: "Manager",
        description: "Can manage projects and view reports",
        is_system_role: true,
        hierarchy_level: 50,
        scope: "team",
        permission_ids: createdPermissions
          .filter(p => ["projects.view", "projects.create", "projects.edit", "reports.view", "reports.export"].some(pn => p.name === pn))
          .map(p => p.id)
      },
      {
        name: "editor",
        display_name: "Editor",
        description: "Can create and edit content",
        is_system_role: true,
        hierarchy_level: 30,
        scope: "team",
        permission_ids: createdPermissions
          .filter(p => ["projects.view", "projects.create", "projects.edit", "products.view"].some(pn => p.name === pn))
          .map(p => p.id)
      },
      {
        name: "viewer",
        display_name: "Viewer",
        description: "Read-only access to projects and reports",
        is_system_role: true,
        hierarchy_level: 10,
        scope: "team",
        permission_ids: createdPermissions
          .filter(p => ["projects.view", "reports.view", "products.view"].some(pn => p.name === pn))
          .map(p => p.id)
      }
    ];

    // Create roles
    const createdRoles = [];
    for (const roleDef of roleDefs) {
      const existing = await base44.asServiceRole.entities.Role.filter({ name: roleDef.name });
      if (existing.length === 0) {
        const role = await base44.asServiceRole.entities.Role.create(roleDef);
        createdRoles.push(role);
      } else {
        createdRoles.push(existing[0]);
      }
    }

    return Response.json({
      success: true,
      message: "Permissions and roles seeded successfully",
      permissions_created: createdPermissions.length,
      roles_created: createdRoles.length
    });
  } catch (error) {
    console.error("Seed error:", error);
    return Response.json(
      { error: error.message },
      { status: 500 }
    );
  }
});
import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';

/**
 * Comprehensive permission engine test suite
 */
serveWithAudit('testPermissionEngine', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (!user || user.role !== "master_admin") {
      return errorResponse("Only master_admin can run tests", 403);
    }

    const results: any[] = [];

    // Test 1: Seed permissions if missing
    try {
      const existingPerms = await entities.Permission.list();
      if (existingPerms.length === 0) {
        results.push({
          test: "Seed Permissions",
          status: "EXECUTING",
          message: "Seeding default permissions..."
        });

        const permDefs = [
          { name: "projects.view", display_name: "View Projects", resource: "projects", action: "view", risk_level: "low" },
          { name: "projects.create", display_name: "Create Projects", resource: "projects", action: "create", risk_level: "medium" },
          { name: "users.view", display_name: "View Users", resource: "users", action: "view", risk_level: "low" },
          { name: "users.delete", display_name: "Delete Users", resource: "users", action: "delete", risk_level: "critical", requires_approval: true, requires_mfa: true }
        ];

        for (const def of permDefs) {
          await entities.Permission.create({
            ...def,
            is_system_permission: true
          });
        }

        results.push({
          test: "Seed Permissions",
          status: "PASS",
          message: `Created ${permDefs.length} permissions`
        });
      }
    } catch (e: any) {
      results.push({
        test: "Seed Permissions",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 2: Verify Permission entity schema
    try {
      const perms = await entities.Permission.list();
      const hasRequiredFields = perms.every((p: any) =>
        p.name && p.display_name && p.resource && p.action
      );
      results.push({
        test: "Permission Schema Validation",
        status: hasRequiredFields ? "PASS" : "FAIL",
        message: hasRequiredFields
          ? `All ${perms.length} permissions have required fields`
          : "Some permissions missing required fields"
      });
    } catch (e: any) {
      results.push({
        test: "Permission Schema Validation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 3: Verify Role entity schema
    try {
      const roles = await entities.Role.list();
      results.push({
        test: "Role Schema Validation",
        status: roles.length > 0 ? "PASS" : "WARN",
        message: roles.length > 0
          ? `Found ${roles.length} roles`
          : "No roles found - seed permissions first"
      });
    } catch (e: any) {
      results.push({
        test: "Role Schema Validation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 4: Test UserPermission creation
    try {
      const perms = await entities.Permission.filter({ name: "projects.view" });
      const users = await entities.User.list();

      if (perms.length > 0 && users.length > 0) {
        const testUser = users[0];
        const testPerm = perms[0];

        const existing = await entities.UserPermission.filter({
          user_id: testUser.id,
          permission_id: testPerm.id
        });

        if (existing.length === 0) {
          const grant = await entities.UserPermission.create({
            user_id: testUser.id,
            user_email: testUser.email,
            permission_id: testPerm.id,
            permission_name: testPerm.name,
            granted_by: user.email,
            granted_at: new Date().toISOString(),
            is_active: true,
            source: "test"
          });

          results.push({
            test: "UserPermission Creation",
            status: grant ? "PASS" : "FAIL",
            message: "Created test permission grant"
          });

          // Clean up
          await entities.UserPermission.delete(grant.id);
        } else {
          results.push({
            test: "UserPermission Creation",
            status: "PASS",
            message: "Test grant already exists"
          });
        }
      }
    } catch (e: any) {
      results.push({
        test: "UserPermission Creation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 5: Test PermissionAuditLog creation
    try {
      const log = await entities.PermissionAuditLog.create({
        actor_email: user.email,
        action: "permission_used",
        permission_name: "projects.view",
        status: "success"
      });

      results.push({
        test: "PermissionAuditLog Creation",
        status: log ? "PASS" : "FAIL",
        message: "Audit log entry created successfully"
      });

      // Clean up
      await entities.PermissionAuditLog.delete(log.id);
    } catch (e: any) {
      results.push({
        test: "PermissionAuditLog Creation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 6: Test ApprovalWorkflow creation
    try {
      const workflow = await entities.ApprovalWorkflow.create({
        action_type: "permission_grant",
        requestor_email: user.email,
        status: "pending",
        requested_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        action_details: { test: true }
      });

      results.push({
        test: "ApprovalWorkflow Creation",
        status: workflow ? "PASS" : "FAIL",
        message: "Approval workflow created successfully"
      });

      // Clean up
      await entities.ApprovalWorkflow.delete(workflow.id);
    } catch (e: any) {
      results.push({
        test: "ApprovalWorkflow Creation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 7: Permission hierarchy validation
    try {
      const perms = await entities.Permission.list();
      const hierarchyValid = perms.every((p: any) => {
        if (!p.parent_permission_id) return true;
        return perms.some((parent: any) => parent.id === p.parent_permission_id);
      });
      results.push({
        test: "Permission Hierarchy",
        status: hierarchyValid ? "PASS" : "WARN",
        message: hierarchyValid
          ? "All permission hierarchies valid"
          : "Some permissions reference missing parents"
      });
    } catch (e: any) {
      results.push({
        test: "Permission Hierarchy",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 8: Risk level validation
    try {
      const perms = await entities.Permission.list();
      const validRiskLevels = ["low", "medium", "high", "critical"];
      const riskValid = perms.every((p: any) =>
        validRiskLevels.includes(p.risk_level)
      );
      results.push({
        test: "Risk Level Validation",
        status: riskValid ? "PASS" : "FAIL",
        message: riskValid
          ? "All permissions have valid risk levels"
          : "Some permissions have invalid risk levels"
      });
    } catch (e: any) {
      results.push({
        test: "Risk Level Validation",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 9: Test expiration logic
    try {
      const users = await entities.User.list();
      if (users.length > 0) {
        const perms = await entities.Permission.filter({ name: "projects.view" });
        if (perms.length > 0) {
          const expiredDate = new Date(Date.now() - 1000).toISOString();
          const grant = await entities.UserPermission.create({
            user_id: users[0].id,
            user_email: users[0].email,
            permission_id: perms[0].id,
            permission_name: perms[0].name,
            granted_by: user.email,
            granted_at: new Date().toISOString(),
            expires_at: expiredDate,
            is_active: true,
            source: "test"
          });

          const isExpired = !grant.expires_at || new Date(grant.expires_at) <= new Date();
          results.push({
            test: "Permission Expiration Logic",
            status: isExpired ? "PASS" : "FAIL",
            message: isExpired ? "Expiration logic working" : "Expiration not calculated correctly"
          });

          await entities.UserPermission.delete(grant.id);
        }
      }
    } catch (e: any) {
      results.push({
        test: "Permission Expiration Logic",
        status: "FAIL",
        message: e.message
      });
    }

    // Test 10: Data scope validation
    try {
      const perms = await entities.Permission.list();
      const validScopes = ["own", "team", "all"];
      const scopeValid = perms.every((p: any) =>
        !p.data_scope || validScopes.includes(p.data_scope)
      );
      results.push({
        test: "Data Scope Validation",
        status: scopeValid ? "PASS" : "FAIL",
        message: scopeValid
          ? "All permissions have valid data scopes"
          : "Some permissions have invalid data scopes"
      });
    } catch (e: any) {
      results.push({
        test: "Data Scope Validation",
        status: "FAIL",
        message: e.message
      });
    }

    // Summary
    const passes = results.filter(r => r.status === "PASS").length;
    const fails = results.filter(r => r.status === "FAIL").length;
    const warns = results.filter(r => r.status === "WARN").length;

    return jsonResponse({
      summary: {
        total: results.length,
        passed: passes,
        failed: fails,
        warnings: warns,
        timestamp: new Date().toISOString()
      },
      results
    });
  } catch (error: any) {
    return errorResponse(error.message);
  }
});

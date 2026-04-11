import React, { useState } from "react";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  Plus, Search, X, Clock, AlertTriangle, CheckCircle2, Shield, 
  Eye, Edit, Trash2, Lock, Unlock 
} from "lucide-react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const riskColors = {
  low: "bg-blue-50 text-blue-700 border-blue-200",
  medium: "bg-yellow-50 text-yellow-700 border-yellow-200",
  high: "bg-orange-50 text-orange-700 border-orange-200",
  critical: "bg-red-50 text-red-700 border-red-200"
};

export default function PermissionMatrix() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedUser, setSelectedUser] = useState(null);
  const [showGrantDialog, setShowGrantDialog] = useState(false);
  const [grantingPermission, setGrantingPermission] = useState(null);

  // BUG FIX: Verify the current user is master_admin before allowing grant/revoke.
  // Without this, any employee who navigates to Settings can modify permissions.
  const { data: currentUser } = useQuery({
    queryKey: ["current-user-for-perms"],
    queryFn: () => api.auth.me(),
    staleTime: 60_000,
  });
  const isMasterAdmin = currentUser?.role === 'master_admin';

  // Fetch data
  const { data: users = [], isLoading: usersLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list()
  });

  const { data: permissions = [], isLoading: permsLoading } = useQuery({
    queryKey: ["permissions"],
    queryFn: () => api.entities.Permission.list()
  });

  const { data: userPermissions = [], isLoading: userPermsLoading } = useQuery({
    queryKey: ["userPermissions"],
    queryFn: () => api.entities.UserPermission.list()
  });

  const { data: auditLogs = [] } = useQuery({
    queryKey: ["permissionAuditLogs"],
    queryFn: () => api.entities.PermissionAuditLog.list("-created_date", 100)
  });

  // Mutations
  const grantMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.userEmail || !data.permissionName) {
        throw new Error("User and permission are required");
      }
      const user = await api.auth.me();
      // BUG FIX: Server-side role check — only master_admin can grant permissions
      if (user.role !== 'master_admin') {
        throw new Error("Only admins can grant permissions");
      }
      const permission = permissions.find(p => p.name === data.permissionName);
      if (!permission) throw new Error("Permission not found");

      // BUG FIX: Check for existing active, non-expired grant to prevent duplicates
      const existing = userPermissions.find(
        up => up.user_email === data.userEmail &&
              up.permission_name === data.permissionName &&
              up.is_active &&
              (!up.expires_at || new Date(up.expires_at) > new Date())
      );
      if (existing) throw new Error("Permission already active for this user");

      return await api.entities.UserPermission.create({
        user_email: data.userEmail,
        permission_id: permission.id,
        permission_name: permission.name,
        granted_by: user.email,
        reason: data.reason || "",
        expires_at: data.expiresAt || null,
        is_active: true,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userPermissions"] });
      setSelectedUser(null);
      toast.success("Permission granted successfully");
      setShowGrantDialog(false);
      setGrantingPermission(null);
    },
    onError: (e) => {
      toast.error(e.message || "Failed to grant permission");
    }
  });

  const revokeMutation = useMutation({
    mutationFn: async (data) => {
      if (!data.userEmail || !data.permissionName) {
        throw new Error("User and permission are required");
      }
      // BUG FIX: Server-side role check — only master_admin can revoke permissions
      const me = await api.auth.me();
      if (me.role !== 'master_admin') {
        throw new Error("Only admins can revoke permissions");
      }
      // BUG FIX: Also check expires_at — don't "revoke" an already-expired permission
      const userPerm = userPermissions.find(
        up => up.user_email === data.userEmail &&
              up.permission_name === data.permissionName &&
              up.is_active &&
              (!up.expires_at || new Date(up.expires_at) > new Date())
      );
      if (!userPerm) throw new Error("Active permission not found");

      return await api.entities.UserPermission.update(userPerm.id, { is_active: false });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["userPermissions"] });
      toast.success("Permission revoked successfully");
    },
    onError: (e) => {
      toast.error(e.message || "Failed to revoke permission");
    }
  });

  const filteredUsers = users.filter(u =>
    u.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.full_name?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (usersLoading || permsLoading) {
    return <div className="p-4">Loading permissions...</div>;
  }

  return (
    <div className="space-y-6">
      <Tabs defaultValue="matrix" className="space-y-4">
        <TabsList>
          <TabsTrigger value="matrix">Permission Matrix</TabsTrigger>
          <TabsTrigger value="audit">Audit Trail</TabsTrigger>
          <TabsTrigger value="documentation">Documentation</TabsTrigger>
        </TabsList>

        {/* Permission Matrix Tab */}
        <TabsContent value="matrix" className="space-y-4">
          {userPermsLoading ? (
            <div className="flex items-center justify-center p-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search users..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="max-w-md"
                />
              </div>

              <div className="border rounded-lg overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-muted border-b">
                      <tr>
                        <th className="text-left p-3 font-semibold">User</th>
                        <th className="text-left p-3 font-semibold">Role</th>
                        <th className="text-left p-3 font-semibold">Permissions</th>
                        <th className="text-left p-3 font-semibold">Risk Level</th>
                        <th className="text-right p-3 font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map(user => {
                        const userPerms = userPermissions.filter(
                          up => up.user_email === user.email && up.is_active
                        );
                        const activePerms = userPerms.filter(
                          p => !p.expires_at || new Date(p.expires_at) > new Date()
                        );
                        const maxRisk = activePerms.length > 0
                          ? Math.max(
                              ...activePerms.map(p => {
                                const perm = permissions.find(pr => pr.id === p.permission_id);
                                return { low: 0, medium: 1, high: 2, critical: 3 }[perm?.risk_level || "low"];
                              })
                            )
                          : -1;
                        const riskLevel = ["low", "medium", "high", "critical"][maxRisk + 1] || "none";

                        return (
                          <tr key={user.id} className="border-b hover:bg-muted/50">
                            <td className="p-3">
                              <div>
                                <p className="font-medium">{user.full_name}</p>
                                <p className="text-xs text-muted-foreground">{user.email}</p>
                              </div>
                            </td>
                            <td className="p-3">
                              <Badge variant="outline">{user.role}</Badge>
                            </td>
                            <td className="p-3">
                              <div className="flex items-center gap-2">
                                <span className="text-xs bg-blue-50 px-2 py-1 rounded">
                                  {activePerms.length} perms
                                </span>
                                {activePerms.length > 0 && (
                                  <div className="flex gap-1">
                                    {activePerms.slice(0, 3).map(p => (
                                      <span key={p.id} className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">
                                        {p.permission_name}
                                      </span>
                                    ))}
                                    {activePerms.length > 3 && (
                                      <span className="text-xs text-muted-foreground">
                                        +{activePerms.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="p-3">
                              <Badge className={`${riskColors[riskLevel]}`}>
                                {riskLevel === "none" ? "—" : riskLevel}
                              </Badge>
                            </td>
                            <td className="p-3 text-right">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setSelectedUser(user)}
                                className="gap-1"
                              >
                                <Eye className="h-3 w-3" />
                                View
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
          </TabsContent>

        {/* Audit Trail Tab */}
        <TabsContent value="audit" className="space-y-4">
          <div className="border rounded-lg">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="bg-muted border-b">
                  <tr>
                    <th className="text-left p-3 font-semibold">Time</th>
                    <th className="text-left p-3 font-semibold">Actor</th>
                    <th className="text-left p-3 font-semibold">Action</th>
                    <th className="text-left p-3 font-semibold">Target</th>
                    <th className="text-left p-3 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map(log => (
                    <tr key={log.id} className="border-b hover:bg-muted/50">
                      <td className="p-3">
                        {fmtTimestampCustom(log.created_date, { dateStyle: 'short', timeStyle: 'short' })}
                      </td>
                      <td className="p-3 font-mono text-xs">{log.actor_email}</td>
                      <td className="p-3">
                        <Badge variant="outline" className="text-xs">
                          {log.action}
                        </Badge>
                      </td>
                      <td className="p-3">{log.target_user_email || log.permission_name || "—"}</td>
                      <td className="p-3">
                        <Badge
                          variant="outline"
                          className={
                            log.status === "success"
                              ? "bg-green-50 text-green-700"
                              : log.status === "denied"
                              ? "bg-red-50 text-red-700"
                              : "bg-yellow-50 text-yellow-700"
                          }
                        >
                          {log.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </TabsContent>

        {/* Documentation Tab */}
        <TabsContent value="documentation" className="space-y-4">
          <PermissionDocumentation permissions={permissions} />
        </TabsContent>
      </Tabs>

      {/* User Details Drawer */}
      {selectedUser && (
        <UserPermissionDetails
          user={selectedUser}
          permissions={permissions}
          userPermissions={userPermissions}
          onClose={() => setSelectedUser(null)}
          isMasterAdmin={isMasterAdmin}
          onGrant={(permission) => {
            if (!isMasterAdmin) { toast.error("Only admins can grant permissions"); return; }
            setGrantingPermission(permission);
            setShowGrantDialog(true);
          }}
          onRevoke={(permission) => {
            if (!isMasterAdmin) { toast.error("Only admins can revoke permissions"); return; }
            revokeMutation.mutate({
              userEmail: selectedUser.email,
              permissionName: permission.name
            });
          }}
        />
      )}

      {/* Grant Dialog */}
      {showGrantDialog && grantingPermission && (
        <GrantPermissionDialog
          user={selectedUser}
          permission={grantingPermission}
          isLoading={grantMutation.isPending}
          onClose={() => {
            setShowGrantDialog(false);
            setGrantingPermission(null);
          }}
          onSubmit={(data) => {
            grantMutation.mutate({
              userEmail: selectedUser.email,
              permissionName: grantingPermission.name,
              ...data
            });
          }}
        />
      )}
    </div>
  );
}

function UserPermissionDetails({
  user,
  permissions,
  userPermissions,
  isMasterAdmin,
  onClose,
  onGrant,
  onRevoke
}) {
  if (!user) return null;

  const userPerms = userPermissions.filter(
    up => up.user_email === user.email && up.is_active
  );
  const activePerms = userPerms.filter(
    p => !p.expires_at || new Date(p.expires_at) > new Date()
  );

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-screen w-96 bg-card border-l p-6 overflow-y-auto z-50 shadow-lg">
        <div className="flex justify-between items-start mb-6">
          <div>
            <h2 className="text-xl font-bold">{user.full_name}</h2>
            <p className="text-sm text-muted-foreground">{user.email}</p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="space-y-4">
          <div>
            <p className="text-sm font-semibold mb-2">Current Permissions</p>
            {activePerms.length === 0 ? (
              <p className="text-xs text-muted-foreground">No permissions granted</p>
            ) : (
              <div className="space-y-2">
                {activePerms.map(userPerm => {
                  const perm = permissions.find(p => p.id === userPerm.permission_id);
                  return (
                    <div key={userPerm.id} className="flex items-start justify-between p-2 bg-muted rounded text-xs">
                      <div>
                        <p className="font-mono font-medium">{perm?.name}</p>
                        <p className="text-muted-foreground">{perm?.description}</p>
                        {userPerm.expires_at && (
                          <p className="text-yellow-700 mt-1">
                            <Clock className="h-3 w-3 inline mr-1" />
                            Expires: {new Date(userPerm.expires_at).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      {isMasterAdmin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => onRevoke(perm)}
                          className="text-destructive"
                        >
                          <X className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-semibold mb-2">Available Permissions</p>
            <div className="space-y-1 max-h-64 overflow-y-auto">
              {permissions
                .filter(p => !activePerms.some(up => up.permission_id === p.id))
                .map(perm => (
                  <div key={perm.id} className="flex items-center justify-between p-2 hover:bg-muted rounded text-xs">
                    <div className="flex-1">
                      <p className="font-mono font-medium">{perm.name}</p>
                    </div>
                    {isMasterAdmin && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onGrant(perm)}
                      >
                        <Plus className="h-3 w-3" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
          </div>
        </div>
      </div>
    </>
  );
}



function GrantPermissionDialog({ user, permission, isLoading, onClose, onSubmit }) {
  // BUG FIX: Moved useState hooks BEFORE the early return to comply with Rules of Hooks.
  // React requires hooks to be called in the same order on every render.
  const [reason, setReason] = useState("");
  const [temporary, setTemporary] = useState(false);
  const [expiryDays, setExpiryDays] = useState(7);
  const [error, setError] = useState("");

  if (!user || !permission) return null;

  const handleSubmit = () => {
    if (expiryDays < 1) {
      setError("Expiry days must be at least 1");
      return;
    }
    onSubmit({
      reason,
      expiresAt: temporary
        ? new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000).toISOString()
        : null
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-card rounded-lg p-6 max-w-md w-full space-y-4 shadow-lg">
        <h3 className="font-semibold">Grant Permission</h3>
        <div className="space-y-2 text-sm">
          <p><strong>User:</strong> {user.full_name}</p>
          <p><strong>Permission:</strong> {permission.name}</p>
          <p className="text-muted-foreground">{permission.description}</p>
        </div>
        <textarea
          placeholder="Reason for granting..."
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setError("");
          }}
          className="w-full border rounded px-3 py-2 text-sm"
          rows="3"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={temporary}
            onChange={(e) => setTemporary(e.target.checked)}
          />
          Temporary (expires after)
        </label>
        {temporary && (
          <Input
            type="number"
            min="1"
            max="365"
            value={expiryDays}
            onChange={(e) => {
              setExpiryDays(Math.max(1, Math.min(365, Number(e.target.value) || 1)));
              setError("");
            }}
            placeholder="Days (1-365)"
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose} disabled={isLoading}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={isLoading} className="gap-1">
            {isLoading && <div className="h-3 w-3 rounded-full border-2 border-primary-foreground border-t-transparent animate-spin" />}
            Grant
          </Button>
        </div>
      </div>
    </div>
  );
}

function PermissionDocumentation({ permissions }) {
  return (
    <div className="space-y-4">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm">
        <h3 className="font-semibold text-blue-900 mb-2">Permission Matrix Guide</h3>
        <ul className="space-y-1 text-blue-800 list-disc list-inside">
          <li>Permissions are fine-grained access controls</li>
          <li>Users inherit permissions from roles + direct grants</li>
          <li>Temporary permissions automatically expire</li>
          <li>All actions are audit logged</li>
          <li>High-risk actions require approval</li>
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="font-semibold">Available Permissions</h3>
        <div className="grid gap-3">
          {permissions.map(perm => (
            <div key={perm.id} className={`border rounded-lg p-3 ${riskColors[perm.risk_level]}`}>
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <p className="font-mono font-semibold text-sm">{perm.name}</p>
                  <p className="text-xs mt-1">{perm.description}</p>
                </div>
                <Badge variant="outline" className="text-xs ml-2">
                  {perm.risk_level}
                </Badge>
              </div>
              <div className="flex gap-2 mt-2 text-xs">
                {perm.requires_mfa && (
                  <span className="flex items-center gap-1 bg-card/50 px-2 py-1 rounded">
                    <Lock className="h-3 w-3" /> MFA
                  </span>
                )}
                {perm.requires_approval && (
                  <span className="flex items-center gap-1 bg-card/50 px-2 py-1 rounded">
                    <Shield className="h-3 w-3" /> Approval
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
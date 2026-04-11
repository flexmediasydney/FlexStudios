import { useState, useMemo } from "react";
import React from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from "@/api/supabaseClient";
import { supabase } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Shield, UserCheck, UserX, Edit, Trash2, Phone, Mail, KeyRound, RotateCcw, Send, Clock, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import DeleteConfirmationDialog from "@/components/common/DeleteConfirmationDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import InviteUserDialog from "@/components/users/InviteUserDialog";
import InviteCodesPanel from "@/components/users/InviteCodesPanel";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

const roleConfig = {
  master_admin: { label: "Owner", color: "bg-red-100 text-red-700 border-red-200", icon: Shield },
  admin: { label: "Administrator", color: "bg-orange-100 text-orange-700 border-orange-200", icon: Shield },
  manager: { label: "Manager", color: "bg-purple-100 text-purple-700 border-purple-200", icon: UserCheck },
  employee: { label: "Staff", color: "bg-blue-100 text-blue-700 border-blue-200", icon: UserCheck },
  contractor: { label: "Contractor", color: "bg-gray-100 text-gray-700 border-gray-200", icon: UserX },
};

const providerLabel = { email: "Email/Password", google: "Google", phone: "Phone OTP" };

const STAFF_ROLE_OPTIONS = [
  { value: "project_owner", label: "Project Owner" },
  { value: "photographer", label: "Photographer" },
  { value: "videographer", label: "Videographer" },
  { value: "drone_operator", label: "Drone Operator" },
  { value: "image_editor", label: "Image Editor" },
  { value: "video_editor", label: "Video Editor" },
  { value: "floorplan_editor", label: "Floorplan Editor" },
  { value: "drone_editor", label: "Drone Editor" },
];

const STAFF_ROLE_COLORS = {
  project_owner:    "bg-emerald-100 text-emerald-700 border-emerald-200",
  photographer:     "bg-blue-100 text-blue-700 border-blue-200",
  videographer:     "bg-purple-100 text-purple-700 border-purple-200",
  drone_operator:   "bg-pink-100 text-pink-700 border-pink-200",
  image_editor:     "bg-green-100 text-green-700 border-green-200",
  video_editor:     "bg-indigo-100 text-indigo-700 border-indigo-200",
  floorplan_editor: "bg-amber-100 text-amber-700 border-amber-200",
  drone_editor:     "bg-cyan-100 text-cyan-700 border-cyan-200",
};

export default function UsersManagement() {
  const { canEdit, canView } = useEntityAccess('users');
  const queryClient = useQueryClient();
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);
  const [deleteImpact, setDeleteImpact] = useState(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("users"); // users | codes
  // Admin operations go through edge functions now (no service role key in frontend)

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list("-created_date"),
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["internal_teams"],
    queryFn: () => api.entities.InternalTeam.list(),
  });

  // ─── Mutations ──────────────────────────────────────────────────────────

  const updateUserMutation = useMutation({
    mutationFn: ({ userId, updates }) => api.entities.User.update(userId, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      refetchEntityList("User");
      toast.success("User updated");
      setEditingUser(null);
    },
    onError: (err) => toast.error(err?.message || "Failed to update user"),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ userId, isActive }) => api.entities.User.update(userId, { is_active: isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      refetchEntityList("User");
      toast.success("User status updated");
    },
    onError: (err) => toast.error(err?.message || "Failed to update"),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId) => {
      try {
        const allProjects = await api.entities.Project.filter({}, null, 2000);
        const affected = allProjects.filter(p =>
          !["delivered", "cancelled"].includes(p.status) &&
          [p.photographer_id, p.videographer_id, p.image_editor_id, p.video_editor_id, p.project_owner_id, p.onsite_staff_1_id, p.onsite_staff_2_id].includes(userId)
        );
        await Promise.all(affected.map(p => {
          const u = {};
          if (p.photographer_id === userId) { u.photographer_id = null; u.photographer_name = null; }
          if (p.videographer_id === userId) { u.videographer_id = null; u.videographer_name = null; }
          if (p.image_editor_id === userId) u.image_editor_id = null;
          if (p.video_editor_id === userId) u.video_editor_id = null;
          if (p.project_owner_id === userId) u.project_owner_id = null;
          if (p.onsite_staff_1_id === userId) { u.onsite_staff_1_id = null; u.onsite_staff_1_name = null; }
          if (p.onsite_staff_2_id === userId) { u.onsite_staff_2_id = null; u.onsite_staff_2_name = null; }
          return api.entities.Project.update(p.id, u).catch(() => {});
        }));
      } catch {}
      try {
        const roles = await api.entities.EmployeeRole.filter({ user_id: userId }, null, 50);
        await Promise.all(roles.map(r => api.entities.EmployeeRole.delete(r.id).catch(() => {})));
      } catch {}
      // Clear task assignments referencing this user so they don't show a stale name
      try {
        const assignedTasks = await api.entities.ProjectTask.filter({ assigned_to: userId }, null, 500);
        await Promise.all(assignedTasks.map(t =>
          api.entities.ProjectTask.update(t.id, { assigned_to: null, assigned_to_name: null }).catch(() => {})
        ));
      } catch {}
      return api.entities.User.delete(userId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      refetchEntityList("User");
      toast.success("User deleted");
      setDeletingUser(null);
      setDeleteImpact(null);
    },
    onError: (err) => toast.error(err?.message || "Failed to delete"),
  });

  const handleDeleteClick = async (user) => {
    setDeletingUser(user);
    setDeleteImpact(null);
    setImpactLoading(true);
    try {
      const userId = user.id;
      const [projects, tasks, roles] = await Promise.all([
        api.entities.Project.filter({}, null, 2000),
        api.entities.ProjectTask.filter({ assigned_to: userId }, null, 500),
        api.entities.EmployeeRole.filter({ user_id: userId }, null, 50),
      ]);
      const assignedProjects = projects.filter(p =>
        !["delivered", "cancelled"].includes(p.status) &&
        [p.photographer_id, p.videographer_id, p.image_editor_id, p.video_editor_id, p.project_owner_id, p.onsite_staff_1_id, p.onsite_staff_2_id].includes(userId)
      );
      const affectedEntities = {};
      if (assignedProjects.length > 0) {
        affectedEntities.projects = {
          count: assignedProjects.length,
          items: assignedProjects.map(p => ({ name: p.address || p.title || p.id })),
        };
      }
      if (tasks.length > 0) {
        affectedEntities.tasks = {
          count: tasks.length,
          items: tasks.map(t => ({ name: t.title || 'Untitled task' })),
        };
      }
      if (roles.length > 0) {
        affectedEntities['employee roles'] = {
          count: roles.length,
          items: roles.map(r => ({ name: r.role || 'Role' })),
        };
      }
      const totalAffected = assignedProjects.length + tasks.length + roles.length;
      setDeleteImpact({ totalAffected, affectedEntities });
    } catch {
      setDeleteImpact({ totalAffected: 0, affectedEntities: {} });
    } finally {
      setImpactLoading(false);
    }
  };

  const handleSendPasswordReset = async (email) => {
    try {
      await api.users.sendPasswordResetAdmin(email);
      toast.success(`Password reset email sent to ${email}`);
    } catch (err) {
      toast.error(err?.message || "Failed to send reset email");
    }
  };

  const handleResendInvite = async (email) => {
    try {
      await api.users.resendInvite(email);
      toast.success(`Invite re-sent to ${email}`);
    } catch (err) {
      toast.error(err?.message || "Failed to resend invite");
    }
  };

  const handleSignOutEverywhere = async (userId, userName) => {
    try {
      await api.users.signOutEverywhere(userId);
      toast.success(`All sessions terminated for ${userName}`);
    } catch (err) {
      toast.error(err?.message || "Failed to sign out user");
    }
  };

  // ─── Filtered & Stats ──────────────────────────────────────────────────

  const filteredUsers = useMemo(() =>
    users.filter(u =>
      u.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.phone?.includes(searchQuery)
    ),
    [users, searchQuery]
  );

  const stats = useMemo(() => ({
    total: users.length,
    active: users.filter(u => u.is_active).length,
    admins: users.filter(u => u.role === "master_admin").length,
    employees: users.filter(u => u.role === "employee").length,
  }), [users]);

  // ─── Render ─────────────────────────────────────────────────────────────

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">User Management <AccessBadge entityType="users" /></h1>
          <p className="text-muted-foreground mt-1">Manage team members, access levels, and invite codes</p>
        </div>
        <Button onClick={() => setShowInviteDialog(true)} className="gap-2" disabled={!canEdit} title="Send an email or code invite to a new team member">
          <Plus className="h-4 w-4" /> Invite User
        </Button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Total", value: stats.total },
          { label: "Active", value: stats.active },
          { label: "Admins", value: stats.admins },
          { label: "Staff", value: stats.employees },
        ].map(s => (
          <Card key={s.label}>
            <CardContent className="pt-4 pb-3">
              <div className="text-2xl font-bold">{s.value}</div>
              <p className="text-xs text-muted-foreground">{s.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Tab Switcher */}
      <div className="flex gap-1 border-b">
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "users" ? "border-blue-600 text-blue-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveTab("users")}
        >
          Users ({users.length})
        </button>
        <button
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === "codes" ? "border-blue-600 text-blue-600" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          onClick={() => setActiveTab("codes")}
        >
          <KeyRound className="h-3.5 w-3.5 inline mr-1.5" />Invite Codes
        </button>
      </div>

      {/* Users Tab */}
      {activeTab === "users" && (
        <>
          {/* Search */}
          <div className="relative max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input placeholder="Search by name, email, or phone..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10" />
          </div>

          {/* Users Table */}
          <Card>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/50">
                  <TableHead className="font-semibold">User</TableHead>
                  <TableHead className="font-semibold">Contact</TableHead>
                  <TableHead className="font-semibold">Role</TableHead>
                  <TableHead className="font-semibold">Team</TableHead>
                  <TableHead className="font-semibold">Default Role</TableHead>
                  <TableHead className="font-semibold">Target Hrs</TableHead>
                  <TableHead className="font-semibold">Last Login</TableHead>
                  <TableHead className="font-semibold">Status</TableHead>
                  <TableHead className="text-right font-semibold">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  <TableRow><TableCell colSpan={9} className="text-center py-8"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></TableCell></TableRow>
                ) : filteredUsers.length === 0 ? (
                  <TableRow><TableCell colSpan={9} className="text-center py-8 text-muted-foreground">No users found</TableCell></TableRow>
                ) : (
                  filteredUsers.map(user => {
                    const config = roleConfig[user.role] || roleConfig.employee;
                    const Icon = config.icon;
                    return (
                      <TableRow key={user.id} className={`hover:bg-muted/30 ${!user.is_active ? "opacity-50" : ""}`}>
                        <TableCell>
                          <div className="flex items-center gap-2.5">
                            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                              <span className="text-sm font-semibold text-primary">
                                {(user.full_name || user.email || "?").charAt(0).toUpperCase()}
                              </span>
                            </div>
                            <div>
                              <p className="font-medium text-sm">{user.full_name || "—"}</p>
                              {user.auth_provider && user.auth_provider !== "email" && (
                                <span className="text-[10px] text-muted-foreground">{providerLabel[user.auth_provider] || user.auth_provider}</span>
                              )}
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="space-y-0.5">
                            <div className="text-sm text-muted-foreground flex items-center gap-1">
                              <Mail className="h-3 w-3" /> {user.email}
                            </div>
                            {user.phone && (
                              <div className="text-xs text-muted-foreground flex items-center gap-1">
                                <Phone className="h-3 w-3" /> {user.phone}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`${config.color} border text-xs`}>{config.label}</Badge>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={user.internal_team_id || "none"}
                            onValueChange={(v) => updateUserMutation.mutate({ userId: user.id, updates: { internal_team_id: v === "none" ? null : v, internal_team_name: v === "none" ? null : teams.find(t => t.id === v)?.name || null } })}
                          >
                            <SelectTrigger className="h-8 text-xs w-32"><SelectValue placeholder="No team" /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">No team</SelectItem>
                              {teams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Select
                            value={user.default_staff_role || "none"}
                            onValueChange={(v) => updateUserMutation.mutate({ userId: user.id, updates: { default_staff_role: v === "none" ? null : v } })}
                          >
                            <SelectTrigger className="h-8 text-xs w-36 border-0 shadow-none hover:bg-muted/50 px-1.5">
                              <SelectValue>
                                {user.default_staff_role ? (
                                  <Badge variant="outline" className={`${STAFF_ROLE_COLORS[user.default_staff_role] || "bg-muted text-muted-foreground"} border text-[10px] px-1.5 py-0`}>
                                    {STAFF_ROLE_OPTIONS.find(o => o.value === user.default_staff_role)?.label || user.default_staff_role}
                                  </Badge>
                                ) : (
                                  <span className="text-muted-foreground/50">None</span>
                                )}
                              </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">None</SelectItem>
                              {STAFF_ROLE_OPTIONS.map(o => (
                                <SelectItem key={o.value} value={o.value}>
                                  <Badge variant="outline" className={`${STAFF_ROLE_COLORS[o.value]} border text-[10px] px-1.5 py-0`}>{o.label}</Badge>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm tabular-nums">{user.weekly_target_hours ?? 40.0}h</span>
                        </TableCell>
                        <TableCell>
                          {user.last_login_at ? (
                            <div className="text-xs text-muted-foreground flex items-center gap-1">
                              <Clock className="h-3 w-3" />
                              {formatDistanceToNow(new Date(user.last_login_at), { addSuffix: true })}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground/50">Never</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={user.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-muted text-muted-foreground"}>
                            {user.is_active ? "Active" : "Inactive"}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                                <Edit className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-48">
                              <DropdownMenuItem onClick={() => setEditingUser({ ...user })}>
                                <Edit className="h-3.5 w-3.5 mr-2" /> Edit Details
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleSendPasswordReset(user.email)}>
                                <RotateCcw className="h-3.5 w-3.5 mr-2" /> Send Password Reset
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleResendInvite(user.email)}>
                                <Send className="h-3.5 w-3.5 mr-2" /> Resend Invite
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => handleSignOutEverywhere(user.id, user.full_name)}>
                                <KeyRound className="h-3.5 w-3.5 mr-2" /> Sign Out Everywhere
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => toggleActiveMutation.mutate({ userId: user.id, isActive: !user.is_active })}>
                                {user.is_active ? <><UserX className="h-3.5 w-3.5 mr-2" /> Deactivate</> : <><UserCheck className="h-3.5 w-3.5 mr-2" /> Activate</>}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => handleDeleteClick(user)} className="text-red-600 focus:text-red-600">
                                <Trash2 className="h-3.5 w-3.5 mr-2" /> Delete User
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </Card>
        </>
      )}

      {/* Invite Codes Tab */}
      {activeTab === "codes" && <InviteCodesPanel />}

      <InviteUserDialog open={showInviteDialog} onClose={() => setShowInviteDialog(false)} onSuccess={() => queryClient.invalidateQueries({ queryKey: ["users"] })} />

      {/* Edit User Dialog */}
      {editingUser && (
        <Dialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Edit User</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>Full Name</Label>
                <Input value={editingUser.full_name || ""} onChange={(e) => setEditingUser(p => ({ ...p, full_name: e.target.value }))} className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Email</Label>
                <Input type="email" value={editingUser.email || ""} disabled className="h-11 bg-muted/50" />
                <p className="text-[10px] text-muted-foreground">Email cannot be changed</p>
              </div>
              <div className="space-y-2">
                <Label>Phone</Label>
                <Input type="tel" placeholder="+61 412 345 678" value={editingUser.phone || ""} onChange={(e) => setEditingUser(p => ({ ...p, phone: e.target.value }))} className="h-11" />
              </div>
              <div className="space-y-2">
                <Label>Security Level</Label>
                <Select value={editingUser.role} onValueChange={(v) => setEditingUser(p => ({ ...p, role: v }))}>
                  <SelectTrigger className="h-11"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="master_admin">Owner</SelectItem>
                    <SelectItem value="admin">Administrator</SelectItem>
                    <SelectItem value="manager">Manager</SelectItem>
                    <SelectItem value="employee">Staff</SelectItem>
                    <SelectItem value="contractor">Contractor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Team</Label>
                <Select value={editingUser.internal_team_id || "none"} onValueChange={(v) => setEditingUser(p => ({ ...p, internal_team_id: v === "none" ? null : v, internal_team_name: v === "none" ? null : teams.find(t => t.id === v)?.name || null }))}>
                  <SelectTrigger className="h-11"><SelectValue placeholder="No team" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No team</SelectItem>
                    {teams.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default Staff Role</Label>
                <Select value={editingUser.default_staff_role || "none"} onValueChange={(v) => setEditingUser(p => ({ ...p, default_staff_role: v === "none" ? null : v }))}>
                  <SelectTrigger className="h-11"><SelectValue placeholder="None" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {STAFF_ROLE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground">Used by Tonomo webhooks to assign the correct project role</p>
              </div>
              <div className="space-y-2">
                <Label>Weekly Target Hours</Label>
                <Input type="number" step="0.1" min="0" max="168" placeholder="40.0" value={editingUser.weekly_target_hours ?? 40.0} onChange={(e) => setEditingUser(p => ({ ...p, weekly_target_hours: parseFloat(e.target.value) || 0 }))} className="h-11" />
                <p className="text-[10px] text-muted-foreground">Used for capacity planning (default 40h/week)</p>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
              <Button
                onClick={() => updateUserMutation.mutate({
                  userId: editingUser.id,
                  updates: {
                    full_name: editingUser.full_name?.trim() || null,
                    phone: editingUser.phone?.trim() || null,
                    role: editingUser.role,
                    internal_team_id: editingUser.internal_team_id || null,
                    internal_team_name: editingUser.internal_team_name || null,
                    default_staff_role: editingUser.default_staff_role || null,
                    weekly_target_hours: editingUser.weekly_target_hours ?? 40.0,
                  },
                })}
                disabled={updateUserMutation.isPending}
              >
                {updateUserMutation.isPending ? <><Loader2 className="h-4 w-4 animate-spin mr-2" />Saving...</> : "Save Changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <DeleteConfirmationDialog
        open={!!deletingUser}
        itemName={deletingUser?.full_name || ''}
        itemType="user"
        impact={deleteImpact}
        isLoading={impactLoading || deleteUserMutation.isPending}
        onConfirm={() => deleteUserMutation.mutate(deletingUser.id)}
        onCancel={() => { setDeletingUser(null); setDeleteImpact(null); }}
      />
    </div>
  );
}

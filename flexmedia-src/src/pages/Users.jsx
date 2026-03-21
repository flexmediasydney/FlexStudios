import { useState, useMemo } from "react";
import React from "react";
import { api } from "@/api/supabaseClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, Shield, UserCheck, UserX, Edit, Trash2, MoreVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import InviteUserDialog from "@/components/users/InviteUserDialog";
import { toast } from "sonner";

const roleConfig = {
  master_admin: { 
    label: "Master Admin", 
    color: "bg-red-100 text-red-700 border-red-200",
    icon: Shield 
  },
  employee: { 
    label: "Employee", 
    color: "bg-blue-100 text-blue-700 border-blue-200",
    icon: UserCheck 
  },
  contractor: { 
    label: "Contractor", 
    color: "bg-amber-100 text-amber-700 border-amber-200",
    icon: UserX 
  }
};

export default function UsersManagement() {
  const queryClient = useQueryClient();
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [editingUser, setEditingUser] = useState(null);
  const [deletingUser, setDeletingUser] = useState(null);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list("-created_date")
  });

  const { data: teams = [] } = useQuery({
    queryKey: ["internal_teams"],
    queryFn: () => api.entities.InternalTeam.list()
  });

  const updateRoleMutation = useMutation({
    mutationFn: ({ userId, role }) => api.entities.User.update(userId, { role }),
    onSuccess: () => {
      queryClient.invalidateQueries(["users"]);
      toast.success("User role updated");
      setEditingUser(null);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to update user");
    }
  });

  const updateTeamMutation = useMutation({
    mutationFn: ({ userId, teamId }) => {
      const team = teams.find(t => t.id === teamId);
      return api.entities.User.update(userId, { 
        internal_team_id: teamId,
        internal_team_name: team?.name || ""
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries(["users"]);
      toast.success("Team assignment updated");
    },
    onError: (err) => toast.error(err?.message || 'Failed to update team assignment'),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ userId, isActive }) => 
      api.entities.User.update(userId, { is_active: isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries(["users"]);
      toast.success("User status updated");
    },
    onError: (err) => toast.error(err?.message || 'Failed to update user status'),
  });

  const deleteUserMutation = useMutation({
    mutationFn: async (userId) => {
      // Clean up role references on open projects
      try {
        const allProjects = await api.entities.Project.filter({}, null, 2000);
        const affectedProjects = allProjects.filter(p =>
          !['delivered', 'cancelled'].includes(p.status) && (
            p.photographer_id === userId ||
            p.videographer_id === userId ||
            p.image_editor_id === userId ||
            p.video_editor_id === userId ||
            p.project_owner_id === userId ||
            p.onsite_staff_1_id === userId ||
            p.onsite_staff_2_id === userId
          )
        );
        const failedProjects = [];
        await Promise.all(affectedProjects.map(p => {
          const updates = {};
          if (p.photographer_id === userId) { updates.photographer_id = null; updates.photographer_name = null; }
          if (p.videographer_id === userId) { updates.videographer_id = null; updates.videographer_name = null; }
          if (p.image_editor_id === userId) updates.image_editor_id = null;
          if (p.video_editor_id === userId) updates.video_editor_id = null;
          if (p.project_owner_id === userId) updates.project_owner_id = null;
          if (p.onsite_staff_1_id === userId) { updates.onsite_staff_1_id = null; updates.onsite_staff_1_name = null; }
          if (p.onsite_staff_2_id === userId) { updates.onsite_staff_2_id = null; updates.onsite_staff_2_name = null; }
          return api.entities.Project.update(p.id, updates).catch(() => {
            failedProjects.push(p.title || p.property_address || p.id);
          });
        }));
        if (failedProjects.length > 0) {
          toast.warning(`${failedProjects.length} project(s) couldn't be updated — check manually: ${failedProjects.slice(0, 3).join(', ')}${failedProjects.length > 3 ? '...' : ''}`);
        }
      } catch { /* non-fatal — proceed with delete */ }

      // Remove EmployeeRole records for this user
       try {
         const roles = await api.entities.EmployeeRole.filter(
           { user_id: userId }, null, 50
         );
         await Promise.all(roles.map(r =>
           api.entities.EmployeeRole.delete(r.id).catch(() => {})
         ));
       } catch { /* non-fatal */ }

       // Clean up user-personal entities
       try {
         const deletingUserRecord = users.find(u => u.id === userId);
         const [availability, connections, signatures, prefs] = await Promise.all([
           api.entities.PhotographerAvailability.filter({ user_id: userId }, null, 20).catch(() => []),
           deletingUserRecord?.email
             ? api.entities.CalendarConnection.filter({ created_by: deletingUserRecord.email }, null, 10).catch(() => [])
             : Promise.resolve([]),
           api.entities.UserSignature.filter({ user_id: userId }, null, 5).catch(() => []),
           api.entities.NotificationPreference.filter({ user_id: userId }, null, 50).catch(() => []),
         ]);
         await Promise.all([
           ...availability.map(a => api.entities.PhotographerAvailability.delete(a.id).catch(() => {})),
           ...connections.map(c => api.entities.CalendarConnection.delete(c.id).catch(() => {})),
           ...signatures.map(s => api.entities.UserSignature.delete(s.id).catch(() => {})),
           ...prefs.map(p => api.entities.NotificationPreference.delete(p.id).catch(() => {})),
         ]);
       } catch { /* non-fatal */ }

       return api.entities.User.delete(userId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries(["users"]);
      toast.success("User deleted");
      setDeletingUser(null);
    },
    onError: (error) => {
      toast.error(error.message || "Failed to delete user");
    }
  });

  const filteredUsers = useMemo(() => 
    users.filter(user =>
      user.full_name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      user.email?.toLowerCase().includes(searchQuery.toLowerCase())
    ),
    [users, searchQuery]
  );

  const stats = useMemo(() => ({
    total: users.length,
    active: users.filter(u => u.is_active).length,
    admins: users.filter(u => u.role === 'master_admin').length,
    employees: users.filter(u => u.role === 'employee').length,
  }), [users]);

  return (
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
            <p className="text-muted-foreground mt-1">
              Manage team members and their access levels
            </p>
          </div>
          <Button onClick={() => setShowInviteDialog(true)} className="gap-2">
            <Plus className="h-4 w-4" />
            Invite User
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{stats.total}</div>
              <p className="text-xs text-muted-foreground">Total Users</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{stats.active}</div>
              <p className="text-xs text-muted-foreground">Active</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{stats.admins}</div>
              <p className="text-xs text-muted-foreground">Admins</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4">
              <div className="text-2xl font-bold">{stats.employees}</div>
              <p className="text-xs text-muted-foreground">Employees</p>
            </CardContent>
          </Card>
        </div>

        {/* Search */}
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Users Table */}
        <Card>
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="font-semibold">Name</TableHead>
                <TableHead className="font-semibold">Email</TableHead>
                <TableHead className="font-semibold">Role</TableHead>
                <TableHead className="font-semibold">Team</TableHead>
                <TableHead className="font-semibold">Status</TableHead>
                <TableHead className="text-right font-semibold">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan="6" className="text-center py-6 text-muted-foreground">
                    No users found
                  </TableCell>
                </TableRow>
              ) : (
                filteredUsers.map(user => {
                  const config = roleConfig[user.role] || roleConfig.employee;
                  const Icon = config.icon;
                  return (
                    <TableRow key={user.id} className="hover:bg-muted/30">
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                            <Icon className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium text-sm">{user.full_name}</p>
                            {user.title && <p className="text-xs text-muted-foreground">{user.title}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{user.email}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className={`${config.color} border text-xs`}>
                          {config.label}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Select 
                          value={user.internal_team_id || "none"}
                          onValueChange={(value) => updateTeamMutation.mutate({ 
                            userId: user.id, 
                            teamId: value === "none" ? null : value 
                          })}
                        >
                          <SelectTrigger className="h-8 text-xs w-32">
                            <SelectValue placeholder="No team" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No team</SelectItem>
                            {teams.map(team => (
                              <SelectItem key={team.id} value={team.id}>
                                {team.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <Badge 
                          variant="outline"
                          className={user.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-700"}
                        >
                          {user.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setEditingUser(user)}
                            title="Change role"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => 
                              toggleActiveMutation.mutate({ 
                                userId: user.id, 
                                isActive: !user.is_active 
                              })
                            }
                            title={user.is_active ? "Deactivate" : "Activate"}
                          >
                            {user.is_active ? <UserCheck className="h-4 w-4" /> : <UserX className="h-4 w-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setDeletingUser(user)}
                            className="text-destructive hover:text-destructive hover:bg-destructive/10"
                            title="Delete user"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>

        <InviteUserDialog
          open={showInviteDialog}
          onClose={() => setShowInviteDialog(false)}
          onSuccess={() => queryClient.invalidateQueries(["users"])}
        />

        {/* Edit Role Dialog */}
        {editingUser && (
          <AlertDialog open={!!editingUser} onOpenChange={() => setEditingUser(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Change User Role</AlertDialogTitle>
                <AlertDialogDescription>
                  Update role for {editingUser.full_name}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="py-4">
                <Select 
                  defaultValue={editingUser.role}
                  onValueChange={(role) => {
                    updateRoleMutation.mutate({ userId: editingUser.id, role });
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="master_admin">Master Admin</SelectItem>
                    <SelectItem value="employee">Employee</SelectItem>
                    <SelectItem value="contractor">Contractor</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}

        {/* Delete Confirmation */}
        {deletingUser && (
          <AlertDialog open={!!deletingUser} onOpenChange={() => setDeletingUser(null)}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete User?</AlertDialogTitle>
                <AlertDialogDescription>
                  This will permanently delete {deletingUser.full_name}'s account. This action cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction 
                  onClick={() => deleteUserMutation.mutate(deletingUser.id)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
  );
}
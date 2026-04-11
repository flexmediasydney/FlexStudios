import { useState, useMemo } from "react";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Edit, Trash2, Users, Search, Star } from "lucide-react";
import { useTeamRoleAssignments } from "@/components/hooks/useTeamRoleAssignments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import DeleteConfirmationDialog from "@/components/common/DeleteConfirmationDialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";

export default function InternalTeamsManagement() {
  const { canEdit, canView } = useEntityAccess('internal_teams');
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingTeam, setEditingTeam] = useState(null);
  const [deletingTeam, setDeletingTeam] = useState(null);
  const [teamDeleteImpact, setTeamDeleteImpact] = useState(null);
  const [teamImpactLoading, setTeamImpactLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: "",
    description: "",
    color: "#3b82f6",
    team_function: "",
    is_active: true
  });
  const [searchQuery, setSearchQuery] = useState("");
  const { rolesByTeam } = useTeamRoleAssignments();

  const { data: teams = [] } = useQuery({
    queryKey: ["internal_teams"],
    queryFn: () => api.entities.InternalTeam.list("-created_date")
  });

  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list()
  });

  const saveMutation = useMutation({
    mutationFn: (data) => {
      // Normalize empty strings to null for optional fields
      const cleaned = { ...data };
      if (cleaned.team_function === '') cleaned.team_function = null;
      if (cleaned.description === '') cleaned.description = null;

      if (editingTeam) {
        return api.entities.InternalTeam.update(editingTeam.id, cleaned);
      }
      return api.entities.InternalTeam.create(cleaned);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["internal_teams"] });
      refetchEntityList("InternalTeam");
      toast.success(editingTeam ? "Team updated" : "Team created");
      handleClose();
    },
    onError: (err) => {
      console.error('Team save failed:', err);
      toast.error(err?.message || 'Failed to save team');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id) => api.entities.InternalTeam.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["internal_teams"] });
      refetchEntityList("InternalTeam");
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success("Team deleted");
      setDeletingTeam(null);
    },
    onError: (err) => {
      console.error('Team delete failed:', err);
      toast.error(err?.message || 'Failed to delete team');
    },
  });

  const handleTeamDeleteClick = async (team) => {
    setDeletingTeam(team);
    setTeamDeleteImpact(null);
    setTeamImpactLoading(true);
    try {
      const members = (users || []).filter(u => u.internal_team_id === team.id);
      const affectedEntities = {};
      if (members.length > 0) {
        affectedEntities.members = {
          count: members.length,
          items: members.map(m => ({ name: m.full_name || m.email || 'Unknown' })),
        };
      }
      setTeamDeleteImpact({ totalAffected: members.length, affectedEntities });
    } catch {
      setTeamDeleteImpact({ totalAffected: 0, affectedEntities: {} });
    } finally {
      setTeamImpactLoading(false);
    }
  };

  const handleOpen = (team = null) => {
    if (team) {
      setEditingTeam(team);
      setFormData({
        name: team.name,
        description: team.description || "",
        color: team.color || "#3b82f6",
        team_function: team.team_function || "",
        is_active: team.is_active !== false
      });
    } else {
      setEditingTeam(null);
      setFormData({
        name: "",
        description: "",
        color: "#3b82f6",
        team_function: "",
        is_active: true
      });
    }
    setShowDialog(true);
  };

  const handleClose = () => {
    setShowDialog(false);
    setEditingTeam(null);
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!formData.name?.trim()) {
      toast.error("Team name is required");
      return;
    }
    if (formData.name.trim().length > 120) {
      toast.error("Team name must be 120 characters or less");
      return;
    }
    // Check duplicate names
    const duplicate = teams.find(t => t.id !== editingTeam?.id && t.name?.toLowerCase().trim() === formData.name.toLowerCase().trim());
    if (duplicate) {
      toast.error(`A team named "${duplicate.name}" already exists`);
      return;
    }
    saveMutation.mutate({ ...formData, name: formData.name.trim() });
  };

  const teamMembersMap = useMemo(() => {
    const map = new Map();
    for (const u of users) {
      if (u.internal_team_id) {
        if (!map.has(u.internal_team_id)) map.set(u.internal_team_id, []);
        map.get(u.internal_team_id).push(u);
      }
    }
    return map;
  }, [users]);

  const getTeamMembers = (teamId) => teamMembersMap.get(teamId) || [];

  const filteredTeams = useMemo(() =>
    teams.filter(t =>
      t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.description?.toLowerCase().includes(searchQuery.toLowerCase())
    ),
    [teams, searchQuery]
  );

  const stats = useMemo(() => ({
    total: teams.length,
    active: teams.filter(t => t.is_active !== false).length,
    totalMembers: users.filter(u => u.internal_team_id).length,
  }), [teams, users]);

  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold">Internal Teams <AccessBadge entityType="internal_teams" /></h2>
          <p className="text-muted-foreground">Manage your internal teams and members</p>
        </div>
        <Button onClick={() => handleOpen()} className="gap-2" disabled={!canEdit}>
          <Plus className="h-4 w-4" />
          Add Team
        </Button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { value: stats.total, label: "Total Teams" },
          { value: stats.active, label: "Active" },
          { value: stats.totalMembers, label: "Members" },
        ].map(({ value, label }) => (
          <Card key={label}>
            <CardContent className="py-3 px-4">
              <div className="text-xl font-bold">{value}</div>
              <p className="text-xs text-muted-foreground">{label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search teams..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Teams Table */}
      <Card>
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/50">
              <TableHead className="font-semibold">Team Name</TableHead>
              <TableHead className="font-semibold">Description</TableHead>
              <TableHead className="font-semibold">Roles</TableHead>
              <TableHead className="font-semibold">Members</TableHead>
              <TableHead className="font-semibold">Status</TableHead>
              <TableHead className="text-right font-semibold">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredTeams.length === 0 ? (
              <TableRow>
                <TableCell colSpan="6" className="text-center py-12">
                  <div className="flex flex-col items-center gap-2">
                    <Users className="h-8 w-8 text-muted-foreground/40" />
                    <p className="text-sm text-muted-foreground">
                      {searchQuery ? "No teams match your search." : "No teams created yet."}
                    </p>
                    {!searchQuery && canEdit && (
                      <Button variant="outline" size="sm" onClick={() => handleOpen()} className="mt-1 gap-1.5">
                        <Plus className="h-3.5 w-3.5" />
                        Create your first team
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              filteredTeams.map(team => {
                const members = getTeamMembers(team.id);
                return (
                  <TableRow key={team.id} className="hover:bg-muted/30">
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div 
                          className="w-3 h-3 rounded-full flex-shrink-0" 
                          style={{ backgroundColor: team.color }}
                        />
                        <span className="font-medium">{team.name}</span>
                        {members.length > 0 && (
                          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 font-normal">
                            {members.length} {members.length === 1 ? 'member' : 'members'}
                          </Badge>
                        )}
                        {team.team_function && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            team.team_function === 'onsite'     ? 'bg-blue-100 text-blue-700' :
                            team.team_function === 'editing'    ? 'bg-purple-100 text-purple-700' :
                            team.team_function === 'management' ? 'bg-amber-100 text-amber-700' :
                            'bg-muted text-muted-foreground'
                          }`}>
                            {team.team_function === 'onsite'     ? '📷 Onsite' :
                             team.team_function === 'editing'    ? '🖼 Editing' :
                             team.team_function === 'management' ? '👑 Management' :
                             '⚙ Mixed'}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground max-w-xs truncate">
                      {team.description || "—"}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(rolesByTeam[team.id] || []).map(a => (
                          <span
                            key={a.role}
                            className="inline-flex items-center gap-0.5 text-[11px] px-1.5 py-0.5 rounded-full font-medium bg-muted text-muted-foreground"
                          >
                            {(a.role || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                            {a.is_primary_fallback && <Star className="h-2.5 w-2.5 text-amber-500 fill-amber-500" />}
                          </span>
                        ))}
                        {!(rolesByTeam[team.id]?.length) && (
                          <span className="text-xs text-muted-foreground italic">None</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm font-medium">{members.length}</span>
                        {members.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            ({members.slice(0, 2).map(m => (m.full_name || m.email || '?').split(' ')[0]).join(", ")}{members.length > 2 ? "..." : ""})
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge 
                        variant="outline"
                        className={team.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100 text-gray-700"}
                      >
                        {team.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => handleOpen(team)} title="Edit team" disabled={!canEdit} className="gap-1">
                          <Edit className="h-3.5 w-3.5" />
                          <span className="text-xs">Edit</span>
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTeamDeleteClick(team)}
                          className="text-destructive hover:text-destructive hover:bg-destructive/10 gap-1"
                          title="Delete team"
                          disabled={!canEdit}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          <span className="text-xs">Delete</span>
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

      <Dialog open={showDialog} onOpenChange={handleClose}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingTeam ? "Edit Team" : "New Team"}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="name">Team Name *</Label>
              <Input
                id="name"
                value={formData.name}
                onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Team Function</Label>
              <select
                value={formData.team_function || ''}
                onChange={e => setFormData(prev => ({ ...prev, team_function: e.target.value }))}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-background"
              >
                <option value="">Not specified</option>
                <option value="onsite">Onsite — Photographers &amp; Videographers</option>
                <option value="editing">Editing — Photo, Video, Floor Plan, Drone editors</option>
                <option value="management">Management — Project owners, coordinators</option>
                <option value="mixed">Mixed — Multiple functions</option>
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Used to auto-suggest this team in Fallback Role Assignments.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="color">Team Color</Label>
              <div className="flex gap-2">
                <Input
                  id="color"
                  type="color"
                  value={formData.color}
                  onChange={(e) => setFormData(prev => ({ ...prev, color: e.target.value }))}
                  className="w-20 h-10"
                />
                <Input
                  type="text"
                  value={formData.color}
                  onChange={(e) => setFormData(prev => ({ ...prev, color: e.target.value }))}
                  placeholder="#3b82f6"
                  className="flex-1"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="is_active"
                checked={formData.is_active}
                onChange={(e) => setFormData(prev => ({ ...prev, is_active: e.target.checked }))}
                className="h-4 w-4 accent-primary"
              />
              <Label htmlFor="is_active">Active</Label>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={handleClose} disabled={saveMutation.isPending}>Cancel</Button>
              <Button type="submit" disabled={saveMutation.isPending}>
                {saveMutation.isPending ? "Saving..." : editingTeam ? "Update" : "Create"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <DeleteConfirmationDialog
        open={!!deletingTeam}
        itemName={deletingTeam?.name || ''}
        itemType="team"
        impact={teamDeleteImpact}
        isLoading={teamImpactLoading || deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deletingTeam.id)}
        onCancel={() => { setDeletingTeam(null); setTeamDeleteImpact(null); }}
      />
    </div>
  );
}
import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useQuery } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { createNotification } from "@/components/notifications/createNotification";

export default function AssignUsersDialog({ project, open, onClose, onSave }) {
  const [selectedUsers, setSelectedUsers] = useState([]);
  const [selectedTeams, setSelectedTeams] = useState([]);
  const [saving, setSaving] = useState(false);

  const { data: users = [] } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.entities.User.list()
  });

  const { data: internalTeams = [] } = useEntityList("InternalTeam");

  const allUsers = users.filter(u => u.is_active !== false);
  const activeTeams = internalTeams.filter(t => t.is_active !== false);

  useEffect(() => {
    if (project && open) {
      setSelectedUsers(Array.isArray(project.assigned_users) ? project.assigned_users : []);
      setSelectedTeams(Array.isArray(project.assigned_teams) ? project.assigned_teams : []);
    }
  }, [project, open]);

  const handleToggleUser = (userId) => {
    setSelectedUsers(prev => 
      prev.includes(userId)
        ? prev.filter(id => id !== userId)
        : [...prev, userId]
    );
  };

  const handleToggleTeam = (teamId) => {
    setSelectedTeams(prev =>
      prev.includes(teamId)
        ? prev.filter(id => id !== teamId)
        : [...prev, teamId]
    );
  };

  const handleSave = async () => {
    if (!project?.id) return;
    setSaving(true);
    try {
      const previousUsers = Array.isArray(project.assigned_users) ? project.assigned_users : [];
      await api.entities.Project.update(project.id, {
        assigned_users: selectedUsers,
        assigned_teams: selectedTeams
      });

      // Notify users who are newly added (weren't in the previous list)
      const newlyAdded = selectedUsers.filter(id => !previousUsers.includes(id));
      if (newlyAdded.length > 0) {
        const currentUser = await api.auth.me().catch(() => null);
        newlyAdded.forEach(userId => {
          createNotification({
            userId,
            type: 'project_assigned_to_you',
            title: `You've been assigned to a project`,
            message: `${project.title || project.property_address} — you have been added as a contributor`,
            projectId: project.id,
            projectName: project.title || project.property_address,
            entityType: 'project',
            entityId: project.id,
            ctaUrl: 'ProjectDetails',
            ctaParams: { id: project.id },
            sourceUserId: currentUser?.id,
            idempotencyKey: `assigned:${project.id}:${userId}`,
          }).catch(() => { /* non-critical */ });
        });
      }

      onSave();
    } catch (err) {
      console.error('Failed to save assignments:', err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign Users</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 max-h-96 overflow-y-auto">
           {/* Users Section */}
           <div>
             <h3 className="font-semibold text-sm mb-3">Users</h3>
             {allUsers.length === 0 ? (
               <p className="text-muted-foreground text-sm text-center py-4">
                 No users available
               </p>
             ) : (
               <div className="space-y-2">
                 {allUsers.map(user => (
                   <div key={user.id} className="flex items-center justify-between p-3 border rounded-lg">
                     <div className="flex items-center gap-3">
                       <Checkbox
                         checked={selectedUsers.includes(user.id)}
                         onCheckedChange={() => handleToggleUser(user.id)}
                       />
                       <div>
                         <p className="font-medium text-sm">{user.full_name}</p>
                         <p className="text-xs text-muted-foreground">{user.email}</p>
                       </div>
                     </div>
                     {selectedUsers.includes(user.id) && (
                       <Badge variant="secondary" className="bg-green-100 text-green-700">
                         Assigned
                       </Badge>
                     )}
                   </div>
                 ))}
               </div>
             )}
           </div>

           {/* Internal Teams Section */}
           <div>
             <h3 className="font-semibold text-sm mb-3">Internal Teams</h3>
             {activeTeams.length === 0 ? (
               <p className="text-muted-foreground text-sm text-center py-4">
                 No internal teams available
               </p>
             ) : (
               <div className="space-y-2">
                 {activeTeams.map(team => (
                   <div key={team.id} className="flex items-center justify-between p-3 border rounded-lg">
                     <div className="flex items-center gap-3">
                       <Checkbox
                         checked={selectedTeams.includes(team.id)}
                         onCheckedChange={() => handleToggleTeam(team.id)}
                       />
                       <div>
                         <p className="font-medium text-sm">{team.name}</p>
                         {team.description && (
                           <p className="text-xs text-muted-foreground">{team.description}</p>
                         )}
                       </div>
                     </div>
                     {selectedTeams.includes(team.id) && (
                       <Badge variant="secondary" className="bg-blue-100 text-blue-700">
                         Assigned
                       </Badge>
                     )}
                   </div>
                 ))}
               </div>
             )}
           </div>
         </div>
        
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Assignments
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
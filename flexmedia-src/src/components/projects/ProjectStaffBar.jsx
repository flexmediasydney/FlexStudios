import React, { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEntityList, useEntityData } from "@/components/hooks/useEntityData";
import { User, Users, ChevronDown, ChevronRight, AlertCircle, Camera, Video, ImageIcon, Film, PenTool, Compass, Crown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { createNotification } from "@/components/notifications/createNotification";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRoleMappings, projectHasCategoryFromMappings, isRoleRequiredForProject } from "@/components/hooks/useRoleMappings";
import { invalidateProjectCaches } from "@/lib/invalidateProjectCaches";

const ROLE_ICONS = {
  project_owner: Crown,
  photographer: Camera,
  videographer: Video,
  image_editor: ImageIcon,
  video_editor: Film,
  floorplan_editor: PenTool,
  drone_editor: Compass,
};

const ROLE_COLORS = {
  project_owner: { bg: "bg-purple-100 dark:bg-purple-900/40", text: "text-purple-700 dark:text-purple-300", badge: "bg-purple-500" },
  photographer: { bg: "bg-blue-100 dark:bg-blue-900/40", text: "text-blue-700 dark:text-blue-300", badge: "bg-blue-500" },
  videographer: { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-300", badge: "bg-rose-500" },
  image_editor: { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-300", badge: "bg-emerald-500" },
  video_editor: { bg: "bg-orange-100 dark:bg-orange-900/40", text: "text-orange-700 dark:text-orange-300", badge: "bg-orange-500" },
  floorplan_editor: { bg: "bg-cyan-100 dark:bg-cyan-900/40", text: "text-cyan-700 dark:text-cyan-300", badge: "bg-cyan-500" },
  drone_editor: { bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-700 dark:text-indigo-300", badge: "bg-indigo-500" },
};

function getInitials(name) {
  if (!name) return "?";
  return name.split(" ").filter(Boolean).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?";
}

// Re-export from the shared hook for backward compatibility
export function projectHasCategory(project, allProducts, allPackages, categories) {
  return projectHasCategoryFromMappings(project, allProducts, allPackages, categories);
}

export const STAFF_ROLES_CONFIG = [
  { key: "project_owner", label: "Project Owner", requiredCategories: null },
  { key: "photographer",   label: "Photographer", legacyKey: "onsite_staff_1", requiredCategories: ["photography", "drone", "virtual_staging"] },
  { key: "videographer",   label: "Videographer",  legacyKey: "onsite_staff_2", requiredCategories: ["video"] },
  { key: "image_editor", label: "Image Editor", requiredCategories: ["photography", "drone", "virtual_staging"] },
  { key: "video_editor", label: "Video Editor", requiredCategories: ["video"] },
  { key: "floorplan_editor", label: "Floorplan Editor", requiredCategories: ["floorplan", "editing"] },
  { key: "drone_editor", label: "Drone Editor", requiredCategories: ["drone"] },
];

export function isRoleRequired(role, project, allProducts, allPackages) {
  // Backward-compat shim for STAFF_ROLES_CONFIG shape
  const mapping = { ...role, categories: role.requiredCategories, always_required: !role.requiredCategories };
  return isRoleRequiredForProject(mapping, project, allProducts, allPackages);
}


/**
 * NotRequiredBadge — static, non-editable pill for roles set to "not_required"
 */
function NotRequiredBadge({ roleKey, label }) {
  const RoleIcon = ROLE_ICONS[roleKey] || User;
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs bg-muted/50 text-muted-foreground border border-transparent cursor-default select-none">
            <RoleIcon className="h-3 w-3 opacity-50" />
            <span className="font-medium opacity-70">{label}</span>
            <span className="text-[10px] italic opacity-50">N/R</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{label}: Not required</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}


function StaffSelector({ roleKey, legacyKey, label, project, canEdit, disabled, disabledLabel, users, teams, isSaving }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const idKey = `${roleKey}_id`;
  const nameKey = `${roleKey}_name`;
  const typeKey = `${roleKey}_type`;

  const currentId = project?.[idKey] || (legacyKey ? project?.[`${legacyKey}_id`] : null);
  const currentName = project?.[nameKey] || (legacyKey ? project?.[`${legacyKey}_name`] : null);
  const currentType = project?.[typeKey];

  const mutation = useMutation({
    mutationFn: async (data) => {
      const result = await api.entities.Project.update(project.id, data);
      // Notify newly assigned staff
      try {
        const currentUser = await api.auth.me().catch(() => null);
        const projectName = project.title || project.property_address || 'Project';
        const roleFields = ['photographer_id', 'onsite_staff_1_id', 'onsite_staff_2_id', 'image_editor_id', 'video_editor_id', 'project_owner_id'];
        for (const field of roleFields) {
          if (data[field] && data[field] !== project[field] && data[field] !== 'not_required' && data[field] !== currentUser?.id) {
            const roleName = field.replace('_id', '').replace(/_/g, ' ');
            const notifType = field === 'photographer_id' || field === 'onsite_staff_1_id'
              ? 'photographer_assigned'
              : field === 'project_owner_id' ? 'project_owner_assigned' : 'project_assigned_to_you';
            createNotification({
              userId: data[field],
              type: notifType,
              title: `Assigned as ${roleName}: ${projectName}`,
              message: `You have been assigned as ${roleName} on ${projectName}.`,
              projectId: project.id, projectName,
              entityType: 'project', entityId: project.id,
              ctaUrl: 'ProjectDetails', ctaParams: { id: project.id },
              sourceUserId: currentUser?.id,
              idempotencyKey: `role_assign:${project.id}:${field}:${data[field]}`,
            }).catch(() => {});
          }
        }
      } catch { /* non-critical */ }
      return result;
    },
    onSuccess: (_, data) => {
      setOpen(false);
      toast.success("Staff assignment updated");

      // Resync onsite tasks when photographer or videographer changes
      const onsiteRoleFields = ['photographer_id', 'onsite_staff_1_id', 'videographer_id', 'onsite_staff_2_id'];
      const isOnsiteRoleChange = onsiteRoleFields.some(f => data[f] !== undefined);
      if (isOnsiteRoleChange && project?.id) {
        api.functions.invoke('syncOnsiteEffortTasks', { project_id: project.id }).catch(() => {});
      }

      // Re-assign tasks for ALL roles. Optimistically patch the scoped task
      // cache so TaskManagement reflects the new assignee immediately, then
      // run server-side updates and invalidate to reconcile.
      if (project?.id && data) {
        const allRoleFields = ['photographer_id', 'videographer_id', 'image_editor_id', 'video_editor_id', 'floorplan_editor_id', 'drone_editor_id', 'project_owner_id'];
        const updatePromises = [];

        for (const field of allRoleFields) {
          if (field in data) {
            const roleName = field.replace('_id', '');
            const newId = data[field] || null;
            const newName = data[field.replace('_id', '_name')] || null;
            const newType = data[field.replace('_id', '_type')] || 'user';

            // Optimistic patch: scoped task cache (the key TaskManagement reads)
            queryClient.setQueriesData(
              { queryKey: ['project-tasks-scoped', project.id] },
              (prev) => {
                if (!Array.isArray(prev)) return prev;
                return prev.map(t => {
                  if (t.auto_assign_role !== roleName || t.is_deleted) return t;
                  return newType === 'team'
                    ? { ...t, assigned_to: null, assigned_to_name: null, assigned_to_team_id: newId, assigned_to_team_name: newName }
                    : { ...t, assigned_to: newId, assigned_to_name: newName, assigned_to_team_id: null, assigned_to_team_name: null };
                });
              }
            );

            const p = api.entities.ProjectTask.filter({ project_id: project.id }, null, 200).then(tasks => {
              const matching = tasks.filter(t => t.auto_assign_role === roleName && !t.is_deleted);
              return Promise.allSettled(matching.map(t => {
                const updates = newType === 'team'
                  ? { assigned_to: null, assigned_to_name: null, assigned_to_team_id: newId, assigned_to_team_name: newName }
                  : { assigned_to: newId, assigned_to_name: newName, assigned_to_team_id: null, assigned_to_team_name: null };
                return api.entities.ProjectTask.update(t.id, updates);
              }));
            }).catch(() => {});
            updatePromises.push(p);
          }
        }

        // After all server-side reassignments settle, reconcile both scoped
        // and legacy task caches plus the project entity cache.
        Promise.allSettled(updatePromises).then(() => {
          invalidateProjectCaches(queryClient, { tasks: true, project: true });
        });
      } else {
        invalidateProjectCaches(queryClient, { project: true });
      }
    },
    onError: (err) => toast.error(err?.message || "Failed to update staff assignment"),
  });

  const select = (id, name, type) => {
    mutation.mutate({
      [idKey]: id,
      [nameKey]: name,
      [typeKey]: type,
    });
  };

  const isNotRequired = currentId === "not_required";
  const isSet = !!currentId && !isNotRequired;
  const isLoading = mutation.isPending || isSaving;

  const RoleIcon = ROLE_ICONS[roleKey] || User;
  const roleColor = ROLE_COLORS[roleKey] || { bg: "bg-muted", text: "text-muted-foreground", badge: "bg-muted-foreground" };

  // If the role is disabled (not needed for this project's products), show static pill
  if (disabled) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border text-sm bg-muted/40 border-border text-muted-foreground cursor-default opacity-60">
              <div className="relative">
                <Avatar className="h-8 w-8">
                  <AvatarFallback className="bg-muted text-muted-foreground text-xs">
                    <RoleIcon className="h-3.5 w-3.5" />
                  </AvatarFallback>
                </Avatar>
              </div>
              <div className="text-left">
                <p className="text-[10px] text-muted-foreground leading-none mb-0.5 uppercase tracking-wider font-medium">{label}</p>
                <p className="leading-none text-xs italic">{disabledLabel || "Not required"}</p>
              </div>
            </div>
          </TooltipTrigger>
          <TooltipContent>{label}: Not required for this project</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // If the role value is explicitly "not_required", render as a subtle badge (not editable field)
  if (isNotRequired && !canEdit) {
    return <NotRequiredBadge roleKey={roleKey} label={label} />;
  }

  return (
     <Popover open={open && canEdit} onOpenChange={(v) => canEdit && setOpen(v)}>
       <PopoverTrigger asChild>
         <button
           disabled={!canEdit || isLoading}
           className={cn(
             "relative flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium transition-all w-full",
             isSet
               ? "bg-card border-border text-foreground hover:border-primary/50"
               : isNotRequired
               ? "bg-muted/30 border-border text-muted-foreground"
               : "bg-amber-50 border-amber-300 text-amber-700 dark:bg-amber-950/30 dark:border-amber-800 dark:text-amber-300 hover:border-amber-400 dark:hover:border-amber-700",
             !canEdit && "cursor-default opacity-80",
             isLoading && "opacity-70 pointer-events-none"
           )}
           title={canEdit ? `Click to assign ${label}` : label}
         >
          {isLoading && (
            <div className="absolute inset-0 flex items-center justify-center rounded-md bg-background/60 z-10">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
            </div>
          )}
          <div className="relative flex-shrink-0">
            <Avatar className={cn("h-5 w-5", isSet ? "" : "opacity-60")}>
              <AvatarFallback className={cn(
                "text-[9px] font-semibold",
                isSet ? roleColor.bg + " " + roleColor.text : "bg-muted text-muted-foreground"
              )}>
                {isSet ? (
                  currentType === "team" ? <Users className="h-2.5 w-2.5" /> : getInitials(currentName)
                ) : isNotRequired ? (
                  <RoleIcon className="h-2.5 w-2.5" />
                ) : (
                  <AlertCircle className="h-2.5 w-2.5 text-amber-500" />
                )}
              </AvatarFallback>
            </Avatar>
          </div>
          <div className="text-left min-w-0 flex-1">
            <span className="text-[10px] text-muted-foreground mr-1">{label}:</span>
            <span className={cn(
              "text-xs truncate",
              isSet ? "font-medium" : isNotRequired ? "text-muted-foreground italic" : "text-amber-600 dark:text-amber-400 italic"
            )}>
              {isSet ? currentName : isNotRequired ? "N/R" : "Unassigned"}
            </span>
            {isSet && currentType === "team" && (
              <span className="ml-1 text-[8px] px-1 rounded bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300 font-semibold">TEAM</span>
            )}
          </div>
          {canEdit && !isLoading && <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-1 max-h-72 overflow-y-auto">
          {currentId && !isNotRequired && (
            <button
              className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded-md transition-colors focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:outline-none"
              onClick={() => select(null, null, null)}
            >
              Clear assignment
            </button>
          )}
          <button
            className={cn(
              "w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted flex items-center gap-2 text-muted-foreground italic",
              isNotRequired && "bg-primary/10 text-primary font-medium not-italic"
            )}
            onClick={() => select("not_required", "Not required", null)}
          >
            Not required
          </button>
          {users.length > 0 && (
            <>
              <p className="text-xs font-semibold text-muted-foreground px-3 pt-1">Staff</p>
              {users.map((u) => (
                <button
                  key={u.id}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted flex items-center gap-2 transition-colors",
                    currentId === u.id && "bg-primary/10 text-primary font-medium"
                  )}
                  onClick={() => select(u.id, u.full_name, "user")}
                >
                  <Avatar className="h-5 w-5 flex-shrink-0">
                    <AvatarFallback className="text-[8px] bg-muted text-muted-foreground font-semibold">
                      {getInitials(u.full_name)}
                    </AvatarFallback>
                  </Avatar>
                  {u.full_name}
                </button>
              ))}
            </>
          )}
          {teams.length > 0 && (
            <>
              <p className="text-xs font-semibold text-muted-foreground px-3 pt-1">Teams</p>
              {teams.map((t) => (
                <button
                  key={t.id}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted flex items-center gap-2",
                    currentId === t.id && "bg-primary/10 text-primary font-medium"
                  )}
                  onClick={() => select(t.id, t.name, "team")}
                >
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-indigo-100 text-indigo-600 dark:bg-indigo-900/40 dark:text-indigo-300 flex-shrink-0">
                    <Users className="h-3 w-3" />
                  </span>
                  {t.name}
                  <span className="ml-auto text-[9px] font-semibold uppercase tracking-wider text-indigo-500 bg-indigo-50 dark:text-indigo-300 dark:bg-indigo-950/30 px-1 py-px rounded">Team</span>
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ProjectStaffBar({ project, canEdit, onProjectUpdate }) {
   const { data: liveProject } = useEntityData("Project", project?.id);
   const { data: allProducts = [] } = useEntityList("Product");
   const { data: allPackages = [] } = useEntityList("Package");
   const { data: users = [] } = useEntityList("User");
   const { data: teams = [] } = useEntityList("InternalTeam");
   const { mappings } = useRoleMappings();
   const [showAllRoles, setShowAllRoles] = useState(false);

   // Real-time subscription: when roles are changed via applyProjectRoleDefaults
   // (edge function), trigger parent refresh so the entire project view stays in sync.
   useEffect(() => {
     if (!project?.id) return;
     let mounted = true;
     const unsub = api.entities.Project.subscribe((event) => {
       if (!mounted) return;
       if (event.id === project.id || event.data?.id === project.id) {
         onProjectUpdate?.();
       }
     });
     return () => {
       mounted = false;
       if (typeof unsub === 'function') unsub();
     };
   }, [project?.id, onProjectUpdate]);

   if (!project) return null;

   const displayProject = liveProject || project;

   // Legacy key mapping for photographer/videographer
   const legacyKeys = { photographer: "onsite_staff_1", videographer: "onsite_staff_2" };

   // Partition roles into required vs irrelevant for this project's products
   const requiredRoles = [];
   const irrelevantRoles = [];

   for (const mapping of mappings) {
     const isNeeded = isRoleRequiredForProject(mapping, displayProject, allProducts, allPackages);
     if (isNeeded) {
       requiredRoles.push(mapping);
     } else {
       irrelevantRoles.push(mapping);
     }
   }

   const hiddenCount = irrelevantRoles.length;

   return (
     <Card>
       <CardContent className="p-3">
         <div className="flex items-center gap-1.5 mb-2">
           <Users className="h-3 w-3 text-muted-foreground" />
           <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Team</p>
         </div>

         {/* Required roles — compact grid */}
         <div className="space-y-1">
           {requiredRoles.map((mapping) => (
             <StaffSelector
               key={mapping.role}
               roleKey={mapping.role}
               legacyKey={legacyKeys[mapping.role]}
               label={mapping.label}
               project={displayProject}
               canEdit={canEdit}
               disabled={false}
               users={users}
               teams={teams}
             />
           ))}
         </div>

         {/* Irrelevant roles — collapsed */}
         {hiddenCount > 0 && (
           <div className="mt-1.5">
             <button
               onClick={() => setShowAllRoles(prev => !prev)}
               className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground font-medium transition-colors"
               title={showAllRoles ? 'Hide roles not required for this project' : `Show ${hiddenCount} role${hiddenCount > 1 ? 's' : ''} not required for this project`}
             >
               {showAllRoles ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
               {hiddenCount} more role{hiddenCount > 1 ? 's' : ''}
             </button>
             {showAllRoles && (
               <div className="space-y-1 mt-1">
                 {irrelevantRoles.map((mapping) => {
                   const idKey = `${mapping.role}_id`;
                   const currentId = displayProject?.[idKey] || (legacyKeys[mapping.role] ? displayProject?.[`${legacyKeys[mapping.role]}_id`] : null);
                   if (!currentId || currentId === "not_required") {
                     return <NotRequiredBadge key={mapping.role} roleKey={mapping.role} label={mapping.label} />;
                   }
                   return (
                     <StaffSelector key={mapping.role} roleKey={mapping.role} legacyKey={legacyKeys[mapping.role]} label={mapping.label} project={displayProject} canEdit={canEdit} disabled={false} users={users} teams={teams} />
                   );
                 })}
               </div>
             )}
           </div>
         )}
       </CardContent>
     </Card>
   );
}

export default React.memo(ProjectStaffBar);

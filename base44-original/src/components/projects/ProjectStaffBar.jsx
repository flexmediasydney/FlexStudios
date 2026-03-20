import React, { useState } from "react";
import { base44 } from "@/api/base44Client";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEntityList, useEntityData } from "@/components/hooks/useEntityData";
import { User, Users, ChevronDown, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { createNotification } from "@/components/notifications/createNotification";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useRoleMappings, projectHasCategoryFromMappings, isRoleRequiredForProject } from "@/components/hooks/useRoleMappings";

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



function StaffSelector({ roleKey, legacyKey, label, project, canEdit, disabled, disabledLabel, users, teams }) {
  const [open, setOpen] = useState(false);

  const idKey = `${roleKey}_id`;
  const nameKey = `${roleKey}_name`;
  const typeKey = `${roleKey}_type`;

  const currentId = project?.[idKey] || (legacyKey ? project?.[`${legacyKey}_id`] : null);
  const currentName = project?.[nameKey] || (legacyKey ? project?.[`${legacyKey}_name`] : null);
  const currentType = project?.[typeKey];

  const mutation = useMutation({
    mutationFn: async (data) => {
      const result = await base44.entities.Project.update(project.id, data);
      // Notify newly assigned staff
      try {
        const currentUser = await base44.auth.me().catch(() => null);
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
      // Resync onsite tasks when photographer or videographer changes
      // so task assignment and future effort logs reflect the new staff
      const onsiteRoleFields = ['photographer_id', 'onsite_staff_1_id', 'videographer_id', 'onsite_staff_2_id'];
      const isOnsiteRoleChange = onsiteRoleFields.some(f => data[f] !== undefined);
      if (isOnsiteRoleChange && project?.id) {
        base44.functions.invoke('syncOnsiteEffortTasks', {
          project_id: project.id,
        }).catch(() => {});
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

  // If videographer is not required, show a static "Not required" pill
  if (disabled) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg border text-sm bg-muted/40 border-border text-muted-foreground cursor-default opacity-70">
        <User className="h-3.5 w-3.5 flex-shrink-0" />
        <div className="text-left">
          <p className="text-xs leading-none mb-0.5">{label}</p>
          <p className="leading-none text-xs italic">{disabledLabel || "Not required"}</p>
        </div>
      </div>
    );
  }

  return (
     <Popover open={open && canEdit} onOpenChange={(v) => canEdit && setOpen(v)}>
       <PopoverTrigger asChild>
         {/* Issue #13: Staff selector missing focus states and accessibility attributes */}
         <button
           disabled={!canEdit}
           className={cn(
             "flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary",
             isSet
               ? "bg-card border-border text-foreground hover:border-primary/50"
               : isNotRequired
               ? "bg-muted/40 border-border text-muted-foreground hover:border-muted-foreground/50"
               : "bg-amber-50 border-amber-300 text-amber-700 hover:border-amber-400",
             !canEdit && "cursor-default opacity-80"
           )}
           title={canEdit ? `Click to assign ${label}` : "You don't have permission to edit"}
           aria-label={`${label}: ${isSet ? currentName : isNotRequired ? "Not required" : "Not assigned"}`}
         >
          {isSet ? (
            currentType === "team" ? (
              <Users className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            ) : (
              <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
            )
          ) : isNotRequired ? (
            <User className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          ) : (
            <AlertCircle className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" />
          )}
          <div className="text-left">
            <p className="text-xs text-muted-foreground leading-none mb-0.5">{label}</p>
            <p className={cn("leading-none", isSet ? "text-foreground" : isNotRequired ? "text-muted-foreground italic text-xs" : "text-amber-600 italic text-xs")}>
              {isSet ? currentName : isNotRequired ? "Not required" : "Not assigned"}
            </p>
          </div>
          {canEdit && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-1 flex-shrink-0" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-1">
          {currentId && !isNotRequired && (
            <button
              className="w-full text-left px-3 py-2 text-sm text-destructive hover:bg-destructive/10 rounded-md"
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
              <p className="text-xs font-semibold text-muted-foreground px-3 pt-1">Employees</p>
              {users.map((u) => (
                <button
                  key={u.id}
                  className={cn(
                    "w-full text-left px-3 py-2 text-sm rounded-md hover:bg-muted flex items-center gap-2",
                    currentId === u.id && "bg-primary/10 text-primary font-medium"
                  )}
                  onClick={() => select(u.id, u.full_name, "user")}
                >
                  <User className="h-3.5 w-3.5 flex-shrink-0" />
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
                  <Users className="h-3.5 w-3.5 flex-shrink-0" />
                  {t.name}
                </button>
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default function ProjectStaffBar({ project, canEdit }) {
   const { data: liveProject } = useEntityData("Project", project?.id);
   const { data: allProducts = [] } = useEntityList("Product");
   const { data: allPackages = [] } = useEntityList("Package");
   const { data: users = [] } = useEntityList("User");
   const { data: teams = [] } = useEntityList("InternalTeam");
   const { mappings } = useRoleMappings();

   if (!project) return null;

   const displayProject = liveProject || project;

   // Legacy key mapping for photographer/videographer
   const legacyKeys = { photographer: "onsite_staff_1", videographer: "onsite_staff_2" };

   return (
     <div className="border-t border-b bg-muted/30 -mx-6 px-6 py-3">
       <div className="flex flex-wrap gap-2">
         {mappings.map((mapping) => {
           const isNeeded = isRoleRequiredForProject(mapping, displayProject, allProducts, allPackages);
           return (
             <StaffSelector
               key={mapping.role}
               roleKey={mapping.role}
               legacyKey={legacyKeys[mapping.role]}
               label={mapping.label}
               project={displayProject}
               canEdit={canEdit}
               disabled={!isNeeded}
               disabledLabel="Not required"
               users={users}
               teams={teams}
             />
           );
         })}
       </div>
     </div>
   );
}
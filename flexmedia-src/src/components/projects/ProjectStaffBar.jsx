import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useEntityList, useEntityData, refetchEntityList } from "@/components/hooks/useEntityData";
import { User, Users, ChevronDown, ChevronRight, AlertCircle, Camera, Video, ImageIcon, Film, PenTool, Compass, Crown, Loader2, Search, Star, X as XIcon } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useRoleMappings, projectHasCategoryFromMappings, isRoleRequiredForProject } from "@/components/hooks/useRoleMappings";

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
  project_owner: { bg: "bg-purple-100", text: "text-purple-700", badge: "bg-purple-500" },
  photographer: { bg: "bg-blue-100", text: "text-blue-700", badge: "bg-blue-500" },
  videographer: { bg: "bg-rose-100", text: "text-rose-700", badge: "bg-rose-500" },
  image_editor: { bg: "bg-emerald-100", text: "text-emerald-700", badge: "bg-emerald-500" },
  video_editor: { bg: "bg-orange-100", text: "text-orange-700", badge: "bg-orange-500" },
  floorplan_editor: { bg: "bg-cyan-100", text: "text-cyan-700", badge: "bg-cyan-500" },
  drone_editor: { bg: "bg-indigo-100", text: "text-indigo-700", badge: "bg-indigo-500" },
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


/** Map default_staff_role values to the STAFF_ROLES_CONFIG keys they match */
const ROLE_MATCH_MAP = {
  project_owner: ["project_owner"],
  photographer: ["photographer", "drone_operator"],
  videographer: ["videographer"],
  image_editor: ["image_editor"],
  video_editor: ["video_editor"],
  floorplan_editor: ["floorplan_editor"],
  drone_editor: ["drone_editor", "drone_operator"],
};

const ROLE_LABEL_SHORT = {
  project_owner: "Owner",
  photographer: "Photo",
  videographer: "Video",
  drone_operator: "Drone",
  image_editor: "Img Edit",
  video_editor: "Vid Edit",
  floorplan_editor: "FP Edit",
  drone_editor: "Drone Edit",
};

const MAX_VISIBLE = 30;

/**
 * Compute which users are "suggested" for a given role across loaded projects.
 * Returns up to 3 user IDs that appear most often in this role.
 */
function useSuggestedUsers(roleKey, legacyKey, allProjects) {
  return useMemo(() => {
    if (!allProjects?.length) return [];
    const idField = `${roleKey}_id`;
    const legacyField = legacyKey ? `${legacyKey}_id` : null;
    const counts = {};
    for (const p of allProjects) {
      const uid = p[idField] || (legacyField ? p[legacyField] : null);
      if (uid && uid !== "not_required") {
        counts[uid] = (counts[uid] || 0) + 1;
      }
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id]) => id);
  }, [roleKey, legacyKey, allProjects]);
}

function StaffSelector({ roleKey, legacyKey, label, project, canEdit, disabled, disabledLabel, users, teams, isSaving, allProjects }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const idKey = `${roleKey}_id`;
  const nameKey = `${roleKey}_name`;
  const typeKey = `${roleKey}_type`;

  const currentId = project?.[idKey] || (legacyKey ? project?.[`${legacyKey}_id`] : null);
  const currentName = project?.[nameKey] || (legacyKey ? project?.[`${legacyKey}_name`] : null);
  const currentType = project?.[typeKey];

  const suggestedIds = useSuggestedUsers(roleKey, legacyKey, allProjects);

  // Build the team lookup once
  const teamMap = useMemo(() => {
    const m = {};
    for (const t of teams) m[t.id] = t;
    return m;
  }, [teams]);

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
      setSearch("");
      toast.success("Staff assignment updated");
      const onsiteRoleFields = ['photographer_id', 'onsite_staff_1_id', 'videographer_id', 'onsite_staff_2_id'];
      const isOnsiteRoleChange = onsiteRoleFields.some(f => data[f] !== undefined);
      if (isOnsiteRoleChange && project?.id) {
        api.functions.invoke('syncOnsiteEffortTasks', {
          project_id: project.id,
        }).catch(() => {});
      }

      // Invalidate caches so UI updates immediately
      queryClient.invalidateQueries({ queryKey: ["entity-list", "Project"] });
      queryClient.invalidateQueries({ queryKey: ["entity-data", "Project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["entity-list", "ProjectTask"] });
      refetchEntityList("Project");

      // Re-assign tasks for the changed role
      if (project?.id && data) {
        const roleFields = ['photographer_id', 'videographer_id', 'image_editor_id', 'video_editor_id', 'floorplan_editor_id', 'drone_editor_id', 'project_owner_id'];
        for (const field of roleFields) {
          if (field in data) {
            const roleName = field.replace('_id', '');
            const newUserId = data[field] || null;
            const newUserName = data[field.replace('_id', '_name')] || null;
            const assignType = data[field.replace('_id', '_type')] || 'user';

            // Fetch tasks with this auto_assign_role and re-assign
            api.entities.ProjectTask.filter({ project_id: project.id }, null, 200).then(tasks => {
              const toUpdate = tasks.filter(t =>
                t.auto_assign_role === roleName && !t.is_deleted
              );
              Promise.allSettled(toUpdate.map(t => {
                const updates = assignType === 'team'
                  ? { assigned_to: null, assigned_to_name: null, assigned_to_team_id: newUserId, assigned_to_team_name: newUserName }
                  : { assigned_to: newUserId, assigned_to_name: newUserName, assigned_to_team_id: null, assigned_to_team_name: null };
                return api.entities.ProjectTask.update(t.id, updates);
              })).then(() => {
                refetchEntityList("ProjectTask");
              });
            }).catch(() => {});
          }
        }
      }
    },
    onError: (err) => toast.error(err?.message || "Failed to update staff assignment"),
  });

  const select = useCallback((id, name, type) => {
    mutation.mutate({
      [idKey]: id,
      [nameKey]: name,
      [typeKey]: type,
    });
  }, [mutation, idKey, nameKey, typeKey]);

  const isNotRequired = currentId === "not_required";
  const isSet = !!currentId && !isNotRequired;
  const isLoading = mutation.isPending || isSaving;

  const RoleIcon = ROLE_ICONS[roleKey] || User;
  const roleColor = ROLE_COLORS[roleKey] || { bg: "bg-muted", text: "text-muted-foreground", badge: "bg-muted-foreground" };

  // Which default_staff_role values match this roleKey
  const matchingRoles = ROLE_MATCH_MAP[roleKey] || [];

  // Filter & sort users for the dropdown
  const { filteredUsers, suggestedUsers, groupedUsers, totalMatching, truncated, activeTeams } = useMemo(() => {
    const q = search.toLowerCase().trim();
    // Filter by search
    let matched = users;
    if (q) {
      matched = users.filter(u => {
        const name = (u.full_name || "").toLowerCase();
        const email = (u.email || "").toLowerCase();
        return name.includes(q) || email.includes(q);
      });
    }
    const totalMatching = matched.length;

    // Sort: matching default_staff_role first, then alphabetical
    const sorted = [...matched].sort((a, b) => {
      const aMatch = matchingRoles.includes(a.default_staff_role) ? 0 : 1;
      const bMatch = matchingRoles.includes(b.default_staff_role) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      return (a.full_name || "").localeCompare(b.full_name || "");
    });

    // Suggested: from the suggestedIds list, only if they exist in our user set and match search
    const suggestedSet = new Set(suggestedIds);
    const suggested = q
      ? [] // Don't show suggested when actively searching
      : sorted.filter(u => suggestedSet.has(u.id)).slice(0, 3);
    const suggestedIdSet = new Set(suggested.map(u => u.id));

    // Group remaining by team
    const groups = {};
    const usersForGrouping = sorted.filter(u => !suggestedIdSet.has(u.id) || q);
    const truncated = usersForGrouping.length > MAX_VISIBLE;
    const visible = usersForGrouping.slice(0, MAX_VISIBLE);

    for (const u of visible) {
      const teamId = u.internal_team_id || "__unassigned__";
      if (!groups[teamId]) groups[teamId] = [];
      groups[teamId].push(u);
    }

    // Sort groups: named teams alphabetically, unassigned last
    const teamOrder = Object.keys(groups).sort((a, b) => {
      if (a === "__unassigned__") return 1;
      if (b === "__unassigned__") return -1;
      const aName = teamMap[a]?.name || "";
      const bName = teamMap[b]?.name || "";
      return aName.localeCompare(bName);
    });

    const groupedUsers = teamOrder.map(tid => ({
      teamId: tid,
      teamName: tid === "__unassigned__" ? "Unassigned" : (teamMap[tid]?.name || "Unknown Team"),
      teamColor: tid !== "__unassigned__" ? teamMap[tid]?.color : null,
      users: groups[tid],
    }));

    // Filter teams by search too
    const activeTeams = q
      ? teams.filter(t => t.is_active !== false && t.name.toLowerCase().includes(q))
      : teams.filter(t => t.is_active !== false);

    return { filteredUsers: sorted, suggestedUsers: suggested, groupedUsers, totalMatching, truncated: truncated ? totalMatching - MAX_VISIBLE : 0, activeTeams };
  }, [users, teams, search, matchingRoles, suggestedIds, teamMap]);

  // Build flat list of selectable items for keyboard navigation
  // Order must match visual render order: suggested, not_required, grouped users, teams
  const flatItems = useMemo(() => {
    const items = [];
    // Suggested users first
    for (const u of suggestedUsers) {
      items.push({ type: "suggested", id: u.id, name: u.full_name, user: u });
    }
    // "Not Required" option
    items.push({ type: "action", id: "not_required", label: "Not Required" });
    // Grouped users by team
    for (const group of groupedUsers) {
      for (const u of group.users) {
        items.push({ type: "user", id: u.id, name: u.full_name, role: u.default_staff_role, user: u });
      }
    }
    // Teams at the bottom
    for (const t of activeTeams) {
      items.push({ type: "team", id: t.id, name: t.name, team: t });
    }
    return items;
  }, [suggestedUsers, groupedUsers, activeTeams]);

  // Reset highlight when search changes
  useEffect(() => { setHighlightIdx(-1); }, [search]);

  // Focus search input when popover opens
  useEffect(() => {
    if (open) {
      setSearch("");
      setHighlightIdx(-1);
      // Small delay for popover animation
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Scroll highlighted item into view
  useEffect(() => {
    if (highlightIdx < 0 || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${highlightIdx}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const handleKeyDown = useCallback((e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx(prev => Math.min(prev + 1, flatItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx(prev => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0) {
      e.preventDefault();
      const item = flatItems[highlightIdx];
      if (!item) return;
      if (item.type === "action" && item.id === "not_required") {
        select("not_required", "Not required", null);
      } else if (item.type === "user") {
        select(item.id, item.name, "user");
      } else if (item.type === "team") {
        select(item.id, item.name, "team");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  }, [flatItems, highlightIdx, select, setOpen]);

  // Render a user row at a specific flat index
  const renderUserRow = useCallback((u, flatIndex) => {
    const isSelected = currentId === u.id;
    const isHighlighted = highlightIdx === flatIndex;
    const roleLabel = ROLE_LABEL_SHORT[u.default_staff_role];
    const hasMatchingRole = matchingRoles.includes(u.default_staff_role);

    return (
      <button
        key={`fi-${flatIndex}`}
        data-idx={flatIndex}
        className={cn(
          "w-full text-left px-2.5 py-1.5 text-sm rounded-md flex items-center gap-2 transition-colors",
          isHighlighted && "bg-accent",
          isSelected && !isHighlighted && "bg-primary/10 text-primary",
          !isHighlighted && !isSelected && "hover:bg-muted"
        )}
        onClick={() => select(u.id, u.full_name, "user")}
        onMouseEnter={() => setHighlightIdx(flatIndex)}
      >
        <Avatar className="h-5 w-5 flex-shrink-0">
          <AvatarFallback className={cn(
            "text-[8px] font-semibold",
            hasMatchingRole ? roleColor.bg + " " + roleColor.text : "bg-muted text-muted-foreground"
          )}>
            {getInitials(u.full_name)}
          </AvatarFallback>
        </Avatar>
        <span className="truncate flex-1 min-w-0">{u.full_name || u.email || "Unknown"}</span>
        {roleLabel && (
          <span className={cn(
            "text-[9px] px-1.5 py-0 rounded-full font-medium flex-shrink-0",
            hasMatchingRole
              ? "bg-primary/10 text-primary border border-primary/20"
              : "bg-muted text-muted-foreground"
          )}>
            {roleLabel}
          </span>
        )}
        {isSelected && (
          <span className="text-primary flex-shrink-0 text-xs">&#10003;</span>
        )}
      </button>
    );
  }, [currentId, highlightIdx, matchingRoles, roleColor, select]);

  // Precompute flat index offsets for each section
  const sectionOffsets = useMemo(() => {
    const suggestedStart = 0;
    const notRequiredIdx = suggestedUsers.length;
    const groupedStart = notRequiredIdx + 1;
    let groupedCount = 0;
    for (const g of groupedUsers) groupedCount += g.users.length;
    const teamsStart = groupedStart + groupedCount;
    return { suggestedStart, notRequiredIdx, groupedStart, teamsStart };
  }, [suggestedUsers.length, groupedUsers]);

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
     <Popover open={open && canEdit} onOpenChange={(v) => { if (canEdit) { setOpen(v); if (!v) setSearch(""); } }}>
       <PopoverTrigger asChild>
         <button
           disabled={!canEdit || isLoading}
           className={cn(
             "relative flex items-center gap-1.5 px-2 py-1 rounded-md border text-xs font-medium transition-all w-full",
             isSet
               ? "bg-card border-border text-foreground hover:border-primary/50"
               : isNotRequired
               ? "bg-muted/30 border-border text-muted-foreground"
               : "bg-amber-50 border-amber-300 text-amber-700 hover:border-amber-400",
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
              isSet ? "font-medium" : isNotRequired ? "text-muted-foreground italic" : "text-amber-600 italic"
            )}>
              {isSet ? currentName : isNotRequired ? "N/R" : "Unassigned"}
            </span>
            {isSet && currentType === "team" && (
              <span className="ml-1 text-[8px] px-1 rounded bg-indigo-100 text-indigo-600 font-semibold">TEAM</span>
            )}
          </div>
          {canEdit && !isLoading && <ChevronDown className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start" onKeyDown={handleKeyDown}>
        {/* Search input */}
        <div className="p-2 border-b">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search staff..."
              className="h-8 pl-8 pr-8 text-sm"
            />
            {search && (
              <button
                onClick={() => { setSearch(""); inputRef.current?.focus(); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <XIcon className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Scrollable list */}
        <ScrollArea className="max-h-72">
          <div ref={listRef} className="p-1.5">

            {/* Suggested section */}
            {suggestedUsers.length > 0 && (
              <div className="mb-1">
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Star className="h-3 w-3 text-amber-500" />
                  Suggested
                </div>
                {suggestedUsers.map((u, i) => renderUserRow(u, sectionOffsets.suggestedStart + i))}
              </div>
            )}

            {/* Not Required option */}
            {(() => {
              const nrIdx = sectionOffsets.notRequiredIdx;
              return (
                <button
                  data-idx={nrIdx}
                  className={cn(
                    "w-full text-left px-2.5 py-1.5 text-sm rounded-md flex items-center gap-2 transition-colors",
                    highlightIdx === nrIdx && "bg-accent",
                    isNotRequired && highlightIdx !== nrIdx && "bg-primary/10 text-primary",
                    highlightIdx !== nrIdx && !isNotRequired && "hover:bg-muted",
                    "text-muted-foreground"
                  )}
                  onClick={() => select("not_required", "Not required", null)}
                  onMouseEnter={() => setHighlightIdx(nrIdx)}
                >
                  <span className="inline-flex items-center justify-center h-5 w-5 rounded-full bg-muted flex-shrink-0">
                    <XIcon className="h-3 w-3 text-muted-foreground" />
                  </span>
                  <span className="italic">Not Required</span>
                  {isNotRequired && <span className="text-primary flex-shrink-0 text-xs ml-auto">&#10003;</span>}
                </button>
              );
            })()}

            {/* Divider */}
            <div className="border-t my-1.5" />

            {/* Grouped users by team */}
            {groupedUsers.length > 0 ? (
              (() => {
                let runningIdx = sectionOffsets.groupedStart;
                return groupedUsers.map(group => {
                  const startIdx = runningIdx;
                  runningIdx += group.users.length;
                  return (
                    <div key={group.teamId} className="mb-1">
                      <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                        {group.teamColor && (
                          <span
                            className="inline-block h-2 w-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: group.teamColor }}
                          />
                        )}
                        {group.teamName}
                        <span className="text-[9px] font-normal">({group.users.length})</span>
                      </div>
                      {group.users.map((u, i) => renderUserRow(u, startIdx + i))}
                    </div>
                  );
                });
              })()
            ) : (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                No matching staff found
              </div>
            )}

            {/* Truncation notice */}
            {truncated > 0 && (
              <div className="px-3 py-2 text-center text-xs text-muted-foreground bg-muted/50 rounded-md mt-1">
                {truncated} more &mdash; refine your search
              </div>
            )}

            {/* Teams section */}
            {activeTeams.length > 0 && (
              <>
                <div className="border-t my-1.5" />
                <div className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <Users className="h-3 w-3" />
                  Teams
                </div>
                {activeTeams.map((t, i) => {
                  const teamIdx = sectionOffsets.teamsStart + i;
                  const memberCount = users.filter(u => u.internal_team_id === t.id).length;
                  const isTeamSelected = currentId === t.id;
                  const isTeamHighlighted = highlightIdx === teamIdx;
                  return (
                    <button
                      key={t.id}
                      data-idx={teamIdx}
                      className={cn(
                        "w-full text-left px-2.5 py-1.5 text-sm rounded-md flex items-center gap-2 transition-colors",
                        isTeamHighlighted && "bg-accent",
                        isTeamSelected && !isTeamHighlighted && "bg-primary/10 text-primary",
                        !isTeamHighlighted && !isTeamSelected && "hover:bg-muted"
                      )}
                      onClick={() => select(t.id, t.name, "team")}
                      onMouseEnter={() => setHighlightIdx(teamIdx)}
                    >
                      <span
                        className="inline-flex items-center justify-center h-5 w-5 rounded-full flex-shrink-0"
                        style={{ backgroundColor: t.color ? `${t.color}20` : undefined }}
                      >
                        <Users className="h-3 w-3" style={{ color: t.color || undefined }} />
                      </span>
                      <span className="truncate flex-1">{t.name}</span>
                      <span className="text-[9px] font-medium text-muted-foreground bg-muted px-1.5 py-0 rounded-full flex-shrink-0">
                        {memberCount}
                      </span>
                      {isTeamSelected && <span className="text-primary flex-shrink-0 text-xs">&#10003;</span>}
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}

export default function ProjectStaffBar({ project, canEdit, onProjectUpdate }) {
   const { data: liveProject } = useEntityData("Project", project?.id);
   const { data: allProducts = [] } = useEntityList("Product");
   const { data: allPackages = [] } = useEntityList("Package");
   const { data: users = [] } = useEntityList("User");
   const { data: teams = [] } = useEntityList("InternalTeam");
   const { data: recentProjects = [] } = useEntityList("Project", "-created_date", 200);
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
               allProjects={recentProjects}
             />
           ))}
         </div>

         {/* Irrelevant roles — collapsed */}
         {hiddenCount > 0 && (
           <div className="mt-1.5">
             <button
               onClick={() => setShowAllRoles(prev => !prev)}
               className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/60 hover:text-muted-foreground font-medium transition-colors"
             >
               {showAllRoles ? <ChevronDown className="h-2.5 w-2.5" /> : <ChevronRight className="h-2.5 w-2.5" />}
               {hiddenCount} more
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
                     <StaffSelector key={mapping.role} roleKey={mapping.role} legacyKey={legacyKeys[mapping.role]} label={mapping.label} project={displayProject} canEdit={canEdit} disabled={false} users={users} teams={teams} allProjects={recentProjects} />
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

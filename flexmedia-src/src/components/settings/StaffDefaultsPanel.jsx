import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useEntityList } from "@/components/hooks/useEntityData";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Crown,
  Camera,
  Video,
  Image as ImageIcon,
  Film,
  PenTool,
  Compass,
  User,
  Users,
  X,
  Check,
  ChevronsUpDown,
  Save,
  Loader2,
  UserCog,
  Info,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Role definitions ──────────────────────────────────────────────────────────

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
  project_owner: "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  photographer: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  videographer: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400",
  image_editor: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400",
  video_editor: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  floorplan_editor: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900/30 dark:text-cyan-400",
  drone_editor: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400",
};

const ROLES = [
  { key: "project_owner", label: "Project Owner", userField: "project_owner_default_user_id", teamTier: "owner" },
  { key: "photographer", label: "Photographer", userField: "photographer_default_user_id", teamTier: "onsite", teamField: "photographer_fallback_team_id" },
  { key: "videographer", label: "Videographer", userField: "videographer_default_user_id", teamTier: "onsite", teamField: "videographer_fallback_team_id" },
  { key: "image_editor", label: "Image Editor", userField: "image_editor_default_user_id", teamTier: "editing" },
  { key: "video_editor", label: "Video Editor", userField: "video_editor_default_user_id", teamTier: "editing" },
  { key: "floorplan_editor", label: "Floorplan Editor", userField: "floorplan_editor_default_user_id", teamTier: "editing" },
  { key: "drone_editor", label: "Drone Editor", userField: "drone_editor_default_user_id", teamTier: "editing" },
];

// Map team tier to the fallback_team_id column
const TIER_TEAM_FIELDS = {
  owner: "owner_fallback_team_id",
  onsite: "onsite_fallback_team_id",
  editing: "editing_fallback_team_id",
};

function getTeamField(role) {
  // Role-specific team field takes priority (photographer, videographer have their own)
  if (role.teamField) return role.teamField;
  return TIER_TEAM_FIELDS[role.teamTier] || null;
}

// ── Searchable combobox ───────────────────────────────────────────────────────

function SearchableSelect({ options, value, onChange, placeholder, emptyLabel }) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal h-9 text-sm"
        >
          <span className="truncate">
            {selected ? selected.label : placeholder || "Select..."}
          </span>
          <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search..." />
          <CommandList>
            <CommandEmpty>{emptyLabel || "No results."}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === option.value ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ── Single role row ───────────────────────────────────────────────────────────

function RoleDefaultRow({ role, formState, setFormState, userOptions, teamOptions }) {
  const Icon = ROLE_ICONS[role.key] || User;
  const colorClass = ROLE_COLORS[role.key] || "bg-muted text-muted-foreground";

  const userField = role.userField;
  const teamField = getTeamField(role);

  const currentUserId = formState[userField] || null;
  const currentTeamId = teamField ? (formState[teamField] || null) : null;

  // Determine mode: "user" if a user is set, "team" if a team is set, otherwise "user"
  const hasUser = !!currentUserId;
  const hasTeam = !!currentTeamId;
  const [mode, setMode] = useState(hasUser ? "user" : hasTeam ? "team" : "user");

  // Sync mode when formState changes from parent
  React.useEffect(() => {
    if (currentUserId) setMode("user");
    else if (currentTeamId) setMode("team");
  }, [currentUserId, currentTeamId]);

  const handleModeToggle = (newMode) => {
    setMode(newMode);
    // Clear the other field when switching
    if (newMode === "user" && teamField) {
      setFormState((prev) => ({ ...prev, [teamField]: null }));
    } else if (newMode === "team") {
      setFormState((prev) => ({ ...prev, [userField]: null }));
    }
  };

  const handleUserChange = (userId) => {
    setFormState((prev) => ({
      ...prev,
      [userField]: userId || null,
      ...(teamField ? { [teamField]: null } : {}),
    }));
  };

  const handleTeamChange = (teamId) => {
    setFormState((prev) => ({
      ...prev,
      ...(teamField ? { [teamField]: teamId || null } : {}),
      [userField]: null,
    }));
  };

  const handleClear = () => {
    setFormState((prev) => ({
      ...prev,
      [userField]: null,
      ...(teamField ? { [teamField]: null } : {}),
    }));
  };

  const currentValue = mode === "user" ? currentUserId : currentTeamId;
  const currentOptions = mode === "user" ? userOptions : teamOptions;
  const currentLabel =
    currentOptions.find((o) => o.value === currentValue)?.label || null;

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
      {/* Role label */}
      <div className="flex items-center gap-2.5 sm:w-48 flex-shrink-0">
        <div className={cn("flex items-center justify-center w-8 h-8 rounded-lg", colorClass)}>
          <Icon className="h-4 w-4" />
        </div>
        <span className="font-medium text-sm">{role.label}</span>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-muted/50 rounded-md p-0.5 flex-shrink-0">
        <button
          type="button"
          onClick={() => handleModeToggle("user")}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all",
            mode === "user"
              ? "bg-background shadow-sm text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          <User className="h-3 w-3" />
          User
        </button>
        {teamField && (
          <button
            type="button"
            onClick={() => handleModeToggle("team")}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-all",
              mode === "team"
                ? "bg-background shadow-sm text-foreground"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Users className="h-3 w-3" />
            Team
          </button>
        )}
      </div>

      {/* Selector */}
      <div className="flex-1 min-w-0">
        {mode === "user" ? (
          <SearchableSelect
            options={userOptions}
            value={currentUserId}
            onChange={handleUserChange}
            placeholder="Select a user..."
            emptyLabel="No active users found."
          />
        ) : teamField ? (
          <SearchableSelect
            options={teamOptions}
            value={currentTeamId}
            onChange={handleTeamChange}
            placeholder="Select a team..."
            emptyLabel="No active teams found."
          />
        ) : (
          <p className="text-xs text-muted-foreground italic px-2">
            No team fallback available for this role.
          </p>
        )}
      </div>

      {/* Current assignment + clear */}
      <div className="flex items-center gap-2 flex-shrink-0">
        {currentLabel && (
          <Badge variant="secondary" className="text-xs max-w-[140px] truncate">
            {currentLabel}
          </Badge>
        )}
        {(currentUserId || currentTeamId) && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            onClick={handleClear}
            title="Clear assignment"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

// ── Main panel ────────────────────────────────────────────────────────────────

export default function StaffDefaultsPanel() {
  const queryClient = useQueryClient();

  // Load current role defaults
  const { data: roleDefaults, isLoading: defaultsLoading } = useQuery({
    queryKey: ["tonomoRoleDefaults"],
    queryFn: async () => {
      try {
        const all = await api.entities.TonomoRoleDefaults.list("-created_date", 1);
        if (all.length === 0) {
          return await api.entities.TonomoRoleDefaults.create({});
        }
        return all[0];
      } catch (err) {
        console.warn("Failed to load role defaults:", err?.message);
        return null;
      }
    },
    retry: false,
  });

  // Load users and teams
  const { data: users = [], loading: usersLoading } = useEntityList("User", "full_name", 500);
  const { data: teams = [], loading: teamsLoading } = useEntityList("InternalTeam", "name", 200);

  // Build dropdown options
  const userOptions = useMemo(() => {
    return users
      .filter((u) => u.is_active !== false)
      .map((u) => ({
        value: u.id,
        label: u.full_name || u.email || "Unknown",
      }));
  }, [users]);

  const teamOptions = useMemo(() => {
    return teams
      .filter((t) => t.is_active !== false)
      .map((t) => ({
        value: t.id,
        label: t.name || "Unnamed Team",
      }));
  }, [teams]);

  // Form state — seeded from DB when loaded
  const [formState, setFormState] = useState({});
  const [isInitialized, setIsInitialized] = useState(false);

  React.useEffect(() => {
    if (roleDefaults && !isInitialized) {
      const state = {};
      for (const role of ROLES) {
        state[role.userField] = roleDefaults[role.userField] || null;
        const teamField = getTeamField(role);
        if (teamField) {
          state[teamField] = roleDefaults[teamField] || null;
        }
      }
      setFormState(state);
      setIsInitialized(true);
    }
  }, [roleDefaults, isInitialized]);

  // Detect unsaved changes
  const hasChanges = useMemo(() => {
    if (!roleDefaults || !isInitialized) return false;
    for (const [key, val] of Object.entries(formState)) {
      const dbVal = roleDefaults[key] || null;
      if ((val || null) !== (dbVal || null)) return true;
    }
    return false;
  }, [formState, roleDefaults, isInitialized]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (updates) => {
      if (!roleDefaults?.id) throw new Error("No role defaults record found");
      return api.entities.TonomoRoleDefaults.update(roleDefaults.id, updates);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tonomoRoleDefaults"] });
      setIsInitialized(false); // Re-seed from DB
      toast.success("Staff defaults saved successfully");
    },
    onError: (err) => {
      toast.error(err?.message || "Failed to save staff defaults");
    },
  });

  const handleSave = () => {
    // Build update payload — only send fields that changed
    const updates = {};
    for (const [key, val] of Object.entries(formState)) {
      const dbVal = roleDefaults?.[key] || null;
      if ((val || null) !== (dbVal || null)) {
        updates[key] = val || null;
      }
    }
    if (Object.keys(updates).length === 0) {
      toast.info("No changes to save");
      return;
    }
    saveMutation.mutate(updates);
  };

  const isLoading = defaultsLoading || usersLoading || teamsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!roleDefaults) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <p>Could not load role defaults configuration.</p>
        <p className="text-sm mt-1">Please check that the TonomoRoleDefaults entity exists.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-primary/10">
                <UserCog className="h-5 w-5 text-primary" />
              </div>
              <div>
                <CardTitle className="text-lg">Staff Defaults</CardTitle>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Configure which person or team is automatically assigned to each role when a new project is created.
                </p>
              </div>
            </div>
            <Button
              onClick={handleSave}
              disabled={!hasChanges || saveMutation.isPending}
              size="sm"
              className="gap-1.5"
            >
              {saveMutation.isPending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200/50 dark:border-blue-800/30 mb-4">
            <Info className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
            <p className="text-xs text-blue-700 dark:text-blue-300">
              Individual user defaults take priority over team defaults. When a project is created,
              the system first checks for a user default, then falls back to the team default for each role.
            </p>
          </div>

          {ROLES.map((role) => (
            <RoleDefaultRow
              key={role.key}
              role={role}
              formState={formState}
              setFormState={setFormState}
              userOptions={userOptions}
              teamOptions={teamOptions}
            />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

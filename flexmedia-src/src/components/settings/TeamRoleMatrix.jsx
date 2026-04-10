import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { useRoleMappings } from "@/components/hooks/useRoleMappings";
import { useTeamRoleAssignments } from "@/components/hooks/useTeamRoleAssignments";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Users, Camera, Film, Plane, Palette, FileText, Star, Info,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const ROLE_ICONS = {
  project_owner: Users,
  photographer: Camera,
  videographer: Film,
  image_editor: Palette,
  video_editor: Film,
  floorplan_editor: FileText,
  drone_editor: Plane,
};

const ROLE_COLORS = {
  project_owner: { bg: "bg-slate-100", text: "text-slate-700", border: "border-slate-300", fill: "bg-slate-500" },
  photographer: { bg: "bg-blue-50", text: "text-blue-700", border: "border-blue-300", fill: "bg-blue-500" },
  videographer: { bg: "bg-purple-50", text: "text-purple-700", border: "border-purple-300", fill: "bg-purple-500" },
  image_editor: { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-300", fill: "bg-emerald-500" },
  video_editor: { bg: "bg-violet-50", text: "text-violet-700", border: "border-violet-300", fill: "bg-violet-500" },
  floorplan_editor: { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-300", fill: "bg-amber-500" },
  drone_editor: { bg: "bg-cyan-50", text: "text-cyan-700", border: "border-cyan-300", fill: "bg-cyan-500" },
};

// Cell states: empty → assigned → assigned+primary → empty
function getNextState(currentAssignment) {
  if (!currentAssignment) return "assigned";
  if (!currentAssignment.is_primary_fallback) return "primary";
  return "remove";
}

export default function TeamRoleMatrix() {
  const { mappings, loading: rolesLoading } = useRoleMappings();
  const {
    assignments, rolesByTeam, primaryFallbackByRole,
    upsertMutation, removeMutation, clearPrimaryMutation, loading: assignmentsLoading,
  } = useTeamRoleAssignments();

  const { data: teams = [], isLoading: teamsLoading } = useQuery({
    queryKey: ["internal_teams"],
    queryFn: () => api.entities.InternalTeam.list("name"),
  });

  const activeTeams = useMemo(() => teams.filter(t => t.is_active !== false), [teams]);

  const roles = useMemo(() =>
    mappings.map(m => ({ role: m.role, label: m.label || m.role })),
    [mappings]
  );

  const loading = rolesLoading || assignmentsLoading || teamsLoading;
  const mutating = upsertMutation.isPending || removeMutation.isPending || clearPrimaryMutation.isPending;

  const getAssignment = (teamId, role) =>
    assignments.find(a => a.team_id === teamId && a.role === role && a.is_active !== false);

  async function handleCellClick(teamId, role) {
    if (mutating) return;

    const current = getAssignment(teamId, role);
    const nextState = getNextState(current);

    try {
      if (nextState === "assigned") {
        await upsertMutation.mutateAsync({ teamId, role, isPrimaryFallback: false });
        toast.success("Role assigned to team");
      } else if (nextState === "primary") {
        // Clear existing primary for this role first
        await clearPrimaryMutation.mutateAsync({ role, exceptTeamId: teamId });
        await upsertMutation.mutateAsync({ teamId, role, isPrimaryFallback: true });
        toast.success("Set as primary fallback");
      } else {
        await removeMutation.mutateAsync({ teamId, role });
        toast.success("Role removed from team");
      }
    } catch (err) {
      toast.error(err?.message || "Failed to update assignment");
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          Loading team role assignments...
        </CardContent>
      </Card>
    );
  }

  if (activeTeams.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No active teams found. Create teams in the Teams management page first.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold">Team Role Assignments</h2>
        <p className="text-muted-foreground">
          Map which teams handle which project roles. Click a cell to cycle: empty &rarr; assigned &rarr; primary fallback (star) &rarr; empty.
        </p>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-sm text-muted-foreground">
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded border-2 border-dashed border-muted-foreground/30" />
          <span>Not assigned</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded bg-blue-500/20 border border-blue-300" />
          <span>Assigned</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded bg-blue-500 border border-blue-600 flex items-center justify-center">
            <Star className="h-2.5 w-2.5 text-white" />
          </div>
          <span>Primary fallback (used by webhook auto-assignment)</span>
        </div>
      </div>

      {/* Matrix */}
      <Card>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50">
                <TableHead className="font-semibold min-w-[180px] sticky left-0 bg-muted/50 z-10">
                  Team
                </TableHead>
                {roles.map(r => {
                  const Icon = ROLE_ICONS[r.role];
                  const colors = ROLE_COLORS[r.role] || ROLE_COLORS.project_owner;
                  return (
                    <TableHead key={r.role} className="text-center min-w-[100px]">
                      <div className="flex flex-col items-center gap-1">
                        {Icon && <Icon className={cn("h-4 w-4", colors.text)} />}
                        <span className="text-xs font-medium leading-tight">{r.label}</span>
                      </div>
                    </TableHead>
                  );
                })}
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeTeams.map(team => (
                <TableRow key={team.id} className="hover:bg-muted/30">
                  <TableCell className="font-medium sticky left-0 bg-background z-10">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-3 h-3 rounded-full flex-shrink-0"
                        style={{ backgroundColor: team.color || "#94a3b8" }}
                      />
                      <span>{team.name}</span>
                    </div>
                  </TableCell>
                  {roles.map(r => {
                    const assignment = getAssignment(team.id, r.role);
                    const colors = ROLE_COLORS[r.role] || ROLE_COLORS.project_owner;
                    const isAssigned = !!assignment;
                    const isPrimary = assignment?.is_primary_fallback;

                    return (
                      <TableCell
                        key={r.role}
                        className="text-center p-1"
                      >
                        <button
                          onClick={() => handleCellClick(team.id, r.role)}
                          disabled={mutating}
                          className={cn(
                            "w-full h-10 rounded-md border-2 transition-all cursor-pointer",
                            "flex items-center justify-center",
                            "hover:ring-2 hover:ring-offset-1 hover:ring-blue-400",
                            "disabled:opacity-50 disabled:cursor-wait",
                            !isAssigned && "border-dashed border-muted-foreground/20 hover:border-muted-foreground/40",
                            isAssigned && !isPrimary && cn(colors.bg, colors.border, "border-solid"),
                            isPrimary && cn(colors.fill, "border-transparent text-white"),
                          )}
                          title={
                            !isAssigned ? `Click to assign ${r.label} to ${team.name}` :
                            !isPrimary ? `Click to set ${team.name} as primary fallback for ${r.label}` :
                            `Click to remove ${r.label} from ${team.name}`
                          }
                        >
                          {isPrimary && <Star className="h-4 w-4 text-white fill-white" />}
                          {isAssigned && !isPrimary && (
                            <div className={cn("w-2 h-2 rounded-full", colors.fill)} />
                          )}
                        </button>
                      </TableCell>
                    );
                  })}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </Card>

      {/* Fallback Summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="h-4 w-4 text-muted-foreground" />
            Webhook Fallback Summary
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-3">
            When a project is created via webhook with empty staff slots, these teams are auto-assigned:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
            {roles.map(r => {
              const fallbackTeamId = primaryFallbackByRole[r.role];
              const team = fallbackTeamId ? activeTeams.find(t => t.id === fallbackTeamId) : null;
              const colors = ROLE_COLORS[r.role] || ROLE_COLORS.project_owner;
              const Icon = ROLE_ICONS[r.role];

              return (
                <div
                  key={r.role}
                  className={cn(
                    "flex items-center gap-2 px-3 py-2 rounded-lg border",
                    team ? cn(colors.bg, colors.border) : "bg-muted/30 border-dashed border-muted-foreground/20"
                  )}
                >
                  {Icon && <Icon className={cn("h-4 w-4 flex-shrink-0", team ? colors.text : "text-muted-foreground")} />}
                  <div className="min-w-0">
                    <div className={cn("text-xs font-medium", team ? colors.text : "text-muted-foreground")}>
                      {r.label}
                    </div>
                    <div className="text-xs truncate">
                      {team ? (
                        <span className="flex items-center gap-1">
                          <div
                            className="w-2 h-2 rounded-full flex-shrink-0"
                            style={{ backgroundColor: team.color }}
                          />
                          {team.name}
                        </span>
                      ) : (
                        <span className="text-muted-foreground italic">No fallback</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

/**
 * Hook: loads team↔role assignments from team_role_assignments table.
 * Provides derived maps for quick lookups and mutation helpers.
 */
export function useTeamRoleAssignments() {
  const queryClient = useQueryClient();

  const { data: assignments = [], isLoading: loading } = useQuery({
    queryKey: ["team_role_assignments"],
    queryFn: () => api.entities.TeamRoleAssignment.list("fallback_priority"),
    staleTime: 60_000,
  });

  // Map<role, team_id[]> — all teams that handle each role
  const teamsByRole = useMemo(() => {
    const map = {};
    for (const a of assignments) {
      if (!a.is_active) continue;
      if (!map[a.role]) map[a.role] = [];
      map[a.role].push(a.team_id);
    }
    return map;
  }, [assignments]);

  // Map<team_id, assignment[]> — all roles for each team
  const rolesByTeam = useMemo(() => {
    const map = {};
    for (const a of assignments) {
      if (!a.is_active) continue;
      if (!map[a.team_id]) map[a.team_id] = [];
      map[a.team_id].push(a);
    }
    return map;
  }, [assignments]);

  // Map<role, team_id> — the primary fallback team for each role
  const primaryFallbackByRole = useMemo(() => {
    const map = {};
    for (const a of assignments) {
      if (!a.is_active || !a.is_primary_fallback) continue;
      map[a.role] = a.team_id;
    }
    return map;
  }, [assignments]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["team_role_assignments"] });

  const upsertMutation = useMutation({
    mutationFn: async ({ teamId, role, isPrimaryFallback }) => {
      // Find existing assignment
      const existing = assignments.find(a => a.team_id === teamId && a.role === role);
      if (existing) {
        return api.entities.TeamRoleAssignment.update(existing.id, {
          is_primary_fallback: isPrimaryFallback,
          is_active: true,
        });
      }
      return api.entities.TeamRoleAssignment.create({
        team_id: teamId,
        role,
        is_primary_fallback: isPrimaryFallback,
        is_active: true,
        fallback_priority: 0,
      });
    },
    onSuccess: invalidate,
  });

  const removeMutation = useMutation({
    mutationFn: async ({ teamId, role }) => {
      const existing = assignments.find(a => a.team_id === teamId && a.role === role);
      if (existing) {
        return api.entities.TeamRoleAssignment.delete(existing.id);
      }
    },
    onSuccess: invalidate,
  });

  // Clear primary fallback for a role (used before setting a new one)
  const clearPrimaryMutation = useMutation({
    mutationFn: async ({ role, exceptTeamId }) => {
      const toUpdate = assignments.filter(
        a => a.role === role && a.is_primary_fallback && a.team_id !== exceptTeamId
      );
      await Promise.all(
        toUpdate.map(a =>
          api.entities.TeamRoleAssignment.update(a.id, { is_primary_fallback: false })
        )
      );
    },
    onSuccess: invalidate,
  });

  return {
    assignments,
    teamsByRole,
    rolesByTeam,
    primaryFallbackByRole,
    loading,
    upsertMutation,
    removeMutation,
    clearPrimaryMutation,
    invalidate,
  };
}

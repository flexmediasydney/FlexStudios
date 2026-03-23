import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/supabaseClient';
import { useCurrentUser } from '@/components/auth/PermissionGuard';

/**
 * Hook to check the current user's access level for a specific entity type.
 * Returns { accessLevel, canEdit, canView, isLoading }
 *
 * Access levels:
 *   'edit' — full CRUD access
 *   'view' — read-only, inputs disabled, no create/delete
 *   'none' — hidden entirely (default for missing rules)
 */
export function useEntityAccess(entityType) {
  const { data: currentUser } = useCurrentUser();
  const role = currentUser?.role;

  const { data: rules = [], isLoading } = useQuery({
    queryKey: ['entity-access-rules'],
    queryFn: () => api.entities.EntityAccessRule.list('role', 200),
    staleTime: 5 * 60 * 1000, // 5 minutes
    enabled: !!role,
  });

  const rule = rules.find(r => r.role === role && r.entity_type === entityType);
  const accessLevel = rule?.access_level || 'none';

  return {
    accessLevel,
    canEdit: accessLevel === 'edit',
    canView: accessLevel === 'view' || accessLevel === 'edit',
    isLoading,
  };
}

/**
 * Hook to get ALL entity access rules (for admin matrix UI).
 */
export function useAllEntityAccessRules() {
  const { data: rules = [], isLoading, refetch } = useQuery({
    queryKey: ['entity-access-rules'],
    queryFn: () => api.entities.EntityAccessRule.list('role', 200),
    staleTime: 30 * 1000,
  });

  return { rules, isLoading, refetch };
}

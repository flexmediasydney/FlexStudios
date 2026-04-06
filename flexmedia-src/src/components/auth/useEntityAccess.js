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
    // BUG FIX: staleTime must match useAllEntityAccessRules (30s) to avoid cache
    // inconsistency — the admin matrix writes at 30s stale but this hook was reading
    // from the same cache key with 5-min stale, causing stale rules after admin edits.
    staleTime: 30 * 1000,
    enabled: !!role,
  });

  // BUG FIX: Guard against null/undefined role — without this, rules.find() could
  // match a DB rule with a null role field, granting unintended access during loading.
  if (!role) {
    return { accessLevel: 'none', canEdit: false, canView: false, isLoading };
  }

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

/**
 * RoleGate — Centralized, future-proof permission gate for UI rendering.
 *
 * Solves the "pricing leak" problem: instead of every component importing
 * usePermissions and manually checking `canSeePricing`, they wrap sensitive
 * sections in <RoleGate> or use the useRoleGate hook. New features
 * automatically inherit the gate — you can't accidentally forget it.
 *
 * Usage:
 *
 *   // Section-level gate (most common)
 *   <RoleGate require="canSeePricing">
 *     <RevenueCard value={revenue} />
 *   </RoleGate>
 *
 *   // With fallback
 *   <RoleGate require="canSeePricing" fallback={<span className="text-muted-foreground">—</span>}>
 *     ${revenue.toLocaleString()}
 *   </RoleGate>
 *
 *   // Multiple permissions (ANY match = allowed)
 *   <RoleGate require={["canSeePricing", "canSeeAnalytics"]}>
 *     <FinancialDashboard />
 *   </RoleGate>
 *
 *   // Destructive action gate
 *   <RoleGate require="isManagerOrAbove">
 *     <Button onClick={handleDelete}>Delete</Button>
 *   </RoleGate>
 *
 *   // Hook version for programmatic use
 *   const { allowed, mask } = useRoleGate('canSeePricing');
 *   const displayValue = mask(revenue, '—'); // revenue for manager+, '—' for employee
 *
 * Available permission keys (from usePermissions):
 *   canSeePricing, canEditPricing, canEditProject, canDeleteProject,
 *   canManageContacts, canManageUsers, canAccessSettings, canSeeAnalytics,
 *   isOwner, isAdminOrAbove, isManagerOrAbove, isEmployeeOrAbove
 */

import { usePermissions } from './PermissionGuard';
import { toast } from 'sonner';

/**
 * Component: conditionally render children based on permission.
 * If the user doesn't have the required permission, renders `fallback` (default: nothing).
 */
export function RoleGate({ require, fallback = null, children }) {
  const perms = usePermissions();

  const keys = Array.isArray(require) ? require : [require];
  const allowed = keys.some(k => !!perms[k]);

  return allowed ? children : fallback;
}

/**
 * Hook: programmatic permission checks with helpers.
 *
 * @param {string} permissionKey - Key from usePermissions() (e.g. 'canSeePricing')
 * @returns {{ allowed: boolean, mask: Function, guard: Function }}
 *
 * - `allowed` — boolean, can the user do this?
 * - `mask(value, fallback)` — returns value if allowed, fallback otherwise
 * - `guard(fn, errorMsg)` — wraps an async function to check permission before executing
 */
export function useRoleGate(permissionKey) {
  const perms = usePermissions();
  const allowed = !!perms[permissionKey];

  return {
    allowed,

    // Mask a value: show real value if allowed, fallback if not
    mask: (value, fallback = null) => allowed ? value : fallback,

    // Guard a function: only execute if allowed, otherwise show toast
    guard: (fn, errorMsg = 'You do not have permission for this action') => {
      return async (...args) => {
        if (!allowed) {
          toast.error(errorMsg);
          return;
        }
        return fn(...args);
      };
    },
  };
}

/**
 * Shortcut: price-specific visibility hook.
 * Combines both the role-based check (usePermissions) and provides a
 * consistent API for hiding financial data.
 *
 * Usage:
 *   const { visible, mask, Price } = usePriceGate();
 *   if (!visible) return null; // hide entire section
 *   const displayRevenue = mask(revenue, '—'); // mask individual values
 */
export function usePriceGate() {
  const { canSeePricing } = usePermissions();
  return {
    visible: canSeePricing,
    mask: (value, fallback = '—') => canSeePricing ? value : fallback,
  };
}

/**
 * AdminDroneThemes — master-admin-only editor for the system-level drone theme.
 *
 * The system theme is the global FlexMedia fallback for every render that has
 * no person- or organisation-level override. Until now operators edited it via
 * raw SQL; this page exposes the same ThemeBrandingSubtab UI used on Org/Agent
 * detail pages, with `ownerKind="system"` and a null `ownerId`.
 *
 * Permissions: master_admin only — gated by both routeAccess and an in-page
 * defensive check (the underlying setDroneTheme RPC also enforces server-side).
 */

import { usePermissions } from "@/components/auth/PermissionGuard";
import ThemeBrandingSubtab from "@/components/themes/ThemeBrandingSubtab";
import { AlertCircle } from "lucide-react";

export default function AdminDroneThemes() {
  const { isMasterAdmin } = usePermissions();
  if (!isMasterAdmin) {
    return (
      <div className="flex items-center justify-center min-h-[60vh] p-8">
        <div className="bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800/50 rounded-xl p-8 max-w-md text-center">
          <AlertCircle className="h-10 w-10 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">Access denied</h2>
          <p className="text-sm text-red-700 dark:text-red-300">Drone system themes are restricted to master admins.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="p-4 md:p-6 max-w-[1200px] mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-semibold leading-none">Drone system themes</h1>
        <p className="text-xs text-muted-foreground mt-1">
          Global fallback for every project that has no person- or organisation-level override. Edit cautiously — these settings affect every render.
        </p>
      </div>
      <ThemeBrandingSubtab ownerKind="system" ownerId={null} ownerName="FlexMedia" />
    </div>
  );
}

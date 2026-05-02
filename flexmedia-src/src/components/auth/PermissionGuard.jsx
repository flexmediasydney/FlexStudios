import { useQuery } from "@tanstack/react-query";
import React from "react";
import { api } from "@/api/supabaseClient";
import { useAuth } from "@/lib/AuthContext";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function useCurrentUser() {
  // Use the user from AuthContext directly — avoids calling supabase.auth.getUser()
  // which can hang indefinitely due to Web Locks issues
  const { user, isLoadingAuth } = useAuth();

  return useQuery({
    queryKey: ["current-user", user?.id],
    queryFn: () => user,
    enabled: !isLoadingAuth && !!user,
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    initialData: user || undefined,
  });
}

export function usePermissions() {
  // QC-iter2-W3 F-C-010: read `isLoadingAuth` directly from AuthContext (not
  // useQuery's isLoading) so callers can distinguish "auth bootstrapping"
  // from "no user / denied". When the underlying query is `enabled: false`
  // during bootstrap, react-query reports `isLoading: false` even though
  // auth has not resolved — that's what produced the Access Denied flash.
  const { user, isLoadingAuth } = useAuth();
  const isLoading = isLoadingAuth === true;

  // A missing role means no access.
  const role = user?.role || null;

  // ── 5-tier hierarchy booleans ─────────────────────────────
  const isOwner = role === 'master_admin';
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';
  const isEmployee = role === 'employee';
  const isContractor = role === 'contractor';

  const isAdminOrAbove = isOwner || isAdmin;
  const isManagerOrAbove = isAdminOrAbove || isManager;
  const isEmployeeOrAbove = isManagerOrAbove || isEmployee;

  // Legacy aliases kept for backward-compat with existing code
  const isMasterAdmin = isOwner;
  const isAdminOrEmployee = isEmployeeOrAbove;

  const isAssignedToProject = (project) => {
    if (!project || !user?.id) return false;
    const directRoles = [
      project.project_owner_id,
      project.photographer_id,
      project.videographer_id,
      project.onsite_staff_1_id,
      project.onsite_staff_2_id,
      project.image_editor_id,
      project.video_editor_id,
    ];
    if (directRoles.includes(user.id)) return true;
    return false;
  };

  return {
    user,
    role,
    // QC-iter2-W3 F-C-010: bootstrap signal for callers that gate render on a
    // permission boolean. During auth bootstrap `isAdminOrAbove` is `false`
    // (because `user` hasn't resolved), which produces a brief "Access denied"
    // flash on every full reload. Callers should branch on `isLoading` first
    // and render a skeleton/loader, then check the role booleans.
    isLoading,
    isResolved: !isLoading,

    // Tier booleans
    isOwner,
    isAdmin,
    isManager,
    isEmployee,
    isContractor,
    isAdminOrAbove,
    isManagerOrAbove,
    isEmployeeOrAbove,

    // Legacy aliases
    isMasterAdmin,
    isAdminOrEmployee,

    // Project access
    canSeeAllProjects: isEmployeeOrAbove,
    canAccessProject: (project) => isEmployeeOrAbove || isAssignedToProject(project),
    canEditProject: (project) => isManagerOrAbove,
    canDeleteProject: isOwner,

    // Pricing & financial
    canSeePricing: isManagerOrAbove,
    canEditPricing: isAdminOrAbove,
    canSeePriceMatrix: isManagerOrAbove,
    canSeeInvoicing: isManagerOrAbove,

    // Price Matrix access levels: "edit" | "view_with_pricing" | "view_without_pricing" | "none"
    // master_admin → edit, admin → edit, manager → view_with_pricing, employee → view_without_pricing
    priceMatrixAccess: isAdminOrAbove ? "edit" : isManager ? "view_with_pricing" : isEmployee ? "view_without_pricing" : "none",
    canEditPriceMatrix: isAdminOrAbove,
    canViewPriceMatrixPricing: isManagerOrAbove,
    canViewPriceMatrixStructure: isEmployeeOrAbove,

    // Contacts & CRM
    canManageContacts: isManagerOrAbove,
    canSeeProspecting: isManagerOrAbove,
    canManageAgencies: isManagerOrAbove,

    // Settings & Admin
    canAccessSettings: isAdminOrAbove,
    canManageUsers: isOwner,
    canManageAutomation: isAdminOrAbove,
    canManageIntegrations: isAdminOrAbove,

    // Analytics & Reporting
    canSeeAnalytics: isManagerOrAbove,
    canSeeBI: isOwner,
    canSeeUtilization: isOwner,
    canSeeReports: isManagerOrAbove,

    // Email
    canSeeAllEmails: isManagerOrAbove,
    canSendEmails: isEmployeeOrAbove,

    // Calendar
    canSeeAllCalendars: isEmployeeOrAbove,
    canManageCalendarConnections: isAdminOrAbove,

    // Dangerous operations
    canDeleteUsers: isOwner,
    canRunCleanupFunctions: isOwner,
    canAccessTestFunctions: isOwner,
  };
}

export function PermissionGuard({
  children,
  require = null, // "master_admin", "employee", or ["master_admin", "employee"]
  fallback = null
}) {
  const { data: user, isLoading, error, refetch } = useCurrentUser();

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center p-8 gap-3">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Checking permissions...</p>
      </div>
    );
  }

  // Show the actual error when auth fails, instead of silently swallowing it
  if (error) {
    const isAuthError = error.message?.includes('Not authenticated') ||
                        error.message?.includes('JWT') ||
                        error.message?.includes('session');

    if (isAuthError) {
      return (
        <div className="flex items-center justify-center min-h-screen p-8">
          <Alert className="max-w-md">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              <p className="mb-3">You need to be logged in to access this page.</p>
              <Button onClick={() => api.auth.redirectToLogin()}>
                Sign In
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      );
    }

    // Non-auth error: show the error details so it can be debugged
    return (
      <div className="flex items-center justify-center min-h-screen p-8">
        <Alert className="max-w-lg" variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load user</AlertTitle>
          <AlertDescription>
            <p className="mb-3 text-sm">{error.message || 'An unexpected error occurred while loading your account.'}</p>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Retry
              </Button>
              <Button size="sm" onClick={() => api.auth.redirectToLogin()}>
                Sign In
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen p-8">
        <Alert className="max-w-md">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            <p className="mb-3">You need to be logged in to access this page.</p>
            <Button onClick={() => api.auth.redirectToLogin()}>
              Sign In
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  // BUG FIX: If user.role is null/undefined, deny access even when `require` is not set.
  // A user record with no role should not be able to see any protected content.
  if (!user.role) {
    return fallback || (
      <div className="flex items-center justify-center min-h-screen p-8">
        <Alert className="max-w-md" variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>No Role Assigned</AlertTitle>
          <AlertDescription>
            <p>Your account does not have a role assigned. Please contact your administrator to be granted access.</p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (require) {
    const requiredRoles = Array.isArray(require) ? require : [require];
    const hasPermission = requiredRoles.includes(user.role);

    if (!hasPermission) {
      return fallback || (
        <div className="flex items-center justify-center min-h-screen p-8">
          <Alert className="max-w-md" variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Access Denied</AlertTitle>
            <AlertDescription>
              <p>You don't have permission to access this page.</p>
              <p className="text-xs mt-1 opacity-70">
                Your role: {user.role}. Required: {requiredRoles.join(' or ')}.
              </p>
            </AlertDescription>
          </Alert>
        </div>
      );
    }
  }

  return children;
}
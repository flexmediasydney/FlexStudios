import { useQuery } from "@tanstack/react-query";
import React from "react";
import { base44 } from "@/api/base44Client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async () => {
      try {
        const user = await base44.auth.me();
        return user;
      } catch (error) {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000, // Keep user fresh for 5 minutes
    gcTime: 10 * 60 * 1000,   // Cache for 10 minutes
    retry: 2,                  // Retry failed requests twice
    retryDelay: 1000,         // 1 second between retries
  });
}

export function usePermissions() {
  const { data: user } = useCurrentUser();

  const role = user?.role || 'contractor';
  const isMasterAdmin = role === 'master_admin';
  const isAdminOrEmployee = role === 'master_admin' || role === 'employee';
  const isEmployee = role === 'employee';
  const isContractor = role === 'contractor';

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
    if (project.assigned_users?.includes(user.id)) return true;
    return false;
  };

  return {
    user,
    role,
    isMasterAdmin,
    isAdminOrEmployee,
    isEmployee,
    isContractor,

    // Project access
    canSeeAllProjects: isAdminOrEmployee,
    canAccessProject: (project) => isAdminOrEmployee || isAssignedToProject(project),
    canEditProject: (project) => isAdminOrEmployee || isAssignedToProject(project),
    canDeleteProject: isMasterAdmin,

    // Pricing & financial
    canSeePricing: isAdminOrEmployee,
    canEditPricing: isAdminOrEmployee,
    canSeePriceMatrix: isAdminOrEmployee,
    canSeeInvoicing: isAdminOrEmployee,

    // Contacts & CRM
    canManageContacts: isAdminOrEmployee,
    canSeeProspecting: isAdminOrEmployee,
    canManageAgencies: isAdminOrEmployee,

    // Settings & Admin
    canAccessSettings: isAdminOrEmployee,
    canManageUsers: isMasterAdmin,
    canManageAutomation: isAdminOrEmployee,
    canManageIntegrations: isAdminOrEmployee,

    // Analytics & Reporting
    canSeeAnalytics: isAdminOrEmployee,
    canSeeBI: isMasterAdmin,
    canSeeUtilization: isMasterAdmin,
    canSeeReports: isAdminOrEmployee,

    // Email
    canSeeAllEmails: isAdminOrEmployee,
    canSendEmails: isAdminOrEmployee,

    // Calendar
    canSeeAllCalendars: isAdminOrEmployee,
    canManageCalendarConnections: isAdminOrEmployee,

    // Dangerous operations
    canDeleteUsers: isMasterAdmin,
    canRunCleanupFunctions: isMasterAdmin,
    canAccessTestFunctions: isMasterAdmin,
  };
}

export function PermissionGuard({ 
  children, 
  require = null, // "master_admin", "employee", or ["master_admin", "employee"]
  fallback = null 
}) {
  const { data: user, isLoading } = useCurrentUser();
  
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
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
            <Button onClick={() => base44.auth.redirectToLogin()}>
              Sign In
            </Button>
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
            <AlertDescription>
              You don't have permission to access this page.
            </AlertDescription>
          </Alert>
        </div>
      );
    }
  }
  
  return children;
}
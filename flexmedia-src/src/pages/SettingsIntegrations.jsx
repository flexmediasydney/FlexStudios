import { PermissionGuard } from "@/components/auth/PermissionGuard";
import IntegrationsManagement from "@/components/settings/IntegrationsManagement";
import { Plug } from "lucide-react";

export default function SettingsIntegrations() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Plug className="h-8 w-8" />
            Integrations
          </h1>
          <p className="text-muted-foreground mt-1">
            Connect external services and manage API credentials
          </p>
        </div>
        <IntegrationsManagement />
      </div>
    </PermissionGuard>
  );
}
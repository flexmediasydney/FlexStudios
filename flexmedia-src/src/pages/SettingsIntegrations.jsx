import { PermissionGuard } from "@/components/auth/PermissionGuard";
import IntegrationsManagement from "@/components/settings/IntegrationsManagement";

export default function SettingsIntegrations() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8">
        <IntegrationsManagement />
      </div>
    </PermissionGuard>
  );
}
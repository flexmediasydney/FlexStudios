import { PermissionGuard } from "@/components/auth/PermissionGuard";
import ClientsManagement from "@/components/settings/ClientsManagement";

export default function SettingsClients() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8">
        <ClientsManagement />
      </div>
    </PermissionGuard>
  );
}
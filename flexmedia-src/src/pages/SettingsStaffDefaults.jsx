import { PermissionGuard } from "@/components/auth/PermissionGuard";
import StaffDefaultsPanel from "@/components/settings/StaffDefaultsPanel";

export default function SettingsStaffDefaults() {
  return (
    <PermissionGuard require={["master_admin"]}>
      <div className="p-6 lg:p-8">
        <StaffDefaultsPanel />
      </div>
    </PermissionGuard>
  );
}

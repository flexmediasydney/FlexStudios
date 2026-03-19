import { PermissionGuard } from "@/components/auth/PermissionGuard";
import PriceMatrixManagement from "@/components/settings/PriceMatrixManagement";

export default function SettingsPriceMatrix() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8">
        <PriceMatrixManagement />
      </div>
    </PermissionGuard>
  );
}
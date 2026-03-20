import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import ProductsManagement from "@/components/settings/ProductsManagement";
import PackagesManagement from "@/components/settings/PackagesManagement";
import RoleTaskMatrix from "@/components/settings/RoleTaskMatrix";

export default function SettingsProductsPackages() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8">
        <Tabs defaultValue="products" className="space-y-4">
          <TabsList>
            <TabsTrigger value="products">Products</TabsTrigger>
            <TabsTrigger value="packages">Packages</TabsTrigger>
            <TabsTrigger value="role-matrix">Role Matrix</TabsTrigger>
          </TabsList>
          <TabsContent value="products">
            <ProductsManagement />
          </TabsContent>
          <TabsContent value="packages">
            <PackagesManagement />
          </TabsContent>
          <TabsContent value="role-matrix">
            <RoleTaskMatrix />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
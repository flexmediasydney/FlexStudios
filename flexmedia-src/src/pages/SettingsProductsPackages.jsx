import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import ProductsManagement from "@/components/settings/ProductsManagement";
import PackagesManagement from "@/components/settings/PackagesManagement";
import RoleTaskMatrix from "@/components/settings/RoleTaskMatrix";
import TeamRoleMatrix from "@/components/settings/TeamRoleMatrix";
import { ShoppingBag, Package, Grid3X3, Users } from "lucide-react";

export default function SettingsProductsPackages() {
  return (
    <PermissionGuard require={["master_admin", "admin"]}>
      <div className="p-6 lg:p-8 space-y-6 max-w-6xl">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <ShoppingBag className="h-8 w-8" />
            Products & Packages
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your service products, pricing packages, role assignments, and team structure
          </p>
        </div>
        <Tabs defaultValue="products" className="space-y-4">
          <TabsList>
            <TabsTrigger value="products">
              <ShoppingBag className="h-4 w-4 mr-1.5" />
              Products
            </TabsTrigger>
            <TabsTrigger value="packages">
              <Package className="h-4 w-4 mr-1.5" />
              Packages
            </TabsTrigger>
            <TabsTrigger value="role-matrix">
              <Grid3X3 className="h-4 w-4 mr-1.5" />
              Role Matrix
            </TabsTrigger>
            <TabsTrigger value="team-roles">
              <Users className="h-4 w-4 mr-1.5" />
              Team Roles
            </TabsTrigger>
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
          <TabsContent value="team-roles">
            <TeamRoleMatrix />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
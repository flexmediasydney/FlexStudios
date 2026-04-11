import React from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Users, Building2, Package, DollarSign, Settings as SettingsIcon, Plug, Wrench } from "lucide-react";
import { PermissionGuard, usePermissions } from "@/components/auth/PermissionGuard";
import UsersManagement from "@/components/settings/UsersManagement";
import ClientsManagement from "@/components/settings/ClientsManagement";
import ProductsManagement from "@/components/settings/ProductsManagement";
import PackagesManagement from "@/components/settings/PackagesManagement";
import PriceMatrixManagement from "@/components/settings/PriceMatrixManagement";
import DeliverySettings from "@/components/settings/DeliverySettings";
import ProjectTypesManagement from "@/components/settings/ProjectTypesManagement";
import ProductCategoriesManagement from "@/components/settings/ProductCategoriesManagement";
import NoteTagsManagement from "@/components/settings/NoteTagsManagement";
import ProjectRulebook from "@/components/projects/ProjectRulebook";
import IntegrationsManagement from "@/components/settings/IntegrationsManagement";
import InternalTeamsManagement from "@/components/settings/InternalTeamsManagement";

export default function Settings() {
  const { isMasterAdmin } = usePermissions();

  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Wrench className="h-7 w-7 text-primary" />
            Settings & Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage your business configuration and pricing
          </p>
        </div>

        <Tabs defaultValue="clients" className="space-y-6">
          <TabsList className="grid w-full grid-cols-3 lg:grid-cols-6 h-auto">
            <TabsTrigger value="clients" className="gap-2">
              <Building2 className="h-4 w-4" />
              <span className="hidden sm:inline">Clients</span>
            </TabsTrigger>
            <TabsTrigger value="products-packages" className="gap-2">
              <Package className="h-4 w-4" />
              <span className="hidden sm:inline">Products & Packages</span>
            </TabsTrigger>
            <TabsTrigger value="pricing" className="gap-2">
              <DollarSign className="h-4 w-4" />
              <span className="hidden sm:inline">Price Matrix</span>
            </TabsTrigger>
            <TabsTrigger value="organisation" className="gap-2">
              <SettingsIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Organisation</span>
            </TabsTrigger>
            {/* Integrations tab removed — use Tonomo Integration page */}
            {false && <TabsTrigger value="integrations" className="gap-2">
              <Plug className="h-4 w-4" />
              <span className="hidden sm:inline">Integrations</span>
            </TabsTrigger>}
            {isMasterAdmin && (
              <TabsTrigger value="teams-users" className="gap-2">
                <Users className="h-4 w-4" />
                <span className="hidden sm:inline">Teams & Users</span>
              </TabsTrigger>
            )}
          </TabsList>

          <TabsContent value="clients">
            <div className="mb-4">
              <p className="text-sm text-muted-foreground">Manage agencies, agents, and client accounts linked to your business.</p>
            </div>
            <ClientsManagement />
          </TabsContent>

          <TabsContent value="products-packages">
            <div className="mb-4">
              <p className="text-sm text-muted-foreground">Configure the products you offer and bundle them into packages for quoting.</p>
            </div>
            <Tabs defaultValue="products" className="space-y-4">
              <TabsList>
                <TabsTrigger value="products">Products</TabsTrigger>
                <TabsTrigger value="packages">Packages</TabsTrigger>
              </TabsList>
              <TabsContent value="products">
                <ProductsManagement />
              </TabsContent>
              <TabsContent value="packages">
                <PackagesManagement />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="pricing">
            <PriceMatrixManagement />
          </TabsContent>

          <TabsContent value="organisation">
            <Tabs defaultValue="project_types" className="space-y-4">
              <TabsList>
                <TabsTrigger value="project_types">Project Types</TabsTrigger>
                <TabsTrigger value="categories">Categories</TabsTrigger>
                <TabsTrigger value="delivery">Delivery</TabsTrigger>
                <TabsTrigger value="projects">Project Rules</TabsTrigger>
                <TabsTrigger value="note_tags">Note Tags</TabsTrigger>
              </TabsList>
              <TabsContent value="project_types">
                <ProjectTypesManagement />
              </TabsContent>
              <TabsContent value="categories">
                <ProductCategoriesManagement />
              </TabsContent>
              <TabsContent value="delivery">
                <DeliverySettings />
              </TabsContent>
              <TabsContent value="projects">
                <ProjectRulebook />
              </TabsContent>
              <TabsContent value="note_tags">
                <NoteTagsManagement />
              </TabsContent>
            </Tabs>
          </TabsContent>

          <TabsContent value="integrations">
            <IntegrationsManagement />
          </TabsContent>

          {isMasterAdmin && (
            <TabsContent value="teams-users">
              <Tabs defaultValue="teams" className="space-y-4">
                <TabsList>
                  <TabsTrigger value="teams">Teams</TabsTrigger>
                  <TabsTrigger value="users">Users</TabsTrigger>
                </TabsList>
                <TabsContent value="teams">
                  <InternalTeamsManagement />
                </TabsContent>
                <TabsContent value="users">
                  <UsersManagement />
                </TabsContent>
              </Tabs>
            </TabsContent>
          )}
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
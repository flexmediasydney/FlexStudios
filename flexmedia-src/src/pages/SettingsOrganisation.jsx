import React from "react";
import { PermissionGuard } from "@/components/auth/PermissionGuard";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import DeliverySettings from "@/components/settings/DeliverySettings";
import ProjectRulebook from "@/components/projects/ProjectRulebook";
import ProjectTypesManagement from "@/components/settings/ProjectTypesManagement";
import ProductCategoriesManagement from "@/components/settings/ProductCategoriesManagement";
import NoteTagsManagement from "@/components/settings/NoteTagsManagement";
import { Building2 } from "lucide-react";

export default function SettingsOrganisation() {
  return (
    <PermissionGuard require={["master_admin", "employee"]}>
      <div className="p-6 lg:p-8 space-y-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight flex items-center gap-2">
            <Building2 className="h-8 w-8" />
            Organisation Settings
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage delivery, projects, and system rules
          </p>
        </div>

        <Tabs defaultValue="project_types" className="w-full">
          <TabsList>
            <TabsTrigger value="project_types">Project Types</TabsTrigger>
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="delivery">Delivery</TabsTrigger>
            <TabsTrigger value="projects">Project Rules</TabsTrigger>
            <TabsTrigger value="note_tags">Note Tags</TabsTrigger>
          </TabsList>

          <TabsContent value="project_types" className="mt-6">
            <ProjectTypesManagement />
          </TabsContent>

          <TabsContent value="categories" className="mt-6">
            <ProductCategoriesManagement />
          </TabsContent>
          
          <TabsContent value="delivery" className="mt-6">
            <DeliverySettings />
          </TabsContent>
          
          <TabsContent value="projects" className="mt-6">
            <ProjectRulebook />
          </TabsContent>

          <TabsContent value="note_tags" className="mt-6">
            <NoteTagsManagement />
          </TabsContent>
        </Tabs>
      </div>
    </PermissionGuard>
  );
}
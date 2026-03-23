import { useState, useMemo } from "react";
import React from "react";
import { api } from "@/api/supabaseClient";
import { useMutation } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Plus, Search, Edit, Trash2, ChevronDown, ChevronRight, History, Camera, BookOpen, LayoutList, Grid3x3, Trello, GitBranch } from "lucide-react";
import ProjectTypeFilter from "../components/settings/ProjectTypeFilter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import PackageGridView from "../components/products/PackageGridView";
import PackageKanbanView from "../components/products/PackageKanbanView";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";

import PackageActivityFeed from "../components/products/PackageActivityFeed";
import PackageSnapshotsPanel from "../components/products/PackageSnapshotsPanel";
import ProductsPackagesRulebook from "../components/products/ProductsPackagesRulebook";
import ProductCategoryHierarchy from "../components/hierarchy/ProductCategoryHierarchy";
import ImpactWarningDialog from "../components/products/ImpactWarningDialog";
import DeleteConfirmationDialog from "../components/common/DeleteConfirmationDialog";
import PackageFormDialog from "../components/products/PackageFormDialog";

const EMPTY_TIER = { package_price: 0, scheduling_time: 0, admin_time: 0, editor_time: 0 };
const INITIAL_FORM = {
  name: "", description: "", products: [],
  project_type_ids: [],
  standard_tier: { ...EMPTY_TIER },
  premium_tier: { ...EMPTY_TIER },
  standard_task_templates: [],
  premium_task_templates: [],
  is_active: true
};

function getChangedFields(oldData, newData) {
  const fields = [];
  const scalarFields = [
    ["name", oldData?.name, newData?.name],
    ["description", oldData?.description, newData?.description],
    ["standard_tier.package_price", oldData?.standard_tier?.package_price, newData?.standard_tier?.package_price],
    ["premium_tier.package_price", oldData?.premium_tier?.package_price, newData?.premium_tier?.package_price],
    ["is_active", oldData?.is_active, newData?.is_active],
  ];
  for (const [field, oldVal, newVal] of scalarFields) {
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      fields.push({ field, old_value: String(oldVal ?? ""), new_value: String(newVal ?? "") });
    }
  }
  // Detect array/nested changes (task templates, products, project types)
  const arrayFields = ["standard_task_templates", "premium_task_templates", "products", "project_type_ids"];
  for (const field of arrayFields) {
    const oldJson = JSON.stringify(oldData?.[field] || []);
    const newJson = JSON.stringify(newData?.[field] || []);
    if (oldJson !== newJson) {
      const oldCount = (oldData?.[field] || []).length;
      const newCount = (newData?.[field] || []).length;
      fields.push({ field, old_value: `${oldCount} item(s)`, new_value: `${newCount} item(s)` });
    }
  }
  return fields;
}

import { usePermissions } from '@/components/auth/PermissionGuard';
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';

export default function PackagesPage() {
  const { canAccessSettings } = usePermissions();
  const { canEdit, canView } = useEntityAccess('packages');
  if (!canAccessSettings) {
    return <div className="p-8 text-center text-muted-foreground">Access denied</div>;
  }
  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;
  const [showDialog, setShowDialog] = useState(false);
  const [editingPackage, setEditingPackage] = useState(null);
  const [deletingPackage, setDeletingPackage] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedPackages, setExpandedPackages] = useState({});
  const [showImpactDialog, setShowImpactDialog] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState(null);
  const [viewMode, setViewMode] = useState("table");
  const [filterTypeId, setFilterTypeId] = useState(null);

  const { data: packages, loading: packagesLoading, refetch: refetchPackages } = useEntityList("Package", "-created_date");
  const { data: products } = useEntityList("Product", "name");
  const { data: projectTypes = [] } = useEntityList("ProjectType", "order");
  const { data: priceMatrices = [] } = useEntityList("PriceMatrix");
  const { data: projects = [] } = useEntityList("Project");
  const { data: projectTasks = [] } = useEntityList("ProjectTask");
  const { data: packageSnapshots = [] } = useEntityList("PackageSnapshot");
  const { data: projectActivities = [] } = useEntityList("ProjectActivity");

  // Pass all active products to the dialog for selection
  const availableProducts = products.filter(p => p.is_active);

  const logChange = async (action, pkg, previousState, newState) => {
    const user = await api.auth.me().catch(() => null);
    const changedFields = action === "update" ? getChangedFields(previousState, newState) : [];
    const summaryParts = changedFields.map(f => `${f.field}: ${f.old_value} → ${f.new_value}`);

    await api.entities.PackageAuditLog.create({
      package_id: pkg.id || "new",
      package_name: pkg.name,
      action,
      user_email: user?.email || "",
      user_name: user?.full_name || user?.email || "Unknown",
      changes_summary: action === "create"
        ? `Created package "${pkg.name}"`
        : action === "delete"
          ? `Deleted package "${pkg.name}"`
          : summaryParts.length > 0
            ? summaryParts.join("; ")
            : `Updated package "${pkg.name}"`,
      previous_state: previousState || {},
      new_state: newState || {},
      changed_fields: changedFields
    }).catch(() => {});
  };

  const getImpactedItems = (pkg, newData) => {
    const changes = getChangedFields(pkg, newData);
    const impactedMatrices = priceMatrices
      .filter(pm => pm.package_pricing?.some(pp => pp.package_id === pkg.id))
      .map(pm => pm.entity_name);
    const impactedProjects = projects
      .filter(proj => proj.status !== "delivered" && proj.packages?.some(p => p.package_id === pkg.id))
      .map(proj => proj.title);
    const impactedTasks = projectTasks
      .filter(task => task.package_id === pkg.id)
      .map(task => task.title);
    const impactedSnapshots = packageSnapshots
      .filter(snap => snap.package_id === pkg.id)
      .map(snap => `${snap.package_name} (${new Date(snap.created_date).toLocaleDateString()})`);
    const impactedActivities = projectActivities
      .filter(act => act.description?.includes(pkg.name) || act.new_state?.name === pkg.name)
      .length;
    
    return {
      changes,
      impacts: {
        pricing: impactedMatrices,
        projects: impactedProjects,
        tasks: impactedTasks,
        snapshots: impactedSnapshots,
        activity: impactedActivities > 0 ? [`${impactedActivities} activity log${impactedActivities > 1 ? 's' : ''}`] : []
      }
    };
  };

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (editingPackage) {
        const result = await api.entities.Package.update(editingPackage.id, data);
        await logChange("update", { id: editingPackage.id, name: data.name }, editingPackage, data);
        return result;
      }
      const result = await api.entities.Package.create(data);
      await logChange("create", { id: result.id, name: data.name }, null, data);
      return result;
    },
    onSuccess: async () => {
      await refetchEntityList("Package");
      refetchEntityList("Product");
      refetchEntityList("PriceMatrix");
      const action = editingPackage ? "updated" : "created";
      toast.success(`Package "${editingPackage?.name || pendingSaveData?.name}" ${action}`);
      handleClose();
      setShowImpactDialog(false);
      setPendingSaveData(null);
    },
    onError: (e) => toast.error(e.message || "Failed to save")
  });

  const handleSaveWithImpactCheck = (data) => {
    if (!editingPackage) {
      saveMutation.mutate(data);
      return;
    }
    const { changes, impacts } = getImpactedItems(editingPackage, data);
    const hasImpact = Object.values(impacts).some(arr => arr.length > 0);
    if (hasImpact) {
      setPendingSaveData(data);
      setShowImpactDialog(true);
    } else {
      saveMutation.mutate(data);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (pkg) => {
      await api.entities.Package.delete(pkg.id);
      await logChange("delete", { id: pkg.id, name: pkg.name }, pkg, null);
    },
    onSuccess: async () => {
      await refetchEntityList("Package");
      refetchEntityList("PriceMatrix");
      toast.success(`Package "${deletingPackage?.name}" deleted`);
      setDeletingPackage(null);
    },
    onError: (e) => toast.error(e.message || "Failed to delete")
  });

  const handleOpen = async (pkg = null) => {
    setEditingPackage(pkg);
    setShowDialog(true);
  };

  const handleClose = () => { setShowDialog(false); setEditingPackage(null); };
  const toggleExpanded = (id) => setExpandedPackages(prev => ({ ...prev, [id]: !prev[id] }));



  const filteredPackages = packages.filter(p => {
    const matchesSearch = p.name?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = !filterTypeId
      ? true
      : (p.project_type_ids || []).includes(filterTypeId);
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Packages <AccessBadge entityType="packages" /></h1>
        <p className="text-muted-foreground mt-1">Manage product bundles with tier variants</p>
      </div>

      <Tabs defaultValue="packages">
        <TabsList>
          <TabsTrigger value="packages">Packages</TabsTrigger>
          <TabsTrigger value="hierarchy">
            <GitBranch className="h-4 w-4 mr-1.5" />
            Hierarchy
          </TabsTrigger>
          <TabsTrigger value="activity">
            <History className="h-4 w-4 mr-1.5" />
            Activity Log
          </TabsTrigger>
          <TabsTrigger value="snapshots">
            <Camera className="h-4 w-4 mr-1.5" />
            Snapshots
          </TabsTrigger>
          <TabsTrigger value="rulebook">
            <BookOpen className="h-4 w-4 mr-1.5" />
            Rulebook
          </TabsTrigger>
        </TabsList>

        <TabsContent value="packages" className="mt-6 space-y-4">
          <div className="flex flex-col gap-3">
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search packages..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>
            <div className="flex gap-1 border rounded-lg p-1 bg-muted">
              <Button
                variant={viewMode === "table" ? "default" : "ghost"}
                size="sm"
                onClick={() => setViewMode("table")}
                className="h-8 w-8 p-0"
                title="Table view"
              >
                <LayoutList className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "grid" ? "default" : "ghost"}
                size="sm"
                onClick={() => setViewMode("grid")}
                className="h-8 w-8 p-0"
                title="Grid view"
              >
                <Grid3x3 className="h-4 w-4" />
              </Button>
              <Button
                variant={viewMode === "kanban" ? "default" : "ghost"}
                size="sm"
                onClick={() => setViewMode("kanban")}
                className="h-8 w-8 p-0"
                title="Kanban view"
              >
                <Trello className="h-4 w-4" />
              </Button>
            </div>
            <Button onClick={() => handleOpen()} className="gap-2" disabled={!canEdit}>
              <Plus className="h-4 w-4" />
              Add Package
            </Button>
          </div>
            <ProjectTypeFilter selectedTypeId={filterTypeId} onChange={setFilterTypeId} />
          </div>

          {packagesLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : viewMode === "grid" ? (
            <PackageGridView packages={filteredPackages} onEdit={handleOpen} onDelete={setDeletingPackage} projectTypes={projectTypes} />
          ) : viewMode === "kanban" ? (
            <PackageKanbanView packages={filteredPackages} onEdit={handleOpen} onDelete={setDeletingPackage} projectTypes={projectTypes} />
          ) : (
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Package Name</TableHead>
                    <TableHead>Project Type</TableHead>
                    <TableHead>Products</TableHead>
                    <TableHead>Standard Price</TableHead>
                    <TableHead>Premium Price</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredPackages.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                        {searchQuery ? "No packages match your search" : "No packages yet. Add your first package."}
                      </TableCell>
                    </TableRow>
                  ) : filteredPackages.map((pkg) => {
                    const isExpanded = expandedPackages[pkg.id];
                    return (
                      <React.Fragment key={pkg.id}>
                        <TableRow className="hover:bg-muted/50">
                          <TableCell>
                            <Button variant="ghost" size="sm" onClick={() => toggleExpanded(pkg.id)} className="h-6 w-6 p-0">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">{pkg.name}</TableCell>
                          <TableCell>
                            {(() => {
                              const typeId = (pkg.project_type_ids || [])[0];
                              const type = typeId ? projectTypes.find(t => t.id === typeId) : null;
                              return type ? (
                                <span
                                  className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium text-white"
                                  style={{ backgroundColor: type.color || "#3b82f6" }}
                                >
                                  {type.name}
                                </span>
                              ) : (
                                <span className="text-xs text-muted-foreground">All</span>
                              );
                            })()}
                          </TableCell>
                          <TableCell>
                            <span className="text-sm text-muted-foreground">{pkg.products?.length || 0} products</span>
                          </TableCell>
                          <TableCell className="font-medium">${pkg.standard_tier?.package_price?.toFixed(2) || "0.00"}</TableCell>
                          <TableCell className="font-medium">${pkg.premium_tier?.package_price?.toFixed(2) || "0.00"}</TableCell>
                          <TableCell>
                            <Badge variant="outline" className={pkg.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100"}>
                              {pkg.is_active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => handleOpen(pkg)} disabled={!canEdit}>
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeletingPackage(pkg)} className="text-destructive hover:text-destructive" disabled={!canEdit}>
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>

                        {isExpanded && (
                          <>
                            <TableRow className="bg-muted/50">
                              <TableCell></TableCell>
                              <TableCell className="pl-8 font-medium text-sm" colSpan={5}>Products Included:</TableCell>
                            </TableRow>
                            {pkg.products?.map((item, idx) => (
                              <TableRow key={idx} className="bg-muted/20">
                                <TableCell></TableCell>
                                <TableCell className="pl-12 text-sm" colSpan={2}>{item.product_name}</TableCell>
                                <TableCell className="text-sm text-muted-foreground" colSpan={3}>Qty: {item.quantity}</TableCell>
                              </TableRow>
                            ))}
                            {[
                              { label: "Standard", tier: pkg.standard_tier },
                              { label: "Premium", tier: pkg.premium_tier }
                            ].map(({ label, tier }) => (
                              <TableRow key={label} className="bg-muted/30">
                                <TableCell></TableCell>
                                <TableCell className="pl-8 text-sm font-medium" colSpan={2}>{label} Tier</TableCell>
                                <TableCell className="text-sm">${tier?.package_price?.toFixed(2) || "0.00"}</TableCell>
                                <TableCell className="text-sm" colSpan={3}>
                                  <div className="flex gap-4 text-xs text-muted-foreground">
                                    <span>Scheduling: {tier?.scheduling_time || 0}min</span>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </>
                        )}
                      </React.Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            )}
        </TabsContent>

        <TabsContent value="hierarchy" className="mt-6">
          <ProductCategoryHierarchy />
        </TabsContent>

        <TabsContent value="activity" className="mt-6">
          <PackageActivityFeed />
        </TabsContent>

        <TabsContent value="snapshots" className="mt-6">
          <PackageSnapshotsPanel />
        </TabsContent>

        <TabsContent value="rulebook" className="mt-6">
          <ProductsPackagesRulebook />
        </TabsContent>
      </Tabs>

      {/* Package Form Dialog */}
      <PackageFormDialog
        key={editingPackage?.id || 'new'}
        open={showDialog}
        onClose={handleClose}
        package={editingPackage}
        onSave={handleSaveWithImpactCheck}
        presetTypeId={filterTypeId}
        availableProducts={availableProducts}
        products={products}
        projectTypes={projectTypes}
      />

      {editingPackage && pendingSaveData && (
        <ImpactWarningDialog
          open={showImpactDialog}
          onOpenChange={setShowImpactDialog}
          itemName={editingPackage.name}
          itemType="package"
          changes={getChangedFields(editingPackage, pendingSaveData)}
          impacts={getImpactedItems(editingPackage, pendingSaveData).impacts}
          onConfirm={() => saveMutation.mutate(pendingSaveData)}
          isPending={saveMutation.isPending}
        />
      )}

      <DeleteConfirmationDialog
        open={!!deletingPackage}
        itemName={deletingPackage?.name}
        itemType="package"
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deletingPackage)}
        onCancel={() => setDeletingPackage(null)}
      />
    </div>
  );
}
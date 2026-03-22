import React, { useState, useMemo } from "react";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList } from "@/components/hooks/useEntityData";
import { Plus, Search, Edit, Trash2, ChevronDown, ChevronRight, History, Camera, BookOpen, LayoutList, Grid3x3, Trello, GitBranch } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import ProductGridView from "../components/products/ProductGridView";
import ProductKanbanView from "../components/products/ProductKanbanView";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { toast } from "sonner";
import ProductFormDialog from "../components/products/ProductFormDialog";
import ProductActivityFeed from "../components/products/ProductActivityFeed";
import ProductSnapshotsPanel from "../components/products/ProductSnapshotsPanel";
import ProductsPackagesRulebook from "../components/products/ProductsPackagesRulebook";
import ProductPackageHierarchy from "../components/hierarchy/ProductPackageHierarchy";
import ProductCategoryHierarchy from "../components/hierarchy/ProductCategoryHierarchy";
import ImpactWarningDialog from "../components/products/ImpactWarningDialog";
import DeleteConfirmationDialog from "../components/common/DeleteConfirmationDialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const categories = {
  photography: "Photography",
  video: "Video",
  drone: "Drone",
  editing: "Editing",
  virtual_staging: "Virtual Staging",
  other: "Other"
};

function getChangedFields(oldData, newData) {
  const fields = [];
  const scalarFields = [
    ["standard_tier.base_price", oldData?.standard_tier?.base_price, newData?.standard_tier?.base_price],
    ["standard_tier.unit_price", oldData?.standard_tier?.unit_price, newData?.standard_tier?.unit_price],
    ["premium_tier.base_price", oldData?.premium_tier?.base_price, newData?.premium_tier?.base_price],
    ["premium_tier.unit_price", oldData?.premium_tier?.unit_price, newData?.premium_tier?.unit_price],
    ["name", oldData?.name, newData?.name],
    ["category", oldData?.category, newData?.category],
    ["is_active", oldData?.is_active, newData?.is_active],
    ["pricing_type", oldData?.pricing_type, newData?.pricing_type],
    ["min_quantity", oldData?.min_quantity, newData?.min_quantity],
    ["max_quantity", oldData?.max_quantity, newData?.max_quantity],
  ];
  for (const [field, oldVal, newVal] of scalarFields) {
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      fields.push({ field, old_value: String(oldVal ?? ""), new_value: String(newVal ?? "") });
    }
  }
  // Detect task template changes (compared as JSON for deep equality)
  const arrayFields = ["standard_task_templates", "premium_task_templates", "project_type_ids"];
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
export default function ProductsPage() {
  const { canAccessSettings } = usePermissions();
  if (!canAccessSettings) {
    return <div className="p-8 text-center text-muted-foreground">Access denied</div>;
  }
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [deletingProduct, setDeletingProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedProducts, setExpandedProducts] = useState({});
  const [showImpactDialog, setShowImpactDialog] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState(null);
  const [viewMode, setViewMode] = useState("table");

  const { data: products, loading: isLoading } = useEntityList("Product", "-created_date");
  const { data: packages = [] } = useEntityList("Package");
  const { data: priceMatrices = [] } = useEntityList("PriceMatrix");
  const { data: projects = [] } = useEntityList("Project");
  const { data: projectTasks = [] } = useEntityList("ProjectTask");
  const { data: productSnapshots = [] } = useEntityList("ProductSnapshot");
  // Note: projectActivities intentionally omitted — too expensive to load for all products
  const projectActivities = [];

  const logChange = async (action, product, previousState, newState) => {
    if (!product) return;
    
    const user = await api.auth.me().catch(() => null);
    const changedFields = action === "update" ? getChangedFields(previousState, newState) : [];
    const summaryParts = changedFields.map(f => `${f?.field || 'unknown'}: ${f?.old_value || ''} → ${f?.new_value || ''}`);

    await api.entities.ProductAuditLog.create({
      product_id: product.id || "new",
      product_name: product?.name || "Unnamed Product",
      action,
      user_email: user?.email || "",
      user_name: user?.full_name || user?.email || "Unknown",
      changes_summary: action === "create"
        ? `Created product "${product?.name || 'Unnamed'}"`
        : action === "delete"
          ? `Deleted product "${product?.name || 'Unnamed'}"`
          : summaryParts.length > 0
            ? summaryParts.join("; ")
            : `Updated product "${product?.name || 'Unnamed'}"`,
      previous_state: previousState || {},
      new_state: newState || {},
      changed_fields: changedFields
    }).catch(() => {});
  };

  const getImpactedItems = (product, newData) => {
    if (!product || !newData) return { changes: [], impacts: {} };
    
    const changes = getChangedFields(product, newData);
    const impactedPackages = (packages || [])
      .filter(pkg => pkg?.products?.some(p => p?.product_id === product.id))
      .map(pkg => pkg?.name || 'Unnamed');
    const impactedMatrices = (priceMatrices || [])
      .filter(pm => pm?.product_pricing?.some(pp => pp?.product_id === product.id))
      .map(pm => pm?.entity_name || 'Unnamed');
    // "delivered" is the terminal status in Project — exclude it from impact count
    const impactedProjects = (projects || [])
      .filter(proj => proj?.status !== "delivered" && proj?.products?.some(p => p?.product_id === product.id))
      .map(proj => proj?.title || 'Untitled');
    const impactedTasks = (projectTasks || [])
      .filter(task => task?.product_id === product.id)
      .map(task => task?.title || 'Untitled');
    const impactedSnapshots = (productSnapshots || [])
      .filter(snap => snap?.product_id === product.id)
      .map(snap => `${snap?.product_name || 'Unknown'} (${snap?.created_date ? new Date(snap.created_date).toLocaleDateString() : 'N/A'})`);
    const impactedActivities = (projectActivities || [])
      .filter(act => act?.description?.includes(product.name) || act?.new_state?.name === product.name)
      .length;
    
    return {
      changes,
      impacts: {
        packages: impactedPackages,
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
      if (!data) throw new Error("Invalid data");
      
      if (editingProduct) {
        const result = await api.entities.Product.update(editingProduct.id, data);
        await logChange("update", { id: editingProduct.id, name: data.name }, editingProduct, data);
        return result;
      }
      const result = await api.entities.Product.create(data);
      await logChange("create", { id: result?.id, name: data.name }, null, data);
      return result;
    },
    onSuccess: (result, data) => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["packages"] });
      queryClient.invalidateQueries({ queryKey: ["price-matrix"] });
      const action = editingProduct ? "updated" : "created";
      const productName = data?.name || "Product";
      toast.success(`Product "${productName}" ${action}`);
      handleClose();
    },
    onError: (e) => toast.error(e?.message || "Failed to save")
  });

  const handleSaveWithImpactCheck = (data) => {
    if (!editingProduct) {
      saveMutation.mutate(data);
      return;
    }

    // Check if type restriction changed — warn about existing packages/projects
    const oldTypeIds = editingProduct?.project_type_ids || [];
    const newTypeIds = data?.project_type_ids || [];
    const isTypeChanged = JSON.stringify([...oldTypeIds].sort()) !== JSON.stringify([...newTypeIds].sort());

    if (isTypeChanged && newTypeIds.length > 0 && oldTypeIds.length === 0 && newTypeIds[0]) {
      // Product is now type-restricted — warn about packages/projects that may no longer be compatible
      const affectedPackages = (packages || [])
        .filter(pkg => pkg?.products?.some(p => p?.product_id === editingProduct?.id) && 
                (pkg?.project_type_ids || []).length > 0 &&
                !pkg.project_type_ids.includes(newTypeIds[0]))
        .map(pkg => pkg?.name || 'Unnamed');
      
      const affectedProjects = (projects || [])
        .filter(proj => proj?.products?.some(p => p?.product_id === editingProduct?.id) && 
                proj?.project_type_id && 
                !newTypeIds.includes(proj.project_type_id))
        .map(proj => proj?.title || 'Untitled');
      
      if (affectedPackages.length > 0 || affectedProjects.length > 0) {
        const msg = [
          affectedPackages.length > 0 && `${affectedPackages.length} package(s)`,
          affectedProjects.length > 0 && `${affectedProjects.length} project(s)`
        ].filter(Boolean).join(" and ");
        
        toast.warning(`This product is now type-restricted and no longer applies to ${msg}`);
      }
    }

    const { changes, impacts } = getImpactedItems(editingProduct, data);
    const hasImpact = Object.values(impacts).some(arr => arr.length > 0);
    if (hasImpact) {
      setPendingSaveData(data);
      setShowImpactDialog(true);
    } else {
      saveMutation.mutate(data);
    }
  };

  const deleteMutation = useMutation({
    mutationFn: async (product) => {
      if (!product?.id) throw new Error("Invalid product");
      await api.entities.Product.delete(product.id);
      await logChange("delete", { id: product.id, name: product.name }, product, null);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["packages"] });
      queryClient.invalidateQueries({ queryKey: ["price-matrix"] });
      toast.success(`Product "${deletingProduct?.name || 'Product'}" deleted`);
      setDeletingProduct(null);
    },
    onError: (e) => toast.error(e?.message || "Failed to delete")
  });

  const handleOpen = (product = null) => { setEditingProduct(product); setShowDialog(true); };
  const handleClose = () => { 
    setShowDialog(false); 
    setEditingProduct(null); 
    setPendingSaveData(null);
    setShowImpactDialog(false);
  };
  const toggleExpanded = (id) => setExpandedProducts(prev => ({ ...prev, [id]: !prev[id] }));

  const filteredProducts = useMemo(() => 
    (products || []).filter(p =>
      p?.name?.toLowerCase().includes(searchQuery.toLowerCase())
    ),
    [products, searchQuery]
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-muted-foreground mt-1">Manage products with tier variants</p>
        </div>
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">Products</TabsTrigger>
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

        <TabsContent value="products" className="mt-6 space-y-4">
          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search products..."
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
            <Button onClick={() => handleOpen()} className="gap-2">
              <Plus className="h-4 w-4" />
              Add Product
            </Button>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : viewMode === "grid" ? (
            <ProductGridView products={filteredProducts} onEdit={handleOpen} onDelete={setDeletingProduct} />
          ) : viewMode === "kanban" ? (
            <ProductKanbanView products={filteredProducts} onEdit={handleOpen} onDelete={setDeletingProduct} />
          ) : (
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Product Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Pricing</TableHead>
                    <TableHead>Standard</TableHead>
                    <TableHead>Premium</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredProducts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                        {searchQuery ? "No products match your search" : "No products yet. Add your first product."}
                      </TableCell>
                    </TableRow>
                  ) : filteredProducts.map((product) => {
                    const isExpanded = expandedProducts[product.id];
                    return (
                      <React.Fragment key={product.id}>
                        <TableRow className="hover:bg-muted/50">
                          <TableCell>
                            <Button variant="ghost" size="sm" onClick={() => toggleExpanded(product.id)} className="h-6 w-6 p-0">
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                          </TableCell>
                          <TableCell className="font-medium">{product.name}</TableCell>
                          <TableCell>
                            <Badge variant={product.product_type === "core" ? "default" : "secondary"}>
                              {product.product_type === "core" ? "Core" : "Add-on"}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{categories[product.category] || product.category}</Badge>
                          </TableCell>
                          <TableCell>{product.pricing_type === "per_unit" ? "Per Unit" : "Fixed"}</TableCell>
                          <TableCell>
                            ${(product.standard_tier?.base_price ?? 0).toFixed(2)}
                            {product.pricing_type === "per_unit" && (product.standard_tier?.unit_price ?? 0) > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">+ ${(product.standard_tier.unit_price ?? 0).toFixed(2)}/unit</span>
                            )}
                          </TableCell>
                          <TableCell>
                            ${(product.premium_tier?.base_price ?? 0).toFixed(2)}
                            {product.pricing_type === "per_unit" && (product.premium_tier?.unit_price ?? 0) > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">+ ${(product.premium_tier.unit_price ?? 0).toFixed(2)}/unit</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline" className={product.is_active ? "bg-green-50 text-green-700 border-green-200" : "bg-gray-100"}>
                              {product.is_active ? "Active" : "Inactive"}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex gap-1 justify-end">
                              <Button variant="ghost" size="sm" onClick={() => handleOpen(product)}>
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost" size="sm" onClick={() => setDeletingProduct(product)} className="text-destructive hover:text-destructive">
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>

                        {isExpanded && (
                          <>
                            <TableRow className="bg-muted/30">
                              <TableCell></TableCell>
                              <TableCell className="pl-8 text-sm font-medium" colSpan={2}>Standard Tier</TableCell>
                              <TableCell className="text-sm">
                                ${(product.standard_tier?.base_price ?? 0).toFixed(2)}
                                {product.pricing_type === "per_unit" && ` + $${(product.standard_tier?.unit_price ?? 0).toFixed(2)}/unit`}
                              </TableCell>
                              <TableCell className="text-sm" colSpan={4}>
                                <div className="flex gap-4 text-xs text-muted-foreground">
                                  <span>On-site: {product.standard_tier?.onsite_time ?? 0}min</span>
                                  <span>Admin: {product.standard_tier?.admin_time ?? 0}min</span>
                                  <span>Editor: {product.standard_tier?.editor_time ?? 0}min</span>
                                </div>
                              </TableCell>
                            </TableRow>
                            <TableRow className="bg-muted/30">
                              <TableCell></TableCell>
                              <TableCell className="pl-8 text-sm font-medium" colSpan={2}>Premium Tier</TableCell>
                              <TableCell className="text-sm">
                                ${(product.premium_tier?.base_price ?? 0).toFixed(2)}
                                {product.pricing_type === "per_unit" && ` + $${(product.premium_tier?.unit_price ?? 0).toFixed(2)}/unit`}
                              </TableCell>
                              <TableCell className="text-sm" colSpan={4}>
                                <div className="flex gap-4 text-xs text-muted-foreground">
                                  <span>On-site: {product.premium_tier?.onsite_time ?? 0}min</span>
                                  <span>Admin: {product.premium_tier?.admin_time ?? 0}min</span>
                                  <span>Editor: {product.premium_tier?.editor_time ?? 0}min</span>
                                </div>
                              </TableCell>
                            </TableRow>
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

        <TabsContent value="hierarchy" className="mt-6 space-y-6">
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Product & Package Relationships</h3>
              <p className="text-sm text-muted-foreground">View which products are included in packages and their pricing tiers.</p>
            </div>
            <ProductPackageHierarchy />
          </div>
          <div className="border-t pt-6 space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Product Category Hierarchy</h3>
              <p className="text-sm text-muted-foreground">Organized by project type → category → product → package relationships.</p>
            </div>
            <ProductCategoryHierarchy />
          </div>
        </TabsContent>

        <TabsContent value="activity" className="mt-6">
          <ProductActivityFeed />
        </TabsContent>

        <TabsContent value="snapshots" className="mt-6">
          <ProductSnapshotsPanel />
        </TabsContent>

        <TabsContent value="rulebook" className="mt-6">
          <ProductsPackagesRulebook />
        </TabsContent>
      </Tabs>

      <ProductFormDialog
        key={editingProduct?.id || "new"}
        open={showDialog}
        onClose={handleClose}
        product={editingProduct}
        onSave={handleSaveWithImpactCheck}
      />

      {editingProduct && pendingSaveData && (
        <ImpactWarningDialog
          open={showImpactDialog}
          onOpenChange={setShowImpactDialog}
          itemName={editingProduct.name}
          itemType="product"
          changes={getChangedFields(editingProduct, pendingSaveData)}
          impacts={getImpactedItems(editingProduct, pendingSaveData).impacts}
          onConfirm={() => saveMutation.mutate(pendingSaveData)}
          isPending={saveMutation.isPending}
        />
      )}

      <DeleteConfirmationDialog
        open={!!deletingProduct}
        itemName={deletingProduct?.name}
        itemType="product"
        isLoading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate(deletingProduct)}
        onCancel={() => setDeletingProduct(null)}
      />
    </div>
  );
}
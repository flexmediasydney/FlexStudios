import React, { useState } from "react";
import { fmtTimestampCustom } from "@/components/utils/dateUtils";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { Plus, Search, Edit, Trash2, ChevronDown, ChevronRight, GitBranch, History, Camera, BookOpen, LayoutList, Grid3x3, Trello } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import ProductGridView from "../products/ProductGridView";
import ProductKanbanView from "../products/ProductKanbanView";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import ProductActivityFeed from "../products/ProductActivityFeed";
import ProductSnapshotsPanel from "../products/ProductSnapshotsPanel";
import ProductsPackagesRulebook from "../products/ProductsPackagesRulebook";
import ProductPackageHierarchy from "../hierarchy/ProductPackageHierarchy";
import ProductFormDialog from "../products/ProductFormDialog";
import ImpactWarningDialog from "../products/ImpactWarningDialog";
import ProjectTypeFilter from "./ProjectTypeFilter";
import DeleteConfirmationDialog from "../common/DeleteConfirmationDialog";
import DataIntegrityMonitor from "../products/DataIntegrityMonitor";



function getChangedFields(oldData, newData) {
  const fields = [];
  const checks = [
    ["name", oldData?.name, newData?.name],
    ["pricing_type", oldData?.pricing_type, newData?.pricing_type],
    ["standard_tier.base_price", oldData?.standard_tier?.base_price, newData?.standard_tier?.base_price],
    ["premium_tier.base_price", oldData?.premium_tier?.base_price, newData?.premium_tier?.base_price],
    ["is_active", oldData?.is_active, newData?.is_active],
  ];
  for (const [field, oldVal, newVal] of checks) {
    if (String(oldVal ?? "") !== String(newVal ?? "")) {
      fields.push({ field, old_value: String(oldVal ?? ""), new_value: String(newVal ?? "") });
    }
  }
  return fields;
}

export default function ProductsManagement() {
  const queryClient = useQueryClient();
  const [showDialog, setShowDialog] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [deletingProduct, setDeletingProduct] = useState(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedProducts, setExpandedProducts] = useState({});
  const [showImpactDialog, setShowImpactDialog] = useState(false);
  const [pendingSaveData, setPendingSaveData] = useState(null);
  const [viewMode, setViewMode] = useState("table");
  const [filterTypeId, setFilterTypeId] = useState(null);

  const { data: products, loading: isLoading } = useEntityList("Product", "-created_date");
  const { data: packages = [] } = useEntityList("Package");
  const { data: priceMatrices = [] } = useEntityList("PriceMatrix");
  const { data: projects = [] } = useEntityList("Project");
  const { data: projectTasks = [] } = useEntityList("ProjectTask");
  const { data: productSnapshots = [] } = useEntityList("ProductSnapshot");
  const { data: projectActivities = [] } = useEntityList("ProjectActivity");
  const { data: productCategories = [] } = useEntityList("ProductCategory");

  const logChange = async (action, product, previousState, newState) => {
    const user = await api.auth.me().catch(() => null);
    const changedFields = action === "update" ? getChangedFields(previousState, newState) : [];
    const summaryParts = changedFields.map(f => `${f.field}: ${f.old_value} → ${f.new_value}`);

    await api.entities.ProductAuditLog.create({
      product_id: product.id || "new",
      product_name: product.name,
      action,
      user_email: user?.email || "",
      user_name: user?.full_name || user?.email || "Unknown",
      changes_summary: action === "create"
        ? `Created product "${product.name}"`
        : action === "delete"
          ? `Deleted product "${product.name}"`
          : summaryParts.length > 0
            ? summaryParts.join("; ")
            : `Updated product "${product.name}"`,
      previous_state: previousState || {},
      new_state: newState || {},
      changed_fields: changedFields
    }).catch(() => {});
  };

  const getImpactedItems = (product, newData) => {
    const changes = getChangedFields(product, newData);
    const impactedPackages = packages
      .filter(pkg => pkg.products?.some(p => p.product_id === product.id))
      .map(pkg => pkg.name);
    const impactedMatrices = priceMatrices
      .filter(pm => pm.product_pricing?.some(pp => pp.product_id === product.id))
      .map(pm => pm.entity_name);
    const impactedProjects = projects
      .filter(proj => proj.status !== "completed" && proj.products?.some(p => p.product_id === product.id))
      .map(proj => proj.title);
    const impactedTasks = projectTasks
      .filter(task => task.product_id === product.id)
      .map(task => task.title);
    const impactedSnapshots = productSnapshots
      .filter(snap => snap.product_id === product.id)
      .map(snap => `${snap.product_name} (${fmtTimestampCustom(snap.created_date, { day: 'numeric', month: 'short', year: 'numeric' })})`);
    const impactedActivities = projectActivities
      .filter(act => act.description?.includes(product.name) || act.new_state?.name === product.name)
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
      if (editingProduct) {
        const result = await api.entities.Product.update(editingProduct.id, data);
        await logChange("update", { id: editingProduct.id, name: data.name }, editingProduct, data);
        return result;
      }
      const result = await api.entities.Product.create(data);
      await logChange("create", { id: result.id, name: data.name }, null, data);
      return result;
    },
    onSuccess: () => {
      // useEntityList uses shared cache (not react-query), so use refetchEntityList
      refetchEntityList("Product");
      const action = editingProduct ? "updated" : "created";
      toast.success(`Product "${editingProduct?.name || pendingSaveData?.name}" ${action}`);
      handleClose();
      setShowImpactDialog(false);
      setPendingSaveData(null);
    },
    onError: (e) => toast.error(e.message || "Failed to save")
  });

  const handleSaveWithImpactCheck = (data) => {
    if (!editingProduct) {
      saveMutation.mutate(data);
      return;
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
      await api.entities.Product.delete(product.id);
      await logChange("delete", { id: product.id, name: product.name }, product, null);
    },
    onSuccess: () => {
      refetchEntityList("Product");
      toast.success(`Product "${deletingProduct?.name}" deleted`);
      setDeletingProduct(null);
    },
    onError: (e) => toast.error(e.message || "Failed to delete")
  });

  const handleOpen = (product = null) => { setEditingProduct(product); setShowDialog(true); };
  const handleClose = () => { setShowDialog(false); setEditingProduct(null); };
  const toggleExpanded = (id) => setExpandedProducts(prev => ({ ...prev, [id]: !prev[id] }));

  const { data: projectTypes = [] } = useEntityList("ProjectType", "order");

  const filteredProducts = products.filter(p => {
    const matchesSearch = p.name?.toLowerCase().includes(searchQuery.toLowerCase());
    // When a type is selected: only show products explicitly tagged for that type
    // When no type (All): show everything
    const matchesType = !filterTypeId
      ? true
      : (p.project_type_ids || []).includes(filterTypeId);
    return matchesSearch && matchesType;
  });

  return (
    <div className="space-y-6">
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
          <div className="mb-4">
            <DataIntegrityMonitor />
          </div>

          <div className="flex flex-col gap-3">
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
            <ProjectTypeFilter selectedTypeId={filterTypeId} onChange={setFilterTypeId} />
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center p-12">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
            </div>
          ) : viewMode === "grid" ? (
            <ProductGridView products={filteredProducts} onEdit={handleOpen} onDelete={setDeletingProduct} projectTypes={projectTypes} />
          ) : viewMode === "kanban" ? (
            <ProductKanbanView products={filteredProducts} onEdit={handleOpen} onDelete={setDeletingProduct} projectTypes={projectTypes} />
          ) : (
            <div className="border rounded-lg">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-12"></TableHead>
                    <TableHead>Product Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Project Type</TableHead>
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
                      <TableCell colSpan={10} className="text-center py-12 text-muted-foreground">
                        {searchQuery ? "No products match your search" : "No products yet. Add your first product."}
                      </TableCell>
                    </TableRow>
                  ) : filteredProducts.flatMap((product) => {
                    const isExpanded = expandedProducts[product.id];
                    const rows = [
                        <TableRow key={`${product.id}-main`} className="hover:bg-muted/50">
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
                            {(() => {
                              const typeId = (product.project_type_ids || [])[0];
                              const type = typeId ? projectTypes.find(t => t.id === typeId) : null;
                              return type ? (
                                <span
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium text-white"
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
                            {(() => {
                              const cat = productCategories.find(c => c.name === product.category);
                              return cat ? (
                                <Badge variant="outline" style={{ 
                                  backgroundColor: cat.color + '20',
                                  color: cat.color,
                                  borderColor: cat.color
                                }}>
                                  {cat.icon} {cat.name}
                                </Badge>
                              ) : (
                                <Badge variant="outline">{product.category}</Badge>
                              );
                            })()}
                          </TableCell>
                          <TableCell>{product.pricing_type === "per_unit" ? "Per Unit" : "Fixed"}</TableCell>
                          <TableCell>
                            ${product.standard_tier?.base_price?.toFixed(2) || "0.00"}
                            {product.pricing_type === "per_unit" && product.standard_tier?.unit_price > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">+ ${product.standard_tier.unit_price}/unit</span>
                            )}
                          </TableCell>
                          <TableCell>
                            ${product.premium_tier?.base_price?.toFixed(2) || "0.00"}
                            {product.pricing_type === "per_unit" && product.premium_tier?.unit_price > 0 && (
                              <span className="text-xs text-muted-foreground ml-1">+ ${product.premium_tier.unit_price}/unit</span>
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
                        ];

                        if (isExpanded) {
                        rows.push(
                        <TableRow key={`${product.id}-standard`} className="bg-muted/30">
                          <TableCell></TableCell>
                          <TableCell className="pl-8 text-sm font-medium" colSpan={2}>Standard Tier</TableCell>
                          <TableCell className="text-sm">
                            ${product.standard_tier?.base_price?.toFixed(2) || "0.00"}
                            {product.pricing_type === "per_unit" && ` + $${product.standard_tier?.unit_price || 0}/unit`}
                          </TableCell>
                          <TableCell className="text-sm" colSpan={4}>
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span>On-site: {product.standard_tier?.onsite_time || 0}min</span>
                              <span>Admin: {product.standard_tier?.admin_time || 0}min</span>
                              <span>Editor: {product.standard_tier?.editor_time || 0}min</span>
                            </div>
                          </TableCell>
                        </TableRow>
                        );
                        rows.push(
                        <TableRow key={`${product.id}-premium`} className="bg-muted/30">
                          <TableCell></TableCell>
                          <TableCell className="pl-8 text-sm font-medium" colSpan={2}>Premium Tier</TableCell>
                          <TableCell className="text-sm">
                            ${product.premium_tier?.base_price?.toFixed(2) || "0.00"}
                            {product.pricing_type === "per_unit" && ` + $${product.premium_tier?.unit_price || 0}/unit`}
                          </TableCell>
                          <TableCell className="text-sm" colSpan={4}>
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span>On-site: {product.premium_tier?.onsite_time || 0}min</span>
                              <span>Admin: {product.premium_tier?.admin_time || 0}min</span>
                              <span>Editor: {product.premium_tier?.editor_time || 0}min</span>
                            </div>
                          </TableCell>
                        </TableRow>
                        );
                        }

                        return rows;
                        })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="hierarchy" className="mt-6">
          <ProductPackageHierarchy />
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
        presetTypeId={!editingProduct && filterTypeId ? filterTypeId : null}
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
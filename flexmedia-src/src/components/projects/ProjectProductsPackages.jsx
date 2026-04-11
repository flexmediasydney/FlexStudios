import { useState, useMemo, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, AlertCircle, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import Price from '@/components/common/Price';
import { toast } from "sonner";
import { api } from "@/api/supabaseClient";
import { useProjectItemsManager } from "./hooks/useProjectItemsManager";
import AddItemsDialog from "./AddItemsDialog";
import { normalizeProjectItems } from "@/components/lib/normalizeProjectItems";
import { refetchEntityList } from "@/components/hooks/useEntityData";

// Inline pricing helper — reads stored tier pricing from product objects.
// All authoritative pricing is calculated by calculateProjectPricing backend.
// This is display-only: it reads what the backend already computed.
function getProductDisplayPrice(product, quantity, tierKey) {
  if (!product) return 0;
  const tier = product[tierKey];
  if (!tier) return 0;
  const base = Math.max(0, parseFloat(tier.base_price) || 0);
  const unit = Math.max(0, parseFloat(tier.unit_price) || 0);
  if (product.pricing_type === 'per_unit') {
    const minQty = Math.max(1, product.min_quantity || 1);
    const extraQty = Math.max(0, quantity - minQty);
    return base + (unit * extraQty);
  }
  return base; // Fixed pricing: base only
}

export default function ProjectProductsPackages({ project }) {
  const { products: allProductsRaw, packages: allPackagesRaw, batchUpdate } = useProjectItemsManager(project.id);

  // Filter by project type — products/packages tagged with specific types only show for matching projects
  const projectTypeId = project.project_type_id;
  const allProducts = allProductsRaw.filter(p =>
    !p.project_type_ids?.length || !projectTypeId || p.project_type_ids.includes(projectTypeId)
  );
  const allPackages = allPackagesRaw.filter(p =>
    !p.project_type_ids?.length || !projectTypeId || p.project_type_ids.includes(projectTypeId)
  );
  
  // Local form state
  const [formState, setFormState] = useState({
    products: project.products || [],
    packages: project.packages || [],
  });
  const [expandedPackages, setExpandedPackages] = useState(new Set());
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  // Sync formState when project data changes externally (webhook, another user, etc.)
  // Uses JSON comparison to avoid resetting mid-edit on subscription cache churn
  const projectProductsJson = JSON.stringify(project.products || []);
  const projectPackagesJson = JSON.stringify(project.packages || []);
  const prevProjectJson = useRef({ products: projectProductsJson, packages: projectPackagesJson });
  if (prevProjectJson.current.products !== projectProductsJson || prevProjectJson.current.packages !== projectPackagesJson) {
    // Only reset if not currently saving (user's own save will update project prop too)
    if (!isSaving) {
      setFormState({
        products: project.products || [],
        packages: project.packages || [],
      });
      setError(null);
    }
    prevProjectJson.current = { products: projectProductsJson, packages: projectPackagesJson };
  }

  const tierKey = project.pricing_tier === "premium" ? "premium_tier" : "standard_tier";

  // Detect orphaned items: saved on the project but not valid for its current project type
  const orphanedItems = useMemo(() => {
    const orphanProducts = formState.products.filter(item => {
      const prod = allProductsRaw.find(p => p.id === item.product_id);
      if (!prod) return true; // deleted product
      if (!projectTypeId) return false;
      const types = prod.project_type_ids || [];
      return types.length > 0 && !types.includes(projectTypeId);
    });
    const orphanPackages = formState.packages.filter(item => {
      const pkg = allPackagesRaw.find(p => p.id === item.package_id);
      if (!pkg) return true; // deleted package
      if (!projectTypeId) return false;
      const types = pkg.project_type_ids || [];
      return types.length > 0 && !types.includes(projectTypeId);
    });
    return { products: orphanProducts, packages: orphanPackages, hasOrphans: orphanProducts.length > 0 || orphanPackages.length > 0 };
  }, [formState, allProductsRaw, allPackagesRaw, projectTypeId]);

  const handleRemoveOrphans = () => {
    setFormState(prev => ({
      products: prev.products.filter(item => !orphanedItems.products.some(o => o.product_id === item.product_id)),
      packages: prev.packages.filter(item => !orphanedItems.packages.some(o => o.package_id === item.package_id)),
    }));
  };

  // Enrich products with full data
  const projectProducts = useMemo(() => {
    return formState.products
      .map(item => {
        const product = allProducts.find(p => p.id === item.product_id);
        return product ? { ...product, projectQty: item.quantity || 1 } : null;
      })
      .filter(Boolean);
  }, [formState.products, allProducts]);

  // Enrich packages with full data and their products.
  // Product quantities come from the stored project overrides (item.products),
  // falling back to the package template quantity if no override exists.
  const projectPackages = useMemo(() => {
    return formState.packages
      .map(item => {
        const pkg = allPackages.find(p => p.id === item.package_id);
        if (!pkg) return null;

        // Build a lookup of stored per-product qty overrides on this project's package item
        const storedQtyMap = {};
        (item.products || []).forEach(p => { storedQtyMap[p.product_id] = p.quantity || 1; });

        // Enrich from the package template, using stored override qty where available
        const enrichedProducts = ((pkg.products && Array.isArray(pkg.products)) ? pkg.products : [])
          .map(templateItem => {
            const product = allProducts.find(p => p.id === templateItem.product_id);
            if (!product) return null;
            const qty = storedQtyMap[templateItem.product_id] ?? templateItem.quantity ?? 1;
            return { ...product, packageQty: qty };
          })
          .filter(Boolean);

        return { ...pkg, projectQty: item.quantity || 1, enrichedProducts };
      })
      .filter(Boolean);
  }, [formState.packages, allPackages, allProducts]);

  // Calculate total price for preview
  const totalPrice = useMemo(() => {
    let total = 0;
    
    // Standalone products
    projectProducts.forEach(product => {
      total += getProductDisplayPrice(product, product.projectQty, tierKey);
    });
    
    // Products within packages
    projectPackages.forEach(pkg => {
      // Package base price
      const tier = pkg[tierKey];
      if (tier?.package_price) {
        total += tier.package_price * pkg.projectQty;
      }
      
      // Products within package
      pkg.enrichedProducts.forEach(product => {
        const productPrice = getProductDisplayPrice(product, product.packageQty * pkg.projectQty, tierKey);
        total += productPrice;
      });
    });
    
    return total;
  }, [projectProducts, projectPackages, tierKey]);

  // Available items (not yet added)
  // Only 1 package per project — if one exists, no packages are available to add
  const usedProductIds = formState.products.map(i => i.product_id);
  const usedPackageIds = formState.packages.map(i => i.package_id);
  // Also exclude products already inside any selected package
  const packageProductIds = new Set(
    formState.packages.flatMap(pkg => (pkg.products || []).map(p => p.product_id))
  );
  const availableProducts = allProducts.filter(p =>
    p.is_active !== false && !usedProductIds.includes(p.id) && !packageProductIds.has(p.id)
  );
  const availablePackages = formState.packages.length > 0
    ? [] // already has a package — none available
    : allPackages.filter(p => p.is_active !== false && !usedPackageIds.includes(p.id));

  // Update quantity
  const handleUpdateQty = (type, id, newQty, packageId = null) => {
   if (newQty < 1) return;

   // Enforce min/max from product definition
   if (type === "products") {
     const prod = allProducts.find(p => p.id === id);
     if (prod) {
       const min = prod.min_quantity || 1;
       const max = prod.max_quantity;
       if (newQty < min || (max && newQty > max)) return;
     }
   } else if (type === "package-product") {
     const prod = allProducts.find(p => p.id === id);
     if (prod) {
       const min = prod.min_quantity || 1;
       const max = prod.max_quantity;
       if (newQty < min || (max && newQty > max)) return;
     }
   } else if (type === "packages") {
     // Packages have a minimum of 1, no maximum
     if (newQty < 1) return;
   }
    
    if (type === "package-product") {
      // Update product within a package's stored products override array.
      // If the product doesn't exist in the stored array yet (legacy data), add it.
      setFormState(prev => ({
        ...prev,
        packages: prev.packages.map(pkg => {
          if (pkg.package_id !== packageId) return pkg;
          const existingArr = pkg.products || [];
          const exists = existingArr.some(p => p.product_id === id);
          const updatedProducts = exists
            ? existingArr.map(p => p.product_id === id ? { ...p, quantity: newQty } : p)
            : [...existingArr, { product_id: id, quantity: newQty }];
          return { ...pkg, products: updatedProducts };
        })
      }));
    } else {
      // Update standalone product or package
      setFormState(prev => ({
        ...prev,
        [type]: prev[type].map(item => 
          (type === "products" ? item.product_id : item.package_id) === id
            ? { ...item, quantity: newQty }
            : item
        )
      }));
    }
  };

  // Remove item
  const handleRemoveItem = (type, id, packageId = null) => {
    if (type === "package-product") {
      // Remove product from package's stored products override array
      setFormState(prev => ({
        ...prev,
        packages: prev.packages.map(pkg =>
          pkg.package_id === packageId
            ? { ...pkg, products: (pkg.products || []).filter(p => p.product_id !== id) }
            : pkg
        )
      }));
    } else {
      // Remove standalone product or package
      setFormState(prev => ({
        ...prev,
        [type]: prev[type].filter(item => 
          (type === "products" ? item.product_id : item.package_id) !== id
        )
      }));
    }
  };

  // Add standalone product
  const handleAddProduct = (id, qty) => {
    const product = allProducts.find(p => p.id === id);
    const resolvedQty = qty ?? (product?.min_quantity || 1);
    setFormState(prev => ({
      ...prev,
      products: [...prev.products, { product_id: id, quantity: resolvedQty }]
    }));
  };

  // Add package with product qty overrides.
  // Any standalone products that are also in the package get absorbed (removed from standalone list).
  // productQtyOverrides: { [productId]: qty } — user-set quantities from the dialog
  const handleAddPackage = (id, qty, productQtyOverrides = {}) => {
    const pkg = allPackages.find(p => p.id === id);
    if (!pkg) return;

    // Build the stored products array for the package using overrides from dialog
    const packageProducts = (pkg.products || []).map(templateItem => ({
      product_id: templateItem.product_id,
      product_name: templateItem.product_name || "",
      quantity: productQtyOverrides[templateItem.product_id] ?? templateItem.quantity ?? 1,
    }));

    // Collect product IDs that are now inside the package
    const packageProductIds = new Set(packageProducts.map(p => p.product_id));

    setFormState(prev => {
      // Remove standalone products that are being absorbed into the package
      const remainingStandalones = prev.products.filter(p => !packageProductIds.has(p.product_id));

      return {
        products: remainingStandalones,
        packages: [...prev.packages, {
          package_id: id,
          quantity: qty ?? 1,
          products: packageProducts,
        }]
      };
    });
  };

  // Save all changes — guarded against double-submit
  const handleSave = async () => {
    if (isSaving) return;
    setIsSaving(true);
    try {
      setError(null);
      
      // Final validation: filter out any type-mismatched or deleted items
      const projectTypeId = project.project_type_id;
      
      const validatedProducts = formState.products.filter(item => {
        const prod = allProductsRaw.find(p => p.id === item.product_id);
        
        // Product doesn't exist anymore
        if (!prod) return false;
        
        // Type mismatch check
        if (projectTypeId) {
          const prodTypes = prod.project_type_ids || [];
          if (prodTypes.length > 0 && !prodTypes.includes(projectTypeId)) {
            return false;
          }
        }
        return true;
      });
      
      const validatedPackages = formState.packages.filter(item => {
        const pkg = allPackagesRaw.find(p => p.id === item.package_id);
        
        // Package doesn't exist anymore
        if (!pkg) return false;
        
        // Type mismatch check
        if (projectTypeId) {
          const pkgTypes = pkg.project_type_ids || [];
          if (pkgTypes.length > 0 && !pkgTypes.includes(projectTypeId)) {
            return false;
          }
        }
        return true;
      });

      // Validate nested product IDs inside packages still exist
      const allProductsMap = new Map(allProductsRaw.map(p => [p.id, p]));
      const cleanedPackages = validatedPackages.map(item => {
        const invalidProducts = (item.products || []).filter(p => !allProductsMap.has(p.product_id));
        if (invalidProducts.length > 0) {
          const pkg = allPackagesRaw.find(p => p.id === item.package_id);
          const pkgName = pkg?.name || item.package_id;
          console.warn(`Package "${pkgName}" has ${invalidProducts.length} removed product(s) — stripping`);
          return { ...item, products: (item.products || []).filter(p => allProductsMap.has(p.product_id)) };
        }
        return item;
      });

      // Auto-strip orphaned/invalid items — update local state so UI reflects what was saved
      if (validatedProducts.length < formState.products.length || cleanedPackages !== validatedPackages) {
        setFormState({ products: validatedProducts, packages: cleanedPackages });
      }

      // Normalize: remove standalone products that overlap with package contents
      const normalized = normalizeProjectItems(
        validatedProducts,
        cleanedPackages,
        allProductsRaw,
        allPackagesRaw
      );
      
      await batchUpdate.mutateAsync({
        products: normalized.products,
        packages: normalized.packages
      });

      // Trigger task and effort sync sequentially
      try {
        await api.functions.invoke('syncProjectTasksFromProducts', { project_id: project.id });
      } catch (syncErr) {
        console.warn('Task sync failed:', syncErr?.message);
      }
      try {
        await api.functions.invoke('syncOnsiteEffortTasks', { project_id: project.id });
      } catch (effortErr) {
        console.warn('Onsite effort sync failed:', effortErr?.message);
      }
      try {
        await api.functions.invoke('cleanupOrphanedProjectTasks', { project_id: project.id });
      } catch { /* non-fatal */ }

      // Fix 9 — recalculate price to reflect the updated product/package set.
      // Must be awaited so the refreshed Project entity has the updated calculated_price.
      // Previously fire-and-forget, causing stale pricing in the UI after save.
      try {
        await api.functions.invoke('recalculateProjectPricingServerSide', {
          project_id: project.id,
        });
      } catch (pricingErr) {
        console.warn('Pricing recalc failed:', pricingErr?.message);
      }

      // Invalidate task caches — syncProjectTasksFromProducts may have created/updated tasks
      refetchEntityList("ProjectTask");
      refetchEntityList("Project");

      toast.success("Products & packages saved");
    } catch (err) {
      console.error('Products/packages save error:', err);
      setError(err.message || 'Failed to save changes');
      toast.error(err.message || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  // Sorted-key stringify to avoid false positives when key order differs
  const stableStringify = (obj) => JSON.stringify(obj, Object.keys(obj || {}).sort());
  const hasChanges = stableStringify(formState) !== stableStringify({ products: project.products || [], packages: project.packages || [] });

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto font-semibold underline">Dismiss</button>
        </div>
      )}

      {orphanedItems.hasOrphans && (
        <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-medium">Mismatched items detected</p>
            <p className="text-xs mt-0.5 text-amber-700">
              {orphanedItems.products.length + orphanedItems.packages.length} item(s) don't belong to this project type and will be removed on save.
            </p>
          </div>
          <button
            onClick={handleRemoveOrphans}
            className="ml-auto text-xs font-semibold underline whitespace-nowrap"
          >
            Remove now
          </button>
        </div>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <CardTitle className="text-base">
            Products & Packages
            {projectProducts.length + projectPackages.length > 0 && (
              <span className="text-muted-foreground font-normal ml-2 text-sm">
                ({projectProducts.length + projectPackages.length})
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {hasChanges && (
              <>
                <Button 
                  size="sm" 
                  variant="outline" 
                  onClick={() => setFormState({ products: project.products || [], packages: project.packages || [] })}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={isSaving || batchUpdate.isPending}
                >
                  {isSaving || batchUpdate.isPending ? "Saving..." : "Save Changes"}
                </Button>
              </>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => setShowAddDialog(true)}
              disabled={availableProducts.length === 0 && formState.packages.length > 0}
            >
              <Plus className="h-4 w-4 mr-1" /> Add
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {projectPackages.length === 0 && projectProducts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">No products or packages added yet.</p>
          ) : (
            <>
              {/* Packages */}
              {projectPackages.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-semibold text-sm text-muted-foreground uppercase">Packages</h4>
                  {projectPackages.map(pkg => {
                    const qty = pkg.projectQty;
                    const isExpanded = expandedPackages.has(pkg.id);
                    const tier = pkg[tierKey];
                    const packagePrice = (tier?.package_price || 0) * qty;
                    
                    let packageProductsPrice = 0;
                    pkg.enrichedProducts.forEach(product => {
                      packageProductsPrice += getProductDisplayPrice(product, product.packageQty * qty, tierKey);
                    });
                    
                    const totalPackagePrice = packagePrice + packageProductsPrice;
                    
                    return (
                      <div key={pkg.id} className="border rounded-lg overflow-hidden">
                        <div className="flex items-center gap-3 py-2 px-3 bg-muted/30">
                          <button
                            onClick={() => setExpandedPackages(prev => {
                              const next = new Set(prev);
                              next.has(pkg.id) ? next.delete(pkg.id) : next.add(pkg.id);
                              return next;
                            })}
                            className="p-0.5 hover:bg-muted rounded"
                          >
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                          <div className="flex-1 min-w-0">
                            <p className="font-medium text-sm">{pkg.name}</p>
                            {pkg.description && <p className="text-xs text-muted-foreground">{pkg.description}</p>}
                          </div>
                          <div className="flex items-center gap-2 flex-shrink-0">
                            {totalPackagePrice > 0 && (
                              <span className="text-sm font-semibold text-primary min-w-[70px] text-right">
                                <Price value={totalPackagePrice} />
                              </span>
                            )}
                            <div className="flex items-center gap-1 border rounded px-1 py-0.5">
                              <button
                                onClick={() => handleUpdateQty("packages", pkg.id, qty - 1)}
                                className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-40"
                                disabled={qty <= 1}
                              >−</button>
                              <span className="text-sm font-medium w-6 text-center">{qty}</span>
                              <button
                                onClick={() => handleUpdateQty("packages", pkg.id, qty + 1)}
                                className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-40"
                              >+</button>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive hover:text-destructive"
                              onClick={() => handleRemoveItem("packages", pkg.id)}
                              title={`Remove ${pkg.name} package`}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                        
                        {/* Package Products */}
                        {isExpanded && pkg.enrichedProducts.length > 0 && (
                          <div className="bg-background space-y-1 border-t p-2">
                            {pkg.enrichedProducts.map(product => {
                              const prodQty = product.packageQty;
                              const prodPrice = getProductDisplayPrice(product, prodQty, tierKey);
                              
                              return (
                                <div key={product.id} className="flex items-center gap-3 py-1.5 px-3 rounded border bg-muted/20">
                                  <div className="w-6" />
                                  <div className="flex-1 min-w-0">
                                    <p className="font-medium text-xs">{product.name}</p>
                                  </div>
                                  <div className="flex items-center gap-2 flex-shrink-0">
                                    {prodPrice > 0 && (
                                      <span className="text-xs font-semibold text-primary min-w-[50px] text-right">
                                        <Price value={prodPrice} />
                                      </span>
                                    )}
                                    {product.pricing_type === "per_unit" && (
                                      <div className="flex items-center gap-1 border rounded px-0.5 py-0">
                                        <button
                                          onClick={() => handleUpdateQty("package-product", product.id, prodQty - 1, pkg.id)}
                                          className="px-1 py-0 text-xs hover:bg-muted rounded disabled:opacity-40"
                                          disabled={prodQty <= (product.min_quantity || 1)}
                                        >−</button>
                                        <span className="text-xs font-medium w-5 text-center">{prodQty}</span>
                                        <button
                                          onClick={() => handleUpdateQty("package-product", product.id, prodQty + 1, pkg.id)}
                                          className="px-1 py-0 text-xs hover:bg-muted rounded disabled:opacity-40"
                                          disabled={!!(product.max_quantity && prodQty >= product.max_quantity)}
                                        >+</button>
                                      </div>
                                    )}
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-destructive hover:text-destructive"
                                      onClick={() => handleRemoveItem("package-product", product.id, pkg.id)}
                                      title={`Remove ${product.name} from package`}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Products */}
              {projectProducts.length > 0 && (
                <div className="space-y-3">
                  <h4 className="font-semibold text-sm text-muted-foreground uppercase">Standalone Products</h4>
                  {projectProducts.map(product => {
                    const qty = product.projectQty;
                    const price = getProductDisplayPrice(product, qty, tierKey);
                    
                    return (
                      <div key={product.id} className="flex items-center gap-3 py-2 px-3 rounded-lg border transition-all hover:shadow-sm hover:border-primary/30 hover:bg-muted/10">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm">{product.name}</p>
                          {product.category && <p className="text-xs text-muted-foreground capitalize">{product.category}</p>}
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {price > 0 && (
                            <span className="text-sm font-semibold text-primary min-w-[70px] text-right">
                              <Price value={price} />
                            </span>
                          )}
                          {product.pricing_type === "per_unit" ? (
                            <div className="flex items-center gap-1 border rounded px-1 py-0.5">
                              <button
                                onClick={() => handleUpdateQty("products", product.id, qty - 1)}
                                className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-40"
                                disabled={qty <= (product.min_quantity || 1)}
                              >−</button>
                              <span className="text-sm font-medium w-6 text-center">{qty}</span>
                              <button
                                onClick={() => handleUpdateQty("products", product.id, qty + 1)}
                                className="px-1.5 py-0.5 text-xs hover:bg-muted rounded disabled:opacity-40"
                                disabled={!!(product.max_quantity && qty >= product.max_quantity)}
                              >+</button>
                            </div>
                          ) : (
                            <div className="text-xs bg-muted px-2 py-1 rounded">Fixed</div>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            onClick={() => handleRemoveItem("products", product.id)}
                            title={`Remove ${product.name}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Total — always show when items exist (even if price is $0) */}
              <div className="flex items-center justify-between pt-3 border-t mt-3 bg-primary/5 rounded-lg px-3 py-2.5">
                <span className="text-sm font-semibold">Estimated Total</span>
                <span className="text-xl font-bold text-primary font-mono tabular-nums"><Price value={totalPrice} /></span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AddItemsDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        availableProducts={availableProducts}
        availablePackages={availablePackages}
        onAddProduct={handleAddProduct}
        onAddPackage={handleAddPackage}
        isLoading={batchUpdate.isPending}
        projectTypeId={projectTypeId}
        currentProducts={formState.products}
        currentPackages={formState.packages}
        allProducts={allProductsRaw}
      />
    </div>
  );
}
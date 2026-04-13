import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { DollarSign, Plus, AlertCircle, Loader2, ChevronLeft, ChevronRight, Percent, Tag } from "lucide-react";
import { Input } from "@/components/ui/input";
import Price from '@/components/common/Price';
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectItemsManager } from "./hooks/useProjectItemsManager";
import { useProjectPricingCalculator } from "./hooks/useProjectPricingCalculator";
import AddItemsDialog from "./AddItemsDialog";
import { PricingTableBody } from "./PricingTableBody";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { normalizeProjectItems } from "@/components/lib/normalizeProjectItems";
import { writeFeedEvent } from "@/components/notifications/createNotification";
import { toast } from "sonner";

export default function ProjectPricingTable({ 
  project, 
  pricingTier = "standard", 
  canSeePricing = false, 
  canEdit = false, 
  onTotalChange 
}) {
  const projectId = project?.id;
  const queryClient = useQueryClient();
  const { products: allProducts, packages: allPackages, batchUpdate } = useProjectItemsManager(projectId);
  
  // formState tracks the user's pending edits (not yet saved to backend)
  const [formState, setFormState] = useState({
    products: project?.products || [],
    packages: project?.packages || [],
  });
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showConfirmSave, setShowConfirmSave] = useState(false);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  // pendingTotal = the backend-verified total we'll show in the confirm dialog
  const [pendingTotal, setPendingTotal] = useState(null);
  const [isVerifying, setIsVerifying] = useState(false);
  const [pendingCalcResult, setPendingCalcResult] = useState(null);
  // ^ holds the full backend calc result between step 1 (verify) and step 2 (confirm)
  const [currentPage, setCurrentPage] = useState(0);
  const refreshTimerRef = useRef(null);
  const debouncedTimerRef = useRef(null);
  const ITEMS_PER_PAGE = 10; // Pagination to reduce large renders

  // Clean up pending timers on unmount to prevent setState-after-unmount
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      if (debouncedTimerRef.current) clearTimeout(debouncedTimerRef.current);
    };
  }, []);

  const tierKey = pricingTier === "premium" ? "premium_tier" : "standard_tier";

  // Sync formState when project data changes externally (not from our own save)
  // Use JSON comparison to avoid resetting form on every entity cache subscription update
  const projectProductsJson = JSON.stringify(project?.products || []);
  const projectPackagesJson = JSON.stringify(project?.packages || []);
  useEffect(() => {
    const newFormState = {
      products: (project?.products || []).map(p => ({ ...p })),
      packages: (project?.packages || []).map(pkg => ({
        ...pkg,
        products: (pkg.products || []).map(np => ({ ...np }))
      })),
      discount_type: project?.discount_type || 'fixed',
      discount_value: project?.discount_value || 0,
    };
    setFormState(newFormState);
    setPendingTotal(null);
    setPendingCalcResult(null);
    setError(null);
  }, [project?.id, projectProductsJson, projectPackagesJson, project?.pricing_tier]);

  // Frontend calculator for live line-level display (uses stored matrix prices)
  const { breakdown } = useProjectPricingCalculator(formState, allProducts, allPackages, tierKey);

  // Notify parent of total changes
  useEffect(() => {
    if (onTotalChange) onTotalChange(breakdown.total);
  }, [breakdown.total]); // eslint-disable-line

  if (!canSeePricing) {
    return null;
  }

  // --- Handlers ---

  // Nested product qty change (inside a package)
  const handleUpdateNestedQty = (packageId, productId, newQty) => {
    const product = allProducts.find(p => p.id === productId);
    const pkg = allPackages.find(p => p.id === packageId);
    const pkgProduct = (pkg?.products || []).find(p => p.product_id === productId);

    // includedQty = what the package definition bundles; user can't go below this
    const includedQty = Math.max(1, pkgProduct?.quantity || 1);
    const minQty = Math.max(1, product?.min_quantity || 1, includedQty);
    const maxQty = product?.max_quantity ? parseInt(product.max_quantity, 10) : null;

    let qty = Math.max(minQty, parseInt(newQty, 10) || minQty);
    if (maxQty !== null) qty = Math.min(qty, maxQty);

    setFormState(prev => ({
      ...prev,
      packages: prev.packages.map(p => {
        if (p.package_id !== packageId) return p;
        const existingProducts = p.products || [];
        const already = existingProducts.find(np => np.product_id === productId);
        const updatedProducts = already
          ? existingProducts.map(np => np.product_id === productId ? { ...np, quantity: qty } : np)
          : [...existingProducts, { product_id: productId, quantity: qty }];
        return { ...p, products: updatedProducts };
      })
    }));
    setPendingTotal(null);
  };

  // Rule: standalone products can change qty within [min, max]
  const handleUpdateQty = (productId, newQty) => {
    const product = allProducts.find(p => p.id === productId);
    const minQty = Math.max(1, product?.min_quantity || 1);
    const maxQty = product?.max_quantity ? parseInt(product.max_quantity, 10) : null;
    let qty = Math.max(minQty, parseInt(newQty, 10) || minQty);
    if (maxQty !== null) qty = Math.min(qty, maxQty);

    setFormState(prev => ({
      ...prev,
      products: prev.products.map(item =>
        item.product_id === productId ? { ...item, quantity: qty } : item
      )
    }));
    // Reset pending total so user must re-verify before saving
    setPendingTotal(null);
  };

  const handleRemoveItem = (type, id) => {
    setFormState(prev => ({
      ...prev,
      [type]: prev[type].filter(item =>
        (type === "products" ? item.product_id : item.package_id) !== id
      )
    }));
    setPendingTotal(null);
    setCurrentPage(0);
  };

  const handleAddItem = (type, id) => {
    if (type === "products") {
      const product = allProducts.find(p => p.id === id);
      const startQty = Math.max(1, product?.min_quantity || 1);
      setFormState(prev => ({
        ...prev,
        products: [
          ...prev.products,
          {
            product_id: id,
            quantity: startQty
          }
        ]
      }));
    } else {
      const pkg = allPackages.find(p => p.id === id);
      // Initialize nested products at their included quantities
      const initialProducts = (pkg?.products || []).map(np => ({
        product_id: np.product_id,
        quantity: Math.max(1, np.quantity || 1)
      }));
      // Absorb: remove standalone products that are now inside this package
      const packageProductIds = new Set(initialProducts.map(p => p.product_id));
      setFormState(prev => ({
        ...prev,
        products: prev.products.filter(p => !packageProductIds.has(p.product_id)),
        packages: [
          ...prev.packages,
          {
            package_id: id,
            quantity: 1,
            products: initialProducts
          }
        ]
      }));
    }
    setShowAddDialog(false);
    setPendingTotal(null);
    setCurrentPage(0);
  };

  // Step 1 of save: verify with backend, show total in confirm dialog
  const handleRequestSave = async () => {
    setError(null);
    setIsVerifying(true);
    try {
      // Validate all products still exist (catch deleted/inactive items)
      for (const prod of formState.products) {
        const found = allProducts.find(p => p.id === prod.product_id);
        if (!found) {
          setError(`Product not found (may have been permanently deleted). Remove it to continue.`);
          setIsVerifying(false);
          return;
        }
      }
      
      // Validate all packages still exist
      for (const pkg of formState.packages) {
        if (!allPackages.find(p => p.id === pkg.package_id)) {
          setError(`Package not found. It may have been deleted or deactivated.`);
          setIsVerifying(false);
          return;
        }
      }

      // If no products or packages, set price to 0 and skip backend verification
      if (formState.products.length === 0 && formState.packages.length === 0) {
        setPendingTotal(0);
        setPendingCalcResult({
          success: true,
          calculated_price: 0,
          products: [],
          packages: [],
          price_matrix_snapshot: null,
        });
        setShowConfirmSave(true);
        return;
      }

      // Refresh products/packages to ensure we calculate against latest matrix data
      await queryClient.invalidateQueries({ queryKey: ['products'] });
      await queryClient.invalidateQueries({ queryKey: ['packages'] });

      const response = await api.functions.invoke('calculateProjectPricing', {
        agent_id: project?.agent_id || null,
        agency_id: project?.agency_id || null,
        products: formState.products,
        packages: formState.packages,
        pricing_tier: pricingTier,
        project_type_id: project?.project_type_id || null,
        discount_type: formState.discount_type || 'fixed',
        discount_value: formState.discount_value || 0,
      });
      if (response.data?.success) {
        // Store verified result to use on confirm
        setPendingTotal(response.data.calculated_price);
        setPendingCalcResult(response.data);
        setShowConfirmSave(true);
      } else {
        setError("Pricing verification failed. Please try again.");
      }
    } catch (err) {
      console.error("Pricing verification error:", err);
      setError("Failed to verify pricing. Please try again.");
    } finally {
      setIsVerifying(false);
    }
  };

  // Step 2: user confirmed — commit to database
  const handleConfirmSave = async () => {
    if (!pendingCalcResult) return;
    setShowConfirmSave(false);
    setIsSaving(true);
    try {
      // Use formState (the user's current selection) for products/packages — NOT pendingCalcResult
      // The backend calculateProjectPricing returns line_items, not products/packages arrays
      // Normalize: remove standalone products that overlap with package contents
      const normalized = normalizeProjectItems(
        formState.products,
        formState.packages,
        allProducts,
        allPackages
      );

      const productsToSave = normalized.products.map(p => ({
        product_id: p.product_id,
        quantity: p.quantity || 1,
      }));

      const packagesToSave = normalized.packages.map(pkg => ({
        package_id: pkg.package_id,
        quantity: pkg.quantity || 1,
        products: (pkg.products || []).map(np => ({
          product_id: np.product_id,
          quantity: np.quantity || 1,
        })),
      }));

      // Mark products as manually overridden so Tonomo webhooks don't overwrite
      const existingOverrides = (() => {
        try { return JSON.parse(project?.manually_overridden_fields || '[]'); }
        catch { return []; }
      })();
      const overrideSet = new Set(existingOverrides);
      overrideSet.add('products');
      overrideSet.add('packages');

      await batchUpdate.mutateAsync({
        products: productsToSave,
        packages: packagesToSave,
        calculated_price: pendingCalcResult.calculated_price,
        price: pendingCalcResult.calculated_price,
        price_matrix_snapshot: pendingCalcResult.price_matrix_snapshot,
        pricing_tier: pricingTier,
        discount_type: formState.discount_type || 'fixed',
        discount_value: parseFloat(formState.discount_value) || 0,
        manually_overridden_fields: JSON.stringify([...overrideSet]),
      });
      
      // Audit: log pricing change to ProjectActivity + TeamActivityFeed
      const oldPrice = project?.calculated_price || 0;
      const newPrice = pendingCalcResult.calculated_price;
      const priceDelta = Math.abs(newPrice - oldPrice);
      const projectName = project?.title || project?.property_address || 'Project';

      api.auth.me().then(currentUser => {
        const userName = currentUser?.full_name || 'Unknown';
        const userEmail = currentUser?.email || '';

        // ProjectActivity entry (visible in project History tab)
        api.entities.ProjectActivity.create({
          project_id: projectId,
          project_title: projectName,
          action: 'pricing_updated',
          description: `Pricing updated: $${Math.round(newPrice).toLocaleString()}${oldPrice ? ` (was $${Math.round(oldPrice).toLocaleString()}, Δ$${Math.round(priceDelta)})` : ''}. Tier: ${pricingTier}.`,
          user_name: userName,
          user_email: userEmail,
        }).catch(() => {});

        // TeamActivityFeed entry (visible on Team Pulse page)
        api.entities.TeamActivityFeed.create({
          event_type: 'pricing_updated',
          project_id: projectId,
          project_title: projectName,
          description: `${userName} updated pricing to $${Math.round(newPrice).toLocaleString()}`,
          actor_name: userName,
          actor_email: userEmail,
        }).catch(() => {});

        // Notify project owner + admins if significant change (>$50 or >5%)
        const pctDelta = oldPrice > 0 ? (priceDelta / oldPrice) * 100 : 0;
        if (oldPrice > 0 && (priceDelta >= 50 || pctDelta >= 5)) {
          api.functions.invoke('notificationService', {
            type: 'project_pricing_changed',
            category: 'project',
            severity: 'info',
            title: `Pricing updated — ${projectName}`,
            message: `Price changed to $${Math.round(newPrice).toLocaleString()} (was $${Math.round(oldPrice).toLocaleString()}).`,
            project_id: projectId,
            project_name: projectName,
            cta_label: 'View Project',
            source: 'pricing',
          }).catch(() => {});
        }
      }).catch(() => {});

      // Sync tasks, update onsite durations, clean up orphans — fire-and-forget
      api.functions.invoke('syncProjectTasksFromProducts', { project_id: projectId })
        .catch(err => console.warn('Task sync failed:', err?.message));
      api.functions.invoke('syncOnsiteEffortTasks', { project_id: projectId })
        .catch(err => console.warn('Onsite sync failed:', err?.message));
      api.functions.invoke('cleanupOrphanedProjectTasks', { project_id: projectId })
        .catch(err => console.warn('Cleanup failed:', err?.message));

      // Force entity cache refresh for tasks after backend sync completes
      // The sync is fire-and-forget so we delay to give it time to finish
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refetchEntityList('ProjectTask');
        refetchEntityList('Project');
        refreshTimerRef.current = null;
      }, 2500);

      setPendingTotal(null);
      setPendingCalcResult(null);
      toast.success("Pricing saved successfully");
    } catch (err) {
      console.error("Pricing save error:", err);
      setError("Failed to save pricing changes. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setFormState({
      products: project?.products || [],
      packages: project?.packages || [],
      discount_type: project?.discount_type || 'fixed',
      discount_value: project?.discount_value || 0,
    });
    setPendingTotal(null);
    setPendingCalcResult(null);
    setError(null);
  };

  // Fix: proper debounce using a ref to track the timer — the previous
  // useCallback-based approach returned a cleanup fn that was never called,
  // so every invocation fired after 200ms instead of debouncing.
  const qtyTimerRef = useRef(null);
  const debouncedUpdateQty = useCallback((productId, newQty) => {
    if (qtyTimerRef.current) clearTimeout(qtyTimerRef.current);
    qtyTimerRef.current = setTimeout(() => {
      qtyTimerRef.current = null;
      handleUpdateQty(productId, newQty);
    }, 200);
  }, [allProducts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce nested product qty changes the same way as standalone products
  const nestedQtyTimerRef = useRef(null);
  const debouncedUpdateNestedQty = useCallback((packageId, productId, newQty) => {
    if (nestedQtyTimerRef.current) clearTimeout(nestedQtyTimerRef.current);
    nestedQtyTimerRef.current = setTimeout(() => {
      nestedQtyTimerRef.current = null;
      handleUpdateNestedQty(packageId, productId, newQty);
    }, 200);
  }, [allProducts, allPackages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Change detection
  const hasChanges = useMemo(() => {
    const origProducts = project?.products || [];
    const origPackages = project?.packages || [];
    // Discount changes
    const origDiscType = project?.discount_type || 'fixed';
    const origDiscVal = parseFloat(project?.discount_value) || 0;
    if ((formState.discount_type || 'fixed') !== origDiscType) return true;
    if ((parseFloat(formState.discount_value) || 0) !== origDiscVal) return true;

    if (formState.products.length !== origProducts.length) return true;
    if (formState.packages.length !== origPackages.length) return true;
    if (formState.products.some((prod, idx) =>
      prod.product_id !== origProducts[idx]?.product_id ||
      prod.quantity !== origProducts[idx]?.quantity
    )) return true;
    return formState.packages.some((pkg, idx) => {
      if (pkg.package_id !== origPackages[idx]?.package_id) return true;
      const origNested = origPackages[idx]?.products || [];
      const curNested = pkg.products || [];
      // Get the master package definition to know the default included qty per nested product
      const masterPkg = allPackages.find(p => p.id === pkg.package_id);
      // Check every nested product the user has touched
      for (const np of curNested) {
        const orig = origNested.find(o => o.product_id === np.product_id);
        const masterDef = masterPkg?.products?.find(mp => mp.product_id === np.product_id);
        // Original qty = what's stored on project, or master-included qty if not stored
        const origQty = orig?.quantity ?? masterDef?.quantity ?? 1;
        if (np.quantity !== origQty) return true;
      }
      // Check if any origNested entries are missing from curNested (shouldn't normally happen, but safe)
      for (const orig of origNested) {
        const cur = curNested.find(np => np.product_id === orig.product_id);
        if (!cur && orig.quantity != null) {
          const masterDef = masterPkg?.products?.find(mp => mp.product_id === orig.product_id);
          const masterQty = masterDef?.quantity ?? 1;
          if (orig.quantity !== masterQty) return true;
        }
      }
      return false;
    });
  }, [formState, project, allPackages]);

  const { availableProducts, availablePackages } = useMemo(() => {
    const usedProductIds = new Set(formState.products.map(i => i.product_id));
    const usedPackageIds = new Set(formState.packages.map(i => i.package_id));
    // Also exclude products already inside any selected package
    const packageProductIds = new Set(
      formState.packages.flatMap(pkg => (pkg.products || []).map(p => p.product_id))
    );
    return {
      availableProducts: allProducts.filter(p =>
        p.is_active !== false && !usedProductIds.has(p.id) && !packageProductIds.has(p.id)
      ),
      availablePackages: allPackages.filter(p => p.is_active !== false && !usedPackageIds.has(p.id)),
    };
  }, [formState.products, formState.packages, allProducts, allPackages]);

  // Always use the live frontend calculation when it has items to compute from.
  // The stored calculated_price may be stale (e.g. quantities changed via Tonomo
  // but recalculateProjectPricingServerSide never ran). Only fall back to stored
  // price when the frontend calculator has zero items (empty project).
  const displayTotal = (breakdown.products.length > 0 || breakdown.packages.length > 0)
    ? breakdown.total
    : (project?.calculated_price ?? project?.price ?? 0);

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto font-semibold underline">Dismiss</button>
        </div>
      )}

      <Card className="border-l-4 border-l-primary">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <DollarSign className="h-5 w-5 text-primary" />
            </div>
            <CardTitle>Pricing Breakdown</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {pricingTier === "premium" ? "Premium" : "Standard"} Tier
            </Badge>
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddDialog(true)}
              >
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
           {breakdown.packages.length === 0 && breakdown.products.length === 0 ? (
             <div className="flex flex-col items-center justify-center h-full py-12 gap-4">
               <p className="text-sm text-muted-foreground text-center">No products or packages added yet.</p>
               {canEdit && (
                 <Button
                   variant="outline"
                   size="sm"
                   onClick={() => setShowAddDialog(true)}
                 >
                   <Plus className="h-4 w-4 mr-1" /> Add Products or Packages
                 </Button>
               )}
             </div>
           ) : (
            <>
              {/* Paginated table */}
              <div className="overflow-x-auto">
                {(() => {
                  const allItems = [
                    ...breakdown.packages.map((pkg, idx) => ({ type: 'package', item: pkg, idx })),
                    ...breakdown.products.map((prod, idx) => ({ type: 'product', item: prod, idx }))
                  ];
                  const totalPages = Math.ceil(allItems.length / ITEMS_PER_PAGE);
                  const paginatedItems = allItems.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE);
                  
                  return (
                    <>
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b">
                            <th className="text-left py-2 px-3 font-semibold text-muted-foreground">Item</th>
                            <th className="text-center py-2 px-3 font-semibold text-muted-foreground w-28">Qty</th>
                            <th className="text-right py-2 px-3 font-semibold text-muted-foreground w-24">Unit Price</th>
                            <th className="text-right py-2 px-3 font-semibold text-muted-foreground w-28">Total</th>
                            {canEdit && <th className="w-10" />}
                          </tr>
                        </thead>
                        <PricingTableBody 
                        paginatedItems={paginatedItems}
                        breakdown={breakdown}
                        canEdit={canEdit}
                        onRemoveItem={handleRemoveItem}
                        onUpdateQty={debouncedUpdateQty}
                        onUpdateNestedQty={debouncedUpdateNestedQty}
                      />

                      </table>

                      {/* Pagination controls */}
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between mt-3 px-3 py-2 border-t text-xs text-muted-foreground">
                          <div className="tabular-nums">Page {currentPage + 1} of {totalPages} ({allItems.length} items)</div>
                          <div className="flex gap-1">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
                              disabled={currentPage === 0}
                              className="h-7 w-7 p-0"
                            >
                              <ChevronLeft className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                              disabled={currentPage === totalPages - 1}
                              className="h-7 w-7 p-0"
                            >
                              <ChevronRight className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>

              {/* Subtotal + Discount + Total */}
              <div className="pt-2">
                <Separator className="my-3" />

                {/* Subtotal line */}
                <div className="flex items-center justify-between px-4 py-2">
                  <span className="text-sm text-muted-foreground">Subtotal</span>
                  <span className="text-sm font-mono tabular-nums">
                    <Price value={breakdown.subtotal} />
                  </span>
                </div>

                {/* Manual discount row */}
                <div className="flex items-center justify-between px-4 py-2 gap-3">
                  <div className="flex items-center gap-2">
                    <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-sm text-muted-foreground">Discount</span>
                  </div>
                  {canEdit ? (
                    <div className="flex items-center gap-1.5">
                      {/* $ / % toggle */}
                      <button
                        type="button"
                        onClick={() => {
                          const newType = formState.discount_type === 'percent' ? 'fixed' : 'percent';
                          setFormState(prev => ({ ...prev, discount_type: newType }));
                        }}
                        className="flex items-center justify-center h-8 w-8 rounded border border-border text-xs font-bold text-muted-foreground hover:bg-muted transition-colors shrink-0"
                        title={`Switch to ${formState.discount_type === 'percent' ? 'fixed $' : 'percentage %'}`}
                      >
                        {formState.discount_type === 'percent' ? <Percent className="h-3.5 w-3.5" /> : <DollarSign className="h-3.5 w-3.5" />}
                      </button>
                      {/* Value input */}
                      <Input
                        type="number"
                        min="0"
                        max={formState.discount_type === 'percent' ? 100 : undefined}
                        step={formState.discount_type === 'percent' ? 1 : 5}
                        value={formState.discount_value || ''}
                        onChange={e => setFormState(prev => ({ ...prev, discount_value: e.target.value }))}
                        onBlur={e => {
                          let val = Math.max(0, parseFloat(e.target.value) || 0);
                          if (formState.discount_type === 'percent') val = Math.min(100, val);
                          setFormState(prev => ({ ...prev, discount_value: val }));
                        }}
                        placeholder="0"
                        className="h-8 w-24 text-right font-mono text-sm"
                      />
                      {/* Show computed discount amount */}
                      {breakdown.manualDiscount > 0 && (
                        <span className="text-sm font-mono tabular-nums text-red-600 whitespace-nowrap">
                          −<Price value={breakdown.manualDiscount} />
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-sm font-mono tabular-nums text-red-600">
                      {breakdown.manualDiscount > 0 ? (
                        <>−<Price value={breakdown.manualDiscount} />
                          <span className="text-xs text-muted-foreground ml-1">
                            ({formState.discount_type === 'percent' ? `${formState.discount_value}%` : `$${formState.discount_value}`})
                          </span>
                        </>
                      ) : '—'}
                    </span>
                  )}
                </div>

                {/* Total */}
                <div className="flex items-center justify-between bg-primary/5 rounded-lg p-4 border border-primary/20 mt-2">
                  <div>
                    <span className="font-semibold text-lg">Total Project Value</span>
                    {canEdit && hasChanges && (
                      <p className="text-xs text-amber-600 mt-0.5 font-medium">⚠ Unsaved changes — save to lock in pricing</p>
                    )}
                  </div>
                  <div className="text-right">
                    <p className="text-3xl font-bold text-primary font-mono tabular-nums transition-all duration-300">
                      <Price value={displayTotal} />
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {pricingTier === "premium" ? "Premium" : "Standard"} tier · Matrix-adjusted
                      {hasChanges && <span className="text-amber-500"> · estimate (excludes matrix discounts)</span>}
                    </p>
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Save / Discard bar — only shown when there are pending changes */}
      {canEdit && hasChanges && (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-200 bg-amber-50">
          <AlertCircle className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <p className="text-sm text-amber-800 flex-1">You have unsaved pricing changes. Save to lock in matrix-adjusted prices.</p>
          <Button variant="outline" size="sm" onClick={handleDiscard} disabled={isSaving || isVerifying}>
            Discard
          </Button>
          <Button size="sm" onClick={handleRequestSave} disabled={isSaving || isVerifying}>
            {isVerifying ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Verifying...</> : "Review & Save"}
          </Button>
        </div>
      )}

      {/* Double-confirmation dialog — shows backend-verified total before committing */}
      <AlertDialog open={showConfirmSave} onOpenChange={setShowConfirmSave}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Pricing Changes</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  You're about to update the pricing for this project. The backend has verified the following total using the current price matrix:
                </p>
                {/* Show old vs new price so the user can see what's changing */}
                {(project?.calculated_price ?? project?.price ?? 0) > 0 && (
                  <div className="rounded-lg border bg-muted/50 p-3 text-center">
                    <p className="text-xs text-muted-foreground mb-1">Current price</p>
                    <p className="text-lg font-semibold text-muted-foreground font-mono line-through">
                      <Price value={project?.calculated_price ?? project?.price ?? 0} />
                    </p>
                  </div>
                )}
                <div className="rounded-lg border bg-primary/5 p-4 text-center">
                  <p className="text-xs text-muted-foreground mb-1">{pricingTier === "premium" ? "Premium" : "Standard"} tier · Matrix-adjusted</p>
                  <p className="text-3xl font-bold text-primary font-mono">
                    <Price value={pendingTotal ?? 0} />
                  </p>
                  {pendingCalcResult?.manual_discount_applied > 0 && (
                    <p className="text-sm text-muted-foreground mt-1">
                      Includes discount: −${pendingCalcResult.manual_discount_applied.toLocaleString()}
                      ({pendingCalcResult.discount_type === 'percent' ? `${pendingCalcResult.discount_value}%` : 'fixed'})
                    </p>
                  )}
                </div>
                <p className="text-xs text-destructive/80 font-medium">
                  This will overwrite the stored project price. This action cannot be undone automatically.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Confirm & Save"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AddItemsDialog
        open={showAddDialog}
        onOpenChange={setShowAddDialog}
        availableProducts={availableProducts}
        availablePackages={availablePackages}
        onAddProduct={(id) => handleAddItem("products", id)}
        onAddPackage={(id) => handleAddItem("packages", id)}
        isLoading={isSaving}
      />
    </div>
  );
}
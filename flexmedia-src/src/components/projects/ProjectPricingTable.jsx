import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { DollarSign, Plus, Minus, AlertCircle, Loader2, ChevronLeft, ChevronRight, Percent, Tag, Info, Lock, Unlock } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import Price from '@/components/common/Price';
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { useProjectItemsManager } from "./hooks/useProjectItemsManager";
import { useProjectPricingCalculator } from "./hooks/useProjectPricingCalculator";
import { usePermissions } from "@/components/auth/PermissionGuard";
import AddItemsDialog from "./AddItemsDialog";
import { PricingTableBody } from "./PricingTableBody";
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { normalizeProjectItems } from "@/components/lib/normalizeProjectItems";
import { writeFeedEvent } from "@/components/notifications/createNotification";
import { toast } from "sonner";

/**
 * Single-line badge that expresses the full matrix-resolution state for a
 * project at a glance. Summarises all scenarios the engine handles:
 *
 *   • no matrix at all          → "Standard · master pricing"
 *   • matrix use_default_pricing → "Standard · matrix ignored"
 *   • blanket discount (pkg)    → "Premium · Belle Strath · 20% packages"
 *   • blanket discount (both)   → "Premium · Ray White · 30% pkg + 20% prod"
 *   • overrides only            → "Standard · Balmain · N overrides, no blanket"
 *   • overrides + blanket       → "Premium · X · 20% pkg + N overrides"
 *
 * Hover reveals the full breakdown via a shadcn Tooltip.
 */
function MatrixStateBadge({ pricingTier, blanketMeta, snapshot }) {
  const tierLabel = pricingTier === "premium" ? "Premium" : "Standard";

  // Resolve the "shape" of what's pricing this project.
  let summary = "master pricing";
  let tone = "muted";  // slate | emerald | purple | amber | muted

  const useDefault = !!snapshot?.use_default_pricing;
  const pkgPct = blanketMeta?.package_percent || 0;
  const prodPct = blanketMeta?.product_percent || 0;
  const hasBlanket = pkgPct > 0 || prodPct > 0;
  const overrideCount =
    (snapshot?.product_pricing?.filter(p => p.override_enabled)?.length || 0) +
    (snapshot?.package_pricing?.filter(p => p.override_enabled)?.length || 0);
  const matrixName = snapshot?.entity_name || null;

  if (useDefault) {
    summary = "matrix ignored";
    tone = "muted";
  } else if (hasBlanket || overrideCount > 0) {
    const parts = [];
    if (pkgPct > 0) parts.push(`${pkgPct}% pkg`);
    if (prodPct > 0) parts.push(`${prodPct}% prod`);
    if (overrideCount > 0) parts.push(`${overrideCount} override${overrideCount === 1 ? "" : "s"}`);
    summary = parts.join(" + ");
    tone = hasBlanket ? "purple" : "emerald";
  } else if (snapshot) {
    summary = "no blanket";
    tone = "muted";
  }

  const colorClass = {
    purple: "border-purple-300 bg-purple-50 text-purple-800 dark:bg-purple-950/30 dark:text-purple-300 dark:border-purple-900/40",
    emerald: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300 dark:border-emerald-900/40",
    amber: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/40",
    muted: "border-border text-muted-foreground",
  }[tone];

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium cursor-help",
              colorClass,
            )}
          >
            <span className="font-semibold">{tierLabel}</span>
            {matrixName && <span className="opacity-70">·</span>}
            {matrixName && <span className="truncate max-w-[140px]">{matrixName}</span>}
            <span className="opacity-70">·</span>
            <span>{summary}</span>
            <Info className="h-3 w-3 opacity-50" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-sm">
          <div className="space-y-1.5">
            <div className="font-semibold">
              {tierLabel} tier
              {matrixName && <> · {matrixName} matrix</>}
            </div>
            {useDefault && (
              <div className="text-xs">
                Matrix is configured to <strong>use default pricing</strong> — all
                overrides and blanket discounts are ignored. Project prices at
                master tier.
              </div>
            )}
            {!useDefault && hasBlanket && (
              <>
                {pkgPct > 0 && (
                  <div className="text-xs">• <strong>{pkgPct}%</strong> off package base prices</div>
                )}
                {prodPct > 0 && (
                  <div className="text-xs">• <strong>{prodPct}%</strong> off standalone products + nested package extras</div>
                )}
                {pkgPct > 0 && prodPct === 0 && (
                  <div className="text-[10px] text-muted-foreground">Standalone products and package extras not rebated.</div>
                )}
              </>
            )}
            {!useDefault && overrideCount > 0 && (
              <div className="text-xs">
                • <strong>{overrideCount}</strong> per-item override{overrideCount === 1 ? "" : "s"}
                {" "}(matrix replaces master tier price for those lines)
              </div>
            )}
            {!useDefault && !hasBlanket && overrideCount === 0 && !snapshot && (
              <div className="text-xs">
                No price matrix for this project — lines price at master tier
                {pricingTier === "premium" ? " (premium)" : " (standard)"}.
              </div>
            )}
            {!useDefault && !hasBlanket && overrideCount === 0 && snapshot && (
              <div className="text-xs">
                Matrix exists but has no blanket discount or overrides enabled.
                Effectively pricing at master tier.
              </div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Lock badge shown next to MatrixStateBadge when `project.pricing_locked_at`
 * is set by the DB trigger (status=delivered + payment_status=paid). While
 * locked, the pricing table's edit UI is disabled — admins can explicitly
 * unlock via the adjacent "Unlock" button (see PricingUnlockDialog).
 */
function PricingLockBadge({ lockedAt }) {
  if (!lockedAt) return null;
  let lockedDate = "";
  try {
    lockedDate = format(new Date(lockedAt), "MMM d, yyyy");
  } catch {
    lockedDate = String(lockedAt).slice(0, 10);
  }
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[11px] font-medium cursor-help",
              "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-900/40",
            )}
          >
            <Lock className="h-3 w-3" />
            <span className="font-semibold">Pricing Locked</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-sm">
          <div className="space-y-1.5">
            <div className="font-semibold">Pricing is locked</div>
            <div className="text-xs">
              Locked on <strong>{lockedDate}</strong> (delivered + paid).
              Admin can unlock to make corrections.
            </div>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default function ProjectPricingTable({
  project,
  pricingTier = "standard",
  canSeePricing = false,
  canEdit = false,
  onTotalChange
}) {
  const projectId = project?.id;
  const queryClient = useQueryClient();
  const { isAdminOrAbove, user: currentUser } = usePermissions();

  // Pricing lock: migrations 204+205 auto-set pricing_locked_at on transition
  // into delivered+paid, and block UPDATEs to calculated_price/products/packages
  // while non-null. Derive `effectiveCanEdit` to disable edit UI locally without
  // touching the prop contract — parent keeps passing `canEdit` based on role,
  // we AND it with the lock state.
  const pricingLockedAt = project?.pricing_locked_at || null;
  const isPricingLocked = !!pricingLockedAt;
  const effectiveCanEdit = canEdit && !isPricingLocked;

  const [showUnlockDialog, setShowUnlockDialog] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [unlockError, setUnlockError] = useState(null);
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
      discount_mode: project?.discount_mode || 'discount',
    };
    setFormState(newFormState);
    setPendingTotal(null);
    setPendingCalcResult(null);
    setError(null);
  }, [project?.id, projectProductsJson, projectPackagesJson, project?.pricing_tier]);

  // Frontend calculator — now uses shared @pricing/engine (same math as backend).
  // Context carries the project's matrix-resolution keys so blanket discount +
  // per-item overrides are reflected in the live preview. Matches what the
  // backend would save, byte-for-byte. See useProjectPricingCalculator for
  // the engine delegation.
  const pricingContext = useMemo(() => ({
    agent_id: project?.agent_id || null,
    agency_id: project?.agency_id || null,
    project_type_id: project?.project_type_id || null,
  }), [project?.agent_id, project?.agency_id, project?.project_type_id]);
  const { breakdown } = useProjectPricingCalculator(formState, allProducts, allPackages, tierKey, pricingContext);

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

      // Pricing engine fetches fresh data from DB — no client cache refresh needed.
      const invokeBody = {
        agent_id: project?.agent_id || null,
        agency_id: project?.agency_id || null,
        products: formState.products,
        packages: formState.packages,
        pricing_tier: pricingTier,
        project_type_id: project?.project_type_id || null,
        discount_type: formState.discount_type || 'fixed',
        discount_value: parseFloat(formState.discount_value) || 0,
        discount_mode: formState.discount_mode || 'discount',
      };

      let response;
      try {
        response = await api.functions.invoke('calculateProjectPricing', invokeBody);
      } catch (invokeErr) {
        // Retry once — transient network or auth errors can occur
        console.warn("Pricing invoke failed, retrying:", invokeErr?.message);
        await new Promise(r => setTimeout(r, 1000));
        response = await api.functions.invoke('calculateProjectPricing', invokeBody);
      }
      if (response.data?.success) {
        setPendingTotal(response.data.calculated_price);
        setPendingCalcResult(response.data);
        setShowConfirmSave(true);
      } else {
        console.error("Pricing verification response:", response);
        setError("Pricing verification failed — server returned an error. Please try again.");
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

    // HARD GUARD (2026-04-20): block saves while catalog is still loading.
    // normalizeProjectItems relies on the full product/package list; an empty
    // catalog would drop every item during normalization and silently persist
    // products:[] and packages:[]. Root cause of 7 Tonomo projects losing
    // their packages. See also ProjectProductsPackages.handleSave guard.
    if (!Array.isArray(allProducts) || allProducts.length === 0 ||
        !Array.isArray(allPackages) || allPackages.length === 0) {
      setError('Product/package catalog still loading — please wait a moment and try again.');
      return;
    }

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

      // 2026-04-20: Tonomo is the authoritative source for products/packages.
      // We no longer write `manually_overridden_fields`, `manually_locked_product_ids`,
      // or `manually_locked_package_ids` from this save path. Every next Tonomo
      // webhook overwrites local edits — that's the intended behaviour. Legacy
      // values on existing rows are left untouched; the backend reconciler
      // ignores them (see processTonomoQueue/utils.ts::reconcileProductsPackagesAgainstLock).
      // Other override keys (e.g. agent_id, shoot_date) are preserved if present.

      await batchUpdate.mutateAsync({
        products: productsToSave,
        packages: packagesToSave,
        calculated_price: pendingCalcResult.calculated_price,
        price: pendingCalcResult.calculated_price,
        price_matrix_snapshot: pendingCalcResult.price_matrix_snapshot,
        pricing_tier: pricingTier,
        discount_type: formState.discount_type || 'fixed',
        discount_value: parseFloat(formState.discount_value) || 0,
        discount_mode: formState.discount_mode || 'discount',
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
            action: 'create_for_roles',
            roles: ['project_owner', 'master_admin'],
            type: 'project_pricing_changed',
            category: 'project',
            severity: 'info',
            title: `Pricing updated — ${projectName}`,
            message: `Price changed to $${Math.round(newPrice).toLocaleString()} (was $${Math.round(oldPrice).toLocaleString()}).`,
            projectId: projectId,
            projectName: projectName,
            ctaLabel: 'View Project',
            source: 'pricing',
            idempotencyKeySuffix: `price_${Math.round(newPrice)}_${Date.now()}`,
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
    const origDiscMode = project?.discount_mode || 'discount';
    if ((formState.discount_type || 'fixed') !== origDiscType) return true;
    if ((parseFloat(formState.discount_value) || 0) !== origDiscVal) return true;
    if ((formState.discount_mode || 'discount') !== origDiscMode) return true;

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

  // Pre-formatted lock date for dialog body copy
  const lockedDateStr = useMemo(() => {
    if (!pricingLockedAt) return "";
    try { return format(new Date(pricingLockedAt), "MMM d, yyyy 'at' h:mm a"); }
    catch { return String(pricingLockedAt).slice(0, 16); }
  }, [pricingLockedAt]);

  // Admin unlock: clears pricing_locked_at and writes a ProjectActivity audit row
  // containing the operator-provided reason. The DB trigger permits NULLing the
  // column (migration 205); any subsequent edit path immediately re-engages.
  // Reason is required (10+ chars) so audit trail isn't empty.
  const handleConfirmUnlock = async () => {
    setUnlockError(null);
    const reason = (unlockReason || "").trim();
    if (reason.length < 10) {
      setUnlockError("Please provide a reason (at least 10 characters).");
      return;
    }
    setIsUnlocking(true);
    try {
      // Direct supabase update — the DB trigger explicitly allows setting
      // pricing_locked_at = NULL (admin unlock path). The entity api would
      // also work, but the task spec calls out api._supabase for this.
      const { error: unlockErr } = await api._supabase
        .from("projects")
        .update({ pricing_locked_at: null })
        .eq("id", projectId);
      if (unlockErr) throw unlockErr;

      // Audit trail — same shape as other pricing activity rows
      const projectName = project?.title || project?.property_address || "Project";
      api.entities.ProjectActivity.create({
        project_id: projectId,
        project_title: projectName,
        action: "pricing_unlocked",
        description: `Pricing lock cleared. Reason: ${reason}`,
        user_name: currentUser?.full_name || currentUser?.email || "Unknown",
        user_email: currentUser?.email || "",
      }).catch(err => console.warn("[pricing_unlocked activity]", err?.message));

      // Invalidate project queries so the badge disappears + edit UI re-enables
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["Project"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      refetchEntityList("Project");

      toast.success("Pricing unlocked");
      setShowUnlockDialog(false);
      setUnlockReason("");
    } catch (err) {
      console.error("Pricing unlock failed:", err);
      setUnlockError(err?.message || "Failed to unlock pricing. Please try again.");
    } finally {
      setIsUnlocking(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/30 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-auto font-semibold underline cursor-pointer" title="Dismiss error" aria-label="Dismiss error">Dismiss</button>
        </div>
      )}

      <Card className="border-l-4 border-l-primary">
        <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4">
          <div className="flex items-center gap-2">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <DollarSign className="h-5 w-5 text-primary" />
            </div>
            <CardTitle>Pricing Breakdown</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            {/* Full matrix-state badge. Shows tier + resolved matrix
                configuration at a glance so users can see exactly what's
                pricing this project without hunting through tooltips.
                Scenarios covered:
                  - no matrix         → "Standard · master pricing"
                  - use_default       → "Standard · matrix ignored"
                  - blanket pkg only  → "Premium · Belle Strath · 20% pkg"
                  - blanket both      → "Premium · Ray White · 30% pkg + 20% prod"
                  - overrides only    → "Standard · Balmain · 1 override, no blanket"
            */}
            <MatrixStateBadge
              pricingTier={pricingTier}
              blanketMeta={breakdown.blanketMeta}
              snapshot={breakdown._engine?.price_matrix_snapshot}
            />
            {/* Lock badge — shown when DB has auto-locked pricing via trigger.
                Sits next to the matrix-state badge, not a replacement. */}
            <PricingLockBadge lockedAt={pricingLockedAt} />
            {/* Admin-only Unlock button — explicit action, writes audit log */}
            {isPricingLocked && isAdminOrAbove && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setUnlockError(null); setUnlockReason(""); setShowUnlockDialog(true); }}
                title="Unlock pricing for corrections"
                aria-label="Unlock pricing"
                className="h-7"
              >
                <Unlock className="h-3.5 w-3.5 mr-1" /> Unlock
              </Button>
            )}
            {effectiveCanEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowAddDialog(true)}
                title="Add products or packages"
                aria-label="Add products or packages"
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
               {effectiveCanEdit && (
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
                            {effectiveCanEdit && <th className="w-10" />}
                          </tr>
                        </thead>
                        <PricingTableBody
                        paginatedItems={paginatedItems}
                        breakdown={breakdown}
                        canEdit={effectiveCanEdit}
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
                              title="Previous page"
                              aria-label="Previous page"
                            >
                              <ChevronLeft className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
                              disabled={currentPage === totalPages - 1}
                              className="h-7 w-7 p-0"
                              title="Next page"
                              aria-label="Next page"
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

                {/* Matrix blanket discount row — only shown when a blanket
                    discount was actually applied. Proper shadcn Tooltip
                    (not native `title`) so it shows quickly and explains the
                    breakdown across all supported scenarios:
                    - BLANKET_PKG_ONLY: "20% off packages (base price)"
                    - BLANKET_PROD_ONLY: "10% off products + package extras"
                    - BLANKET_BOTH: both explained on separate lines
                    - Named matrix source (entity_name) always shown */}
                {breakdown.blanketDiscount > 0 && (() => {
                  const meta = breakdown.blanketMeta;
                  const pctParts = [];
                  if (meta?.package_percent > 0) pctParts.push(`${meta.package_percent}% packages`);
                  if (meta?.product_percent > 0) pctParts.push(`${meta.product_percent}% products`);
                  return (
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <div className="flex items-center justify-between px-4 py-2 cursor-help hover:bg-purple-50/50 dark:hover:bg-purple-950/20 rounded-md transition-colors">
                            <div className="flex items-center gap-2">
                              <Tag className="h-3.5 w-3.5 text-purple-500" />
                              <span className="text-sm text-purple-700 dark:text-purple-400">
                                Price Matrix Discount
                              </span>
                              {meta && (
                                <span className="text-[10px] text-muted-foreground">
                                  ({pctParts.join(' + ')})
                                </span>
                              )}
                              <Info className="h-3 w-3 text-purple-400/60" />
                            </div>
                            <span className="text-sm font-mono tabular-nums text-purple-600 dark:text-purple-400">
                              −<Price value={breakdown.blanketDiscount} />
                            </span>
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-sm">
                          <div className="space-y-1.5">
                            <div className="font-semibold">
                              Matrix rebate from{' '}
                              <span className="text-purple-300">
                                {meta?.matrix_entity_name || `${meta?.matrix_entity_type || 'agency'} matrix`}
                              </span>
                            </div>
                            {meta?.package_percent > 0 && (
                              <div className="text-xs">
                                • <strong>{meta.package_percent}%</strong> off package base price
                              </div>
                            )}
                            {meta?.product_percent > 0 && (
                              <div className="text-xs">
                                • <strong>{meta.product_percent}%</strong> off standalone products
                                {' '}+ nested package extras
                              </div>
                            )}
                            {meta?.package_percent > 0 && meta?.product_percent === 0 && (
                              <div className="text-[10px] text-muted-foreground mt-1">
                                Package base only — extras and standalone products not rebated
                              </div>
                            )}
                            <div className="text-[10px] text-muted-foreground pt-1 border-t border-white/10">
                              Manual per-project discounts/fees apply separately below.
                            </div>
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  );
                })()}

                {/* Manual discount / fee row */}
                <div className="flex items-center justify-between px-4 py-2 gap-3">
                  <div className="flex items-center gap-2">
                    {(formState.discount_mode || 'discount') === 'fee'
                      ? <><Plus className="h-3.5 w-3.5 text-amber-600" /><span className="text-sm text-amber-700 font-medium">Additional Fee</span></>
                      : <><Tag className="h-3.5 w-3.5 text-muted-foreground" /><span className="text-sm text-muted-foreground">Discount</span></>
                    }
                  </div>
                  {effectiveCanEdit ? (
                    <div className="flex items-center gap-1.5">
                      {/* Discount ↔ Fee mode toggle */}
                      <button
                        type="button"
                        onClick={() => {
                          const newMode = (formState.discount_mode || 'discount') === 'fee' ? 'discount' : 'fee';
                          setFormState(prev => ({ ...prev, discount_mode: newMode }));
                        }}
                        className={cn(
                          "flex items-center gap-1 h-8 px-2 rounded border text-xs font-medium transition-colors shrink-0",
                          (formState.discount_mode || 'discount') === 'fee'
                            ? "border-amber-300 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
                            : "border-border text-muted-foreground hover:bg-muted"
                        )}
                        title={`Switch to ${(formState.discount_mode || 'discount') === 'fee' ? 'discount (subtract)' : 'fee (add)'}`}
                      >
                        {(formState.discount_mode || 'discount') === 'fee' ? <><Plus className="h-3 w-3" />Fee</> : <><Minus className="h-3 w-3" />Disc</>}
                      </button>
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
                      {/* Show computed amount */}
                      {breakdown.manualDiscount > 0 && (
                        <span className="text-sm font-mono tabular-nums text-red-600 whitespace-nowrap">
                          −<Price value={breakdown.manualDiscount} />
                        </span>
                      )}
                      {breakdown.manualFee > 0 && (
                        <span className="text-sm font-mono tabular-nums text-amber-600 whitespace-nowrap">
                          +<Price value={breakdown.manualFee} />
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className={cn("text-sm font-mono tabular-nums", (formState.discount_mode || 'discount') === 'fee' ? "text-amber-600" : "text-red-600")}>
                      {breakdown.manualDiscount > 0 ? (
                        <>−<Price value={breakdown.manualDiscount} />
                          <span className="text-xs text-muted-foreground ml-1">
                            ({formState.discount_type === 'percent' ? `${formState.discount_value}%` : `$${formState.discount_value}`})
                          </span>
                        </>
                      ) : breakdown.manualFee > 0 ? (
                        <>+<Price value={breakdown.manualFee} />
                          <span className="text-xs text-muted-foreground ml-1">
                            ({formState.discount_type === 'percent' ? `${formState.discount_value}%` : `$${formState.discount_value}`} fee)
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
                    {effectiveCanEdit && hasChanges && (
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

      {/* Save / Discard bar — only shown when editing is active and there are
          pending changes. Gated on effectiveCanEdit so it disappears entirely
          when pricing is locked. */}
      {effectiveCanEdit && hasChanges && (
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

      {/* Muted "Unlock to edit" hint — shown in place of the save bar when the
          project is locked AND the user would otherwise have edit rights.
          Admins get an inline unlock shortcut; everyone else sees just the note. */}
      {canEdit && isPricingLocked && (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/40">
          <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <p className="text-sm text-muted-foreground flex-1">
            Pricing is locked — unlock to edit.
          </p>
          {isAdminOrAbove && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => { setUnlockError(null); setUnlockReason(""); setShowUnlockDialog(true); }}
            >
              <Unlock className="h-3.5 w-3.5 mr-1" /> Unlock
            </Button>
          )}
        </div>
      )}

      {/* Admin unlock confirmation — writes pricing_locked_at = null and logs
          a ProjectActivity row with the operator-provided reason. */}
      <AlertDialog open={showUnlockDialog} onOpenChange={(o) => { if (!isUnlocking) setShowUnlockDialog(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlock project pricing?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p>
                  This project was locked on <strong>{lockedDateStr || "—"}</strong> because
                  it's delivered + paid. Unlocking allows pricing changes. Please add
                  a reason (stored in audit log).
                </p>
                <div className="space-y-1">
                  <label htmlFor="unlock-reason" className="text-xs font-medium text-foreground">
                    Reason <span className="text-destructive">*</span>
                  </label>
                  <Textarea
                    id="unlock-reason"
                    value={unlockReason}
                    onChange={e => setUnlockReason(e.target.value)}
                    placeholder="e.g. Client requested extra retouch post-delivery; needs repricing."
                    rows={3}
                    className="text-sm"
                    disabled={isUnlocking}
                  />
                  <p className="text-[11px] text-muted-foreground">
                    Minimum 10 characters. This will be attached to the project activity log.
                  </p>
                </div>
                {unlockError && (
                  <div className="flex items-center gap-2 p-2 rounded bg-destructive/10 border border-destructive/30 text-xs text-destructive">
                    <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
                    <span>{unlockError}</span>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnlocking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); handleConfirmUnlock(); }}
              disabled={isUnlocking}
            >
              {isUnlocking ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Unlocking...</> : "Confirm Unlock"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
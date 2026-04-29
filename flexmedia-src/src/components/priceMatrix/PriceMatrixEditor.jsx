import { useState, useEffect, useRef } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { useEntityAccess } from '@/components/auth/useEntityAccess';
import AccessBadge from '@/components/auth/AccessBadge';
import { ChevronDown, ChevronUp, Save, RotateCcw, Building, User, Percent, History, AlertTriangle, Lock, TrendingUp, Crown, Sparkles, RefreshCw, ArrowLeftRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import PriceMatrixAuditLog from "./PriceMatrixAuditLog";
import PriceMatrixSummaryTable from "./PriceMatrixSummaryTable";
import RecomputeAffectedProjectsDialog from "./RecomputeAffectedProjectsDialog";

const safeNum = (val) => { const n = parseFloat(val); return isFinite(n) && n >= 0 ? n : 0; };
const clamp = (val, min, max) => Math.min(Math.max(safeNum(val), min), max);
const TIERS = ["standard", "premium"];
const MODES = [
  { value: "fixed",          label: "Fixed",      short: "$" },
  { value: "percent_off",    label: "% off",       short: "−%" },
  { value: "percent_markup", label: "% markup",    short: "+%" },
];
const TIER_LABEL = { standard: "Standard", premium: "Premium" };

// Build an empty per-tier block from a master-tier object. mode='fixed' with
// the master values pre-filled is the engine-equivalent of "no override" —
// users edit the values to make it actually do something. master_snapshot is
// captured at write time so stale-master detection works later.
function buildTierFixed(masterBase, masterUnit) {
  return {
    enabled: false,
    mode: "fixed",
    base: safeNum(masterBase),
    unit: safeNum(masterUnit),
    master_snapshot: {
      base: safeNum(masterBase),
      unit: safeNum(masterUnit),
      snapshot_at: new Date().toISOString(),
    },
  };
}
function buildPackageTierFixed(masterPrice) {
  return {
    enabled: false,
    mode: "fixed",
    price: safeNum(masterPrice),
    master_snapshot: {
      price: safeNum(masterPrice),
      snapshot_at: new Date().toISOString(),
    },
  };
}

export default function PriceMatrixEditor({ priceMatrix }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [localData, setLocalData] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [activeSection, setActiveSection] = useState("overrides"); // "overrides" | "summary"
  const [recomputeOpen, setRecomputeOpen] = useState(false);
  const lastSavedJsonRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    const incomingJson = JSON.stringify(priceMatrix);
    setLocalData(prev => {
      if (!prev) { lastSavedJsonRef.current = incomingJson; return priceMatrix; }
      // Only accept real-time updates if user has NO unsaved changes
      const localJson = JSON.stringify(prev);
      const hasUnsavedChanges = lastSavedJsonRef.current && localJson !== lastSavedJsonRef.current;
      if (hasUnsavedChanges) return prev; // protect unsaved work
      lastSavedJsonRef.current = incomingJson;
      return priceMatrix;
    });
  }, [priceMatrix]);

  const { data: products = [] } = useEntityList("Product", "name");
  const { data: packages = [] } = useEntityList("Package", "name");

  const { data: currentUser } = useQuery({
    queryKey: ["current-user"],
    queryFn: () => api.auth.me(),
    staleTime: 60000,
  });
  const { canViewPriceMatrixPricing, isAdminOrAbove } = usePermissions();
  const { canEdit, canView } = useEntityAccess('price_matrices');
  const canSeePrices = canViewPriceMatrixPricing;

  // Count of ACTIVE projects pinned to any version of this matrix.
  // Versioning layer: projects.price_matrix_version_id FK → price_matrix_versions.
  // We first resolve every version row for this matrix_id (current +
  // superseded) so a project still pinned to a pre-edit snapshot counts as
  // "affected" and will show up in the recompute modal. Only admins need
  // this signal, so the query is gated on isAdminOrAbove.
  const { data: affectedCount = 0 } = useQuery({
    queryKey: ["matrix-affected-projects", priceMatrix.id],
    enabled: !!priceMatrix.id && isAdminOrAbove,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: versions } = await api._supabase
        .from("price_matrix_versions")
        .select("id")
        .eq("matrix_id", priceMatrix.id);
      const versionIds = (versions || []).map((v) => v.id);
      if (versionIds.length === 0) return 0;
      const { count } = await api._supabase
        .from("projects")
        .select("id", { count: "exact", head: true })
        .in("price_matrix_version_id", versionIds)
        .eq("is_archived", false);
      return count || 0;
    },
  });

  const saveMutation = useMutation({
    mutationFn: async (data) => {
      if (!canEdit) throw new Error("You do not have permission to edit pricing.");
      const syncedProductPricing = (data.product_pricing || []).map(pp => {
        const master = products.find(p => p.id === pp.product_id);
        return master ? { ...pp, product_name: master.name } : pp;
      });
      const syncedPackagePricing = (data.package_pricing || []).map(pp => {
        const master = packages.find(p => p.id === pp.package_id);
        return master ? { ...pp, package_name: master.name } : pp;
      });
      // Engine v3: validate per-tier overrides. Each tier independently has
      // {enabled, mode, base/unit/price, percent}. We sanitise numeric fields
      // and clamp percents to [0, 100]. Legacy fields are dropped — backfill
      // in migration 361 ensured every row has tier_overrides populated.
      const validateProductTier = (tierObj) => {
        if (!tierObj) return { enabled: false, mode: "fixed", base: 0, unit: 0 };
        const mode = ["fixed", "percent_off", "percent_markup"].includes(tierObj.mode) ? tierObj.mode : "fixed";
        const out = {
          enabled: Boolean(tierObj.enabled),
          mode,
          master_snapshot: tierObj.master_snapshot || null,
        };
        if (mode === "fixed") {
          out.base = Math.max(0, parseFloat(tierObj.base) || 0);
          out.unit = Math.max(0, parseFloat(tierObj.unit) || 0);
        } else {
          out.percent = clamp(tierObj.percent, 0, 100);
        }
        return out;
      };
      const validatePackageTier = (tierObj) => {
        if (!tierObj) return { enabled: false, mode: "fixed", price: 0 };
        const mode = ["fixed", "percent_off", "percent_markup"].includes(tierObj.mode) ? tierObj.mode : "fixed";
        const out = {
          enabled: Boolean(tierObj.enabled),
          mode,
          master_snapshot: tierObj.master_snapshot || null,
        };
        if (mode === "fixed") {
          out.price = Math.max(0, parseFloat(tierObj.price) || 0);
        } else {
          out.percent = clamp(tierObj.percent, 0, 100);
        }
        return out;
      };
      const validatedProductPricing = syncedProductPricing.map(pp => ({
        product_id: pp.product_id,
        product_name: pp.product_name,
        tier_overrides: {
          standard: validateProductTier(pp.tier_overrides?.standard),
          premium:  validateProductTier(pp.tier_overrides?.premium),
        },
      }));
      const validatedPackagePricing = syncedPackagePricing.map(pp => ({
        package_id: pp.package_id,
        package_name: pp.package_name,
        tier_overrides: {
          standard: validatePackageTier(pp.tier_overrides?.standard),
          premium:  validatePackageTier(pp.tier_overrides?.premium),
        },
      }));
      const validatedBlanket = {
        enabled: Boolean(data.blanket_discount?.enabled),
        product_percent: Math.min(100, Math.max(0, parseFloat(data.blanket_discount?.product_percent) || 0)),
        package_percent: Math.min(100, Math.max(0, parseFloat(data.blanket_discount?.package_percent) || 0)),
      };
      // Enforce mutual exclusion: default mode disables blanket
      if (data.use_default_pricing) validatedBlanket.enabled = false;
      // Validate default_tier — only 'standard' | 'premium' | null allowed (matches DB CHECK)
      const validatedDefaultTier =
        data.default_tier === "standard" || data.default_tier === "premium"
          ? data.default_tier
          : null;
      const payload = {
        ...data,
        product_pricing: validatedProductPricing,
        package_pricing: validatedPackagePricing,
        blanket_discount: validatedBlanket,
        default_tier: validatedDefaultTier,
        last_modified_at: new Date().toISOString(),
        last_modified_by: currentUser?.email,
      };
      await api.entities.PriceMatrix.update(priceMatrix.id, payload);
      api.functions.invoke("logPriceMatrixChange", {
        price_matrix_id: priceMatrix.id,
        previous_state: priceMatrix,
        new_state: payload
      }).catch(() => {});
    },
    onSuccess: async () => {
      toast.success("Pricing saved");
      lastSavedJsonRef.current = JSON.stringify(localData);
      // PriceMatrix data is loaded via useEntityList (custom cache), not react-query,
      // so we must use refetchEntityList to actually refresh the UI.
      await refetchEntityList("PriceMatrix");
      refetchEntityList("PriceMatrixAuditLog");
      queryClient.invalidateQueries({ queryKey: ["price-matrix-audit", priceMatrix.id] });
      queryClient.invalidateQueries({ queryKey: ["matrix-affected-projects", priceMatrix.id] });

      // Force-recompute the Market Share substrate for every listing under this
      // matrix's agency/agent. The DB trigger from migration 193 has already
      // flipped them to quote_status='stale'; this RPC synchronously drains the
      // queue (up to 1000 rows) so the dashboard updates within seconds rather
      // than waiting 10min for the cron. See migration 193.
      const toastId = toast.loading("Recomputing affected Market Share listings...");
      try {
        const result = await api.rpc("pulse_compute_stale_quotes_for_matrix", {
          p_matrix_id: priceMatrix.id,
          p_limit: 1000,
        });
        const processed = Number(result?.processed ?? 0);
        const targetCount = Number(result?.target_count ?? processed);
        const errors = Number(result?.errors ?? 0);
        const label = processed === 1 ? "listing" : "listings";
        if (processed === 0 && targetCount === 0) {
          toast.info("No affected listings found for this matrix.", { id: toastId });
        } else if (errors > 0) {
          toast.warning(
            `Recomputed ${processed}/${targetCount} ${label} (${errors} errors).`,
            { id: toastId }
          );
        } else {
          toast.success(
            `${processed} ${label} recomputed. Market Share + Retention cards will refresh.`,
            { id: toastId, duration: 6000 }
          );
        }
        // Invalidate dashboard/retention query caches so the next fetch reads
        // the fresh substrate.
        queryClient.invalidateQueries({ queryKey: ["market-share"] });
        queryClient.invalidateQueries({ queryKey: ["pulse-market-share"] });
        queryClient.invalidateQueries({ queryKey: ["pulse-retention"] });
        queryClient.invalidateQueries({ queryKey: ["retention"] });
        queryClient.invalidateQueries({ queryKey: ["pulse-missed-top"] });
        queryClient.invalidateQueries({ queryKey: ["substrate-invalidation-stats"] });
      } catch (e) {
        console.error("substrate recompute failed:", e);
        toast.error(
          "Substrate recompute failed - cron will catch up within 10min.",
          { id: toastId }
        );
      }
    },
    onError: (error) => { console.error("Price matrix save error:", error); toast.error("Failed to save pricing. Please try again."); }
  });

  const setField = (path, value) => {
    setLocalData(prev => {
      const updated = { ...prev };
      const parts = path.split(".");
      let obj = updated;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = { ...(obj[parts[i]] || {}) };
        obj = obj[parts[i]];
      }
      obj[parts[parts.length - 1]] = value;
      return updated;
    });
  };

  const getProductPricing = (productId) => localData?.product_pricing?.find(p => p.product_id === productId);
  const getPackagePricing = (packageId) => localData?.package_pricing?.find(p => p.package_id === packageId);

  // Materialise a product_pricing entry with full tier_overrides scaffolding.
  // Used when the user first interacts with a product that has no row yet
  // (post-backfill this should be rare, but the UI may show products that
  // were added to the catalogue after the matrix was last edited).
  const materialiseProductRow = (product) => ({
    product_id: product.id,
    product_name: product.name,
    tier_overrides: {
      standard: buildTierFixed(product?.standard_tier?.base_price, product?.standard_tier?.unit_price),
      premium:  buildTierFixed(product?.premium_tier?.base_price,  product?.premium_tier?.unit_price),
    },
  });
  const materialisePackageRow = (pkg) => ({
    package_id: pkg.id,
    package_name: pkg.name,
    tier_overrides: {
      standard: buildPackageTierFixed(pkg?.standard_tier?.package_price),
      premium:  buildPackageTierFixed(pkg?.premium_tier?.package_price),
    },
  });

  // Patch a single tier sub-block on a product or package row. patch is a
  // partial object merged over the existing tier block (e.g. { enabled: true }
  // or { mode: 'percent_off', percent: 10 }).
  const patchProductTier = (productId, tier, patch) => {
    if (!canEdit) return;
    setLocalData(prev => {
      const product = products.find(p => p.id === productId);
      const list = [...(prev?.product_pricing || [])];
      let idx = list.findIndex(p => p.product_id === productId);
      if (idx === -1) {
        list.push(materialiseProductRow(product || { id: productId, name: productId }));
        idx = list.length - 1;
      }
      const row = list[idx];
      const currentTier = row.tier_overrides?.[tier]
        || buildTierFixed(product?.[`${tier}_tier`]?.base_price, product?.[`${tier}_tier`]?.unit_price);
      list[idx] = {
        ...row,
        tier_overrides: {
          ...(row.tier_overrides || {}),
          [tier]: { ...currentTier, ...patch },
        },
      };
      return { ...prev, product_pricing: list };
    });
  };

  const patchPackageTier = (packageId, tier, patch) => {
    if (!canEdit) return;
    setLocalData(prev => {
      const pkg = packages.find(p => p.id === packageId);
      const list = [...(prev?.package_pricing || [])];
      let idx = list.findIndex(p => p.package_id === packageId);
      if (idx === -1) {
        list.push(materialisePackageRow(pkg || { id: packageId, name: packageId }));
        idx = list.length - 1;
      }
      const row = list[idx];
      const currentTier = row.tier_overrides?.[tier]
        || buildPackageTierFixed(pkg?.[`${tier}_tier`]?.package_price);
      list[idx] = {
        ...row,
        tier_overrides: {
          ...(row.tier_overrides || {}),
          [tier]: { ...currentTier, ...patch },
        },
      };
      return { ...prev, package_pricing: list };
    });
  };

  // Toggle the per-tier `enabled` flag. When flipping ON, refresh the
  // master_snapshot so stale-master detection is anchored at this moment.
  const toggleProductTier = (productId, tier) => {
    if (!canEdit) return;
    const product = products.find(p => p.id === productId);
    const existing = getProductPricing(productId)?.tier_overrides?.[tier];
    const willEnable = !(existing?.enabled);
    const masterBase = safeNum(product?.[`${tier}_tier`]?.base_price);
    const masterUnit = safeNum(product?.[`${tier}_tier`]?.unit_price);
    patchProductTier(productId, tier, willEnable
      ? {
          enabled: true,
          mode: existing?.mode || "fixed",
          base: existing?.mode === "fixed" ? (existing?.base ?? masterBase) : masterBase,
          unit: existing?.mode === "fixed" ? (existing?.unit ?? masterUnit) : masterUnit,
          master_snapshot: { base: masterBase, unit: masterUnit, snapshot_at: new Date().toISOString() },
        }
      : { enabled: false }
    );
  };

  const togglePackageTier = (packageId, tier) => {
    if (!canEdit) return;
    const pkg = packages.find(p => p.id === packageId);
    const existing = getPackagePricing(packageId)?.tier_overrides?.[tier];
    const willEnable = !(existing?.enabled);
    const masterPrice = safeNum(pkg?.[`${tier}_tier`]?.package_price);
    patchPackageTier(packageId, tier, willEnable
      ? {
          enabled: true,
          mode: existing?.mode || "fixed",
          price: existing?.mode === "fixed" ? (existing?.price ?? masterPrice) : masterPrice,
          master_snapshot: { price: masterPrice, snapshot_at: new Date().toISOString() },
        }
      : { enabled: false }
    );
  };

  // Copy the override block from one tier to the other (in-place). Useful
  // shortcut when both tiers end up with the same override (e.g. a flat 10%
  // discount applied uniformly).
  const copyProductTier = (productId, fromTier, toTier) => {
    if (!canEdit) return;
    const row = getProductPricing(productId);
    const src = row?.tier_overrides?.[fromTier];
    if (!src) return;
    // Master snapshot stays anchored to the destination tier's master values
    // so stale-detection remains meaningful.
    const product = products.find(p => p.id === productId);
    const destMasterBase = safeNum(product?.[`${toTier}_tier`]?.base_price);
    const destMasterUnit = safeNum(product?.[`${toTier}_tier`]?.unit_price);
    patchProductTier(productId, toTier, {
      enabled: src.enabled,
      mode: src.mode || "fixed",
      base: src.base,
      unit: src.unit,
      percent: src.percent,
      master_snapshot: { base: destMasterBase, unit: destMasterUnit, snapshot_at: new Date().toISOString() },
    });
  };

  const copyPackageTier = (packageId, fromTier, toTier) => {
    if (!canEdit) return;
    const row = getPackagePricing(packageId);
    const src = row?.tier_overrides?.[fromTier];
    if (!src) return;
    const pkg = packages.find(p => p.id === packageId);
    const destMasterPrice = safeNum(pkg?.[`${toTier}_tier`]?.package_price);
    patchPackageTier(packageId, toTier, {
      enabled: src.enabled,
      mode: src.mode || "fixed",
      price: src.price,
      percent: src.percent,
      master_snapshot: { price: destMasterPrice, snapshot_at: new Date().toISOString() },
    });
  };

  if (!localData) return null;
  if (!canView) return <div className="p-8 text-center text-muted-foreground">You don't have access to this section.</div>;

  const hasChanges = JSON.stringify(localData) !== JSON.stringify(priceMatrix);
  const useDefault = localData.use_default_pricing ?? true;
  const blanketEnabled = localData.blanket_discount?.enabled || false;
  const Icon = localData.entity_type === "agency" ? Building : User;

  const matrixProjectTypeId = localData?.project_type_id || null;
  const activeProducts = products.filter(p => {
    if (p.is_active === false) return false;
    // If matrix is scoped to a project type, only show products for that type (or universal ones)
    if (matrixProjectTypeId && p.project_type_ids?.length > 0 && !p.project_type_ids.includes(matrixProjectTypeId)) return false;
    return true;
  });
  const activePackages = packages.filter(p => {
    if (p.is_active === false) return false;
    if (matrixProjectTypeId && p.project_type_ids?.length > 0 && !p.project_type_ids.includes(matrixProjectTypeId)) return false;
    return true;
  });

  const storedProductIds = new Set((localData.product_pricing || []).map(p => p.product_id));
  const storedPackageIds = new Set((localData.package_pricing || []).map(p => p.package_id));
  const newProducts = !useDefault && !blanketEnabled ? activeProducts.filter(p => !storedProductIds.has(p.id)) : [];
  const newPackages = !useDefault && !blanketEnabled ? activePackages.filter(p => !storedPackageIds.has(p.id)) : [];
  const hasCatalogueChanges = newProducts.length > 0 || newPackages.length > 0;

  return (
    <div className="border rounded-lg overflow-hidden bg-card">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-7 h-7 rounded bg-muted flex items-center justify-center flex-shrink-0">
          <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{localData.entity_name} <AccessBadge entityType="price_matrices" /></span>
            {localData.project_type_name && (
              <Badge variant="outline" className="text-xs h-5 border-primary/30 text-primary/80">{localData.project_type_name}</Badge>
            )}
            {useDefault ? (
              <Badge variant="secondary" className="text-xs h-5">Default</Badge>
            ) : blanketEnabled ? (
              <Badge className="text-xs h-5 bg-amber-100 text-amber-800 border-amber-200">
                <Percent className="h-3 w-3 mr-0.5" />
                {localData.blanket_discount?.product_percent ?? 0}% / {localData.blanket_discount?.package_percent ?? 0}%
              </Badge>
            ) : (
              <Badge className="text-xs h-5 bg-blue-100 text-blue-800 border-blue-200">Custom</Badge>
            )}
            {localData.default_tier === "premium" && (
              <Badge className="text-xs h-5 bg-purple-100 text-purple-800 border-purple-200" title="Default tier: Premium — matrix declares authoritative tier (engine skips proximity inheritance)">
                <Crown className="h-3 w-3 mr-0.5" />Prm tier
              </Badge>
            )}
            {localData.default_tier === "standard" && (
              <Badge className="text-xs h-5 bg-slate-100 text-slate-700 border-slate-200" title="Default tier: Standard — matrix declares authoritative tier (engine skips proximity inheritance)">
                Std tier
              </Badge>
            )}
            {hasChanges && <Badge variant="outline" className="text-xs h-5 text-orange-600 border-orange-300">Unsaved</Badge>}
            {hasCatalogueChanges && <Badge className="text-xs h-5 bg-orange-100 text-orange-700 border-orange-200"><AlertTriangle className="h-3 w-3 mr-0.5" />Catalogue update</Badge>}
            {isAdminOrAbove && affectedCount > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge variant="outline" className="text-xs h-5 border-blue-200 text-blue-700 bg-blue-50 cursor-help">
                    {affectedCount} active project{affectedCount === 1 ? "" : "s"}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  Projects currently priced against this matrix. Recompute after saving to bring them onto the latest version.
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1 flex-shrink-0">
          {!canEdit && (
            <Badge variant="outline" className="text-[10px] h-5 flex items-center gap-1 text-muted-foreground">
              <Lock className="h-3 w-3" />
              {canSeePrices ? "Read Only" : "Structure Only"}
            </Badge>
          )}
          {canEdit && hasChanges && (
            <>
              <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => { setLocalData(priceMatrix); toast.info("Changes discarded"); }} disabled={saveMutation.isPending}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" className="h-7 px-2 text-xs" onClick={() => saveMutation.mutate(localData)} disabled={saveMutation.isPending}>
                <Save className="h-3.5 w-3.5 mr-1" />{saveMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </>
          )}
          {isAdminOrAbove && !hasChanges && affectedCount > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  onClick={() => setRecomputeOpen(true)}
                  disabled={saveMutation.isPending}
                >
                  <RefreshCw className="h-3.5 w-3.5 mr-1" />
                  Recompute Affected
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                Preview + apply new prices to all {affectedCount} active project{affectedCount === 1 ? "" : "s"} on this matrix.
              </TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" size="sm" className={`h-7 w-7 p-0 ${showActivity ? "bg-muted" : ""}`} onClick={() => setShowActivity(v => !v)} title="Activity">
            <History className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setIsExpanded(v => !v)}>
            {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {/* Activity log */}
      {showActivity && (
        <div className="border-t px-4 py-3">
          <PriceMatrixAuditLog priceMatrixId={priceMatrix.id} />
        </div>
      )}

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t">
          {/* Default-tier selector — declares authoritative tier for this entity.
             Used by Market Share missed-opportunity engine (T1/T2 of tier cascade).
             "Auto-detect" = null = engine resolves via proximity to past projects. */}
          <div className="flex items-center gap-3 px-4 py-2.5 bg-muted/10 border-b">
            <div className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-xs font-medium text-muted-foreground">Default tier:</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => canEdit && setField("default_tier", null)}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  !localData.default_tier
                    ? "bg-secondary border-border font-medium"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"
                }`}
                title="Engine infers tier from nearest past project with this agency/agent"
              >
                Auto-detect
              </button>
              <button
                onClick={() => canEdit && setField("default_tier", "standard")}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                  localData.default_tier === "standard"
                    ? "bg-slate-100 border-slate-200 text-slate-800 font-medium"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"
                }`}
                title="This entity is always billed at standard tier"
              >
                Standard
              </button>
              <button
                onClick={() => canEdit && setField("default_tier", "premium")}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-0.5 ${
                  localData.default_tier === "premium"
                    ? "bg-purple-100 border-purple-200 text-purple-800 font-medium"
                    : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"
                }`}
                title="This entity is always billed at premium tier"
              >
                <Crown className="h-3 w-3" />Premium
              </button>
            </div>
            <span className="text-[11px] text-muted-foreground ml-auto">
              {localData.default_tier
                ? `Engine will use ${localData.default_tier} tier directly`
                : "Engine will infer tier from nearest past project"}
            </span>
          </div>

          {/* Mode bar */}
          <div className="flex items-center justify-between px-4 py-2.5 bg-muted/30 border-b">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-muted-foreground">Mode:</span>
              <button
                onClick={() => {
                  if (!canEdit) return;
                  if (!useDefault) {
                    // Switching TO default: explicitly disable blanket discount
                    setLocalData(prev => ({ ...prev, use_default_pricing: true, blanket_discount: { ...(prev.blanket_discount || {}), enabled: false } }));
                  } else {
                    setField("use_default_pricing", false);
                  }
                }}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${useDefault ? "bg-secondary border-border font-medium" : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"}`}
              >
                Default
              </button>
              <button
                onClick={() => {
                  if (!canEdit) return;
                  if (useDefault) setField("use_default_pricing", false);
                  setLocalData(prev => ({ ...prev, use_default_pricing: false, blanket_discount: { ...(prev.blanket_discount || {}), enabled: false } }));
                }}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors ${!useDefault && !blanketEnabled ? "bg-blue-100 border-blue-200 text-blue-800 font-medium" : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"}`}
              >
                Custom
              </button>
              <button
                onClick={() => {
                  if (!canEdit) return;
                  setLocalData(prev => ({ ...prev, use_default_pricing: false, blanket_discount: { ...(prev.blanket_discount || {}), enabled: !blanketEnabled } }));
                }}
                disabled={!canEdit}
                className={`text-xs px-2 py-0.5 rounded border transition-colors flex items-center gap-0.5 ${!useDefault && blanketEnabled ? "bg-amber-100 border-amber-200 text-amber-800 font-medium" : "bg-transparent border-transparent text-muted-foreground hover:bg-muted"}`}
              >
                <Percent className="h-3 w-3" />Blanket
              </button>
            </div>
            {!useDefault && (
              <div className="flex items-center gap-1 text-xs text-muted-foreground border-l pl-3">
                <button onClick={() => setActiveSection("overrides")} className={`px-2 py-0.5 rounded ${activeSection === "overrides" ? "bg-muted font-medium text-foreground" : "hover:bg-muted/60"}`}>Overrides</button>
                <button onClick={() => setActiveSection("summary")} className={`px-2 py-0.5 rounded ${activeSection === "summary" ? "bg-muted font-medium text-foreground" : "hover:bg-muted/60"}`}>Summary</button>
              </div>
            )}
          </div>

          {useDefault ? (
            <div className="p-4">
              <p className="text-xs text-muted-foreground text-center py-2">Using master catalogue pricing. Switch to Custom or Blanket to configure.</p>
              <PriceMatrixSummaryTable priceMatrix={localData} products={activeProducts} packages={activePackages} />
            </div>
          ) : (
            <div>
              {/* Blanket discount inputs */}
              {blanketEnabled && (
                <div className="flex items-center gap-4 px-4 py-3 bg-amber-50 border-b">
                  <span className="text-xs font-medium text-amber-800">Blanket Discount:</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-amber-700">Products</span>
                    <Input
                      type="number" step="1" min="0" max="100"
                      value={localData.blanket_discount?.product_percent ?? 0}
                      onChange={(e) => setField("blanket_discount.product_percent", clamp(e.target.value, 0, 100))}
                      className="h-7 w-20 text-xs bg-card border-amber-200"
                    />
                    <span className="text-xs text-amber-700">%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-amber-700">Packages</span>
                    <Input
                      type="number" step="1" min="0" max="100"
                      value={localData.blanket_discount?.package_percent ?? 0}
                      onChange={(e) => setField("blanket_discount.package_percent", clamp(e.target.value, 0, 100))}
                      className="h-7 w-20 text-xs bg-card border-amber-200"
                    />
                    <span className="text-xs text-amber-700">%</span>
                  </div>
                </div>
              )}

              {/* Catalogue change alert */}
              {hasCatalogueChanges && !blanketEnabled && (
                <div className="flex items-start gap-2 px-4 py-2.5 bg-orange-50 border-b text-xs text-orange-800">
                  <AlertTriangle className="h-3.5 w-3.5 text-orange-500 mt-0.5 flex-shrink-0" />
                  <span>
                    <strong>Catalogue update:</strong>{" "}
                    {[...newProducts.map(p => p.name), ...newPackages.map(p => p.name)].join(", ")} added since last edit — using master pricing.
                  </span>
                </div>
              )}

              {activeSection === "overrides" && !blanketEnabled && (
                <OverridesTable
                  activeProducts={activeProducts}
                  activePackages={activePackages}
                  getProductPricing={getProductPricing}
                  getPackagePricing={getPackagePricing}
                  patchProductTier={patchProductTier}
                  patchPackageTier={patchPackageTier}
                  toggleProductTier={toggleProductTier}
                  togglePackageTier={togglePackageTier}
                  copyProductTier={copyProductTier}
                  copyPackageTier={copyPackageTier}
                  newProducts={newProducts}
                  newPackages={newPackages}
                  canEdit={canEdit}
                  canSeePrices={canSeePrices}
                />
              )}

              {(activeSection === "summary" || blanketEnabled) && (
                <div className="p-4">
                  <PriceMatrixSummaryTable priceMatrix={localData} products={activeProducts} packages={activePackages} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isAdminOrAbove && (
        <RecomputeAffectedProjectsDialog
          open={recomputeOpen}
          onOpenChange={setRecomputeOpen}
          matrixId={priceMatrix.id}
          matrixLabel={`${priceMatrix.entity_name || ""}${priceMatrix.project_type_name ? ` — ${priceMatrix.project_type_name}` : ""}`.trim()}
        />
      )}
    </div>
  );
}

function PriceInput({ value, onChange, onBlur, readOnly, masked }) {
  if (masked) {
    return (
      <div className="flex items-center">
        <span className="text-xs text-muted-foreground mr-0.5">$</span>
        <span className="h-7 w-20 text-xs flex items-center text-muted-foreground">***</span>
      </div>
    );
  }
  return (
    <div className="flex items-center">
      <span className="text-xs text-muted-foreground mr-0.5">$</span>
      <Input
        type="number" step="5" min="0" value={value}
        onChange={onChange} onBlur={onBlur}
        className="h-7 w-20 text-xs tabular-nums px-1.5"
        readOnly={readOnly}
      />
    </div>
  );
}

// Engine v3 OverridesTable — two sub-rows per product/package, one per tier.
// Each sub-row independently controls: enabled, mode (fixed | percent_off |
// percent_markup), values. Master tier price is shown as a pinned reference
// for each row. A "copy" button mirrors the override from the OPPOSITE tier.
function OverridesTable({
  activeProducts, activePackages,
  getProductPricing, getPackagePricing,
  patchProductTier, patchPackageTier,
  toggleProductTier, togglePackageTier,
  copyProductTier, copyPackageTier,
  newProducts, newPackages, canEdit, canSeePrices = true,
}) {
  const masked = !canSeePrices;
  return (
    <div>
      {activeProducts.length > 0 && (
        <div>
          <div className="px-4 py-2 bg-muted/20 border-b">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Products</span>
          </div>
          <div className="divide-y">
            {activeProducts.map(product => (
              <ProductOverrideCard
                key={product.id}
                product={product}
                pricing={getProductPricing(product.id)}
                isNew={newProducts.some(p => p.id === product.id)}
                patchTier={patchProductTier}
                toggleTier={toggleProductTier}
                copyTier={copyProductTier}
                canEdit={canEdit}
                masked={masked}
              />
            ))}
          </div>
        </div>
      )}

      {activePackages.length > 0 && (
        <div className="border-t">
          <div className="px-4 py-2 bg-muted/20 border-b">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Packages</span>
          </div>
          <div className="divide-y">
            {activePackages.map(pkg => (
              <PackageOverrideCard
                key={pkg.id}
                pkg={pkg}
                pricing={getPackagePricing(pkg.id)}
                isNew={newPackages.some(p => p.id === pkg.id)}
                patchTier={patchPackageTier}
                toggleTier={togglePackageTier}
                copyTier={copyPackageTier}
                canEdit={canEdit}
                masked={masked}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One product = one card with two tier sub-rows.
function ProductOverrideCard({ product, pricing, isNew, patchTier, toggleTier, copyTier, canEdit, masked }) {
  const isPerUnit = product.pricing_type === "per_unit";
  const anyEnabled = TIERS.some(t => pricing?.tier_overrides?.[t]?.enabled);
  return (
    <div className={`px-4 py-3 ${isNew ? "bg-orange-50/40" : anyEnabled ? "bg-blue-50/20" : ""}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">{product.name}</span>
        {isNew && <Badge className="text-xs h-4 bg-orange-100 text-orange-700 border-orange-200 px-1">New</Badge>}
        <Badge variant="outline" className="text-[10px] h-4 px-1 text-muted-foreground">
          {isPerUnit ? "per-unit" : "fixed"}
        </Badge>
      </div>
      <div className="space-y-1.5">
        {TIERS.map(tier => (
          <ProductTierRow
            key={tier}
            product={product}
            tier={tier}
            block={pricing?.tier_overrides?.[tier]}
            patchTier={patchTier}
            toggleTier={toggleTier}
            copyTier={copyTier}
            canEdit={canEdit}
            masked={masked}
            isPerUnit={isPerUnit}
          />
        ))}
      </div>
    </div>
  );
}

function ProductTierRow({ product, tier, block, patchTier, toggleTier, copyTier, canEdit, masked, isPerUnit }) {
  const masterTier = product[`${tier}_tier`] || {};
  const masterBase = safeNum(masterTier.base_price);
  const masterUnit = safeNum(masterTier.unit_price);
  const enabled = Boolean(block?.enabled);
  const mode = block?.mode || "fixed";
  const otherTier = tier === "standard" ? "premium" : "standard";

  // Stale-master detection: block.master_snapshot was captured at toggle time.
  const snap = block?.master_snapshot || {};
  const baseDrifted = snap.base !== undefined && Number(snap.base) !== masterBase;
  const unitDrifted = snap.unit !== undefined && Number(snap.unit) !== masterUnit;

  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${enabled ? `${tier === "premium" ? "bg-purple-50" : "bg-slate-50"} border border-transparent` : "bg-muted/10"}`}>
      {/* Tier label + enable */}
      <div className="flex items-center gap-1.5 w-[110px] flex-shrink-0">
        <Switch checked={enabled} onCheckedChange={() => toggleTier(product.id, tier)} disabled={!canEdit} className="scale-75" />
        <span className="text-xs font-medium">
          {tier === "premium" && <Crown className="h-3 w-3 inline mr-0.5 text-purple-600" />}
          {TIER_LABEL[tier]}
        </span>
      </div>

      {/* Mode selector — only when enabled */}
      {enabled ? (
        <select
          value={mode}
          disabled={!canEdit}
          onChange={(e) => patchTier(product.id, tier, { mode: e.target.value })}
          className="h-6 text-xs rounded border bg-background px-1 disabled:opacity-50"
        >
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      ) : (
        <span className="text-xs text-muted-foreground italic w-[80px]">using master</span>
      )}

      {/* Inputs — vary by mode */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        {!enabled ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            ${masterBase}{isPerUnit ? ` + $${masterUnit}/unit` : ""} <span className="text-muted-foreground/60">(master)</span>
          </span>
        ) : mode === "fixed" ? (
          <>
            <TierFieldGroup
              label="Base"
              value={block?.base ?? masterBase}
              master={masterBase}
              snapped={snap.base}
              drifted={baseDrifted}
              onChange={(v) => patchTier(product.id, tier, { base: v })}
              canEdit={canEdit} masked={masked}
            />
            {isPerUnit && (
              <TierFieldGroup
                label="Unit"
                value={block?.unit ?? masterUnit}
                master={masterUnit}
                snapped={snap.unit}
                drifted={unitDrifted}
                onChange={(v) => patchTier(product.id, tier, { unit: v })}
                canEdit={canEdit} masked={masked}
              />
            )}
          </>
        ) : (
          <PercentFieldGroup
            mode={mode}
            value={block?.percent ?? 0}
            masterBase={masterBase}
            masterUnit={isPerUnit ? masterUnit : null}
            onChange={(v) => patchTier(product.id, tier, { percent: v })}
            canEdit={canEdit} masked={masked}
          />
        )}
      </div>

      {/* Copy from other tier */}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm" variant="ghost"
            className="h-6 w-6 p-0 flex-shrink-0"
            onClick={() => copyTier(product.id, otherTier, tier)}
            disabled={!canEdit}
          >
            <ArrowLeftRight className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy {TIER_LABEL[otherTier]} → {TIER_LABEL[tier]}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function PackageOverrideCard({ pkg, pricing, isNew, patchTier, toggleTier, copyTier, canEdit, masked }) {
  const anyEnabled = TIERS.some(t => pricing?.tier_overrides?.[t]?.enabled);
  return (
    <div className={`px-4 py-3 ${isNew ? "bg-orange-50/40" : anyEnabled ? "bg-blue-50/20" : ""}`}>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium">{pkg.name}</span>
        {isNew && <Badge className="text-xs h-4 bg-orange-100 text-orange-700 border-orange-200 px-1">New</Badge>}
      </div>
      <div className="space-y-1.5">
        {TIERS.map(tier => (
          <PackageTierRow
            key={tier}
            pkg={pkg}
            tier={tier}
            block={pricing?.tier_overrides?.[tier]}
            patchTier={patchTier}
            toggleTier={toggleTier}
            copyTier={copyTier}
            canEdit={canEdit}
            masked={masked}
          />
        ))}
      </div>
    </div>
  );
}

function PackageTierRow({ pkg, tier, block, patchTier, toggleTier, copyTier, canEdit, masked }) {
  const masterPrice = safeNum(pkg[`${tier}_tier`]?.package_price);
  const enabled = Boolean(block?.enabled);
  const mode = block?.mode || "fixed";
  const otherTier = tier === "standard" ? "premium" : "standard";
  const snap = block?.master_snapshot || {};
  const drifted = snap.price !== undefined && Number(snap.price) !== masterPrice;

  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded ${enabled ? `${tier === "premium" ? "bg-purple-50" : "bg-slate-50"} border border-transparent` : "bg-muted/10"}`}>
      <div className="flex items-center gap-1.5 w-[110px] flex-shrink-0">
        <Switch checked={enabled} onCheckedChange={() => toggleTier(pkg.id, tier)} disabled={!canEdit} className="scale-75" />
        <span className="text-xs font-medium">
          {tier === "premium" && <Crown className="h-3 w-3 inline mr-0.5 text-purple-600" />}
          {TIER_LABEL[tier]}
        </span>
      </div>

      {enabled ? (
        <select
          value={mode}
          disabled={!canEdit}
          onChange={(e) => patchTier(pkg.id, tier, { mode: e.target.value })}
          className="h-6 text-xs rounded border bg-background px-1 disabled:opacity-50"
        >
          {MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      ) : (
        <span className="text-xs text-muted-foreground italic w-[80px]">using master</span>
      )}

      <div className="flex items-center gap-3 flex-1 min-w-0">
        {!enabled ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            ${masterPrice} <span className="text-muted-foreground/60">(master)</span>
          </span>
        ) : mode === "fixed" ? (
          <TierFieldGroup
            label="Price"
            value={block?.price ?? masterPrice}
            master={masterPrice}
            snapped={snap.price}
            drifted={drifted}
            onChange={(v) => patchTier(pkg.id, tier, { price: v })}
            canEdit={canEdit} masked={masked}
          />
        ) : (
          <PercentFieldGroup
            mode={mode}
            value={block?.percent ?? 0}
            masterBase={masterPrice}
            masterUnit={null}
            onChange={(v) => patchTier(pkg.id, tier, { percent: v })}
            canEdit={canEdit} masked={masked}
          />
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm" variant="ghost"
            className="h-6 w-6 p-0 flex-shrink-0"
            onClick={() => copyTier(pkg.id, otherTier, tier)}
            disabled={!canEdit}
          >
            <ArrowLeftRight className="h-3 w-3" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy {TIER_LABEL[otherTier]} → {TIER_LABEL[tier]}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function TierFieldGroup({ label, value, master, snapped, drifted, onChange, canEdit, masked }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</span>
      <PriceInput
        value={value}
        onChange={(e) => canEdit && onChange(safeNum(e.target.value))}
        onBlur={(e) => canEdit && onChange(clamp(e.target.value, 0, Infinity))}
        readOnly={!canEdit}
        masked={masked}
      />
      <span className="text-[10px] text-muted-foreground/70 tabular-nums">/ master ${master}</span>
      {drifted && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="text-[10px] text-amber-600 flex items-center gap-0.5 cursor-help">
              <TrendingUp className="h-2.5 w-2.5" />was ${snapped}
            </span>
          </TooltipTrigger>
          <TooltipContent>Master {label.toLowerCase()} changed since override was last set</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

function PercentFieldGroup({ mode, value, masterBase, masterUnit, onChange, canEdit, masked }) {
  const sign = mode === "percent_off" ? -1 : 1;
  const factor = 1 + (sign * Number(value || 0)) / 100;
  const previewBase = Math.max(0, masterBase * factor);
  const previewUnit = masterUnit != null ? Math.max(0, masterUnit * factor) : null;
  return (
    <div className="flex items-center gap-1">
      <Input
        type="number" step="1" min="0" max="100"
        value={value ?? 0}
        onChange={(e) => canEdit && onChange(clamp(e.target.value, 0, 100))}
        readOnly={!canEdit}
        className="h-7 w-16 text-xs px-1.5 tabular-nums"
      />
      <span className="text-xs text-muted-foreground">%</span>
      <span className="text-[10px] text-muted-foreground/70 tabular-nums">
        →{masked ? " ***" : ` $${previewBase.toFixed(0)}`}{previewUnit != null ? (masked ? " / ***" : ` / $${previewUnit.toFixed(0)}/u`) : ""}
        <span className="text-muted-foreground/60"> from ${masterBase}{masterUnit != null ? `/$${masterUnit}` : ""}</span>
      </span>
    </div>
  );
}
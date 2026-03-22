import { useState, useEffect } from "react";
import { api } from "@/api/supabaseClient";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEntityList, refetchEntityList } from "@/components/hooks/useEntityData";
import { usePermissions } from "@/components/auth/PermissionGuard";
import { ChevronDown, ChevronUp, Save, RotateCcw, Building, User, Percent, History, AlertTriangle, Lock, TrendingUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import PriceMatrixAuditLog from "./PriceMatrixAuditLog";
import PriceMatrixSummaryTable from "./PriceMatrixSummaryTable";

const safeNum = (val) => { const n = parseFloat(val); return isFinite(n) && n >= 0 ? n : 0; };
const clamp = (val, min, max) => Math.min(Math.max(safeNum(val), min), max);

export default function PriceMatrixEditor({ priceMatrix }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [localData, setLocalData] = useState(null);
  const [showActivity, setShowActivity] = useState(false);
  const [activeSection, setActiveSection] = useState("overrides"); // "overrides" | "summary"
  const [lastSavedJson, setLastSavedJson] = useState(null);

  useEffect(() => {
    const incomingJson = JSON.stringify(priceMatrix);
    setLocalData(prev => {
      if (!prev) { setLastSavedJson(incomingJson); return priceMatrix; }
      // Only accept real-time updates if user has NO unsaved changes
      const localJson = JSON.stringify(prev);
      const hasUnsavedChanges = lastSavedJson && localJson !== lastSavedJson;
      if (hasUnsavedChanges) return prev; // protect unsaved work
      setLastSavedJson(incomingJson);
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
  const { canEditPriceMatrix, canViewPriceMatrixPricing, priceMatrixAccess } = usePermissions();
  const canEdit = canEditPriceMatrix;
  const canSeePrices = canViewPriceMatrixPricing;

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
      const validatedProductPricing = syncedProductPricing.map(pp => ({
        ...pp,
        standard_base: Math.max(0, parseFloat(pp.standard_base) || 0),
        standard_unit: Math.max(0, parseFloat(pp.standard_unit) || 0),
        premium_base: Math.max(0, parseFloat(pp.premium_base) || 0),
        premium_unit: Math.max(0, parseFloat(pp.premium_unit) || 0),
      }));
      const validatedPackagePricing = syncedPackagePricing.map(pp => ({
        ...pp,
        standard_price: Math.max(0, parseFloat(pp.standard_price) || 0),
        premium_price: Math.max(0, parseFloat(pp.premium_price) || 0),
      }));
      const validatedBlanket = {
        enabled: Boolean(data.blanket_discount?.enabled),
        product_percent: Math.min(100, Math.max(0, parseFloat(data.blanket_discount?.product_percent) || 0)),
        package_percent: Math.min(100, Math.max(0, parseFloat(data.blanket_discount?.package_percent) || 0)),
      };
      // Enforce mutual exclusion: default mode disables blanket
      if (data.use_default_pricing) validatedBlanket.enabled = false;
      const payload = {
        ...data,
        product_pricing: validatedProductPricing,
        package_pricing: validatedPackagePricing,
        blanket_discount: validatedBlanket,
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
      setLastSavedJson(JSON.stringify(localData));
      await refetchEntityList("PriceMatrix");
      refetchEntityList("PriceMatrixAuditLog");
    },
    onError: (error) => toast.error("Failed to save: " + (error?.message || "Unknown error"))
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

  const setProductField = (productId, field, value) => {
    setLocalData(prev => {
      const list = [...(prev?.product_pricing || [])];
      const idx = list.findIndex(p => p.product_id === productId);
      const product = products.find(p => p.id === productId);
      const coerced = field === "override_enabled" ? Boolean(value) : safeNum(value);
      if (idx === -1) {
        list.push({
          product_id: productId, product_name: product?.name || productId,
          override_enabled: false,
          standard_base: product?.standard_tier?.base_price || 0,
          standard_unit: product?.standard_tier?.unit_price || 0,
          premium_base: product?.premium_tier?.base_price || 0,
          premium_unit: product?.premium_tier?.unit_price || 0,
          [field]: coerced
        });
      } else { list[idx] = { ...list[idx], [field]: coerced }; }
      return { ...prev, product_pricing: list };
    });
  };

  const setPackageField = (packageId, field, value) => {
    setLocalData(prev => {
      const list = [...(prev?.package_pricing || [])];
      const idx = list.findIndex(p => p.package_id === packageId);
      const pkg = packages.find(p => p.id === packageId);
      const coerced = field === "override_enabled" ? Boolean(value) : safeNum(value);
      if (idx === -1) {
        list.push({
          package_id: packageId, package_name: pkg?.name || packageId,
          override_enabled: false,
          standard_price: pkg?.standard_tier?.package_price || 0,
          premium_price: pkg?.premium_tier?.package_price || 0,
          [field]: coerced
        });
      } else { list[idx] = { ...list[idx], [field]: coerced }; }
      return { ...prev, package_pricing: list };
    });
  };

  const toggleProductOverride = (productId) => {
    if (!canEdit) return;
    setLocalData(prev => {
      const existing = prev?.product_pricing?.find(p => p.product_id === productId);
      const product = products.find(p => p.id === productId);
      const masterSnapshot = {
        master_standard_base: product?.standard_tier?.base_price ?? 0,
        master_standard_unit: product?.standard_tier?.unit_price ?? 0,
        master_premium_base: product?.premium_tier?.base_price ?? 0,
        master_premium_unit: product?.premium_tier?.unit_price ?? 0,
        master_snapshot_at: new Date().toISOString(),
      };
      if (existing) {
        return {
          ...prev,
          product_pricing: prev.product_pricing.map(p =>
            p.product_id === productId
              ? { ...p, override_enabled: !p.override_enabled, ...((!p.override_enabled) ? masterSnapshot : {}) }
              : p
          )
        };
      }
      return {
        ...prev,
        product_pricing: [...(prev?.product_pricing || []), {
          product_id: productId, product_name: product?.name || productId,
          override_enabled: true,
          standard_base: product?.standard_tier?.base_price || 0,
          standard_unit: product?.standard_tier?.unit_price || 0,
          premium_base: product?.premium_tier?.base_price || 0,
          premium_unit: product?.premium_tier?.unit_price || 0,
          ...masterSnapshot
        }]
      };
    });
  };

  const togglePackageOverride = (packageId) => {
    if (!canEdit) return;
    setLocalData(prev => {
      const existing = prev?.package_pricing?.find(p => p.package_id === packageId);
      const pkg = packages.find(p => p.id === packageId);
      const masterSnapshot = {
        master_standard_price: pkg?.standard_tier?.package_price ?? 0,
        master_premium_price: pkg?.premium_tier?.package_price ?? 0,
        master_snapshot_at: new Date().toISOString(),
      };
      if (existing) {
        return {
          ...prev,
          package_pricing: prev.package_pricing.map(p =>
            p.package_id === packageId
              ? { ...p, override_enabled: !p.override_enabled, ...((!p.override_enabled) ? masterSnapshot : {}) }
              : p
          )
        };
      }
      return {
        ...prev,
        package_pricing: [...(prev?.package_pricing || []), {
          package_id: packageId, package_name: pkg?.name || packageId,
          override_enabled: true,
          standard_price: pkg?.standard_tier?.package_price || 0,
          premium_price: pkg?.premium_tier?.package_price || 0,
          ...masterSnapshot
        }]
      };
    });
  };

  if (!localData) return null;

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
            <span className="font-medium text-sm">{localData.entity_name}</span>
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
            {hasChanges && <Badge variant="outline" className="text-xs h-5 text-orange-600 border-orange-300">Unsaved</Badge>}
            {hasCatalogueChanges && <Badge className="text-xs h-5 bg-orange-100 text-orange-700 border-orange-200"><AlertTriangle className="h-3 w-3 mr-0.5" />Catalogue update</Badge>}
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
                      className="h-7 w-20 text-xs bg-white border-amber-200"
                    />
                    <span className="text-xs text-amber-700">%</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-amber-700">Packages</span>
                    <Input
                      type="number" step="1" min="0" max="100"
                      value={localData.blanket_discount?.package_percent ?? 0}
                      onChange={(e) => setField("blanket_discount.package_percent", clamp(e.target.value, 0, 100))}
                      className="h-7 w-20 text-xs bg-white border-amber-200"
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
                  toggleProductOverride={toggleProductOverride}
                  togglePackageOverride={togglePackageOverride}
                  setProductField={setProductField}
                  setPackageField={setPackageField}
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

function OverridesTable({ activeProducts, activePackages, getProductPricing, getPackagePricing, toggleProductOverride, togglePackageOverride, setProductField, setPackageField, newProducts, newPackages, canEdit, canSeePrices = true }) {
  const masked = !canSeePrices;
  return (
    <div>
      {/* Products table */}
      {activeProducts.length > 0 && (
        <div>
          <div className="px-4 py-2 bg-muted/20 border-b">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Products</span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/10">
                <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium w-[200px]">Name</th>
                <th className="text-center px-3 py-2 text-xs text-muted-foreground font-medium w-20">Override</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Std Base</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Std Unit</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Pre Base</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Pre Unit</th>
              </tr>
            </thead>
            <tbody>
              {activeProducts.map(product => {
                const pricing = getProductPricing(product.id);
                const isEnabled = pricing?.override_enabled || false;
                const isNew = newProducts.some(p => p.id === product.id);
                const fields = [
                  { field: "standard_base", val: pricing?.standard_base ?? product.standard_tier?.base_price ?? 0, master: product.standard_tier?.base_price ?? 0, snap: "master_standard_base" },
                  { field: "standard_unit", val: pricing?.standard_unit ?? product.standard_tier?.unit_price ?? 0, master: product.standard_tier?.unit_price ?? 0, snap: "master_standard_unit" },
                  { field: "premium_base", val: pricing?.premium_base ?? product.premium_tier?.base_price ?? 0, master: product.premium_tier?.base_price ?? 0, snap: "master_premium_base" },
                  { field: "premium_unit", val: pricing?.premium_unit ?? product.premium_tier?.unit_price ?? 0, master: product.premium_tier?.unit_price ?? 0, snap: "master_premium_unit" },
                ];
                return (
                  <tr key={product.id} className={`border-b last:border-b-0 ${isNew ? "bg-orange-50/50" : isEnabled ? "bg-blue-50/30" : "hover:bg-muted/10"}`}>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{product.name}</span>
                        {isNew && <Badge className="text-xs h-4 bg-orange-100 text-orange-700 border-orange-200 px-1">New</Badge>}
                      </div>
                      {!isEnabled && (
                        <div className="text-xs text-muted-foreground">
                          ${product.standard_tier?.base_price ?? 0} base{product.standard_tier?.unit_price ? ` + $${product.standard_tier.unit_price}/unit` : ""}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Switch checked={isEnabled} onCheckedChange={() => toggleProductOverride(product.id)} disabled={!canEdit} className="scale-75" />
                    </td>
                    {fields.map(({ field, val, master, snap }) => {
                      const masterAtOverride = pricing?.[snap];
                      const drifted = masterAtOverride !== undefined && masterAtOverride !== master;
                      return (
                        <td key={field} className="px-3 py-2">
                          {isEnabled ? (
                            <div>
                              <PriceInput
                                value={val}
                                onChange={(e) => canEdit && setProductField(product.id, field, e.target.value)}
                                onBlur={(e) => canEdit && setProductField(product.id, field, clamp(e.target.value, 0, Infinity))}
                                readOnly={!canEdit}
                                masked={masked}
                              />
                              {drifted && (
                                <div className="text-xs text-amber-600 flex items-center gap-0.5 mt-0.5">
                                  <TrendingUp className="h-2.5 w-2.5" />was ${masterAtOverride}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground tabular-nums">${master}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Packages table */}
      {activePackages.length > 0 && (
        <div className="border-t">
          <div className="px-4 py-2 bg-muted/20 border-b">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Packages</span>
          </div>
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/10">
                <th className="text-left px-4 py-2 text-xs text-muted-foreground font-medium">Name</th>
                <th className="text-center px-3 py-2 text-xs text-muted-foreground font-medium w-20">Override</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Std Price</th>
                <th className="text-left px-3 py-2 text-xs text-muted-foreground font-medium">Pre Price</th>
              </tr>
            </thead>
            <tbody>
              {activePackages.map(pkg => {
                const pricing = getPackagePricing(pkg.id);
                const isEnabled = pricing?.override_enabled || false;
                const isNew = newPackages.some(p => p.id === pkg.id);
                const fields = [
                  { field: "standard_price", val: pricing?.standard_price ?? pkg.standard_tier?.package_price ?? 0, master: pkg.standard_tier?.package_price ?? 0, snap: "master_standard_price" },
                  { field: "premium_price", val: pricing?.premium_price ?? pkg.premium_tier?.package_price ?? 0, master: pkg.premium_tier?.package_price ?? 0, snap: "master_premium_price" },
                ];
                return (
                  <tr key={pkg.id} className={`border-b last:border-b-0 ${isNew ? "bg-orange-50/50" : isEnabled ? "bg-blue-50/30" : "hover:bg-muted/10"}`}>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">{pkg.name}</span>
                        {isNew && <Badge className="text-xs h-4 bg-orange-100 text-orange-700 border-orange-200 px-1">New</Badge>}
                      </div>
                      {!isEnabled && <div className="text-xs text-muted-foreground">${pkg.standard_tier?.package_price ?? 0} std</div>}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <Switch checked={isEnabled} onCheckedChange={() => togglePackageOverride(pkg.id)} disabled={!canEdit} className="scale-75" />
                    </td>
                    {fields.map(({ field, val, master, snap }) => {
                      const masterAtOverride = pricing?.[snap];
                      const drifted = masterAtOverride !== undefined && masterAtOverride !== master;
                      return (
                        <td key={field} className="px-3 py-2">
                          {isEnabled ? (
                            <div>
                              <PriceInput
                                value={val}
                                onChange={(e) => canEdit && setPackageField(pkg.id, field, e.target.value)}
                                onBlur={(e) => canEdit && setPackageField(pkg.id, field, clamp(e.target.value, 0, Infinity))}
                                readOnly={!canEdit}
                                masked={masked}
                              />
                              {drifted && (
                                <div className="text-xs text-amber-600 flex items-center gap-0.5 mt-0.5">
                                  <TrendingUp className="h-2.5 w-2.5" />was ${masterAtOverride}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-xs text-muted-foreground tabular-nums">${master}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
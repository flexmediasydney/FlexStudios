import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Plus, Trash2, DollarSign, TrendingUp, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A self-contained pricing impact editor used inside CreateRevisionDialog.
 * 
 * Props:
 *   pricingImpact: { has_impact, products_added, products_removed, quantity_changes }
 *   onChange: (updatedPricingImpact) => void
 *   project: the current project (for existing products/packages)
 *   allProducts: full product catalog
 */
export default function RevisionPricingImpact({ pricingImpact, onChange, project, allProducts = [] }) {
  const [expanded, setExpanded] = useState(false);

  const projectProducts = project?.products || [];

  const update = (patch) => onChange({ ...pricingImpact, ...patch });

  const toggleImpact = (val) => {
    update({
      has_impact: val,
      products_added: val ? (pricingImpact.products_added || []) : [],
      products_removed: val ? (pricingImpact.products_removed || []) : [],
      quantity_changes: val ? (pricingImpact.quantity_changes || []) : [],
    });
    if (val) setExpanded(true);
  };

  // ---- Products Added ----
  const addProduct = () => {
    update({ products_added: [...(pricingImpact.products_added || []), { product_id: "", product_name: "", quantity: 1 }] });
  };
  const removeAddedProduct = (i) => {
    update({ products_added: pricingImpact.products_added.filter((_, idx) => idx !== i) });
  };
  const updateAddedProduct = (i, field, val) => {
    const next = [...(pricingImpact.products_added || [])];
    if (field === "product_id" && val) {
      const p = (allProducts || []).find(x => x.id === val);
      next[i] = { product_id: val, product_name: p?.name || "", quantity: next[i].quantity || 1 };
    } else if (field && val !== undefined) {
      next[i] = { ...next[i], [field]: val };
    }
    update({ products_added: next });
  };

  // ---- Products Removed ----
  const addRemoval = () => {
    update({ products_removed: [...(pricingImpact.products_removed || []), { product_id: "", product_name: "" }] });
  };
  const removeRemoval = (i) => {
    update({ products_removed: pricingImpact.products_removed.filter((_, idx) => idx !== i) });
  };
  const updateRemoval = (i, productId) => {
    if (!productId) return;
    const prod = projectProducts.find(p => p.product_id === productId);
    const next = [...(pricingImpact.products_removed || [])];
    next[i] = { product_id: productId, product_name: prod?.product_name || "" };
    update({ products_removed: next });
  };

  // ---- Quantity Changes ----
  const addQtyChange = () => {
    update({ quantity_changes: [...(pricingImpact.quantity_changes || []), { product_id: "", product_name: "", old_quantity: 1, new_quantity: 1 }] });
  };
  const removeQtyChange = (i) => {
    update({ quantity_changes: pricingImpact.quantity_changes.filter((_, idx) => idx !== i) });
  };
  const updateQtyChange = (i, field, val) => {
    const next = [...(pricingImpact.quantity_changes || [])];
    if (field === "product_id" && val) {
      const prod = projectProducts.find(p => p.product_id === val);
      next[i] = { 
        product_id: val, 
        product_name: prod?.product_name || "", 
        old_quantity: prod?.quantity || next[i].old_quantity || 1, 
        new_quantity: next[i].new_quantity || 1 
      };
    } else if (field && val !== undefined) {
      next[i] = { ...next[i], [field]: val };
    }
    update({ quantity_changes: next });
  };

  // Count of active changes
  const changeCount = (pricingImpact.products_added?.filter(p => p.product_id)?.length || 0)
    + (pricingImpact.products_removed?.filter(p => p.product_id)?.length || 0)
    + (pricingImpact.quantity_changes?.filter(p => p.product_id)?.length || 0);

  // Available products not already in project (for "add")
   const projectProductIds = new Set(projectProducts.map(p => p.product_id).filter(Boolean));
   const alreadyAddedIds = new Set((pricingImpact.products_added || []).map(p => p.product_id).filter(Boolean));
   const catalogProductsForAdd = (allProducts || []).filter(p => 
     p.is_active !== false && 
     !projectProductIds.has(p.id) && 
     !alreadyAddedIds.has(p.id)
   );

  // Products that exist in the project (for remove / qty change)
  const existingProductOptions = projectProducts;

  return (
    <div className="border rounded-xl overflow-hidden">
      {/* Toggle header */}
      <div
        className={cn(
          "flex items-center justify-between px-4 py-3 cursor-pointer transition-colors",
          pricingImpact.has_impact ? "bg-orange-50 border-b border-orange-100" : "bg-muted/20 hover:bg-muted/30"
        )}
        onClick={() => pricingImpact.has_impact && setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <DollarSign className={cn("h-4 w-4", pricingImpact.has_impact ? "text-orange-600" : "text-muted-foreground")} />
          <span className={cn("text-sm font-medium", pricingImpact.has_impact ? "text-orange-700" : "text-muted-foreground")}>
            Pricing Impact
          </span>
          {pricingImpact.has_impact && changeCount > 0 && (
            <Badge className="bg-orange-100 text-orange-700 border-orange-200 text-xs">
              {changeCount} change{changeCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-3" onClick={e => e.stopPropagation()}>
          <Switch
            checked={!!pricingImpact.has_impact}
            onCheckedChange={toggleImpact}
          />
          {pricingImpact.has_impact && (
            <button onClick={() => setExpanded(e => !e)} className="text-muted-foreground">
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {pricingImpact.has_impact && expanded && (
        <div className="p-4 space-y-5 bg-orange-50/30">

          {/* Add Products */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-green-700 flex items-center gap-1">
                <TrendingUp className="h-3.5 w-3.5" /> Add Products
              </p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addProduct}>
                <Plus className="h-3 w-3 mr-1" /> Add
              </Button>
            </div>
            {(pricingImpact.products_added || []).length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No products being added. Click "Add" to include new products.</p>
            ) : (
              <div className="space-y-2">
                {(pricingImpact.products_added || []).map((item, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                       value={item.product_id || ""}
                       onValueChange={v => updateAddedProduct(i, "product_id", v)}
                     >
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue placeholder="Select product..." />
                      </SelectTrigger>
                      <SelectContent className="z-50">
                        {catalogProductsForAdd.length === 0 ? (
                          <div className="px-2 py-1 text-xs text-muted-foreground">No products available</div>
                        ) : (
                          catalogProductsForAdd.map(p => (
                            <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min="1"
                      max="999"
                      step="1"
                      value={item.quantity || 1}
                      onChange={e => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) {
                          updateAddedProduct(i, "quantity", Math.max(1, Math.min(999, val)));
                        }
                      }}
                      onBlur={e => {
                        const val = parseInt(e.target.value, 10);
                        if (isNaN(val) || val < 1) {
                          updateAddedProduct(i, "quantity", 1);
                        }
                      }}
                      className="h-8 w-20 text-xs text-center"
                      placeholder="Qty"
                    />
                    <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeAddedProduct(i)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Quantity Changes */}
          {existingProductOptions.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-blue-700">Change Quantities</p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addQtyChange}>
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
              {(pricingImpact.quantity_changes || []).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No quantity changes.</p>
              ) : (
                <div className="space-y-2">
                  {(pricingImpact.quantity_changes || []).map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select
                        value={item.product_id || ""}
                        onValueChange={v => updateQtyChange(i, "product_id", v)}
                      >
                        <SelectTrigger className="h-8 text-xs flex-1">
                            <SelectValue placeholder="Select product..." />
                          </SelectTrigger>
                          <SelectContent className="z-50">
                            {existingProductOptions.map(p => (
                              <SelectItem key={p.product_id} value={p.product_id}>{p.product_name}</SelectItem>
                            ))}
                          </SelectContent>
                      </Select>
                      <span className="text-xs text-muted-foreground">{item.old_quantity || 1} →</span>
                      <Input
                        type="number"
                        min="1"
                        max="999"
                        step="1"
                        value={item.new_quantity || 1}
                        onChange={e => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val)) {
                            updateQtyChange(i, "new_quantity", Math.max(1, Math.min(999, val)));
                          }
                        }}
                        onBlur={e => {
                          const val = parseInt(e.target.value, 10);
                          if (isNaN(val) || val < 1) {
                            updateQtyChange(i, "new_quantity", 1);
                          }
                        }}
                        className="h-8 w-20 text-xs text-center"
                        placeholder="New qty"
                      />
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeQtyChange(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Remove Products */}
          {existingProductOptions.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs font-semibold text-red-700">Remove Products</p>
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={addRemoval}>
                  <Plus className="h-3 w-3 mr-1" /> Add
                </Button>
              </div>
              {(pricingImpact.products_removed || []).length === 0 ? (
                <p className="text-xs text-muted-foreground italic">No products being removed.</p>
              ) : (
                <div className="space-y-2">
                  {(pricingImpact.products_removed || []).map((item, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Select
                        value={item.product_id || ""}
                        onValueChange={v => updateRemoval(i, v)}
                      >
                        <SelectTrigger className="h-8 text-xs flex-1">
                          <SelectValue placeholder="Select product to remove..." />
                        </SelectTrigger>
                        <SelectContent className="z-50">
                          {existingProductOptions.map(p => (
                            <SelectItem key={p.product_id} value={p.product_id}>{p.product_name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-destructive" onClick={() => removeRemoval(i)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <p className="text-xs text-muted-foreground italic border-t pt-3">
            Define the pricing impact here. You can apply these changes to the project later.
          </p>
        </div>
      )}
    </div>
  );
}
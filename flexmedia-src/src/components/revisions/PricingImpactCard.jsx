import React, { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { calculatePricingDelta } from "@/components/utils/pricingImpactCalculator";

/**
 * Editable pricing impact card for RevisionCard.
 * Shows pricing changes and allows editing when not applied.
 */
export default function PricingImpactCard({ 
  pricingImpact, 
  onUpdate, 
  onMarkApplied, 
  onRevert, 
  applied, 
  canEdit,
  allProducts = [],
  pricingTier = 'standard'
}) {
  const [expanded, setExpanded] = useState(false);
  
  // Calculate delta on-the-fly from current pricing impact
  const estimatedDelta = useMemo(() => {
    return calculatePricingDelta(pricingImpact, allProducts, pricingTier);
  }, [pricingImpact, allProducts, pricingTier]);

  const update = (patch) => onUpdate({ ...pricingImpact, ...patch });

  // Add product
  const addProduct = () => {
    update({
      products_added: [...(pricingImpact.products_added || []), { product_id: "", product_name: "", quantity: 1 }]
    });
  };

  // Remove product
  const removeProduct = (i) => {
    update({
      products_added: pricingImpact.products_added.filter((_, idx) => idx !== i)
    });
  };

  // Update product
   const updateProduct = (i, field, val) => {
     const next = [...(pricingImpact.products_added || [])];
     if (field === "product_id") {
       const p = allProducts.find(x => x.id === val);
       next[i] = { product_id: val, product_name: p?.name || "", quantity: next[i].quantity || 1 };
     } else if (field === "quantity") {
       const q = Math.max(1, parseInt(val) || 1);
       next[i] = { ...next[i], [field]: q };
     } else {
       next[i] = { ...next[i], [field]: val };
     }
     update({ products_added: next });
   };

  const activeCount = (pricingImpact.products_added || []).filter(p => p.product_id).length;

  return (
    <div className={`rounded-lg p-3 text-xs space-y-2 border ${applied ? "bg-green-50 border-green-200" : "bg-orange-50 border-orange-200"}`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex-1">
          <p className={`font-semibold flex items-center gap-1 ${applied ? "text-green-700" : "text-orange-700"}`}>
            <DollarSign className="h-3.5 w-3.5" />
            {applied ? "✓ Pricing Updated" : "⚠ Pricing Pending"}
            {estimatedDelta !== 0 && (
              <span className={`font-semibold ${estimatedDelta > 0 ? "text-green-600" : "text-red-600"}`}>
                {estimatedDelta > 0 ? "+" : ""} ${estimatedDelta.toFixed(2)}
              </span>
            )}
          </p>
        </div>
        {canEdit && !applied && (
          <button 
            onClick={() => setExpanded(e => !e)}
            className="text-muted-foreground hover:text-foreground"
            title={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>

      {/* View mode (collapsed) */}
      {!expanded && (
        <div className="space-y-1 max-h-32 overflow-y-auto">
          {(pricingImpact.products_added || []).filter(p => p.product_id).map((p, i) => (
            <p key={i} className={applied ? "text-green-700" : "text-orange-700"}>
              <span className="font-medium">+ {p.product_name}</span> × {p.quantity}
            </p>
          ))}
          {(pricingImpact.products_removed || []).filter(p => p.product_id).map((p, i) => (
            <p key={`remove-${i}`} className={applied ? "text-green-700" : "text-orange-700"}>
              <span className="font-medium">− {p.product_name}</span>
            </p>
          ))}
          {(pricingImpact.quantity_changes || []).filter(p => p.product_id).map((p, i) => (
            <p key={`qty-${i}`} className={applied ? "text-green-700" : "text-orange-700"}>
              <span className="font-medium">~ {p.product_name}</span> {p.old_quantity}→{p.new_quantity}
            </p>
          ))}
          {activeCount === 0 && (pricingImpact.products_removed || []).length === 0 && (pricingImpact.quantity_changes || []).length === 0 && !applied && (
            <p className="text-muted-foreground italic text-xs">No changes defined.</p>
          )}
        </div>
      )}

      {/* Edit mode (expanded) */}
      {expanded && canEdit && !applied && (
        <div className="space-y-2 border-t pt-2 mt-2">
          {(pricingImpact.products_added || []).map((item, i) => (
            <div key={i} className="flex items-center gap-2">
              <Select
                value={item.product_id || ""}
                onValueChange={(v) => {
                  updateProduct(i, "product_id", v);
                }}
              >
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue placeholder="Select product..." />
                </SelectTrigger>
                <SelectContent side="bottom" align="start" className="z-50">
                  {(allProducts || []).filter(p => p.is_active !== false).length === 0 ? (
                    <div className="px-2 py-1 text-xs text-muted-foreground">No products available</div>
                  ) : (
                    (allProducts || []).filter(p => p.is_active !== false).map(p => (
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
                  const val = parseInt(e.target.value);
                  if (!isNaN(val)) {
                    updateProduct(i, "quantity", Math.max(1, Math.min(999, val)));
                  }
                }}
                onBlur={e => {
                  const val = parseInt(e.target.value);
                  if (isNaN(val) || val < 1) {
                    updateProduct(i, "quantity", 1);
                  }
                }}
                className="h-7 w-16 text-xs text-center"
                placeholder="Qty"
              />
              <Button 
                variant="ghost" 
                size="sm" 
                className="h-7 w-7 p-0 text-destructive"
                onClick={() => removeProduct(i)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <Button 
            size="sm" 
            variant="outline" 
            className="h-7 text-xs w-full"
            onClick={addProduct}
          >
            <Plus className="h-3 w-3 mr-1" /> Add Product
          </Button>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2 pt-1 border-t">
        {!applied && canEdit && (
          <Button 
            size="sm" 
            variant="outline" 
            className="h-7 text-xs flex-1 border-orange-300 text-orange-700 hover:bg-orange-100"
            onClick={onMarkApplied}
          >
            Mark as Updated
          </Button>
        )}
        {applied && canEdit && (
          <Button 
            size="sm" 
            variant="outline" 
            className="h-7 text-xs flex-1 border-red-300 text-red-600 hover:bg-red-50"
            onClick={onRevert}
          >
            Revert
          </Button>
        )}
      </div>
    </div>
  );
}
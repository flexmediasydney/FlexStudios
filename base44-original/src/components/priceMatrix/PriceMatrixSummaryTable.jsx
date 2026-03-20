import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";

const roundToNearestFive = (value) => Math.ceil(value / 5) * 5;
const applyDiscount = (price, pct) => roundToNearestFive(price * (1 - pct / 100));

function fmt(val) {
  return `$${(Number(val) || 0).toFixed(2)}`;
}

function PricingModeBadge({ mode }) {
  if (mode === "club_flex") return <Badge className="text-xs bg-purple-100 text-purple-700 border-purple-200">Club Flex</Badge>;
  if (mode === "override") return <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-200">Override</Badge>;
  if (mode === "blanket") return <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">Blanket</Badge>;
  return <Badge variant="outline" className="text-xs">Master</Badge>;
}

export default function PriceMatrixSummaryTable({ priceMatrix, products, packages, isClubFlex = false, agencyPriceMatrix = null }) {
  const useDefault = priceMatrix?.use_default_pricing ?? true;
  const blanketEnabled = !useDefault && priceMatrix?.blanket_discount?.enabled;
  const productDiscountPct = Math.min(100, Math.max(0, parseFloat(priceMatrix?.blanket_discount?.product_percent) || 0));
  const packageDiscountPct = Math.min(100, Math.max(0, parseFloat(priceMatrix?.blanket_discount?.package_percent) || 0));

  const activeProducts = useMemo(() => products.filter(p => p.is_active !== false), [products]);
  const activePackages = useMemo(() => packages.filter(p => p.is_active !== false), [packages]);

  const resolvedProducts = useMemo(() => activeProducts.map(product => {
    let stdBase = product.standard_tier?.base_price ?? 0;
    let stdUnit = product.standard_tier?.unit_price ?? 0;
    let preBase = product.premium_tier?.base_price ?? 0;
    let preUnit = product.premium_tier?.unit_price ?? 0;
    let mode = "master";

    // For agents: check club flex first, then agent overrides, then inherit from agency
    if (isClubFlex && agencyPriceMatrix) {
      // Agent is club flex - use agency pricing
      const agencyMatrixPricing = (agencyPriceMatrix?.product_pricing || []).find(p => p.product_id === product.id);
      const agencyUseDefault = agencyPriceMatrix?.use_default_pricing ?? true;
      const agencyBlanketEnabled = !agencyUseDefault && agencyPriceMatrix?.blanket_discount?.enabled;
      
      if (!agencyUseDefault) {
        if (agencyBlanketEnabled) {
          const agencyProductDiscountPct = Math.min(100, Math.max(0, parseFloat(agencyPriceMatrix?.blanket_discount?.product_percent) || 0));
          stdBase = applyDiscount(stdBase, agencyProductDiscountPct);
          stdUnit = applyDiscount(stdUnit, agencyProductDiscountPct);
          preBase = applyDiscount(preBase, agencyProductDiscountPct);
          preUnit = applyDiscount(preUnit, agencyProductDiscountPct);
          mode = "club_flex";
        } else if (agencyMatrixPricing?.override_enabled) {
          stdBase = agencyMatrixPricing.standard_base ?? stdBase;
          stdUnit = agencyMatrixPricing.standard_unit ?? stdUnit;
          preBase = agencyMatrixPricing.premium_base ?? preBase;
          preUnit = agencyMatrixPricing.premium_unit ?? preUnit;
          mode = "club_flex";
        }
      }
    } else if (!useDefault) {
      // Agent has custom pricing
      const matrixPricing = (priceMatrix?.product_pricing || []).find(p => p.product_id === product.id);
      if (blanketEnabled) {
        stdBase = applyDiscount(stdBase, productDiscountPct);
        stdUnit = applyDiscount(stdUnit, productDiscountPct);
        preBase = applyDiscount(preBase, productDiscountPct);
        preUnit = applyDiscount(preUnit, productDiscountPct);
        mode = "blanket";
      } else if (matrixPricing?.override_enabled) {
        stdBase = matrixPricing.standard_base ?? stdBase;
        stdUnit = matrixPricing.standard_unit ?? stdUnit;
        preBase = matrixPricing.premium_base ?? preBase;
        preUnit = matrixPricing.premium_unit ?? preUnit;
        mode = "override";
      } else if (agencyPriceMatrix) {
        // No agent overrides, inherit from agency
        const agencyMatrixPricing = (agencyPriceMatrix?.product_pricing || []).find(p => p.product_id === product.id);
        const agencyUseDefault = agencyPriceMatrix?.use_default_pricing ?? true;
        const agencyBlanketEnabled = !agencyUseDefault && agencyPriceMatrix?.blanket_discount?.enabled;
        
        if (!agencyUseDefault) {
          if (agencyBlanketEnabled) {
            const agencyProductDiscountPct = Math.min(100, Math.max(0, parseFloat(agencyPriceMatrix?.blanket_discount?.product_percent) || 0));
            stdBase = applyDiscount(stdBase, agencyProductDiscountPct);
            stdUnit = applyDiscount(stdUnit, agencyProductDiscountPct);
            preBase = applyDiscount(preBase, agencyProductDiscountPct);
            preUnit = applyDiscount(preUnit, agencyProductDiscountPct);
            mode = "master";
          } else if (agencyMatrixPricing?.override_enabled) {
            stdBase = agencyMatrixPricing.standard_base ?? stdBase;
            stdUnit = agencyMatrixPricing.standard_unit ?? stdUnit;
            preBase = agencyMatrixPricing.premium_base ?? preBase;
            preUnit = agencyMatrixPricing.premium_unit ?? preUnit;
            mode = "master";
          }
        }
      }
    }

    return { id: product.id, name: product.name, pricing_type: product.pricing_type, stdBase, stdUnit, preBase, preUnit, mode };
  }), [activeProducts, priceMatrix, useDefault, blanketEnabled, productDiscountPct, isClubFlex, agencyPriceMatrix]);

  const resolvedPackages = useMemo(() => activePackages.map(pkg => {
    let stdPrice = pkg.standard_tier?.package_price ?? 0;
    let prePrice = pkg.premium_tier?.package_price ?? 0;
    let mode = "master";

    // For agents: check club flex first, then agent overrides, then inherit from agency
    if (isClubFlex && agencyPriceMatrix) {
      // Agent is club flex - use agency pricing
      const agencyMatrixPricing = (agencyPriceMatrix?.package_pricing || []).find(p => p.package_id === pkg.id);
      const agencyUseDefault = agencyPriceMatrix?.use_default_pricing ?? true;
      const agencyBlanketEnabled = !agencyUseDefault && agencyPriceMatrix?.blanket_discount?.enabled;
      
      if (!agencyUseDefault) {
        if (agencyBlanketEnabled) {
          const agencyPackageDiscountPct = Math.min(100, Math.max(0, parseFloat(agencyPriceMatrix?.blanket_discount?.package_percent) || 0));
          stdPrice = applyDiscount(stdPrice, agencyPackageDiscountPct);
          prePrice = applyDiscount(prePrice, agencyPackageDiscountPct);
          mode = "club_flex";
        } else if (agencyMatrixPricing?.override_enabled) {
          stdPrice = agencyMatrixPricing.standard_price ?? stdPrice;
          prePrice = agencyMatrixPricing.premium_price ?? prePrice;
          mode = "club_flex";
        }
      }
    } else if (!useDefault) {
      // Agent has custom pricing
      const matrixPricing = (priceMatrix?.package_pricing || []).find(p => p.package_id === pkg.id);
      if (blanketEnabled) {
        stdPrice = applyDiscount(stdPrice, packageDiscountPct);
        prePrice = applyDiscount(prePrice, packageDiscountPct);
        mode = "blanket";
      } else if (matrixPricing?.override_enabled) {
        stdPrice = matrixPricing.standard_price ?? stdPrice;
        prePrice = matrixPricing.premium_price ?? prePrice;
        mode = "override";
      } else if (agencyPriceMatrix) {
        // No agent overrides, inherit from agency
        const agencyMatrixPricing = (agencyPriceMatrix?.package_pricing || []).find(p => p.package_id === pkg.id);
        const agencyUseDefault = agencyPriceMatrix?.use_default_pricing ?? true;
        const agencyBlanketEnabled = !agencyUseDefault && agencyPriceMatrix?.blanket_discount?.enabled;
        
        if (!agencyUseDefault) {
          if (agencyBlanketEnabled) {
            const agencyPackageDiscountPct = Math.min(100, Math.max(0, parseFloat(agencyPriceMatrix?.blanket_discount?.package_percent) || 0));
            stdPrice = applyDiscount(stdPrice, agencyPackageDiscountPct);
            prePrice = applyDiscount(prePrice, agencyPackageDiscountPct);
            mode = "master";
          } else if (agencyMatrixPricing?.override_enabled) {
            stdPrice = agencyMatrixPricing.standard_price ?? stdPrice;
            prePrice = agencyMatrixPricing.premium_price ?? prePrice;
            mode = "master";
          }
        }
      }
    }

    return { id: pkg.id, name: pkg.name, stdPrice, prePrice, mode };
  }), [activePackages, priceMatrix, useDefault, blanketEnabled, packageDiscountPct, isClubFlex, agencyPriceMatrix]);

  return (
    <div className="space-y-4 mt-3 pt-3 border-t">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Effective Pricing Summary</span>
        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          <PricingModeBadge mode="master" /><span>Master</span>
          {isClubFlex && (<><PricingModeBadge mode="club_flex" /><span>Club Flex</span></>)}
          <PricingModeBadge mode="blanket" /><span>Blanket</span>
          <PricingModeBadge mode="override" /><span>Override</span>
        </div>
      </div>

      {activeProducts.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/30 border-b">
                <th className="text-left px-3 py-1.5 text-xs text-muted-foreground font-medium">Product</th>
                <th className="text-center px-2 py-1.5 text-xs text-muted-foreground font-medium w-16">Source</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Std Base</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Std Unit</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Pre Base</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Pre Unit</th>
              </tr>
            </thead>
            <tbody>
              {resolvedProducts.map((row, i) => (
                <tr key={row.id} className={`${i < resolvedProducts.length - 1 ? "border-b" : ""} ${row.mode === "club_flex" ? "bg-purple-50/40" : row.mode === "override" ? "bg-blue-50/40" : row.mode === "blanket" ? "bg-amber-50/40" : ""}`}>
                  <td className="px-3 py-1.5 text-xs font-medium">{row.name}</td>
                  <td className="px-2 py-1.5 text-center"><PricingModeBadge mode={row.mode} /></td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">{fmt(row.stdBase)}</td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums text-muted-foreground">{row.pricing_type === "per_unit" ? fmt(row.stdUnit) : "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">{fmt(row.preBase)}</td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums text-muted-foreground">{row.pricing_type === "per_unit" ? fmt(row.preUnit) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activePackages.length > 0 && (
        <div className="rounded-md border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="bg-muted/30 border-b">
                <th className="text-left px-3 py-1.5 text-xs text-muted-foreground font-medium">Package</th>
                <th className="text-center px-2 py-1.5 text-xs text-muted-foreground font-medium w-16">Source</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Std Price</th>
                <th className="text-right px-3 py-1.5 text-xs text-muted-foreground font-medium">Pre Price</th>
              </tr>
            </thead>
            <tbody>
              {resolvedPackages.map((row, i) => (
                <tr key={row.id} className={`${i < resolvedPackages.length - 1 ? "border-b" : ""} ${row.mode === "club_flex" ? "bg-purple-50/40" : row.mode === "override" ? "bg-blue-50/40" : row.mode === "blanket" ? "bg-amber-50/40" : ""}`}>
                  <td className="px-3 py-1.5 text-xs font-medium">{row.name}</td>
                  <td className="px-2 py-1.5 text-center"><PricingModeBadge mode={row.mode} /></td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">{fmt(row.stdPrice)}</td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums">{fmt(row.prePrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
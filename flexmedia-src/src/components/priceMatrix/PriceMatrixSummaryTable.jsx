import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import Price from '@/components/common/Price';
import {
  resolveActiveMatrix,
  resolveProductOverride,
  resolvePackageOverride,
  resolveBlanketDiscount,
} from "@pricing/matrix";
import { roundToNearestFive } from "@pricing/round";

// Canonical per-component blanket application: round the DISCOUNT amount (not
// the post-discount price), matching the shared engine's rule in discount.ts.
// The table intentionally shows per-component values (base, unit) so the
// discount is mirrored onto each component — but rounding is done on the
// discount amount, not the final value, to match the engine.
const applyBlanketToComponent = (value, pct) => {
  if (!pct || pct <= 0) return value;
  return Math.max(0, value - roundToNearestFive((value * pct) / 100));
};

function PricingModeBadge({ mode }) {
  if (mode === "club_flex") return <Badge className="text-xs bg-purple-100 text-purple-700 border-purple-200">Club Flex</Badge>;
  if (mode === "override") return <Badge className="text-xs bg-blue-100 text-blue-700 border-blue-200">Override</Badge>;
  if (mode === "blanket") return <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">Blanket</Badge>;
  return <Badge variant="outline" className="text-xs">Master</Badge>;
}

export default function PriceMatrixSummaryTable({ priceMatrix, products, packages, isClubFlex = false, agencyPriceMatrix = null }) {
  const activeProducts = useMemo(() => products.filter(p => p.is_active !== false), [products]);
  const activePackages = useMemo(() => packages.filter(p => p.is_active !== false), [packages]);

  // Resolve the two matrices through the shared use_default_pricing gate.
  // Club flex agents inherit from the agency — we model that as "no agent
  // matrix, agency matrix applies" so the shared resolver does the right thing.
  const agentMatrix = useMemo(
    () => (isClubFlex ? null : resolveActiveMatrix(priceMatrix || null)),
    [priceMatrix, isClubFlex],
  );
  const agencyMatrix = useMemo(
    () => resolveActiveMatrix(agencyPriceMatrix || null),
    [agencyPriceMatrix],
  );

  const blanket = useMemo(
    () => resolveBlanketDiscount(agentMatrix, agencyMatrix),
    [agentMatrix, agencyMatrix],
  );

  // Derive the mode badge tag for a row, preserving the prior UX exactly:
  //   - Agent matrix fired            → "blanket" or "override"
  //   - Agency fired & isClubFlex     → "club_flex"
  //   - Agency fired & !isClubFlex    → "master" (non-club-flex agent
  //     inheriting from agency is treated as if using master pricing)
  //   - Nothing fired                 → "master"
  const modeFor = (sourceEntityType, kind) => {
    if (sourceEntityType === "agent") return kind === "blanket" ? "blanket" : "override";
    if (sourceEntityType === "agency") return isClubFlex ? "club_flex" : "master";
    return "master";
  };

  const resolvedProducts = useMemo(() => activeProducts.map(product => {
    const stdTier = product.standard_tier || {};
    const preTier = product.premium_tier || {};
    let stdBase = Math.max(0, parseFloat(stdTier.base_price) || 0);
    let stdUnit = Math.max(0, parseFloat(stdTier.unit_price) || 0);
    let preBase = Math.max(0, parseFloat(preTier.base_price) || 0);
    let preUnit = Math.max(0, parseFloat(preTier.unit_price) || 0);
    let mode = "master";

    // Per-item override wins over blanket (matches engine precedence).
    const stdOverride = resolveProductOverride(product.id, "standard", agentMatrix, agencyMatrix);
    const preOverride = resolveProductOverride(product.id, "premium", agentMatrix, agencyMatrix);
    if (stdOverride) {
      if (stdOverride.base != null) stdBase = Math.max(0, stdOverride.base);
      if (stdOverride.unit != null) stdUnit = Math.max(0, stdOverride.unit);
      mode = modeFor(stdOverride.entity_type, "override");
    } else if (preOverride) {
      mode = modeFor(preOverride.entity_type, "override");
    }
    if (preOverride) {
      if (preOverride.base != null) preBase = Math.max(0, preOverride.base);
      if (preOverride.unit != null) preUnit = Math.max(0, preOverride.unit);
    }

    // Blanket only applies when there's no per-item override (engine semantics
    // are "blanket on subtotal of non-overridden lines"; for this preview table
    // the closest per-component analogue is "skip blanket if override fired").
    if (!stdOverride && !preOverride && blanket && blanket.product_percent > 0) {
      const pct = blanket.product_percent;
      stdBase = applyBlanketToComponent(stdBase, pct);
      stdUnit = applyBlanketToComponent(stdUnit, pct);
      preBase = applyBlanketToComponent(preBase, pct);
      preUnit = applyBlanketToComponent(preUnit, pct);
      mode = modeFor(blanket.entity_type, "blanket");
    }

    return { id: product.id, name: product.name, pricing_type: product.pricing_type, stdBase, stdUnit, preBase, preUnit, mode };
  }), [activeProducts, agentMatrix, agencyMatrix, blanket, isClubFlex]);

  const resolvedPackages = useMemo(() => activePackages.map(pkg => {
    const stdTier = pkg.standard_tier || {};
    const preTier = pkg.premium_tier || {};
    let stdPrice = Math.max(0, parseFloat(stdTier.package_price) || 0);
    let prePrice = Math.max(0, parseFloat(preTier.package_price) || 0);
    let mode = "master";

    const stdOverride = resolvePackageOverride(pkg.id, "standard", agentMatrix, agencyMatrix);
    const preOverride = resolvePackageOverride(pkg.id, "premium", agentMatrix, agencyMatrix);
    if (stdOverride) {
      stdPrice = stdOverride.price;
      mode = modeFor(stdOverride.entity_type, "override");
    }
    if (preOverride) {
      prePrice = preOverride.price;
      if (!stdOverride) mode = modeFor(preOverride.entity_type, "override");
    }

    if (!stdOverride && !preOverride && blanket && blanket.package_percent > 0) {
      const pct = blanket.package_percent;
      stdPrice = applyBlanketToComponent(stdPrice, pct);
      prePrice = applyBlanketToComponent(prePrice, pct);
      mode = modeFor(blanket.entity_type, "blanket");
    }

    return { id: pkg.id, name: pkg.name, stdPrice, prePrice, mode };
  }), [activePackages, agentMatrix, agencyMatrix, blanket, isClubFlex]);

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
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums"><Price value={row.stdBase} /></td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums text-muted-foreground">{row.pricing_type === "per_unit" ? <Price value={row.stdUnit} /> : "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums"><Price value={row.preBase} /></td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums text-muted-foreground">{row.pricing_type === "per_unit" ? <Price value={row.preUnit} /> : "—"}</td>
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
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums"><Price value={row.stdPrice} /></td>
                  <td className="px-3 py-1.5 text-xs text-right tabular-nums"><Price value={row.prePrice} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

  // Engine v3.1: blanket resolves per-tier. The summary table renders both
  // tiers in adjacent columns, so we resolve once per tier and use the
  // appropriate one when applying the blanket onto each component.
  const stdBlanket = useMemo(
    () => resolveBlanketDiscount(agentMatrix, agencyMatrix, "standard"),
    [agentMatrix, agencyMatrix],
  );
  const prmBlanket = useMemo(
    () => resolveBlanketDiscount(agentMatrix, agencyMatrix, "premium"),
    [agentMatrix, agencyMatrix],
  );
  // Used by mode-badge display when at least one tier has a blanket — the
  // table's existing badge UI assumes a single blanket. We treat any tier's
  // blanket as "blanket fired" for badge purposes; the per-tier values still
  // drive the actual numeric column.
  const blanket = stdBlanket || prmBlanket;

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
    // Pass master tier values so engine v3 percent_* modes resolve correctly.
    const stdMasterBase = Math.max(0, parseFloat(stdTier.base_price) || 0);
    const stdMasterUnit = Math.max(0, parseFloat(stdTier.unit_price) || 0);
    const preMasterBase = Math.max(0, parseFloat(preTier.base_price) || 0);
    const preMasterUnit = Math.max(0, parseFloat(preTier.unit_price) || 0);
    const stdOverride = resolveProductOverride(product.id, "standard", agentMatrix, agencyMatrix, stdMasterBase, stdMasterUnit);
    const preOverride = resolveProductOverride(product.id, "premium", agentMatrix, agencyMatrix, preMasterBase, preMasterUnit);
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

    // Blanket only applies when there's no per-item override. Engine v3.1:
    // each tier resolves its own blanket. The preview applies std blanket to
    // std components, premium blanket to premium components.
    if (!stdOverride && stdBlanket && stdBlanket.product_percent > 0) {
      stdBase = applyBlanketToComponent(stdBase, stdBlanket.product_percent);
      stdUnit = applyBlanketToComponent(stdUnit, stdBlanket.product_percent);
      mode = modeFor(stdBlanket.entity_type, "blanket");
    }
    if (!preOverride && prmBlanket && prmBlanket.product_percent > 0) {
      preBase = applyBlanketToComponent(preBase, prmBlanket.product_percent);
      preUnit = applyBlanketToComponent(preUnit, prmBlanket.product_percent);
      if (mode === "master") mode = modeFor(prmBlanket.entity_type, "blanket");
    }

    return { id: product.id, name: product.name, pricing_type: product.pricing_type, stdBase, stdUnit, preBase, preUnit, mode };
  }), [activeProducts, agentMatrix, agencyMatrix, stdBlanket, prmBlanket, isClubFlex]);

  const resolvedPackages = useMemo(() => activePackages.map(pkg => {
    const stdTier = pkg.standard_tier || {};
    const preTier = pkg.premium_tier || {};
    let stdPrice = Math.max(0, parseFloat(stdTier.package_price) || 0);
    let prePrice = Math.max(0, parseFloat(preTier.package_price) || 0);
    let mode = "master";

    const stdOverride = resolvePackageOverride(pkg.id, "standard", agentMatrix, agencyMatrix, stdPrice);
    const preOverride = resolvePackageOverride(pkg.id, "premium", agentMatrix, agencyMatrix, prePrice);
    if (stdOverride) {
      stdPrice = stdOverride.price;
      mode = modeFor(stdOverride.entity_type, "override");
    }
    if (preOverride) {
      prePrice = preOverride.price;
      if (!stdOverride) mode = modeFor(preOverride.entity_type, "override");
    }

    if (!stdOverride && stdBlanket && stdBlanket.package_percent > 0) {
      stdPrice = applyBlanketToComponent(stdPrice, stdBlanket.package_percent);
      mode = modeFor(stdBlanket.entity_type, "blanket");
    }
    if (!preOverride && prmBlanket && prmBlanket.package_percent > 0) {
      prePrice = applyBlanketToComponent(prePrice, prmBlanket.package_percent);
      if (mode === "master") mode = modeFor(prmBlanket.entity_type, "blanket");
    }

    return { id: pkg.id, name: pkg.name, stdPrice, prePrice, mode };
  }), [activePackages, agentMatrix, agencyMatrix, stdBlanket, prmBlanket, isClubFlex]);

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

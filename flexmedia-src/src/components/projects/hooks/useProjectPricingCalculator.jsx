import { useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";
import { computePrice } from "@pricing/engine";

/**
 * Project pricing calculator — live preview that ALWAYS matches the backend.
 *
 * 2026-04-20 rewrite: the hook now delegates all math to the shared
 * @pricing/engine module (see supabase/functions/_shared/pricing/). Same
 * function the backend calculateProjectPricing edge fn calls. Identical
 * output for identical inputs — proven by pricingParityCheck across every
 * active project in prod.
 *
 * This replaces a previous hand-rolled implementation that silently skipped
 * the matrix blanket discount. 7e/164 Burwood Rd was the canonical example:
 * DB had $2,550 (post 20% discount), hook returned $3,100 (pre-discount).
 * No more.
 *
 * Usage — pass `context` with agent_id / agency_id / project_type_id so the
 * hook can fetch the matching matrices and apply overrides + blanket discount.
 * Without context, engine still runs but falls back to master-tier prices with
 * no matrix adjustments (legacy behaviour for pure catalog previews).
 *
 * Returns a `breakdown` with UI-friendly packages[] and products[] arrays
 * enriched with master-catalog metadata (category, pricingType, min/max qty)
 * plus the canonical total/subtotal/discount fields from the engine.
 */
export function useProjectPricingCalculator(
  formState,
  allProducts,
  allPackages,
  tierKey,
  /** Optional: { agent_id, agency_id, project_type_id } — when provided,
      matrix fetching + blanket discount applies. */
  context = null,
) {
  const tier = tierKey === "premium_tier" ? "premium" : "standard";

  // Fetch matrices for the project's agent + agency. useEntityList returns
  // an empty array when filter is null (no over-fetching if context missing).
  const { data: agentMatrices = [] } = useEntityList(
    context?.agent_id ? "PriceMatrix" : null,
    null,
    100,
    context?.agent_id ? { entity_type: "agent", entity_id: context.agent_id } : null,
  );
  const { data: agencyMatrices = [] } = useEntityList(
    context?.agency_id ? "PriceMatrix" : null,
    null,
    100,
    context?.agency_id ? { entity_type: "agency", entity_id: context.agency_id } : null,
  );

  const productMap = useMemo(
    () => new Map(allProducts.map((p) => [p.id, p])),
    [allProducts],
  );
  const packageMap = useMemo(
    () => new Map(allPackages.map((p) => [p.id, p])),
    [allPackages],
  );

  const breakdown = useMemo(() => {
    const inputProducts = formState.products || [];
    const inputPackages = formState.packages || [];

    // Drop formState nested package.products[] qty overrides into the shape
    // the engine expects, preserving user-edited quantities.
    const normalizedPackages = inputPackages.map((pkg) => ({
      package_id: pkg.package_id,
      quantity: pkg.quantity || 1,
      products: (pkg.products || []).map((p) => ({
        product_id: p.product_id,
        quantity: p.quantity,
      })),
    }));
    const normalizedProducts = inputProducts.map((p) => ({
      product_id: p.product_id,
      quantity: p.quantity,
    }));

    // Call the shared engine — same math as the backend.
    const engine = computePrice({
      products: normalizedProducts,
      packages: normalizedPackages,
      pricing_tier: tier,
      project_type_id: context?.project_type_id || null,
      agent_matrices: agentMatrices,
      agency_matrices: agencyMatrices,
      catalog_products: allProducts,
      catalog_packages: allPackages,
      discount_type: formState.discount_type || "fixed",
      discount_value: formState.discount_value || 0,
      discount_mode: formState.discount_mode || "discount",
    });

    // ─── Adapt engine line_items to the UI-friendly breakdown shape ──────
    // The UI uses fields like `item.pkg`, `item.products[].product`,
    // `pricingType`, `minQuantity`, etc. Engine output is lean by design, so
    // we enrich it here using the already-loaded master catalog.
    const productItems = [];
    const packageItems = [];

    for (const line of engine.line_items) {
      if (line.type === "product") {
        const product = productMap.get(line.product_id);
        if (!product) continue;
        const includedQty = Math.max(1, product.min_quantity || 1);
        const extraQty = Math.max(0, line.quantity - includedQty);
        // Derive per-unit price from engine output: for per_unit products,
        // line.base_price = basePrice + unitPrice * extraQty. We can recover
        // unitPrice from the master tier (engine already respected overrides
        // for the final rounded price, which is what the UI shows).
        const masterTier = product[tierKey] || product.standard_tier || {};
        const basePrice = Math.max(0, parseFloat(masterTier.base_price) || 0);
        const unitPrice = Math.max(0, parseFloat(masterTier.unit_price) || 0);
        productItems.push({
          id: product.id,
          name: product.name,
          category: product.category,
          type: "product",
          pricingType: product.pricing_type,
          minQuantity: includedQty,
          maxQuantity: product.max_quantity,
          quantity: line.quantity,
          includedQty,
          extraQty,
          basePrice,
          unitPrice,
          extraCost: unitPrice * extraQty,
          // lineTotal is the engine's rounded, matrix-applied per-line price
          lineTotal: line.final_price,
          product,
          valid: true,
        });
      } else if (line.type === "package") {
        const pkg = packageMap.get(line.package_id);
        if (!pkg) continue;
        // Build nested product items with UI metadata. Use engine.nested_details
        // for per_unit extras; walk master composition for fixed/included products.
        const nestedDetailsByProd = new Map(
          (line.nested_details || []).map((d) => [d.product_id, d]),
        );
        const formPkgOriginal = inputPackages.find((fp) => fp.package_id === line.package_id);
        const formProducts = formPkgOriginal?.products || [];
        const products = (pkg.products || [])
          .map((pkgProduct) => {
            const productData = productMap.get(pkgProduct.product_id);
            if (!productData) return null;
            const masterIncludedQty = Math.max(1, pkgProduct.quantity || 1);
            const minQty = Math.max(1, productData.min_quantity || 1);
            const maxQty = productData.max_quantity;
            const formProd = formProducts.find((fp) => fp.product_id === pkgProduct.product_id);
            let productQty = formProd?.quantity != null
              ? Math.max(masterIncludedQty, formProd.quantity)
              : masterIncludedQty;
            if (maxQty != null) productQty = Math.min(productQty, maxQty);
            const engineDetail = nestedDetailsByProd.get(pkgProduct.product_id);
            const extraQty = engineDetail?.extra_qty ?? Math.max(0, productQty - masterIncludedQty);
            const unitPrice = engineDetail?.unit_price ?? (() => {
              const t = productData[tierKey] || productData.standard_tier || {};
              return Math.max(0, parseFloat(t.unit_price) || 0);
            })();
            return {
              id: productData.id,
              name: productData.name,
              category: productData.category,
              pricingType: productData.pricing_type,
              minQuantity: minQty,
              maxQuantity: maxQty,
              quantity: productQty,
              includedQty: masterIncludedQty,
              extraQty,
              unitPrice,
              lineTotal: engineDetail?.extra_cost ?? 0,
              product: productData,
              valid: true,
            };
          })
          .filter(Boolean);
        packageItems.push({
          id: pkg.id,
          name: pkg.name,
          type: "package",
          quantity: line.quantity,
          basePrice: line.base_price,
          lineTotal: line.final_price,
          products,
          pkg,
          valid: true,
        });
      }
    }

    return {
      packages: packageItems,
      products: productItems,
      // Engine-authoritative totals
      subtotal: engine.subtotal,
      blanketDiscount: engine.blanket_discount_applied,  // NEW: exposes matrix blanket discount
      manualDiscount: engine.manual_discount_applied,
      manualFee: engine.manual_fee_applied,
      discountType: engine.discount_type,
      discountValue: engine.discount_value,
      discountMode: engine.discount_mode,
      total: engine.calculated_price,
      // Full engine result available to consumers that need snapshot/version
      _engine: engine,
    };
  }, [
    formState,
    productMap,
    packageMap,
    tierKey,
    tier,
    agentMatrices,
    agencyMatrices,
    allProducts,
    allPackages,
    context?.project_type_id,
  ]);

  return { breakdown };
}

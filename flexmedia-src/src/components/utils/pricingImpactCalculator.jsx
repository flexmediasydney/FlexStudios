import { computePrice } from "@pricing/engine";

/**
 * Calculate estimated price delta from a revision's pricing impact.
 *
 * 2026-04-20 rewrite: delegates all math to the shared @pricing/engine module.
 * Runs computePrice() twice — once against the CURRENT project lines, once
 * against the POST-revision lines — and returns the difference. This makes the
 * preview delta byte-identical to what the backend will produce when the
 * revision is applied, including:
 *   - agent/agency matrix per-item overrides
 *   - blanket_discount (matrix-level product/package percent discounts)
 *   - $5 rounding on each line
 *   - manual per-project discount/fee
 *
 * Previously this function only looked at master-tier prices — off by tens of
 * dollars for any agent with matrix pricing. No more.
 *
 * @param {object} pricingImpact    Revision pricing_impact object
 *   { has_impact, products_added[], products_removed[], quantity_changes[] }
 * @param {object} context          Context needed to run the engine:
 *   - project: current project (products, packages, discount_*, agent_id, ...)
 *   - allProducts: product catalog
 *   - allPackages: package catalog
 *   - agentMatrices: PriceMatrix rows for project.agent_id (may be empty)
 *   - agencyMatrices: PriceMatrix rows for project.agency_id (may be empty)
 *   - pricingTier: 'standard' | 'premium'
 *
 * @returns {number} Rounded delta (post-total minus pre-total). 0 if no impact.
 */
export function calculatePricingDelta(pricingImpact, context = {}) {
  if (!pricingImpact?.has_impact) return 0;

  const {
    project = {},
    allProducts = [],
    allPackages = [],
    agentMatrices = [],
    agencyMatrices = [],
    pricingTier = "standard",
  } = context;

  // Normalize tier — engine accepts 'standard' | 'premium' only.
  const tier = pricingTier === "premium" ? "premium" : "standard";

  // Build the "before" line-item state from the current project.
  const beforeProducts = (project.products || []).map((p) => ({
    product_id: p.product_id,
    quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
  }));
  const beforePackages = (project.packages || []).map((pkg) => ({
    package_id: pkg.package_id,
    quantity: Math.max(1, parseInt(pkg.quantity, 10) || 1),
    products: (pkg.products || []).map((np) => ({
      product_id: np.product_id,
      quantity: np.quantity,
    })),
  }));

  // Apply the revision's impact deltas to produce the "after" state.
  const afterProducts = applyImpactToProducts(beforeProducts, pricingImpact);
  const afterPackages = beforePackages; // Revisions only touch product lines, not packages.

  const engineInputBase = {
    pricing_tier: tier,
    project_type_id: project.project_type_id || null,
    agent_matrices: agentMatrices,
    agency_matrices: agencyMatrices,
    catalog_products: allProducts,
    catalog_packages: allPackages,
    discount_type: project.discount_type || "fixed",
    discount_value: project.discount_value || 0,
    discount_mode: project.discount_mode || "discount",
  };

  const before = computePrice({
    ...engineInputBase,
    products: beforeProducts,
    packages: beforePackages,
  });
  const after = computePrice({
    ...engineInputBase,
    products: afterProducts,
    packages: afterPackages,
  });

  const delta = (after.calculated_price || 0) - (before.calculated_price || 0);
  return Math.round(delta * 100) / 100;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Apply a revision's pricing_impact (adds, removes, quantity changes) to a
 * product-line array, returning a new array. Packages are not touched — the
 * revision schema does not currently support package-level changes.
 */
function applyImpactToProducts(beforeProducts, pricingImpact) {
  // Start with a mutable copy keyed by product_id for quick lookup.
  const byId = new Map();
  for (const line of beforeProducts) {
    byId.set(line.product_id, { ...line });
  }

  // Removals — drop the product line entirely.
  for (const item of pricingImpact.products_removed || []) {
    if (item?.product_id) {
      byId.delete(item.product_id);
    }
  }

  // Quantity changes — override the stored quantity with new_quantity.
  for (const item of pricingImpact.quantity_changes || []) {
    if (item?.product_id && byId.has(item.product_id)) {
      const qty = Math.max(1, parseInt(item.new_quantity, 10) || 1);
      byId.set(item.product_id, { ...byId.get(item.product_id), quantity: qty });
    }
  }

  // Additions — either add a new line or merge quantity if the product is
  // already present (shouldn't happen in practice, but defensive).
  for (const item of pricingImpact.products_added || []) {
    if (!item?.product_id) continue;
    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
    if (byId.has(item.product_id)) {
      const existing = byId.get(item.product_id);
      byId.set(item.product_id, { ...existing, quantity: existing.quantity + qty });
    } else {
      byId.set(item.product_id, { product_id: item.product_id, quantity: qty });
    }
  }

  return Array.from(byId.values());
}

/**
 * Get readable summary of pricing impact changes
 */
export function getPricingImpactSummary(pricingImpact = {}) {
  const adds = (pricingImpact.products_added || []).filter(p => p.product_id).length;
  const removes = (pricingImpact.products_removed || []).filter(p => p.product_id).length;
  const changes = (pricingImpact.quantity_changes || []).filter(p => p.product_id).length;

  const parts = [];
  if (adds > 0) parts.push(`+${adds} product${adds !== 1 ? 's' : ''}`);
  if (removes > 0) parts.push(`−${removes} product${removes !== 1 ? 's' : ''}`);
  if (changes > 0) parts.push(`~${changes} qty change${changes !== 1 ? 's' : ''}`);

  return parts.join(', ') || 'No changes';
}

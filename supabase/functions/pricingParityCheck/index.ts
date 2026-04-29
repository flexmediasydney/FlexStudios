// pricingParityCheck — runs each project through BOTH the canonical backend
// math (inline, same as calculateProjectPricing) AND the new shared library,
// then returns a diff report. Used during Phase 1 of the engine extraction
// to prove the shared lib matches legacy behaviour before any switchover.
//
// POST body: { project_ids: string[] }
// Response:  { results: [{ project_id, title, match, backend, shared, delta }] }

import { getAdminClient, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { computePrice } from '../_shared/pricing/engine.ts';
import type { PriceMatrix, CatalogProduct, CatalogPackage, PricingTier, DiscountType, DiscountMode } from '../_shared/pricing/engine.ts';

// ─── Legacy backend math — lifted verbatim from calculateProjectPricing ─────
function legacyRoundToNearestFive(value: number): number {
  return Math.ceil(value / 5) * 5;
}

function legacyComputePrice(args: {
  products: any[];
  packages: any[];
  pricing_tier: string;
  project_type_id: string | null;
  discount_type: string;
  discount_value: number;
  discount_mode: string;
  agentMatrix: any[];
  agencyMatrix: any[];
  allProducts: any[];
  allPackages: any[];
}): any {
  const { products, packages, pricing_tier, project_type_id } = args;
  const tierKey = pricing_tier === 'premium' ? 'premium_tier' : 'standard_tier';

  function pickMatrix(matrices: any[]): any {
    if (!matrices || matrices.length === 0) return null;
    if (project_type_id) {
      const typed = matrices.find((m: any) => m.project_type_id === project_type_id);
      if (typed) return typed;
    }
    return matrices.find((m: any) => !m.project_type_id) || matrices[0] || null;
  }

  const rawAgentM = pickMatrix(args.agentMatrix || []);
  const rawAgencyM = pickMatrix(args.agencyMatrix || []);
  const agentM = rawAgentM?.use_default_pricing ? null : rawAgentM;
  const agencyM = rawAgencyM?.use_default_pricing ? null : rawAgencyM;

  // Engine v3 dual-shape resolution — mirrors supabase/functions/_shared/pricing/matrix.ts.
  // Returns { base, unit } for a product override, or null. Master values are needed for
  // percent_off / percent_markup modes — caller passes them in.
  function resolveProductTierLegacy(
    row: any,
    tier: string,
    masterBase: number,
    masterUnit: number,
  ): { base: number | null; unit: number | null } | null {
    if (!row) return null;
    if (row.tier_overrides) {
      const t = row.tier_overrides[tier];
      if (!t || !t.enabled) return null;
      const mode = t.mode || 'fixed';
      if (mode === 'fixed') {
        const base = t.base != null ? Math.max(0, parseFloat(String(t.base))) : null;
        const unit = t.unit != null ? Math.max(0, parseFloat(String(t.unit))) : null;
        if (base == null && unit == null) return null;
        return { base, unit };
      }
      if (mode === 'percent_off' || mode === 'percent_markup') {
        const pctRaw = parseFloat(String(t.percent ?? 0));
        const pct = Math.min(100, Math.max(0, isFinite(pctRaw) ? pctRaw : 0));
        const factor = mode === 'percent_off' ? 1 - pct / 100 : 1 + pct / 100;
        return { base: Math.max(0, masterBase * factor), unit: Math.max(0, masterUnit * factor) };
      }
      return null;
    }
    if (!row.override_enabled) return null;
    const base = tier === 'premium' ? row.premium_base : row.standard_base;
    const unit = tier === 'premium' ? row.premium_unit : row.standard_unit;
    const baseN = base != null && !isNaN(parseFloat(base)) ? Math.max(0, parseFloat(base)) : null;
    const unitN = unit != null && !isNaN(parseFloat(unit)) ? Math.max(0, parseFloat(unit)) : null;
    if (baseN == null && unitN == null) return null;
    return { base: baseN, unit: unitN };
  }

  function resolvePackageTierLegacy(row: any, tier: string, masterPrice: number): number | null {
    if (!row) return null;
    if (row.tier_overrides) {
      const t = row.tier_overrides[tier];
      if (!t || !t.enabled) return null;
      const mode = t.mode || 'fixed';
      if (mode === 'fixed') {
        if (t.price == null) return null;
        const p = parseFloat(String(t.price));
        return isFinite(p) ? Math.max(0, p) : null;
      }
      if (mode === 'percent_off' || mode === 'percent_markup') {
        const pctRaw = parseFloat(String(t.percent ?? 0));
        const pct = Math.min(100, Math.max(0, isFinite(pctRaw) ? pctRaw : 0));
        const factor = mode === 'percent_off' ? 1 - pct / 100 : 1 + pct / 100;
        return Math.max(0, masterPrice * factor);
      }
      return null;
    }
    if (!row.override_enabled) return null;
    const price = tier === 'premium' ? row.premium_price : row.standard_price;
    if (price == null || isNaN(parseFloat(price))) return null;
    return Math.max(0, parseFloat(price));
  }

  function getMatrixPrice(type: 'product' | 'package', id: string, basePrice: number): number {
    if (type === 'product') {
      // Master values not strictly needed here since current callers pass basePrice in
      // ignore-position; the per-product loop below uses resolveProductTierLegacy with
      // proper master values. This helper is only called for packages now.
      return basePrice;
    }
    if (type === 'package' && agentM?.package_pricing) {
      const row = agentM.package_pricing.find((p: any) => p.package_id === id);
      const resolved = resolvePackageTierLegacy(row, pricing_tier, basePrice);
      if (resolved != null) return resolved;
    }
    if (type === 'package' && agencyM?.package_pricing) {
      const row = agencyM.package_pricing.find((p: any) => p.package_id === id);
      const resolved = resolvePackageTierLegacy(row, pricing_tier, basePrice);
      if (resolved != null) return resolved;
    }
    return basePrice;
  }

  let totalPrice = 0;
  const lineItems: any[] = [];

  for (const item of products) {
    const product = args.allProducts.find((p: any) => p.id === item.product_id);
    if (!product) continue;
    const tier = product[tierKey] || product.standard_tier || {};
    let basePrice = Math.max(0, parseFloat(tier.base_price) || 0);
    let unitPrice = Math.max(0, parseFloat(tier.unit_price) || 0);
    // Engine v3: dual-shape resolution. Agent first, then agency.
    const agentRow = agentM?.product_pricing?.find((p: any) => p.product_id === item.product_id);
    const agencyRow = agencyM?.product_pricing?.find((p: any) => p.product_id === item.product_id);
    const resolvedOverride =
      resolveProductTierLegacy(agentRow, pricing_tier, basePrice, unitPrice)
      || resolveProductTierLegacy(agencyRow, pricing_tier, basePrice, unitPrice);
    if (resolvedOverride) {
      if (resolvedOverride.base != null) basePrice = Math.max(0, resolvedOverride.base);
      if (resolvedOverride.unit != null) unitPrice = Math.max(0, resolvedOverride.unit);
    }
    const qty = Math.max(1, item.quantity || 1);
    let itemPrice = 0;
    if (product.pricing_type === 'per_unit') {
      const minQty = Math.max(1, product.min_quantity || 1);
      const extraQty = Math.max(0, qty - minQty);
      itemPrice = basePrice + unitPrice * extraQty;
    } else {
      itemPrice = basePrice;
    }
    const roundedPrice = legacyRoundToNearestFive(itemPrice);
    lineItems.push({ type: 'product', product_id: item.product_id, quantity: qty, base_price: itemPrice, final_price: roundedPrice });
    totalPrice += roundedPrice;
  }

  for (const pkg of packages) {
    const packageObj = args.allPackages.find((p: any) => p.id === pkg.package_id);
    if (!packageObj) continue;
    const tier = packageObj[tierKey] || packageObj.standard_tier || {};
    const basePrice = Math.max(0, parseFloat(tier.package_price) || 0);
    const qty = Math.max(1, pkg.quantity || 1);
    const matrixPrice = getMatrixPrice('package', pkg.package_id, basePrice);
    let nestedExtraCost = 0;
    const formProducts = pkg.products || [];
    const masterProducts = packageObj.products || [];
    for (const masterProd of masterProducts) {
      const product = args.allProducts.find((p: any) => p.id === masterProd.product_id);
      if (!product) continue;
      const includedQty = Math.max(1, masterProd.quantity || 1);
      const formProd = formProducts.find((fp: any) => fp.product_id === masterProd.product_id);
      const userQty = formProd?.quantity != null ? Math.max(includedQty, formProd.quantity) : includedQty;
      if (product.pricing_type === 'per_unit') {
        const extraQty = Math.max(0, userQty - includedQty);
        if (extraQty > 0) {
          const prodTier = product[tierKey] || product.standard_tier || {};
          let unitPrice = Math.max(0, parseFloat(prodTier.unit_price) || 0);
          const masterBaseN = Math.max(0, parseFloat(prodTier.base_price) || 0);
          const nestedAgentRow = agentM?.product_pricing?.find((p: any) => p.product_id === masterProd.product_id);
          const nestedAgencyRow = agencyM?.product_pricing?.find((p: any) => p.product_id === masterProd.product_id);
          const nestedResolved =
            resolveProductTierLegacy(nestedAgentRow, pricing_tier, masterBaseN, unitPrice)
            || resolveProductTierLegacy(nestedAgencyRow, pricing_tier, masterBaseN, unitPrice);
          if (nestedResolved?.unit != null) unitPrice = Math.max(0, nestedResolved.unit);
          nestedExtraCost += unitPrice * extraQty;
        }
      }
    }
    const packageTotal = matrixPrice + nestedExtraCost;
    const roundedPrice = legacyRoundToNearestFive(packageTotal) * qty;
    lineItems.push({ type: 'package', package_id: pkg.package_id, quantity: qty, base_price: matrixPrice, nested_extra_cost: nestedExtraCost, final_price: roundedPrice });
    totalPrice += roundedPrice;
  }

  let finalPrice = totalPrice;
  let appliedDiscount = 0;
  const activeBlanket = agentM?.blanket_discount?.enabled ? agentM.blanket_discount
                     : agencyM?.blanket_discount?.enabled ? agencyM.blanket_discount : null;
  if (activeBlanket) {
    const productPct = Math.min(100, Math.max(0, parseFloat(activeBlanket.product_percent) || 0));
    const packagePct = Math.min(100, Math.max(0, parseFloat(activeBlanket.package_percent) || 0));
    // 2026-04-20 semantic: nested package extras carve into product basis,
    // package blanket applies to package BASE only. Matches applyBlanketDiscount.
    let packageBasis = 0;
    let extrasIntoProducts = 0;
    for (const li of lineItems) {
      if (li.type !== 'package') continue;
      packageBasis += Math.ceil(((li.base_price || 0)) / 5) * 5 * (li.quantity || 1);
      extrasIntoProducts += (li.nested_extra_cost || 0) * (li.quantity || 1);
    }
    const productLineSub = lineItems.filter((li: any) => li.type === 'product').reduce((s: number, li: any) => s + (li.final_price || 0), 0);
    const productBasis = productLineSub + extrasIntoProducts;
    const productDisc = productPct > 0 ? Math.min(productBasis, Math.ceil((productBasis * productPct) / 100 / 5) * 5) : 0;
    const packageDisc = packagePct > 0 ? Math.min(packageBasis, Math.ceil((packageBasis * packagePct) / 100 / 5) * 5) : 0;
    appliedDiscount = productDisc + packageDisc;
    finalPrice = Math.max(0, totalPrice - appliedDiscount);
  }

  let manualDiscount = 0;
  let manualFee = 0;
  const discVal = Math.max(0, parseFloat(String(args.discount_value)) || 0);
  if (discVal > 0) {
    if (args.discount_mode === 'fee') {
      manualFee = args.discount_type === 'percent' ? Math.round((finalPrice * discVal) / 100 * 100) / 100 : discVal;
      finalPrice = finalPrice + manualFee;
    } else {
      manualDiscount = args.discount_type === 'percent'
        ? Math.min(finalPrice, Math.round((finalPrice * discVal) / 100 * 100) / 100)
        : Math.min(finalPrice, discVal);
      finalPrice = Math.max(0, finalPrice - manualDiscount);
    }
  }

  return {
    calculated_price: finalPrice,
    subtotal: totalPrice,
    blanket_discount_applied: appliedDiscount,
    manual_discount_applied: manualDiscount,
    manual_fee_applied: manualFee,
    line_item_count: lineItems.length,
  };
}

// ─── Harness ─────────────────────────────────────────────────────────────
serveWithAudit('pricingParityCheck', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const body = await req.json().catch(() => ({}));
    const projectIds: string[] = Array.isArray(body.project_ids) ? body.project_ids : [];

    if (projectIds.length === 0) return errorResponse('project_ids required', 400);

    // Fetch all projects
    const { data: projects, error: projErr } = await admin
      .from('projects')
      .select('id, title, agent_id, agency_id, project_type_id, products, packages, pricing_tier, discount_type, discount_value, discount_mode')
      .in('id', projectIds);
    if (projErr) return errorResponse(`fetch projects: ${projErr.message}`);

    // Gather all product + package ids needed
    const productIds = new Set<string>();
    const packageIds = new Set<string>();
    const agentIds = new Set<string>();
    const agencyIds = new Set<string>();
    for (const p of projects || []) {
      (p.products || []).forEach((pr: any) => productIds.add(pr.product_id));
      (p.packages || []).forEach((pk: any) => {
        packageIds.add(pk.package_id);
        (pk.products || []).forEach((np: any) => productIds.add(np.product_id));
      });
      if (p.agent_id) agentIds.add(p.agent_id);
      if (p.agency_id) agencyIds.add(p.agency_id);
    }
    // Also pull master package nested product ids
    const { data: masterPackagesFirstPass } = await admin
      .from('packages').select('id, name, standard_tier, premium_tier, products')
      .in('id', Array.from(packageIds));
    for (const mp of masterPackagesFirstPass || []) {
      (mp.products || []).forEach((np: any) => productIds.add(np.product_id));
    }

    const [{ data: prods }, { data: pkgs }, { data: agentMats }, { data: agencyMats }] = await Promise.all([
      admin.from('products').select('id, name, pricing_type, min_quantity, standard_tier, premium_tier').in('id', Array.from(productIds)),
      admin.from('packages').select('id, name, standard_tier, premium_tier, products').in('id', Array.from(packageIds)),
      agentIds.size > 0 ? admin.from('price_matrices').select('*').eq('entity_type', 'agent').in('entity_id', Array.from(agentIds)) : Promise.resolve({ data: [] as any[] }),
      agencyIds.size > 0 ? admin.from('price_matrices').select('*').eq('entity_type', 'agency').in('entity_id', Array.from(agencyIds)) : Promise.resolve({ data: [] as any[] }),
    ]);

    const catalogProducts = (prods || []) as CatalogProduct[];
    const catalogPackages = (pkgs || []) as CatalogPackage[];
    const agentMatrices = (agentMats || []) as PriceMatrix[];
    const agencyMatrices = (agencyMats || []) as PriceMatrix[];

    // Parity-check each project
    const results = (projects || []).map((p: any) => {
      const agentForP = agentMatrices.filter((m) => m.entity_id === p.agent_id);
      const agencyForP = agencyMatrices.filter((m) => m.entity_id === p.agency_id);
      const prodsForP = p.products || [];
      const pkgsForP = p.packages || [];

      const legacy = legacyComputePrice({
        products: prodsForP,
        packages: pkgsForP,
        pricing_tier: p.pricing_tier || 'standard',
        project_type_id: p.project_type_id || null,
        discount_type: p.discount_type || 'fixed',
        discount_value: parseFloat(String(p.discount_value ?? 0)) || 0,
        discount_mode: p.discount_mode || 'discount',
        agentMatrix: agentForP,
        agencyMatrix: agencyForP,
        allProducts: catalogProducts,
        allPackages: catalogPackages,
      });

      const shared = computePrice({
        products: prodsForP,
        packages: pkgsForP,
        pricing_tier: (p.pricing_tier || 'standard') as PricingTier,
        project_type_id: p.project_type_id || null,
        agent_matrices: agentForP,
        agency_matrices: agencyForP,
        catalog_products: catalogProducts,
        catalog_packages: catalogPackages,
        discount_type: (p.discount_type || 'fixed') as DiscountType,
        discount_value: parseFloat(String(p.discount_value ?? 0)) || 0,
        discount_mode: (p.discount_mode || 'discount') as DiscountMode,
      });

      const match =
        legacy.calculated_price === shared.calculated_price &&
        legacy.subtotal === shared.subtotal &&
        legacy.blanket_discount_applied === shared.blanket_discount_applied &&
        legacy.manual_discount_applied === shared.manual_discount_applied &&
        legacy.manual_fee_applied === shared.manual_fee_applied &&
        legacy.line_item_count === shared.line_items.length;

      return {
        project_id: p.id,
        title: p.title,
        tier: p.pricing_tier,
        match,
        legacy: {
          total: legacy.calculated_price,
          subtotal: legacy.subtotal,
          blanket: legacy.blanket_discount_applied,
          man_disc: legacy.manual_discount_applied,
          man_fee: legacy.manual_fee_applied,
          lines: legacy.line_item_count,
        },
        shared: {
          total: shared.calculated_price,
          subtotal: shared.subtotal,
          blanket: shared.blanket_discount_applied,
          man_disc: shared.manual_discount_applied,
          man_fee: shared.manual_fee_applied,
          lines: shared.line_items.length,
        },
        delta: match ? null : {
          total: shared.calculated_price - legacy.calculated_price,
          subtotal: shared.subtotal - legacy.subtotal,
          blanket: shared.blanket_discount_applied - legacy.blanket_discount_applied,
          man_disc: shared.manual_discount_applied - legacy.manual_discount_applied,
          man_fee: shared.manual_fee_applied - legacy.manual_fee_applied,
          lines: shared.line_items.length - legacy.line_item_count,
        },
      };
    });

    return jsonResponse({
      total: results.length,
      passing: results.filter((r) => r.match).length,
      failing: results.filter((r) => !r.match).length,
      results,
    });
  } catch (err: any) {
    return errorResponse(err.message || String(err));
  }
});

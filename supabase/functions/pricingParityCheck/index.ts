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

  function getMatrixPrice(type: 'product' | 'package', id: string, basePrice: number): number {
    if (type === 'product' && agentM?.product_pricing) {
      const override = agentM.product_pricing.find((p: any) => p.product_id === id && p.override_enabled);
      if (override) {
        const tierPrice = pricing_tier === 'premium' ? override.premium_base : override.standard_base;
        if (tierPrice != null && !isNaN(parseFloat(tierPrice))) return Math.max(0, parseFloat(tierPrice));
      }
    }
    if (type === 'product' && agencyM?.product_pricing) {
      const override = agencyM.product_pricing.find((p: any) => p.product_id === id && p.override_enabled);
      if (override) {
        const tierPrice = pricing_tier === 'premium' ? override.premium_base : override.standard_base;
        if (tierPrice != null && !isNaN(parseFloat(tierPrice))) return Math.max(0, parseFloat(tierPrice));
      }
    }
    if (type === 'package' && agentM?.package_pricing) {
      const override = agentM.package_pricing.find((p: any) => p.package_id === id && p.override_enabled);
      if (override) {
        const tierPrice = pricing_tier === 'premium' ? override.premium_price : override.standard_price;
        if (tierPrice != null && !isNaN(parseFloat(tierPrice))) return Math.max(0, parseFloat(tierPrice));
      }
    }
    if (type === 'package' && agencyM?.package_pricing) {
      const override = agencyM.package_pricing.find((p: any) => p.package_id === id && p.override_enabled);
      if (override) {
        const tierPrice = pricing_tier === 'premium' ? override.premium_price : override.standard_price;
        if (tierPrice != null && !isNaN(parseFloat(tierPrice))) return Math.max(0, parseFloat(tierPrice));
      }
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
    const agentOverride = agentM?.product_pricing?.find((p: any) => p.product_id === item.product_id && p.override_enabled);
    const agencyOverride = agencyM?.product_pricing?.find((p: any) => p.product_id === item.product_id && p.override_enabled);
    if (agentOverride) {
      const matrixBase = pricing_tier === 'premium' ? agentOverride.premium_base : agentOverride.standard_base;
      const matrixUnit = pricing_tier === 'premium' ? agentOverride.premium_unit : agentOverride.standard_unit;
      if (matrixBase != null) basePrice = Math.max(0, parseFloat(matrixBase) || 0);
      if (matrixUnit != null) unitPrice = Math.max(0, parseFloat(matrixUnit) || 0);
    } else if (agencyOverride) {
      const matrixBase = pricing_tier === 'premium' ? agencyOverride.premium_base : agencyOverride.standard_base;
      const matrixUnit = pricing_tier === 'premium' ? agencyOverride.premium_unit : agencyOverride.standard_unit;
      if (matrixBase != null) basePrice = Math.max(0, parseFloat(matrixBase) || 0);
      if (matrixUnit != null) unitPrice = Math.max(0, parseFloat(matrixUnit) || 0);
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
          const nestedAgentOverride = agentM?.product_pricing?.find((p: any) => p.product_id === masterProd.product_id && p.override_enabled);
          const nestedAgencyOverride = agencyM?.product_pricing?.find((p: any) => p.product_id === masterProd.product_id && p.override_enabled);
          if (nestedAgentOverride) {
            const matrixUnit = pricing_tier === 'premium' ? nestedAgentOverride.premium_unit : nestedAgentOverride.standard_unit;
            if (matrixUnit != null) unitPrice = Math.max(0, parseFloat(matrixUnit) || 0);
          } else if (nestedAgencyOverride) {
            const matrixUnit = pricing_tier === 'premium' ? nestedAgencyOverride.premium_unit : nestedAgencyOverride.standard_unit;
            if (matrixUnit != null) unitPrice = Math.max(0, parseFloat(matrixUnit) || 0);
          }
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
    const productSub = lineItems.filter((li: any) => li.type === 'product').reduce((s: number, li: any) => s + (li.final_price || 0), 0);
    const packageSub = lineItems.filter((li: any) => li.type === 'package').reduce((s: number, li: any) => s + (li.final_price || 0), 0);
    const productDisc = productPct > 0 ? Math.min(productSub, Math.ceil((productSub * productPct) / 100 / 5) * 5) : 0;
    const packageDisc = packagePct > 0 ? Math.min(packageSub, Math.ceil((packageSub * packagePct) / 100 / 5) * 5) : 0;
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

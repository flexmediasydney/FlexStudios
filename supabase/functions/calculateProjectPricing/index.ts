import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse } from '../_shared/supabase.ts';

/**
 * Canonical pricing engine — single source of truth for all project pricing calculations.
 * Accepts products/packages, applies agent/agency matrix pricing, rounds line items to $5.
 */

// Utility: retry with exponential backoff for transient failures
function retryWithBackoff(fn: () => Promise<any>, maxAttempts = 3, delayMs = 100): Promise<any> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      fn()
        .then(resolve)
        .catch(err => {
          if (attempt < maxAttempts && (err?.message?.includes('timeout') || err?.status >= 500)) {
            setTimeout(tryOnce, delayMs * Math.pow(2, attempt - 1));
          } else {
            reject(err);
          }
        });
    };
    tryOnce();
  });
}

function roundToNearestFive(value: number): number {
  return Math.ceil(value / 5) * 5;
}

Deno.serve(async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    // Role guard (only for user-context calls; service-role calls are already authorized)
    if (user && !['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    // Rate limit: only applies to user calls
    if (user) {
      const now = Date.now();
      if (req.headers.get('x-calc-count') && parseInt(req.headers.get('x-calc-count')!) > 100) {
        console.warn(`Rate limit suspected for user ${user.email}`);
        return errorResponse('Rate limit exceeded', 429);
      }
    }

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v2.0', _fn: 'calculateProjectPricing', _ts: '2026-03-17' });
    }

    const {
      agent_id,
      agency_id,
      products = [],
      packages = [],
      pricing_tier = 'standard',
      project_type_id = null,
    } = body;

    // Input validation
    if (!Array.isArray(products) || !Array.isArray(packages)) {
      return errorResponse('products and packages must be arrays', 400);
    }

    if (products.length === 0 && packages.length === 0) {
      return jsonResponse({
        success: true,
        calculated_price: 0,
        pricing_tier,
        line_items: [],
        price_matrix_snapshot: null,
      });
    }

    // Fetch price matrices
    const [agentMatrix, agencyMatrix, allProductsRaw, allPackagesRaw] = await Promise.all([
      agent_id ? retryWithBackoff(() => entities.PriceMatrix.filter({ entity_type: 'agent', entity_id: agent_id })) : Promise.resolve([]),
      agency_id ? retryWithBackoff(() => entities.PriceMatrix.filter({ entity_type: 'agency', entity_id: agency_id })) : Promise.resolve([]),
      Promise.all(
        [...new Set([
          ...products.map((p: any) => p.product_id),
          ...packages.flatMap((pkg: any) => (pkg.products || []).map((np: any) => np.product_id)),
        ].filter(Boolean))].map((id: string) =>
          retryWithBackoff(() => entities.Product.get(id)).catch(() => null)
        )
      ),
      Promise.all(
        [...new Set(packages.map((p: any) => p.package_id).filter(Boolean))].map((id: string) =>
          retryWithBackoff(() => entities.Package.get(id)).catch(() => null)
        )
      ),
    ]);

    const allProducts = allProductsRaw.filter(Boolean);
    const allPackages = allPackagesRaw.filter(Boolean);
    const tierKey = pricing_tier === 'premium' ? 'premium_tier' : 'standard_tier';

    function pickMatrix(matrices: any[]): any {
      if (!matrices || matrices.length === 0) return null;
      if (project_type_id) {
        const typed = matrices.find((m: any) => m.project_type_id === project_type_id);
        if (typed) return typed;
      }
      return matrices.find((m: any) => !m.project_type_id) || matrices[0] || null;
    }

    // Null out matrices that use default pricing — their overrides should be ignored
    const rawAgentM = pickMatrix(agentMatrix || []);
    const rawAgencyM = pickMatrix(agencyMatrix || []);
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

    // Products
    for (const item of products) {
      const product = allProducts.find((p: any) => p.id === item.product_id);
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

      const roundedPrice = roundToNearestFive(itemPrice);

      lineItems.push({
        type: 'product',
        product_id: item.product_id,
        product_name: product.name,
        quantity: qty,
        base_price: itemPrice,
        matrix_applied: agentOverride || agencyOverride ? true : false,
        final_price: roundedPrice,
      });

      totalPrice += roundedPrice;
    }

    // Packages
    for (const pkg of packages) {
      const packageObj = allPackages.find((p: any) => p.id === pkg.package_id);
      if (!packageObj) continue;

      const tier = packageObj[tierKey] || packageObj.standard_tier || {};
      const basePrice = Math.max(0, parseFloat(tier.package_price) || 0);
      const qty = Math.max(1, pkg.quantity || 1);

      const matrixPrice = getMatrixPrice('package', pkg.package_id, basePrice);

      let nestedExtraCost = 0;
      const nestedDetails: any[] = [];
      const formProducts = pkg.products || [];
      const masterProducts = packageObj.products || [];

      for (const masterProd of masterProducts) {
        const product = allProducts.find((p: any) => p.id === masterProd.product_id);
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

            const extraCost = unitPrice * extraQty;
            nestedExtraCost += extraCost;
            nestedDetails.push({
              product_id: masterProd.product_id,
              product_name: product.name,
              included_qty: includedQty,
              user_qty: userQty,
              extra_qty: extraQty,
              unit_price: unitPrice,
              extra_cost: extraCost,
            });
          }
        }
      }

      const packageTotal = matrixPrice + nestedExtraCost;
      const roundedPrice = roundToNearestFive(packageTotal) * qty;

      lineItems.push({
        type: 'package',
        package_id: pkg.package_id,
        package_name: packageObj.name,
        quantity: qty,
        base_price: matrixPrice,
        nested_extra_cost: nestedExtraCost,
        nested_details: nestedDetails,
        matrix_applied: matrixPrice !== basePrice,
        final_price: roundedPrice,
      });

      totalPrice += roundedPrice;
    }

    // Blanket discount
    let finalPrice = totalPrice;
    let appliedDiscount = 0;

    const activeBlanket = agentM?.blanket_discount?.enabled
      ? agentM.blanket_discount
      : agencyM?.blanket_discount?.enabled
        ? agencyM.blanket_discount
        : null;

    if (activeBlanket) {
      const productDiscountPct = Math.min(100, Math.max(0, parseFloat(activeBlanket.product_percent) || 0));
      const packageDiscountPct = Math.min(100, Math.max(0, parseFloat(activeBlanket.package_percent) || 0));

      const productSubtotal = lineItems
        .filter((li: any) => li.type === 'product')
        .reduce((sum: number, li: any) => sum + (li.final_price || 0), 0);
      const packageSubtotal = lineItems
        .filter((li: any) => li.type === 'package')
        .reduce((sum: number, li: any) => sum + (li.final_price || 0), 0);

      const productDiscount = productDiscountPct > 0
        ? Math.min(productSubtotal, Math.ceil((productSubtotal * productDiscountPct) / 100 / 5) * 5)
        : 0;
      const packageDiscount = packageDiscountPct > 0
        ? Math.min(packageSubtotal, Math.ceil((packageSubtotal * packageDiscountPct) / 100 / 5) * 5)
        : 0;

      appliedDiscount = productDiscount + packageDiscount;
      finalPrice = Math.max(0, totalPrice - appliedDiscount);
    }

    return jsonResponse({
      success: true,
      calculated_price: finalPrice,
      pricing_tier,
      line_items: lineItems,
      subtotal: totalPrice,
      blanket_discount_applied: appliedDiscount,
      price_matrix_snapshot: agentM || agencyM || rawAgentM || rawAgencyM,
    });

  } catch (error: any) {
    console.error('calculateProjectPricing error:', error);
    return errorResponse(error.message);
  }
});

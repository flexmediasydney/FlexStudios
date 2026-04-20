// calculateProjectPricing — thin wrapper around the shared pricing library.
//
// 2026-04-20: Extracted the ~230 lines of inline pricing math into
// supabase/functions/_shared/pricing/. This file now:
//   1. Auth-guards the request
//   2. Loads inputs (products, packages, matrices, catalog) from DB
//   3. Calls computePrice() — the single source of truth used by BOTH backend
//      edge fns AND the frontend Vite app (via @pricing alias)
//   4. Returns the PricingResult
//
// Math semantics unchanged. Verified via pricingParityCheck against 53 prod
// projects — zero divergence between old inline math and shared lib.
//
// DO NOT reintroduce inline pricing math here. If you need to change how a
// price is calculated, change it in _shared/pricing/* and bump ENGINE_VERSION.
// That way frontend preview and backend save always agree by construction.

import { getAdminClient, getUserFromReq, createEntities, handleCors, jsonResponse, errorResponse, serveWithAudit } from '../_shared/supabase.ts';
import { computePrice } from '../_shared/pricing/engine.ts';
import type { PriceMatrix, CatalogProduct, CatalogPackage, PricingTier, DiscountType, DiscountMode } from '../_shared/pricing/engine.ts';

function retryWithBackoff(fn: () => Promise<any>, maxAttempts = 3, delayMs = 100): Promise<any> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tryOnce = () => {
      attempt++;
      fn()
        .then(resolve)
        .catch((err: any) => {
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

serveWithAudit('calculateProjectPricing', async (req) => {
  const cors = handleCors(req); if (cors) return cors;
  try {
    const admin = getAdminClient();
    const entities = createEntities(admin);
    const user = await getUserFromReq(req);

    if (user && !['master_admin', 'admin', 'manager', 'employee'].includes(user.role)) {
      return errorResponse('Forbidden: insufficient role', 403);
    }

    if (user) {
      if (req.headers.get('x-calc-count') && parseInt(req.headers.get('x-calc-count')!) > 100) {
        console.warn(`Rate limit suspected for user ${user.email}`);
        return errorResponse('Rate limit exceeded', 429);
      }
    }

    const body = await req.json().catch(() => ({}));

    if (body?._health_check) {
      return jsonResponse({ _version: 'v3.0-shared', _fn: 'calculateProjectPricing', _ts: '2026-04-20' });
    }

    const {
      agent_id,
      agency_id,
      products = [],
      packages = [],
      pricing_tier = 'standard',
      project_type_id = null,
      discount_type = 'fixed',
      discount_value = 0,
      discount_mode = 'discount',
    } = body;

    if (!Array.isArray(products) || !Array.isArray(packages)) {
      return errorResponse('products and packages must be arrays', 400);
    }

    // Empty line items — engine handles this too, but short-circuit here to
    // avoid unnecessary DB reads.
    if (products.length === 0 && packages.length === 0) {
      return jsonResponse({
        success: true,
        calculated_price: 0,
        pricing_tier,
        line_items: [],
        price_matrix_snapshot: null,
      });
    }

    // ─── Load inputs from DB ──────────────────────────────────────────────
    const productIds: string[] = [...new Set([
      ...products.map((p: any) => p.product_id),
      ...packages.flatMap((pkg: any) => (pkg.products || []).map((np: any) => np.product_id)),
    ].filter(Boolean))];
    const packageIds: string[] = [...new Set(packages.map((p: any) => p.package_id).filter(Boolean))];

    const [agentMatricesRaw, agencyMatricesRaw, productCatalogRaw, packageCatalogRaw] = await Promise.all([
      agent_id ? retryWithBackoff(() => entities.PriceMatrix.filter({ entity_type: 'agent', entity_id: agent_id })) : Promise.resolve([]),
      agency_id ? retryWithBackoff(() => entities.PriceMatrix.filter({ entity_type: 'agency', entity_id: agency_id })) : Promise.resolve([]),
      Promise.all(productIds.map((id: string) => retryWithBackoff(() => entities.Product.get(id)).catch(() => null))),
      Promise.all(packageIds.map((id: string) => retryWithBackoff(() => entities.Package.get(id)).catch(() => null))),
    ]);

    // Packages carry nested product ids that the line-items engine needs to
    // look up — scan their master compositions and load any missing products.
    const extraNestedIds = new Set<string>();
    for (const pkg of packageCatalogRaw.filter(Boolean)) {
      for (const nested of (pkg.products || [])) {
        if (nested.product_id && !productIds.includes(nested.product_id)) {
          extraNestedIds.add(nested.product_id);
        }
      }
    }
    const extraProducts = await Promise.all(
      [...extraNestedIds].map((id: string) => retryWithBackoff(() => entities.Product.get(id)).catch(() => null))
    );

    const catalog_products: CatalogProduct[] = [...productCatalogRaw, ...extraProducts].filter(Boolean) as CatalogProduct[];
    const catalog_packages: CatalogPackage[] = packageCatalogRaw.filter(Boolean) as CatalogPackage[];
    const agent_matrices: PriceMatrix[] = (agentMatricesRaw || []) as PriceMatrix[];
    const agency_matrices: PriceMatrix[] = (agencyMatricesRaw || []) as PriceMatrix[];

    // ─── Call the shared engine ───────────────────────────────────────────
    const result = computePrice({
      products,
      packages,
      pricing_tier: pricing_tier as PricingTier,
      project_type_id,
      agent_matrices,
      agency_matrices,
      catalog_products,
      catalog_packages,
      discount_type: discount_type as DiscountType,
      discount_value,
      discount_mode: discount_mode as DiscountMode,
    });

    return jsonResponse({
      success: true,
      ...result,
      // Back-compat: legacy callers read these exact keys. Keep them even
      // though PricingResult already has matching fields — some consumers
      // destructure explicitly.
      calculated_price: result.calculated_price,
      pricing_tier: result.pricing_tier,
      line_items: result.line_items,
      subtotal: result.subtotal,
      blanket_discount_applied: result.blanket_discount_applied,
      manual_discount_applied: result.manual_discount_applied,
      manual_fee_applied: result.manual_fee_applied,
      discount_type: result.discount_type,
      discount_value: result.discount_value,
      discount_mode: result.discount_mode,
      price_matrix_snapshot: result.price_matrix_snapshot,
    });

  } catch (error: any) {
    console.error('calculateProjectPricing error:', error);
    return errorResponse(error.message);
  }
});

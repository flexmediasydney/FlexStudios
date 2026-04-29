// Per-line computation — products and packages.
//
// Math for a single product line:
//   base = override.base ?? tier.base_price
//   unit = override.unit ?? tier.unit_price
//   qty  = max(1, user_qty)
//   if pricing_type === 'per_unit':
//     extra_qty = max(0, qty - min_quantity)
//     raw = base + unit * extra_qty
//   else:
//     raw = base
//   final = roundToNearestFive(raw)
//
// Math for a single package line:
//   base_package = override.price ?? tier.package_price
//   nested_extra = Σ over master products:
//     if pricing_type === 'per_unit' AND user_qty > master_included_qty:
//       unit = nested_override.unit ?? tier.unit_price
//       nested_extra += unit * (user_qty - master_included_qty)
//   raw = base_package + nested_extra
//   per_unit_rounded = roundToNearestFive(raw)
//   final = per_unit_rounded * qty
//
// Byte-for-byte preserves the current calculateProjectPricing edge fn math
// (line 160–280). Any behavior change here breaks every stored price — the
// fixture tests pin this.

import { roundToNearestFive } from './round.ts';
import { resolveProductOverride, resolvePackageOverride } from './matrix.ts';
import type {
  CatalogProduct,
  CatalogPackage,
  LineItem,
  LineItemProduct,
  LineItemPackage,
  PackageLine,
  PriceMatrix,
  PricingTier,
  ProductLine,
} from './schema.ts';

export interface LineItemsInput {
  products: ProductLine[];
  packages: PackageLine[];
  tier: PricingTier;
  catalog_products: CatalogProduct[];
  catalog_packages: CatalogPackage[];
  agent_matrix: PriceMatrix | null;
  agency_matrix: PriceMatrix | null;
}

export function computeLineItems(input: LineItemsInput): LineItem[] {
  const lineItems: LineItem[] = [];

  // ─── Standalone products ───────────────────────────────────────────────
  for (const item of input.products) {
    const product = input.catalog_products.find((p) => p.id === item.product_id);
    if (!product) continue;

    const tier = (input.tier === 'premium' ? product.premium_tier : product.standard_tier)
      || product.standard_tier
      || {};
    let basePrice = nonNegative(tier.base_price);
    let unitPrice = nonNegative(tier.unit_price);

    // Pass master tier values so engine v3 percent_off / percent_markup modes
    // can compute final values. Legacy 'fixed' / engine-v2 paths ignore them.
    const override = resolveProductOverride(
      item.product_id,
      input.tier,
      input.agent_matrix,
      input.agency_matrix,
      basePrice,
      unitPrice,
    );
    if (override) {
      if (override.base != null) basePrice = Math.max(0, override.base);
      if (override.unit != null) unitPrice = Math.max(0, override.unit);
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

    const line: LineItemProduct = {
      type: 'product',
      product_id: item.product_id,
      product_name: product.name,
      quantity: qty,
      base_price: itemPrice,
      matrix_applied: override != null,
      final_price: roundedPrice,
    };
    lineItems.push(line);
  }

  // ─── Packages ──────────────────────────────────────────────────────────
  for (const pkg of input.packages) {
    const packageObj = input.catalog_packages.find((p) => p.id === pkg.package_id);
    if (!packageObj) continue;

    const tier = (input.tier === 'premium' ? packageObj.premium_tier : packageObj.standard_tier)
      || packageObj.standard_tier
      || {};
    const tierBasePrice = nonNegative(tier.package_price);
    const qty = Math.max(1, pkg.quantity || 1);

    // Package-level override (one override replaces tier base price entirely).
    // Pass master tier price so engine v3 percent modes can compute against it.
    const pkgOverride = resolvePackageOverride(
      pkg.package_id,
      input.tier,
      input.agent_matrix,
      input.agency_matrix,
      tierBasePrice,
    );
    const matrixPrice = pkgOverride ? pkgOverride.price : tierBasePrice;

    // Nested extra: for each product in the package's MASTER composition,
    // compare master_included_qty to user-requested qty. Any extra gets
    // charged at (possibly overridden) unit price.
    let nestedExtraCost = 0;
    const nestedDetails: LineItemPackage['nested_details'] = [];
    const formProducts = pkg.products || [];
    const masterProducts = packageObj.products || [];

    for (const masterProd of masterProducts) {
      const product = input.catalog_products.find((p) => p.id === masterProd.product_id);
      if (!product) continue;

      const includedQty = Math.max(1, masterProd.quantity || 1);
      const formProd = formProducts.find((fp) => fp.product_id === masterProd.product_id);
      const userQty = formProd?.quantity != null ? Math.max(includedQty, formProd.quantity) : includedQty;

      if (product.pricing_type !== 'per_unit') continue;
      const extraQty = Math.max(0, userQty - includedQty);
      if (extraQty <= 0) continue;

      const prodTier = (input.tier === 'premium' ? product.premium_tier : product.standard_tier)
        || product.standard_tier
        || {};
      let unitPrice = nonNegative(prodTier.unit_price);

      // Master master values for the nested product — needed for engine v3
      // percent modes. The base value is unused for nested unit-overflow but
      // pass it for resolver consistency.
      const nestedMasterBase = nonNegative(prodTier.base_price);
      const nestedMasterUnit = unitPrice;
      const nestedOverride = resolveProductOverride(
        masterProd.product_id,
        input.tier,
        input.agent_matrix,
        input.agency_matrix,
        nestedMasterBase,
        nestedMasterUnit,
      );
      if (nestedOverride?.unit != null) unitPrice = Math.max(0, nestedOverride.unit);

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

    const packageTotal = matrixPrice + nestedExtraCost;
    // Critical ordering: round FIRST, then multiply by qty. Preserves legacy
    // behavior — multi-qty packages get (rounded unit) × qty, not round(qty × raw).
    const roundedPrice = roundToNearestFive(packageTotal) * qty;

    const line: LineItemPackage = {
      type: 'package',
      package_id: pkg.package_id,
      package_name: packageObj.name,
      quantity: qty,
      base_price: matrixPrice,
      nested_extra_cost: nestedExtraCost,
      nested_details: nestedDetails,
      matrix_applied: matrixPrice !== tierBasePrice,
      final_price: roundedPrice,
    };
    lineItems.push(line);
  }

  return lineItems;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function nonNegative(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, n);
}

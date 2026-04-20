// Discount cascade — blanket discount (matrix-level) and manual adjustment
// (per-project).
//
// Order of operations, locked forever:
//
//   subtotal      = Σ lineItems[].final_price
//   packageDisc   = min(packageSubtotal, ceil(packageSubtotal × packagePct / 100 / 5) × 5)
//   productDisc   = min(productSubtotal, ceil(productSubtotal × productPct / 100 / 5) × 5)
//   postBlanket   = subtotal − packageDisc − productDisc
//   manualDisc    = if mode='discount' then min(postBlanket, amount_or_pct_of_postBlanket) else 0
//   manualFee     = if mode='fee' then amount_or_pct_of_postBlanket else 0
//   total         = max(0, postBlanket − manualDisc + manualFee)
//
// Key invariants:
//   - Blanket discount is MUTUALLY EXCLUSIVE per source (agent OR agency, never both)
//   - Manual adjustment anchors on POST-blanket amount, not pre-blanket subtotal
//   - Fee is uncapped (matches current backend — user typed it, user owns it)
//   - Discount is capped to prevent negative totals
//   - Rounding is only on the DISCOUNT amount (not on the post-blanket subtotal)

import { roundToNearestFive } from './round.ts';
import { resolveBlanketDiscount } from './matrix.ts';
import type {
  DiscountMode,
  DiscountType,
  LineItem,
  PriceMatrix,
} from './schema.ts';

export interface BlanketResult {
  subtotal: number;
  product_subtotal: number;
  package_subtotal: number;
  product_discount: number;
  package_discount: number;
  applied_discount: number;
  post_blanket: number;
}

/**
 * Apply the matrix's blanket discount.
 *
 * Semantic (set 2026-04-20): nested per-unit extras added INSIDE a package
 * (e.g. user bumps Sales Images from the included 20 to 22) are treated as
 * products for discount purposes — they get `product_percent`, not
 * `package_percent`. The package base price is what gets `package_percent`.
 *
 * Rationale: these extras are ad-hoc additions by the end user and aren't
 * part of the standing "package deal" the matrix is discounting. Charging
 * them under the product side of the blanket matches how they'd be treated
 * if the user had added them as standalone products.
 *
 * Historical note: before this change, the engine bundled extras into the
 * package line's `final_price` and applied `package_percent` to the whole
 * thing. No production project actually exercised that path (zero projects
 * had extras at the time of the switch), so the semantic change didn't
 * move any stored prices. Parity tests (pricingParityCheck) stayed 53/53
 * green through the transition.
 *
 * `subtotal` remains `Σ line.final_price` for line-item display consistency.
 * What changes is how we carve up that subtotal into package-discountable
 * vs product-discountable portions for the blanket math. Sums of rounded
 * sub-portions can drift from `final_price` by $5 on awkward percentages;
 * that's accepted rounding noise.
 */
export function applyBlanketDiscount(
  lineItems: LineItem[],
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
): BlanketResult {
  // Display subtotal — sum of already-rounded line finals. Unchanged.
  const productLineSubtotal = lineItems
    .filter((li) => li.type === 'product')
    .reduce((sum, li) => sum + (li.final_price || 0), 0);
  const packageLineSubtotal = lineItems
    .filter((li) => li.type === 'package')
    .reduce((sum, li) => sum + (li.final_price || 0), 0);
  const subtotal = productLineSubtotal + packageLineSubtotal;

  // ── Discount basis — NEW 2026-04-20 semantic ──────────────────────────
  // Package blanket applies to package BASE only (rounded per instance, × qty).
  // Product blanket applies to standalone products + nested package extras.
  let packageDiscountBasis = 0;
  let productExtrasFromPackages = 0;
  for (const li of lineItems) {
    if (li.type !== 'package') continue;
    const base = li.base_price || 0;
    const qty = li.quantity || 1;
    packageDiscountBasis += roundToNearestFive(base) * qty;
    productExtrasFromPackages += (li.nested_extra_cost || 0) * qty;
  }
  const productDiscountBasis = productLineSubtotal + productExtrasFromPackages;

  const blanket = resolveBlanketDiscount(agentMatrix, agencyMatrix);

  let productDiscount = 0;
  let packageDiscount = 0;
  if (blanket) {
    productDiscount =
      blanket.product_percent > 0
        ? Math.min(productDiscountBasis, roundToNearestFive((productDiscountBasis * blanket.product_percent) / 100))
        : 0;
    packageDiscount =
      blanket.package_percent > 0
        ? Math.min(packageDiscountBasis, roundToNearestFive((packageDiscountBasis * blanket.package_percent) / 100))
        : 0;
  }

  const appliedDiscount = productDiscount + packageDiscount;
  const postBlanket = Math.max(0, subtotal - appliedDiscount);

  return {
    subtotal,
    // Report the discount-basis breakdown, not the line-display breakdown —
    // these feed the UI's per-line effective price calculation.
    product_subtotal: productDiscountBasis,
    package_subtotal: packageDiscountBasis,
    product_discount: productDiscount,
    package_discount: packageDiscount,
    applied_discount: appliedDiscount,
    post_blanket: postBlanket,
  };
}

export interface ManualResult {
  manual_discount_applied: number;
  manual_fee_applied: number;
  total: number;
  discount_type: DiscountType;
  discount_value: number;
  discount_mode: DiscountMode;
}

export function applyManualAdjustment(
  postBlanket: number,
  opts: {
    discount_type?: DiscountType;
    discount_value?: number | string;
    discount_mode?: DiscountMode;
  },
): ManualResult {
  const type: DiscountType = opts.discount_type || 'fixed';
  const mode: DiscountMode = opts.discount_mode || 'discount';
  const rawValue = parseFloat(String(opts.discount_value ?? 0));
  const value = Number.isFinite(rawValue) && rawValue > 0 ? rawValue : 0;

  let manualDiscount = 0;
  let manualFee = 0;
  let total = postBlanket;

  if (value > 0) {
    if (mode === 'fee') {
      if (type === 'percent') {
        // Percent of post-blanket. Capped at 100% by logical interpretation but
        // we don't clamp here — the fee side is deliberately uncapped so admins
        // can encode unusual adjustments. Matches legacy backend behaviour.
        manualFee = Math.round(((postBlanket * value) / 100) * 100) / 100;
      } else {
        manualFee = value;
      }
      total = postBlanket + manualFee;
    } else {
      // discount mode
      if (type === 'percent') {
        manualDiscount = Math.min(postBlanket, Math.round(((postBlanket * value) / 100) * 100) / 100);
      } else {
        manualDiscount = Math.min(postBlanket, value);
      }
      total = Math.max(0, postBlanket - manualDiscount);
    }
  }

  return {
    manual_discount_applied: manualDiscount,
    manual_fee_applied: manualFee,
    total,
    discount_type: type,
    discount_value: value,
    discount_mode: mode,
  };
}

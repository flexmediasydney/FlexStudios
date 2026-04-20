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

export function applyBlanketDiscount(
  lineItems: LineItem[],
  agentMatrix: PriceMatrix | null,
  agencyMatrix: PriceMatrix | null,
): BlanketResult {
  const productSubtotal = lineItems
    .filter((li) => li.type === 'product')
    .reduce((sum, li) => sum + (li.final_price || 0), 0);
  const packageSubtotal = lineItems
    .filter((li) => li.type === 'package')
    .reduce((sum, li) => sum + (li.final_price || 0), 0);
  const subtotal = productSubtotal + packageSubtotal;

  const blanket = resolveBlanketDiscount(agentMatrix, agencyMatrix);

  let productDiscount = 0;
  let packageDiscount = 0;
  if (blanket) {
    productDiscount =
      blanket.product_percent > 0
        ? Math.min(productSubtotal, roundToNearestFive((productSubtotal * blanket.product_percent) / 100))
        : 0;
    packageDiscount =
      blanket.package_percent > 0
        ? Math.min(packageSubtotal, roundToNearestFive((packageSubtotal * blanket.package_percent) / 100))
        : 0;
  }

  const appliedDiscount = productDiscount + packageDiscount;
  const postBlanket = Math.max(0, subtotal - appliedDiscount);

  return {
    subtotal,
    product_subtotal: productSubtotal,
    package_subtotal: packageSubtotal,
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

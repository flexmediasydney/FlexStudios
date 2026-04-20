// Canonical rounding rule for the pricing engine.
//
// Every monetary value that the engine surfaces passes through this function
// exactly once at a well-defined point in the cascade. Changing this rule
// would change every price in the system, so it lives alone in its own file
// and every other module imports from here.
//
// Rule: round UP to nearest $5. Applies to:
//   - Per-line final_price (after product/package math + matrix overrides)
//   - Blanket discount AMOUNT (on the post-line subtotal, pre-manual-adjustment)
//
// NOT applied to:
//   - Manual discount/fee amounts (kept exact per user input)
//   - Final total (sum of already-rounded pieces)
//
// Edge cases locked in:
//   - 0 → 0
//   - Negative → rounds toward 0 (ceil). -2 → 0. Keep defensive; math upstream
//     guards against negatives so this shouldn't actually occur.
//   - Non-finite → returns 0

export function roundToNearestFive(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.ceil(value / 5) * 5;
}

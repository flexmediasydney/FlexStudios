/**
 * packageCeiling.ts — Wave 7 P1-6 (W7.7) consolidation point.
 *
 * Single source of truth for "what's the photo count target for this round".
 * The investigation pre-execution flagged that THREE separate edge functions
 * (shortlisting-ingest, the former shortlisting-pass2 — W11.7.10 sunset, now
 * shortlisting-shape-d — and shortlisting-benchmark-runner) each maintained
 * their own copy of:
 *
 *   const PACKAGE_CEILING_DEFAULTS = { gold: 24, 'day to dusk': 31, premium: 38 };
 *
 * This was wrong on multiple counts:
 *   1. Hardcoded ceilings can't represent à la carte add-ons that change the
 *      deliverable count.
 *   2. Three duplicates means three places to maintain when the price matrix
 *      changes — and three places to drift out of sync.
 *   3. The lowercase string-key match was already brittle (`Gold Package` vs
 *      `Gold` vs `Gold+3`).
 *
 * This module re-exports `computeExpectedFileCount` from packageCounts.ts as
 * THE one place to derive the target. Callers fetch products + project
 * once, call `flattenProjectProducts(project)` → `computeExpectedFileCount(...)`
 * to get { target, min, max }, and write those to the round.
 *
 * Future: when admin UI drops in W8 to override per-tier targets, this module
 * is where the lookup would slot in — keeping every caller pointed at the
 * same import path.
 */

export {
  computeExpectedFileCount,
  flattenProjectProducts,
  type FlatProductEntry,
  type ProductCatalogEntry,
  type ProjectForFlatten,
} from './packageCounts.ts';

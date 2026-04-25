// Shared diff helper for Tonomo product/package deltas.
//
// This module is purposefully pure — it has no Deno imports and takes
// already-fetched reference data (allProducts, allPackages) as arguments
// so it can be exercised in isolation.

export interface ProjectProduct {
  product_id: string;
  quantity?: number;
  name?: string;
  custom_price?: number | null;
  source?: string | null;
  tier_hint?: string | null;
  [key: string]: any;
}

export interface ProjectPackage {
  package_id: string;
  quantity?: number;
  products?: ProjectProduct[];
  name?: string;
  [key: string]: any;
}

export interface ProductRef { id: string; name?: string | null }
export interface PackageRef { id: string; name?: string | null; products?: { product_id: string; quantity?: number }[] }

export interface ProductDiffEntry { product_id: string; product_name: string; quantity?: number }
export interface ProductQtyChange { product_id: string; product_name: string; from: number; to: number }
export interface PackageDiffEntry { package_id: string; package_name: string }
export interface PackageInternalChange {
  package_id: string;
  package_name: string;
  // Per-product qty deltas inside the package's `products` override array.
  // 'from' or 'to' = 0 implies the override was added/removed (the catalog
  // default still applies, but the project's override was changed).
  qty_changes: ProductQtyChange[];
}

export interface ProjectItemsDiff {
  added_products: ProductDiffEntry[];
  removed_products: ProductDiffEntry[];
  qty_changed: ProductQtyChange[];
  added_packages: PackageDiffEntry[];
  removed_packages: PackageDiffEntry[];
  // Same package_id on both sides, but the nested products[] override differs.
  // Surfaces the case where deduplicateProjectItems rolls a standalone qty
  // change (Sales Images 25→30) into a package's nested override — without
  // this, the diff would miss it and reconcile would noop.
  package_internal_changes: PackageInternalChange[];
}

function coerceArray<T>(value: any): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function resolveProductName(productId: string, allProducts: ProductRef[], fallback?: string): string {
  if (fallback) return fallback;
  const match = allProducts.find(p => p.id === productId);
  return match?.name || productId;
}

function resolvePackageName(packageId: string, allPackages: PackageRef[], fallback?: string): string {
  if (fallback) return fallback;
  const match = allPackages.find(p => p.id === packageId);
  return match?.name || packageId;
}

/**
 * Compute a delta between the current project's products/packages and the
 * newly-resolved products/packages from a Tonomo webhook.
 *
 * Returns the diff with human-readable names resolved from allProducts / allPackages.
 */
export function diffProjectPackages(
  currentProducts: any,
  currentPackages: any,
  newProducts: any,
  newPackages: any,
  allProducts: ProductRef[] = [],
  allPackages: PackageRef[] = [],
): ProjectItemsDiff {
  const curProds = coerceArray<ProjectProduct>(currentProducts);
  const curPkgs = coerceArray<ProjectPackage>(currentPackages);
  const nxtProds = coerceArray<ProjectProduct>(newProducts);
  const nxtPkgs = coerceArray<ProjectPackage>(newPackages);

  const curProdMap = new Map<string, ProjectProduct>();
  for (const p of curProds) {
    if (!p?.product_id) continue;
    curProdMap.set(p.product_id, p);
  }
  const nxtProdMap = new Map<string, ProjectProduct>();
  for (const p of nxtProds) {
    if (!p?.product_id) continue;
    nxtProdMap.set(p.product_id, p);
  }

  const curPkgMap = new Map<string, ProjectPackage>();
  for (const p of curPkgs) {
    if (!p?.package_id) continue;
    curPkgMap.set(p.package_id, p);
  }
  const nxtPkgMap = new Map<string, ProjectPackage>();
  for (const p of nxtPkgs) {
    if (!p?.package_id) continue;
    nxtPkgMap.set(p.package_id, p);
  }

  const added_products: ProductDiffEntry[] = [];
  const removed_products: ProductDiffEntry[] = [];
  const qty_changed: ProductQtyChange[] = [];

  for (const [pid, np] of nxtProdMap) {
    const cur = curProdMap.get(pid);
    if (!cur) {
      added_products.push({
        product_id: pid,
        product_name: resolveProductName(pid, allProducts, np.name),
        quantity: np.quantity ?? 1,
      });
    } else {
      const curQty = cur.quantity ?? 1;
      const nxtQty = np.quantity ?? 1;
      if (curQty !== nxtQty) {
        qty_changed.push({
          product_id: pid,
          product_name: resolveProductName(pid, allProducts, np.name || cur.name),
          from: curQty,
          to: nxtQty,
        });
      }
    }
  }

  for (const [pid, cur] of curProdMap) {
    if (!nxtProdMap.has(pid)) {
      removed_products.push({
        product_id: pid,
        product_name: resolveProductName(pid, allProducts, cur.name),
      });
    }
  }

  const added_packages: PackageDiffEntry[] = [];
  const removed_packages: PackageDiffEntry[] = [];
  const package_internal_changes: PackageInternalChange[] = [];

  for (const [pid, np] of nxtPkgMap) {
    if (!curPkgMap.has(pid)) {
      added_packages.push({
        package_id: pid,
        package_name: resolvePackageName(pid, allPackages, np.name),
      });
    } else {
      // Same package on both sides — diff the nested products override array.
      // deduplicateProjectItems rolls standalone qty changes (e.g. Sales Images
      // 25 → 30) into the package's nested override; without this check the
      // top-level diff would noop while real qty data was changing.
      const cur = curPkgMap.get(pid)!;
      const curNested = new Map<string, number>();
      for (const np2 of cur.products || []) {
        if (np2?.product_id) curNested.set(np2.product_id, np2.quantity ?? 1);
      }
      const nxtNested = new Map<string, number>();
      for (const np2 of np.products || []) {
        if (np2?.product_id) nxtNested.set(np2.product_id, np2.quantity ?? 1);
      }
      const qtyChanges: ProductQtyChange[] = [];
      for (const [pid2, nxtQty] of nxtNested) {
        const curQty = curNested.get(pid2);
        if (curQty === undefined) {
          qtyChanges.push({
            product_id: pid2,
            product_name: resolveProductName(pid2, allProducts),
            from: 0,
            to: nxtQty,
          });
        } else if (curQty !== nxtQty) {
          qtyChanges.push({
            product_id: pid2,
            product_name: resolveProductName(pid2, allProducts),
            from: curQty,
            to: nxtQty,
          });
        }
      }
      for (const [pid2, curQty] of curNested) {
        if (!nxtNested.has(pid2)) {
          qtyChanges.push({
            product_id: pid2,
            product_name: resolveProductName(pid2, allProducts),
            from: curQty,
            to: 0,
          });
        }
      }
      if (qtyChanges.length > 0) {
        package_internal_changes.push({
          package_id: pid,
          package_name: resolvePackageName(pid, allPackages, np.name || cur.name),
          qty_changes: qtyChanges,
        });
      }
    }
  }

  for (const [pid, cur] of curPkgMap) {
    if (!nxtPkgMap.has(pid)) {
      removed_packages.push({
        package_id: pid,
        package_name: resolvePackageName(pid, allPackages, cur.name),
      });
    }
  }

  return { added_products, removed_products, qty_changed, added_packages, removed_packages, package_internal_changes };
}

/**
 * True when the diff contains ONLY additions (no removals, no quantity changes).
 * A pure add-only diff is safe to apply even when the user has manually
 * overridden products — the user's edits remain intact.
 */
export function isAddOnly(diff: ProjectItemsDiff): boolean {
  if (!diff) return false;
  if (diff.removed_products?.length > 0) return false;
  if (diff.removed_packages?.length > 0) return false;
  if (diff.qty_changed?.length > 0) return false;
  if (diff.package_internal_changes?.length > 0) return false;
  const hasAdds = (diff.added_products?.length > 0) || (diff.added_packages?.length > 0);
  return hasAdds;
}

/**
 * True when the diff contains no changes at all.
 */
export function isNoOp(diff: ProjectItemsDiff): boolean {
  if (!diff) return true;
  return (
    (diff.added_products?.length ?? 0) === 0 &&
    (diff.removed_products?.length ?? 0) === 0 &&
    (diff.qty_changed?.length ?? 0) === 0 &&
    (diff.added_packages?.length ?? 0) === 0 &&
    (diff.removed_packages?.length ?? 0) === 0 &&
    (diff.package_internal_changes?.length ?? 0) === 0
  );
}

/**
 * Merge a set of additions (products + packages) into the current project arrays.
 * Returns fresh arrays — does not mutate input. Newly-added products/packages
 * carry a `source: 'tonomo_auto_merged'` marker so they can be audited.
 *
 * `addedProductsFromNew` and `addedPackagesFromNew` should already be the
 * detail-rich items from the proposed "after" state (i.e. the Tonomo-resolved
 * products/packages), not just the diff summary — so quantities and other
 * fields carry through.
 */
export function applyDiff(
  currentProducts: any,
  currentPackages: any,
  addedProductsFromNew: ProjectProduct[],
  addedPackagesFromNew: ProjectPackage[],
): { products: ProjectProduct[]; packages: ProjectPackage[] } {
  const curProds = coerceArray<ProjectProduct>(currentProducts);
  const curPkgs = coerceArray<ProjectPackage>(currentPackages);

  const seenProductIds = new Set(curProds.map(p => p.product_id).filter(Boolean));
  const seenPackageIds = new Set(curPkgs.map(p => p.package_id).filter(Boolean));

  const mergedProducts: ProjectProduct[] = [...curProds];
  for (const ap of addedProductsFromNew) {
    if (!ap?.product_id || seenProductIds.has(ap.product_id)) continue;
    mergedProducts.push({ ...ap, source: ap.source || 'tonomo_auto_merged' });
    seenProductIds.add(ap.product_id);
  }

  const mergedPackages: ProjectPackage[] = [...curPkgs];
  for (const ap of addedPackagesFromNew) {
    if (!ap?.package_id || seenPackageIds.has(ap.package_id)) continue;
    mergedPackages.push({ ...ap, source: ap.source || 'tonomo_auto_merged' });
    seenPackageIds.add(ap.package_id);
  }

  return { products: mergedProducts, packages: mergedPackages };
}

/**
 * Given the resolved "after" products/packages array and a diff, extract the
 * full items for each added product_id / package_id. Handlers use this to
 * build the argument to `applyDiff` — the diff only carries IDs + names, but
 * we need the full quantity/tier_hint/source from the resolved items.
 */
export function extractAddedFromNew(
  newProducts: ProjectProduct[],
  newPackages: ProjectPackage[],
  diff: ProjectItemsDiff,
): { addedProducts: ProjectProduct[]; addedPackages: ProjectPackage[] } {
  const addedProductIds = new Set(diff.added_products.map(d => d.product_id));
  const addedPackageIds = new Set(diff.added_packages.map(d => d.package_id));
  const addedProducts = (newProducts || []).filter(p => p?.product_id && addedProductIds.has(p.product_id));
  const addedPackages = (newPackages || []).filter(p => p?.package_id && addedPackageIds.has(p.package_id));
  return { addedProducts, addedPackages };
}

// @ts-ignore test — sanity check the diff helper by hand when Deno is available.
// Run with: deno run diffTonomoProducts.ts --self-test
if (typeof Deno !== 'undefined' && (Deno as any).args?.includes?.('--self-test')) {
  const current = [
    { product_id: 'p-img', quantity: 24 },
    { product_id: 'p-fp', quantity: 1 },
  ];
  const next = [
    { product_id: 'p-img', quantity: 24 },
    { product_id: 'p-fp', quantity: 1 },
    { product_id: 'p-dusk', quantity: 1 },
  ];
  const diff = diffProjectPackages(current, [], next, [], [
    { id: 'p-img', name: 'Images' },
    { id: 'p-fp', name: 'Floorplan' },
    { id: 'p-dusk', name: 'Dusk Images' },
  ], []);
  console.log('diff =', JSON.stringify(diff, null, 2));
  console.log('isAddOnly =', isAddOnly(diff));
  const merged = applyDiff(current, [], diff.added_products.map(d => ({ product_id: d.product_id, quantity: d.quantity })), []);
  console.log('merged =', JSON.stringify(merged, null, 2));
}

/**
 * normalizeProjectItems
 *
 * Pure function — no side effects, no API calls.
 * Called at every save boundary to enforce product/package dedup rules:
 *
 * 1. Remove standalone products whose product_id also appears inside a package
 * 2. Merge duplicate standalone products (same product_id → sum quantities)
 * 3. Remove duplicate packages (same package_id → keep first)
 * 4. Warn (don't block) when standalone and package products share a category
 *
 * @param {Array} products  - standalone products [{ product_id, quantity, ... }]
 * @param {Array} packages  - packages [{ package_id, quantity, products: [...], ... }]
 * @param {Array} allProductMasters - full Product entity list (needs .id, .name, .category)
 * @param {Array} allPackageMasters - full Package entity list (needs .id, .name, .products[])
 * @returns {{ products, packages, removed, warnings }}
 */
export function normalizeProjectItems(products = [], packages = [], allProductMasters = [], allPackageMasters = []) {
  const removed = [];
  const warnings = [];

  // Build a set of ALL product IDs inside packages (using master definitions as source of truth)
  const packageProductIds = new Set();
  const packageProductNames = new Map(); // product_id → { productName, packageName }
  for (const pkg of packages) {
    const master = allPackageMasters.find(m => m.id === pkg.package_id);
    const masterProducts = master?.products || [];
    const storedProducts = pkg.products || [];
    // Union of master template products + stored override products
    const allNestedIds = new Set([
      ...masterProducts.map(p => p.product_id),
      ...storedProducts.map(p => p.product_id),
    ]);
    const pkgName = master?.name || pkg.package_name || 'Package';
    for (const pid of allNestedIds) {
      packageProductIds.add(pid);
      const prod = allProductMasters.find(p => p.id === pid);
      packageProductNames.set(pid, { productName: prod?.name || 'Product', packageName: pkgName });
    }
  }

  // 1. Remove standalone products that overlap with package contents
  const deduped = [];
  for (const item of products) {
    if (packageProductIds.has(item.product_id)) {
      const info = packageProductNames.get(item.product_id);
      removed.push({
        product_id: item.product_id,
        reason: `"${info?.productName}" removed from standalone — already included in "${info?.packageName}"`,
      });
      continue;
    }
    deduped.push(item);
  }

  // 2. Merge duplicate standalone products (same product_id → sum quantities)
  const mergedMap = new Map();
  for (const item of deduped) {
    if (mergedMap.has(item.product_id)) {
      const existing = mergedMap.get(item.product_id);
      existing.quantity = (existing.quantity || 1) + (item.quantity || 1);
    } else {
      mergedMap.set(item.product_id, { ...item });
    }
  }
  const mergedProducts = [...mergedMap.values()];

  // 3. Deduplicate packages (same package_id → keep first)
  const seenPackageIds = new Set();
  const dedupedPackages = [];
  for (const pkg of packages) {
    if (seenPackageIds.has(pkg.package_id)) continue;
    seenPackageIds.add(pkg.package_id);
    dedupedPackages.push(pkg);
  }

  // 4. Category overlap warnings (non-blocking)
  // Build category → products map for standalone items
  const standaloneCategoryMap = new Map(); // category → [{ name, id }]
  for (const item of mergedProducts) {
    const prod = allProductMasters.find(p => p.id === item.product_id);
    if (!prod?.category) continue;
    const cat = prod.category.toLowerCase();
    if (!standaloneCategoryMap.has(cat)) standaloneCategoryMap.set(cat, []);
    standaloneCategoryMap.get(cat).push({ id: prod.id, name: prod.name });
  }

  // Build category → products map for package items
  for (const pkg of dedupedPackages) {
    const master = allPackageMasters.find(m => m.id === pkg.package_id);
    const pkgName = master?.name || 'Package';
    const nestedProducts = master?.products || pkg.products || [];
    for (const np of nestedProducts) {
      const prod = allProductMasters.find(p => p.id === np.product_id);
      if (!prod?.category) continue;
      const cat = prod.category.toLowerCase();
      const standaloneInSameCategory = standaloneCategoryMap.get(cat);
      if (standaloneInSameCategory) {
        for (const sa of standaloneInSameCategory) {
          if (sa.id !== np.product_id) { // Only warn if they're different products
            warnings.push({
              type: 'category_overlap',
              category: cat,
              message: `"${sa.name}" (standalone) and "${prod.name}" (in ${pkgName}) are both ${cat} services — intentional?`,
            });
          }
        }
      }
    }
  }

  // Deduplicate warnings by message
  const uniqueWarnings = [];
  const seenMessages = new Set();
  for (const w of warnings) {
    if (!seenMessages.has(w.message)) {
      seenMessages.add(w.message);
      uniqueWarnings.push(w);
    }
  }

  return {
    products: mergedProducts,
    packages: dedupedPackages,
    removed,
    warnings: uniqueWarnings,
  };
}
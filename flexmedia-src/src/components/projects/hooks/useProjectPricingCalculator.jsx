import { useMemo, memo } from "react";

/**
 * Pure frontend pricing calculator with memoization.
 * Used ONLY when we already have matrix-adjusted prices stored on the project items
 * (i.e. items returned from the calculateProjectPricing backend function).
 * 
 * For fresh recalculation with matrix rules, call the backend function directly.
 */
export function useProjectPricingCalculator(formState, allProducts, allPackages, tierKey) {
  const tier = tierKey === "premium_tier" ? "premium" : "standard";

  // Create Maps for O(1) lookups, memoized to prevent unnecessary recalcs
  const productMap = useMemo(() => 
    new Map(allProducts.map(p => [p.id, p])), 
    [allProducts]
  );

  const packageMap = useMemo(() => 
    new Map(allPackages.map(p => [p.id, p])), 
    [allPackages]
  );

  /**
   * Get effective pricing for a product (memoized).
   * Priority: stored tier pricing on formItem (from backend) → master product pricing
   */
  const getProductPricing = useMemo(() => (formItem, product) => {
    const storedTier = formItem?.[tierKey];
    const storedBasePrice = storedTier?.base_price;
    const storedUnitPrice = storedTier?.unit_price;
    return {
      basePrice: storedBasePrice != null
        ? Math.max(0, Math.ceil((parseFloat(storedBasePrice) || 0) / 5) * 5)
        : Math.max(0, parseFloat(product?.[tierKey]?.base_price) || 0),
      unitPrice: storedUnitPrice != null
        ? Math.max(0, Math.ceil((parseFloat(storedUnitPrice) || 0) / 5) * 5)
        : Math.max(0, parseFloat(product?.[tierKey]?.unit_price) || 0),
    };
  }, [tierKey]);

  /**
   * Get effective pricing for a package (memoized).
   */
  const getPackagePricing = useMemo(() => (formItem, pkg) => {
    const storedTier = formItem?.[`${tier}_tier`] ?? formItem?.[tierKey];
    if (storedTier && typeof storedTier === 'object' && storedTier.package_price != null) {
      return Math.max(0, Math.round(parseFloat(storedTier.package_price) || 0));
    }
    return Math.max(0, parseFloat(pkg?.[tierKey]?.package_price) || 0);
  }, [tier, tierKey]);

  const getProductLineItem = (formItem) => {
    const product = productMap.get(formItem.product_id);
    if (!product) {
      return {
        id: formItem.product_id,
        name: formItem.product_name || "Unknown Product",
        type: "product",
        quantity: formItem.quantity || 1,
        basePrice: 0,
        unitPrice: 0,
        lineTotal: 0,
        valid: false,
      };
    }

    // Use the quantity stored on the formItem (from backend, already clamped to min/max).
    // Only fall back to min_quantity if no quantity is stored at all.
    const quantity = formItem.quantity != null ? formItem.quantity : (product.min_quantity || 1);
    const { basePrice, unitPrice } = getProductPricing(formItem, product);

    const includedQty = Math.max(1, product.min_quantity || 1);
    const extraQty = Math.max(0, quantity - includedQty);

    // For per_unit products: base_price covers min_quantity, unitPrice for extra qty
    // For fixed products: lineTotal = base_price (qty doesn't affect price)
    let lineTotal;
    let extraCost;
    if (product.pricing_type === 'per_unit') {
      // Per-unit: base price covers min_quantity, charge unit price for qty above min
      lineTotal = basePrice + (unitPrice * extraQty);
      extraCost = unitPrice * extraQty;
    } else {
      // Fixed: single price regardless of quantity
      lineTotal = basePrice;
      extraCost = 0;
    }

    return {
      id: product.id,
      name: product.name,
      category: product.category,
      type: "product",
      pricingType: product.pricing_type,
      minQuantity: includedQty,
      maxQuantity: product.max_quantity,
      quantity,
      includedQty,
      extraQty,
      basePrice,
      unitPrice,
      extraCost,
      lineTotal,
      product,
      valid: true,
    };
  };

  const getPackageLineItem = (formItem) => {
    const pkg = packageMap.get(formItem.package_id);
    if (!pkg) {
      return {
        id: formItem.package_id,
        name: formItem.package_name || "Unknown Package",
        type: "package",
        quantity: formItem.quantity || 1,
        basePrice: 0,
        lineTotal: 0,
        products: [],
        valid: false,
      };
    }

    // Package quantity — usually 1 but data model supports multiples
    const quantity = Math.max(1, formItem.quantity || 1);
    const basePackagePrice = getPackagePricing(formItem, pkg);

    // Nested products — per_unit products can have qty above the package-included qty,
    // extra qty is charged at the matrix-adjusted unit price.
    const formProducts = formItem.products || [];
    const products = (pkg.products || []).map(pkgProduct => {
      const productData = productMap.get(pkgProduct.product_id);
      if (!productData) return null;

      const formProduct = formProducts.find(fp => fp.product_id === pkgProduct.product_id);
      // includedQty = what the package definition says is bundled (master default)
      const masterIncludedQty = Math.max(1, pkgProduct.quantity || 1);
      const minQty = Math.max(1, productData.min_quantity || 1);
      const maxQty = productData.max_quantity;

      // User-provided qty, clamped to [master included, max_quantity]
      // If user has saved a custom qty, use that; otherwise use master included qty
      let productQty = formProduct?.quantity != null
        ? formProduct.quantity
        : masterIncludedQty;
      productQty = Math.max(masterIncludedQty, productQty);
      if (maxQty != null) productQty = Math.min(productQty, maxQty);

      // Only charge for extra qty if product is per_unit pricing
      const isPerUnit = productData.pricing_type === 'per_unit';
      const extraQty = isPerUnit ? Math.max(0, productQty - masterIncludedQty) : 0;
      
      // Always use master product pricing for unit price on nested products —
      // nested items stored on project packages never have tier pricing attached.
      const { unitPrice } = getProductPricing(null, productData);
      const extraCost = unitPrice * extraQty;

      return {
        id: productData.id,
        name: productData.name,
        category: productData.category,
        pricingType: productData.pricing_type,
        minQuantity: minQty,
        maxQuantity: maxQty,
        quantity: productQty,
        includedQty: masterIncludedQty,
        extraQty,
        unitPrice,
        lineTotal: extraCost,
        product: productData,
        valid: true,
      };
    }).filter(Boolean);

    const extraProductsTotal = products.reduce((sum, p) => sum + p.lineTotal, 0);
    const lineTotal = (basePackagePrice + extraProductsTotal) * quantity;

    return {
      id: pkg.id,
      name: pkg.name,
      type: "package",
      quantity,
      basePrice: basePackagePrice,
      lineTotal,
      products,
      pkg,
      valid: true,
    };
  };

  const breakdown = useMemo(() => {
    const packageItems = (formState.packages || [])
      .map(item => getPackageLineItem(item))
      .filter(item => item.valid);

    const productItems = (formState.products || [])
      .map(item => getProductLineItem(item))
      .filter(item => item.valid);

    // Round to 2 decimal places to prevent float accumulation drift
    // (e.g. 245.00000000001 from repeated parseFloat * qty additions)
    const subtotal = Math.round(
      (packageItems.reduce((sum, p) => sum + p.lineTotal, 0) +
       productItems.reduce((sum, p) => sum + p.lineTotal, 0)) * 100
    ) / 100;

    return {
      packages: packageItems,
      products: productItems,
      subtotal: Math.max(0, subtotal),
      total: Math.max(0, subtotal),
    };
  }, [formState, productMap, packageMap, tierKey]);

  return { breakdown };
}
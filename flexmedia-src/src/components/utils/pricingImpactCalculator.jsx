/**
 * Calculate estimated price delta from pricing impact changes
 * Handles product additions, removals, and quantity changes
 */
export function calculatePricingDelta(pricingImpact, allProducts = [], pricingTier = 'standard') {
  if (!pricingImpact?.has_impact) return 0;

  let delta = 0;

  // Added products — respect min_quantity and pricing_type
  (pricingImpact.products_added || []).forEach(item => {
    if (item.product_id) {
      const product = allProducts.find(p => p.id === item.product_id);
      if (product) {
        const tier = pricingTier === 'premium' ? product.premium_tier : product.standard_tier;
        const basePrice = Math.max(0, parseFloat(tier?.base_price) || 0);
        const unitPrice = Math.max(0, parseFloat(tier?.unit_price) || 0);
        const qty = item.quantity || 1;
        if (product.pricing_type === 'per_unit') {
          const minQty = Math.max(1, product.min_quantity || 1);
          const extraQty = Math.max(0, qty - minQty);
          delta += basePrice + (unitPrice * extraQty);
        } else {
          delta += basePrice;
        }
      }
    }
  });

  // Removed products (negative impact) — mirrors the add logic for symmetry
  (pricingImpact.products_removed || []).forEach(item => {
    if (item.product_id) {
      const product = allProducts.find(p => p.id === item.product_id);
      if (product) {
        const tier = pricingTier === 'premium' ? product.premium_tier : product.standard_tier;
        const basePrice = Math.max(0, parseFloat(tier?.base_price) || 0);
        const unitPrice = Math.max(0, parseFloat(tier?.unit_price) || 0);
        const oldQty = item.quantity || 1;
        if (product.pricing_type === 'per_unit') {
          const minQty = Math.max(1, product.min_quantity || 1);
          const extraQty = Math.max(0, oldQty - minQty);
          delta -= basePrice + (unitPrice * extraQty);
        } else {
          delta -= basePrice;
        }
      }
    }
  });

  // Quantity changes — only per_unit products have qty-sensitive pricing
  (pricingImpact.quantity_changes || []).forEach(item => {
    if (item.product_id) {
      const product = allProducts.find(p => p.id === item.product_id);
      if (product && product.pricing_type === 'per_unit') {
        const tier = pricingTier === 'premium' ? product.premium_tier : product.standard_tier;
        const unitPrice = Math.max(0, parseFloat(tier?.unit_price) || 0);
        const minQty = Math.max(1, product.min_quantity || 1);
        // Only charge for qty above min_quantity
        const oldChargeable = Math.max(0, (item.old_quantity || 1) - minQty);
        const newChargeable = Math.max(0, (item.new_quantity || 1) - minQty);
        delta += unitPrice * (newChargeable - oldChargeable);
      }
      // Fixed-price products: quantity changes have zero price impact
    }
  });

  return Math.round(delta * 100) / 100;
}

/**
 * Get readable summary of pricing impact changes
 */
export function getPricingImpactSummary(pricingImpact = {}) {
  const adds = (pricingImpact.products_added || []).filter(p => p.product_id).length;
  const removes = (pricingImpact.products_removed || []).filter(p => p.product_id).length;
  const changes = (pricingImpact.quantity_changes || []).filter(p => p.product_id).length;
  
  const parts = [];
  if (adds > 0) parts.push(`+${adds} product${adds !== 1 ? 's' : ''}`);
  if (removes > 0) parts.push(`−${removes} product${removes !== 1 ? 's' : ''}`);
  if (changes > 0) parts.push(`~${changes} qty change${changes !== 1 ? 's' : ''}`);
  
  return parts.join(', ') || 'No changes';
}
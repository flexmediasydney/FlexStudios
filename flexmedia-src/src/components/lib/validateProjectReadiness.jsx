/**
 * validateProjectReadiness
 * 
 * Shared validation logic for both ProjectForm (save gate) and 
 * TonomoTab (approval gate). Pure function — no API calls.
 * 
 * @param project - Project object (from form state or entity)
 * @param allProducts - Full Product entity list (for category lookup)
 * @param allPackages - Full Package entity list (for nested product lookup)
 * @returns { valid, errors, warnings }
 */
export function validateProjectReadiness(project, allProducts = [], allPackages = []) {
  const errors = [];
  const warnings = [];

  // Skip all validation for cancellation confirmations
  if (project.pending_review_type === 'cancellation') {
    return { valid: true, errors: [], warnings: [] };
  }

  // 1. Address required
  if (!project.property_address?.trim()) {
    errors.push('Property address is required');
  }

  // 2. Agent required
  if (!project.agent_id) {
    errors.push('Agent is required');
  }

  // 3. Project owner required
  if (!project.project_owner_id) {
    errors.push('Project owner must be assigned');
  }

  // 3a. Project type required
  if (!project.project_type_id) {
    errors.push('Project type is required');
  }

  // 4. At least one product or package required
  const hasProducts = (project.products?.length || 0) > 0;
  const hasPackages = (project.packages?.length || 0) > 0;
  if (!hasProducts && !hasPackages) {
    errors.push('At least one product or package is required');
  }

  // 5. Pricing tier warning
  if (!project.pricing_tier) {
    warnings.push('Pricing tier not set — will default to Standard');
  }

  // 6–7. Role validation against product categories
  if (hasProducts || hasPackages) {
    const needsPhotographer = projectHasCategory(
      project, allProducts, allPackages,
      ['photography', 'drone', 'virtual_staging']
    );
    const needsVideographer = projectHasCategory(
      project, allProducts, allPackages,
      ['video']
    );

    const hasPhotographer = !!(project.photographer_id || project.onsite_staff_1_id);
    const hasVideographer = !!(project.videographer_id || project.onsite_staff_2_id);

    if (needsPhotographer && !hasPhotographer) {
      errors.push('Photographer required — booking includes photography, drone, or virtual staging services');
    }
    if (needsVideographer && !hasVideographer) {
      errors.push('Videographer required — booking includes video services');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Check whether a project's products/packages include any of the given categories.
 * Handles both standalone products and nested products inside packages.
 */
function projectHasCategory(project, allProducts, allPackages, categories) {
  const cats = categories.map(c => c.toLowerCase());

  const projectProductIds = (project?.products || []).map(p => p.product_id || p);
  const hasDirectProduct = allProducts.some(
    p => projectProductIds.includes(p.id) && cats.includes((p.category || '').toLowerCase())
  );
  if (hasDirectProduct) return true;

  const inlinePackageProductIds = (project?.packages || [])
    .flatMap(pkg => (pkg.products || []).map(pp => pp.product_id))
    .filter(Boolean);
  const hasInlinePackageProduct = allProducts.some(
    p => inlinePackageProductIds.includes(p.id) && cats.includes((p.category || '').toLowerCase())
  );
  if (hasInlinePackageProduct) return true;

  const projectPackageIds = (project?.packages || []).map(p => p.package_id || p);
  return allPackages.some(pkg => {
    if (!projectPackageIds.includes(pkg.id)) return false;
    return (pkg.products || []).some(pp => {
      const prod = allProducts.find(p => p.id === pp.product_id);
      return prod && cats.includes((prod.category || '').toLowerCase());
    });
  });
}
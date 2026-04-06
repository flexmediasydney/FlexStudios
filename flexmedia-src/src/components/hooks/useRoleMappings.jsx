import { useMemo } from "react";
import { useEntityList } from "@/components/hooks/useEntityData";

// Hardcoded fallback — used when RoleCategoryMapping entity has no rows yet
const HARDCODED_DEFAULTS = [
  {
    role: "project_owner",
    label: "Project Owner",
    categories: null,
    always_required: true,
    description: "Assigned to every project regardless of services",
    order: 0,
  },
  {
    role: "photographer",
    label: "Photographer",
    categories: ["photography", "drone", "virtual_staging"],
    always_required: false,
    description: "Required when project includes photography, drone, or virtual staging",
    order: 1,
  },
  {
    role: "videographer",
    label: "Videographer",
    categories: ["video"],
    always_required: false,
    description: "Required when project includes video services",
    order: 2,
  },
  {
    role: "image_editor",
    label: "Image Editor",
    categories: ["photography", "virtual_staging"],
    always_required: false,
    description: "Required when project includes photography or virtual staging",
    order: 3,
  },
  {
    role: "video_editor",
    label: "Video Editor",
    categories: ["video"],
    always_required: false,
    description: "Required when project includes video services",
    order: 4,
  },
  {
    role: "floorplan_editor",
    label: "Floorplan Editor",
    categories: ["floorplan", "editing"],
    always_required: false,
    description: "Required when project includes editing or floorplan services",
    order: 5,
  },
  {
    role: "drone_editor",
    label: "Drone Editor",
    categories: ["drone"],
    always_required: false,
    description: "Required when project includes drone services",
    order: 6,
  },
];

/**
 * Parse the `categories` field from an entity row.
 * Entity stores it as a JSON string; fallback objects already have arrays.
 */
function parseCategories(categories) {
  if (!categories) return null;
  if (Array.isArray(categories)) return categories;
  try {
    return JSON.parse(categories);
  } catch {
    return null;
  }
}

/**
 * Hook: loads role→category mappings from the RoleCategoryMapping entity.
 * Falls back to hardcoded defaults if the entity has no rows.
 */
export function useRoleMappings() {
  const { data: rows = [], loading } = useEntityList("RoleCategoryMapping", "order");

  const mappings = useMemo(() => {
    const activeRows = rows.filter(r => r.is_active !== false);
    if (activeRows.length === 0) return HARDCODED_DEFAULTS;

    // Merge: DB rows take priority; fill in any missing roles from hardcoded defaults
    const dbRoleKeys = new Set(activeRows.map(r => r.role));
    const missingDefaults = HARDCODED_DEFAULTS.filter(d => !dbRoleKeys.has(d.role));

    return [
      ...activeRows.map(row => ({
        ...row,
        categories: parseCategories(row.categories),
      })),
      ...missingDefaults,
    ].sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  }, [rows]);

  const usingFallback = !loading && rows.filter(r => r.is_active !== false).length === 0;

  return { mappings, loading, usingFallback };
}

/**
 * Pure function: check if a project's products/packages include any of the given categories.
 * Case-insensitive. Used by both hooks and validation utilities.
 */
export function projectHasCategoryFromMappings(project, allProducts, allPackages, categories) {
  if (!categories || categories.length === 0) return true;
  const cats = categories.map(c => c.toLowerCase());

  // 1. Standalone products
  const projectProductIds = (project?.products || []).map(p => p.product_id || p);
  if (allProducts.some(p => projectProductIds.includes(p.id) && cats.includes((p.category || '').toLowerCase()))) {
    return true;
  }

  // 2. Products embedded in the project's own package data
  const inlineProductIds = (project?.packages || [])
    .flatMap(pkg => (pkg.products || []).map(pp => pp.product_id))
    .filter(Boolean);
  if (allProducts.some(p => inlineProductIds.includes(p.id) && cats.includes((p.category || '').toLowerCase()))) {
    return true;
  }

  // 3. Fallback: Package entity's own product list
  const projectPackageIds = (project?.packages || []).map(p => p.package_id || p);
  return allPackages.some(pkg => {
    if (!projectPackageIds.includes(pkg.id)) return false;
    return (pkg.products || []).some(pp => {
      const prod = allProducts.find(p => p.id === pp.product_id);
      return prod && cats.includes((prod.category || '').toLowerCase());
    });
  });
}

/**
 * Pure function: determine if a role (mapping row) is required for a given project.
 */
export function isRoleRequiredForProject(mapping, project, allProducts, allPackages) {
  if (mapping.always_required || !mapping.categories) return true;
  if (!project?.products?.length && !project?.packages?.length) return false;
  return projectHasCategoryFromMappings(project, allProducts, allPackages, mapping.categories);
}
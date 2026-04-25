import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

/**
 * useProjectHasDroneWork
 * ──────────────────────
 * Returns { hasDroneWork, isLoading } indicating whether the given project
 * has any drone-type line items in its price matrix (loose products + nested
 * package products) OR an existing drone shoot row. Used to gate the
 * visibility / enablement of the Drones tab on the Project Details page.
 *
 * Investigation findings (2026-04):
 *   - `project_tasks.task_type` is only 'back_office' | 'onsite' — NOT a
 *     reliable drone signal. Tasks don't carry product-type metadata.
 *   - The canonical drone signal is `products.category = 'Drones'`. As of
 *     today exactly one such product exists ("Drone Shots", id ending in
 *     ...025), but we don't hard-code IDs — we query the Drones-category
 *     product set so any future drone product (e.g. "Drone Video") works.
 *   - Project line items live in two jsonb arrays on `projects`:
 *       projects.products[]                 → loose add-ons
 *       projects.packages[].products[]      → denormalized package contents
 *   - Falls back to checking for an existing `drone_shoots` row so that a
 *     project mid-pipeline (where pricing was edited away post-upload) still
 *     surfaces the tab.
 *
 * @param {string} projectId  — project UUID
 * @param {object} project    — already-loaded project row (has .products / .packages)
 * @returns {{ hasDroneWork: boolean, isLoading: boolean }}
 */
export function useProjectHasDroneWork(projectId, project) {
  // 1. Drone-category product IDs (cached app-wide; tiny table, ~30 rows).
  const { data: droneProductIds, isLoading: productsLoading } = useQuery({
    queryKey: ["drone_category_product_ids"],
    queryFn: async () => {
      const rows = await api.entities.Product.filter({ category: "Drones" }, null, 100);
      return new Set((rows || []).map((p) => p.id));
    },
    staleTime: 10 * 60_000, // 10 min — category mappings change rarely
  });

  // 2. Fallback: drone shoots already attached to this project.
  const { data: hasShoots, isLoading: shootsLoading } = useQuery({
    queryKey: ["project_has_drone_shoot", projectId],
    queryFn: async () => {
      if (!projectId) return false;
      try {
        const rows = await api.entities.DroneShoot.filter({ project_id: projectId }, null, 1);
        return (rows || []).length > 0;
      } catch {
        // DroneShoot entity / table may not exist on every env — treat as no shoots.
        return false;
      }
    },
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });

  const isLoading = productsLoading || shootsLoading;

  // Synchronous scan of the already-loaded project's pricing payload.
  // Resolves both loose products and nested package products against the
  // Drones-category set.
  let hasDroneInPricing = false;
  if (droneProductIds && droneProductIds.size > 0 && project) {
    const looseHit = (project.products || []).some(
      (item) => item?.product_id && droneProductIds.has(item.product_id),
    );
    const packageHit = (project.packages || []).some((pkg) =>
      (pkg?.products || []).some(
        (item) => item?.product_id && droneProductIds.has(item.product_id),
      ),
    );
    hasDroneInPricing = looseHit || packageHit;
  }

  return {
    hasDroneWork: Boolean(hasDroneInPricing || hasShoots),
    isLoading,
  };
}

export default useProjectHasDroneWork;

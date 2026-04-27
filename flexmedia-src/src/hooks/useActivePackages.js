import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

/**
 * useActivePackages — Wave 7 P1-11 (frontend)
 * ────────────────────────────────────────────
 * Single source of truth for the live `packages` table in admin UIs.
 *
 * Replaces the hardcoded `["Gold", "Day to Dusk", "Premium"]` arrays that
 * previously littered the FlexStudios shortlisting admin pages. Per Joseph's
 * architectural correction (2026-04-27), packages must NEVER be hardcoded —
 * they live in the `packages` table and admin UIs read them at runtime.
 *
 * Returns:
 *   {
 *     packages: Array<{ id, name, is_active }>,  // sorted by name, is_active=true
 *     names:    string[],                         // convenience: just the names
 *     isLoading, isError, error
 *   }
 *
 * Caching:
 *   - 10 minute staleTime (package definitions change rarely;
 *     marketing-driven, manual edits via Settings → Packages).
 *
 * @returns {{
 *   packages: Array<{id: string, name: string, is_active: boolean}>,
 *   names: string[],
 *   isLoading: boolean,
 *   isError: boolean,
 *   error: unknown,
 * }}
 */
export function useActivePackages() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["active_packages"],
    queryFn: async () => {
      const rows = await api.entities.Package.filter(
        { is_active: true },
        "name",
        500,
      );
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 10 * 60 * 1000, // 10 min
  });

  const packages = data || [];
  const names = packages.map((p) => p.name).filter(Boolean);

  return { packages, names, isLoading, isError, error };
}

export default useActivePackages;

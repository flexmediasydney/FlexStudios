import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

/**
 * Hook to fetch pre-computed dashboard statistics.
 * Returns { data, computed_at, isLoading, isError, error, refetch }.
 * Data is an object keyed by stat_key (e.g. "total_projects", "revenue_mtd").
 * Refreshes every 5 minutes; stats are computed server-side.
 * @returns {{ data: Record<string, any> | undefined, computed_at: string | null, isLoading: boolean, isError: boolean, error: Error | null, refetch: () => void }}
 */
export function useDashboardStats() {
  const query = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const rows = await api.entities.DashboardStat.list("-computed_at", 20);
      const stats = {};
      let latestComputedAt = null;
      for (const row of rows) {
        stats[row.stat_key] = row.stat_value;
        if (row.computed_at && (!latestComputedAt || row.computed_at > latestComputedAt)) {
          latestComputedAt = row.computed_at;
        }
      }
      return { stats, computed_at: latestComputedAt };
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — stats are pre-computed
    refetchInterval: 5 * 60 * 1000,
    retry: 2,
  });

  return {
    data: query.data?.stats,
    computed_at: query.data?.computed_at,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error,
    refetch: query.refetch,
  };
}

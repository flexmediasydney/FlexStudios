import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

export function useDashboardStats() {
  return useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const rows = await api.entities.DashboardStat.list("-computed_at", 20);
      const stats = {};
      for (const row of rows) {
        stats[row.stat_key] = row.stat_value;
      }
      return stats;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes — stats are pre-computed
    refetchInterval: 5 * 60 * 1000,
  });
}

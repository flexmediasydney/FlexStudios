import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";

/**
 * Simple, bulletproof hook for project items management
 * Single responsibility: fetch data and batch update
 */
export function useProjectItemsManager(projectId) {
  const queryClient = useQueryClient();

  const productsQuery = useQuery({
    queryKey: ["products-all"],
    queryFn: () => api.entities.Product.list('-updated_date', 500),
    staleTime: 300000, // Cache for 5 min to minimize DB hits
    gcTime: 600000, // Keep in memory for 10 min for faster re-mounts
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'stale',
  });

  const packagesQuery = useQuery({
    queryKey: ["packages-all"],
    queryFn: () => api.entities.Package.list('-updated_date', 500),
    staleTime: 300000,
    gcTime: 600000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: 'stale',
  });

  const batchUpdateMutation = useMutation({
    mutationFn: async (updateData) => {
      return api.entities.Project.update(projectId, updateData);
    },
    onError: (err) => {
      console.error('Project batch update failed:', err);
      // Callers (ProjectPricingTable, ProjectProductsPackages) catch this via mutateAsync
      // but this ensures React Query marks the mutation as failed
    },
    onSuccess: (updatedProject) => {
      // Invalidate project queries so all views (kanban, list, details) refresh
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      queryClient.invalidateQueries({ queryKey: ["Project"] });
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      // Force immediate refetch to ensure UI sees updated nested product quantities
      queryClient.refetchQueries({ queryKey: ["project", projectId] });
    },
  });

  return {
    products: productsQuery.data || [],
    packages: packagesQuery.data || [],
    isLoading: productsQuery.isLoading || packagesQuery.isLoading,
    error: productsQuery.error || packagesQuery.error,
    batchUpdate: batchUpdateMutation,
  };
}
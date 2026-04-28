import { refetchEntityList } from '@/components/hooks/useEntityData';

/**
 * Centralized project cache invalidation.
 * Busts BOTH React Query cache and useEntityData module-level cache.
 */
export function invalidateProjectCaches(queryClient, { timeLogs = false, tasks = false, project = false, effort = false, all = false } = {}) {
  if (all || timeLogs) {
    refetchEntityList("TaskTimeLog");
    queryClient?.invalidateQueries({ queryKey: ['time-logs'] });
  }
  if (all || tasks) {
    refetchEntityList("ProjectTask");
    queryClient?.invalidateQueries({ queryKey: ['project-tasks'] });
    // ProjectDetails + TaskManagement now use a project-scoped query.
    queryClient?.invalidateQueries({ queryKey: ['project-tasks-scoped'] });
  }
  if (all || project) {
    refetchEntityList("Project");
    queryClient?.invalidateQueries({ queryKey: ['project'] });
  }
  if (all || effort) {
    queryClient?.invalidateQueries({ queryKey: ['project-effort'] });
    queryClient?.invalidateQueries({ queryKey: ['effort'] });
  }
}

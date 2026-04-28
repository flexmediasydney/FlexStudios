/**
 * Debounced wrapper for calculateProjectTaskDeadlines to prevent rate limiting.
 * Multiple calls within the debounce window are coalesced into one.
 */
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";
import { queryClientInstance } from "@/components/lib/query-client";

const pendingTimers = new Map(); // project_id -> timeout handle

/**
 * Schedule a deadline recalculation for a project, debounced per project_id.
 * After the server updates is_blocked/due_date, refetches tasks so the UI reflects changes.
 * @param {string} projectId
 * @param {string} triggerEvent
 * @param {number} delayMs - debounce window in ms (default 1000)
 */
export function scheduleDeadlineSync(projectId, triggerEvent = "manual", delayMs = 1000) {
  if (!projectId) return;

  // Clear any pending call for this project
  if (pendingTimers.has(projectId)) {
    clearTimeout(pendingTimers.get(projectId));
  }

  const timer = setTimeout(async () => {
    pendingTimers.delete(projectId);
    try {
      await api.functions.invoke("calculateProjectTaskDeadlines", {
        project_id: projectId,
        trigger_event: triggerEvent,
      });
      // Refresh both caches so is_blocked / due_date changes appear:
      //   - global ProjectTask cache (used by dashboards, Tasks page, etc.)
      //   - project-scoped TanStack query (used by ProjectDetails / TaskManagement)
      refetchEntityList("ProjectTask");
      // Prefix match — covers any sort order this project's hook is using.
      queryClientInstance.invalidateQueries({ queryKey: ['project-tasks-scoped', projectId] });
    } catch (err) {
      console.warn(`[deadlineSync] Skipped (${projectId}):`, err?.message || err);
    }
  }, delayMs);

  pendingTimers.set(projectId, timer);
}
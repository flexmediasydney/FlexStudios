/**
 * Debounced wrapper for calculateProjectTaskDeadlines to prevent rate limiting.
 * Multiple calls within the debounce window are coalesced into one.
 */
import { api } from "@/api/supabaseClient";
import { refetchEntityList } from "@/components/hooks/useEntityData";

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
      // Refetch tasks so is_blocked changes show in the UI immediately
      refetchEntityList("ProjectTask");
    } catch (err) {
      console.warn(`[deadlineSync] Skipped (${projectId}):`, err?.message || err);
    }
  }, delayMs);

  pendingTimers.set(projectId, timer);
}
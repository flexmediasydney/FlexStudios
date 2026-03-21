/**
 * Debounced wrapper for calculateProjectTaskDeadlines to prevent rate limiting.
 * Multiple calls within the debounce window are coalesced into one.
 */
import { api } from "@/api/supabaseClient";

const pendingTimers = new Map(); // project_id -> timeout handle

/**
 * Schedule a deadline recalculation for a project, debounced per project_id.
 * @param {string} projectId
 * @param {string} triggerEvent
 * @param {number} delayMs - debounce window in ms (default 2000)
 */
export function scheduleDeadlineSync(projectId, triggerEvent = "manual", delayMs = 2000) {
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
    } catch (err) {
      // Silently swallow rate limit and other transient errors
      console.warn(`[deadlineSync] Skipped (${projectId}):`, err?.message || err);
    }
  }, delayMs);

  pendingTimers.set(projectId, timer);
}
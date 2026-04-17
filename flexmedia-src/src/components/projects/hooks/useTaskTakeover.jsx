import { useState, useCallback } from "react";
import { api } from "@/api/supabaseClient";

/**
 * Task takeover helper for completion flows.
 *
 * When a user tries to complete a task they don't own (assigned to another
 * user, or assigned to a team), the flow should be:
 *   1. requestTakeover(task, currentUser, onApproved) — check if takeover needed
 *   2. If not needed: onApproved() fires immediately
 *   3. If needed: a dialog prompts the user via <TaskTakeoverDialog />
 *   4. On approve: ownership is transferred, task_owner_changed activity logged,
 *      then onApproved() fires so the caller can continue with its completion body
 *   5. On cancel: onApproved does NOT fire; the completion is aborted
 *
 * Returns:
 *   - pendingTakeover: { task, currentUser, kind: "team" | "individual" } | null
 *   - requestTakeover(task, currentUser, onApproved)
 *   - approveTakeover(): transfers ownership + logs activity, then resolves onApproved
 *   - cancelTakeover(): clears pending state without firing onApproved
 */
export function useTaskTakeover() {
  const [pendingTakeover, setPendingTakeover] = useState(null);
  // Store callback in a ref-like state slot so re-renders don't strip it
  const [onApprovedCallback, setOnApprovedCallback] = useState(null);

  const requestTakeover = useCallback((task, currentUser, onApproved) => {
    if (!task || !currentUser) {
      if (onApproved) onApproved();
      return;
    }
    const isTeamAssigned = !!task.assigned_to_team_id && !task.assigned_to;
    const isOtherUserAssigned = !!task.assigned_to && task.assigned_to !== currentUser.id;
    if (!isTeamAssigned && !isOtherUserAssigned) {
      if (onApproved) onApproved();
      return;
    }
    setPendingTakeover({ task, currentUser, kind: isTeamAssigned ? "team" : "individual" });
    // Wrap in a factory fn so React stores the callback reference, not invokes it
    setOnApprovedCallback(() => onApproved || null);
  }, []);

  const approveTakeover = useCallback(async () => {
    if (!pendingTakeover) return;
    const { task, currentUser } = pendingTakeover;
    const previousOwner =
      task.assigned_to_name || task.assigned_to_team_name || "unassigned";
    try {
      await api.entities.ProjectTask.update(task.id, {
        assigned_to: currentUser.id,
        assigned_to_name: currentUser.full_name || currentUser.email,
        assigned_to_team_id: null,
        assigned_to_team_name: null,
      });
      // Audit: task ownership transfer. Non-fatal if activity log fails.
      api.entities.ProjectActivity.create({
        project_id: task.project_id,
        project_title: task.project_title || "",
        action: "task_owner_changed",
        description: `${currentUser.full_name || currentUser.email} took over "${task.title}" (previously assigned to ${previousOwner})`,
        user_name: currentUser.full_name || currentUser.email,
        user_email: currentUser.email,
        actor_type: "user",
      }).catch(() => {});
      if (onApprovedCallback) {
        try { onApprovedCallback(); } catch (err) { console.warn("[takeover] onApproved threw:", err?.message); }
      }
    } catch (err) {
      console.error("[takeover] failed to transfer ownership:", err);
      // Don't fire onApproved if ownership transfer failed — caller's completion
      // body would silently run against stale ownership state.
    } finally {
      setPendingTakeover(null);
      setOnApprovedCallback(null);
    }
  }, [pendingTakeover, onApprovedCallback]);

  const cancelTakeover = useCallback(() => {
    setPendingTakeover(null);
    setOnApprovedCallback(null);
  }, []);

  return { pendingTakeover, requestTakeover, approveTakeover, cancelTakeover };
}

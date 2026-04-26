/**
 * droneShootStatus.ts — Wave 14 Stream 3
 * ────────────────────────────────────────────────────────────────────
 * Unified helper for advancing drone_shoots.status with a consistent
 * audit log on failure.
 *
 * QC iter 6 Stream A noted four sites in drone-render + drone-render-edited
 * duplicating the same shoot-status update pattern; two of them previously
 * swallowed the UPDATE error silently, leaving the shoot stuck (eg. at
 * 'rendering' after a successful run) with no surfaced reason. This helper
 * standardises the pattern so silent UPDATE failures become visible in the
 * function logs with the originating site's name + the reason for the move.
 *
 * Status values (from drone_shoots.status check constraint):
 *   ingested → analysing → sfm_complete → rendering → render_failed
 *   → proposed_ready → adjustments_ready → final_ready → delivered
 *
 * The optional `allowedFromStatuses` guard is for the "flip to rendering"
 * call sites that intentionally no-op when the shoot is already in a
 * terminal state — they pass the list of source statuses that may legally
 * transition to the target.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface UpdateShootStatusContext {
  /** Calling Edge Function name (eg. 'drone-render', 'drone-render-edited'). */
  generator: string;
  /** Short tag explaining why the move happened (eg. 'render_complete'). */
  reason: string;
}

export interface UpdateShootStatusOptions {
  /**
   * Optional source-status guard. When provided the UPDATE is filtered with
   * `.in('status', allowedFromStatuses)` so the move is a no-op when the
   * shoot is already past the allowed source set. Used by the "flip to
   * rendering" sites that don't want to pull a shoot back from a terminal
   * state.
   */
  allowedFromStatuses?: string[];
}

/**
 * Roll drone_shoots.status forward to `newStatus` for `shootId`.
 *
 * Returns `true` on a successful UPDATE (or no-op when the optional source
 * guard didn't match), `false` when supabase-js returned an error. The
 * helper logs to console.warn on error with the calling generator + reason
 * so silent failures are no longer silent.
 */
export async function updateShootStatus(
  admin: SupabaseClient,
  shootId: string,
  newStatus: string,
  context: UpdateShootStatusContext,
  options?: UpdateShootStatusOptions,
): Promise<boolean> {
  let q = admin
    .from("drone_shoots")
    .update({ status: newStatus })
    .eq("id", shootId);
  if (options?.allowedFromStatuses && options.allowedFromStatuses.length > 0) {
    q = q.in("status", options.allowedFromStatuses);
  }
  const { error } = await q;
  if (error) {
    console.warn(
      `[${context.generator}] updateShootStatus to '${newStatus}' failed for shoot ${shootId} (${context.reason}): ${error.message}`,
    );
    return false;
  }
  return true;
}

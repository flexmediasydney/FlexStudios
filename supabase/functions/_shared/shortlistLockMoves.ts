/**
 * shortlistLockMoves.ts — pure helpers for the shortlist-lock async batch flow.
 *
 * Wave 7 P0-1: extracted from the old monolithic shortlist-lock so the
 * move-list construction (deterministic) is independently testable.
 *
 * The old function did per-file /files/move_v2 in a 6-worker concurrent loop,
 * which timed out at the 150s edge gateway window for >50-file rounds. The
 * rewrite submits ALL moves in one /files/move_batch_v2 async call. Both
 * paths use the same move-spec builder; only the I/O changes.
 */

export interface CompositionGroupForLock {
  id: string;
  files_in_group: string[] | null;
  // Audit defect #19: Pass 0 stores files_in_group as STEMS (no extension).
  // We carry exif_metadata so we can derive the actual filename
  // (e.g. IMG_5620.CR3) from exif_metadata[stem].fileName when constructing
  // Dropbox source/dest paths.
  // deno-lint-ignore no-explicit-any
  exif_metadata: Record<string, any> | null;
}

export interface MoveSpec {
  /** UUID of the source composition group — useful for error attribution. */
  group_id: string;
  /** Dropbox stem (or full filename) used for matching across runs. */
  stem: string;
  /** Resolved source path (`<sourceDest>/<filename>`). */
  from_path: string;
  /** Resolved destination path (`<approvedDest|rejectedDest>/<basename>`). */
  to_path: string;
  /** Which bucket this move belongs to — drives the per-bucket counts. */
  bucket: 'approved' | 'rejected';
  /** Idempotency: source already lives at the destination. Skip without API call. */
  already_at_destination: boolean;
}

/**
 * Resolve a stem (no extension) to a full filename.
 *
 * Audit defect #19: Pass 0 writes files_in_group as STEMS like 'IMG_5620'.
 * The actual Dropbox file is 'IMG_5620.CR3'. Pass 0 also stores per-stem
 * exif_metadata where exif_metadata[stem].fileName is the full filename
 * with extension. Fall back to `${stem}.CR3` if the map lookup fails
 * (Canon RAW is the dominant path through this codebase).
 */
export function resolveFullFilename(
  stem: string,
  // deno-lint-ignore no-explicit-any
  exifMetadata: Record<string, any> | null,
): string {
  if (stem.includes('.')) return stem; // already has an extension — pass through
  const meta = exifMetadata?.[stem];
  const fname = meta?.fileName;
  if (typeof fname === 'string' && fname.length > 0) return fname;
  return `${stem}.CR3`;
}

/**
 * Build the deterministic move list for a lock.
 *
 * Inputs:
 *   - groups: the composition groups in the round (with files_in_group + exif_metadata)
 *   - approvedSet: group_ids destined for the Final Shortlist folder
 *   - rejectedSet: group_ids destined for the Rejected folder
 *   - sourceDest: the source folder (Photos/Raws/Shortlist Proposed/)
 *   - approvedDest, rejectedDest: destination folders
 *
 * Output: one MoveSpec per file. Ordering is stable: groups sorted by id,
 * files preserved in their files_in_group order. The stable order matters
 * for two reasons:
 *   1. Re-running the lock (idempotent retry) submits identical entries to
 *      Dropbox, which lets the server-side dedupe catch in-flight duplicates.
 *   2. The errors_sample we persist on shortlisting_lock_progress is
 *      deterministic — the operator looking at it on retry sees the same
 *      first 20 failures, not a permuted view.
 *
 * Idempotent skips: when a source path already starts with the destination
 * folder (because a prior partial run already moved it), we set
 * already_at_destination=true so the caller can omit it from the batch.
 */
export function buildMoveSpecs(
  groups: CompositionGroupForLock[],
  approvedSet: Set<string>,
  rejectedSet: Set<string>,
  sourceDest: string,
  approvedDest: string,
  rejectedDest: string,
): MoveSpec[] {
  const sourcePrefix = sourceDest.replace(/\/+$/, '') + '/';
  const approvedPrefix = approvedDest.replace(/\/+$/, '') + '/';
  const rejectedPrefix = rejectedDest.replace(/\/+$/, '') + '/';

  const sortedGroups = [...groups].sort((a, b) => a.id.localeCompare(b.id));
  const out: MoveSpec[] = [];

  for (const g of sortedGroups) {
    const files = g.files_in_group || [];
    if (files.length === 0) continue;
    let bucket: 'approved' | 'rejected' | null = null;
    let destPrefix: string | null = null;
    if (approvedSet.has(g.id)) {
      bucket = 'approved';
      destPrefix = approvedPrefix;
    } else if (rejectedSet.has(g.id)) {
      bucket = 'rejected';
      destPrefix = rejectedPrefix;
    }
    if (!bucket || !destPrefix) continue; // undecided → leave alone

    for (const stem of files) {
      if (!stem) continue;
      // Defensive: if a caller ever passes a full path, honour it; otherwise
      // resolve stem → full filename via exif_metadata (defect #19).
      const looksLikePath = stem.startsWith('/');
      const filename = looksLikePath ? stem : resolveFullFilename(stem, g.exif_metadata);
      const sourcePath = looksLikePath ? stem : `${sourcePrefix}${filename}`;
      const baseName = filename.split('/').pop() || filename;
      const destPath = `${destPrefix}${baseName}`;

      const already_at_destination = sourcePath
        .toLowerCase()
        .startsWith(destPrefix.toLowerCase());

      out.push({
        group_id: g.id,
        stem,
        from_path: sourcePath,
        to_path: destPath,
        bucket,
        already_at_destination,
      });
    }
  }

  return out;
}

/**
 * Compute approved + rejected sets from raw inputs (events + overrides + classifications).
 *
 * Mirrors the resolution rule from the old shortlist-lock body and the
 * swimlane's column logic:
 *
 *   Initial AI shortlist set =
 *     groups with a `pass2_slot_assigned` rank=1 event OR a
 *     `pass2_phase3_recommendation` event.
 *
 *   Apply overrides on top:
 *     human_action='approved_as_proposed' → keep in approved set
 *     human_action='added_from_rejects'   → add to approved set
 *     human_action='removed'              → remove from approved set
 *     human_action='swapped'              → human_selected_group_id replaces
 *                                            ai_proposed_group_id in the set
 *
 *   Approved = final approved set
 *   Rejected = (groups with classification.is_near_duplicate_candidate=TRUE)
 *              UNION (groups removed by human override)
 *              MINUS approved (approval wins on conflict)
 */

export interface SlotEventForLock {
  group_id: string | null;
  event_type: string;
  payload: { rank?: number; phase?: number; slot_id?: string; stem?: string } | null;
}

export interface OverrideForLock {
  ai_proposed_group_id: string | null;
  human_selected_group_id: string | null;
  human_action: string;
}

export interface ClassificationForLock {
  group_id: string;
  is_near_duplicate_candidate: boolean | null;
}

export function computeApprovedRejectedSets(
  slotEvents: SlotEventForLock[],
  overrides: OverrideForLock[],
  classifications: ClassificationForLock[],
): { approvedSet: Set<string>; rejectedSet: Set<string> } {
  const aiShortlistSet = new Set<string>();
  for (const ev of slotEvents) {
    if (!ev.group_id) continue;
    if (ev.event_type === 'pass2_phase3_recommendation') {
      aiShortlistSet.add(ev.group_id);
    } else if (ev.event_type === 'pass2_slot_assigned') {
      const rank = ev.payload?.rank;
      if (rank === 1 || rank === undefined) aiShortlistSet.add(ev.group_id);
    }
  }

  const approvedSet = new Set(aiShortlistSet);
  const explicitlyRemoved = new Set<string>();

  for (const ov of overrides) {
    const aiId = ov.ai_proposed_group_id;
    const humanId = ov.human_selected_group_id;
    switch (ov.human_action) {
      case 'ai_proposed':
        // Shape D / editorial-engine seed row written by Stage 4 — treat
        // the AI pick as default-approved so Shape D rounds don't end up
        // with an empty approvedSet when the operator hasn't touched
        // every card. Idempotent with approved_as_proposed below.
        if (aiId) approvedSet.add(aiId);
        break;
      case 'approved_as_proposed':
        if (aiId) approvedSet.add(aiId);
        break;
      case 'added_from_rejects':
        if (humanId) {
          approvedSet.add(humanId);
          explicitlyRemoved.delete(humanId);
        }
        break;
      case 'removed':
        if (aiId) {
          approvedSet.delete(aiId);
          explicitlyRemoved.add(aiId);
        }
        break;
      case 'swapped':
        if (aiId) {
          approvedSet.delete(aiId);
          explicitlyRemoved.add(aiId);
        }
        if (humanId) {
          approvedSet.add(humanId);
          explicitlyRemoved.delete(humanId);
        }
        break;
      case 'reverted_to_ai_proposed':
        // 2026-05-04: operator dragged the card back to PROPOSED after a
        // prior approve/reject. Restores the AI's choice and clears any
        // earlier "explicitly removed" flag so the rejection-reasons
        // pipeline doesn't pick this group up as a negative training
        // signal. Net effect at lock time: same as a fresh ai_proposed
        // row.
        if (aiId) {
          approvedSet.add(aiId);
          explicitlyRemoved.delete(aiId);
        }
        break;
    }
  }

  const rejectedSet = new Set<string>();
  for (const c of classifications) {
    if (c.is_near_duplicate_candidate && !approvedSet.has(c.group_id)) {
      rejectedSet.add(c.group_id);
    }
  }
  for (const gid of explicitlyRemoved) {
    if (!approvedSet.has(gid)) rejectedSet.add(gid);
  }

  return { approvedSet, rejectedSet };
}

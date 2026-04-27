/**
 * manualModeResolver.ts — pure helpers for the W7.13 manual-mode shortlisting
 * trigger detection + manual-lock approved-stem resolution.
 *
 * Wave 7 P1-19 (W7.13): the shortlisting subtab forks into manual mode for
 * project types where AI shortlisting doesn't apply. Two triggers fire it:
 *
 *   1. project_types.shortlisting_supported = false
 *      → reason = 'project_type_unsupported'
 *
 *   2. computeExpectedFileCount(...).target === 0
 *      → reason = 'no_photo_products'
 *
 * When triggered:
 *   - shortlisting-ingest creates a synthetic shortlisting_rounds row with
 *     status='manual' + manual_mode_reason set; no Pass 0 jobs are enqueued
 *   - the frontend renders ManualShortlistingSwimlane (no Pass 0/1/2/3 UI)
 *   - shortlist-lock(mode='manual') receives the operator-curated approved
 *     set as filename stems and resolves them to move_batch_v2 entries against
 *     the actual Dropbox source folder
 *
 * Both helpers are pure (no DB / Dropbox / edge-runtime) so they can be tested
 * directly without mocking — the main code paths fetch the inputs and feed
 * them in.
 */

// ─── Trigger #1 + #2 — manual-mode reason resolution ─────────────────────────

/**
 * Reasons a round runs in manual mode. The string literal is also persisted to
 * `shortlisting_rounds.manual_mode_reason` so dashboards can surface
 * manual-mode rounds separately from engine rounds.
 */
export type ManualModeReason =
  | 'project_type_unsupported'
  | 'no_photo_products';

export interface ResolveManualModeReasonInput {
  /**
   * The project's `project_types.shortlisting_supported` flag. Defaults to
   * `true` when the project has no project_type or the lookup failed (manual
   * mode opts the project IN; we don't want a transient FK lookup miss to
   * silently switch a real engine round to manual).
   */
  shortlistingSupported: boolean;
  /**
   * The dynamic photo count target — `computeExpectedFileCount(...).target`.
   * Zero indicates the project's products contain no engine_role='photo_*'
   * entries (e.g. floorplan-only or video-only project) and the engine has
   * nothing to shortlist.
   */
  expectedCountTarget: number;
}

/**
 * Resolve whether a project should run in manual mode and why.
 *
 * Trigger #1 takes precedence over #2 — if the project type is explicitly
 * unsupported, the reason is structural, not a count artefact. This matters
 * for downstream surfacing: an admin looking at a manual round labeled
 * 'project_type_unsupported' knows the toggle is the lever to flip; a round
 * labeled 'no_photo_products' would suggest the price matrix is the lever.
 *
 * Returns null when neither trigger fires — caller continues with the engine
 * path (Pass 0/1/2/3).
 */
export function resolveManualModeReason(
  input: ResolveManualModeReasonInput,
): ManualModeReason | null {
  if (!input.shortlistingSupported) return 'project_type_unsupported';
  if (input.expectedCountTarget === 0) return 'no_photo_products';
  return null;
}

// ─── Manual-lock approved-stem resolution ────────────────────────────────────

/**
 * A Dropbox file as returned by `listDropboxFiles` / `listFolder`. Manual
 * mode lists everything in `Photos/Raws/Shortlist Proposed/` and the operator
 * drag-and-drops the cards they want into the approved column. The approved
 * set is sent back as filename stems (no extension) — this resolver matches
 * each stem to the actual file in Dropbox so move_batch_v2 has the full
 * source path.
 */
export interface ManualLockSourceFile {
  /** Full Dropbox path (`/Acme/Photos/Raws/Shortlist Proposed/IMG_1.jpg`). */
  path: string;
  /** Filename only (`IMG_1.jpg`) — used to derive the destination basename. */
  name: string;
}

/**
 * One move entry to feed Dropbox /files/move_batch_v2. Mirrors
 * `MoveSpec` from shortlistLockMoves.ts but slimmer — manual mode has no
 * group_id / bucket / idempotency tracking; the operator's drag-result is
 * already the final approved set.
 */
export interface ManualMoveEntry {
  from_path: string;
  to_path: string;
  /** The matched stem — caller passes through to telemetry. */
  stem: string;
  /** True when the source file already lives at the destination (idempotent). */
  already_at_destination: boolean;
}

/**
 * Result of resolving an approved-stem set against the listed Dropbox files.
 *
 * `entries` is what shortlist-lock submits to Dropbox.
 * `unmatchedStems` lets the caller surface a 400 ("operator-supplied stem
 * doesn't exist in the source folder") rather than silently skip a file the
 * operator thought they approved.
 */
export interface ResolveManualLockMovesResult {
  entries: ManualMoveEntry[];
  unmatchedStems: string[];
}

/**
 * Strip the file extension from a filename.
 *
 * Manual mode uses stems (no extension) as the wire-format approved-set
 * identifier — same convention as engine mode's `composition_groups.files_in_group`.
 * This matches behaviour with `shortlistLockMoves.resolveFullFilename` which
 * treats a stem as "everything before the last dot, if any" — keeps the two
 * paths in lockstep.
 */
function stripExtension(filename: string): string {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx <= 0) return filename;
  return filename.slice(0, dotIdx);
}

/**
 * Resolve the operator-supplied approved-stem set against the Dropbox file
 * list, producing the move_batch_v2 entries.
 *
 * Inputs:
 *   - approvedStems: filenames (with or without extension) the operator
 *     dragged into the approved column
 *   - sourceFiles: every file currently in the `Photos/Raws/Shortlist Proposed/`
 *     folder for the project (from listDropboxFiles at lock time)
 *   - approvedDest: full path to `Photos/Raws/Final Shortlist/`
 *
 * Match rule: case-insensitive on the stem (Dropbox is case-insensitive on
 * macOS-style mounts). A stem with a dot is interpreted as a full filename
 * and matched against the file's basename instead of stem-only — this lets
 * operators paste in "IMG_1.jpg" and get the right behaviour.
 *
 * Idempotency: a source file whose path already starts with the destination
 * folder is flagged `already_at_destination=true` so the caller can omit it
 * from the batch (matches engine-mode lock behaviour).
 *
 * Determinism: entries are sorted by stem so re-runs of an interrupted lock
 * submit identical batch payloads to Dropbox (server-side dedupe catches
 * in-flight duplicates more cleanly).
 */
export function resolveManualLockMoves(
  approvedStems: string[],
  sourceFiles: ManualLockSourceFile[],
  approvedDest: string,
): ResolveManualLockMovesResult {
  // Build a stem→file index for O(1) lookups. Lower-case the key to match
  // Dropbox's case-insensitive semantics.
  const fileByStem = new Map<string, ManualLockSourceFile>();
  const fileByName = new Map<string, ManualLockSourceFile>();
  for (const f of sourceFiles) {
    fileByStem.set(stripExtension(f.name).toLowerCase(), f);
    fileByName.set(f.name.toLowerCase(), f);
  }

  const destPrefix = approvedDest.replace(/\/+$/, '') + '/';
  const entries: ManualMoveEntry[] = [];
  const unmatchedStems: string[] = [];

  // De-dupe approved stems — same operator drag-drop can land twice if the
  // UI fires the click handler twice (we've seen this on flaky touchpads).
  const seenStems = new Set<string>();

  for (const rawStem of approvedStems) {
    const stem = (rawStem ?? '').trim();
    if (!stem) continue;
    const dedupKey = stem.toLowerCase();
    if (seenStems.has(dedupKey)) continue;
    seenStems.add(dedupKey);

    // Stems with a dot → match against full filename. Stems without →
    // match against stripped basename. Caller can pass either.
    const looksLikeFullName = stem.includes('.');
    const file = looksLikeFullName
      ? fileByName.get(stem.toLowerCase())
      : fileByStem.get(stem.toLowerCase());

    if (!file) {
      unmatchedStems.push(stem);
      continue;
    }

    const destPath = `${destPrefix}${file.name}`;
    const already_at_destination = file.path.toLowerCase().startsWith(destPrefix.toLowerCase());

    entries.push({
      from_path: file.path,
      to_path: destPath,
      stem,
      already_at_destination,
    });
  }

  // Determinism: sort by stem (lexicographic, case-insensitive).
  entries.sort((a, b) => a.stem.toLowerCase().localeCompare(b.stem.toLowerCase()));

  return { entries, unmatchedStems };
}

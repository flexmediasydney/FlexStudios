/**
 * auditJsonBuilder.ts — pure builder for the W7.4 shortlist-lock audit JSON
 * mirror.
 *
 * Wave 7 P1-12 (W7.4): every successful shortlist-lock writes a JSON file to
 * `<dropbox_root_path>/Photos/_AUDIT/round_<N>_locked_<ISO8601>.json`. The
 * file is a tamper-evident, self-contained snapshot of "what did this round
 * become" — survives even if the DB is wiped (Dropbox holds 180-day version
 * history on the team plan).
 *
 * Per the W7.4 design spec resolutions (orchestrator, 2026-04-27):
 *   - One JSON per LOCK event (multiple files if a round is unlocked + relocked
 *     via P0-1's resume flow). Path stamps the ISO timestamp so each lock
 *     attempt has its own file.
 *   - Schema includes `approved` + `rejected` group entries with file_stems,
 *     scores, and slot bindings for traceability.
 *   - Overrides verbatim (every human action) — makes the file the canonical
 *     "what happened in this round" record without needing the DB.
 *   - schema_version: '1.0' for forward compat.
 *
 * Decoupled from DB / Dropbox / edge-runtime APIs: this module is a pure
 * function-of-inputs so it can be tested without mocking. The lock function
 * fetches the inputs and feeds them in.
 */

// ─── Public types ────────────────────────────────────────────────────────────

/**
 * Round-level fields the audit JSON needs. Read once at the top of the lock
 * function from `shortlisting_rounds`.
 *
 * `engine_version` and `tier_used` are nullable — the canonical
 * `shortlisting_rounds` schema (mig 282) does NOT include these columns today;
 * we tolerate them being absent and emit `null` so the JSON shape stays stable
 * if/when they're added later.
 */
export interface AuditRoundInfo {
  round_id: string;
  round_number: number;
  project_id: string;
  package_type: string | null;
  locked_at: string;          // ISO 8601 (canonical lock timestamp)
  locked_by_user_id: string | null;
  engine_version: string | null;
  tier_used: string | null;
}

/**
 * Per-group context for an APPROVED entry. The lock function joins
 * composition_groups + composition_classifications + pass2_slot_assigned
 * events to build this.
 */
export interface AuditApprovedInput {
  group_id: string;
  slot_id: string | null;
  score: number | null;            // combined_score from classification
  ai_proposed_score: number | null; // ai_proposed_score from override (if any)
  file_stems: string[];            // composition_groups.files_in_group
}

export type AuditRejectedReason =
  | 'human_action=removed'
  | 'near_duplicate'
  | string; // forward-compat for future reasons

/**
 * Per-group context for a REJECTED entry.
 */
export interface AuditRejectedInput {
  group_id: string;
  file_stems: string[];
  reason: AuditRejectedReason;
}

/**
 * A `shortlisting_overrides` row, verbatim. The lock function reads the full
 * row set and passes each row through unchanged — the audit JSON includes the
 * fields that drive the lock decision (human_action, ai_proposed_*,
 * human_selected_*, client_sequence, actor_user_id, created_at) plus any
 * extras for forward compat.
 *
 * `actor_user_id` is included in the schema for forward compat. The current
 * mig 285 schema does NOT have an `actor_user_id` column on
 * shortlisting_overrides — pass `null` for this field today; orchestrator
 * resolution flagged this gap.
 */
export interface AuditOverrideRow {
  human_action: string;
  ai_proposed_group_id: string | null;
  ai_proposed_slot_id: string | null;
  human_selected_group_id: string | null;
  human_selected_slot_id: string | null;
  client_sequence: number | null;
  actor_user_id: string | null;
  created_at: string;
  // Forward-compat: any other override fields the caller wants to preserve.
  [key: string]: unknown;
}

/**
 * Full set of inputs for the audit JSON builder.
 */
export interface AuditJsonInput {
  round: AuditRoundInfo;
  approved: AuditApprovedInput[];
  rejected: AuditRejectedInput[];
  overrides: AuditOverrideRow[];
}

/**
 * The JSON object written to Dropbox. `schema_version` allows a future v1.1
 * to add fields without breaking older readers.
 */
export interface AuditJsonOutput {
  schema_version: '1.0';
  round_id: string;
  round_number: number;
  project_id: string;
  package_type: string | null;
  locked_at: string;
  locked_by_user_id: string | null;
  engine_version: string | null;
  tier_used: string | null;
  approved: AuditApprovedInput[];
  rejected: AuditRejectedInput[];
  overrides: AuditOverrideRow[];
}

// ─── Builder ─────────────────────────────────────────────────────────────────

/**
 * Pure builder: takes raw lock-time inputs and returns the JSON object that
 * gets uploaded to Dropbox.
 *
 * Invariants enforced by this function:
 *   - schema_version is always '1.0'
 *   - approved + rejected sets are mutually exclusive on group_id (a group
 *     cannot be both approved AND rejected — the spec defines approval as
 *     winning over rejection on conflict; see shortlistLockMoves.ts).
 *     If the caller passes overlapping sets we drop the duplicate from
 *     rejected and keep the approved entry.
 *   - approved + rejected entries are sorted by group_id for deterministic
 *     diffs (Dropbox version history shows clean diffs across re-locks).
 *   - overrides preserved verbatim (no filtering, no reordering — the caller
 *     already orders by client_sequence/created_at when querying the DB; we
 *     trust that order).
 *
 * Keeping this pure means tests can construct fixture inputs and assert the
 * output directly; the lock function's I/O bits (Dropbox upload, DB queries)
 * stay outside the unit-test surface.
 */
export function buildAuditJson(input: AuditJsonInput): AuditJsonOutput {
  // De-dupe: if a group appears in both approved and rejected, approval wins.
  const approvedIds = new Set(input.approved.map((a) => a.group_id));
  const filteredRejected = input.rejected.filter(
    (r) => !approvedIds.has(r.group_id),
  );

  // Deterministic ordering — group_id is a UUID so localeCompare gives a
  // stable lexicographic sort. The lock-time DB queries don't guarantee any
  // particular order, so we sort here once for clean Dropbox diffs.
  const approvedSorted = [...input.approved].sort((a, b) =>
    a.group_id.localeCompare(b.group_id),
  );
  const rejectedSorted = [...filteredRejected].sort((a, b) =>
    a.group_id.localeCompare(b.group_id),
  );

  return {
    schema_version: '1.0',
    round_id: input.round.round_id,
    round_number: input.round.round_number,
    project_id: input.round.project_id,
    package_type: input.round.package_type,
    locked_at: input.round.locked_at,
    locked_by_user_id: input.round.locked_by_user_id,
    engine_version: input.round.engine_version,
    tier_used: input.round.tier_used,
    approved: approvedSorted,
    rejected: rejectedSorted,
    overrides: input.overrides,
  };
}

// ─── Path helper ─────────────────────────────────────────────────────────────

/**
 * Build the Dropbox file path for an audit JSON, given the project's Dropbox
 * root and the round's lock metadata.
 *
 * Path pattern: `<rootPath>/Photos/_AUDIT/round_<N>_locked_<ISO8601>.json`
 *
 * The ISO timestamp is sanitised so it's a valid Dropbox filename. Dropbox
 * accepts most characters but `:` is reserved on macOS-style mounts; we
 * replace `:` with `-` (and `.` with `-` on the milliseconds suffix) to match
 * the convention from W7.4 spec § "Where to write".
 *
 * Example output:
 *   /Flex Media Team Folder/Projects/abc-123_lot-45/Photos/_AUDIT/round_2_locked_2026-04-27T03-12-08-441Z.json
 */
export function buildAuditJsonPath(
  rootPath: string,
  roundNumber: number,
  lockedAt: string,
): string {
  const safeStamp = lockedAt.replace(/[:.]/g, '-');
  const filename = `round_${roundNumber}_locked_${safeStamp}.json`;
  // Normalise: strip trailing slash on root then join.
  const root = rootPath.replace(/\/+$/, '');
  return `${root}/Photos/_AUDIT/${filename}`;
}

/**
 * Serialise the audit JSON for upload. Pretty-printed (2-space indent) so
 * Dropbox's version-history diff view is human-readable across re-locks.
 */
export function serializeAuditJson(audit: AuditJsonOutput): string {
  return JSON.stringify(audit, null, 2);
}

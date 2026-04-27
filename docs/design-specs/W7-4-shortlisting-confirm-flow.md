# W7.4 — Confirm-Time File-Movement Flow + Audit Mirror — Design Spec

**Status:** Design phase. ~half-day execution after sign-off.
**Pairs with:** P0-1 (`shortlist-lock` rewrite) — both touch the lock function.

## Spec compliance gap

Spec section 18 defines the confirm-time flow as **copy** (not move):

```
01_RAW_WORKING ─copy─▶ 03_SHORTLIST_CONFIRMED ─copy─▶ 04_EDITOR_INPUT
                                ▲                            ▲
                            audit row                    audit row
```

Plus: per-event JSON audit files written to `_AUDIT/`.

Our implementation today **moves** files in a single transition:

```
Photos/Raws/Shortlist Proposed ─MOVE─▶ Photos/Raws/Final Shortlist (approved)
                              └─MOVE─▶ Photos/Raws/Rejected         (rejected)
```

No editor-input copy. No audit folder mirror. Different folder name conventions (we use product-aligned `Photos/Raws/...` instead of phase-numbered `01_..04_..`).

## What the spec wants — and why

Spec design intent (interpreting the original architectural reasoning):

1. **Copy preserves source.** Original RAWs stay in `01_RAW_WORKING` until project end-of-life. If a file is corrupted in editor delivery, we can recover from source. If editor needs to re-pick from original universe, original universe still exists.
2. **Two-stage copy** (`Confirmed` → `Editor Input`) lets the editor work on a folder dedicated to their workflow without disturbing the audit-grade `Confirmed` set. Editor can mark files done, tag versions, etc., without modifying the canonical confirmed set.
3. **`_AUDIT/` JSON mirror** gives a tamper-evident chronological log alongside the DB audit table. Survives even if the DB is wiped.

## Tradeoffs of copy-vs-move

### Storage cost

For a 24-image Gold round at 60MB/CR3 × 5 brackets:
- Confirmed photos: 24 × 5 = 120 RAWs × 60MB = **7.2 GB per round**
- Editor input copy: another **7.2 GB**
- Total per round: ~21.6 GB (originals + confirmed + editor input)

vs current MOVE: ~7.2 GB (source) split across confirmed + rejected post-move.

Per 100 rounds/year: spec approach uses ~2 TB more Dropbox storage. At Dropbox Business pricing this is meaningful but not catastrophic.

### Operator UX cost

Copy creates the question: **what cleans up `Photos/Raws/Shortlist Proposed/` after editor receives the files?** Spec implies "manual cleanup at end of project lifecycle" but our pipeline doesn't have a clear "project lifecycle done" signal today.

Without cleanup:
- Source folder fills up indefinitely with old shoots
- Re-running a round later (e.g. operator wants to re-test) sees STALE files in source — wrong universe
- The `Run Shortlist Now` button's empty-folder check (burst 15 X2) breaks because the folder is never empty post-lock

### Audit benefit

The copy pattern's audit benefit is real: if anything goes wrong post-confirm, you have THREE folder snapshots (source / confirmed / editor) each with their own Dropbox version history. Our MOVE pattern collapses this to "two folders that change over time".

## Recommended hybrid

Keep the simplicity of MOVE but ADD audit safeguards:

1. **MOVE remains primary** — files transition once, source folder empties, operator UX stays clean.
2. **`_AUDIT/` JSON mirror** — for every lock event, write a tamper-evident JSON file to `Photos/_AUDIT/round_{N}_locked_{timestamp}.json` containing:
   - Round metadata (round_id, locked_at, locked_by, package, tier)
   - Confirmed shortlist (list of stems with their slot assignments, scores, room types)
   - Rejected list (stems + reason)
   - Move execution log (per-file: from/to/timestamp)
3. **Explicit `Photos/Editors/Edited Post Production/` is OUT-OF-SCOPE for the lock function.** The editor pulls from `Photos/Raws/Final Shortlist/` directly. If editors want a working copy in their own folder, that's their workflow, not the engine's.
4. **Source folder cleanup**: source naturally empties when lock moves files (current behaviour). New file uploads for a future round trigger the next ingest cycle. Clean.

This delivers the audit value (per-event JSON) without the storage + UX cost of copy-twice.

## Implementation

### Migration not required

Pure code change in `shortlist-lock`.

### `_AUDIT/` folder provisioning

The `_AUDIT/` folder kind already exists in the canonical project folder skeleton (per `projectFolders.ts` — `audit` folder kind, path `_AUDIT/`). Confirm it's provisioned for shortlisting projects (current code may not write to it for photos pipeline — verify).

### Audit JSON schema

```typescript
interface ShortlistLockAuditEntry {
  schema_version: '1.0';
  event_type: 'shortlist_locked';
  round_id: string;
  project_id: string;
  locked_at: string;       // ISO timestamp
  locked_by: string | null; // user UUID
  package_type: string;
  package_ceiling: number;
  tier: string;

  approved: Array<{
    composition_group_id: string;
    delivery_reference_stem: string;
    files_in_group: string[];
    slot_id: string | null;        // populated for slot-fill winners
    slot_phase: number | null;     // 1, 2, or 3
    slot_rank: number | null;
    is_phase3_recommendation: boolean;
    combined_score: number | null;
    room_type: string | null;
    composition_type: string | null;
  }>;

  rejected: Array<{
    composition_group_id: string;
    delivery_reference_stem: string;
    files_in_group: string[];
    rejection_reason: 'human_override' | 'near_duplicate' | 'pass0_hard_reject';
  }>;

  undecided: Array<{                 // groups in neither approved nor rejected
    composition_group_id: string;
    delivery_reference_stem: string;
    files_in_group: string[];
  }>;

  move_execution: {
    started_at: string;
    completed_at: string;
    async_job_id: string;            // Dropbox batch job id from W7.1
    total_moves: number;
    succeeded: number;
    failed: number;
    error_excerpts: string[];        // first 5 errors if any
  };

  coverage: {
    package_ceiling: number;
    proposed_count: number;
    coverage_notes: string;
  };
}
```

### Where to write

`Photos/_AUDIT/round_{round_number}_locked_{timestamp}.json`

The timestamp is in `YYYY-MM-DDTHH-MM-SS` format (no colons, Dropbox-friendly). Multiple lock attempts on the same round produce multiple files — full chronological history.

### Code change

In `shortlist-lock` (post-W7.1), after the move batch completes successfully and before transitioning the round to `status='locked'`:

```typescript
async function writeAuditMirror(entry: ShortlistLockAuditEntry, project: Project) {
  const auditFolder = await getFolderPath(project.id, 'audit');
  const filename = `round_${entry.round_number}_locked_${entry.locked_at.replace(/[:.]/g, '-')}.json`;
  const fullPath = `${auditFolder}/${filename}`;

  const content = JSON.stringify(entry, null, 2);
  await uploadFile(fullPath, content, 'add');  // 'add' mode = error if exists; safe
}
```

Best-effort — wrap in try/catch and log warning if it fails. Audit mirror is an enhancement, not a hard dependency for lock to succeed.

### Testing

Add a smoke check to W7.1's smoke test:
1. Lock the Everton round
2. Verify `Photos/_AUDIT/round_2_locked_*.json` appears in Dropbox
3. Pretty-print one and confirm it round-trips through JSON.parse

## Out-of-scope for this spec

- Editor-side folder workflows. The editor team's preferences for working-copy folders are their concern. Engine's job ends at "files in `Photos/Raws/Final Shortlist/`".
- Spec compliance with literal `04_EDITOR_INPUT/` path — we don't have it; we use `Photos/Editors/Edited Post Production/` and the editor knows where to look.
- Soft-delete-with-suffix patterns. Original files still exist in Dropbox version history if recovery is ever needed — that's good enough.

## Open questions for sign-off

1. **Is the audit JSON schema enough for compliance / legal needs?** If FlexMedia has a contractual obligation to preserve source RAWs for N years, the MOVE+audit-mirror pattern still satisfies it (Dropbox versions retain deleted files for 30/180 days depending on plan; further archival is a separate concern).
2. **Should the audit JSON also capture overrides (the human's drag-decisions)?** Recommendation: yes — include the full overrides list with `human_action`, `client_sequence`, timestamps. This makes the audit JSON the canonical "what did this round become" record without needing the DB.
3. **Per-round file vs append-only log?** Spec implies one JSON file per event. We're going with one JSON per LOCK event (multiple if a round is unlocked + relocked, which P0-1's resume flow allows). Alternative: append all events for a project to a single `project_<id>_audit.jsonl` file. Multi-file is simpler + Dropbox handles versioning.

## Effort estimate

- Half-day implementation (~50 lines added to lock function)
- Lands as part of P0-1 burst (W7.1)

## Pre-execution checklist

- [ ] Joseph signs off on Q1 (compliance scope)
- [ ] Joseph confirms Q2 (overrides included)
- [ ] Joseph confirms Q3 (one file per lock event)
- [ ] `Photos/_AUDIT/` folder kind verified in `project_folders` for photos projects

# W7.13 — Manual Shortlisting Mode — Design Spec

**Status:** ✅ Shipped 2026-04-27 (commits 91ea4d3, 068ae67, faa8a2d, 689eb55, ecc01ae).
**Backlog ref:** P1-19 (new, added 2026-04-27)
**Wave plan ref:** W7.13 — UX fork for project types where AI shortlisting doesn't apply
**Dependencies:** W7.7 (adds `project_types.shortlisting_supported` column), W7.4 (audit JSON mirror — works the same in manual mode), W7.5 (lock fn — works the same).
**Unblocks:** ability to use the FlexStudios shortlisting UI for any project type without forcing the engine onto incompatible content.

---

## Problem (Joseph 2026-04-27)

The shortlisting subtab today assumes every project goes through Pass 0/1/2/3 — RAW HDR brackets, room-type classification, slot resolution, score-driven shortlisting. That's the right behaviour for property photography projects, but FlexMedia takes other kinds of work too. When a project type doesn't fit the engine's assumptions (corporate event coverage, raw deliverable archives, niche commercial work), the operator should still get the swimlane UI to manage shortlisting, but **without any AI passes**:

- No Pass 0 (no bracket detection, no EXIF extract; the files might not even be RAW)
- No Pass 1 (no room-type classification; not relevant)
- No Pass 2 (no slot resolution; no slots make sense)
- No Pass 3 (no validation; nothing to validate against)
- **Just** read the files in Dropbox, render each as a swimlane card, let the operator drag to approved one-by-one, and hit Lock to trigger the existing move_batch_v2 flow against the human-curated approved set.

Same lock semantics, same audit JSON mirror, same Dropbox folder structure. Different UI, no engine.

## Architecture

### Detection

A project runs in manual mode when:
```sql
SELECT pt.shortlisting_supported
FROM projects p
JOIN project_types pt ON pt.id = p.project_type_id
WHERE p.id = $1;
```
returns `false`. The W7.7 migration adds this column with default `true` so existing project types stay on the engine path.

Master_admin can flip the flag per project type via `Settings → Project Types`.

### Frontend fork

`flexmedia-src/src/pages/ProjectShortlistingTab.jsx` (or wherever the swimlane lives — confirm via grep) reads the project's `project_type.shortlisting_supported` flag at mount. Branches to one of two render trees:

**Engine mode (default — today's behaviour):**
- "Run round" button enqueues a `shortlisting_rounds` row + `shortlisting_jobs` for Pass 0
- Status indicator shows current pass (extract / pass1 / pass2 / pass3)
- Phase-1/2/3 swimlane layout with slot grouping
- Lock button triggers `shortlist-lock` with the AI-proposed + human-overridden approved set

**Manual mode (new):**
- No "Run round" button
- No status indicator (no engine running)
- Single flat swimlane: **"Files to review"** column on left, **"Approved"** column on right
- Each file in the project's `Photos/Raws/Shortlist Proposed/` folder renders as a card (filename + thumbnail if available; thumbnail comes from the existing Dropbox preview API or a generic file-icon fallback if Dropbox can't render the type)
- Drag-to-approved is the only interaction
- Lock button is enabled whenever the approved set is non-empty
- Lock button triggers `shortlist-lock` with the human-curated approved set (no AI scores, no slot assignments)

### Backend impact (minimal)

The lock function (`shortlist-lock`) already accepts an approved-stem set as input. Manual mode just calls it with the human's drag-result; no `shortlisting_rounds` row required.

But the audit JSON mirror (W7.4) currently expects a round_id to embed metadata. Two options:

**Option A — Manual rounds get a synthetic `shortlisting_rounds` row.**
Insert a row with `package_type='manual'`, `package_tier_choice=null`, `total_compositions=null`, status transitions skip directly from 'created' → 'locked'. Audit JSON is identical to engine-mode rounds with most fields null. Simpler frontend (the same swimlane state can render either mode); only the engine-side logic is conditional.

**Option B — Manual mode bypasses `shortlisting_rounds` entirely.**
Lock writes the audit JSON with a synthetic `round_id: null` shape. Cleaner DB (no fake rows) but the audit JSON shape diverges, the swimlane state machine has two flavours, and the dispatcher's queries that join on round_id need null guards.

**Recommendation: Option A.** The synthetic-round overhead is one row write per lock; everything else stays unified. Manual rounds never get `shortlisting_jobs` enqueued so the dispatcher ignores them.

### Listing files in manual mode

The frontend needs a way to list all files in `Photos/Raws/Shortlist Proposed/` for the project. This is exactly what `listDropboxFiles` does today. Manual mode hits that endpoint at mount and on a refresh button.

⚠️ **Dependency**: `listDropboxFiles` is on the legacy stale-token path (P1-18 backlog). Manual mode silently breaks if the token expires. Either:
- W7.13 includes the W7.12 (P1-18) migration as a precondition
- Or the chip already spawned for P1-18 must land before W7.13 ships

The orchestrator should ensure W7.12 lands first.

### Dropbox folder structure

Manual mode uses the same project folder tree:
```
<dropbox_root_path>/
├── Photos/
│   ├── Raws/
│   │   ├── Shortlist Proposed/   ← source files (everything)
│   │   └── Final Shortlist/      ← lock destination (approved files)
│   ├── _AUDIT/                   ← audit JSON files (W7.4)
│   └── Editors/Edited Post Production/
```

`provisionProjectFolders` already creates these regardless of project type, so no change needed there.

## Migration

No schema migration needed. W7.7's `project_types.shortlisting_supported` column is the only DB plumbing required. W7.13 is purely:
- Frontend fork in `ProjectShortlistingTab.jsx`
- New "Files to review" / "Approved" simple swimlane components
- A small `manualLock` action on the existing `shortlist-lock` edge fn (or just a `mode: 'manual'` flag in the existing payload)
- Synthetic round row creation at lock time (Option A)

## Engine impact

`shortlisting-job-dispatcher` and `shortlisting-orchestrator` should refuse to enqueue rounds for projects where `project_type.shortlisting_supported = false`. Defensive — even if the frontend somehow surfaces a "Run round" button on a manual-mode project, the backend rejects with a 400 ("manual_mode_project").

## Tests

- Frontend: render `ProjectShortlistingTab` with a fixture project where `shortlisting_supported=false`; assert the manual-mode tree renders (no Run-round button, "Files to review" swimlane visible).
- Frontend: render with `shortlisting_supported=true`; assert engine mode renders.
- Backend: invoke `shortlist-lock` with `mode: 'manual'` payload; assert synthetic round row is created and move_batch_v2 fires against the human approved set.
- Backend: invoke `shortlisting-orchestrator` for a manual-mode project; assert 400 with reason `manual_mode_project`.

## Out of scope

- Bulk-approve UX (drag-multiple, "approve all" button) — could be a follow-up if operators ask for it
- Pre-existing files in `Final Shortlist/` (e.g. from a prior lock) — they're left alone; new lock additions are appended
- Engine-mode → manual-mode migration mid-project. If a project type's `shortlisting_supported` flag flips while a round is in flight, the round completes under engine mode and the next round runs as manual.

## Effort estimate

- 0.5 day backend (synthetic round row creation + dispatcher 400 guard + manual-mode payload field)
- 1-2 days frontend (fork in ProjectShortlistingTab, manual swimlane component, drag-to-approved, lock wiring)
- 0.5 day Settings → Project Types admin toggle UI
- Total: ~2-3 days

## Pre-execution checklist

- [x] Architecture self-resolved by orchestrator (Option A: synthetic round row keeps unified state)
- [ ] W7.7 has landed (provides `project_types.shortlisting_supported` flag)
- [ ] W7.12 (P1-18 legacy-token migration) has landed (manual mode depends on `listDropboxFiles`)
- [ ] Joseph signs off on Option A (synthetic round row) vs Option B (no round row) — orchestrator's recommendation is A

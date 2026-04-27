# W10.1 — Multi-camera partitioning in `bracketDetector` — Design Spec

**Status:** ⚙️ Ready to dispatch (awaiting Joseph sign-off on Q1-Q3 below).
**Backlog ref:** P2-6
**Wave plan ref:** W10.1 — `composition_groups.camera_source` + `is_secondary_camera` + per-camera Pass 0 partitioning + swimlane secondary-camera banner (W10.2 sibling)
**Dependencies:** None hard. Plays nicely with W7.7 (`shortlisting_supported` flag, dynamic counts) since manual-mode rounds bypass Pass 0 entirely.
**Unblocks:** W10.2 (the sibling banner UI is described here in §6 but lands as its own commit), W11 (universal vision response — secondary-camera images flow through Pass 1 with `source.media_kind='still_image'` and a new caller-provided hint `is_secondary_camera`).

---

## Problem

Today's Pass 0 bracket detector assumes a single camera per shoot. The detector walks files sorted by `captureTimestampMs`, breaking groups on >4s gaps, on settings discontinuities, or on AEB-sequence restarts. It treats `cameraModel` as a settings-continuity check (a model change forces a new group), but it does **not** partition the input upstream — so a multi-camera shoot still flows through a single timeline, where R5 brackets and R6 / iPhone snaps interleave by timestamp.

Real-world shape from production: a primary photographer fires 5-bracket AEB sequences on a Canon R5; a second photographer (or the same photographer with a phone) fires occasional iPhone Live Photos / single JPEGs for context shots; sometimes a junior fires a Canon R6 from a different vantage. When timestamps interleave, the current detector's output is junk:

- A 5-shot R5 bracket gets broken because an iPhone shot lands inside the 4s window with different settings, forcing a settings break partway through. The orphan iPhone shot becomes a singleton, the R5 sequence becomes a 4-shot incomplete bracket, and the next R5 bracket inherits the orphan-as-anchor.
- Even when settings breaks "happen to work", the detector reports `validateBracketCounts` drift outside tolerance for any shoot with 10+ secondary-camera shots — Pass 1 is then asked to score classes that aren't real brackets.

The fix is camera-source partitioning: detect the unique `camera_source` (model + body serial) per file from EXIF, partition the bracket-detection input by source, run `groupIntoBrackets` per source, tag the rare-source groups as `is_secondary_camera=true`, and let secondary-camera images flow through Pass 0 as singletons (file_count=1, isComplete=false, but explicitly NOT a "broken bracket"). The swimlane displays a per-source banner so the editor sees "23 R5 brackets + 3 iPhone images treated as singletons" instead of "drift +0.6 on 26 files".

---

## Architecture

### Section 1 — New columns on `composition_groups`

Today: `composition_groups.cameraModel` is captured implicitly (via `BracketGroup.cameraModel` derived from group[0].cameraModel) but not persisted as a queryable column. Wave 10.1 makes it a first-class column, plus the camera-body serial for true uniqueness, plus the secondary-camera flag.

```sql
ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS camera_source TEXT,
  ADD COLUMN IF NOT EXISTS is_secondary_camera BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN composition_groups.camera_source IS
  'Wave 10.1 P2-6: canonical camera identifier — "<Model>:<SerialNumber>" lowercased and slugged. Two cameras of the same model have different camera_sources because of the serial. NULL for legacy rows pre-W10.1.';

COMMENT ON COLUMN composition_groups.is_secondary_camera IS
  'Wave 10.1 P2-6: TRUE when this group came from a non-primary camera_source on the round (i.e. this source contributed fewer files than the round''s primary). Pass 0 emits these as singletons (no bracket merge); the swimlane displays a banner.';
```

### Section 2 — Modal worker `photos-extract` extracts camera body serial

`modal/photos-extract/main.py` already extracts `Model` via the `EXIF_TAGS` array (line 156). Add `-SerialNumber` to that list and surface it in the per-file response.

```python
# main.py — EXIF_TAGS additions
EXIF_TAGS = [
    "-AEBBracketValue",
    "-DateTimeOriginal",
    "-SubSecTimeOriginal",
    "-ShutterSpeed",
    "-ShutterSpeedValue",
    "-ExposureTime",
    "-Aperture",
    "-ApertureValue",
    "-FNumber",
    "-ISO",
    "-FocalLength",
    "-Orientation",
    "-Model",
    "-SerialNumber",  # NEW W10.1 — Canon CR3 / iPhone HEIC both carry it
]

# in _process_one(), inside exif_raw → exif dict construction:
camera_serial = exif_raw.get("SerialNumber") or exif_raw.get("InternalSerialNumber") or None
# ...
return stem, {
    "ok": True,
    "exif": {
        "fileName": Path(file_path).name,
        "cameraModel": camera_model,
        "cameraSerial": camera_serial,            # NEW W10.1
        "shutterSpeed": str(exif_raw.get("ShutterSpeed") or exif_raw.get("ExposureTime") or ""),
        # ... rest unchanged
    },
    # ...
}
```

Notes:
- Canon CR3 carries `SerialNumber` (body serial, e.g. `043032004247`). Some older bodies emit `InternalSerialNumber` instead — fallback covers both.
- iPhone HEIC carries `Make=Apple` + `Model=iPhone 14 Pro` and a per-device `BodySerialNumber` is sometimes available; when missing, the source identity is `apple:iphone-14-pro:<unknown>` — multiple iPhones look the same, but they group cleanly together as "the iPhone(s)" which is the intended behaviour.
- No backwards-compat concern: the field is additive; older Modal responses that lack `cameraSerial` are handled gracefully by the helper in §3.

### Section 3 — New helper `_shared/cameraPartitioner.ts`

Pure-function, no I/O. Takes an array of EXIF-extracted file rows, returns groups keyed by `camera_source`, plus the canonical labelling for primary vs secondary.

```typescript
// supabase/functions/_shared/cameraPartitioner.ts (new)

import type { ExifSignals } from './bracketDetector.ts';

/**
 * Wave 10.1 P2-6 — partition a flat list of EXIF-extracted files into
 * per-camera buckets, then label the largest as primary and all others
 * as secondary.
 *
 * camera_source canonicalisation:
 *   `${cameraModel}:${cameraSerial}` lowercased, non-alphanumerics → '-'.
 *   When cameraSerial is missing we fall back to `${cameraModel}:unknown`
 *   so all serial-less files of the same model bucket together (real-world
 *   iPhone case).
 *
 * Primary selection rule: the camera_source contributing the most files is
 * primary; ties broken by earliest captureTimestampMs (deterministic). This
 * matches the editor's intuition — "the camera I shot most with is primary".
 *
 * Optional override: when round.primary_camera_source_override is set
 * (admin-pinned via Pass 0 settings; not in initial scope — defer to W10
 * follow-up), respect it.
 */

export interface CameraSourceGroup {
  cameraSource: string;          // canonical "<model>:<serial>" slug
  isSecondaryCamera: boolean;
  files: ExifSignals[];
}

export function canonicalCameraSource(
  cameraModel: string | null | undefined,
  cameraSerial: string | null | undefined,
): string {
  const model = (cameraModel || 'unknown').toString().trim();
  const serial = (cameraSerial || 'unknown').toString().trim();
  const slug = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slug(model)}:${slug(serial)}`;
}

export function partitionByCameraSource(
  files: Array<ExifSignals & { cameraSerial?: string | null }>,
  options: { primaryOverride?: string | null } = {},
): CameraSourceGroup[] {
  if (files.length === 0) return [];

  // Bucket by canonical source
  const byCamera = new Map<string, ExifSignals[]>();
  const earliestByCamera = new Map<string, number>();
  for (const f of files) {
    const key = canonicalCameraSource(f.cameraModel, f.cameraSerial ?? null);
    if (!byCamera.has(key)) byCamera.set(key, []);
    byCamera.get(key)!.push(f);
    const prev = earliestByCamera.get(key);
    if (prev == null || f.captureTimestampMs < prev) {
      earliestByCamera.set(key, f.captureTimestampMs);
    }
  }

  // Determine primary: explicit override > largest bucket > earliest start tie
  let primaryKey: string | null = options.primaryOverride || null;
  if (!primaryKey || !byCamera.has(primaryKey)) {
    const ranked = [...byCamera.entries()]
      .map(([k, arr]) => ({
        key: k,
        count: arr.length,
        earliest: earliestByCamera.get(k)!,
      }))
      .sort((a, b) => (b.count - a.count) || (a.earliest - b.earliest));
    primaryKey = ranked[0]?.key ?? null;
  }

  return [...byCamera.entries()].map(([cameraSource, files]) => ({
    cameraSource,
    isSecondaryCamera: cameraSource !== primaryKey,
    files,
  }));
}
```

Tests live alongside in `cameraPartitioner.test.ts` — empty input, single source → 1 primary group, two sources unequal → larger is primary, two sources equal count → earliest start wins, missing serial collapses by model, override honoured when present.

### Section 4 — `bracketDetector.ts` accepts a `groupBy` mode

The current `groupIntoBrackets(files: ExifSignals[])` runs over a flat list. Wave 10.1 keeps that signature for backwards compat (Pass 0 callers can opt in) and adds a new entry point that respects partitioning.

```typescript
// supabase/functions/_shared/bracketDetector.ts (additions)

export interface PartitionedBracketGroup extends BracketGroup {
  cameraSource: string;
  isSecondaryCamera: boolean;
}

/**
 * Wave 10.1 P2-6 — bracket-detect after partitioning by camera_source.
 *
 * For each partition:
 *   - Primary partition: full bracket grouping (5-shot max, AEB-aware,
 *     settings-aware) just like today's groupIntoBrackets.
 *   - Secondary partition(s): emit each file as its own group of 1
 *     (singletons). NO bracket merging — secondary-camera shots are by
 *     definition not part of the primary's AEB run, and merging them by
 *     timestamp (which is what today's flat detector does) produces the
 *     bug we're fixing.
 *
 * The file_count=1 / isComplete=false output for secondary groups is
 * SEMANTICALLY DIFFERENT from "incomplete bracket" — Pass 0 logging must
 * distinguish the two. validateBracketCounts is called per-partition, not
 * over the union, so primary drift is reported cleanly without secondary
 * noise.
 */
export function groupIntoBracketsPartitioned(
  partitions: CameraSourceGroup[],
): PartitionedBracketGroup[] {
  const out: PartitionedBracketGroup[] = [];
  for (const p of partitions) {
    if (p.isSecondaryCamera) {
      // Singletons — preserve order for deterministic group_index assignment
      const sorted = [...p.files].sort((a, b) => a.captureTimestampMs - b.captureTimestampMs);
      for (const f of sorted) {
        out.push({
          files: [f],
          isComplete: false,
          isMicroAdjustmentSplit: false,
          cameraModel: f.cameraModel,
          primaryTimestampMs: f.captureTimestampMs,
          cameraSource: p.cameraSource,
          isSecondaryCamera: true,
        });
      }
    } else {
      const primaryGroups = groupIntoBrackets(p.files);
      for (const g of primaryGroups) {
        out.push({
          ...g,
          cameraSource: p.cameraSource,
          isSecondaryCamera: false,
        });
      }
    }
  }
  // Stable sort across all partitions so group_index stays deterministic.
  // Primary groups before secondary singletons (within the same timestamp
  // bucket) — the editor expects to see the bracketed flow first.
  return out.sort((a, b) => {
    if (a.isSecondaryCamera !== b.isSecondaryCamera) {
      return a.isSecondaryCamera ? 1 : -1;
    }
    return a.primaryTimestampMs - b.primaryTimestampMs;
  });
}
```

`groupIntoBrackets` (the legacy entry point) stays unchanged — pure backwards compat for tests + any caller that explicitly wants flat behaviour.

### Section 5 — Pass 0 wiring

`supabase/functions/shortlisting-pass0/index.ts` builds `exifSignals` from the Modal response (line ~370). Today it calls `groupIntoBrackets(exifSignals)`. Change:

```typescript
// shortlisting-pass0/index.ts (around line 386)

import { partitionByCameraSource } from '../_shared/cameraPartitioner.ts';
import { groupIntoBracketsPartitioned } from '../_shared/bracketDetector.ts';

// ... existing exifSignals construction now also pulls cameraSerial:
exifSignals.push({
  fileName: exif.fileName,
  cameraModel: exif.cameraModel,
  cameraSerial: exif.cameraSerial ?? null,   // NEW W10.1
  // ... rest unchanged
});

// 5. Partition by camera source, then bracket-detect each.
const partitions = partitionByCameraSource(exifSignals);
const groups = groupIntoBracketsPartitioned(partitions);

// 5b. Validate per partition (drift on primary; secondaries are expected to
//     be singletons so no drift check). Emit a per-partition warning into
//     the round's shortlisting_events for the swimlane banner.
const partitionSummary: Array<{
  camera_source: string;
  is_secondary: boolean;
  file_count: number;
  group_count: number;
  validation_warnings: string[];
}> = [];

for (const p of partitions) {
  const groupsForPartition = groups.filter(g => g.cameraSource === p.cameraSource);
  if (p.isSecondaryCamera) {
    partitionSummary.push({
      camera_source: p.cameraSource,
      is_secondary: true,
      file_count: p.files.length,
      group_count: groupsForPartition.length,
      validation_warnings: [],  // singletons by design — no drift check
    });
    continue;
  }
  const validation = validateBracketCounts(
    groupsForPartition.map(({ cameraSource, isSecondaryCamera, ...g }) => g),
    p.files.length,
  );
  partitionSummary.push({
    camera_source: p.cameraSource,
    is_secondary: false,
    file_count: p.files.length,
    group_count: groupsForPartition.length,
    validation_warnings: validation.warnings,
  });
}
// Persist partitionSummary into the existing shortlisting_events row Pass 0
// emits (event_type='pass0_summary'). The swimlane reads it for the banner.
```

The `insertCompositionGroups` helper that follows must be extended to write the new columns:

```typescript
// _shared/passZeroPersist.ts (or wherever insertCompositionGroups lives)
.insert({
  // ... existing columns ...
  camera_source: group.cameraSource,
  is_secondary_camera: group.isSecondaryCamera,
})
```

### Section 6 — Frontend swimlane secondary-camera banner (W10.2)

**Note:** banner UI lands as the **W10.2 commit** but is specified here so the W10.1 author has the contract.

`flexmedia-src/src/components/projects/shortlisting/ShortlistingSwimlane.jsx` adds a banner above the columns when `groups.some(g => g.is_secondary_camera)`. Read from the existing `composition_groups` query (already present at line ~141).

```jsx
// Inside the swimlane render, near the top:
const secondaryBuckets = useMemo(() => {
  const m = new Map();
  for (const g of groups) {
    if (!g.is_secondary_camera) continue;
    const key = g.camera_source || 'unknown';
    if (!m.has(key)) m.set(key, 0);
    m.set(key, m.get(key) + 1);
  }
  return [...m.entries()].map(([source, count]) => ({ source, count }));
}, [groups]);

{secondaryBuckets.length > 0 && (
  <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 mb-3 text-sm text-amber-900">
    {secondaryBuckets.map(({ source, count }) => (
      <div key={source}>
        {count} {humaniseCameraSource(source)} image{count !== 1 ? 's' : ''} treated as singletons
        — these did not run through bracket merging.
      </div>
    ))}
  </div>
)}
```

`humaniseCameraSource('apple:iphone-14-pro:unknown')` → `"iPhone 14 Pro"`; `humaniseCameraSource('canon-eos-r6:0123456789')` → `"Canon EOS R6"`. Helper lives in `flexmedia-src/src/utils/cameraSource.js`. Banner styling matches W7.4's audit-status banner pattern (amber for "informational, no action required").

---

## Migration

Reserve **next available** at integration time. Recommend `340_composition_groups_camera_source.sql` (W7.7 reserved 339).

```sql
-- Wave 10.1 P2-6: composition_groups gains camera_source + is_secondary_camera
-- so Pass 0 can partition multi-camera shoots and the swimlane can render
-- a per-source banner.

ALTER TABLE composition_groups
  ADD COLUMN IF NOT EXISTS camera_source TEXT,
  ADD COLUMN IF NOT EXISTS is_secondary_camera BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN composition_groups.camera_source IS
  'Wave 10.1 P2-6: "<model>:<serial>" slug; two cameras of the same model differ by serial. NULL for legacy rows pre-W10.1.';
COMMENT ON COLUMN composition_groups.is_secondary_camera IS
  'Wave 10.1 P2-6: TRUE for groups from non-primary camera_sources. Pass 0 emits these as singletons; swimlane displays a banner.';

-- Composite index: round-scoped queries that filter by primary camera and
-- by secondary status (the swimlane fetches all groups for a round and
-- partitions client-side, but the analytics RPCs in Wave 14 will filter).
CREATE INDEX IF NOT EXISTS idx_composition_groups_camera_source
  ON composition_groups(round_id, is_secondary_camera, camera_source);

NOTIFY pgrst, 'reload schema';

-- Rollback (manual):
-- DROP INDEX IF EXISTS idx_composition_groups_camera_source;
-- ALTER TABLE composition_groups DROP COLUMN IF EXISTS is_secondary_camera;
-- ALTER TABLE composition_groups DROP COLUMN IF EXISTS camera_source;
--
-- Backfill is N/A: legacy rows stay camera_source=NULL,
-- is_secondary_camera=FALSE (default). Pass 0 only writes the columns for
-- new rounds. The swimlane handles NULL gracefully (no banner).
```

---

## Engine integration

1. **Modal worker** (`photos-extract/main.py`) — add `-SerialNumber` to `EXIF_TAGS` and surface as `cameraSerial` in the response.

2. **Pass 0** (`shortlisting-pass0/index.ts`) — read `exif.cameraSerial` into the projected `ExifSignals`, call `partitionByCameraSource`, then `groupIntoBracketsPartitioned`. Persist `camera_source` + `is_secondary_camera` per group. Emit `partitionSummary` into the `pass0_summary` event payload.

3. **Pass 1** — receives groups including secondary-camera singletons. Per the W11 spec the universal vision response will eventually include `is_secondary_camera` as a hint in the input; for now Pass 1 prompts can stay neutral (a singleton from an iPhone scores like any other singleton — quality bar unchanged). No prompt changes in W10.1.

4. **Pass 2 / Pass 3** — slot eligibility doesn't care about camera_source; secondary-camera images compete for slots on quality alone. If a secondary-camera image legitimately wins a slot, that's the right outcome (e.g. an iPhone shot of a wall feature that no R5 frame captured). No changes.

5. **Orchestrator** — no changes. The dispatcher chains pass0 → pass1 unchanged.

6. **`shortlist-lock`** — no changes. Locks operate on `composition_groups` rows and don't need to know about source.

---

## Frontend impact

1. **`ShortlistingSwimlane.jsx`** — new banner block (see §6). Reads `g.camera_source` + `g.is_secondary_camera` off the existing `composition_groups` query.

2. **`ShortlistingCard.jsx`** — small badge on cards from secondary cameras: "iPhone" / "R6 (secondary)" pill in the top-right corner. Helps editors triage at a glance. Read from `g.is_secondary_camera + g.camera_source`.

3. **`humaniseCameraSource(slug)`** helper — maps known slugs to friendly names. Bootstrap mapping list:
   - `canon-eos-r5:*` → `"Canon EOS R5"`
   - `canon-eos-r6:*` → `"Canon EOS R6"`
   - `canon-eos-r6m2:*` → `"Canon EOS R6 Mark II"`
   - `apple:iphone-*` → strip prefix, title-case
   - any other → derive from prefix before `:`
   No DB-backed lookup needed; keep the helper pure.

---

## Open questions for sign-off

**Q1.** Primary-camera selection rule: largest bucket wins, ties broken by earliest start. Is this right, or do you want a project-level "primary photographer's body serial" pin (e.g. settable on the project record)?
**Recommendation:** ship the largest-bucket rule for v1. A project-level pin is a future refinement (Wave 10 follow-up) — wait until we see real misclassifications before adding it.

**Q2.** What happens when a round has 3+ camera sources? E.g. R5 (primary) + R6 (junior photographer) + iPhone (BTS shots). The current spec treats only the largest as primary; everything else is "secondary". Do you want a tier system (`is_secondary_camera_tier_1`, `_tier_2`)?
**Recommendation:** keep it binary in v1. The swimlane banner naturally renders one row per source, so the editor sees the breakdown ("12 iPhone images, 3 R6 images treated as singletons") without needing a tier ranking. Tier complexity is a YAGNI without a concrete use case.

**Q3.** How does the secondary-camera path interact with `validateBracketCounts` drift warnings? Today the validator counts all files; partitioned mode validates only the primary partition. Are you ok with the round's `pass0_summary` event reporting drift only against the primary file count?
**Recommendation:** yes — primary-only drift is the meaningful signal. Secondary singletons by design have group_count == file_count, so any "drift" there would always be 0. Document the change in the `pass0_summary` event payload comment.

---

## Resolutions self-resolved by orchestrator

- **R1 (camera_source canonicalisation).** `${slug(model)}:${slug(serial)}` matches the existing slug-style of engine identifiers (`engine_role`, `tier_code`). Two same-model bodies with different serials get distinct keys; iPhones with no readable serial collapse under `apple:iphone-14-pro:unknown`, which is the desired behaviour.

- **R2 (singletons vs incomplete-brackets — distinct semantics).** Today `BracketGroup.isComplete=false` flags an "incomplete bracket". Wave 10.1 reuses that field for secondary-camera singletons but adds `isSecondaryCamera=true` so consumers can disambiguate. Pass 1 / Pass 2 don't need to care today; the universal vision response (W11) will receive the secondary-camera flag as input metadata.

- **R3 (legacy backwards compat).** `groupIntoBrackets(files)` flat entry point stays as-is; tests don't break. New entry point `groupIntoBracketsPartitioned(partitions)` is the Pass 0 caller. Cleanly versioned, no breaking change to the shared helper.

- **R4 (no Modal-side serial validation).** exiftool returns `null`/empty for cameras lacking the tag; the helper canonicalises to `:unknown` rather than failing. Bad serials (e.g. exiftool fluke) collapse benignly into the same bucket — worst case is a same-model camera looking like one source, which is fine.

- **R5 (secondary singletons get full Pass 1 + Pass 2).** They're treated like any other group — they compete for slots on quality. We do NOT skip Pass 1 for secondary-camera images. Editors sometimes deliver iPhone-as-final (rare, but allowed). The banner is a heads-up, not a filter.

---

## Effort estimate

- Migration + helper: 30 min
- Modal worker tweak: 30 min (add tag, return field)
- Pass 0 wiring + tests for `cameraPartitioner.test.ts`: 90 min
- Frontend banner + `humaniseCameraSource` helper: 60 min
- Smoke test on real multi-camera round (find one in production fixtures): 30 min

**Total: half-day.** If real fixture is unavailable, write a synthetic 25-file fixture (20 R5 brackets + 5 iPhone singletons) and validate the partitioner output.

---

## Out of scope (handled in other waves)

- Project-level "primary camera body serial" pin (Wave 10 follow-up if Q1 surfaces a need)
- Pass 1 prompt awareness of secondary-camera context (deferred to W11 universal vision response — the schema includes `source.media_kind` and the caller can pass `is_secondary_camera` as a hint)
- Multi-camera-aware tier system (`is_secondary_camera_tier_N`) — deferred per Q2 recommendation
- Editing the swimlane to allow "promote secondary to primary" (operator override) — defer until use case emerges

---

## Pre-execution checklist

- [ ] Joseph signs off on Q1 (primary rule), Q2 (binary vs tiered), Q3 (drift scope)
- [ ] Migration number reserved at integration time (recommend 340; orchestrator confirms next free)
- [ ] Modal worker version bump confirmed (photos-extract has its own deploy lane — Joseph confirms whether to rev `flexstudios-photos-extract` Modal app or wait for next batch)
- [ ] Smoke-test fixture identified: pick one historical multi-camera round from FlexMedia archive (or synthesise one) for end-to-end validation
- [ ] W10.2 banner UI lands as a separate commit (sibling burst); spec details in §6

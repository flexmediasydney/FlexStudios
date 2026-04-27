# W7.6 — Vision Prompt Blocks API Contract — Design Spec

**Status:** ⚙️ Detail spec. Authored 2026-04-27 by orchestrator. Ready for execution.
**Backlog ref:** P1-10
**Wave plan ref:** W7.6 — Vision prompt refactor into composable `_shared/visionPrompts/` blocks
**Dependencies:** None (independent of in-flight W7.4/W7.5/W7.8 burst).
**Unblocks:** W11 keystone (universal vision response schema can plug into the modular structure cleanly), W15 (source-specific output variants for finals/external).

---

## Problem

Today's Pass 1 and Pass 2 prompts live in two monolithic files (`pass1Prompt.ts`, `pass2Prompt.ts`) where each builder concatenates inline string fragments — taxonomies, scoring anchors, JSON schemas, edge-case disambiguations — into one userPrefix string.

This worked fine for Wave 6 (single source: RAW HDR brackets, single output schema). It will not survive Wave 11.

Wave 11's universal vision response schema needs:
- The same Pass 1 model to score RAW brackets *and* delivered JPEGs *and* external REA listings.
- 22 per-signal measurement prompts injected as their own block.
- Source-aware framing ("you are looking at a delivered final" vs "you are looking at a RAW HDR bracket").
- Output schema swap (the universal schema replaces today's 22-field schema).

Doing this with the current monolith means rewriting the whole `buildPass1Prompt` function for each variant. Bug-prone, untested-by-construction.

W7.6 extracts every reusable fragment into a named block function, establishes a typed assembly API, and snapshot-tests the result so the *behaviour* of today's prompts is preserved while the *structure* becomes amenable to Wave 11's swap-out work.

## Architecture

### File layout

```
supabase/functions/_shared/visionPrompts/
├── blocks/
│   ├── header.ts                       # role + HDR explainer + anti-grade-inflation
│   ├── stepOrdering.ts                 # STEP 1 / STEP 2 reasoning-first contract
│   ├── streamBAnchors.ts               # rehome of streamBInjector.buildScoringReferenceBlock
│   ├── roomTypeTaxonomy.ts             # 40 room types + living_secondary note
│   ├── compositionTypeTaxonomy.ts      # 11 composition types
│   ├── vantagePoint.ts                 # alfresco/exterior_rear disambiguation
│   ├── clutterSeverity.ts              # graduated clutter levels + flag rules
│   ├── pass1OutputSchema.ts            # current 22-field JSON schema
│   ├── pass2Phases.ts                  # three-phase architecture explainer
│   ├── pass2OutputSchema.ts            # winner + slot_alternatives schema
│   ├── nearDuplicateCulling.ts         # within-room dup rule
│   ├── bedroomSplit.ts                 # master vs secondary scoring
│   ├── ensuiteSecondAngle.ts           # ensuite_primary 2-image rule
│   ├── alfrescoExteriorRear.ts         # Pass 2 eligibility rule
│   ├── slotEnumeration.ts              # render slot table from slot_definitions[]
│   └── classificationsTable.ts         # render Pass 1 results as packed text table
├── assemble.ts                         # the public API: assemble() + types
└── README.md                           # block catalogue + assembly recipes
```

`pass1Prompt.ts` and `pass2Prompt.ts` retain their public exports (`buildPass1Prompt`, `buildPass2Prompt`) but their bodies become 5-15 line assembly recipes calling block functions.

### Block API contract

Every block exports two things:

```typescript
// block name follows the file (kebab → camelCase function)
export const ROOM_TYPE_TAXONOMY_BLOCK_VERSION = 'v1.0';

export interface RoomTypeTaxonomyBlockOpts {
  // empty — taxonomy block has no inputs today
  // Wave 11 may add e.g. `{ source: 'raw' | 'finals' | 'external' }`
}

export function roomTypeTaxonomyBlock(_opts?: RoomTypeTaxonomyBlockOpts): string {
  return [
    'ROOM TYPE TAXONOMY (use exactly these values):',
    '...',
  ].join('\n');
}
```

Rules:

1. **Pure function.** No DB calls, no IO, no Date.now(). Output is a deterministic function of inputs.
2. **Returns string.** Block functions return the text fragment. The `assemble()` helper joins blocks with appropriate separators.
3. **Typed opts.** Even if the opts object is empty today, the parameter exists so future variants can add fields without breaking callers.
4. **Versioned.** Each file exports a `*_BLOCK_VERSION` const. The version bumps when the block's text changes. Versions get aggregated and stored in `composition_classifications.prompt_block_versions JSONB` for run-time provenance.
5. **Naming.** Block functions are camelCase, suffix `Block`. Files are camelCase matching the function name.

### Assembly API

```typescript
// _shared/visionPrompts/assemble.ts

export interface BlockEntry {
  name: string;                                 // e.g. 'roomTypeTaxonomy'
  version: string;                              // e.g. 'v1.0'
  text: string;                                 // the rendered block
}

export interface AssembledPrompt {
  /** System message — sets role and the reasoning-first STEP 1/STEP 2 contract. */
  system: string;
  /** User-message text part. Caller appends image content part after this for Pass 1. */
  userPrefix: string;
  /** Map of block name → version. Persist this on the run row for provenance. */
  blockVersions: Record<string, string>;
}

export function assemble(input: {
  systemBlocks: BlockEntry[];
  userBlocks: BlockEntry[];
  /** Separator between blocks in userPrefix. Defaults to '\n\n'. */
  separator?: string;
}): AssembledPrompt;
```

### Sample assembly: Pass 1 (today's behaviour)

```typescript
import { headerBlock, HEADER_BLOCK_VERSION } from './visionPrompts/blocks/header.ts';
import { stepOrderingBlock, STEP_ORDERING_BLOCK_VERSION } from './visionPrompts/blocks/stepOrdering.ts';
import { streamBAnchorsBlock, STREAM_B_ANCHORS_BLOCK_VERSION } from './visionPrompts/blocks/streamBAnchors.ts';
import { pass1OutputSchemaBlock, PASS1_OUTPUT_SCHEMA_BLOCK_VERSION } from './visionPrompts/blocks/pass1OutputSchema.ts';
import { roomTypeTaxonomyBlock, ROOM_TYPE_TAXONOMY_BLOCK_VERSION } from './visionPrompts/blocks/roomTypeTaxonomy.ts';
import { compositionTypeTaxonomyBlock, COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION } from './visionPrompts/blocks/compositionTypeTaxonomy.ts';
import { vantagePointBlock, VANTAGE_POINT_BLOCK_VERSION } from './visionPrompts/blocks/vantagePoint.ts';
import { clutterSeverityBlock, CLUTTER_SEVERITY_BLOCK_VERSION } from './visionPrompts/blocks/clutterSeverity.ts';
import { assemble } from './visionPrompts/assemble.ts';

export function buildPass1Prompt(anchors: StreamBAnchors): AssembledPrompt {
  return assemble({
    systemBlocks: [
      { name: 'header', version: HEADER_BLOCK_VERSION, text: headerBlock({ pass: 1, source: 'raw' }) },
      { name: 'stepOrdering', version: STEP_ORDERING_BLOCK_VERSION, text: stepOrderingBlock() },
    ],
    userBlocks: [
      { name: 'streamBAnchors', version: STREAM_B_ANCHORS_BLOCK_VERSION, text: streamBAnchorsBlock(anchors) },
      { name: 'pass1OutputSchema', version: PASS1_OUTPUT_SCHEMA_BLOCK_VERSION, text: pass1OutputSchemaBlock() },
      { name: 'roomTypeTaxonomy', version: ROOM_TYPE_TAXONOMY_BLOCK_VERSION, text: roomTypeTaxonomyBlock() },
      { name: 'compositionTypeTaxonomy', version: COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION, text: compositionTypeTaxonomyBlock() },
      { name: 'vantagePoint', version: VANTAGE_POINT_BLOCK_VERSION, text: vantagePointBlock() },
      { name: 'clutterSeverity', version: CLUTTER_SEVERITY_BLOCK_VERSION, text: clutterSeverityBlock() },
    ],
  });
}
```

### Sample assembly: Pass 2 (today's behaviour)

```typescript
export function buildPass2Prompt(opts: Pass2BuilderOpts): AssembledPrompt {
  return assemble({
    systemBlocks: [
      { name: 'header', version: HEADER_BLOCK_VERSION, text: headerBlock({ pass: 2, source: 'raw' }) },
      { name: 'pass2Phases', version: PASS2_PHASES_BLOCK_VERSION, text: pass2PhasesBlock() },
    ],
    userBlocks: [
      { name: 'streamBAnchors', version: STREAM_B_ANCHORS_BLOCK_VERSION, text: streamBAnchorsBlock(opts.anchors) },
      { name: 'pass2OutputSchema', version: PASS2_OUTPUT_SCHEMA_BLOCK_VERSION, text: pass2OutputSchemaBlock() },
      { name: 'slotEnumeration', version: SLOT_ENUMERATION_BLOCK_VERSION, text: slotEnumerationBlock(opts.slots) },
      { name: 'classificationsTable', version: CLASSIFICATIONS_TABLE_BLOCK_VERSION, text: classificationsTableBlock(opts.classifications) },
      { name: 'nearDuplicateCulling', version: NEAR_DUPLICATE_CULLING_BLOCK_VERSION, text: nearDuplicateCullingBlock() },
      { name: 'bedroomSplit', version: BEDROOM_SPLIT_BLOCK_VERSION, text: bedroomSplitBlock() },
      { name: 'ensuiteSecondAngle', version: ENSUITE_SECOND_ANGLE_BLOCK_VERSION, text: ensuiteSecondAngleBlock() },
      { name: 'alfrescoExteriorRear', version: ALFRESCO_EXTERIOR_REAR_BLOCK_VERSION, text: alfrescoExteriorRearBlock() },
    ],
  });
}
```

### Future-state assembly: Pass 1 with universal vision response schema (Wave 11)

```typescript
// Wave 11 swaps in the universal output schema; everything else is identical.
export function buildPass1PromptUniversal(anchors: StreamBAnchors, source: 'raw' | 'finals' | 'external'): AssembledPrompt {
  return assemble({
    systemBlocks: [
      { name: 'header', version: HEADER_BLOCK_VERSION, text: headerBlock({ pass: 1, source }) },
      { name: 'stepOrdering', version: STEP_ORDERING_BLOCK_VERSION, text: stepOrderingBlock() },
    ],
    userBlocks: [
      { name: 'streamBAnchors', version: STREAM_B_ANCHORS_BLOCK_VERSION, text: streamBAnchorsBlock(anchors) },
      // ─── swapped ──────────────────────────────────────────────────────────
      { name: 'universalVisionSchema', version: UNIVERSAL_VISION_SCHEMA_BLOCK_VERSION, text: universalVisionSchemaBlock({ source }) },
      { name: 'signalMeasurementPrompts', version: SIGNAL_MEASUREMENT_PROMPTS_BLOCK_VERSION, text: signalMeasurementPromptsBlock(opts.signals) },
      // ─── unchanged ────────────────────────────────────────────────────────
      { name: 'roomTypeTaxonomy', version: ROOM_TYPE_TAXONOMY_BLOCK_VERSION, text: roomTypeTaxonomyBlock() },
      { name: 'compositionTypeTaxonomy', version: COMPOSITION_TYPE_TAXONOMY_BLOCK_VERSION, text: compositionTypeTaxonomyBlock() },
      { name: 'vantagePoint', version: VANTAGE_POINT_BLOCK_VERSION, text: vantagePointBlock() },
      { name: 'clutterSeverity', version: CLUTTER_SEVERITY_BLOCK_VERSION, text: clutterSeverityBlock() },
    ],
  });
}
```

This is W7.6's whole point: Wave 11 is a 30-line PR that adds two new block files and one new builder. No surgery on existing code.

## Provenance: persisting block versions

The `assemble()` return includes `blockVersions: Record<string, string>`. The Pass 1/Pass 2 caller persists this to a new column:

```sql
ALTER TABLE composition_classifications
  ADD COLUMN prompt_block_versions JSONB;
```

Stored as `{"header":"v1.0","stepOrdering":"v1.0","pass1OutputSchema":"v1.2",...}`. When a downstream signal regression is observed, ops can query:

```sql
SELECT prompt_block_versions, COUNT(*)
  FROM composition_classifications
 WHERE created_at > NOW() - INTERVAL '7 days'
 GROUP BY prompt_block_versions
 ORDER BY 2 DESC;
```

…to see which block-version combo is in use across recent runs and correlate with output drift.

## Migration path

Strict three-phase rollout to keep Pass 1/Pass 2 byte-stable through the refactor:

### Phase A — Extract blocks, keep behaviour byte-identical

1. For each block listed above, create the file in `visionPrompts/blocks/` with a single function that returns a string fragment matching today's text exactly.
2. Refactor `pass1Prompt.ts` and `pass2Prompt.ts` to use `assemble()`.
3. **Snapshot test.** Add `pass1Prompt.snapshot.test.ts` and `pass2Prompt.snapshot.test.ts`. Each test calls the builder with fixed inputs (`tier_anchors = {S:5, P:8, A:9.5}`, fixed slot list, fixed classifications fixture) and asserts the output `system` + `userPrefix` are byte-identical to a checked-in `.snap` file.
4. Generate the snapshot from the **pre-refactor** code (run on the old `main`), commit it, then verify the new code produces the same snapshot. This is the regression gate — if it passes, behaviour is preserved by construction.

### Phase B — Add block versioning + provenance column

1. Migration `N_composition_classifications_prompt_block_versions.sql` adds the JSONB column (nullable, no backfill).
2. Pass 1 + Pass 2 callers persist `assembled.blockVersions` to the new column.
3. UI: a small row in the swimlane diagnostics tab showing block versions per round.

### Phase C — Wave 11 plug-in points

W7.6 ships completed at end of Phase B. Wave 11 work begins as a separate burst that adds:
- `universalVisionSchemaBlock`
- `signalMeasurementPromptsBlock`
- `buildPass1PromptUniversal`

…without modifying anything from Phases A or B.

## Tests

Mandatory:

1. **Snapshot tests** for `buildPass1Prompt` and `buildPass2Prompt` (Phase A regression gate).
2. **Per-block unit tests** at `_shared/visionPrompts/blocks/*.test.ts` — one test file per block. Each test:
   - Instantiates the block with representative opts
   - Asserts the output contains expected substrings (e.g. `roomTypeTaxonomyBlock` includes `living_secondary`)
   - Asserts the version constant matches the file's exported version
3. **Assemble test** at `_shared/visionPrompts/assemble.test.ts`:
   - blockVersions map matches the input list
   - separator defaults to `\n\n`
   - empty block list produces empty string (defensive)

Total expected tests: ~30 (16 blocks × 1-2 tests each + 2 snapshot tests + 4 assemble tests).

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| Snapshot drift mid-refactor | Generate the snapshot file from the pre-refactor `main` commit, lock it in via the Phase A regression gate. |
| Block-extraction misses a fragment | Diff `pass1Prompt.ts` and `pass2Prompt.ts` line-by-line in the PR; reviewer confirms every non-import string is in some block. |
| Block versioning becomes noise | Pin block versions at `v1.0` for the Phase A refactor (no semantic version change since text is byte-stable). Bump only when text actually changes. |
| Wave 11 needs a block this spec didn't enumerate | The block API is open — Wave 11 can add new blocks without modifying W7.6's catalogue. The catalogue is descriptive of *today's* prompts, not prescriptive of all future blocks. |

## Out of scope

- **Universal vision response schema.** That's Wave 11's job — W7.6 just establishes the plug-in point.
- **Source-specific block variants** (RAW vs finals vs external). Wave 11 + Wave 15 add these.
- **Prompt-text changes.** Phase A is a pure refactor. If a block's text needs to change for engine-quality reasons, that's a separate burst.
- **Pass 0 prompt changes.** Pass 0 (bracket detection + hard reject) is rule-based, no LLM call, no prompt to refactor.

## Effort estimate

- **Phase A** (extract + snapshot tests): 1-1.5 days
- **Phase B** (provenance column + UI): 0.5 day
- **Total W7.6**: ~2 days

## Resolutions (orchestrator, 2026-04-27)

This spec self-resolves all open architectural decisions; no Joseph
sign-off required to begin execution. The decisions below are recorded
explicitly so any reviewer can see what was chosen and why:

- **Block file naming**: camelCase function + matching filename. `_BLOCK_VERSION` constant per file. Standard, mirrors existing conventions in `_shared/`.
- **Assemble API**: explicit `BlockEntry[]` input over auto-detection from imports. Makes the order + version provenance explicit at the call site (greppable, auditable).
- **Snapshot strategy**: byte-identical output is the regression gate. Generated from pre-refactor `main`. No tolerance for "minor whitespace changes". If a refactor introduces a whitespace change, fix the refactor — don't relax the snapshot.
- **Provenance column shape**: single JSONB column (`prompt_block_versions`) over a sidecar table. Trivial to query, cheap to write, no JOIN cost on the read path. If this becomes hot we can promote to a sidecar table later.
- **Migration phasing**: A → B → C. Keeps each phase's diff small and reviewable.
- **Pass 0 exclusion**: confirmed scope-out. Pass 0 is exiftool + PIL-based, no LLM prompt to refactor.

## Pre-execution checklist

- [x] Architecture self-resolved by orchestrator (above)
- [x] No dependency on in-flight W7.4 / W7.5 / W7.8 burst (all touch different files)
- [x] No dependency on W7.7 sidecar
- [x] Phase A regression gate strategy documented (snapshot from pre-refactor main)
- [ ] Migration number reserved (will be `338_composition_classifications_prompt_block_versions.sql` once W7.5 takes 336 + W7.8 takes 337; orchestrator reserves at integration time)
- [ ] Executor task: enumerate every non-import string in `pass1Prompt.ts` + `pass2Prompt.ts` and confirm it lands in exactly one block

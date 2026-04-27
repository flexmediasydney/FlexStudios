# visionPrompts/ — composable Pass 1 & Pass 2 prompt blocks

Wave 7 P1-10 (W7.6) refactor of the previously-monolithic `pass1Prompt.ts` and
`pass2Prompt.ts` into 16 named, versioned, snapshot-tested blocks plus a typed
`assemble()` API.

See `docs/design-specs/W7-6-vision-prompt-blocks.md` for the full design rationale.

## Block catalogue

| File | Used in | Purpose |
| --- | --- | --- |
| `blocks/header.ts` | system (P1, P2) | Role + HDR explainer + anti-grade-inflation framing |
| `blocks/stepOrdering.ts` | system + user (P1) | STEP 1 / STEP 2 reasoning-first contract |
| `blocks/streamBAnchors.ts` | user (P1, P2) | Stream B Tier S/P/A score anchor reference |
| `blocks/roomTypeTaxonomy.ts` | user (P1) | 40 room types + living_secondary disambiguation |
| `blocks/compositionTypeTaxonomy.ts` | user (P1) | 11 composition types |
| `blocks/vantagePoint.ts` | user (P1) | alfresco/exterior_rear disambiguation rule |
| `blocks/clutterSeverity.ts` | user (P1) | Graduated clutter levels + flag rule + output reminder |
| `blocks/pass1OutputSchema.ts` | user (P1) | Current 22-field JSON schema |
| `blocks/pass2Phases.ts` | system (P2) | Three-phase architecture explainer |
| `blocks/pass2OutputSchema.ts` | user (P2) | Instructions + winner-with-alternatives JSON schema |
| `blocks/nearDuplicateCulling.ts` | user (P2) | Within-room near-duplicate rule (spec L7) |
| `blocks/bedroomSplit.ts` | user (P2) | master vs secondary bedroom scoring criteria |
| `blocks/ensuiteSecondAngle.ts` | user (P2) | ensuite_primary 2-image angle rule (spec L19) |
| `blocks/alfrescoExteriorRear.ts` | user (P2) | exterior_rear eligibility rule (spec L6) |
| `blocks/slotEnumeration.ts` | user (P2) | SHORTLISTING CONTEXT + SLOT REQUIREMENTS rendering |
| `blocks/classificationsTable.ts` | user (P2) | Pass 1 results as packed text table |

## Block API contract

Every block exports two named symbols:

```typescript
export const HEADER_BLOCK_VERSION = 'v1.0';

export interface HeaderBlockOpts {
  pass: 1 | 2;
  source?: 'raw' | 'finals' | 'external';
}

export function headerBlock(opts: HeaderBlockOpts): string {
  return ...;
}
```

Rules:

1. **Pure function.** No DB calls, no IO, no `Date.now()`. Output is a deterministic function of inputs.
2. **Returns string.** Block functions return the text fragment. The `assemble()` helper joins blocks with the configured separator (default `\n\n`).
3. **Typed opts.** Even if the opts object is empty today, the parameter exists so future variants can add fields without breaking callers.
4. **Versioned.** Each file exports a `*_BLOCK_VERSION` constant. Bump when the block's text changes. Versions get aggregated and persisted to `composition_classifications.prompt_block_versions JSONB` for run-time provenance.

## Snapshot regression gate

`__snapshots__/pass1Prompt.snap.txt` and `__snapshots__/pass2Prompt.snap.txt`
were generated from the **pre-refactor** monolithic prompt builders (commit
`a870bad` baseline) using the fixtures in `__snapshots__/_fixtures.ts`. The
snapshot tests
(`pass1Prompt.snapshot.test.ts`, `pass2Prompt.snapshot.test.ts`) re-run the
NEW modular builders against the same fixtures and assert byte-equality
against the snapshot. **Do not modify the `.snap.txt` files** — they are the
regression gate. If a refactor breaks them, the refactor is wrong.

To regenerate (only when text contents intentionally change), run:

```bash
SUPABASE_URL=stub SUPABASE_SERVICE_ROLE_KEY=stub \
  /Users/josephsaad/.deno/bin/deno run --allow-write --allow-env --no-check \
  supabase/functions/_shared/visionPrompts/__snapshots__/_generate.ts
```

## Sample assemblies

See the inline source comments in `pass1Prompt.ts` and `pass2Prompt.ts` for the
real recipes. The Wave 11 universal-vision-schema variant is sketched in the
W7.6 design spec and will land as a thin builder atop these blocks (no surgery
on existing code).

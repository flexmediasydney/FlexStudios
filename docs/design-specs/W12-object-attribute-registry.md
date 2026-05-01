# W12 — Object/Attribute Registry + AI Suggestions — Design Spec

**Status:** ⚙️ **Foundation shipped 2026-05-01.** 4 tables + 191-entry seed + canonical-rollup edge fn + object-registry-admin curation fn + canonicalRegistryBlock prompt helper deployed and smoke-tested against the Saladine round (211/414 obs auto-normalised at 0.9477 avg cosine similarity, 191 candidates queued).
**Backlog ref:** P2-2 + P2-3.
**Wave plan ref:** Wave 12 — engine grows institutional memory. Subsumes W12.1-W12.8 from `docs/WAVE_PLAN.md`.
**Companion spec:** `docs/design-specs/W12-trigger-thresholds.md` covers the AI-suggestion threshold defaults (W12.7-W12.8). This spec covers the full wave: schema, extractor worker, manual-trigger normalisation, discovery queue UI, and AI-suggestion plumbing. The two specs are intended to be read together at execution time.

---

## ⚙️ Implementation status (2026-05-01)

**Shipped:**
- ✅ **Migration 380** (`380_w12_object_registry.sql.draft`, applied as `380_w12_object_registry`) — pgvector extension + 4 tables (`object_registry` with **5-level hierarchy** `level_0_class → level_4_detail` + `parent_canonical_id` + `aliases TEXT[]` + `signal_room_type` + `signal_confidence`; `raw_attribute_observations`; `attribute_values`; `object_registry_candidates`) + RLS (master_admin SELECT/UPDATE; service_role bypass) + HNSW vector index on `embedding_vector` + `canonical_nearest_neighbors(embedding, top_n)` RPC for cosine top-N lookup.
- ✅ **Migration 381** (`381_w12_canonical_seed.sql.draft`, applied via Management API SQL) — **191 curated canonical entries** with full 5-level hierarchy, signal_room_type populated for 151/191, aliases tuned to real Saladine + iter-5 vocabulary. Embeddings backfilled (191/191 populated via Gemini `gemini-embedding-001` @ 1536 dim).
- ✅ **`canonical-rollup`** (`supabase/functions/canonical-rollup/index.ts`, deployed) — Stage 1.5 normalisation. POST `{round_id, [group_id], [key_elements[]], [limit]}`. Pre-embeds in parallel batches of 8, top-5 nearest match via the HNSW index, threshold-splits per spec (≥0.92 auto-normalise; 0.75-0.92 queue; <0.75 new observation). Idempotent via dedup on (round, group, raw_label). Per-call cap (default 60, max 200) keeps under the 150s edge-fn timeout.
- ✅ **`object-registry-admin`** (`supabase/functions/object-registry-admin/index.ts`, deployed) — master_admin curation router. Subcommands: `list_candidates`, `approve_candidate`, `reject_candidate`, `merge_candidates`, `defer_candidate`, `auto_archive`, `backfill_embeddings`.
- ✅ **`canonicalRegistryBlock`** (`supabase/functions/_shared/visionPrompts/blocks/canonicalRegistryBlock.ts`) — W7.6 composable prompt block. Renders top-N (default 200) canonicals as the W11.7 spec's "CANONICAL FEATURE REGISTRY" text block. **Helper is live but NOT YET WIRED into Stage 1's prompt — Agent 2 owns `shortlisting-shape-d/index.ts` and will pick this up next session.**
- ✅ **Smoke test** — Saladine round `3ed54b53-9184-402f-9907-d168ed1968a4` (42 classifications) processed end-to-end. 414 raw_attribute_observations created, 211 auto-normalised at 0.9477 avg similarity, 203 queued/new (191 unique candidates after dedup). Top observed: `obj_blinds_venetian_white` (market_frequency=20). Cost ~$0.04 for the round.

**Pending (out of scope for this dispatch):**
- 🔜 **Stage 1 prompt integration** — Agent 2 wires `canonicalRegistryBlock()` into the Stage 1 system prompt (top 200 by `market_frequency`).
- 🔜 **Stage 4 prompt integration** — same block, same import, in `shortlisting-shape-d-stage4/index.ts` (Agent 1).
- 🔜 **Frontend admin UI** — Settings → Engine → Object Registry. Browse + Discovery Queue + Normalisation tabs (Agent 4 may scaffold; full UI later).
- 🔜 **`shortlisting-suggestion-engine`** edge fn (W12.7-W12.8) — slot + room-type AI suggestions (separate dispatch).
- 🔜 **W13a/b/c population** — pulse + finals goldmines write into `raw_attribute_observations` (separate waves).
- 🔜 **`attribute_value` candidate approval** — `object-registry-admin.approve_candidate` only handles object candidates in v1; attribute_value approval returns 501 until v2.

**Dependencies:**
- **Wave 11 must land first** — universal vision response defines the canonical-key shape (`OBJECT_*` keys, `observed_objects` JSONB array shape, `attribute_observations` JSON shape). Pre-W11, the engine doesn't emit per-object structured output; W12's extractor would have nothing to consume.
- **Wave 11.7 (unified architecture)** — under unified, observed_objects are emitted directly by the single Opus call (cleaner cross-image consistency than the legacy two-pass split would have produced). W12's normalisation pipeline reads `composition_classifications.observed_objects` regardless of which architecture produced it.
- **W7.6 ✅ shipped** — composable prompt blocks make adding the `objectsAndAttributes` block to the unified prompt a clean drop-in.
- **No W8 dependency** — W12 doesn't read tier configs; the registry is tier-agnostic. (W14 calibration will join across; not a W12 concern.)

---

## ⚡ Architectural alignment (2026-04-29)

W11.7's unified architecture **improves W12's substrate quality** without changing W12's schema or extractor logic:

- **Cross-image consistency**: today's hypothetical Pass 1 would name a kitchen benchtop "stone" in one image, "Caesarstone" in another, "engineered stone" in a third — leaving W12's normalisation pipeline to merge synonyms via cosine similarity. Under W11.7, Opus sees all kitchen images at once and emits ONE consistent canonical name for the same surface. **W12's normalisation does less work; the registry grows cleaner faster.**
- **The unified call's prompt explicitly receives the canonical registry** as context (top 200 entries by `market_frequency`). Cross-project knowledge feeds back into the engine's prompt — the closed-loop ethos compounds across projects.
- **Observation provenance unchanged**: `raw_attribute_observations.source_type` distinguishes `internal_raw` (unified call output) from `internal_finals`, `pulse_listing`, etc. W11.7 just changes how `internal_raw` rows get produced; the table shape is unchanged.

**Unblocks:**
- **W13b (pulse description goldmine)** — needs `object_registry`, `attribute_values`, `raw_attribute_observations` tables to write into. The 28k pulse extraction sits idle until W12 schema lands.
- **W13c (floorplan OCR goldmine)** — same.
- **W14 (calibration session)** — the editor-vs-AI disagreement diff joins against `object_registry.market_frequency` to validate the AI suggestion engine (per W14.5 in the wave plan).
- **W15 (Pulse vision program)** — cross-source competitor analysis ("which features do competitors photograph that we miss?") reads from a populated registry.

---

## Problem

The shortlisting engine emits Pass 1 classifications (`composition_classifications`) one row per composition, but the institutional memory of "what objects appear in this property" is locked inside an unstructured `analysis` paragraph + a free-form `key_elements TEXT[]`. There is no canonical vocabulary, no cross-shoot frequency table, no way to ask "how often do we see kitchen islands in $3M+ Mosman properties?" because the data is text in one column per row.

Three concrete consequences:

1. **No grounding for AI suggestions.** When Pass 2 emits `proposed_slot_id: 'balcony_terrace_hero'` for a composition because no existing slot fits, that signal sits in `shortlisting_events` and is never aggregated. The model's repeated suggestions across rounds — strong evidence of a real taxonomy gap — never surface for admin review.

2. **No cross-shoot vocabulary normalisation.** One round's `key_elements` includes "marble bench top"; another's says "marble benchtops"; a third says "Calacatta marble counter". The engine treats these as three independent strings. A canonical `object_registry` row for `OBJECT_BENCHTOP` with `attribute_values` for material/colour/finish would unify them.

3. **No market-frequency baseline.** When an editor sees a property with a wine cellar and asks "is this rare or common at this price point?", the answer requires aggregating across hundreds of rounds. Without a structured registry, the question is unanswerable.

**The fix:** lift `key_elements` + `observed_objects` (W11) into a normalised registry. Each Pass 1 emits raw observations into `raw_attribute_observations`; a manual-trigger normalisation batch (per Joseph's 2026-04-27 directive: same pattern as W13a/W13b — no autonomous cron) merges raw observations into `object_registry` rows via cosine similarity. The discovery queue UI surfaces ambiguous candidates for human review. The AI suggestion engine cross-references the registry against `pass2_slot_suggestion` events to propose new slot definitions.

This is the "engine grows institutional memory" wave. The registry compounds: every shoot enriches it; every enrichment improves Pass 1's grounding; better grounding produces better Pass 2 decisions; better decisions produce richer training_examples.

---

## Architecture

### Section 1 — Schema (mig 345)

Four tables. Each carries full provenance so re-extraction + audit are clean.

#### `object_registry`

Canonical objects observed in property compositions. The right level of granularity is "things a buyer or photographer would name as distinct" — `OBJECT_KITCHEN_ISLAND` not `OBJECT_KITCHEN > island`; `OBJECT_WINE_CELLAR` not `OBJECT_KITCHEN > storage > wine_cellar`. Flat, not nested.

```sql
CREATE TABLE object_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_label TEXT UNIQUE NOT NULL,                -- e.g. 'kitchen_island', 'wine_cellar', 'stairwell'
  canonical_label_embedding VECTOR(1536),               -- pgvector; OpenAI text-embedding-3-small dim
  category TEXT,                                        -- 'fixture' | 'appliance' | 'feature' | 'material' | 'spatial'
  market_frequency INT NOT NULL DEFAULT 0,              -- # of observations across all rounds + pulse
  first_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'canonical'
    CHECK (status IN ('canonical', 'deprecated', 'merged')),
  merged_into_id UUID REFERENCES object_registry(id),   -- when status='merged', points at the survivor
  description TEXT,                                      -- short human-readable definition
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_object_registry_status
  ON object_registry(status) WHERE status = 'canonical';
CREATE INDEX idx_object_registry_freq
  ON object_registry(market_frequency DESC) WHERE status = 'canonical';
CREATE INDEX idx_object_registry_category
  ON object_registry(category) WHERE status = 'canonical';

-- pgvector index for similarity search:
CREATE INDEX idx_object_registry_embedding
  ON object_registry USING hnsw (canonical_label_embedding vector_cosine_ops)
  WHERE status = 'canonical';
```

**`canonical_label` shape:** snake_case lowercase, no spaces, no leading category prefix (the prefix is in the `category` column). e.g. `kitchen_island`, NOT `OBJECT_KITCHEN_ISLAND` (the W11 prompt uses the prefix for clarity to the model; the DB stores the snake_case form for cleaner joins).

**`canonical_label_embedding`:** pgvector at dim 1536 (OpenAI `text-embedding-3-small` native). Per Q1 below: orchestrator self-resolves on dim choice — see R3 below for why 1536 (not the spec-suggested 384).

**`market_frequency`:** denormalised counter incremented by the normalisation batch. Read by W12.7 AI-suggestion thresholds + W15 competitor analysis. Indexed DESC for "what are the top 50 most-observed objects" queries.

**`status` lifecycle:** `canonical` (active), `deprecated` (admin retired the row but it stays for audit), `merged` (admin merged it into another row; `merged_into_id` points at the survivor; old observations remain pointed at this row for provenance).

**Why no `synonyms TEXT[]` column?** Synonyms are observed at extraction time, not declared upfront. The registry's job is to be the canonical anchor; the synonym graph emerges from `raw_attribute_observations.raw_label` distribution. If admin needs an explicit synonym surface, that's a follow-up extension to the discovery UI.

#### `raw_attribute_observations`

Per-observation log of "the model emitted X for round Y group Z". Source-aware (internal_raw, internal_finals, pulse_listing) so the registry can answer cross-source questions.

```sql
CREATE TABLE raw_attribute_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_id UUID REFERENCES composition_groups(id) ON DELETE CASCADE,
  raw_label TEXT NOT NULL,                              -- as the model wrote it
  raw_label_embedding VECTOR(1536),                      -- computed at insert time for normalisation reuse
  normalised_to_object_id UUID REFERENCES object_registry(id),
  normalised_at TIMESTAMPTZ,
  similarity_score NUMERIC(5,4),                         -- final cosine similarity at normalisation time
  confidence NUMERIC(4,3),                               -- model's confidence on this observation (0-1)
  source_type TEXT NOT NULL
    CHECK (source_type IN ('internal_raw', 'internal_finals', 'pulse_listing', 'pulse_floorplan')),
  source_excerpt TEXT,                                   -- the sentence/paragraph the observation came from (pulse) or analysis fragment (internal)
  attributes JSONB DEFAULT '{}'::jsonb,                  -- model's attribute hints attached to this observation
  -- For pulse observations:
  pulse_listing_id UUID REFERENCES pulse_listings(id) ON DELETE SET NULL,
  -- Auditing:
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_raw_obs_pending_normalisation
  ON raw_attribute_observations(created_at)
  WHERE normalised_to_object_id IS NULL;
CREATE INDEX idx_raw_obs_object
  ON raw_attribute_observations(normalised_to_object_id)
  WHERE normalised_to_object_id IS NOT NULL;
CREATE INDEX idx_raw_obs_round
  ON raw_attribute_observations(round_id) WHERE round_id IS NOT NULL;
CREATE INDEX idx_raw_obs_pulse
  ON raw_attribute_observations(pulse_listing_id) WHERE pulse_listing_id IS NOT NULL;
```

**Why `(round_id, group_id)` AND `pulse_listing_id` as separate FKs vs a polymorphic key?** Postgres-friendly. Each row points at exactly one source; the FK that's NULL for the other source type is fine. Constraint: `CHECK ((round_id IS NOT NULL) <> (pulse_listing_id IS NOT NULL))` enforces "exactly one source FK populated".

**`raw_label_embedding`:** computed at insert time by the extractor worker (per §2). Storing the embedding prevents re-embedding the same `raw_label` at every normalisation pass; the column carries enough state to do similarity match without additional API calls.

**`source_excerpt`:** for pulse observations, this is the description fragment the observation was drawn from. For internal observations, it's the relevant slice of the Pass 1 `analysis` paragraph (or the full `key_elements` array entry that produced the observation). Auditable provenance: any observation can be traced back to its source text.

**`attributes JSONB`:** model's hints at observation time — `{"material": "marble", "edge_style": "waterfall"}`. Normalised into `attribute_values` (next table) by the discovery queue admin or auto-promoted at high confidence.

#### `attribute_values`

Attribute key-value pairs keyed to `object_registry`. e.g. `kitchen_island.edge_style=waterfall`, `pool.heating_type=heated`, `pool.water_treatment=saltwater`.

```sql
CREATE TABLE attribute_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES object_registry(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL,                           -- 'edge_style', 'material', 'colour', 'heating_type'
  value_text TEXT NOT NULL,                              -- 'waterfall', 'caesarstone', 'matte_black', 'heated'
  value_embedding VECTOR(1536),
  observation_count INT NOT NULL DEFAULT 0,              -- # of times this attribute_value pair was observed
  status TEXT NOT NULL DEFAULT 'canonical'
    CHECK (status IN ('canonical', 'deprecated', 'merged')),
  merged_into_id UUID REFERENCES attribute_values(id),
  first_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (object_id, attribute_key, value_text)
);

CREATE INDEX idx_attribute_values_object
  ON attribute_values(object_id) WHERE status = 'canonical';
CREATE INDEX idx_attribute_values_key
  ON attribute_values(attribute_key) WHERE status = 'canonical';
CREATE INDEX idx_attribute_values_freq
  ON attribute_values(object_id, observation_count DESC) WHERE status = 'canonical';
CREATE INDEX idx_attribute_values_embedding
  ON attribute_values USING hnsw (value_embedding vector_cosine_ops)
  WHERE status = 'canonical';
```

**Why object-keyed and not standalone?** Attributes only make sense in the context of an object. `material=marble` is meaningless without "marble *of what*". The `(object_id, attribute_key, value_text)` UNIQUE composite is the natural identity.

**`observation_count`:** denormalised, bumped by the normalisation batch when a `raw_attribute_observations.attributes` JSONB entry resolves to this row. Drives the discovery UI's "frequent attribute values per object" view.

#### `object_registry_candidates`

The discovery queue. Holds proposed canonical objects + attributes that the normalisation batch couldn't auto-resolve.

```sql
CREATE TABLE object_registry_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('object', 'attribute_value')),
  proposed_canonical_label TEXT NOT NULL,                -- 'wine_cellar', or for attribute: 'edge_style:waterfall'
  proposed_category TEXT,                                 -- 'fixture' | 'appliance' | ... (object only)
  -- For attribute candidates:
  proposed_object_id UUID REFERENCES object_registry(id),
  proposed_attribute_key TEXT,
  proposed_value_text TEXT,
  -- Similarity context:
  similarity_to_existing JSONB,                          -- {"top_match_id": "...", "score": 0.85, "label": "...", "alternates": [...]}
  observed_count INT NOT NULL DEFAULT 1,
  sample_observation_ids UUID[],                         -- up to 10 samples of raw_attribute_observations.id for review
  sample_excerpts TEXT[],                                -- truncated source_excerpts for quick scan
  -- Workflow:
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'auto_archived')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  approved_object_id UUID REFERENCES object_registry(id),
  approved_attribute_value_id UUID REFERENCES attribute_values(id),
  merged_into_object_id UUID REFERENCES object_registry(id),
  merged_into_attribute_value_id UUID REFERENCES attribute_values(id),
  -- Auto-archive:
  first_proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archive_at TIMESTAMPTZ,                                 -- computed at insert: first_proposed_at + 14 days (Q3)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (candidate_type, proposed_canonical_label, proposed_object_id, proposed_attribute_key)
);

CREATE INDEX idx_candidates_pending
  ON object_registry_candidates(observed_count DESC, last_proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX idx_candidates_archive
  ON object_registry_candidates(archive_at) WHERE status = 'pending';
```

**Why one table for both object and attribute candidates?** They share the workflow (pending → review → approve/reject/merge). One reviewer UI handles both via the `candidate_type` discriminator. Reduces table count + admin UX surface area.

**`auto_archived` status:** per Q3 below: pending candidates older than 14 days flip to `auto_archived` (not deleted — kept for audit). The `archive_at` column is set at insert (`first_proposed_at + 14 days`), checked by a manual-trigger archival batch (same pattern as the normalisation batch — no autonomous cron). If admin re-observes the candidate after archive, a new row is created (the unique constraint is satisfied because the previous row's `status` is no longer `pending` → effectively a different candidate from the unique index's perspective is NOT achieved by status alone, see R5 below for the orchestrator's resolution).

**`similarity_to_existing` JSONB shape:**
```jsonc
{
  "top_match_id": "uuid-of-closest-canonical",
  "top_match_label": "kitchen_island",
  "top_match_score": 0.85,
  "alternates": [
    {"id": "...", "label": "kitchen_bench", "score": 0.78},
    {"id": "...", "label": "kitchen_breakfast_bar", "score": 0.72}
  ]
}
```

Surfaced in the discovery UI so the reviewer sees "is this a synonym for an existing canonical?" without further DB joins.

### Section 2 — Pass 1 integration: `objectsAndAttributes` block + extractor worker

#### Pass 1 prompt block (per W7.6 composable)

A new `_shared/visionPrompts/blocks/objectsAndAttributes.ts` block instructs Pass 1 to emit, alongside the existing per-row classification, a structured `observed_objects` array:

```jsonc
{
  "observed_objects": [
    {
      "canonical_key_proposed": "kitchen_island" | null,
      "raw_label": "designer Caesarstone island bench",
      "confidence": 0.95,
      "attributes": {"material": "caesarstone", "edge_style": "waterfall"},
      "source_excerpt": "<analysis fragment that produced this observation>"
    },
    ...
  ],
  "attribute_observations": [
    {
      "attribute_key": "aircon_type",
      "attribute_value": "ducted_reverse_cycle",
      "confidence": 0.88,
      "source_excerpt": "<analysis fragment>"
    },
    ...
  ]
}
```

The model is provided (in the prompt) with the active list of canonical objects + categories from `object_registry WHERE status='canonical'` (top 200 by market_frequency, to keep the prompt size manageable). Per W11's universal vision response pattern, this list is part of the prompt block's render input — re-rendered per round at ingest time.

#### `shortlisting-attribute-extractor` (new edge fn)

Runs after Pass 1 completes for a round. Reads `composition_classifications.observed_objects + attribute_observations` (added as JSONB columns by W11; W12 doesn't add them — W11 owns the schema for those columns), inserts `raw_attribute_observations` rows.

```typescript
// supabase/functions/shortlisting-attribute-extractor/index.ts (new)

interface ExtractRequest {
  round_id: string;
}

// Per group classification:
//   1. SELECT composition_classifications WHERE round_id = $1
//   2. For each row's observed_objects[]:
//        - INSERT raw_attribute_observations with source_type='internal_raw' (or internal_finals if W13a backfill)
//        - Compute raw_label_embedding via OpenAI text-embedding-3-small
//   3. For each row's attribute_observations[]:
//        - Same pattern; raw_label = "<attribute_key>:<attribute_value>"
//   4. Emit shortlisting_events 'attribute_extraction_completed' with counts
//
// Idempotency: re-running on the same round is safe via unique constraint
// (round_id, group_id, raw_label) on raw_attribute_observations — see migration §3.
//
// Auth: service_role (called by dispatcher chain post-Pass-1)
```

**Trigger model:** the dispatcher's pass-completion handler enqueues an `attribute-extract` job in `shortlisting_jobs` after Pass 1 finishes. The extractor reads, processes, marks the job complete. No new dispatcher logic — same pattern as the existing pass1/pass2 chain.

**Embedding cost:** OpenAI text-embedding-3-small at $0.020/1M input tokens. Per observation ~5-10 tokens. Per round ~50-200 observations. Per-round embedding cost: ~$0.0001. Negligible compared to Pass 1's vision spend.

### Section 3 — Manual-trigger normalisation batch (W12.5)

**Per Joseph 2026-04-27:** same pattern as W13a/W13b — no autonomous cron, no nightly batch. Joseph fires the normalisation batch manually when he wants observations processed. The system never normalises on its own.

#### Edge fn `normalise-attribute-observations`

POST `{ limit?: number, source_type_filter?: string, dry_run?: boolean }`.

```typescript
// supabase/functions/normalise-attribute-observations/index.ts (new)
// Master_admin only.

// 1. SELECT raw_attribute_observations
//    WHERE normalised_to_object_id IS NULL
//    AND raw_label_embedding IS NOT NULL
//    [optional: AND source_type = $1]
//    ORDER BY created_at ASC
//    LIMIT $2 (default 1000; configurable up to 5000)
//
// 2. For each row:
//    a. Cosine-compare raw_label_embedding against object_registry.canonical_label_embedding
//       via pgvector: SELECT id, canonical_label,
//                     1 - (canonical_label_embedding <=> $1) AS similarity
//                     FROM object_registry WHERE status = 'canonical'
//                     ORDER BY canonical_label_embedding <=> $1 LIMIT 5
//    b. If top similarity ≥ 0.92:
//         UPDATE raw_attribute_observations SET
//           normalised_to_object_id = top_match.id,
//           normalised_at = NOW(),
//           similarity_score = top_match.similarity
//         UPDATE object_registry SET
//           market_frequency = market_frequency + 1,
//           last_observed_at = NOW()
//         WHERE id = top_match.id
//    c. Elif top similarity in [0.75, 0.92):
//         INSERT object_registry_candidates (or upsert by unique key:
//         increment observed_count, append to sample_observation_ids,
//         update last_proposed_at)
//         WITH similarity_to_existing = JSONB blob (top + alternates)
//    d. Else (top similarity < 0.75):
//         Same as 'c' but similarity_to_existing's top score reflects "no close match".
//         Reviewer can choose: "approve as new canonical" OR "merge into top_match".
//
// 3. Process attribute_observations same way against attribute_values
//    (object_id resolved from the parent observed_object's normalised_to_object_id;
//    if parent isn't normalised yet, defer the attribute observation to the next batch).
//
// 4. Return: { processed, auto_normalised, queued_for_review, deferred, elapsed_ms }
```

**Thresholds (per `W12-trigger-thresholds.md`):**
- ≥ 0.92 → auto-normalise
- 0.75 – 0.92 → discovery queue
- < 0.75 → discovery queue with "no close match" hint

**Throughput:** pgvector HNSW index makes per-observation lookup sub-millisecond at the seed scale (~200 canonicals). At W13b's 28k pulse extractions seeded into raw_attribute_observations, the batch processes 1000 rows in ~2-5s.

**Idempotency:** the WHERE clause filters `normalised_to_object_id IS NULL`, so re-running is a no-op for already-normalised rows. The batch is safe to invoke repeatedly.

**Cost:** zero (pure DB; embeddings already computed at extraction time).

#### Admin UI for the normalisation batch

`Settings → Engine → Object Registry → Normalisation` (master_admin only):
- Stats: pending observations, latest normalisation run, % auto-normalised vs queued for review
- Run controls (manual-trigger only — no cron):
  - Limit input (default 1000, max 5000)
  - Source type filter dropdown (`internal_raw`, `internal_finals`, `pulse_listing`, `pulse_floorplan`, or "all")
  - Dry-run toggle (returns counts without writing)
  - "Run normalisation" button
- Recent runs table: triggered_at, source_type, processed, auto_normalised, queued_for_review, elapsed

Joseph alone decides when to run. The system never auto-normalises.

### Section 4 — Discovery queue UI (W12.6)

`Settings → Engine → Object Registry → Discovery Queue` (master_admin/admin):

```
Pending: 47   Last 7 days: 12 approved · 3 rejected · 2 merged

[Filter: Object | Attribute | All ▼]   [Sort: Frequency ↓ ▼]   [Search: ____]

┌────────────────────────────────────────────────────────────────────────┐
│ Candidate: butler_pantry                              status: pending  │
│ Observed: 8 times across 6 rounds + 12 pulse listings                  │
│ Top match: pantry (0.81 similarity)                                    │
│ Alternates: kitchen_island (0.74), storage_walk_in (0.71)              │
│                                                                        │
│ Sample excerpts:                                                       │
│   "designer Caesarstone kitchen with butler's pantry"                  │
│   "spacious kitchen leading to butler's pantry with separate sink"     │
│   ...                                                                  │
│                                                                        │
│ [Approve as new canonical] [Merge into pantry] [Reject] [Defer]        │
└────────────────────────────────────────────────────────────────────────┘
... 46 more cards ...
```

**Approve as new canonical:** opens a modal — admin enters/confirms canonical_label, picks category, optionally adds description. Save inserts into `object_registry`, flips candidate `status='approved'` + sets `approved_object_id`. Backfill path: also flip all `raw_attribute_observations` matching the candidate's similarity profile to point at the new row (or leave them un-normalised — admin choice via a checkbox; default leave un-normalised, the next normalisation batch picks them up via the new canonical).

**Merge into pantry:** admin confirms; flips candidate `status='merged'`, sets `merged_into_object_id`. Backfill path: also flip the matching `raw_attribute_observations` to point at the surviving canonical.

**Reject:** admin gives a reason; flips `status='rejected'`. The matching observations stay un-normalised (they'll get re-queued on the next normalisation batch unless the canonical landscape has shifted; admin can also flip `status='deprecated'` on observations they don't want re-surfaced, but that's an out-of-scope follow-up).

**Defer:** flips `status='auto_archived'` early — admin says "not now, surface later if it comes back". The unique constraint allows the same proposal to be re-created if observations re-accumulate.

**Auto-archive:** rows with `status='pending' AND archive_at < NOW()` flip to `auto_archived` via the manual-trigger archival batch (admin runs from the UI; no cron). Same UI page has an "Archive aged candidates" button.

### Section 5 — AI suggestion engine (W12.7-W12.8)

This is where the registry pays off. Today, Pass 2 emits `proposed_slot_id` events to `shortlisting_events` when no existing slot fits a composition the model thinks is shortlist-worthy. Those events sit unaggregated. W12.7 reads them.

#### `shortlisting-suggestion-engine` (new edge fn, manual-trigger)

POST `{ window_days?: number }` (default 90).

```typescript
// supabase/functions/shortlisting-suggestion-engine/index.ts (new)
// Master_admin only.

// 1. Slot suggestions (per W12-trigger-thresholds.md):
//    SELECT proposed_slot_id, COUNT(DISTINCT round_id) as round_count,
//           COUNT(*) as total_proposals,
//           ARRAY_AGG(DISTINCT round_id) as sample_round_ids,
//           ARRAY_AGG(reasoning) as sample_reasoning
//    FROM shortlisting_events
//    WHERE event_type = 'pass2_slot_suggestion'
//    AND created_at >= NOW() - $1 * INTERVAL '1 day'
//    GROUP BY proposed_slot_id
//    HAVING COUNT(DISTINCT round_id) >= 5
//    AND proposed_slot_id NOT IN (SELECT slot_id FROM shortlisting_slot_definitions WHERE is_active);
//
//    Upsert into shortlisting_slot_suggestions (table from W12-trigger-thresholds.md spec).
//
// 2. Room-type suggestions (forced fallback, key_elements clusters, override patterns):
//    Cross-references object_registry.market_frequency + composition_classifications.room_type_confidence.
//    Per W12-trigger-thresholds.md trigger sources 1-3 + thresholds.
//
//    Upsert into shortlisting_room_type_suggestions.
//
// 3. Object/registry-driven slot proposals (NEW in W12.8):
//    For high-frequency objects in object_registry that don't appear as
//    eligible_room_types in any active slot:
//    SELECT or.canonical_label, or.market_frequency, or.id
//    FROM object_registry or
//    WHERE or.status = 'canonical'
//    AND or.market_frequency >= 20
//    AND NOT EXISTS (
//      SELECT 1 FROM shortlisting_slot_definitions sd
//      WHERE sd.is_active AND or.canonical_label = ANY(sd.eligible_room_types)
//    );
//
//    Surface as a slot suggestion with hint "objects of this canonical appear N
//    times across the registry; admin should consider adding a slot definition".
```

The output is two lists: pending slot suggestions + pending room-type suggestions. Admin reviews via a new `Settings → Engine → AI Suggestions` page (per W12-trigger-thresholds.md spec section "Admin UI").

**Trigger model:** manual-trigger same as normalisation batch. Admin runs the engine when they want suggestions refreshed. No autonomous cron. Cost: zero (pure DB read + write).

### Section 6 — pgvector extension setup

The migration enables pgvector if not already installed:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Verified safe: pgvector is supported on Supabase free tier and above. The mig 230 (`drone_command_center`) doesn't enable it; this is W12's first usage. Edge functions that invoke pgvector do so through SQL only — no client-side library needed.

**Embedding generation:** edge functions call OpenAI's `text-embedding-3-small` API. New edge fn `_shared/embeddings.ts` wraps the call with retry + cost logging. API key reuses `OPENAI_API_KEY` (already set per other edge fns).

Per Q1 below: orchestrator self-resolves on dim 1536 (R3) — pgvector handles it, the storage cost is bounded (~6KB/embedding × 200 canonicals = ~1.2MB at scale; per-observation 6KB × 28k pulse + ongoing rounds = ~170MB at full scale, fine for Supabase Postgres).

### Section 7 — RLS

```sql
-- All four tables: master_admin/admin/manager/employee read; insert/update gated to master_admin/admin.

ALTER TABLE object_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_attribute_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_registry_candidates ENABLE ROW LEVEL SECURITY;

-- (Standard pattern matching mig 295's shortlisting_benchmark_results — copied verbatim with table name swap.)
```

`raw_attribute_observations.source_excerpt` may contain agent listing copy fragments — restrict pulse-sourced rows to master_admin/admin only? Punt to follow-up if pulse data sensitivity becomes an issue. v1: same RLS as the other tables (manager/employee can see).

---

## Migration `345_object_attribute_registry.sql`

```sql
-- Wave 12 P2-2 + P2-3 (W12): object/attribute registry + AI suggestion plumbing.
--
-- Builds the institutional-memory substrate. Pass 1 emits observed_objects
-- per W11; this migration provides the canonical registry, raw observation
-- log, attribute keys-values, and discovery queue. AI suggestion engine
-- (W12.7-W12.8) reads from these tables. W13b pulse goldmine writes into
-- raw_attribute_observations as well.
--
-- Manual-trigger only per Joseph 2026-04-27: no pg_cron blocks. Normalisation
-- runs are explicit human invocations from the admin UI.

-- 0. pgvector extension ────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;

-- 1. object_registry ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_label TEXT UNIQUE NOT NULL,
  canonical_label_embedding VECTOR(1536),
  category TEXT,
  market_frequency INT NOT NULL DEFAULT 0,
  first_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'canonical'
    CHECK (status IN ('canonical', 'deprecated', 'merged')),
  merged_into_id UUID REFERENCES object_registry(id),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE object_registry IS
  'Wave 12 (P2-2): canonical objects observed in compositions. Flat (not nested). status lifecycle: canonical → deprecated|merged. Bootstrap seed from W12.2 (~200 rows from spec section 11).';

CREATE INDEX IF NOT EXISTS idx_object_registry_status
  ON object_registry(status) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_object_registry_freq
  ON object_registry(market_frequency DESC) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_object_registry_category
  ON object_registry(category) WHERE status = 'canonical';

-- pgvector HNSW index for cosine similarity:
CREATE INDEX IF NOT EXISTS idx_object_registry_embedding
  ON object_registry USING hnsw (canonical_label_embedding vector_cosine_ops)
  WHERE status = 'canonical';

-- 2. raw_attribute_observations ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raw_attribute_observations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  group_id UUID REFERENCES composition_groups(id) ON DELETE CASCADE,
  raw_label TEXT NOT NULL,
  raw_label_embedding VECTOR(1536),
  normalised_to_object_id UUID REFERENCES object_registry(id),
  normalised_at TIMESTAMPTZ,
  similarity_score NUMERIC(5,4),
  confidence NUMERIC(4,3),
  source_type TEXT NOT NULL
    CHECK (source_type IN ('internal_raw', 'internal_finals', 'pulse_listing', 'pulse_floorplan')),
  source_excerpt TEXT,
  attributes JSONB DEFAULT '{}'::jsonb,
  pulse_listing_id UUID REFERENCES pulse_listings(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT raw_obs_exactly_one_source
    CHECK ((round_id IS NOT NULL) <> (pulse_listing_id IS NOT NULL))
);

COMMENT ON TABLE raw_attribute_observations IS
  'Wave 12 (P2-2): per-observation log. Source-aware (internal_raw / internal_finals / pulse_listing / pulse_floorplan). Normalised to object_registry by the manual-trigger normalisation batch.';

CREATE INDEX IF NOT EXISTS idx_raw_obs_pending_normalisation
  ON raw_attribute_observations(created_at)
  WHERE normalised_to_object_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_object
  ON raw_attribute_observations(normalised_to_object_id)
  WHERE normalised_to_object_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_round
  ON raw_attribute_observations(round_id) WHERE round_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_raw_obs_pulse
  ON raw_attribute_observations(pulse_listing_id) WHERE pulse_listing_id IS NOT NULL;

-- Idempotency: same round + group + raw_label = no duplicate
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_obs_round_group_label
  ON raw_attribute_observations(round_id, group_id, raw_label)
  WHERE round_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_raw_obs_pulse_label
  ON raw_attribute_observations(pulse_listing_id, raw_label)
  WHERE pulse_listing_id IS NOT NULL;

-- 3. attribute_values ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attribute_values (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id UUID NOT NULL REFERENCES object_registry(id) ON DELETE CASCADE,
  attribute_key TEXT NOT NULL,
  value_text TEXT NOT NULL,
  value_embedding VECTOR(1536),
  observation_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'canonical'
    CHECK (status IN ('canonical', 'deprecated', 'merged')),
  merged_into_id UUID REFERENCES attribute_values(id),
  first_observed_at TIMESTAMPTZ DEFAULT NOW(),
  last_observed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (object_id, attribute_key, value_text)
);

COMMENT ON TABLE attribute_values IS
  'Wave 12 (P2-2): attribute key-value pairs keyed to object_registry. e.g. kitchen_island.edge_style=waterfall.';

CREATE INDEX IF NOT EXISTS idx_attribute_values_object
  ON attribute_values(object_id) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attribute_values_key
  ON attribute_values(attribute_key) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attribute_values_freq
  ON attribute_values(object_id, observation_count DESC) WHERE status = 'canonical';
CREATE INDEX IF NOT EXISTS idx_attribute_values_embedding
  ON attribute_values USING hnsw (value_embedding vector_cosine_ops)
  WHERE status = 'canonical';

-- 4. object_registry_candidates ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS object_registry_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_type TEXT NOT NULL
    CHECK (candidate_type IN ('object', 'attribute_value')),
  proposed_canonical_label TEXT NOT NULL,
  proposed_category TEXT,
  proposed_object_id UUID REFERENCES object_registry(id),
  proposed_attribute_key TEXT,
  proposed_value_text TEXT,
  similarity_to_existing JSONB,
  observed_count INT NOT NULL DEFAULT 1,
  sample_observation_ids UUID[],
  sample_excerpts TEXT[],
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'merged', 'auto_archived')),
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  reviewer_notes TEXT,
  approved_object_id UUID REFERENCES object_registry(id),
  approved_attribute_value_id UUID REFERENCES attribute_values(id),
  merged_into_object_id UUID REFERENCES object_registry(id),
  merged_into_attribute_value_id UUID REFERENCES attribute_values(id),
  first_proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_proposed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archive_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

COMMENT ON TABLE object_registry_candidates IS
  'Wave 12 (P2-2): discovery queue for new canonicals + attributes flagged by the normalisation batch (sim 0.75-0.92 = ambiguous; sim < 0.75 = potential new). Admin reviews via Settings → Engine → Object Registry → Discovery Queue.';

-- Per Joseph: pending → auto_archive after 14 days unreviewed
CREATE INDEX IF NOT EXISTS idx_candidates_pending
  ON object_registry_candidates(observed_count DESC, last_proposed_at DESC)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_candidates_archive
  ON object_registry_candidates(archive_at) WHERE status = 'pending';

-- Unique key prevents duplicate proposals for the same (type, label, scope):
-- Object candidates: unique on (candidate_type='object', proposed_canonical_label)
-- Attribute candidates: unique on (candidate_type='attribute_value', proposed_object_id, proposed_attribute_key, proposed_value_text)
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_object_pending
  ON object_registry_candidates(proposed_canonical_label)
  WHERE candidate_type = 'object' AND status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_candidates_attribute_pending
  ON object_registry_candidates(proposed_object_id, proposed_attribute_key, proposed_value_text)
  WHERE candidate_type = 'attribute_value' AND status = 'pending';

-- 5. RLS ──────────────────────────────────────────────────────────────────
ALTER TABLE object_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_attribute_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribute_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE object_registry_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY object_registry_select ON object_registry FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY object_registry_write ON object_registry FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

CREATE POLICY raw_obs_select ON raw_attribute_observations FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY raw_obs_write ON raw_attribute_observations FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

CREATE POLICY attr_values_select ON attribute_values FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager','employee'));
CREATE POLICY attr_values_write ON attribute_values FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

CREATE POLICY candidates_select ON object_registry_candidates FOR SELECT TO authenticated
  USING (get_user_role() IN ('master_admin','admin','manager'));
CREATE POLICY candidates_write ON object_registry_candidates FOR ALL TO authenticated
  USING (get_user_role() IN ('master_admin','admin'))
  WITH CHECK (get_user_role() IN ('master_admin','admin'));

NOTIFY pgrst, 'reload schema';

-- ── Rollback (manual; only if migration breaks production) ────────────────
--
-- DROP TABLE IF EXISTS object_registry_candidates;
-- DROP TABLE IF EXISTS attribute_values;
-- DROP TABLE IF EXISTS raw_attribute_observations;
-- DROP TABLE IF EXISTS object_registry;
-- (pgvector extension stays; harmless if no other tables use it)
```

---

## Engine integration

1. **Pass 1 prompt** — new `objectsAndAttributes` block (W7.6 composable) instructs model to emit `observed_objects` + `attribute_observations` arrays. Block reads `object_registry WHERE status='canonical'` (top 200 by frequency) for the prompt's canonical-key list. Block-version pinned per W7.6 mechanism.

2. **`shortlisting-attribute-extractor`** (new edge fn) — runs after Pass 1, reads composition_classifications JSONB columns, inserts `raw_attribute_observations` with embeddings. Triggered by the dispatcher post-Pass-1.

3. **`normalise-attribute-observations`** (new edge fn) — manual-trigger; processes pending observations, auto-normalises high-sim, queues mid-sim for review. Returns counts.

4. **`shortlisting-suggestion-engine`** (new edge fn) — manual-trigger; reads `shortlisting_events` + `object_registry` + `composition_classifications`, upserts `shortlisting_slot_suggestions` + `shortlisting_room_type_suggestions`.

5. **`_shared/embeddings.ts`** (new) — wraps OpenAI text-embedding-3-small with retry + cost logging.

6. **`pulse-description-extractor`** (W13b's Modal worker) — writes `raw_attribute_observations` with `source_type='pulse_listing'`. Schema match: this migration's columns are W13b-ready.

7. **W13a's `shortlisting-historical-training-extractor`** — when re-extracting backfill rounds, reads `raw_attribute_observations.attributes` to enrich the training row's `key_elements` field. No code change here; W13a's spec already references this dependency.

---

## Frontend impact

1. **`Settings → Engine → Object Registry`** — new page with three tabs:
   - **Browse:** paginated list of canonical objects, sortable by market_frequency, filterable by category. Click a row → modal with full detail (description, attribute_values list, recent observations sample).
   - **Discovery Queue:** per §4.
   - **Normalisation:** per §3 admin UI.

2. **`Settings → Engine → AI Suggestions`** — per `W12-trigger-thresholds.md` "Admin UI" section. Two tabs (Slot suggestions, Room-type suggestions). Renders pending suggestions with sample evidence + approve/reject/merge actions. Uses the `shortlisting-suggestion-engine` edge fn.

3. **Round status drawer extension** — when viewing a locked round, surface "Objects observed in this round" panel pulling from `raw_attribute_observations WHERE round_id = $1 AND normalised_to_object_id IS NOT NULL`. Joins to `object_registry.canonical_label` for display. Read-only; gives the editor / agent a richer summary without leaving the round.

---

## Tests

- **Migration test:** mig 345 idempotent; pgvector extension installs; all four tables + indexes + RLS exist post-run.
- **`shortlisting-attribute-extractor` integration test:** seed a round with observed_objects in composition_classifications JSONB; run extractor; verify `raw_attribute_observations` rows + embeddings populated.
- **`normalise-attribute-observations` integration test:** seed 5 observations + 1 high-sim canonical + 1 mid-sim canonical; run normalise; verify auto-normalised count = 1, queued count = 1, `market_frequency` bumped, `object_registry_candidates` row created.
- **Discovery queue UI integration test:** approve flow inserts `object_registry` row + flips candidate status; merge flow updates `merged_into_id` + flips status.
- **`shortlisting-suggestion-engine` integration test:** seed 5 rounds with `pass2_slot_suggestion` events for the same proposed_slot_id; run engine; verify suggestion row inserted with correct evidence_round_count.
- **`_shared/embeddings.ts` test:** retry logic, cost logging, dim 1536 output shape.
- **pgvector similarity smoke test:** insert 10 canonicals + 1 query; verify `<=>` operator returns sorted results; HNSW index used (EXPLAIN check).

---

## Open questions for sign-off

**Q1.** pgvector embedding model + dimension?
**Recommendation:** OpenAI `text-embedding-3-small` at native dim **1536**. The original spec suggested 384 (PCA-reduced) but PCA introduces complexity (an embedding-reduction edge fn between OpenAI's call and the DB write) and degrades similarity quality at the threshold boundaries (0.92 / 0.75). 1536 storage is bounded (~6KB/row × 28k pulse + ongoing rounds = ~170MB at full scale — well within Supabase's quota). pgvector's HNSW index on 1536-dim vectors is performant for the registry's scale (sub-millisecond on warm cache, single-digit ms on cold). See R3 below for the full trade-off analysis.

**Q2.** Normalisation invocation pattern — manual-trigger only, confirmed?
**Recommendation:** **Yes** — confirmed by Joseph 2026-04-27. Same pattern as W13a/W13b. Admin fires the batch from the UI when they want observations processed. No autonomous cron, no auto-resume after partial failures, no scheduled batches. The migration omits any `pg_cron.schedule` block.

**Q3.** Candidate review SLA / auto-archive window?
**Recommendation:** **14 days** pending → auto_archive (status flip; row retained for audit). Low-value candidates that aren't reviewed in 14 days are unlikely to surface enough additional evidence to matter; keeping them in the active queue creates noise. Auto_archived rows are still queryable by admin via a "Show archived" toggle in the UI. If the same candidate re-accumulates observations after archive, a new row is created (the partial unique index `WHERE status = 'pending'` allows it).

**Q4.** Pulse-sourced observation RLS — restrict to master_admin/admin only?
**Recommendation:** **No** — same RLS as internal observations (manager/employee can see). Pulse listing data is publicly scraped from REA; no privacy concern. Tightening RLS later is cheap if a sensitivity issue surfaces. v1 ships permissive.

---

## Resolutions self-resolved by orchestrator

**R1 — flat object_registry, not hierarchical.**
Hierarchical taxonomy ("OBJECT_KITCHEN > kitchen_island > with_waterfall_edge") sounds clean but produces fragile boundaries: is `butler_pantry` a child of `kitchen` or a sibling? At what depth does it stop being an "object" and start being an "attribute"? Flat registry sidesteps the question — every distinct thing is its own row, attributes are explicit key-value pairs in `attribute_values`. Easier to query, easier to extend, easier for admin to reason about. Standard pattern in retrieval/registry systems.

**R2 — single discovery queue table, polymorphic by `candidate_type`.**
Two tables (`object_candidates` + `attribute_candidates`) would split the workflow + double the UI. The `candidate_type` column lets a single query + single admin page handle both. The unique constraint partial indexes per type keep referential integrity.

**R3 — pgvector dim 1536, NOT 384 PCA-reduced.**
PCA reduction introduces:
- An additional edge fn step (call OpenAI → call PCA → store) — more failure modes
- Quality loss at the similarity-threshold boundaries (PCA at 384-dim loses ~5-10% of cosine similarity precision; the 0.92 / 0.75 threshold differences become noisier)
- Re-embedding cost when admin upgrades the embedding model later (PCA basis would need re-fitting)
1536 storage cost is bounded (170MB at full pulse + ongoing scale). Supabase Postgres handles this comfortably. Postgres TOAST stores oversized values out-of-line so row size doesn't bloat. The W13b spec already plans for OpenAI native dim usage; W12's choice aligns. Single source of truth: native dim.

**R4 — manual-trigger normalisation, NOT pg_cron.**
Per Joseph's 2026-04-27 directive applied to the institutional-memory waves (W13a/W13b/W12 share this rule). Admin fires the batch when they want it run; the system never normalises autonomously. The `archive_at` timestamp is set at insert and checked manually by an "Archive aged candidates" UI button — no cron evicts anything.

**R5 — `auto_archived` is a status flip, NOT a delete.**
The discovery queue can pile up with low-value pending candidates. Deleting them is destructive (loses the evidence trail). `auto_archived` flips the status (out of the active queue) but the row + its `sample_observation_ids` + `sample_excerpts` stay queryable for audit. If an archived candidate re-accumulates evidence, a new row is created (the partial unique index `WHERE status='pending'` allows the new pending row alongside the archived one).

**R6 — `raw_attribute_observations` carries embedding, not just raw_label.**
Computing the embedding at observation insert time (in the extractor edge fn) costs ~$0.0001/observation but saves re-embedding at every normalisation pass (which would be 10x+ the embedding cost across pulse + ongoing rounds). The embedding column is also forward-compat: future re-normalisation passes (e.g. after admin merges two canonicals) re-use the stored embedding without re-calling OpenAI.

**R7 — `attribute_observations` deferred to next batch when parent object isn't normalised yet.**
An attribute observation like `aircon_type:ducted_reverse_cycle` needs an `object_id` to anchor to. If the observation came from a Pass 1 row whose `observed_object` is still un-normalised, the attribute can't be resolved yet. The batch defers it (skips this iteration) and picks it up next run after the parent normalises. Simpler than priority queues; eventually-consistent.

**R8 — single edge fn for normalisation, NOT split per source_type.**
The normalisation logic is identical regardless of whether the observation came from internal_raw, pulse_listing, etc. The `source_type_filter` parameter on the edge fn lets admin scope a run ("only normalise pulse data right now, hold off on internal until I'm satisfied with the pulse output") without splitting the codebase. Single fn, conditional filter.

**R9 — Pass 1 emits `canonical_key_proposed: null` when no canonical fits.**
Forces the model to be explicit when it doesn't know. The `null` value tells the normalisation batch "this is a fresh observation with no canonical hint" — different from a low-similarity hit on an existing canonical. Provides the discovery queue with two flavours of candidate (model proposed null = uncharted territory; model proposed an existing canonical with low similarity = potential synonym). Reviewer treats them differently.

**R10 — Suggestion engine reads from `shortlisting_events`, NOT a direct Pass 2 hook.**
`shortlisting_events` (mig 284) is the existing audit log for engine internals. Pass 2 already emits `pass2_slot_suggestion` events when it can't find a slot. Reading from this log keeps the suggestion engine decoupled from Pass 2's runtime; suggestion engine can be re-run over historical events to surface gaps that emerged before the engine existed. Same pattern: events are the source of truth for engine telemetry.

**R11 — Prompt's canonical-key list capped at 200 by market_frequency.**
Sending the full registry (potentially 1000+ canonicals after Wave 13 goldmines) into every Pass 1 prompt would blow the context budget. The top 200 by frequency covers ~95% of typical observations (Pareto). The model can still emit `canonical_key_proposed: null` for the long tail; the discovery queue catches them. Admin can lift the cap via `engine_settings` if a particular shoot tier needs broader vocabulary.

---

## Effort estimate

- Migration (4 tables + indexes + pgvector + RLS): half-day
- `_shared/embeddings.ts` (OpenAI wrapper + retry + cost log): 2 hours
- Pass 1 `objectsAndAttributes` block (W7.6 composable): 2 hours (assumes W11 lands the JSONB columns on composition_classifications)
- `shortlisting-attribute-extractor` edge fn: 1 day
- `normalise-attribute-observations` edge fn (cosine match + threshold split + denormalised counter bumps + candidate upsert): 1.5 days
- `shortlisting-suggestion-engine` edge fn (3 trigger sources × upsert into 2 suggestion tables): 1 day
- Object Registry admin page (Browse + Discovery Queue + Normalisation tabs): 2-3 days
- AI Suggestions admin page (Slots + Room-types tabs, approve/reject/merge actions): 1.5 days
- Round status drawer extension (Objects panel): 2 hours
- Bootstrap seed (~200 canonical objects + categories from spec section 11): 1 day (data entry + categorisation)
- Tests + smoke + e2e: 1 day

**Total: ~9-11 engineering days** + 1 day data-entry. Largest variance is the bootstrap seed — depends how prescriptive Joseph wants the v1 vocabulary. Can ship with a smaller seed (~50 most-common) and let Wave 13b's pulse goldmine + ongoing live rounds populate the rest organically.

---

## Out of scope (handled in other waves)

- **AI suggestion thresholds** — already specced in `docs/design-specs/W12-trigger-thresholds.md` (companion doc).
- **W13b pulse extractor** — separate spec; writes to this wave's `raw_attribute_observations` table with `source_type='pulse_listing'`.
- **W13c floorplan OCR** — separate spec; writes with `source_type='pulse_floorplan'`.
- **Cross-source competitor analysis** — Wave 15c reads from this wave's data but is its own spec.
- **Auto-merging of duplicate canonicals** — admin-driven only in v1. Auto-merge across high-confidence synonym pairs is a follow-up.
- **Synonym graph as first-class** — emerge from `raw_attribute_observations.raw_label` distribution; no explicit synonym table in v1.
- **Embedding model upgrades** — when OpenAI ships text-embedding-4 (or similar), a re-embedding pass against all rows is a separate wave; not v1 work.

---

## Pre-execution checklist

- [ ] **Wave 11 must have shipped first** — composition_classifications.observed_objects + attribute_observations JSONB columns must exist before W12's extractor can read them
- [ ] W7.6 ✅ shipped (composable prompt blocks for the new `objectsAndAttributes` block)
- [ ] Joseph signs off on Q1 (1536 dim), Q2 (manual-trigger confirmed), Q3 (14-day auto-archive), Q4 (pulse RLS permissive)
- [ ] Migration number reserved at integration time (recommend 345 — chained after W7.7=339, W10.1=340, W10.3=341, W13a=342, W13b=343, W8=344)
- [ ] pgvector extension verified available on Supabase project (it is; just needs `CREATE EXTENSION` in mig 345)
- [ ] OpenAI API key (`OPENAI_API_KEY`) confirmed set in edge-fn secrets (used by `_shared/embeddings.ts`)
- [ ] Bootstrap seed list reviewed — Joseph confirms the ~200 canonical objects + categorisation from spec section 11 (or a subset for v1)
- [ ] Frontend IA confirmed — `Settings → Engine → Object Registry` (with three tabs) AND `Settings → Engine → AI Suggestions` (separate page); alternative is a single combined page (more compact but busier)
- [ ] Pass 1 snapshot test updated with the new `objectsAndAttributes` block enabled
- [ ] One end-to-end run: ingest a round → Pass 1 emits observed_objects → extractor populates raw_attribute_observations → normalisation batch processes → discovery queue shows candidates → admin approves one → confirm `object_registry.market_frequency` increments on next run

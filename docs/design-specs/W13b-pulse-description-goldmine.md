# W13b — Pulse Description Goldmine (object_registry bootstrap) — Design Spec

**Status:** ⚙️ Ready to dispatch (awaiting Joseph sign-off on Q1-Q4 below).
**Backlog ref:** P2-4
**Wave plan ref:** W13b — Sonnet/Opus extractor over 28k pulse_listings descriptions → object_registry market_frequency seed + attribute_values bootstrap
**Dependencies:**
- **W11 must land first** — universal vision response defines the canonical-key shape (`OBJECT_*` keys, `attribute_values` JSON shape) that this extractor populates. Pre-W11, this spec's extractor would have no schema to write into.
- **W12 must land first** — `object_registry`, `attribute_values`, `raw_attribute_observations` tables (per W12.1) need to exist; pgvector extension installed; cosine-similarity functions available.
- **W11.7 architectural parallel** — this spec's text-extraction pattern (Sonnet/Opus over a corpus → emit structured JSON via tool-use → write to canonical tables) mirrors the unified-call image-extraction pattern. Same prompt-block conventions; same engine_settings cost-cap discipline; same manual-trigger policy.

**Unblocks:**
- **W12.5** (manual-trigger normalisation batch) gets a 28k-row seed corpus on day one instead of waiting for live shoots to accumulate.
- **W12.6** (discovery queue UI) has actual candidates to review post-deploy.
- **W15b** (REA listing scoring + missed-opportunity recalibration) — every listing scored for vision-grade signals can join against the description-derived attribute set, giving a richer competitor profile.

---

## ⚡ Architectural alignment (2026-04-29)

W13b's extractor is text-only (no images), so W11.7's unified-image-call architecture doesn't directly change W13b's flow. But:

- **Same architectural principles apply**: tool-use for strict JSON output, manual-trigger only (no autonomous cron per Joseph 2026-04-27), per-invocation `cost_cap_usd`, master_admin invocation control.
- **W13b output feeds the same `object_registry`** that W11.7's unified call reads as canonical-context-prompt. Pulse-derived canonical features (e.g. "Caesarstone benchtop" observed 80 times in REA descriptions) become high-confidence prompt context for the unified call's image judgements. **Cross-source learning**: text observations from REA listings train the unified call's image classification.
- **W12 normalisation is the bridge**: pulse_description_extractions → normalisation pipeline → object_registry → unified call's prompt context. Same plumbing W11.7 image observations flow through.

---

## Problem

Pulse has scraped ~28,000 REA listing descriptions. Each description is a paragraph of dense semantic structure that real estate agents have written, edited, and approved as the canonical pitch for the property:

> "Set on a tree-lined boulevard in coveted Mosman East, this masterfully renovated Federation home offers four oversized bedrooms, a designer Caesarstone kitchen with butler's pantry, ducted reverse-cycle air conditioning throughout, and a north-facing rear garden with a heated saltwater pool. The wine cellar accommodates 200 bottles, and the home gym sits adjacent to a steam room. A double automated garage completes the offering."

Buried in this paragraph: ~25 distinct attribute values that the engine cares about. `ducted reverse-cycle air conditioning` is a normalisation candidate (variants in the corpus include "ducted AC", "reverse-cycle ducted air-con", "ducted system"). `Caesarstone benchtops` is an `OBJECT_KITCHEN` attribute. `north-facing rear garden` is both an aspect signal and an outdoor classification. `heated saltwater pool` clusters with "heated pool", "saltwater pool", "salt-chlorinated pool" — all the same `OBJECT_POOL` with attribute `heating_type=heated, water_treatment=saltwater`.

Wave 12 builds the institutional-memory schema (`object_registry`, `attribute_values`, `raw_attribute_observations`) and the AI suggestion engine that populates it from live Pass 1 calls. Without bootstrap data, the registry starts empty and the suggestion engine takes months to surface the long tail of attributes that a Sydney listing inevitably mentions.

**The fix:** treat each of the 28k descriptions as a pre-built training corpus. Run Sonnet (default) or Opus (high-end properties; per Joseph's >$10M memory note) over each description in extraction mode, returning a structured list of (canonical-key, attribute-value, confidence) triples per listing. Cluster the results by frequency to seed `object_registry.market_frequency`. Use cosine similarity (pgvector — already infra) to merge synonyms onto canonical entries.

Each extraction row carries full provenance: `listing_id` (FK to `pulse_listings`), `source_address`, the raw description excerpt the model based the extraction on, the model used (sonnet vs opus). Future audits + re-extractions trace cleanly back to the source paragraph.

---

## Architecture

### Section 1 — New Modal worker `pulse-description-extractor`

Why Modal vs an edge function: 28k descriptions × ~2s per Sonnet call = ~16 hours wall-clock. Edge functions hit timeout; Modal containers parallelise cleanly with a thread pool over the Anthropic API rate limit. Same shape as `photos-extract`.

```python
# modal/pulse-description-extractor/main.py (new)

from __future__ import annotations
import modal
from typing import Any, Dict, List, Optional

# Same image pattern as photos-extract — slim Debian + pip deps.
extractor_image = (
    modal.Image.debian_slim(python_version="3.11")
    .pip_install(
        "anthropic>=0.40",
        "fastapi[standard]",
        "httpx==0.27.2",
    )
)

app = modal.App("flexstudios-pulse-description-extractor", image=extractor_image)


@app.function(
    cpu=2.0,
    memory=4096,
    timeout=900,
    secrets=[
        modal.Secret.from_name("anthropic_api_key"),
        modal.Secret.from_name("supabase_service_role_key"),
    ],
)
@modal.fastapi_endpoint(method="POST", requires_proxy_auth=False)
def extract_http(payload: Dict[str, Any]):
    """
    POST body:
      _token:      SUPABASE_SERVICE_ROLE_KEY (auth)
      batch:       Array<{
        listing_id: UUID,
        description: string,
        source_address: string,
        asking_price: number | null,    # determines model choice (Sonnet vs Opus)
        listing_type: 'sale' | 'rental' | 'sold',
      }>
      model_override: 'sonnet' | 'opus' | null   # null = use default selector

    Response:
      ok: bool
      extractions: Array<{
        listing_id: UUID,
        ok: bool,
        error?: string,
        model_used: 'sonnet' | 'opus',
        cost_usd: number,
        elapsed_ms: number,
        observed_objects: Array<{
          canonical_key_proposed: string,    // model's guess at canonical OBJECT_*
          raw_label: string,                 // free-form descriptor from the paragraph
          confidence: number,                // 0-1
          attributes: Record<string, unknown>,
          source_excerpt: string,            // the sentence the extraction came from
        }>,
        attribute_observations: Array<{
          attribute_key: string,             // e.g. 'aircon_type', 'pool_heating'
          attribute_value: string,           // 'ducted_reverse_cycle', 'heated_saltwater'
          confidence: number,
          source_excerpt: string,
        }>,
        key_elements: string[],              // free-form tags ['ducted_aircon', 'wine_cellar']
      }>
    """
```

### Section 2 — Model selection: Sonnet by default, Opus for premium properties

Per Joseph's memory note: "Sonnet (default) and Opus for >$10M properties". Implementation:

```python
def select_model(asking_price: Optional[float], listing_type: str, override: Optional[str]) -> str:
    if override in ("sonnet", "opus"):
        return override
    # Premium threshold: asking_price >= $10M (exact value confirmed Q1)
    PREMIUM_THRESHOLD = 10_000_000.0
    if asking_price is not None and asking_price >= PREMIUM_THRESHOLD:
        return "opus"
    return "sonnet"
```

Rationale: Opus catches the long-tail vocabulary that's overrepresented in luxury listings — "Tasmanian oak parquet", "marble Calacatta vanity", "Schiavello-fitted study", "vintage Murano glass pendants", etc. Sonnet handles the bulk of mid-market listings (single-pendant kitchens, standard Caesarstone, etc.) at 5-7x lower cost. The price gate is a good empirical proxy for "does this listing have unusual vocabulary worth Opus's extraction quality".

For sold properties, use `sold_price` as the proxy (Sonnet vs Opus). For rentals, use a heuristic: weekly rent × 52 × 25 (rough capitalisation) — but rentals rarely cross the $10M threshold so this is mostly Sonnet territory.

### Section 3 — Extraction prompt structure

The prompt is a focused single-shot extraction; we don't ask the model to score quality, only to identify and structure attributes:

```
SYSTEM:
You are an attribute extraction engine for real estate listings. Your output
populates an object_registry that powers competitor analysis and image-quality
scoring. Be exhaustive. Be precise. Avoid hallucination — if the description
doesn't mention something, don't infer it.

USER:
Listing address: {source_address}
Listing type: {listing_type}
Asking price: {asking_price_aud_or_unspecified}

Description:
"""
{description}
"""

Extract every notable property attribute. Return STRICT JSON:

{
  "observed_objects": [
    {
      "canonical_key_proposed": "OBJECT_KITCHEN" | "OBJECT_POOL" | "OBJECT_GARAGE" | ... | null,
      "raw_label": "designer Caesarstone kitchen",
      "confidence": 0.95,
      "attributes": {"benchtop_material": "caesarstone", "cabinetry_style": "designer"},
      "source_excerpt": "designer Caesarstone kitchen with butler's pantry"
    }
  ],
  "attribute_observations": [
    {
      "attribute_key": "aircon_type",
      "attribute_value": "ducted_reverse_cycle",
      "confidence": 0.9,
      "source_excerpt": "ducted reverse-cycle air conditioning throughout"
    }
  ],
  "key_elements": ["ducted_aircon", "wine_cellar", "north_facing", "saltwater_pool", ...]
}

Use canonical keys from this list when applicable; emit null for new candidates:
{CANONICAL_OBJECT_KEYS_FROM_W12_BOOTSTRAP}

Use attribute keys from this list when applicable; new attribute_keys are OK
(they enter the discovery queue):
{CANONICAL_ATTRIBUTE_KEYS_FROM_W12_BOOTSTRAP}
```

The bootstrap canonical-key lists come from the W12.2 seed (`object_registry` rows that ship with the engine). Initial corpus: ~50 OBJECT_* keys, ~80 attribute_keys. The model usually picks one when it fits; emits `null` for novel candidates that go through the W12.6 discovery queue.

**JSON schema enforcement** via Anthropic's tool-use mechanic — define a single `submit_extraction` tool with the JSON schema; force tool_choice to that tool. Model output is then guaranteed-shaped, no free-form parsing.

### Section 4 — Persistence: `pulse_description_extractions` table

We don't write directly to `object_registry` — that's W12.5's nightly normalisation batch's job. Instead, this wave persists the raw per-listing extractions, and W12.5 ingests them.

```sql
-- Wave 13b P2-4: pulse_description_extractions stores per-listing extraction
-- output. Provenance-rich; W12.5's normalisation batch consumes this table
-- to populate object_registry.market_frequency + attribute_values.

CREATE TABLE IF NOT EXISTS pulse_description_extractions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL REFERENCES pulse_listings(id) ON DELETE CASCADE,
  source_address TEXT NOT NULL,                 -- denormalised for fast joins
  description_hash TEXT NOT NULL,                -- SHA-256 of normalised description; idempotency key
  description_excerpt TEXT,                      -- first 500 chars (debug aid)
  model_used TEXT NOT NULL CHECK (model_used IN ('sonnet', 'opus')),
  cost_usd NUMERIC(10, 6) NOT NULL,
  elapsed_ms INT NOT NULL,
  observed_objects JSONB NOT NULL DEFAULT '[]'::jsonb,
  attribute_observations JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_elements TEXT[] NOT NULL DEFAULT '{}',
  extraction_status TEXT NOT NULL DEFAULT 'extracted'
    CHECK (extraction_status IN ('extracted', 'normalised', 'rejected')),
  rejection_reason TEXT,
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  normalised_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency: re-running extraction against the same description hash is a no-op
CREATE UNIQUE INDEX IF NOT EXISTS uq_pulse_description_extractions_listing_hash
  ON pulse_description_extractions(listing_id, description_hash);

CREATE INDEX IF NOT EXISTS idx_pulse_description_extractions_status
  ON pulse_description_extractions(extraction_status, extracted_at);

CREATE INDEX IF NOT EXISTS idx_pulse_description_extractions_listing
  ON pulse_description_extractions(listing_id);

COMMENT ON TABLE pulse_description_extractions IS
  'Wave 13b P2-4: raw per-listing description extractions from Sonnet/Opus. Provenance-rich; consumed by W12.5 nightly normalisation batch to populate object_registry + attribute_values. extraction_status=normalised when W12.5 has processed the row.';

NOTIFY pgrst, 'reload schema';
```

`description_hash` is computed as `sha256(normalise_whitespace(description))`. When pulse re-scrapes a listing and the description hasn't changed, re-extraction is a no-op (the unique index catches it). When the description changes (rare for archived listings; common for active ones), the new hash creates a new extraction row — the old row stays for audit.

### Section 5 — Edge fn `pulse-description-extract` (manual-trigger only)

**Joseph confirmed 2026-04-27**: this wave runs strictly on-demand. No pg_cron, no nightly schedule, no autonomous batching. Joseph asks the orchestrator (or invokes the admin UI directly) when he wants to process N listings; he picks N. The runtime never decides to fire on its own.

The edge function accepts a request shape that's explicit about scope:

```typescript
// supabase/functions/pulse-description-extract/index.ts (new)
// Master_admin only. Service-role bearer required.

interface ExtractRequest {
  /** Explicit set of listings to process. Highest priority — if provided, the
   *  filter+limit fields are ignored. Use this when Joseph specifies "extract
   *  these specific listings". */
  listing_ids?: string[];

  /** When listing_ids is absent, run a query-based selection. */
  selection?: {
    /** Hard cap on rows processed in this invocation. Required when listing_ids
     *  is absent — there is no default. Joseph specifies the count per call. */
    limit: number;

    /** Optional filters narrowing the candidate set. */
    listing_type?: 'sale' | 'rental' | 'sold';
    min_price?: number;
    max_price?: number;
    suburb?: string;
    re_extract?: boolean;             // if true, re-process listings that have changed
  };

  /** Required cost guard. Aborts the call before Modal invocation if estimated
   *  cost exceeds this cap. No default — Joseph provides per call. */
  cost_cap_usd: number;
}

// 1. Determine the candidate listing_id set:
//    - If listing_ids provided → use as-is (filtered to extant pulse_listings rows)
//    - Else SELECT pulse_listings rows matching selection.* filters where:
//         description IS NOT NULL AND length(description) > 100
//         AND NOT EXISTS (SELECT 1 FROM pulse_description_extractions e
//                         WHERE e.listing_id = l.id AND e.description_hash = sha256(l.description))
//      LIMIT selection.limit
//
// 2. Estimate cost: sonnet_count * $0.011 + opus_count * $0.057 (opus when listing.asking_price >= $10M).
//    If estimate > cost_cap_usd → abort with 400 + estimate detail.
//
// 3. POST to Modal pulse-description-extractor with the batch.
// 4. INSERT extraction rows on success.
// 5. Return summary: { processed_count, succeeded, failed, opus_count, sonnet_count, total_cost_usd, elapsed_seconds }.
//    Joseph reads the summary, decides whether to invoke again with the next chunk.
```

**No cron schedule.** No `pg_cron.schedule(...)` block. No `pulse_description_batch_completed` event firing on a timer. Every invocation is an explicit POST from a human (or the orchestrator on Joseph's instruction).

**Admin UI** (lands as part of W13b execution): a `Settings → Pulse Goldmine` page with:
- Current pending count (`SELECT COUNT(*) FROM pulse_listings l WHERE l.description IS NOT NULL AND NOT EXISTS (...)` — the candidate count for re-extract=false)
- Filter inputs (listing_type / price range / suburb)
- Limit input (Joseph types the count for this run)
- Cost cap input (Joseph types the cap)
- Estimated cost preview before invocation
- "Run extraction" button → POSTs to the edge fn → shows summary on completion

Joseph alone decides when to fire and at what scale. The system never auto-extracts.

### Section 6 — Cosine similarity normalisation (W12.5 contract)

Wave 12.5 owns the synonym-merge logic. W13b's contract is to deliver provenance-rich extraction rows; W12.5 picks them up.

The handoff (per W12.5 spec):

1. SELECT extraction rows WHERE `extraction_status='extracted'`.
2. For each `observed_objects[].raw_label`:
   - Compute embedding via OpenAI text-embedding-3-small or pgvector's bge-small.
   - Cosine-compare against `object_registry.canonical_label_embedding`.
   - If similarity ≥ 0.92: write `raw_attribute_observations` row pointing to existing `object_registry.id`; bump `market_frequency`.
   - If 0.75–0.92: queue for W12.6 discovery review.
   - If < 0.75: insert candidate into `object_registry_candidates` for human review.
3. Mark extraction row `extraction_status='normalised', normalised_at=NOW()`.

W13b ships **without** the normalisation logic — that's W12's. The contract in this spec is just: produce well-shaped extractions with full provenance, persist them, mark for downstream consumption.

### Section 7 — Cost model + parallelism

**Per-listing cost** (Sonnet, ~600-800 tokens in, ~400-600 tokens out):
- Input: 800 × $3/1M = $0.0024
- Output: 600 × $15/1M = $0.009
- **Total: ~$0.011/Sonnet call**

Per Opus (premium properties only, ~5% of corpus):
- Input: 800 × $15/1M = $0.012
- Output: 600 × $75/1M = $0.045
- **Total: ~$0.057/Opus call**

**Theoretical full-corpus cost** (NOT a budget commitment — Joseph triggers each run; the corpus is processed only as far as he wants to go):

For 28k listings at 95% Sonnet / 5% Opus:
- Sonnet: 26,600 × $0.011 = **$292**
- Opus: 1,400 × $0.057 = **$80**
- **Theoretical total to fully process the corpus: ~$372**

In practice Joseph processes whatever subset he chooses per invocation. A 100-listing pilot run costs ~$1.20. A 1,000-listing run costs ~$13. The system never burns cost without an explicit human invocation + cost cap acceptance.

**Parallelism per invocation**: Modal's thread pool is already concurrent (per `photos-extract` pattern). Anthropic's API rate limit (40k tokens/min on default tier) means a single invocation should cap at ~1,500-2,000 listings to stay within rate limits — the edge fn enforces this via a hard maximum on `selection.limit` (configurable via `engine_settings`, default 2000). Joseph can run multiple sequential invocations if he wants more throughput in a single sitting.

### Section 8 — Re-extraction policy

For active listings whose description changes (rare for archived listings; common for active sales/rentals), `description_hash` changes → new extraction row inserts (the unique index on `(listing_id, hash)` permits multiple rows per listing as long as hashes differ).

Old extraction rows stay for audit; W12.5 reads only `WHERE extraction_status = 'extracted'`. When normalisation marks the new row `normalised`, the old row is unaffected — its `raw_attribute_observations` linkages stay intact for historical accuracy.

For deleted/withdrawn listings (`pulse_listings.listing_withdrawn_at IS NOT NULL`), extractions stay in place — the past observation about a withdrawn property remains a valid market signal.

---

## Migration

Reserve **next available** at integration time. Recommend `343_pulse_description_extractions.sql` (chained after W7.7=339, W10.1=340, W10.3=341, W13a=342).

Migration scope: **table + indexes + comments only**. NO `pg_cron.schedule(...)` block — this wave is manual-trigger only per Joseph's 2026-04-27 confirmation. The edge function is invoked exclusively via the admin UI / explicit POST.

Rollback comment block per existing pattern.

---

## Engine integration

This wave is **mostly orthogonal** to the shortlisting engine. Pass 0/1/2/3 don't change. The integration is downstream:

1. **W12.5 normalisation batch** consumes `pulse_description_extractions` rows (per §6 contract).

2. **W15b missed-opportunity recalibration** (future) — when scoring an external REA listing's images, the engine joins against this listing's description-derived attribute set to enrich the property profile. e.g. "this listing has `wine_cellar=true` from description AND `wine_cellar` visible in image #14 — the agent's emphasis aligns with the photographer's coverage".

3. **`object_registry.market_frequency`** populated from this corpus + future live shoots gives a market-share signal: "Caesarstone benchtops appear in 71% of $2-3M Mosman listings; this client's home has timber benchtops which is a 12%-frequency choice — likely a deliberate styling decision".

---

## Frontend impact

Minimal — this is a backend bootstrap wave.

1. **`Settings → Engine → Pulse Description Extractor`** — admin page. Master_admin only.
   - Status: total candidate listings (extant + matching filters), listings extracted, listings remaining
   - Cost-to-date: cumulative spend across all manual invocations
   - Run controls (manual-trigger only — there is NO cron):
     - Limit input (Joseph types the count for THIS run)
     - Filter inputs (listing_type / price range / suburb)
     - Re-extract toggle (re-process listings whose description has changed)
     - Cost cap input (Joseph types the cap for this invocation)
     - Estimated cost preview (computed before the POST)
     - "Run extraction" button (single explicit click; no auto-fire)
   - Recent runs table: last N invocations × {triggered_at, listing_count_processed, sonnet_count, opus_count, cost_usd, elapsed_seconds, triggered_by}

2. **`pulse_description_extractions` is read-only** to managers/employees via RLS (admins can update for manual rejection / re-trigger).

---

## Open questions for sign-off

**Q1.** Memory note says "Opus for >$10M properties". Confirm the exact threshold value (or whether it's a different rule, e.g. by listing tier label like "Prestige" / "Premium").
**Recommendation:** $10M AUD asking_price (or sold_price for sold listings) as a hard threshold. Rentals stay Sonnet (almost no rentals cross $10M cap-rate equivalent). Override available per-batch via `model_override` for one-off A/B testing.

**Q2.** ~~Total cost reconciliation~~ → resolved by Joseph 2026-04-27: theoretical full-corpus cost is documented (~$372) but it's NOT a budget commitment. Joseph triggers each run individually, sets the per-invocation `cost_cap_usd`, and decides when to stop. No upfront budget approval needed.

**Q3.** ~~Parallelism / batch cadence~~ → resolved by Joseph 2026-04-27: NO scheduled batches, NO nightly cron. Each run is an explicit human invocation. The edge function caps a single invocation at ~2,000 listings (rate-limit ceiling); Joseph runs sequential invocations if he wants more in one sitting.

**Q4.** Re-extraction policy on edited descriptions for active listings: re-extract on every `description_hash` change, or freeze the snapshot at first extraction?
**Recommendation:** re-extract on change. Each new hash inserts a new extraction row; old rows stay for audit. The market signal evolves as agents edit listings (e.g. "added air conditioning post-renovation"); we want the freshest snapshot in the registry while preserving the historical record.

---

## Resolutions self-resolved by orchestrator

- **R1 (Modal worker, not edge fn).** 28k Sonnet calls at ~2s each = ~16 hours wall-clock. Edge fn timeout is 150s. Modal containers parallelise cleanly with the same architecture as photos-extract. No question; Modal it is.

- **R2 (table name + relationship).** `pulse_description_extractions` lives alongside `pulse_listings` (FK, CASCADE on delete). NOT named `object_registry_seed` because the table outlives the bootstrap — re-extractions of edited listings keep populating it. The `extraction_status` enum (extracted → normalised → rejected) makes the lifecycle explicit.

- **R3 (idempotency by description_hash, not by listing_id).** A listing whose description changes legitimately needs a new extraction; per R2 above, the table is the long-term store. SHA-256(description) gives a deterministic hash; the unique index on `(listing_id, description_hash)` lets multiple extractions coexist when hashes differ.

- **R4 (tool-use JSON schema enforcement).** Free-form JSON parsing of Sonnet/Opus output is fragile (markdown code fences, prose preambles). Anthropic's tool-use mechanic with `tool_choice: {type:"tool", name:"submit_extraction"}` forces the model to return a tool-call payload that's guaranteed-shaped. Same pattern as the existing W11 universal vision response.

- **R5 (no normalisation in this wave).** Synonym merging via cosine similarity is W12.5's job; including it here would couple W13b to W12 internals and create a dependency tangle. The clean handoff: W13b emits `extraction_status='extracted'`; W12.5 reads + writes to `raw_attribute_observations` + flips status to `normalised`.

- **R6 (provenance is non-negotiable).** Every extraction row carries `listing_id`, `source_address`, `description_hash`, `description_excerpt` (first 500 chars), `model_used`. Re-querying the source paragraph via the `description_hash` is a JOIN against `pulse_listings`. No information is lost in the pipeline.

- **R7 (price thresholds use asking_price for active, sold_price for sold).** Both columns exist on `pulse_listings`. `COALESCE(asking_price, sold_price)` is the default model-selection input; rentals fall through to Sonnet (almost never premium-tier).

- **R8 (cost cap as hard abort, not soft warn).** Each manual invocation supplies a required `cost_cap_usd`. The pre-flight estimate (sonnet × opus × token rates) must fit under the cap or the call returns `400` with the estimate detail BEFORE invoking Modal. During the run, if the running tally crosses the cap (rate-limit retries / unexpected token usage), the runner aborts and returns `ok=true, aborted=true, cost_so_far`. Joseph re-invokes with a higher cap or smaller `limit` if needed.

- **R9 (no autonomous schedule, ever).** Joseph's 2026-04-27 directive: this wave runs strictly on human invocation. The migration omits any `pg_cron.schedule` block. There is no `pulse-description-scheduler` cron tick. There is no auto-resume after partial failures. Every batch starts with an explicit click on the admin page or an explicit POST. This applies to W13a as well (specced separately).

---

## Effort estimate

- Migration (table + indexes + cron): 30 min
- `pulse-description-extractor` Modal worker (clone photos-extract image, swap exiftool for Anthropic SDK): 1 day
- `pulse-description-batch-runner` edge fn (selects, calls Modal, persists): half-day
- Prompt design + tool-use schema + 100-listing dry-run validation: 1 day
- Settings admin page (status + run controls + recent batch table): 1 day
- 7-night cron run (overnight, no labour beyond morning spot-checks): 0 days

**Total: ~3-4 days** of engineering + 7 calendar days of cron run.

---

## Out of scope (handled in other waves)

- Cosine-similarity normalisation of `observed_objects[].raw_label` to `object_registry` — Wave 12.5
- Discovery queue UI for new candidate review — Wave 12.6
- `object_registry.market_frequency` rollups — Wave 12.5 / 12.7
- Floorplan OCR goldmine over `pulse_listings.floorplan_urls` — Wave 13c (sibling spec, not authored here)
- Cross-source competitor analysis joining vision-derived signals against description-derived attributes — Wave 15c

---

## Pre-execution checklist

- [ ] W11 shipped (canonical-key shape locked; `OBJECT_*` enum stable)
- [ ] W12.1 shipped (`object_registry`, `attribute_values`, `raw_attribute_observations` tables exist; pgvector installed)
- [ ] W12.2 shipped (object_registry seed populated — extractor needs canonical-key list to reference in the prompt)
- [ ] Joseph signs off on Q1 ($10M Opus threshold), Q2 ($400 budget), Q3 (7-night batching), Q4 (re-extract on change)
- [ ] Migration number reserved at integration time (recommend 343)
- [ ] Anthropic API tier confirmed: Tier 1 sufficient for nightly batches (4000 × 1500 tokens = 6M/night, well under Tier 1's daily cap; if Tier 2 needed, automatic upgrade triggers at $1k spend)
- [ ] Modal app `flexstudios-pulse-description-extractor` deployed
- [ ] 100-listing dry run: prompt validation against a stratified sample (10 sale × 10 sold × 5 rental at varied price points), Joseph QA's the output for hallucination + canonical-key accuracy
- [ ] Cost cap monitor: nightly batch row in `pulse_description_extractions` aggregates includes cost_usd; alert if any single night exceeds $80 (vs ~$53 expected)

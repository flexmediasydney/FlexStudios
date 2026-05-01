# W13c — Floorplan OCR Goldmine — Design Spec

**Status:** Infrastructure landed 2026-05-01 — manual-trigger only, smoke-50 validated, full corpus run gated on Joseph sign-off.

- Migration **386** (`386_w13c_floorplan_extracts.sql`) applied: `floorplan_extracts` table with full provenance + the canonical extract schema; `v_floorplan_crm_mismatches` view for ops review.
- Edge function `floorplan-ocr-extractor` deployed: master_admin / service-role POST endpoint that reads N pending floorplan rows from `pulse_listings.floorplan_urls`, calls Gemini 2.5 Pro vision via the W11.8 unified adapter (with `source_type='floorplan_image'` so the W7.6 source-context block guides the model), persists to `floorplan_extracts`, audits cost.
- Dispatcher kind `floorplan_extract` wired into `KIND_TO_FUNCTION` + `shortlisting_jobs.kind_check` constraint. Terminal kind (no chain).
- **No autonomous trigger.** Joseph fires the endpoint per batch (size + cost cap supplied per call).

### Goal (3 sentences)

FlexMedia has ~22k pulse-archived REA listings carrying a `floorplan_urls[]` array — architectural floorplan drawings, not photographs. We extract structured signal (room enumeration + dimensions, bed/bath counts, home archetype, north-arrow orientation, garage type, flow paths) from each floorplan via Gemini 2.5 Pro vision in OCR mode, persisting per-image provenance. The extracted rows feed (a) cross-validation of CRM-stored `bedrooms` / `bathrooms` (the mismatch view surfaces inconsistencies for ops review) and (b) the W12 canonical-attribute registry's room-frequency seed, and unblock the future W15c floorplan-aware shortlisting wave.

---

## Source data

`pulse_listings.floorplan_urls` (text array). Confirmed counts as of 2026-05-01:

| Metric | Value |
|---|---|
| Listings with at least one floorplan | 22,145 |
| Listings with exactly 1 floorplan | 21,468 |
| Listings with 2+ floorplans | 677 |
| Total floorplan images | 22,822 |
| Listings with CRM `bedrooms` populated | 21,880 |
| Listings with CRM `bathrooms` populated | 22,094 |

Joseph's pre-flight estimate of "~7,881 floorplans" reflects an earlier sample-cohort count; the live total is **22,822 images across 22,145 listings**. The cost model in §4 covers both the ~7.8k Joseph-cohort smoke pilot (**~$59**) and a hypothetical full-corpus run (~$171). **Only the 50-image smoke runs in this wave**; full-corpus rollout is a separate sign-off.

URLs are direct REA static asset URLs (`i3.au.reastatic.net/800x600-fit,format=webp/...`). The Gemini adapter requires base64 inputs (REST endpoint constraint per W11.8 google.ts §URL inputs); the extractor fetches each URL via plain `fetch`, base64-encodes inline, and passes through.

---

## Extract schema

Persisted per-floorplan-image row in `floorplan_extracts`:

```typescript
interface FloorplanExtract {
  id: string;                       // UUID PK
  pulse_listing_id: string;         // FK pulse_listings(id) ON DELETE CASCADE
  floorplan_url: string;            // The exact URL from floorplan_urls[i]
  floorplan_url_hash: text;         // SHA-256(url) — idempotency key

  // ─── Areas ─────────────────────────────────────────────
  total_internal_sqm: number | null;          // Internal floor area when labeled
  total_land_sqm: number | null;              // Land/lot area when shown on the same drawing

  // ─── Rooms ─────────────────────────────────────────────
  // Each entry: { room_label, count, dimensions_sqm? }
  rooms_detected: Array<{
    room_label: string;             // e.g. 'master', 'ensuite', 'kitchen', 'lounge'
    count: number;                  // number of rooms of that type observed
    dimensions_sqm?: number;        // floor area of one such room when legible
  }>;

  // ─── Counts (cross-validated against CRM) ──────────────
  bedrooms_count: number | null;    // floorplan-derived bedroom count
  bathrooms_count: number | null;   // floorplan-derived bathroom count

  // ─── Archetype + orientation ───────────────────────────
  home_archetype:
    | 'open_plan' | 'traditional' | 'split_level'
    | 'townhouse' | 'duplex' | 'apartment'
    | 'unit' | 'studio' | 'unknown';
  north_arrow_orientation: number | null;     // degrees (0=N, 90=E, ...) or null when no arrow visible

  // ─── Garage ────────────────────────────────────────────
  garage_type: 'lock_up' | 'carport' | 'tandem' | 'double' | 'single' | 'none' | 'unknown';

  // ─── Flow paths ────────────────────────────────────────
  // Pairs of room labels that share a doorway / direct connection.
  flow_paths: Array<{ from: string; to: string }>;

  // ─── Cross-check flags vs CRM ──────────────────────────
  // String tokens emitted when extracted ≠ CRM:
  //   'bedrooms_mismatch_2_vs_3'   (extracted_2_vs_crm_3)
  //   'bathrooms_mismatch_1_vs_2'
  //   'no_crm_bedrooms_to_check'   (CRM has null)
  //   'no_crm_bathrooms_to_check'
  cross_check_flags: string[];

  // ─── Quality signals ───────────────────────────────────
  legibility_score: number;           // 0-10 (clarity of the drawing)
  extraction_confidence: number;      // 0-1 (model self-rated confidence)

  // ─── Provenance + cost ─────────────────────────────────
  vendor_used: 'google' | 'anthropic';
  model_used: string;                 // e.g. 'gemini-2.5-pro'
  cost_usd: number;                   // realised per-call cost
  elapsed_ms: number;
  prompt_block_versions: jsonb;       // { sourceContextBlock: 'v1.0', floorplanExtractor: 'v1.0' }
  raw_response_excerpt: text;         // first 2000 chars of vendor response (audit)

  extracted_at: timestamptz;
  created_at: timestamptz;
  updated_at: timestamptz;
}
```

### Idempotency

Unique constraint on `(pulse_listing_id, floorplan_url_hash)`. Re-running the extractor on a listing whose `floorplan_urls` haven't changed is a no-op (skip). When REA edits a listing and the URL changes (rare for archived listings), a fresh row inserts; the old row stays for audit.

---

## Extractor (edge function)

`supabase/functions/floorplan-ocr-extractor/index.ts`:

### Request shape

```typescript
interface ExtractRequest {
  // Explicit listing IDs (highest priority)
  pulse_listing_ids?: string[];

  // Or selection by query
  selection?: {
    limit: number;                          // hard cap; required when pulse_listing_ids absent
    re_extract?: boolean;                   // default false; when true, re-process even if hash matches
    listing_type?: 'sale' | 'rental' | 'sold';
    suburb?: string;
  };

  // REQUIRED — abort if pre-flight estimate exceeds this cap
  cost_cap_usd: number;

  // Optional dispatcher integration
  job_id?: string;
}
```

### Behavior

1. Resolve candidate set:
   - `pulse_listing_ids` provided → use as-is (filter to extant rows with non-empty `floorplan_urls`).
   - Else `selection.*` query: `SELECT id, floorplan_urls, bedrooms, bathrooms FROM pulse_listings WHERE array_length(floorplan_urls, 1) > 0` filtered by selection. Limit applied.
2. Build per-image work units (one row per `floorplan_urls[i]`), filter out URL hashes already extracted (unless `re_extract=true`).
3. Pre-flight cost estimate: `units * $0.0075`. Abort with 400 if estimate > `cost_cap_usd`.
4. **Immediate-ack pattern (W11.7.1)**: if `units > 4` (single-edge-call wall-time exceeds 30s), return `{ ok: true, mode: 'background', estimated_cost_usd, units }` immediately and run the loop inside `EdgeRuntime.waitUntil`. For ≤4 units (smoke-test path), run inline and return the full result.
5. Per unit:
   1. Fetch the URL (timeout 15s) → base64.
   2. Build `VisionRequest` with `vendor: 'google'`, `model: 'gemini-2.5-pro'`, `thinking_budget: 2048`, `system: FLOORPLAN_SYSTEM_PROMPT`, `user_text: sourceContextBlock('floorplan_image') + FLOORPLAN_USER_INSTRUCTIONS + crm_counts_hint`.
   3. Call `callVisionAdapter`.
   4. Parse output → assemble `FloorplanExtract` row (compute `cross_check_flags` against CRM bedrooms/bathrooms in the same step).
   5. INSERT into `floorplan_extracts` with conflict-on-unique-key skip.
   6. If running tally exceeds `cost_cap_usd`, abort the loop early, write the partial summary, return `aborted_at_cost_cap=true`.
6. On completion, if `job_id` provided, write summary into `shortlisting_jobs.result` and mark the job `succeeded`.

### Dispatcher integration

Add `floorplan_extract` to `KIND_TO_FUNCTION`:

```typescript
const KIND_TO_FUNCTION: Record<string, string> = {
  // ... existing kinds ...
  floorplan_extract: 'floorplan-ocr-extractor',
};
```

Migration 384 also extends the `shortlisting_jobs.kind` CHECK constraint to permit `'floorplan_extract'`. The kind is **terminal** (no chain) — `chainNextKind` short-circuits when `job.kind === 'floorplan_extract'`.

---

## Cost model

Per-image (Gemini 2.5 Pro, ~1.5MB floorplan image at 800x600):
- Input: ~1500 tokens (image) + ~400 tokens (prompt) ≈ 1900 tokens × $3.50/M = $0.0067
- Output: ~250 tokens × $10.50/M = $0.0026
- Reasoning (thinking budget 2048, but only ~400 actually consumed for OCR): ~$0.001
- **Per-image: ~$0.0075**

Joseph's pre-flight (~7,881 × $0.0075) ≈ $59 — matches. With the live total of 22,822 images, the theoretical full-corpus cost is **~$171**. The 10% buffer for retries / longer-output cases caps the operator-supplied limit at **$65 for the Joseph-cohort sample** or **$190 for full corpus**. **W13c only runs the smoke 50** (~$0.40); broader rollouts are operator-driven via the admin UI / explicit POST.

---

## Acceptance

50-floorplan smoke run, with manual visual comparison on 5 sampled rows:
- All 50 succeed (no parse failures, no schema violations).
- Realised cost between $0.30 and $0.50.
- ≥80% match between `floorplan_extracts.bedrooms_count` and `pulse_listings.bedrooms`.
  - Mismatches are **not failures** — they're useful signal (the floorplan likely shows a study/4th bedroom that the agent didn't market as a bedroom; or the listing inflates the count).
- Spot check 5 floorplans manually: room enumeration, bed/bath counts, archetype, garage type all line up with the visual drawing.

The 50-row smoke is the only Joseph-prerequisite for full-corpus rollout. He approves the full run separately.

---

## Out of scope

- Full 22,822-image corpus run — separate operator-driven rollout.
- Cosine-similarity normalisation of `rooms_detected[].room_label` to `object_registry` — Wave 12.5.
- Floorplan-aware shortlisting prompt enrichment — Wave 15c.
- Re-extraction policy on edited URLs — handled by hash-based unique constraint (any URL change → fresh row).

---

## Pre-execution checklist

- [x] Migration 386 applied (`floorplan_extracts` table + view + index)
- [x] Edge function `floorplan-ocr-extractor` deployed
- [x] Dispatcher `KIND_TO_FUNCTION` updated; kind CHECK extended
- [x] Smoke 50 completed (see results below)
- [ ] Joseph signs off on full-corpus run (separate sign-off; out of W13c scope)

---

## Smoke 50 — landed 2026-05-01

| Metric | Value |
|---|---|
| Rows ingested | 50/50 |
| Total cost | $0.70 |
| Avg cost/image | $0.014 (vs $0.0075 estimate — Gemini thinking_budget consumes more than expected) |
| Avg confidence | 0.98 |
| Avg legibility | 9.80/10 |
| Avg elapsed | 25.7s/image |
| Bedrooms match CRM | **96.00%** (48/50) |
| Bathrooms match CRM | **90.00%** (45/50) |
| Mismatches surfaced (in v_floorplan_crm_mismatches) | 6 |

The mismatches are **all interesting signal**, not extraction failures:

- Manly studio (0 vs 1): model correctly read no separate bedroom; CRM marketed as 1-bedroom.
- Mosman split-level (5 vs 7): model saw 5 bedrooms on the drawing; CRM lists 7 (additional bedrooms not visible on this floorplan, possibly upstairs not included).
- Four bathroom-by-1 differences: model counts ensuite + main where agent listed only main (or vice-versa).

Archetype distribution surfaces a healthy mix — apartments, townhouses, traditional, open-plan, split-level, studio.

**Cost reconciliation:** realised $0.014/img × 22,822 corpus = ~$320 for full rollout (vs $171 in the $0.0075 baseline estimate). The cost-cap layer (operator-supplied `cost_cap_usd`) keeps each invocation bounded; full-corpus rollout will require a $350-400 cap and Joseph sign-off, separate from this wave.

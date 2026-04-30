# W11.8 — Multi-Vendor Vision Adapter — Design Spec

**Status:** ✅ Shipped 2026-04-30. **Role updated 2026-04-30:** following the Saladine A/B iter-1 → iter-4 progression (validated head-to-head on the Saladine project), the Shape D engine now ships **Gemini 2.5 Pro as the production primary vendor**. W11.8's adapter layer remains in production as the **audit / A/B harness + production failover layer** — not the primary architecture. Joseph 2026-04-29: OpenAI dropped from scope; only Anthropic + Google.

> **TL;DR for readers:**
> - **Production engine default vendor: Gemini 2.5 Pro** (per Saladine A/B iter-4 results).
> - **Anthropic Opus 4.7 retained as failover** via configurable `engine_settings.production_vendor`.
> - **W11.8 is the adapter layer + ongoing audit harness**, not the primary architecture. The primary architecture is the Shape D 5-call multi-stage engine documented in `W11-7-unified-shortlisting-architecture.md`.
> - **Iter-1 → iter-4 is validated history**; the iteration log lives in W11.7 alongside the architecture rationale.

**Implementation commits (worktree `agent-a7d4a6556d05cdcc8`, awaiting orchestrator cherry-pick into main):**
- 1/7 `71e6825` — migration 350 (`vendor_shadow_runs`, `vendor_comparison_results`, 9 `engine_settings` rows)
- 2/7 `5bd9f30` — shared adapter interface (`_shared/visionAdapter/{types,pricing,index}.ts`) + 19 unit tests
- 3/7 `20e5356` — Anthropic adapter (tool-use + ephemeral cache) + thin compat wrapper at `_shared/anthropicVision.ts` + 15 unit tests
- 4/7 `7d6946b` — Google (Gemini) adapter (generateContent + responseSchema) + 19 unit tests
- 5/7 `68ea593` — `vendor-retroactive-compare` edge fn (master_admin only, cost gate, dropbox markdown upload)
- 6/7 `c074aaf` — comparison metrics + markdown report generator + 24 unit tests
- 7/7 (this commit) — `SettingsVendorComparison.jsx` admin page + nav + DEPLOYMENT_RUNBOOK GEMINI_API_KEY section

**Test count delta:** +76 tests (52 across `visionAdapter*.test.ts` — pricing/router/anthropic/google — plus 24 in `vendorComparisonMetrics.test.ts`).
**Frontend build:** clean, `SettingsVendorComparison-*.js` bundle present in `dist/assets/`.


**Backlog ref:** P1-26 (new)
**Wave plan ref:** W11.8 — production-grade adapter layer + per-stage model configuration + shadow-run A/B harness; post-Saladine repositioned as audit/A/B + failover
**Dependencies:** W7.7 (`engine_settings` table for runtime config), W11 (universal schema as the canonical output shape), W11.7 (Shape D multi-stage architecture is the consumer)
**Unblocks:** ongoing vendor A/B testing without code changes; vendor lock-in defence; production failover when the primary vendor degrades; future fine-tuned-self-hosted-model migration path

---

## Why this exists

Joseph 2026-04-29: *"i want path B [build vendor abstraction now, decide later], and i want to see us use a real testcase project that we already have rendered the jpg previews for and see the results across the whole engine comparing both API sources against each other."*

The pre-Shape D engine was locked to Anthropic. Switching any pass to another vendor would have required code changes to every edge function that calls the vision API. Path B inverts this: **vendor selection becomes runtime configuration**, A/B testing becomes a flag, and FlexMedia retains optionality on cost + quality decisions.

The 13 Saladine project (round `3ed54b53`, 42 composition_groups) was the live test case — its preview JPEGs already lived in Dropbox at `Photos/Raws/Shortlist Proposed/Previews/IMG_*.jpg`. Re-running the engine logic through Gemini and Anthropic across iter-1 through iter-4 produced directly-comparable outputs that validated Gemini 2.5 Pro as the primary vendor before committing the Shape D architecture flip. The iter-1 → iter-4 progression itself is captured as validated history in W11.7's architecture-decision narrative; W11.8 simply provided the substrate.

## Post-Saladine role (production architecture, 2026-04-30)

Following Saladine iter-4 sign-off:

- **Production primary vendor: Gemini 2.5 Pro** is the default for all Shape D stages (Stage 1 batch enrichment + Stage 4 visual master synthesis). The full architecture rationale lives in `W11-7-unified-shortlisting-architecture.md`.
- **Anthropic Opus 4.7 is retained as production failover.** When Gemini returns a hard error (rate limit, vendor outage, schema validation failure on retry) the orchestrator transparently routes the same prompt through Anthropic Opus 4.7 via this adapter. Operator UX is unaffected; the audit log records `vendor_meta.failover_triggered: true`.
- **`engine_settings.production_vendor` is configurable** (key shape: `vision.shape_d.primary_vendor` and `vision.shape_d.failover_vendor`), so a master_admin can flip the primary back to Anthropic in seconds if Gemini quality regresses on a model update.
- **Adapter abstraction stays as a long-term asset.** Vendor portability + ongoing audit are still core engine properties — not artifacts of one A/B experiment. Future fine-tuned self-hosted models, a hypothetical OpenAI re-introduction, or Australian-data-residency requirements all plug in as new adapter implementations without touching the Shape D orchestrator.
- **Audit / A/B harness role.** The shadow-run mechanism (Section 4) continues to fire periodically in production: every Nth shape_d round is run through the failover vendor in parallel and the comparison results land in `vendor_comparison_results`. This keeps the model-quality regression signal alive so a future Anthropic-Gemini swap is data-driven, not panic-driven.

---

## Architecture

### Section 1 — The adapter interface

New `_shared/visionAdapter.ts` exposes a unified call shape that all vendors implement against:

```typescript
// supabase/functions/_shared/visionAdapter.ts (new)

export type VisionVendor = 'anthropic' | 'google';

export interface VisionImage {
  /** 'base64' for inline bytes; 'url' for remote URL fetched server-side */
  source_type: 'base64' | 'url';
  /** image/jpeg | image/png | image/webp | image/gif */
  media_type: string;
  /** When source_type='base64' */
  data?: string;
  /** When source_type='url' */
  url?: string;
}

export interface VisionRequest {
  vendor: VisionVendor;
  /** Vendor-specific model id e.g. 'claude-opus-4-7' | 'gemini-2.0-pro' */
  model: string;
  /** Tool / function name when using strict-JSON output mode */
  tool_name: string;
  /** JSON schema for the structured output */
  tool_input_schema: Record<string, unknown>;
  /** System message — role context */
  system: string;
  /** User-message text part(s) */
  user_text: string;
  /** Images attached to the user message */
  images: VisionImage[];
  /** Conversation history (for multi-turn / prompt caching) */
  prior_turns?: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  /** Hard cap on output tokens */
  max_output_tokens: number;
  /** Temperature 0-1 */
  temperature?: number;
  /** Whether to enable prompt caching (Anthropic ephemeral / Gemini implicit) */
  enable_prompt_cache?: boolean;
  /** Hard timeout in ms */
  timeout_ms?: number;
}

export interface VisionResponse {
  /** Parsed structured output matching tool_input_schema */
  output: Record<string, unknown>;
  /** Cost / usage metrics for accounting */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    estimated_cost_usd: number;
  };
  /** Vendor metadata */
  vendor_meta: {
    vendor: VisionVendor;
    model: string;
    request_id: string;
    finish_reason: 'stop' | 'length' | 'tool_use' | 'safety' | 'error';
    elapsed_ms: number;
  };
  /** Raw response body (for debugging + audit) */
  raw_response_excerpt: string;  // first 2000 chars of vendor's raw JSON
}

/**
 * Single entry point. Routes the request to the right vendor adapter based on
 * vendor field. Returns vendor-agnostic VisionResponse shape.
 */
export async function callVisionAdapter(req: VisionRequest): Promise<VisionResponse>;
```

### Section 2 — Per-vendor adapters

Each vendor has a small adapter file that translates VisionRequest → vendor-specific call → VisionResponse.

```
_shared/visionAdapter/
├── index.ts                  # callVisionAdapter() router
├── types.ts                  # VisionRequest / VisionResponse / VisionVendor
├── pricing.ts                # per-vendor per-model token pricing tables
├── adapters/
│   ├── anthropic.ts          # Claude Opus / Sonnet / Haiku
│   ├── google.ts             # Gemini 2.0 Pro / Flash
│   └── __mocks__.ts          # test fixtures
└── visionAdapter.test.ts
```

#### Anthropic adapter notes
- Tool-use mode for strict JSON: `tool_choice: {type: 'tool', name: tool_name}`
- Prompt caching via `cache_control: {type: 'ephemeral'}` on stable prefix (images + slot defs)
- Existing `anthropicVision.ts` becomes a thin wrapper around this adapter

#### Google adapter notes
- Uses `@google/generative-ai` SDK or REST `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Schema enforcement via `generationConfig.responseMimeType: 'application/json'` + `responseSchema`
- 2M context window means many cases that need multi-message on Anthropic fit single call here
- Auth: `GEMINI_API_KEY` Supabase secret

#### OpenAI adapter — DROPPED 2026-04-29
Joseph chose to scope the A/B comparison to Anthropic vs Google only. The adapter interface is open enough that adding OpenAI later is a single-file addition (one new file under `adapters/openai.ts` + one new pricing row + one new vendor enum value). Kept off the v1 build to avoid scope creep.

### Section 3 — Per-stage model configuration

The Shape D stages (W11.7) choose models via `engine_settings`. Production defaults (post-Saladine iter-4) are Gemini 2.5 Pro on Stage 1 + Stage 4; Anthropic Opus 4.7 acts as failover.

```sql
-- Already exists from W7.7; we just add new keys
INSERT INTO engine_settings (key, value, description) VALUES
  ('vision.shape_d.primary_vendor',
   '"google"'::jsonb,
   'Production primary vendor for all Shape D stages. google | anthropic'),
  ('vision.shape_d.failover_vendor',
   '"anthropic"'::jsonb,
   'Vendor used when the primary returns a hard error (rate limit / outage / schema fail on retry).'),
  ('vision.shape_d.stage1.model',
   '"gemini-2.5-pro"'::jsonb,
   'Model id within the primary vendor for Stage 1 batch per-image enrichment (3-4 batches × 50 images).'),
  ('vision.shape_d.stage4.model',
   '"gemini-2.5-pro"'::jsonb,
   'Model id within the primary vendor for Stage 4 visual master synthesis (1 cross-image call across all 200).'),
  ('vision.shape_d.failover_stage1_model',
   '"claude-opus-4-7"'::jsonb,
   'Model id within the failover vendor for Stage 1.'),
  ('vision.shape_d.failover_stage4_model',
   '"claude-opus-4-7"'::jsonb,
   'Model id within the failover vendor for Stage 4.'),
  ('vision.shadow_run.enabled',
   'false'::jsonb,
   'When true, every Nth Shape D round ALSO fires a parallel shadow run against vision.shadow_run.vendor for ongoing A/B comparison. Cost grows by the sample fraction.'),
  ('vision.shadow_run.sample_rate',
   '0.05'::jsonb,
   'Fraction of rounds to fire a shadow run on (0.0-1.0). 0.05 = every 20th round.'),
  ('vision.shadow_run.vendor',
   '"anthropic"'::jsonb,
   'Shadow vendor when shadow_run.enabled=true. Defaults to the failover vendor.'),
  ('vision.shadow_run.model',
   '"claude-opus-4-7"'::jsonb,
   'Shadow model.')
ON CONFLICT (key) DO NOTHING;
```

Master_admin flips any of these via the existing `Settings → Engine Settings` admin page (W7.7). No code change required.

### Section 4 — Shadow-run A/B harness (the Saladine test mechanism)

When `vision.shadow_run.enabled = true`:

1. The unified call fires normally against the primary vendor (writes to DB as usual)
2. **In parallel**, the same prompt fires against the shadow vendor (writes to a separate `vendor_shadow_runs` table; does NOT affect operator UX)
3. After both complete, a comparison record is written to `vendor_comparison_results`

```sql
-- Migration 350_vendor_comparison.sql

CREATE TABLE IF NOT EXISTS vendor_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  pass_kind TEXT NOT NULL,         -- 'unified' | 'description_backfill' | 'pass0_hardreject'
  vendor TEXT NOT NULL,
  model TEXT NOT NULL,
  request_payload JSONB NOT NULL,  -- full VisionRequest for replay
  response_output JSONB,            -- the parsed output if successful
  response_usage JSONB,             -- usage metrics
  vendor_meta JSONB,                -- timing + finish_reason
  error_message TEXT,                -- non-null on failure
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shadow_runs_round ON vendor_shadow_runs(round_id);
CREATE INDEX idx_shadow_runs_vendor_model ON vendor_shadow_runs(vendor, model);

CREATE TABLE IF NOT EXISTS vendor_comparison_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  round_id UUID NOT NULL REFERENCES shortlisting_rounds(id) ON DELETE CASCADE,
  primary_vendor TEXT NOT NULL,
  primary_model TEXT NOT NULL,
  shadow_vendor TEXT NOT NULL,
  shadow_model TEXT NOT NULL,
  -- Decision-level metrics
  slot_decision_agreement_rate NUMERIC(4, 3),  -- 0-1; fraction of slots where both vendors picked same winner
  near_duplicate_agreement_rate NUMERIC(4, 3), -- fraction of near-dup clusters that match
  classification_agreement_rate NUMERIC(4, 3), -- fraction of compositions classified to same room_type
  -- Score-level metrics
  combined_score_mean_abs_delta NUMERIC(4, 2), -- |primary_score - shadow_score| averaged
  combined_score_correlation NUMERIC(4, 3),     -- Pearson correlation across all compositions
  -- Object detection metrics (W12 substrate)
  observed_objects_overlap_rate NUMERIC(4, 3), -- IoU of canonical-key sets
  -- Cost
  primary_cost_usd NUMERIC(6, 4),
  shadow_cost_usd NUMERIC(6, 4),
  -- Latency
  primary_elapsed_ms INT,
  shadow_elapsed_ms INT,
  -- Disagreement narrative (auto-generated from diff)
  disagreement_summary TEXT,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_comparison_round ON vendor_comparison_results(round_id);
```

Comparison metrics surface in `Settings → Engine → Vendor Comparison` admin page (new). Per-round drill-down shows side-by-side slot decisions + score deltas + object-detection overlaps.

### Section 5 — One-shot retroactive comparison tool

For the Saladine test (run BEFORE shadow_run mode is enabled in production), a separate edge function:

```typescript
// supabase/functions/vendor-retroactive-compare/index.ts

interface RetroactiveCompareRequest {
  round_id: string;                  // e.g. '3ed54b53-...' for Saladine
  vendors_to_compare: Array<{
    vendor: VisionVendor;
    model: string;
    label: string;                   // "anthropic-opus-baseline" / "google-pro-test"
  }>;
  pass_kinds: ('unified' | 'description_backfill')[];
  cost_cap_usd: number;              // safety guard
  dry_run?: boolean;                 // estimate cost only
}
```

The fn:
1. Loads the round's existing composition_group preview URLs from Dropbox
2. For each (vendor, model) configuration, fires the same prompts against the same images
3. Persists results in `vendor_shadow_runs` rows
4. Computes comparison metrics
5. Generates a markdown comparison report PDF (or HTML)

This is the test harness Joseph uses to validate vendor parity before flipping production.

### Section 6 — Master_admin UI

New page `Settings → Engine → Vendor Configuration`:
- Per-pass dropdown: vendor + model selection (reads/writes engine_settings)
- "Shadow run" toggle + shadow vendor/model selection
- "Run retroactive comparison" button — kicks off the one-shot tool above; needs a round_id + vendor list + cost cap input
- Recent comparison results table (drill-down to per-round side-by-side)

---

## The Saladine A/B test plan

**Test target:** project `1be81086-fb7f-4203-a7ef-9a161eec6611`, round `3ed54b53-9184-402f-9907-d168ed1968a4`, 42 composition_groups, Tier S.

**Vendors to compare:**

| Label | Vendor | Model | Role |
|---|---|---|---|
| `anthropic-opus-baseline` | anthropic | claude-opus-4-7 | Pass 2 unified-call baseline |
| `anthropic-sonnet-control` | anthropic | claude-sonnet-4-6 | Pass 1 baseline (currently deployed) |
| `google-pro-test` | google | gemini-2.0-pro | Pass 2 candidate |
| `google-flash-test` | google | gemini-2.0-flash | Backfill candidate |
~~OpenAI dropped from scope per Joseph 2026-04-29~~

**Cost estimate (42 compositions on Saladine):**
- Anthropic Opus 4.7 unified: ~$1.00
- Anthropic Sonnet 4.6 control: ~$0.50
- Gemini 2.0 Pro unified: ~$0.30
- Gemini 2.0 Flash backfill: ~$0.05
- GPT-4o unified: ~$0.70
- GPT-4o-mini backfill: ~$0.06
- **Total cost cap for full A/B: $5** (conservative)

**Output report (markdown + DB rows):**

For each vendor pair, produce:

1. **Slot decision agreement matrix** — 8 slots × 5 vendors. Where each vendor picked the winner. Operator can scan for divergence patterns.
2. **Score distribution comparison** — 5 vendors × 42 compositions. Shows whether Gemini also produces score compression (the P1-22 issue) or whether it uses the full 0-10 range.
3. **Room-type classification agreement** — does Gemini also mislabel IMG_6195 as exterior_front? Or does it correctly identify exterior_rear?
4. **Object detection overlap** — for the 5-10 most prominent observed objects per image, what % of canonical keys do vendors agree on? Critical for W12 substrate quality.
5. **Near-duplicate detection accuracy** — vendors compared against the original Pass 2 outputs.
6. **Cost actual + per-vendor latency** — empirical numbers for the cost model.
7. **Editorial summary** — qualitative head-to-head: "Gemini Pro identified Hills Hoist as a back-yard signal correctly on 4/4 images vs Sonnet 0/4. GPT-4o agreed with Sonnet on 3/4."

The report becomes the architectural decision document for which vendor handles which pass post-W11.7 launch.

---

## Migration

Reserve mig **350** (after W11.5=347, W11.6=348, W11.7=349).

Schema additions:
- `vendor_shadow_runs` table (per-call audit)
- `vendor_comparison_results` table (per-round metrics)
- Six `engine_settings` rows for per-pass vendor + model + shadow run config

---

## API key provisioning (BEFORE the Saladine test fires)

Joseph supplies these as Supabase project secrets:

```
GEMINI_API_KEY        for Google Gemini 2.0 Pro / Flash
~~OPENAI_API_KEY — DROPPED 2026-04-29 per Joseph; OpenAI not in v1 scope~~
```

Anthropic credential already exists (`ANTHROPIC_API_KEY`) and is unchanged.

The retroactive comparison tool refuses to fire if the required secret for any chosen vendor is missing — fails loud with explicit "GEMINI_API_KEY not configured" message rather than silently degrading.

---

## Effort estimate

- 1 day adapter interface + Anthropic adapter (refactor existing `anthropicVision.ts`)
- 1 day Google adapter
- ~~1 day OpenAI adapter~~ DROPPED
- 0.5 day pricing table + cost-tracking instrumentation
- 1 day shadow-run wiring in unified call (W11.7 dep)
- 1 day retroactive comparison fn + Saladine test execution
- 1 day comparison metrics computation + admin UI surface
- 0.5 day docs + tests
- **Total: ~7 days execution**

---

## Open questions for sign-off

**Q1.** Should the retroactive comparison tool persist new `composition_classifications` rows (overwriting existing Saladine data), or write to a separate "shadow" table that doesn't affect the live round?
**Recommendation:** **Separate shadow table.** Saladine's locked round must remain queryable in its original Anthropic-Sonnet output. Shadow runs are advisory data only; they never overwrite live round outputs.

**Q2.** A/B test scope — full unified-call comparison (42 compositions × 5 vendors = 210 calls) or just slot-decision-only?
**Recommendation:** **Full per-image classification + per-slot decision.** The score-compression diagnosis from P1-22 needs full per-image data to validate against Gemini's distribution.

**Q3.** Should the comparison report be auto-generated as a Dropbox PDF for archival, or live-only on the admin page?
**Recommendation:** **Both.** Live admin page for interactive review; PDF export to `Photos/_AUDIT/vendor_comparison_<round_id>.pdf` for posterity (matches W7.4's audit JSON pattern).

**Q4.** Default vendor for production after the A/B test?
**Recommendation (resolved 2026-04-30):** **Gemini 2.5 Pro is the production primary** per Saladine A/B iter-4 results. **Anthropic Opus 4.7 is retained as configurable failover** via `engine_settings.vision.shape_d.failover_vendor`. Full architecture rationale lives in W11.7.

---

## Pre-execution checklist

- [x] W7.7 ✅ shipped — `engine_settings` table exists for per-pass config
- [x] W11.7 spec authored — describes the unified call shape this adapter implements
- [x] Joseph provisioned `GEMINI_API_KEY` to Supabase secrets vault 2026-04-29 (OpenAI dropped from scope)
- [ ] Migration 350 reserved at integration time
- [ ] Joseph confirms Q1-Q4 above (defaults are defensible)
- [ ] Saladine round_id `3ed54b53-9184-402f-9907-d168ed1968a4` confirmed as test target

---

## What W11.8 protects you against

1. **Vendor pricing changes** — when Anthropic or Google raise prices, switch via config rather than code change
2. **Vendor quality regression** — if Gemini 2.5 Pro quality drops on a model update, flip `vision.shape_d.primary_vendor` to `"anthropic"` and the failover wiring takes over with no code change
3. **Vendor outage** — `vision.shape_d.failover_vendor` runs automatically when the primary returns a hard error; operator UX is unaffected
4. **Future fine-tuned self-hosted model** — when FlexMedia eventually fine-tunes Llama 3.2 90B Vision on the W13a goldmine corpus, it plugs into the same adapter interface as a third vendor (with `vendor: 'self_hosted'`)
5. **Geographic / sovereignty** — if Australian regulation requires data residency, can route through a self-hosted Australian-region GPU without code rewrite
6. **Ongoing audit signal** — the shadow-run sampling at 5% of production rounds keeps the regression-detection signal warm, so the next vendor swap is data-driven rather than panic-driven

This is **defensive architectural insurance** — engineering cost paid in full (~7 days, shipped 2026-04-30), high optionality value over the next 3-5 years of engine evolution.

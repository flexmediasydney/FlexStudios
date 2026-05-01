# Shortlisting Engine — Wave Plan

Sequenced architectural roadmap. Companion to `docs/WAVE_7_BACKLOG.md`
which captures items by priority (P0/P1/P2/P3); this doc captures items
by **wave**, with dependency graph and execution readiness.

Updated 2026-04-27 after Wave 0 closure + the wave-impact analysis.

---

## Naming

- A **wave** is a coherent body of work that produces one or more
  deployable bursts. Each wave has a single architectural theme.
- A **burst** is the unit of execution — small commit, deployable, pushed
  to main. Same pattern as Wave 6 bursts 1-23.
- The backlog priorities (P0-1, P1-1, etc.) map to wave numbers per the
  table below; both views coexist.

---

## Wave 0 — Safety net (✅ CLOSED 2026-04-27)

End-to-end Round 2 run on Everton 8/2 + 95 unit tests + CI workflow +
`docs/MIGRATION_SAFETY.md` + `docs/WAVE_7_BACKLOG.md`.

---

## Wave 7 — Foundation: packages, products, plumbing

**Theme:** make the engine config-driven instead of code-hardcoded; fix
the operational failure modes Round 2 exposed.

**Status:** Mixed readiness — P0 work is concrete, schema work needs
design phase.

### Bursts (in execution order)

| # | Item | Backlog ref | Status (2026-04-27) |
|---|---|---|---|
| W7.1 | `shortlist-lock` rewrite using `move_batch_v2` + `EdgeRuntime.waitUntil` + DB-persisted progress + frontend live progress UI | P0-1 | ✅ **shipped** (commits 3b17526, 0a229b0, d01d96b) — 165-file lock 30 min → 15 s (120× speedup) |
| W7.2 | `SHORTLISTING_DISPATCHER_JWT` deployment runbook + startup self-check 503 | P0-2 | ✅ **shipped** (commits 8b2ac89, 0948c00, df03a3d) — 109 unit tests + admin ops health page |
| W7.3 | Modal Dropbox token refresh from edge function (eliminates 4hr expiry) | P0-3 | ✅ **shipped** (commit 7bcf566) — Path B real-file smoke test passed: 5 CR3s, 13 s wall, Modal logs `dropbox token source: caller` |
| W7.4 | `shortlisting-confirm` audit JSON mirror | P1-12 | ✅ **shipped** (commits 90b791a, 6553924, 73bfbbe) — audit JSON written to `Photos/_AUDIT/round_N_locked_<ts>.json` after every successful lock |
| W7.5 | `pg_advisory_lock` cross-connection unlock fix (row-based mutex on `dispatcher_locks`) | P1-11 | ✅ **shipped** (commits d01f2e0, 4e515e7, 126c285, 2a75480) — mig 336 applied, both dispatchers using new mutex, smoke test confirms atomic acquire+release |
| W7.6 | Vision prompt refactor into composable `_shared/visionPrompts/` blocks | P1-10 | ⚙️ design spec ready (`docs/design-specs/W7-6-vision-prompt-blocks.md`); next subagent burst |
| W7.7 | Dynamic package/product/tier architecture: `shortlisting_tiers`, `package_engine_tier_mapping`, derived file counts, `engine_settings`, `project_types.shortlisting_supported`, drop legacy `package_types` | P1-6 | ✅ **shipped** (commits d410845, 66df867, 83d8fa7, 2751ff4, e6c161e, 1b21675) — mig 339 + helpers + 35 unit tests + 3 admin UIs; subsumes W7.9 (`expected_count_target/min/max` columns are dynamic, not fixed) |
| W7.12 | P1-18: migrate 4 remaining edge fns off legacy `DROPBOX_API_TOKEN` (chip spawned 2026-04-27) | P1-18 | ✅ ready (chip available) |
| W7.13 | Manual shortlisting mode for project types where AI doesn't apply (UX fork; engine bypass; same lock semantics) | P1-19 | ✅ **shipped** (commits 91ea4d3, 068ae67, faa8a2d, 689eb55, ecc01ae) — mig 340 extends shortlisting_rounds.status enum with 'manual'; `_shared/manualModeResolver.ts` pure helpers + 21 tests; `shortlist-lock` accepts `mode='manual'` with `approved_stems[]`; new `ManualShortlistingSwimlane` component (two-column drag-drop) + ProjectShortlistingTab forks on `project_type.shortlisting_supported`; per-row inline AI-toggle in Settings → Project Types |
| W7.8 | Product-driven slot eligibility (`engine_role` enum) — replaces flawed day/dusk flag | P1-8 | ✅ **shipped** (commits e7b8fb8, aeac3f2, 652a948, 72e0556, 2d4e1a4) — mig 337 applied + backfilled (28 products, 12 slots), smoke test confirms 12/12 slots resolve via engine_role on Everton 8/2; latent quarantine CHECK bug fixed as a bonus |
| W7.9 | Per-package `expected_file_count_range` (replaces hardcoded math) | P1-13 | ✅ **subsumed by W7.7** — `shortlisting_rounds.expected_count_target/_min/_max` now computed dynamically per round at ingest from project products via `_shared/packageCounts.computeExpectedFileCount()`; no per-package config needed |
| W7.10 | Notification routing seed (9 spec types) | P1-9 | ✅ ready (independent) |
| W7.11 | Frontend: replace hardcoded `["Gold", "Day to Dusk", "Premium"]` arrays in slots/training/overrides admin pages | P1-6 sibling | ✅ ready after W7.7 |
| W7.12 | P1-18: migrate 4 remaining edge fns off legacy `DROPBOX_API_TOKEN` (`listDropboxFiles`, `listDropboxFolders`, `getDropboxFilePreview`, `fetchDropboxShareLink`) | P1-18 | ✅ ready (chip spawned 2026-04-27) |

### Dependencies

```
W7.1 / W7.2 / W7.3 ── ✅ shipped 2026-04-27
W7.4 / W7.5 / W7.8 ── 🚧 in flight as parallel subagent burst
W7.6 ─── independent (prep for W11) — orchestrator authoring spec next
W7.7 ─── foundation for W7.9, W7.11. W7.8 verified independent (uses
         packages.products JSONB, doesn't need the sidecar)
W7.9 ─── depends on W7.7
W7.10 ── independent
W7.11 ── depends on W7.7
W7.12 ── independent (chip spawned, ready when picked up)
```

**Estimated total Wave 7 effort remaining:** ~2 weeks after current burst lands.

---

## Wave 8 — Tier configs

**Theme:** make tier-specific behaviour DB-driven and admin-configurable.

**Status:** ✅ **Shipped** — `docs/design-specs/W8-tier-configs.md` shipped as the consolidated W8 burst (subsumes W8.1-W8.4).

### Bursts (all subsumed into single shipped W8 burst)

| # | Item | Backlog ref | Status |
|---|---|---|---|
| W8.1 | `shortlisting_tier_configs` versioned table + admin UI + per-tier dimension weights | P1-7 | ✅ shipped |
| W8.2 | Pass 1 + Pass 2 read tier config; combined_score formula becomes weighted | P1-7 | ✅ shipped |
| W8.3 | Re-simulation safeguard — replay last 30 rounds under proposed weights, show diff | P1-17 | ✅ shipped |
| W8.4 | Round metadata columns (`engine_version`, `tier_config_version` — `tier_used` already covered by W7.7's `engine_tier_id`) | P1-15 | ✅ shipped |

**Migration:** 344. Edge fns: `update-tier-config` + `simulate-tier-config`. Admin UI: `flexmedia-src/src/pages/SettingsTierConfigs.jsx`. Audit JSON schema bumped to 1.1 with `engine_version` + `tier_config` block. v1 weights: 0.25/0.30/0.25/0.20 (Q1), uniform 1.0 signal weights (Q2), 30-round re-simulation (Q3), optimistic concurrency via partial unique index (Q4).

---

## ~~Wave 9~~ — ELIMINATED

Day/Dusk variants subsumed into Wave 7 (W7.8 product-driven slot
eligibility). Wave 9 no longer exists.

---

## Wave 10 — Multi-camera + override metadata

**Theme:** edge cases in the shoot pipeline + richer learning signal.

**Status:** Ready.

### Bursts

| # | Item | Backlog ref | Ready? |
|---|---|---|---|
| W10.1 | Multi-camera partitioning in `bracketDetector` (`camera_source`, `is_secondary_camera`) | P2-6 | ✅ shipped |
| W10.2 | Swimlane secondary-camera banner + iPhone "treated as singletons" notice | P2-6 | ✅ shipped |
| W10.3 | Override metadata columns (`review_duration_seconds`, `alternative_offered`, `alternative_selected`, `primary_signal_overridden`) + swimlane state tracking | P1-16 | ✅ shipped |

**Estimated total:** 1 week.

---

## Wave 11 — Universal vision response schema (KEYSTONE)

**Theme:** redesign the engine's vision output as a source-agnostic schema that
feeds object_registry + signals + image-type tables across RAW/finals/
external listings, **plus the Shape-D-specific fields** that emerged from the
2026-04-30 architecture pivot: `master_listing` per project, `voice_tier`,
canonical_id references, `appeal_signals`, `concern_signals`, `retouch_priority`,
`gallery_position_hint`, `style_archetype`, `embedding_anchor_text`, and the
5-level canonical vocabulary hierarchy.

**Status:** 🛑 **NEEDS FULL DESIGN PHASE BEFORE EXECUTION.** This is the
single most architecturally consequential wave in the roadmap. Cannot be
delegated to subagents without my up-front design work + Joseph's sign-off.

**Architectural pivot (2026-04-30):** the universal schema's compact per-image shape now anchors a **Shape D 5-call multi-stage Gemini-anchored architecture** (3-4 Stage 1 batch calls × 50 images each for full per-image enrichment, plus 1 Stage 4 visual master synthesis call across all 200 images). See W11.7 below — it inherits W11 as a hard dependency. W11 ships first (defines the schema, including master_listing + voice_tier + canonical_id + Stage 1 enrichment fields); W11.7 ships after (changes how the schema is produced).

### Design phase deliverables (before any code)

1. **Complete `image_type` field enum** — `is_drone`, `is_dusk`, `is_day`,
   `is_agent_headshot`, `is_test_shot`, `is_bts`, `is_floorplan`,
   `is_video_frame`, plus any others surfaced by inspection of historical
   rounds
2. **`observed_objects` JSON shape** — canonical key vs free-form on first
   observation; how the model emits when it doesn't know the canonical
   form yet
3. **All 22 signal measurement prompts** — today's signals are config
   without measurement instructions; Wave 11 needs each one prompted
4. **Source-calibration semantics** — how does the model know it's
   processing finals vs RAW? Caller-provided hint? Auto-detected from
   EXIF?
5. **Migration path** — Pass 1 today emits 4 dim aggregates; Wave 11
   emits per-signal scores. Backwards compat? Deprecation window?

### Bursts (after design phase)

| # | Item | Backlog ref |
|---|---|---|
| W11.1 | New universal vision response schema document + Pass 1 prompt rewrite | P1-14 + P2-1 |
| W11.2 | ~~`composition_signal_scores` sidecar table~~ — **subsumed by W11.7.17 — JSONB column on `composition_classifications` instead of sidecar table.** v2 spec dropped the sidecar table after Joseph's 2026-05-01 sign-off. | P2-1 |
| W11.3 | Pass 2 receives per-signal context | P2-1 |
| W11.4 | `composition_classifications.image_type_*` columns (or JSONB) | P1-14 |
| W11.5 | Tier-weighted dimension rollup using DB-driven weights from W8.1 | P2-1 |

**Estimated total:** 5-6 weeks (1 week design + 4-5 weeks execution).
Largest single wave.

---

## Wave 11.5 — Human reclassification capture

**Theme:** operators can correct Shape D mislabels (room_type, composition, vantage, score, slot eligibility) for both Stage 1 mistakes AND Stage 4 self-corrections; each correction feeds `project_memory` consumed in Stage 1's prompt context + cross-project canonical registry.

**Status:** ⚙️ **Spec ready** — `docs/design-specs/W11-5-human-reclassification-capture.md` (terminology refreshed 2026-04-30). Depends on W11 + W11.7 + W12. Mig 347.

**Effort:** ~2.5 days execution.

---

## Wave 11.6 — Rejection reasons admin dashboard

**Theme:** master_admin dashboard surfaces the captured override signal so a human can spot patterns and tune via W8 admin UI. Expanded under W11.7 to surface Stage 4 self-correction events, voice tier distribution, master_listing copy metrics, canonical registry coverage, and cost-per-stage attribution.

**Status:** ⚙️ **Spec ready** — `docs/design-specs/W11-6-rejection-reasons-dashboard.md` (widgets expanded 2026-04-30). Depends on W10.3 ✅ + W11.5 + W11.7. No migration.

**Effort:** ~4.5 days execution.

---

## Wave 11.7 — Shape D multi-stage Gemini-anchored shortlisting architecture (KEYSTONE FOR FUTURE WAVES)

**Theme:** the Shape D engine — 3-4 Stage 1 batch calls × 50 images each (full per-image enrichment: analysis, scoring, classification, clutter detection, per-image listing copy), plus 1 Stage 4 visual master synthesis call across all 200 images that emits slot decisions + a project-level `master_listing`. Primary vendor: **Gemini 2.5 Pro** per Saladine A/B iter-4 results; Anthropic Opus 4.7 retained as production failover. Project memory + canonical registry + few-shot library feed Stage 1's prompt context — closes the "engine grows per project" loop.

**Status:** 🚀 **In production as of 2026-05-01.** Default `engine_settings.engine_mode = "shape_d"`. Saladine smoke validated end-to-end (commit `6d117d9`, $1.31 / 5m 16s / 42 classifications / master_listing emitted / `engine_run_audit` row complete). Pass1+Pass2 retained as 30-day kill-switch fallback; **W11.7.10** schedules deprecation cleanup ~2026-06-01. Spec: `docs/design-specs/W11-7-unified-shortlisting-architecture.md`. Authored 2026-04-29; rewritten 2026-04-30 (Shape D pivot); cutover simplified 2026-05-01 (was 8-10 week phased rollout, collapsed to immediate cutover after validation showed no customer data tied to pass1+pass2). Mig 349.

### Bursts

| # | Item | Backlog ref | Status |
|---|---|---|---|
| W11.7.1 | `shortlisting-shape-d` edge fn — orchestration: project_memory load, Stage 1 batch dispatch, Stage 4 synthesis dispatch, master_listing persistence, vendor failover wiring | P1-25 | ✅ shipped |
| W11.7.2 | Stage 1 batch handler — per-batch Gemini 2.5 Pro call (50 images), full per-image enrichment (analysis, scoring, classification, clutter, per-image listing copy, appeal_signals, concern_signals, retouch_priority, gallery_position_hint, style_archetype) | P1-25 | ✅ shipped |
| W11.7.3 | Stage 4 visual master synthesis handler — single Gemini 2.5 Pro call across all 200 images, emits slot_decisions[] + master_listing block (voice_tier, word_count, reading_grade_level, key_elements with canonical_id refs, embedding_anchor_text) | P1-25 | ✅ shipped |
| W11.7.7 | Master listing copy synthesis — Stage 4 `master_listing` schema + synthesis prompt; SEO/social/brochure derivative outputs | P1-25 | ✅ shipped (Saladine validated 612 words / FK 9.5) |
| W11.7.8 | Voice tier modulation — `property_tier` input + voice anchor block (premium/standard/approachable) + 3 rubric blocks + override mechanism | P1-25 | ✅ shipped (standard tier validated; premium + approachable wired) |
| W11.7.9 | Master-class prompt enrichment — Sydney primer + self-critique + failure-mode blocks (lite); 9 hand-curated voice exemplars across 3 tiers (full) | P1-25 | ⚙️ partially shipped — lite version in production; full version (9 voice exemplars) pending Joseph's hand-curation |
| W11.7.10 | pass1+pass2 deprecation — after 30-day kill-switch window: verify zero traffic to `pass1`/`pass2` job kinds via `shortlisting_jobs.kind` audit; delete `shortlisting-pass1` + `shortlisting-pass2` edge fns; remove `pass1`/`pass2` from `KIND_TO_FUNCTION`; remove pass1→pass2 chain coordination logic; drop `'two_pass'` from `engine_settings.engine_mode` allowed values via CHECK constraint update; audit existing 2 test rounds with `engine_mode='two_pass'` (immutable history, leave alone); sunset migration `380_sunset_two_pass_engine.sql` | P1-25 | ⚙️ scheduled ~2026-06-01 (30-day window from cutover) |

**Note (replaced phase bursts):** previously planned W11.7.4 / .5 / .6 sub-bursts (Phase A coexistence / Phase B 4-week pilot / Phase C default flip + Phase D deprecation) were collapsed into the immediate cutover on 2026-05-01 + the W11.7.10 deprecation cleanup. The `engine_mode` router that came out of Phase A work stays in production as the kill-switch substrate.

**Cost model:** Saladine smoke (42 composition groups) ran at $1.31 wall-to-wall. Projected $3.14 - $6.00 per typical 200-angle shoot under Gemini 2.5 Pro. Replaces the earlier Opus-anchored projection of $1.78 - $9.00.

**Estimated total:** ~13 days build (shipped) + 30-day kill-switch window + ~1 day W11.7.10 cleanup. ~30 days calendar end-to-end.

**Why this wave matters:** it's the architectural bridge between today's open-loop engine (data captured, learning manual) and the closed-loop ethos Joseph articulated (every override + reclassification + observation feeds the next round and every future round). Without W11.7, W12's registry, W14's calibration, and W11.5's reclassifications all land but don't compound into the engine's prompt context. With Shape D, every captured signal becomes prompt context for the next Stage 1 batch — Gemini-primary cost economics make this loop affordable to run on every round.

**Pass 1 + Pass 2 deprecation timeline (W11.7.10):**
- Begins ~2026-06-01 (30-day kill-switch window from cutover)
- Verify zero traffic to `pass1` / `pass2` kinds via `shortlisting_jobs.kind` audit
- `shortlisting-pass1` + `shortlisting-pass2` edge functions deleted
- Dispatcher's `pass1` and `pass2` job kinds removed; pass1→pass2 chain logic removed
- `'two_pass'` dropped from `engine_settings.engine_mode` CHECK constraint
- `shortlisting_rounds.engine_mode` historical stamp preserved indefinitely for replay (`two_pass` rows from 3 historical test rounds remain immutable)

---

## Wave 11.7.17 — Universal Vision Response Schema v2 cutover (✅ shipped)

**Theme:** unify the Stage 1 vision response schema across the 4 source contexts (internal_raw, internal_finals, external_listing, floorplan_image) so a single Stage 1 caller can be re-aimed at finals, external REA listings, and floorplan images by flipping a `source_type` input — with no parallel forks of prompt logic, no per-source schema column gymnastics, and no breaking change to the 4-axis dimension scores already in production.

**Status:** ✅ **Shipped 2026-05-01.** Hard cutover to `schema_version='v2.0'` (Q6 binding — no dual-emit window). Existing v1 rows tagged `schema_version='v1.0'` and immutable; new emissions are v2 from this point forward. Spec: `docs/design-specs/W11-universal-vision-response-schema-v2.md`. Mig 398.

**Joseph's binding decisions (signed off 2026-05-01):**
- **Q1** — `image_type` enum: ship the 11 options as listed (is_day, is_dusk, is_drone, is_agent_headshot, is_test_shot, is_bts, is_floorplan, is_video_frame, is_detail_shot, is_facade_hero, is_other).
- **Q2** — Lighting dimension: ADD 4 NEW lighting signals (`light_quality`, `light_directionality`, `color_temperature_appropriateness`, `light_falloff_quality`). Total = **26 signals** (22 from v1 + 4 new lighting). `lighting_score` aggregate computes from these 4.
- **Q3** — Bounding boxes on `observed_objects`: **DEFAULT ON**. Stage 1 emits `bounding_box: {x_pct, y_pct, w_pct, h_pct}` on every observed_object by default.
- **Q4** — DROP `external_specific.delivery_quality_grade` letter scale. External listings get `combined_score` numeric only.
- **Q5** — 4 nullable `*_specific` blocks; enforced via prompt + persist-layer validation.
- **Q6** — HARD CUTOVER to v2.0. Existing v1 rows tagged `schema_version='v1.0'` (immutable historical record); new emissions are v2 from day one.
- **Q7** — `floorplan_image` kept as its own source type (separate schema branch).

### Bursts

| # | Item | Status |
|---|---|---|
| W11.7.17.1 | Mig 398: additive columns (`source_type`, `image_type`, `raw_specific`, `finals_specific`, `external_specific`, `floorplan_specific`, `observed_objects`, `observed_attributes`, `schema_version`) + indexes; backfill existing rows with `source_type='internal_raw'`, `schema_version='v1.0'` | ✅ |
| W11.7.17.2 | New block `universalVisionResponseSchemaV2.ts` (`UNIVERSAL_VISION_RESPONSE_SCHEMA_VERSION = 'v2.0'`) — 26 signals, bounding_box required, 4 nullable `*_specific` blocks, no `delivery_quality_grade` | ✅ |
| W11.7.17.3 | New block `signalMeasurementBlock.ts` (`SIGNAL_MEASUREMENT_BLOCK_VERSION = 'v1.0'`) — source-aware 26-signal measurement prompts with per-source activation tails | ✅ |
| W11.7.17.4 | Bump `sourceContextBlock.ts` to `v1.1` — appends per-source field-list paragraphs (which `*_specific` to populate, which 3 to leave null) | ✅ |
| W11.7.17.5 | `shortlisting-shape-d/index.ts` Stage 1 prompt swaps `stage1ResponseSchema` for `universalVisionResponseSchemaV2`; injects `signalMeasurementBlock(source_type)` after `header` and before `roomTypeTaxonomy`; persist-layer extends to write the 4 new JSONB columns + `source_type` + `image_type` + `schema_version='v2.0'`; `stage1PromptBlockVersions` map gains `universal_vision_response_schema='v2.0'` + `signal_measurement='v1.0'`, drops `stage1_response_schema`. Stage 4 schema OUT OF SCOPE per spec Appendix A. | ✅ |
| W11.7.17.6 | New `_shared/dimensionRollup.ts` helper — `computeAggregateScores()` rolls 26 signals into 4 dimension aggregates + combined_score per spec §6. Tier-config-aware (signal_weights + dimension_weights). 46 unit tests covering all-present / partial / per-source dimorphism / tier weights / edge cases / Q2 lighting binding. | ✅ |
| W11.7.17.7 | Snapshot tests under `shortlisting-shape-d/__snapshots__/` covering all 4 source types + 2 defensive edge cases | ✅ |
| W11.7.17.8 | Smoke run on Rainbow Cres (`b7c2c9ac-41b3-44b5-b3ec-c0cc6b63f750`, round `c55374b1-1d10-4875-aaad-8dbba646ed3d`) — Stage 1 re-emitted at v2 (33 rows). Cost ~$0.50. | ✅ |
| W11.7.17.9 | Hard cutover: existing v1 rows preserved as immutable historical record; new emissions v2 from day one. **W15a / W15b / W15c UNBLOCKED.** | ✅ |

**Effort:** ~5 days execution (delivered as a single burst on 2026-05-01).

**Why this wave matters:** v2 is the schema that lets W15a (internal finals scoring) + W15b (external REA listing scoring) + W15c (cross-source competitor analysis) become incremental new callers of the same Stage 1 path — zero schema change, zero new persist tables. The schema work is all here.

---

## Wave 11.8 — Multi-vendor vision adapter (audit / A/B + failover)

**Theme:** vendor-agnostic adapter layer over Anthropic + Google vision APIs, per-stage model configuration in `engine_settings`, shadow-run A/B harness, production failover wiring.

**Status:** ✅ **Shipped 2026-04-30.** Role updated post-Saladine: serves as the **audit / A/B harness + production failover layer** — NOT the primary architecture. The Shape D engine (W11.7) is the primary; W11.8 is the substrate that enables vendor portability + ongoing audit.

**Production defaults (post-Saladine iter-4):**
- `vision.shape_d.primary_vendor` = `"google"` (Gemini 2.5 Pro)
- `vision.shape_d.failover_vendor` = `"anthropic"` (Opus 4.7)
- `vision.shadow_run.enabled` toggleable; sample rate ~5% of production rounds keeps regression-detection signal warm

**Spec:** `docs/design-specs/W11-8-multi-vendor-vision-adapter.md` (status + role updated 2026-04-30).

---

## Wave 12 — Object/Attribute Registry + AI suggestions

**Theme:** the engine grows institutional memory.

**Status:** ⚙️ **Full spec ready** — `docs/design-specs/W12-object-attribute-registry.md` (companion to the existing `W12-trigger-thresholds.md`). Per-Joseph normalisation runs **manual-trigger only** (no autonomous cron, mirrors W13a/b policy). Migration 345 enables pgvector at native dim 1536. Dispatchable when Joseph wants.

### Bursts (all covered by W12 spec)

| # | Item | Backlog ref |
|---|---|---|
| W12.1 | Migrations: 4 new tables (`object_registry`, `raw_attribute_observations`, `attribute_values`, `object_registry_candidates`) + pgvector | P2-2 |
| W12.2 | Pass 1 `objectsAndAttributes` block via W7.6 composable pattern (capped at top 200 canonicals by market_frequency) | P2-2 |
| W12.3 | `shortlisting-attribute-extractor` edge fn (runs after Pass 1, embeds raw_label at insert time) | P2-2 |
| W12.4 | Manual-trigger normalisation (cosine 0.92 / 0.75-0.92 / <0.75 thresholds) | P2-2 |
| W12.5 | Discovery queue UI (approve / reject / merge / defer; 14-day auto-archive) | P2-2 |
| W12.6 | AI suggestion engine reading `pass2_slot_suggestion` events | P2-3 |

**Depends on Wave 11** — Pass 1's `observed_objects` array shape locks in there.

**Estimated total:** 9-11 days per spec. **4 open Qs** all with orchestrator recommendations.

---

## Wave 13 — Goldmines (parallel sub-tracks)

**Theme:** bootstrap institutional memory from existing data.

**Status:** All three sub-tracks ready (after dependencies).

### Sub-tracks

#### W13a — Historical FlexMedia backfill

| # | Item | Backlog ref |
|---|---|---|
| W13a.1 | Synthetic-round creator (legacy projects → shortlisting_rounds + composition_groups) | P2-4 |
| W13a.2 | Two-input UX: pick project, paste raw folder + finals folder paths | P2-4 |
| W13a.3 | Run full pipeline → benchmark runner → enriched training_examples with package + tier + slot provenance | P2-4 |

**Depends on:** Wave 7 + Wave 8 (training rows need tier + package context).

#### W13b — Pulse description goldmine

| # | Item | Backlog ref |
|---|---|---|
| W13b.1 | Sonnet (default) / Opus (>$10M properties) extractor over 28k descriptions | P2-4 |
| W13b.2 | Each observation logs `listing_id` + `source_address` for full provenance | P2-4 |
| W13b.3 | Cluster by frequency to populate `object_registry.market_frequency` | P2-4 |

**Depends on:** Wave 12 (object_registry tables must exist).

#### W13c — Floorplan OCR goldmine

| # | Item | Backlog ref |
|---|---|---|
| W13c.1 | Sonnet OCR over `pulse_listings.floorplan_urls` (7,881 images) | P2-4 |
| W13c.2 | Aggregate room name frequencies; cluster synonyms | P2-4 |
| W13c.3 | Validate Pass 1 room_type taxonomy against ground-truth Sydney architectural drawings | P2-4 |

**Depends on:** Wave 12 (object_registry tables).

**Estimated total:** 3-5 weeks parallelizable.

---

## Wave 14 — 50-project structured calibration

**Theme:** establish the permanent benchmark set + name override patterns.

**Status:** ⚙️ **Spec ready** — `docs/design-specs/W14-calibration-session.md`. Reuses existing `shortlisting-benchmark-runner` (no fork). Hard-blocked on Wave 12 landing. Migration 346.

### Bursts (covered by W14 spec)

| # | Item | Backlog ref |
|---|---|---|
| W14.1 | New 3-table schema (`calibration_sessions`, `calibration_editor_shortlists`, `calibration_decisions`) | P2-5 |
| W14.2 | Blind editor declaration phase (mandatory, not skippable per R2 — prevents AI-anchoring bias) | P2-5 |
| W14.3 | Side-by-side diff phase + per-disagreement editor reasoning + `primary_signal_diff` capture (mandatory on disagreements per R3) | P2-5 |
| W14.4 | Stratification: 48 stratified across (package × tier × geography) cells + 2 wildcards | P2-5 |
| W14.5 | Wave 12 validation hook: cross-reference disagreements against `pass2_slot_suggestion` events | P2-3 validation |

**Estimated total:** 9-10 engineering days + 25 hours editor labour. **3 open Qs** (editor budget, stratification cells, annual cadence).

---

## Wave 15 — Pulse Vision (multi-wave program)

**Theme:** apply the universal vision response schema (Wave 11) to internal
finals + external REA listings + competitor analysis.

**Status:** 🟢 **UNBLOCKED 2026-05-01** — W11.7.17 universal schema v2 cutover shipped. Each of W15a/b/c is now a 2-3 day burst of caller wiring + storage routing — zero schema change.

### Sub-waves

#### W15a — Internal finals scoring (🟢 unblocked)

Score our own delivered JPEGs to populate the universal vision response
table for finished media. Same engine, different reject criteria (finals
should NOT have window blowout, vertical lines should be straightened, etc).

#### W15b — External REA listing scoring + missed-opportunity recalibration (🟢 unblocked)

The big business value. Per spec section 24:
- Early-exit signal acquisition (dusk_confirmed, drone_confirmed,
  video_confirmed, floorplan_present, photo_count)
- Package tier inference based on signal combinations
- `has_video` sync lag fix (vision detects dusk → forces re-fetch of
  REA video URL)
- `pulse_listing_missed_opportunity.quoted_price` self-heals from rules-
  based bucket guesses to vision-informed accuracy

#### W15c — Cross-source competitor analysis (🟢 unblocked)

`object_registry` and `signal_scores` are now populated from THREE sources
(internal RAW, internal finals, external listings). Cross-source queries:
- "How does our delivered quality compare to Continuous Creative on
  $3M+ Mosman properties?"
- "What features do competitors photograph that we miss?"
- "Which agencies are over-buying their tier?"

**Estimated total Wave 15 program:** 6-8 weeks.

---

## Sequencing summary

```
Critical path (serial):
  W7 → W8 → W11 → W11.7 (Shape D, Gemini-primary, 🚀 shipped 2026-05-01) →
    W11.7.10 (pass1+pass2 deprecation cleanup, scheduled ~2026-06-01) →
    W12 → W13a/b/c → W14 → W15a/b/c

Parallelizable:
  W7.1/W7.2/W7.3 can run simultaneously
  W7.10 independent
  W10 can start anytime after W7.7 (uses tier_used from W8.4 if available)
  W11.8 ✅ shipped — runs alongside W11.7 as audit/A/B + failover
  W11.5, W11.6 ship after W11.7 lands (W11.7 ✅ shipped, so these are unblocked)
  W12 unblocks the canonical-registry feedback loop that Stage 1 reads (W12 work
    runs in parallel with the 30-day W11.7 kill-switch window)
  W13a/b/c sub-tracks parallel after their dependencies
  W15a/b/c sub-tracks parallel after W11 lands

Total elapsed if fully serialized: ~5-6 months.
With parallelism (Gemini-primary in production + W12 in flight + W11.7.10
deprecation in flight) + design-phase prep work in flight: ~3-4 months.
```

## Orchestrator readiness map (updated 2026-04-27)

| Wave | Status |
|---|---|
| W7.1 / W7.2 / W7.3 | ✅ **shipped** + Path B validated end-to-end |
| W7.4 / W7.5 / W7.8 | ✅ **shipped** — burst completed 2026-04-27, integrated to main, smoke tests passed |
| W7.6 | ⚙️ design spec ready (`docs/design-specs/W7-6-vision-prompt-blocks.md`); ready to dispatch as next subagent burst |
| W7.7 | ✅ **shipped** — mig 339, helpers, engine integration, 3 admin UIs (commits d410845, 66df867, 83d8fa7, 2751ff4, e6c161e, 1b21675) |
| W7.9 | ✅ subsumed by W7.7 (target/min/max counts handled dynamically) |
| W7.11 | ✅ ready after W7.7 |
| W7.10 / W7.12 | ✅ ready (independent) |
| W8 | ✅ **shipped** — mig 344 + edge fns + admin UI + audit JSON schema 1.1 |
| W10 | ✅ yes |
| **W11** | 🛑 **design phase active** — full spec exists at `docs/design-specs/W11-universal-vision-response-schema.md`; needs Joseph's sign-off on the 22 measurement prompts + new Shape D fields (master_listing, voice_tier, canonical_id refs, appeal/concern_signals, retouch_priority, gallery_position_hint, style_archetype, embedding_anchor_text, 5-level canonical vocabulary hierarchy) before execution |
| W11.5 | ⚙️ spec ready (terminology refreshed 2026-04-30); ships after W11 + W11.7 |
| W11.6 | ⚙️ spec ready (Shape D widgets expanded 2026-04-30); ships now that W11.7 is in production (cutover 2026-05-01) |
| **W11.7** | 🚀 **In production 2026-05-01** — Shape D shipped. Default `engine_settings.engine_mode = "shape_d"`. W11.7.1 / .2 / .3 / .7 / .8 ✅ shipped; W11.7.9 ⚙️ partially shipped (lite version in prod, full version pending Joseph's curation); W11.7.10 ⚙️ scheduled ~2026-06-01 (pass1+pass2 deprecation after 30-day kill-switch window) |
| W11.8 | ✅ **shipped 2026-04-30** — audit / A/B + failover role |
| W12 | ⚠️ trigger threshold decisions captured in `docs/design-specs/W12-trigger-thresholds.md`; ready when W11 lands. Unblocks the canonical-registry feedback loop that Shape D Stage 1 reads as prompt context |
| W13a / W13b / W13c | ✅ yes after dependencies |
| W14 | ✅ yes after W12 |
| W15 | 🛑 cannot start until W11 ships |

**Workflow I'll use as orchestrator:**
1. Run concrete bursts (✅) immediately via subagent delegation
2. Before each ⚠️ design-phase wave, write a 1-2 page Design Spec doc,
   get Joseph's sign-off, THEN delegate execution
3. For 🛑 waves (W11, W15), Joseph + I do the design together — no
   subagent delegation until decisions are locked

This keeps Joseph in the loop on load-bearing decisions but doesn't
block velocity on concrete work.

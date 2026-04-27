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
| W7.7 | `package_shortlist_configs` sidecar + `tiers` first-class table + slot FK refactor | P1-6 | ⚠️ draft spec authored (`docs/design-specs/W7-7-package-shortlist-configs.md`); 6 cross-engine open questions await Joseph |
| W7.8 | Product-driven slot eligibility (`engine_role` enum) — replaces flawed day/dusk flag | P1-8 | ✅ **shipped** (commits e7b8fb8, aeac3f2, 652a948, 72e0556, 2d4e1a4) — mig 337 applied + backfilled (28 products, 12 slots), smoke test confirms 12/12 slots resolve via engine_role on Everton 8/2; latent quarantine CHECK bug fixed as a bonus |
| W7.9 | Per-package `expected_file_count_range` (replaces hardcoded math) | P1-13 | ✅ ready after W7.7 |
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

**Status:** Ready after Wave 7 lands `tiers` table.

### Bursts

| # | Item | Backlog ref | Ready? |
|---|---|---|---|
| W8.1 | `shortlisting_tier_configs` versioned table + admin UI + per-tier dimension weights | P1-7 | ✅ ready (depends on W7.7) |
| W8.2 | Pass 1 + Pass 2 read tier config; combined_score formula becomes weighted | P1-7 | ✅ ready after W8.1 |
| W8.3 | Re-simulation safeguard — replay last 30 rounds under proposed weights, show diff | P1-17 | ✅ ready |
| W8.4 | Round metadata columns (`engine_version`, `tier_used`, `tier_config_version`) | P1-15 | ✅ ready |

**Estimated total:** 1-1.5 weeks.

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
| W10.1 | Multi-camera partitioning in `bracketDetector` (`camera_source`, `is_secondary_camera`) | P2-6 | ✅ ready |
| W10.2 | Swimlane secondary-camera banner + iPhone "treated as singletons" notice | P2-6 | ✅ ready |
| W10.3 | Override metadata columns (`review_duration_seconds`, `alternative_offered`, `alternative_selected`, `primary_signal_overridden`) + swimlane state tracking | P1-16 | ✅ ready |

**Estimated total:** 1 week.

---

## Wave 11 — Universal vision response schema (KEYSTONE)

**Theme:** redesign Pass 1's output as a source-agnostic schema that
feeds object_registry + signals + image-type tables across RAW/finals/
external listings.

**Status:** 🛑 **NEEDS FULL DESIGN PHASE BEFORE EXECUTION.** This is the
single most architecturally consequential wave in the roadmap. Cannot be
delegated to subagents without my up-front design work + Joseph's sign-off.

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
| W11.2 | `composition_signal_scores` table + Pass 1 post-processing | P2-1 |
| W11.3 | Pass 2 receives per-signal context | P2-1 |
| W11.4 | `composition_classifications.image_type_*` columns (or JSONB) | P1-14 |
| W11.5 | Tier-weighted dimension rollup using DB-driven weights from W8.1 | P2-1 |

**Estimated total:** 5-6 weeks (1 week design + 4-5 weeks execution).
Largest single wave.

---

## Wave 12 — Object/Attribute Registry + AI suggestions

**Theme:** the engine grows institutional memory.

**Status:** Schema clear; trigger thresholds need decisions.

### Design phase deliverables (~half-day)

1. AI suggestion trigger thresholds — "suggest new room_type when
   model proposes X times in Y days at Z confidence" — pick X/Y/Z
2. Confirm pgvector similarity thresholds (0.92 / 0.75 / <0.75) or tune

### Bursts

| # | Item | Backlog ref |
|---|---|---|
| W12.1 | Migrations: `object_registry`, `attribute_values` (with pgvector), `raw_attribute_observations` | P2-2 |
| W12.2 | Seed `object_registry` from spec section 11 bootstrap list | P2-2 |
| W12.3 | New edge function `shortlisting-attribute-extractor` runs after Pass 1 | P2-2 |
| W12.4 | Pass 1 `key_elements` + `observed_objects` write to `raw_attribute_observations` | P2-2 |
| W12.5 | Nightly normalisation batch (Modal worker or pg_cron) | P2-2 |
| W12.6 | Discovery queue UI for new candidate review | P2-2 |
| W12.7 | AI suggestion engine for room_types + slots | P2-3 |
| W12.8 | Admin UI mining `pass2_slot_suggestion` events for slot proposals | P2-3 |

**Depends on Wave 11** — Pass 1's `observed_objects` array shape locks
in here.

**Estimated total:** 4-6 weeks.

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

**Status:** Ready after Wave 12 (so suggestions engine can be tested).

### Bursts

| # | Item | Backlog ref |
|---|---|---|
| W14.1 | `CalibrationSession` admin tool — parallel UI showing AI vs human shortlists per project | P2-5 |
| W14.2 | Editor manually shortlists 50 stratified projects | P2-5 |
| W14.3 | AI shortlists same 50 in blind mode (using benchmark runner) | P2-5 |
| W14.4 | Side-by-side diff capture per disagreement → `calibration_decisions` table | P2-5 |
| W14.5 | Stress-test Wave 12's AI suggestion engine — do editor disagreements correlate with model's proposed slots/room_types? | P2-3 validation |

**Estimated total:** 1-2 weeks engineering + 25 hours editor labour.

---

## Wave 15 — Pulse Vision (multi-wave program)

**Theme:** apply the universal vision response schema (Wave 11) to internal
finals + external REA listings + competitor analysis.

**Status:** 🛑 Cannot start until Wave 11 schema is live.

### Sub-waves

#### W15a — Internal finals scoring

Score our own delivered JPEGs to populate the universal vision response
table for finished media. Same engine, different reject criteria (finals
should NOT have window blowout, vertical lines should be straightened, etc).

#### W15b — External REA listing scoring + missed-opportunity recalibration

The big business value. Per spec section 24:
- Early-exit signal acquisition (dusk_confirmed, drone_confirmed,
  video_confirmed, floorplan_present, photo_count)
- Package tier inference based on signal combinations
- `has_video` sync lag fix (vision detects dusk → forces re-fetch of
  REA video URL)
- `pulse_listing_missed_opportunity.quoted_price` self-heals from rules-
  based bucket guesses to vision-informed accuracy

#### W15c — Cross-source competitor analysis

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
  W7 → W8 → W11 → W12 → W13a/b/c → W14 → W15a/b/c

Parallelizable:
  W7.1/W7.2/W7.3 can run simultaneously
  W7.10 independent
  W10 can start anytime after W7.7 (uses tier_used from W8.4 if available)
  W13a/b/c sub-tracks parallel after their dependencies
  W15a/b/c sub-tracks parallel after W11 lands

Total elapsed if fully serialized: ~5-6 months.
With parallelism + design-phase prep work in flight: ~3-4 months.
```

## Orchestrator readiness map (updated 2026-04-27)

| Wave | Status |
|---|---|
| W7.1 / W7.2 / W7.3 | ✅ **shipped** + Path B validated end-to-end |
| W7.4 / W7.5 / W7.8 | ✅ **shipped** — burst completed 2026-04-27, integrated to main, smoke tests passed |
| W7.6 | ⚙️ design spec ready (`docs/design-specs/W7-6-vision-prompt-blocks.md`); ready to dispatch as next subagent burst |
| W7.7 | ⚠️ draft spec authored; 6 cross-engine questions await Joseph's review |
| W7.9 / W7.11 | ✅ ready after W7.7 |
| W7.10 / W7.12 | ✅ ready (independent) |
| W8 | ✅ yes after W7.7 |
| W10 | ✅ yes |
| **W11** | 🛑 **design phase active** — full spec exists at `docs/design-specs/W11-universal-vision-response-schema.md`; needs Joseph's sign-off on the 22 measurement prompts before execution |
| W12 | ⚠️ trigger threshold decisions captured in `docs/design-specs/W12-trigger-thresholds.md`; ready when W11 lands |
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

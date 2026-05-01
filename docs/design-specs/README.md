# Design Specs — Index

This folder holds the per-wave design-spec docs that need to be authored
**before** their wave can be delegated to subagents for execution.

The pattern: I (orchestrator) write each spec, get Joseph's sign-off on
the open questions, then dispatch the execution to a subagent.

## Status legend

- 🛑 **Architectural keystone** — most consequential design decision; cannot be skipped
- ⚠️ **Decision required** — choose an option, document tradeoffs
- ⚙️ **Detail spec** — flow mapping, table shape, prompt block contracts
- ✅ **Sign-off only** — proposal is concrete; awaiting Joseph's approval
- ✅ **shipped** — execution complete, deployed, verified
- 🚀 **in production** — live and serving customer traffic

## Specs

| Doc | Wave | Status | Purpose |
|---|---|---|---|
| [W7-4-shortlisting-confirm-flow.md](./W7-4-shortlisting-confirm-flow.md) | W7.4 | ✅ shipped | Audit JSON mirror; lands at `Photos/_AUDIT/round_N_locked_<ts>.json` after every lock |
| [W7-5-pg-advisory-lock-fix.md](./W7-5-pg-advisory-lock-fix.md) | W7.5 | ✅ shipped | Row-based `dispatcher_locks` mutex (mig 336) — atomic acquire+release confirmed in prod |
| [W7-6-vision-prompt-blocks.md](./W7-6-vision-prompt-blocks.md) | W7.6 | ⚙️ ready | Composable prompt blocks API. Self-resolved by orchestrator; ready for subagent dispatch. Unblocks W11 plug-in point |
| [W7-7-package-shortlist-configs.md](./W7-7-package-shortlist-configs.md) | W7.7 | ✅ shipped | Dynamic package/product/tier architecture. Mig 339, helpers, engine integration, 3 admin UIs — commits d410845, 66df867, 83d8fa7, 2751ff4, e6c161e, 1b21675. Subsumes W7.9 / P1-13 |
| [W7-13-manual-shortlisting-mode.md](./W7-13-manual-shortlisting-mode.md) | W7.13 | ✅ shipped | UX fork for project types where AI shortlisting doesn't apply. Manual swimlane + lock-triggers-move. Mig 340 (status enum extension) + `_shared/manualModeResolver.ts` + `shortlist-lock` mode='manual' + `ManualShortlistingSwimlane` + Settings inline toggle |
| [W7-8-product-driven-slot-eligibility.md](./W7-8-product-driven-slot-eligibility.md) | W7.8 | ✅ shipped | `engine_role` enum + `eligible_when_engine_roles` (mig 337) — 28 products + 12 slots backfilled; latent quarantine CHECK bug fixed as bonus |
| [W10-1-multi-camera-partitioning.md](./W10-1-multi-camera-partitioning.md) | W10.1 | ⚙️ ready | Multi-camera partitioning in bracketDetector. New `composition_groups.camera_source` + `is_secondary_camera`. iPhone/secondary singletons banner via W10.2 contract baked in. Mig 340 |
| [W10-3-override-metadata-columns.md](./W10-3-override-metadata-columns.md) | W10.3 | ✅ shipped | All 4 named columns already exist (mig 285); W10.3 ships frontend instrumentation: per-card IntersectionObserver timer, drawer interaction tracking, SignalAttributionModal. Adds mig 342 (alternative_offered_drawer_seen) + edge fn annotate action |
| [W8-tier-configs.md](./W8-tier-configs.md) | W8 | ✅ shipped | `shortlisting_tier_configs` versioned table + Pass 1/2 weighted score rollup + re-simulation safeguard + audit JSON `engine_version` + `tier_config` block (schema 1.1). Mig 344, edge fns `update-tier-config` + `simulate-tier-config`, admin UI `SettingsTierConfigs`. Subsumes W8.1-W8.4 |
| [W11-universal-vision-response-schema.md](./W11-universal-vision-response-schema.md) | W11 | 🛑 | THE keystone — universal schema for vision API across all sources (RAW/finals/external). Pass 1 prompt + per-signal scoring + 22 measurement prompts |
| [W11-5-human-reclassification-capture.md](./W11-5-human-reclassification-capture.md) | W11.5 | ⚙️ ready | Operators correct Pass 1 mislabels (room_type, composition, vantage, score, slot eligibility). New `composition_classification_overrides` table; Pass 2 reads COALESCE(human, ai). Feeds W12 canonical memory + W14 few-shot library. Mig 347 |
| [W11-6-rejection-reasons-dashboard.md](./W11-6-rejection-reasons-dashboard.md) | W11.6 | ⚙️ ready | Master_admin dashboard surfaces override patterns from W10.3's captured data: signal frequency, per-room-type × tier heatmap, tier-config impact tracker, outlier projects, reclassification log (W11.5 dep). Closes the human-tuning loop |
| [W11-7-unified-shortlisting-architecture.md](./W11-7-unified-shortlisting-architecture.md) | W11.7 | 🚀 in production | Shape D 5-call multi-stage Gemini-anchored architecture. 3-4 Stage 1 batch calls × 50 images each (full per-image enrichment) + 1 Stage 4 visual master synthesis call across all 200 images that emits slot decisions + master_listing block. Primary vendor: Gemini 2.5 Pro per Saladine A/B iter-4. Anthropic Opus 4.7 retained as failover. Saladine smoke validated (commit `6d117d9`, $1.31 / 5m 16s). **Default flipped 2026-05-01** (`engine_settings.engine_mode = "shape_d"`); previously planned 8-10 week phased rollout simplified to immediate cutover after validation. Mig 349 |
| [W11-7-7-master-listing-copy-synthesis.md](./W11-7-7-master-listing-copy-synthesis.md) | W11.7.7 | ✅ shipped | Stage 4 master_listing copy output: structure, fields, validators, voice/grade-level constraints, lifecycle in `master_listings` table, integration with delivery. Saladine smoke validated 612 words / FK 9.5 |
| [W11-7-8-voice-tier-modulation.md](./W11-7-8-voice-tier-modulation.md) | W11.7.8 | ✅ shipped | Premium / Standard / Approachable tier system: package mapping, modulation rules at Stage 4, 3 rubric blocks, override paths, audit signals. Standard tier validated on Saladine; premium + approachable wired and ready |
| [W11-7-9-master-class-prompt-enrichment.md](./W11-7-9-master-class-prompt-enrichment.md) | W11.7.9 | ⚙️ partially shipped | Lite version (Sydney market primer + self-critique block + failure-mode block) shipped and validated by Saladine smoke. Full version (9 hand-curated voice exemplars across the 3 tiers) pending Joseph's curation pass |
| W11.7.10 (pass1+pass2 deprecation) | W11.7.10 | ⚙️ scheduled (30-day window) | After 30-day kill-switch window (target ~2026-06-01): verify zero traffic to `pass1`/`pass2` kinds, delete `shortlisting-pass1` + `shortlisting-pass2` edge fns, remove `pass1`/`pass2` from dispatcher `KIND_TO_FUNCTION` + chain coordination logic, drop `'two_pass'` from `engine_settings.engine_mode` allowed values, audit existing 2 historical `engine_mode='two_pass'` rounds (immutable, leave alone). Sunset migration `380_sunset_two_pass_engine.sql`. No standalone spec doc — fully described in W11-7 spec |
| [W11-8-multi-vendor-vision-adapter.md](./W11-8-multi-vendor-vision-adapter.md) | W11.8 | ✅ shipped | Vendor abstraction over Anthropic + Google vision APIs (OpenAI dropped per Joseph 2026-04-29). Per-stage model config in `engine_settings`. Shipped 2026-04-30. Role updated post-Saladine: **audit / A/B harness + production failover layer** — NOT the primary architecture. Production primary vendor: Gemini 2.5 Pro per Saladine A/B iter-4 results; Anthropic Opus 4.7 retained as failover. Adapter abstraction stays as a long-term asset for vendor portability + ongoing audit. Mig 350 |
| [W12-object-attribute-registry.md](./W12-object-attribute-registry.md) | W12 | ⚙️ ready | Full Wave 12 schema (4 tables: object_registry + raw_attribute_observations + attribute_values + object_registry_candidates) + manual-trigger normalisation + discovery queue + AI suggestion engine. pgvector @ 1536. Mig 345 |
| [W12-trigger-thresholds.md](./W12-trigger-thresholds.md) | W12 | ⚙️ | AI suggestion engine thresholds for new room_types / slots. Storage tables for suggestion review |
| [W13a-historical-flexmedia-goldmine.md](./W13a-historical-flexmedia-goldmine.md) | W13a | ⚙️ ready | Synthetic-round backfill for historical FlexMedia delivery training set. **Manual-trigger only** (Joseph 2026-04-27): 1 project per invocation, per-call cost cap. New status='backfilled', finals-extract Modal worker |
| [W13b-pulse-description-goldmine.md](./W13b-pulse-description-goldmine.md) | W13b | ⚙️ ready | Sonnet/Opus extractor over 28k pulse descriptions. **Manual-trigger only** (Joseph 2026-04-27): explicit listing_ids OR Joseph-supplied limit, per-call cost cap, no cron |
| [W14-calibration-session.md](./W14-calibration-session.md) | W14 | ⚙️ ready | 50-project structured calibration (48 stratified + 2 wildcards). Blind editor declaration + side-by-side AI diff + per-disagreement reasoning capture. Reuses benchmark-runner. Mig 346 |

## Specs not yet written (lower priority)

(none — W7.7 followup specs absorbed into the v3 spec.)

## Workflow

1. **I write** each spec when its wave approaches
2. **Joseph reviews + signs off** on the "Open questions" section at the bottom
3. **I update** the spec with answers
4. **I dispatch** execution to a subagent (or do it myself if scope is small)
5. **Spec stays in repo** as the canonical record of the architectural decision — survives this conversation

## Pre-flight checklist for ANY wave

Before starting execution on a wave with a spec doc:

- [ ] Spec exists in this folder
- [ ] All open questions in the spec have answers (Joseph signed off)
- [ ] Migration safety considerations addressed per `../MIGRATION_SAFETY.md`
- [ ] Dependencies on prior waves verified (read `../WAVE_PLAN.md`)
- [ ] Pre-execution checklist at the bottom of the spec is satisfied

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

## Specs

| Doc | Wave | Status | Purpose |
|---|---|---|---|
| [W7-4-shortlisting-confirm-flow.md](./W7-4-shortlisting-confirm-flow.md) | W7.4 | ✅ shipped | Audit JSON mirror; lands at `Photos/_AUDIT/round_N_locked_<ts>.json` after every lock |
| [W7-5-pg-advisory-lock-fix.md](./W7-5-pg-advisory-lock-fix.md) | W7.5 | ✅ shipped | Row-based `dispatcher_locks` mutex (mig 336) — atomic acquire+release confirmed in prod |
| [W7-6-vision-prompt-blocks.md](./W7-6-vision-prompt-blocks.md) | W7.6 | ⚙️ ready | Composable prompt blocks API. Self-resolved by orchestrator; ready for subagent dispatch. Unblocks W11 plug-in point |
| [W7-7-package-shortlist-configs.md](./W7-7-package-shortlist-configs.md) | W7.7 | ✅ shipped | Dynamic package/product/tier architecture. Mig 339, helpers, engine integration, 3 admin UIs — commits d410845, 66df867, 83d8fa7, 2751ff4, e6c161e, 1b21675. Subsumes W7.9 / P1-13 |
| [W7-13-manual-shortlisting-mode.md](./W7-13-manual-shortlisting-mode.md) | W7.13 | ⚙️ ready | UX fork for project types where AI shortlisting doesn't apply. Manual swimlane + lock-triggers-move. Depends on W7.7 + W7.12 |
| [W7-8-product-driven-slot-eligibility.md](./W7-8-product-driven-slot-eligibility.md) | W7.8 | ✅ shipped | `engine_role` enum + `eligible_when_engine_roles` (mig 337) — 28 products + 12 slots backfilled; latent quarantine CHECK bug fixed as bonus |
| [W10-1-multi-camera-partitioning.md](./W10-1-multi-camera-partitioning.md) | W10.1 | ⚙️ ready | Multi-camera partitioning in bracketDetector. New `composition_groups.camera_source` + `is_secondary_camera`. iPhone/secondary singletons banner via W10.2 contract baked in. Mig 340 |
| [W10-3-override-metadata-columns.md](./W10-3-override-metadata-columns.md) | W10.3 | ⚙️ ready | All 4 named columns already exist (mig 285) — this is frontend instrumentation: per-card timer, drawer interaction tracking, signal attribution modal. One new audit column. Mig 341 |
| [W11-universal-vision-response-schema.md](./W11-universal-vision-response-schema.md) | W11 | 🛑 | THE keystone — universal schema for vision API across all sources (RAW/finals/external). Pass 1 prompt + per-signal scoring + 22 measurement prompts |
| [W12-trigger-thresholds.md](./W12-trigger-thresholds.md) | W12 | ⚙️ | AI suggestion engine thresholds for new room_types / slots. Storage tables for suggestion review |
| [W13a-historical-flexmedia-goldmine.md](./W13a-historical-flexmedia-goldmine.md) | W13a | ⚙️ ready | Synthetic-round backfill for historical FlexMedia delivery training set. New status='backfilled', finals-extract Modal worker, $256 estimated for 100-project pilot |
| [W13b-pulse-description-goldmine.md](./W13b-pulse-description-goldmine.md) | W13b | ⚙️ ready | Sonnet/Opus extractor over 28k pulse descriptions for object_registry bootstrap. Anthropic tool-use for strict JSON. ~$372 / 7-night batch |

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

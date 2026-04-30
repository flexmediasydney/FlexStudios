# W11.6 — Rejection Reasons Dashboard — Design Spec

**Status:** ⚙️ Future wave — depends on W10.3 (override metadata instrumentation, ✅ shipped) + W11.5 (human reclassification, future) + W11.7 (Shape D multi-stage architecture surfaces richer per-decision rationale, master_listing copy, voice tier metadata, canonical registry coverage). Terminology + dashboard widgets refreshed 2026-04-30 to align with the rewritten W11.7.
**Backlog ref:** P1-24 (new)
**Wave plan ref:** W11.6 — admin-side visibility into the captured override signal so a human can spot patterns and tune
**Dependencies:** W10.3 (`shortlisting_overrides.primary_signal_overridden` + `review_duration_seconds` + `alternative_offered_drawer_seen`), W7.7 (`engine_settings` + `package_engine_tier_mapping`), W11.7 (Stage 4 visual master synthesis emits `slot_decisions[].rationale`, `quality_outliers[]`, `master_listing` block, `voice_tier`, plus Stage 1's `appeal_signals` / `concern_signals` / `retouch_priority` / `gallery_position_hint` / `style_archetype` enrichment fields)
**Unblocks:** the human-in-the-loop tuning step that closes the "engine grows over time" loop. Without this, the override data sits inert.

---

## ⚡ Architectural alignment (2026-04-30)

W11.7's Shape D engine produces richer per-decision rationale by construction (every winner/alternative comes with a cross-image rationale paragraph from Stage 4's visual master synthesis across all 200 images, not just text-summary heuristics from a single-image scoring pass). It also emits master_listing copy + voice tier metadata + canonical registry references that the dashboard can analyse across projects. New / updated sections under W11.7:

- **Quality outliers section** (new): renders Stage 4's `quality_outliers[]` — properties where the photographer over- or under-delivered relative to tier expectation. Becomes pricing/sales intelligence ("flag for tier upgrade" / "flag for photographer feedback").
- **Per-decision rationale viewer** (richer): each card's "Why?" now shows Stage 4's actual cross-image judgement, not just a single-image text-summarised inference.
- **Stage 4 self-correction events** (new): every time Stage 4 visually corrects a Stage 1 classification (different room_type, different slot eligibility, different score) without operator action, the event is logged and surfaced here so admins see the cross-stage learning rate.
- **Voice tier distribution** (new): per-project counts of master_listing `voice_tier` values (`Premium` / `Standard` / `Approachable`) with a stacked bar chart over time. Helps detect whether tier inference is drifting against package mappings.
- **Master listing copy metrics** (new): histograms of `master_listing.word_count` and `master_listing.reading_grade_level` per voice tier and per package. Surfaces over-long copy or grade-level mismatches with the target audience.
- **Canonical registry coverage** (new): % of `key_elements` per project that resolved to canonical IDs in the registry vs free-form. Trends down as W12 grows; a sudden spike in unresolved elements signals new architectural patterns or registry gaps.
- **Cost-per-stage attribution** (new): per-round Gemini spend split into Stage 1 (3-4 batch calls) vs Stage 4 (1 master synthesis). Verifies the ~$3.84 / 200-angle target and surfaces drift if a vendor change inflates either bucket.
- **Engine-mode timeline** (updated): annotates the override-rate timeline with `shortlisting_rounds.engine_mode` transitions (two_pass → shape_d) so the impact of the architecture flip is measurable.

W11.6 ships AFTER W11.7's coexistence period (Phase B) so the dashboard reads from a stable Shape D output shape.

---

## Problem (Joseph 2026-04-29)

W10.3 captures rich override metadata per rejection: which signal the operator cited, how long they spent reviewing, whether they opened the alternatives drawer, etc. But **nobody is reading this data yet.** The architectural truth from the recent Saladine review:

> *Today's engine is a perfectly-instrumented apprentice that records every lesson but doesn't yet read its own notes.*

The closed loop fires through three stages: (1) capture (W10.3 ✓), (2) **surface** (this spec — W11.6), (3) act (W8 admin tuning ✓ + W11.5 reclassification + W14 calibration). Stage 2 is the missing rung.

Master_admins / admins need a single page that surfaces:
- "Which signals do operators most often cite when overriding?"
- "Is the engine consistently failing on a specific room_type / package / tier?"
- "Did the W8 weight-tuning session 4 weeks ago actually improve override patterns, or just shift them?"
- "Which projects have the highest override rate — and are they tagged `Tier S` but consistently scored Tier P-quality?"
- "How often does Stage 4 visually correct Stage 1, and how often do operators confirm those corrections?"
- "Are master_listings in the right voice tier, and is the copy length / reading grade matching package expectation?"
- "What % of key_elements are still resolving as free-form vs canonical — is the W12 registry catching up?"
- "Where is the Gemini spend going — Stage 1 batch enrichment or Stage 4 master synthesis?"

Without this surface, the override signal exists but doesn't drive action.

---

## Architecture

### Section 1 — Page: `Settings → Engine → Override Patterns`

Master_admin / admin only. Single-page dashboard with 5 core sections (A-E) plus 4 Shape-D-specific widgets (F-I) added under W11.7:

#### Header KPIs (4 cards, last 30 days default)

| Card | Calc | Drives |
|---|---|---|
| **Total overrides** | COUNT(*) | Volume signal |
| **Override rate** | COUNT(overrides) / COUNT(ai_proposals) | Trend over time |
| **Avg review duration** | AVG(review_duration_seconds) WHERE >0 | Operator friction signal |
| **Confirmed-with-review %** | COUNT(>30s) / COUNT(*) | Quality signal — high % = thoughtful overrides |

#### Section A — Signal frequency chart

Horizontal bar chart of `primary_signal_overridden` values (the 14 curated signals + 'other'), ordered by frequency. Each bar shows count + a sparkline of trend over the last 90 days.

Click a bar → drill down into rounds where that signal was cited. Useful for: *"operators cite 'cluttered foreground' 47% of the time on rejected hero_wide rear-exterior shots — is the prompt's clutter detection too lenient?"*

Filterable / groupable by Shape D Stage 1 enrichment fields when the round used `engine_mode='shape_d'`: `appeal_signals`, `concern_signals`, `retouch_priority`, `gallery_position_hint`, `style_archetype`. e.g. *"Of the rejections citing 'cluttered foreground', how many had Stage 1's `concern_signals` already flag clutter? If most did, the issue is operator threshold, not engine miss."*

#### Section B — Per-room-type override heatmap

Matrix of room_types × engine_tiers, cell value = override rate.

```
                Tier S    Tier P    Tier A
exterior_front  12%       8%        15%
exterior_rear   34% ⚠     21%       18%
master_bedroom  6%        5%        4%
kitchen_main    9%        7%        12%
…
```

Hot cells (>25% override) get an amber border; >40% get red. Click cell → list of rounds, click round → swimlane view filtered to that room_type's overrides.

This is what surfaces "exterior_rear is consistently weak on Tier S" — operator action: open W8 admin → boost lighting weight on Tier S → re-simulate against last 30 rounds → activate.

#### Section C — Tier-config impact tracker

Shows the override-rate timeline annotated with tier_config activation events. When master_admin activates `wave-8-v2` weights on Tier S, a vertical line marks the date. The chart shows whether override rates dropped, held, or rose post-activation — closing the loop on whether the tuning worked.

```
Override rate %
60 ─┐
40 ─┤        ▼ wave-8-v1 activated         ▼ wave-8-v2 activated
20 ─┤        ●●●●●●●●●●                    ●●●●●●●
 0 ─┤    ●●●●          ●●●●●●●●●●●●●●●●●●●         ●●●●
   └────────────────────────────────────────────────────
    Apr     May      Jun      Jul      Aug       Sep
```

#### Section D — Outlier projects

Table listing projects with override-rate >2σ above the package's mean. Sorted by recency.

| Property | Package | Tier | Override rate | Common signal | Reviewed? |
|---|---|---|---|---|---|
| 13 Saladine | Gold | S | 41% | cluttered_foreground (12), lighting (8) | No |
| 8/2 Everton | Gold | P | 7% | n/a | n/a |
| … |

Each row links to the project's swimlane + a "Schedule W14 inclusion" button (master_admin) — flags the project for the next 50-project calibration session.

#### Section E — Reclassification log (W11.5 dependency)

Once W11.5 ships, this section renders `composition_classification_overrides` with `human_room_type` corrections grouped by `(ai_room_type → human_room_type)` and split by `override_source` (stage1 vs stage4). Surfaces patterns like "Stage 1 says `exterior_front` but operators corrected to `exterior_rear` 8 times in 30 days; common evidence keyword: hills_hoist."

Operator action: master_admin reviews the pattern, decides whether the relevant prompt block needs an update. Direct path from observation to prompt iteration.

#### Section F — Stage 4 self-correction events (Shape D only)

Renders Stage 4 visual master synthesis events that visually corrected a Stage 1 classification (different room_type / different slot / score adjusted by ≥1.0) without operator intervention. Grouped by `(stage1_value → stage4_value)`. Each row shows:

| Stage 1 → Stage 4 | Count (30d) | Operator confirm rate | Common evidence (Stage 4 rationale keywords) |
|---|---|---|---|
| `exterior_front` → `exterior_rear` | 14 | 86% | hills_hoist, hot_water_system, garden_tap |
| `bedroom_secondary` → `study` | 9 | 78% | desk, monitor, bookshelf |

High operator-confirm rate = the model's self-correction is trustworthy and should graduate into the few-shot library. Low rate = Stage 4 is over-correcting; tune its synthesis prompt.

#### Section G — Voice tier distribution + master_listing copy metrics (Shape D only)

Two side-by-side widgets:

1. **Voice tier distribution** — stacked bar over time of `master_listing.voice_tier` (`Premium` / `Standard` / `Approachable`) per project's package. A Tier-S Gold project producing `Approachable` copy is a misalignment worth investigating.
2. **Copy metrics histograms** — `master_listing.word_count` and `master_listing.reading_grade_level` distributions, faceted by voice tier. Surfaces over-long Premium copy (e.g. >180 words) or grade-mismatched Approachable copy (e.g. grade level >10).

Drill-down: click a tier band → list of projects → click a project → master_listing preview + per-image listing copy from Stage 1.

#### Section H — Canonical registry coverage (Shape D + W12)

Per-round metric: `% of key_elements that resolved to canonical IDs` (vs free-form / unresolved). Trend line over 90 days; expect upward trend as W12's registry grows. Sudden drop indicates either (a) a new architectural pattern Stage 1 / Stage 4 is naming for the first time, or (b) a registry regression worth W12 admin's attention. Click the bar → list of unresolved free-form labels grouped by frequency, with one-click "promote to canonical" deep-link into the W12 discovery queue.

#### Section I — Cost-per-stage attribution (Shape D only)

Per-round Gemini spend split into:

- **Stage 1 batch enrichment** (3-4 batch calls × 50 images each)
- **Stage 4 visual master synthesis** (1 cross-image call across all 200)
- **Anthropic A/B / failover** (when W11.8 audit harness fired)

Compared against the v1 target (~$3.84 / 200-angle shoot). Per-tier and per-package roll-ups; outliers >2σ above mean tagged for review. Critical for catching prompt-bloat regressions and validating that voice-tier modulation isn't inflating Stage 4 token usage.

---

### Section 2 — Backing edge fn `engine-override-analytics`

Single endpoint, master_admin only. Accepts:

```typescript
interface AnalyticsRequest {
  date_range?: { start: string; end: string };  // ISO8601; default last 30 days
  package_filter?: string;                       // 'Gold Package' etc; default all
  tier_filter?: string;                          // 'S' | 'P' | 'A'; default all
  room_type_filter?: string;                     // optional
  drill_down?: 'rounds' | 'overrides' | 'reclassifications';  // section-specific
}

// Returns aggregated metrics per the page's sections
interface AnalyticsResponse {
  kpis: { total: number; rate: number; avg_duration_s: number; confirmed_pct: number };
  signal_frequency: Array<{ signal: string; count: number; trend: number[]; appeal_signals_filter?: string[]; concern_signals_filter?: string[]; style_archetype_filter?: string }>;
  room_type_heatmap: Array<{ room_type: string; tier: string; rate: number; sample_size: number }>;
  tier_config_events: Array<{ activated_at: string; tier_code: string; version: number; notes: string }>;
  outlier_projects: Array<{ project_id: string; address: string; package: string; tier: string; rate: number; common_signals: string[] }>;
  reclassification_patterns: Array<{ ai_value: string; human_value: string; count: number; common_evidence: string[]; override_source: 'stage1' | 'stage4' }>;
  // Shape D widgets (W11.7)
  stage4_self_corrections: Array<{ stage1_value: string; stage4_value: string; count: number; operator_confirm_rate: number; rationale_keywords: string[] }>;
  voice_tier_distribution: Array<{ tier: string; package: string; voice_tier: 'Premium' | 'Standard' | 'Approachable'; count: number; week: string }>;
  master_listing_metrics: Array<{ voice_tier: string; word_count_p50: number; word_count_p95: number; reading_grade_p50: number }>;
  canonical_coverage: Array<{ week: string; resolved_pct: number; unresolved_top_labels: Array<{ label: string; count: number }> }>;
  cost_per_stage: Array<{ round_id: string; stage1_usd: number; stage4_usd: number; ab_audit_usd: number; total_usd: number }>;
}
```

The fn reads `shortlisting_overrides`, `composition_classification_overrides` (W11.5), `shortlisting_rounds`, `shortlisting_tier_configs`, `package_engine_tier_mapping`, plus Shape D outputs (`master_listings`, Stage 1 enrichment columns on `composition_classifications`, Stage 4 synthesis log, `vendor_shadow_runs` for cost). All read-only; no DB writes.

Heavy aggregation — push to materialised views if the dashboard is slow. v1 ships with on-demand SQL; v2 adds a `mv_override_analytics` materialized view refreshed nightly via pg_cron (or manual-trigger per Joseph's policy on cron).

---

### Section 3 — Drill-down navigation

From any chart/cell/row, the dashboard navigates to either:

1. **Round detail** — existing swimlane page with `?focus=overrides` filter that highlights only the overridden cards
2. **Override detail modal** — shows the full override row + Stage 1 per-image enrichment + Stage 4 cross-image rationale + the operator's review_duration + alternative_offered status. Useful for forensic "why did the operator override this exactly?"
3. **W8 admin** (existing) — "tune Tier S weights to address this pattern" deep-link
4. **W12 discovery queue** (Shape D + W12) — from Section H, deep-link directly to "promote free-form label X to canonical" workflow

---

## Migration

Recommend mig 348 (after W11.5's 347): no schema changes; the dashboard is read-only against existing tables. **No migration needed.** v1 ships migration-free.

If v2 adds the materialised view: that's a pure additive migration with no rollback risk (drop the MV).

---

## Effort estimate

- 1 day backend (`engine-override-analytics` edge fn — heavy SQL, RLS)
- 2 days frontend (the dashboard page; shadcn-ui + recharts; 5 core sections + drill-downs)
- 1 day Shape D widgets F-I (Stage 4 self-corrections, voice tier distribution, master_listing metrics, canonical coverage, cost-per-stage attribution)
- 0.5 day tests
- Total: **~4.5 days**

---

## Open questions for sign-off

**Q1.** Default time window?
**Recommendation:** **Last 30 days.** Captures recent tuning impact + enough volume for stable percentages. User can change to last 7 / 90 / 365.

**Q2.** Should the dashboard auto-suggest weight changes?
**Recommendation:** **No at v1.** Surfacing patterns ≠ recommending fixes. The risk of "you should up the lighting weight by 0.05 on Tier S" being technically wrong but presented as authoritative is real. v1 surfaces; humans interpret. v2 (post-W14 calibration) earns the right to suggest because by then there's ground-truth data to reason from.

**Q3.** Visibility for non-admin roles?
**Recommendation:** **Master_admin / admin only at v1.** Manager / employee don't need pattern-level analytics; they operate per-project. If we later want a per-project "your override rate this month" widget for the operator dashboard, that's a different surface.

**Q4.** Export to CSV / Anthropic batch context?
**Recommendation:** **CSV export at v1** (admin clicks "Export"). Anthropic batch-context export comes when W11 + W14 are live and we're authoring few-shot libraries.

---

## Pre-execution checklist

- [x] W10.3 has shipped (✅ today) — captures `primary_signal_overridden` + `review_duration_seconds` + `alternative_offered_drawer_seen`
- [x] W7.7 has shipped (✅ today) — `package_engine_tier_mapping` + `engine_settings`
- [ ] W11.5 specs ready (✓) but implementation not yet shipped — Section E gracefully degrades (renders "W11.5 not yet shipped" placeholder when `composition_classification_overrides` table doesn't exist)
- [ ] Joseph confirms 30-day default time window
- [ ] Joseph confirms no auto-suggestions at v1
- [ ] Master_admin / admin RLS policy confirmed

---

## Why this matters (closing the architectural loop)

W7-W10 + W8 built the **capture** infrastructure. W14 + W11 + W12 build the **automated consumption** infrastructure. **W11.6 is the manual consumption surface** — the bridge that lets the engine improve in calendar weeks rather than calendar quarters.

Without W11.6, master_admins must hand-write SQL queries to find override patterns. With W11.6, every Friday review surfaces "here are the 3 patterns the engine is failing on this week" — and the W8 admin UI is one click away.

This is the rung in the ladder where "engine grows with each response" stops being a vision and starts being a workflow.

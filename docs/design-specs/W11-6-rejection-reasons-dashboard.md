# W11.6 — Rejection Reasons Dashboard — Design Spec

**Status:** ⚙️ Future wave — depends on W10.3 (override metadata instrumentation, ✅ shipped) + W11.5 (human reclassification, future).
**Backlog ref:** P1-24 (new)
**Wave plan ref:** W11.6 — admin-side visibility into the captured override signal so a human can spot patterns and tune
**Dependencies:** W10.3 (`shortlisting_overrides.primary_signal_overridden` + `review_duration_seconds` + `alternative_offered_drawer_seen`), W7.7 (`engine_settings` + `package_engine_tier_mapping`)
**Unblocks:** the human-in-the-loop tuning step that closes the "engine grows over time" loop. Without this, the override data sits inert.

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

Without this surface, the override signal exists but doesn't drive action.

---

## Architecture

### Section 1 — Page: `Settings → Engine → Override Patterns`

Master_admin / admin only. Single-page dashboard with 5 sections:

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

Once W11.5 ships, this section renders `composition_classification_overrides` with `human_room_type` corrections grouped by `(ai_room_type → human_room_type)`. Surfaces patterns like "Pass 1 says `exterior_front` but operators corrected to `exterior_rear` 8 times in 30 days; common evidence keyword: hills_hoist."

Operator action: master_admin reviews the pattern, decides whether the `streamBAnchors.ts` block needs an update. Direct path from observation to prompt iteration.

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
  signal_frequency: Array<{ signal: string; count: number; trend: number[] }>;
  room_type_heatmap: Array<{ room_type: string; tier: string; rate: number; sample_size: number }>;
  tier_config_events: Array<{ activated_at: string; tier_code: string; version: number; notes: string }>;
  outlier_projects: Array<{ project_id: string; address: string; package: string; tier: string; rate: number; common_signals: string[] }>;
  reclassification_patterns: Array<{ ai_value: string; human_value: string; count: number; common_evidence: string[] }>;
}
```

The fn reads `shortlisting_overrides`, `composition_classification_overrides` (W11.5), `shortlisting_rounds`, `shortlisting_tier_configs`, `package_engine_tier_mapping`. All read-only; no DB writes.

Heavy aggregation — push to materialised views if the dashboard is slow. v1 ships with on-demand SQL; v2 adds a `mv_override_analytics` materialized view refreshed nightly via pg_cron (or manual-trigger per Joseph's policy on cron).

---

### Section 3 — Drill-down navigation

From any chart/cell/row, the dashboard navigates to either:

1. **Round detail** — existing swimlane page with `?focus=overrides` filter that highlights only the overridden cards
2. **Override detail modal** — shows the full override row + Pass 1 analysis + Pass 2 rationale + the operator's review_duration + alternative_offered status. Useful for forensic "why did the operator override this exactly?"
3. **W8 admin** (existing) — "tune Tier S weights to address this pattern" deep-link

---

## Migration

Recommend mig 348 (after W11.5's 347): no schema changes; the dashboard is read-only against existing tables. **No migration needed.** v1 ships migration-free.

If v2 adds the materialised view: that's a pure additive migration with no rollback risk (drop the MV).

---

## Effort estimate

- 1 day backend (`engine-override-analytics` edge fn — heavy SQL, RLS)
- 2 days frontend (the dashboard page; shadcn-ui + recharts; 5 sections; drill-downs)
- 0.5 day tests
- Total: **~3.5 days**

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

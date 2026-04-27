# Wave 7+ Backlog

Captured during Wave 0 burst 0.1 (Round 2 end-to-end + lock recovery
exercise on 2026-04-27). Each item is independently shippable as a burst.
Priorities are P0/P1/P2/P3. Within a priority, ship in order listed.

The first item (P0-1) is the single highest-value architectural fix in the
entire backlog — the 30-minute lock recovery on Round 2 quantified the cost
of NOT having it.

---

## P0 — Operational unblockers

### P0-1 — `shortlist-lock` rewrite using Dropbox `move_batch_v2`

**Problem.** Today's lock function does per-file `move_v2` calls in a
6-worker concurrent loop within a 150s edge function gateway window. When a
round has more than ~50 files of moves, Dropbox's per-namespace write rate
limit (~5-15 req/s under sustained load) means we hit the gateway timeout
before completing. The DB transitions to `status='locked'` regardless,
leaving partial Dropbox state and a stuck round. Joseph saw this exactly on
Round 2 — required ~30 minutes of `revert status / re-invoke / observe`
recovery cycles.

**Fix.**

1. Migration: add `shortlisting_lock_progress` table tracking stage,
   batch_job_id, attempted/succeeded/failed counts, started_at, last_polled_at
2. Rewrite `shortlist-lock` to:
   - Build the move list as today (resolve approved/rejected sets from events
     + overrides)
   - Submit ALL moves to Dropbox `/files/move_batch_v2` (single async call,
     accepts up to 10,000 entries)
   - Persist the returned `async_job_id` to `shortlisting_lock_progress`
   - Return immediately with `{ ok: true, status: 'in_progress', async_job_id }`
   - `EdgeRuntime.waitUntil(...)` polls `/files/move_batch/check_v2` every
     2-3s, updates the progress row as each batch entry resolves
3. New endpoint `shortlist-lock-status?round_id=...` for the frontend to
   poll. Returns the current progress row.
4. Frontend swimlane:
   - Lock button click → POST to `shortlist-lock` → get `async_job_id`
   - Show non-blocking progress dialog with real %-complete bar
   - Poll `shortlist-lock-status` every 2-3s
   - On completion → toast + close dialog + refresh swimlane
   - On failure → show "Resume" button which re-invokes `shortlist-lock`
     (the DB persists the async_job_id, we don't restart from scratch)

**Wall-clock impact.** 170-file lock today: ~30 minutes via 10 retry cycles.
Same lock with `move_batch_v2`: ~30-60 seconds total (one batch submit +
polling). Eliminates issues #11/#12/#13 from Joseph's review.

**Estimated effort.** ~1 week. ~150 lines TS in the lock fn, ~80 lines in
the status endpoint, ~120 lines React in the progress dialog.

### P0-2 — `SHORTLISTING_DISPATCHER_JWT` deployment runbook + startup self-check

**Problem.** The secret was missing in production. Dispatcher claimed jobs
fine but failed to chain-call extract/pass0/etc because it had no JWT.
Discovery cost: ~15 minutes of debugging on Round 2.

**Fix.**

1. Document the secret + how to set it via `supabase secrets set` in a new
   `docs/DEPLOYMENT_RUNBOOK.md`
2. Strengthen the existing startup warning in `shortlisting-job-dispatcher`
   to fail-loud at health-check time (not just `console.error`) — return
   503 from `_health_check` if the secret is missing
3. Add a Settings → Operations health-check page that pings the dispatcher's
   health endpoint and surfaces the secret-missing case visually

**Estimated effort.** Half-day.

### P0-3 — Modal Dropbox token refresh from edge function

**Problem.** Modal worker uses a static `DROPBOX_ACCESS_TOKEN` Modal secret.
Tokens expire every ~4 hours. When expired, every CR3 download fails with
`AuthError('expired_access_token')`. Round 2 hit this exactly — required
manually minting a fresh token via a one-shot edge function and redeploying
Modal.

**Fix.**

1. `shortlisting-extract` mints a fresh Dropbox access token before each
   Modal call (via the existing auto-refreshing `dropbox.ts` helper —
   refresh token stays in edge env)
2. Pass the access token in the request body to Modal's `/extract` endpoint
3. Modal `main.py` accepts `access_token` field in request body, uses it
   to instantiate `dropbox.Dropbox(...)` per-request instead of relying on
   the env secret
4. Delete the static `dropbox_access_token` Modal secret (Modal worker no
   longer reads it)

**Estimated effort.** Half-day. ~30 lines of TS in shortlisting-extract,
~20 lines of Python in modal/main.py + redeploy.

---

## P1 — Engine fidelity

### P1-1 — Pass 2 prompt: `proposed_slots` field for AI-suggested taxonomy gaps

**Origin.** Issue #10 from Joseph's Round 2 review. Pass 2 hallucinated
`balcony_terrace_hero` slot because the seeded taxonomy lacked a slot for
`balcony_terrace` room_type. Silent fallback to phase=0 displayed a fake
slot in the swimlane that didn't exist in admin Settings.

**Fix.** Two coordinated changes:

1. `pass2Prompt.ts` — add new optional output field `proposed_slots`. Tells
   the model: "if a composition is genuinely strong but no listed slot fits,
   propose a new slot here with reasoning". This MAKES the suggestion
   mechanism explicit instead of letting it leak through `slot_assignments`
   as silent hallucination.
2. `shortlisting-pass2/index.ts` post-processing — when `slot_assignments`
   contains an unknown slot_id (model didn't use the new field), demote
   the composition to a Phase 3 free recommendation AND emit a
   `pass2_slot_suggestion` event capturing the model's invented slot_id +
   the composition's analysis as reasoning. Same for entries in
   `proposed_slots`.

**Why not just block hallucinations?** Joseph correctly observed that
strict whitelist enforcement kills the self-learning signal. The model
identifying gaps in our taxonomy is *valuable* — we just need to capture
that signal cleanly. Wave 12 will read these `pass2_slot_suggestion` events
to surface "the model proposed `balcony_terrace_hero` 8 times in 3 months,
add it as a real slot?" admin reviews.

**Estimated effort.** 1-2 days. Prompt iteration + post-processing logic +
event payload definition.

### P1-2 — Pass 2 prompt: consecutive-group coherence check (room-type tiebreaker)

**Origin.** Issue #4 from Joseph's Round 2 review. IMG_5751 (group 26) and
IMG_5756 (group 27) were captured 16.7 seconds apart with overlapping
`key_elements`, same composition_type, same focal_length — clearly the same
physical room — but Pass 1 classified one as `master_bedroom` and the
adjacent shot as `bedroom_secondary`. Pass 2 trusted both labels and filled
two separate bedroom slots from what is one room.

**Fix.** Add to `pass2Prompt.ts`:

```
SPATIAL HINT FROM CAPTURE TIMING:
Photographers tend to shoot one physical area before moving to another, so
compositions captured close in time (within ~15-20 minutes) often share a
physical location. Treat capture sequence as a SOFT TIEBREAKER, not a hard
rule:
  - When two compositions share the same room_type but >15 min apart,
    weakly prefer treating them as DIFFERENT rooms (e.g. ground floor vs
    upstairs lounge)
  - When two compositions are >60 min apart, raise that confidence
  - Never use timing alone to override visual evidence — vendors often
    require re-shoots of the same room (new pillows, lighting changes).
    If visual content clearly matches, it's the SAME room regardless of
    timing.

CONSECUTIVE-GROUP COHERENCE CHECK:
When two compositions:
  - Have consecutive group_index values
  - Were captured within 60 seconds of each other
  - Have ≥70% key_element overlap
  - Have similar composition_type + focal_length
…treat them as the SAME physical room regardless of their Pass 1 labels.
If their Pass 1 room_types diverge, pick the higher-confidence label OR
the label that fits the property's deliverables. Never assign these two
to two SEPARATE bedroom slots.
```

Per-composition lines in the universe block need to expose `group_index`
and `t+Nmin` (relative capture time) for the model to actually use these
hints.

**Estimated effort.** 1 day. Prompt iteration + universe-block format
update + test against a captured round to verify behaviour change.

### P1-3 — `shortlisting_room_types` admin table (Layer 1 hand-curated)

**Problem.** Today's room-type taxonomy is a 40-value string in
`pass1Prompt.ts`. Adding a new room type (`wine_cellar_subterranean`,
`pet_grooming_station`, etc) requires editing TS + redeploying. No admin
UI.

**Fix.**

1. Migration: `shortlisting_room_types(id, key, display_name, description,
   detection_hints, category, is_active, version, created_by, notes)`
2. Seed from current hardcoded list
3. `pass1Prompt.ts` builder reads from DB on each call (cached 60s)
4. `slot_definitions.eligible_room_types` switches from text[] to UUID[]
   FK referencing this table (additive-then-subtractive migration per
   `MIGRATION_SAFETY.md`)
5. `SettingsShortlistingRoomTypes.jsx` admin page mirroring the slots /
   standards / signals / prompts pattern (versioned, save-new-version,
   history expander)

**Estimated effort.** 3-5 days.

### P1-4 — `lens_class` derivation + slot eligibility

**Origin.** Joseph's question about wide vs detail vs compressed shots.

**Fix.**

1. `composition_classifications.lens_class TEXT` column
2. Pass 1 post-processing derives lens_class from `exif.focalLength`:
   - `< 14mm` → `ultra_wide`
   - `14-24mm` → `wide`
   - `24-50mm` → `standard`
   - `50-85mm` → `compressed`
   - `> 85mm` → `telephoto`
3. `shortlisting_slot_definitions.lens_class_constraint TEXT` —
   eligibility filter
4. Pass 2 prompt enriched with lens_class per composition
5. Admin slot editor exposes the constraint field

**Estimated effort.** 2-3 days.

### P1-5 — `eligible_composition_types` + `same_room_as_slot` columns

**Origin.** Joseph wanted "slot 1 = compressed kitchen, slot 2 = wide kitchen
of same room". Today's slot model can't enforce same-room linkage between
distinct slots.

**Fix.**

1. `shortlisting_slot_definitions.eligible_composition_types TEXT[]` —
   constraint filter (e.g. `['hero_wide', 'corner_two_point']`)
2. `shortlisting_slot_definitions.same_room_as_slot UUID` — FK to another
   slot. When set, the assigned composition for THIS slot must come from
   the same `room_type` as the assigned composition for the linked slot.
3. Pass 2 prompt + validator enforce both
4. Admin slot editor exposes both fields

**Estimated effort.** 2-3 days.

### P1-6 — `package_shortlist_configs` sidecar + `tiers` first-class table

**Problem.** Today the engine has hardcoded `PACKAGE_CEILINGS` (Gold=24,
D2D=31, Premium=38) in TS and hardcoded `["Gold", "Day to Dusk", "Premium"]`
in the frontend. Disconnected from the real `packages` table. Marketing
adding a new package = silent breakage.

**Fix.** See earlier conversation transcript for full design. In summary:

1. `package_shortlist_configs` (1:1 sidecar to `packages`):
   shortlist_target_min/max/ceiling, default_tier_id, has_drone/dusk/
   video/floorplan_deliverables
2. `tiers` table: id, name, description, is_active
3. `projects.tier_override_id UUID` (nullable)
4. `shortlisting_slot_definitions.package_ids UUID[]` replacing the
   text-array `package_types`
5. Engine switches to FK joins
6. Frontend dropdowns become TanStack queries against the real packages

**Estimated effort.** 1-2 weeks. Touches a foundational table — must follow
`MIGRATION_SAFETY.md` additive-then-subtractive pattern.

### P1-7 — Tier configs with versioned dimension weights + re-simulation safeguard

Depends on P1-6 (`tiers` table must exist).

`shortlisting_tier_configs` versioned: technical/lighting/compositional/
aesthetic weights (must sum to 1.0), coverage_strictness, min_coverage_percent,
bedroom_selection_criteria. Pass 1 reads them to compute combined_score.
Pass 2 prompt receives tier-specific behaviour rules.

`SettingsShortlistingTiers.jsx` admin page mirroring the established pattern,
with **re-simulation safeguard**: a "Preview impact" button that replays the
last 30 locked rounds under the proposed weights and shows a diff table
("which rounds would have produced a different `kitchen_hero` winner").
Admin must confirm before activation.

**Estimated effort.** 1 week.

---

## P2 — Accuracy + scale

### P2-1 — Granular Pass 1 signal scoring (per-signal output, not aggregates)

Spec section 9 enumerates ~22 individual signals (`vertical_line_convergence`,
`sight_line_depth_layers`, `living_zone_count`, etc) but Pass 1 today emits
4 dimension scores + analysis. The signal_weights table exists as config but
isn't actually multiplied against per-image signal scores anywhere — there
ARE no per-image signal scores.

**Fix.** New `composition_signal_scores` table (one row per composition ×
signal). Pass 1 prompt rewritten to emit per-signal scores. Post-processing
multiplies signal × weight to compute dimension aggregates. Pass 2 receives
per-signal context. `SettingsShortlistingSignals` weight tuning becomes
meaningful.

**Estimated effort.** 3-4 weeks. Largest single accuracy lift in the
roadmap.

### P2-2 — Object & Attribute Registry + Pass 1 feedback loop

Wave 12 work — full semantic infrastructure. `object_registry`,
`attribute_values` (with pgvector embedding column), `raw_attribute_observations`.
Pass 1 `key_elements` writes raw observations with
`source='internal_raw_vision'`. Nightly normalisation cosine-matches against
canonicals. Discovery queue UI for new candidate review.

**Estimated effort.** 4-6 weeks.

### P2-3 — Layer 2 AI room-type + slot suggestion engine

Depends on P2-2. Weekly background job reads `pass2_slot_suggestion` events
+ `key_elements` clusters + override patterns. Surfaces ranked
"propose new slot/room_type" candidates to admins for review.

**Estimated effort.** 2-3 weeks.

### P2-4 — Goldmine bootstrap parallel runs

Three sub-tracks, parallelisable once P2-2 lands:

- **13a** Historical FlexMedia backfill via synthetic-round + benchmark
  runner. Two-input UX (raw folder + finals folder). ~$50 in compute.
- **13b** Pulse description goldmine. Sonnet (default) / Opus (>$10M
  properties) extractor over 28k descriptions. ~$360 total.
- **13c** Floorplan OCR goldmine. Sonnet over 7,881 floorplan images. ~$6.

**Estimated effort.** 3-5 weeks total, parallelisable.

### P2-5 — 50-project structured calibration session

Goldmine 5. Calibration UI + decisions table. Editor manually shortlists 50
stratified projects; AI shortlists same 50 blind; side-by-side diff capture
per disagreement. Permanent benchmark set.

**Estimated effort.** 1-2 weeks engineering + 25 hours editor time.

### P2-6 — Multi-camera shoot handling

Spec section 25. Partition `composition_groups` by camera body. Skip
bracket grouping for iPhone secondary. Surface "secondary camera detected"
banner in swimlane.

**Estimated effort.** 3-5 days.

---

## P3 — UX (from Joseph's Round 2 review)

Numbered per his original list:

1. **#1** Sub-tab refresh loads first round, not latest
2. **#2** Alternatives tray blows out fullscreen — needs collapsed-card design
3. **#3** No sort/filter on swimlane — need slot-importance / filename / score sort options
4. **#5** Preview size controls (small/medium/large) on swimlane
5. **#6** Live slot counter banner directly on swimlane (so operator doesn't open Coverage tab)
6. **#7** Live elapsed timer on round in-flight
7. **#8** Lightbox with subgroup-aware filtering (when slot grouping is active, lightbox restricted to that slot)
8. **#9** Group swimlane lanes by slot
9. **#11** Lock popup math clarification — show "X approved / Y rejected / Z undecided will stay in source"
10. **#12** Lock UX — bar + non-blocking dialog + resume button (pairs with P0-1)

**Estimated effort.** Each is independently shippable, ~half-day to 2 days
each. Total ~1-2 weeks of frontend work.

---

## P3 — Engine quality investigations COMPLETED in Wave 0 burst 0.1

These were diagnosed during the Round 2 lock recovery — no further work
needed beyond the P1-1 / P1-2 prompt iterations:

- **#4** IMG_5751 vs IMG_5756 misclassification → P1-2 (consecutive-group
  coherence)
- **#10** `balcony_terrace_hero` slot anomaly → P1-1 (`proposed_slots`
  mechanism)

---

## Notes for the orchestrator

When starting Wave 7:

1. Confirm Wave 0 is closed (unit tests green in CI, this doc + migration
   safety doc + GitHub Actions workflow in place)
2. Pick **P0-1 as the first burst**. The 30-minute lock recovery on Round
   2 is unacceptable as a recurring production cost.
3. P0-2 + P0-3 are quick wins to ship same week as P0-1.
4. After P0 ships, do P1-1 + P1-2 as a paired burst — both are prompt
   iterations + light validator changes, no schema work, immediate engine
   accuracy lift.
5. P1-3 / P1-4 / P1-5 / P1-6 / P1-7 are the larger schema work. Sequence:
   P1-6 (packages refactor) MUST land before P1-7 (tier configs).
   P1-3 (room types) can land independently.
6. P2-1 (granular signals) is the biggest accuracy lift. Worth its own wave.
7. P2-2 + P2-3 + P2-4 are the long-tail self-learning architecture. Start
   when ready to invest the multi-week effort.
8. P3 UX items can be picked off opportunistically between bigger waves.

Each P0/P1/P2 item should produce a burst commit on `main` with explicit
deploy + smoke verification, same pattern as Wave 6 bursts 1-23.

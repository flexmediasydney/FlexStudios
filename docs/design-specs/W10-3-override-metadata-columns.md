# W10.3 — Override metadata columns + swimlane state tracking — Design Spec

**Status:** ⚙️ Ready to dispatch (awaiting Joseph sign-off on Q1-Q3 below).
**Backlog ref:** P1-16
**Wave plan ref:** W10.3 — richer override telemetry to feed Wave 8 tier configs and Wave 13a training set
**Dependencies:** None hard. Mig 285 already created the four columns; this wave is overwhelmingly **frontend instrumentation** (per-row timing, drawer-state capture, signal-dropdown UI) with a small migration to backfill defaults and add an evidence audit column.
**Unblocks:** W8.4 (round metadata reads `tier_used` + `tier_config_version` — uncorrelated to W10.3 directly, but the override row's signal context becomes the signal that W8 weights tune against), W13a (training set extracted from `shortlisting_overrides` rows uses the new context fields as feature columns).

---

## Problem

`shortlisting_overrides` (mig 285) captures **what** changed: `human_action ∈ {approved_as_proposed, removed, swapped, added_from_rejects}`, plus `ai_proposed_group_id`, `human_selected_group_id`, `slot_group_id`. The columns `review_duration_seconds`, `alternative_offered`, `alternative_selected`, and `primary_signal_overridden` exist on the schema but are **under-populated** by today's swimlane:

1. **`review_duration_seconds` is page-level, not row-level.** Today: `reviewStartRef = useRef(Date.now())` set on mount, computed at every drag. The first drag captures real time-to-first-decision; the second drag captures cumulative time, not time-on-this-row. The signal "human spent 47s on THIS card before deciding" is what the learning loop wants — and the >30s gate that flips `confirmed_with_review` becomes near-meaningless after the first drop.

2. **`alternative_offered` is binary on the slot, not on the editor's actual interaction.** Today: `alternative_offered = (altsBySlotId.get(slot?.slot_id) || []).length > 0` — true if Pass 2 emitted alternatives, regardless of whether the editor opened the drawer. The signal "the editor saw alternatives and rejected them" vs "the alternatives were buried in a collapsed drawer" is lost.

3. **`alternative_selected` is fired only via `handleSwapAlternative`.** A drag from `proposed → rejected` while the alts drawer was open reads `alternative_selected=false`, even though the editor was actively reviewing alternatives. Half the alternative-aware signal goes uncaptured.

4. **`primary_signal_overridden` is never populated.** No UI prompts the editor for which signal (vertical_lines, lighting, composition_match, etc.) drove their override. Mig 285 added the column, but no code path writes it. The `get_override_analytics` RPC (mig 295 line 159-176) groups by this column and renders `'<unspecified>'` for ~100% of rows — the analytics page is empty for that dimension.

Wave 8's tier-weights tuning + Wave 13a's training extraction both want rich, per-row context. This wave wires up the swimlane state machine to capture it, and adds one schema tweak (a tracking column) for the evidence audit.

---

## Architecture

### Section 1 — Per-row review timing (replaces page-level ref)

Today's page-level `reviewStartRef` becomes a per-card timer, indexed by `composition_group_id`. The card's "review starts" the first time it scrolls into the viewport (or when the editor expands its details), and "review ends" on the drag/drop event.

```typescript
// flexmedia-src/src/components/projects/shortlisting/ShortlistingSwimlane.jsx

// Replace single reviewStartRef with a Map keyed by group_id.
const reviewStartByGroupId = useRef(new Map<string, number>());
// Cards in viewport: when a card mounts and is in viewport, mark its start.
// We use IntersectionObserver to batch-track. ~150 cards is well within the
// observer's perf budget.
const cardObserverRef = useRef<IntersectionObserver | null>(null);

useEffect(() => {
  if (!('IntersectionObserver' in window)) return;
  cardObserverRef.current = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const groupId = entry.target.getAttribute('data-group-id');
      if (!groupId) continue;
      if (entry.isIntersecting && !reviewStartByGroupId.current.has(groupId)) {
        reviewStartByGroupId.current.set(groupId, Date.now());
      }
    }
  }, { threshold: 0.5, rootMargin: '0px' });
  return () => cardObserverRef.current?.disconnect();
}, []);

// In ShortlistingCard.jsx — add ref + data attribute that the observer hooks
// into.
const cardRef = useRef(null);
useEffect(() => {
  if (cardRef.current && cardObserverRef?.current) {
    cardObserverRef.current.observe(cardRef.current);
    return () => cardObserverRef.current?.unobserve(cardRef.current);
  }
}, []);
return <div ref={cardRef} data-group-id={group.id} ...>{...}</div>;

// On drag end, compute per-row dwell:
const reviewSecs = (() => {
  const startMs = reviewStartByGroupId.current.get(groupId);
  if (!startMs) return null;  // never observed — defensive; fallback below
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
})() ?? Math.floor((Date.now() - reviewStartRef.current) / 1000);  // page-level fallback
```

**Fallback:** if a card never entered the viewport (rare — only happens if the editor drags from search results or filters), fall back to the page-level timer. The page-level `reviewStartRef` stays as a safety net but is no longer the primary source.

**Drawer interaction also triggers a "start":** when the editor expands the card's details panel (alternatives drawer, EXIF popover, etc), record start if not already set. Avoids the case where a card is below-fold but the editor opens it via a "jump to next" hotkey.

### Section 2 — Drawer-state-aware `alternative_offered` + `alternative_selected`

Today: both fields are computed at drag-end from passive state. Wave 10.3 makes them reflect actual interaction.

```typescript
// New state: which slot's alternatives drawer is currently open?
const [openAltsBySlotId, setOpenAltsBySlotId] = useState<Set<string>>(new Set());

// Track whether the editor has EVER opened the drawer for this slot during
// the current session — separate Set so we can distinguish "is open right
// now" vs "was opened at some point".
const seenAltsBySlotId = useRef<Set<string>>(new Set());

// When an alt drawer toggles open:
const onAltsDrawerOpen = (slotId: string) => {
  setOpenAltsBySlotId((prev) => new Set([...prev, slotId]));
  seenAltsBySlotId.current.add(slotId);
};

// In the drag-end override payload:
const slotId = slot?.slot_id || null;
const event = {
  // ...
  alternative_offered:
    !!slotId && (
      seenAltsBySlotId.current.has(slotId) ||
      (altsBySlotId.get(slotId)?.length ?? 0) > 0  // backwards-compat: even if drawer never opened, the slot HAS alts
    ),
  // alternative_offered_drawer_seen: did the editor actually open the drawer?
  // This is a NEW column (see §3) — not the same as alternative_offered.
  alternative_offered_drawer_seen: !!slotId && seenAltsBySlotId.current.has(slotId),
  alternative_selected: false,  // dragging is not selecting
};

// In handleSwapAlternative — explicitly TRUE for both:
const event = {
  // ...
  alternative_offered: true,
  alternative_offered_drawer_seen: true,  // selecting an alt requires the drawer to have been visible
  alternative_selected: true,
};
```

The new column `alternative_offered_drawer_seen` lets the analytics distinguish "alts existed but editor ignored them (closed drawer)" from "alts existed and editor actively rejected them (drawer open, drag without picking)". Wave 8's tier-weight tuning needs the second signal to learn what makes an alternative compelling.

### Section 3 — `primary_signal_overridden` capture via dropdown

When the editor performs a `removed` or `swapped` action — i.e. they're disagreeing with Pass 2's choice — pop a small modal asking which signal drove the decision. The modal is non-blocking: the override fires immediately (optimistic), the modal collects the signal annotation in a follow-up POST.

```jsx
// New component: SignalAttributionModal.jsx
//
// Shown after a 'removed' or 'swapped' override fires. The override row was
// already inserted; this modal collects the primary_signal_overridden value
// and PATCHes the row via shortlisting-overrides (new PATCH path) or via a
// dedicated annotate endpoint.
//
// Dropdown options come from a fixed list — these are the human-readable
// versions of the W11 signal_scores keys (per universal vision response
// schema). The list is intentionally curated (not all 22 signals); editor's
// override usually maps to one of ~8 well-known reasons.

const SIGNAL_OPTIONS = [
  { value: 'vertical_line_convergence',  label: 'Vertical lines / keystone' },
  { value: 'horizon_level',              label: 'Horizon / level' },
  { value: 'sharpness_primary_subject',  label: 'Sharpness / focus' },
  { value: 'window_blowout_area',        label: 'Window blowout / lighting' },
  { value: 'shadow_crush_percentage',    label: 'Shadow detail' },
  { value: 'ambient_artificial_balance', label: 'Light balance' },
  { value: 'composition_type_match',     label: 'Composition / framing' },
  { value: 'three_wall_coverage',        label: 'Wall coverage (kitchen)' },
  { value: 'sight_line_depth_layers',    label: 'Depth / sight lines' },
  { value: 'styling_deliberateness',     label: 'Styling / staging' },
  { value: 'clutter_severity',           label: 'Clutter / mess' },
  { value: 'duplicate_or_near_dup',      label: 'Near-duplicate of better shot' },
  { value: 'client_preference',          label: 'Client / agent preference' },
  { value: 'other',                      label: 'Other (free text)' },
];
```

The modal is dismissable — if the editor closes it (X button, Esc, click-outside), `primary_signal_overridden` stays NULL. We do NOT block the workflow on annotation; speed matters more than telemetry density.

**`other` choice** opens a small free-text input that gets stored as-is into `primary_signal_overridden` (column is TEXT). Free-text rows show up in `get_override_analytics` as their literal value — over time, common free-text answers should be promoted to the dropdown (admin can add via a Settings page; out of scope for this spec).

```typescript
// Endpoint: PATCH shortlisting-overrides accepts { override_id, primary_signal_overridden }
// Already a POST endpoint; extend to accept an `annotate` shape:

POST /shortlisting-overrides
body: {
  annotate: {
    override_id: UUID,
    primary_signal_overridden: string | null,
  }
}
// Returns 200 { ok: true, override_id }
```

The endpoint update is small (~30 lines) — branch on `body.annotate` before the existing `body.events` array logic.

### Section 4 — Drawer-seen audit column (new)

Mig 285 has `alternative_offered`. Wave 10.3 adds **one** new column:

```sql
ALTER TABLE shortlisting_overrides
  ADD COLUMN IF NOT EXISTS alternative_offered_drawer_seen BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN shortlisting_overrides.alternative_offered_drawer_seen IS
  'Wave 10.3 P1-16: TRUE only when the editor actually opened the alternatives drawer for this slot in this review session. Distinguishes "alts existed but editor ignored them" from "alts existed and editor rejected them". Required by Wave 8 tier-weight tuning + Wave 13a training extraction.';

COMMENT ON COLUMN shortlisting_overrides.alternative_offered IS
  'Wave 6 + Wave 10.3 P1-16: TRUE when Pass 2 emitted alternatives for this slot AND the swimlane rendered the drawer (collapsed or open). For "drawer open with editor actually browsing" use alternative_offered_drawer_seen.';
```

Backfill rule: existing rows stay FALSE (default). The column has meaning only for events captured under the W10.3 swimlane build forward.

### Section 5 — Existing column populations (no schema change)

The four columns from mig 285 stay as-is; this wave's value is the **wiring**, not the DDL:

| Column | Mig 285 | W10.3 wiring change |
|---|---|---|
| `review_duration_seconds` | INT, exists | Per-row timer via IntersectionObserver replaces page-level ref |
| `alternative_offered` | BOOL, exists | Computed from `seenAltsBySlotId` ∪ "Pass 2 had alts" — backwards compat preserved |
| `alternative_selected` | BOOL, exists | Stays exact — only `handleSwapAlternative` flips it true |
| `primary_signal_overridden` | TEXT, exists | New `SignalAttributionModal` POSTs annotation after `removed`/`swapped` |

---

## Migration

Reserve **next available** at integration time. Recommend `341_shortlisting_overrides_drawer_seen.sql` (W7.7=339, W10.1=340).

```sql
-- Wave 10.3 P1-16: shortlisting_overrides gains alternative_offered_drawer_seen
-- so the analytics can distinguish "drawer rendered but editor ignored" from
-- "drawer opened and alts actively rejected".

ALTER TABLE shortlisting_overrides
  ADD COLUMN IF NOT EXISTS alternative_offered_drawer_seen BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN shortlisting_overrides.alternative_offered_drawer_seen IS
  'Wave 10.3 P1-16: TRUE only when the editor actually opened the alternatives drawer for this slot in this review session.';

-- Optional: backfill TRUE for rows where alternative_selected=TRUE (selecting
-- an alt implies the drawer was open). Conservatively safe to skip — the
-- analytics queries will just see the NEW signal as "starts gathering data
-- from W10.3 deploy onward" which is the correct framing for the editor.
UPDATE shortlisting_overrides
SET alternative_offered_drawer_seen = TRUE
WHERE alternative_selected = TRUE
  AND alternative_offered_drawer_seen = FALSE;

NOTIFY pgrst, 'reload schema';

-- Rollback (manual):
-- ALTER TABLE shortlisting_overrides DROP COLUMN IF EXISTS alternative_offered_drawer_seen;
```

---

## Engine integration

1. **`shortlisting-overrides` edge fn** — extend to accept the annotate path:

```typescript
// supabase/functions/shortlisting-overrides/index.ts (additions ~line 110)

if (body.annotate && typeof body.annotate === 'object') {
  const a = body.annotate;
  if (!a.override_id || typeof a.override_id !== 'string') {
    return errorResponse('annotate.override_id required', 400, req);
  }
  const signal = a.primary_signal_overridden ?? null;
  if (signal !== null && (typeof signal !== 'string' || signal.length > 200)) {
    return errorResponse('annotate.primary_signal_overridden must be string ≤200 chars or null', 400, req);
  }
  const admin = getAdminClient();
  // Verify caller has access to the row's project_id before update
  const { data: existing } = await admin
    .from('shortlisting_overrides')
    .select('project_id')
    .eq('id', a.override_id)
    .maybeSingle();
  if (!existing) return errorResponse('override not found', 404, req);
  if (!isService) {
    const ok = await callerHasProjectAccess(user, existing.project_id);
    if (!ok) return errorResponse('Forbidden', 403, req);
  }
  const { error } = await admin
    .from('shortlisting_overrides')
    .update({ primary_signal_overridden: signal })
    .eq('id', a.override_id);
  if (error) return errorResponse(`annotate failed: ${error.message}`, 500, req);
  return jsonResponse({ ok: true, override_id: a.override_id }, 200, req);
}
```

2. **`get_override_analytics` RPC (mig 295)** — no change needed; it already groups by `primary_signal_overridden`. With W10.3 wiring, the bucket distribution becomes meaningful instead of 100% `<unspecified>`.

3. **W8 tier-config tuning (downstream)** — when Wave 8.3 re-simulates rounds under proposed weights, the simulator can now correlate "primary_signal_overridden=window_blowout_area" with "tier P weight on lighting=0.45" → weight tuning recommendation.

4. **W13a training extraction (downstream)** — each training row inherits the override's `primary_signal_overridden` as a feature; few-shot prompts can quote the editor's stated reason ("editor preferred this over the AI choice because of vertical line convergence").

---

## Frontend impact

1. **`ShortlistingSwimlane.jsx`** — replace page-level timer with IntersectionObserver per-card; add `seenAltsBySlotId` Set; add `SignalAttributionModal` to the post-drag flow for `removed`/`swapped` actions.

2. **`ShortlistingCard.jsx`** — accept and forward an `onCardSeen` callback (so the observer can register), expose `data-group-id` attribute.

3. **`AlternativesDrawer.jsx`** (or wherever the alts tray lives — confirmed via grep at integration time) — accept `onOpen` callback, fire when expand transition starts.

4. **`SignalAttributionModal.jsx`** (new) — Radix Dialog with the SIGNAL_OPTIONS dropdown + free-text fallback for `other`. Dismissable; non-blocking.

5. **Annotate API client method** — add to `flexmedia-src/src/api/supabaseClient.js` shortlisting wrappers:

```javascript
api.functions.invoke('shortlisting-overrides', {
  annotate: { override_id, primary_signal_overridden },
});
```

6. **Override analytics page** (existing — find via grep `get_override_analytics`) — no UI change needed; rendering is already correct, just data quality improves post-W10.3 deploy.

---

## Tests

- **Unit:** `cameraPartitioner` style — pure helpers in this spec are minimal (`SIGNAL_OPTIONS` list, payload shape). Most logic is React state + IntersectionObserver wiring; integration tests cover this.
- **Integration:** Playwright (or React Testing Library) test that mounts the swimlane with 2 cards, scrolls one into view, drags it, asserts `review_duration_seconds` ≈ time-since-scroll and not time-since-mount.
- **Endpoint:** `shortlisting-overrides.test.ts` — extend with annotate path coverage (success, missing override_id, signal too long, no project access).
- **Schema:** smoke test the new column exists post-migration; check default value works.

---

## Open questions for sign-off

**Q1.** SignalAttributionModal is non-blocking and dismissable. Is that the right UX, or do you want it to gate the drag-end (force annotation before the override is committed)?
**Recommendation:** non-blocking. Editor velocity matters; we'd rather have 60% of overrides annotated than slow down every drag. The modal closes on Esc or click-outside; rows stay NULL for `primary_signal_overridden` and that's a legitimate signal too ("editor was in flow, didn't want to stop"). If post-launch the annotation rate is < 30%, revisit.

**Q2.** SIGNAL_OPTIONS list — is the curated 14-item list the right starting point, or do you want all 22 W11 signal_scores keys exposed as options?
**Recommendation:** curated 14 for v1. The full 22 list includes signals editors don't think about (e.g. `geometric_distortion_barrel`, `light_source_consistency`) — exposing them creates analysis paralysis and bad-quality signal-overridden rows. Add `other` (free text) as the escape hatch; promote frequent free-text answers via Settings page later.

**Q3.** Per-row review timing via IntersectionObserver vs hover-time vs explicit "review this card" click? IntersectionObserver gives "card was on screen with ≥50% visibility for N seconds" — close but not identical to "editor was actually looking at this card". Hover-time is more precise but harder to capture (cards aren't always hovered before drag). Explicit click-to-review is most precise but adds workflow friction.
**Recommendation:** IntersectionObserver for v1. Imperfect signal but cheap to implement, and the >30s gate (`confirmed_with_review`) is robust to imperfect timing. If post-launch the review_duration_seconds distribution looks weird (e.g. bimodal at "10s" and "60s"), revisit.

---

## Resolutions self-resolved by orchestrator

- **R1 (4 columns already exist).** Mig 285 added `review_duration_seconds`, `alternative_offered`, `alternative_selected`, `primary_signal_overridden` — confirmed at audit. W10.3 is a wiring wave, not a schema wave. The single new column (`alternative_offered_drawer_seen`) is additive evidence, not a substitute.

- **R2 (annotate as a follow-up POST, not inline).** Inline annotation in the original event POST would force the editor to wait for the modal before the optimistic UI update lands — bad UX. Follow-up annotation is async and the row already exists by the time it fires. Worst case: editor closes browser before annotating → row stays `primary_signal_overridden=NULL`, which is the current state for 100% of rows anyway.

- **R3 (no per-tier signal vocabulary).** Tier S projects might emphasise different signals than Tier A (e.g. "styling_deliberateness" matters more on Tier P), but the dropdown stays universal in v1. Per-tier vocabularies are a Wave 8 concern (tier configs control which signals weight high), not a Wave 10.3 input concern.

- **R4 (free-text `other` is text, not a relation).** No FK to a "common reasons" table. Promotion to dropdown happens by the Settings admin reading the most-frequent `other` rows and adding them as new entries — manual curation. Avoids over-engineering.

- **R5 (per-row timer falls back to page-level).** For users on browsers without IntersectionObserver (rare but real — old Safari) or when a card never enters viewport, the page-level `reviewStartRef` stays as the safety net. The output is "review_duration_seconds is at least correct in the legacy direction".

---

## Effort estimate

- Migration + comment updates: 15 min
- Endpoint annotate path + tests: 60 min
- Per-row IntersectionObserver wiring + ShortlistingCard ref: 90 min
- AlternativesDrawer onOpen + seenAltsBySlotId state: 45 min
- SignalAttributionModal + free-text input + dropdown: 90 min
- Smoke test on a real round (capture 5+ overrides, verify column population): 30 min

**Total: ~1 day.** Test discipline is important — bad telemetry wiring corrupts months of training data before anyone notices.

---

## Out of scope (handled in other waves)

- W8 tier-weight tuning that consumes `primary_signal_overridden` (Wave 8 spec)
- W13a training extraction that uses these columns as features (W13a spec, this folder)
- Settings page for managing the SIGNAL_OPTIONS dropdown (admin curation; deferred until free-text rows accumulate)
- Per-tier signal vocabularies (deferred per R3)
- `confirmed_with_review` threshold tuning (currently fixed at 30s in the edge fn — admin-tunable in a Settings burst, out of scope for W10.3)

---

## Pre-execution checklist

- [ ] Joseph signs off on Q1 (modal blocking vs non-blocking), Q2 (signal list curation), Q3 (timing approach)
- [ ] Migration number reserved at integration time (recommend 341)
- [ ] AlternativesDrawer.jsx component path confirmed via grep — drawer onOpen callback is straightforward to wire
- [ ] Endpoint annotate path covered in `shortlisting-overrides.test.ts` before deploy
- [ ] Smoke test: lock a synthetic round, fire 5+ overrides, verify `alternative_offered_drawer_seen` differs across actions and `primary_signal_overridden` populates from the modal

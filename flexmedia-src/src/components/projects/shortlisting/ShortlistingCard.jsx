/**
 * ShortlistingCard — Wave 6 Phase 6 SHORTLIST
 *                    + W11.6.2 (3:2 aspect, "Why?" expander, collapsed-card
 *                    alternatives tray)
 *
 * Per-composition card rendered in the swimlane columns.
 *
 * Layout:
 *   - Thumbnail (3:2 aspect — Canon R5 native is 6240x4160 = 1.5 = 3:2)
 *   - Filename (monospace, truncated)
 *   - Room type label (human-readable)
 *   - Slot ID badge (only if shortlisted) with phase indicator
 *   - 4-dim scores (C / L / T / A / avg)
 *   - Shortlist / rejected badge
 *   - "Why?" expander (W11.6.2 P1-20) — three sections:
 *       1. Stage 1 reasoning  → composition_classifications.analysis verbatim
 *       2. Stage 4 slot rationale → shortlisting_overrides.ai_proposed_analysis
 *          (Stage 4 persists winner.rationale into this column when it writes
 *           the ai_proposed override row — see persistSlotDecisions in
 *           shortlisting-shape-d-stage4/index.ts).
 *       3. Rejection reason → shortlisting_stage4_overrides.reason for this
 *          stem when present, else "Near-duplicate of <stem>" derived from
 *          shortlisting_rounds.dedup_groups when this stem appears under
 *          another stem's cluster.
 *     Singleton store ensures one panel open at a time across the swimlane.
 *
 *   - Alternatives tray (W11.6.2 P3 #2): collapsed-card design — each alt
 *     renders as a 96px-square thumb + truncated rationale badge. Tooltip
 *     surfaces full rationale + score on hover. Click = swap in place.
 *
 * Drag handle is the whole card. The parent swimlane wires DragDropContext +
 * Draggable from @hello-pangea/dnd.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, supabase } from "@/api/supabaseClient";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ChevronDown, ChevronUp, HelpCircle, Sparkles } from "lucide-react";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { cn } from "@/lib/utils";

// Human-readable room type labels — consistent with Pass 1 prompt taxonomy.
const ROOM_TYPE_LABEL = {
  master_bedroom: "Master Bedroom",
  bedroom_secondary: "Secondary Bedroom",
  bedroom: "Bedroom",
  kitchen_main: "Kitchen",
  kitchen: "Kitchen",
  living_main: "Living Room",
  living_secondary: "Secondary Living",
  living: "Living",
  dining: "Dining",
  bathroom_main: "Main Bathroom",
  bathroom_ensuite: "Ensuite",
  bathroom: "Bathroom",
  laundry: "Laundry",
  hallway: "Hallway",
  staircase: "Staircase",
  alfresco: "Alfresco",
  patio: "Patio",
  pool: "Pool",
  garden: "Garden",
  exterior_front: "Exterior Front",
  exterior_rear: "Exterior Rear",
  exterior_side: "Exterior Side",
  exterior: "Exterior",
  garage: "Garage",
  study: "Study/Office",
  office: "Office",
  detail: "Detail",
  twilight: "Twilight",
  drone: "Drone",
};

function humanRoomType(rt) {
  if (!rt) return "—";
  if (ROOM_TYPE_LABEL[rt]) return ROOM_TYPE_LABEL[rt];
  return rt
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatScore(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toFixed(1);
}

function shortFilename(s, max = 32) {
  if (!s) return "—";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

// W11.6.2 P3 #2: hard truncate to N chars with ellipsis. Used for the
// alternative-card rationale badge under each thumbnail (spec asks for
// max 60 chars).
function truncate(s, max) {
  if (!s) return "";
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

// ── Singleton "expanded card" store ──────────────────────────────────────────
// W11.6.2 P1-20: the brief asks for ONE Why? panel open at a time across the
// swimlane. The cleanest cross-card coordination — without dragging state up
// into ShortlistingSwimlane.jsx (which W11.6.1 owns and we explicitly do not
// touch) — is a tiny module-level store with `useSyncExternalStore`. Every
// card subscribes to the same currentExpandedId; toggling on a different card
// closes any prior panel.
let _expandedCardId = null;
const _expandedListeners = new Set();
function _emitExpandedChange() {
  for (const l of _expandedListeners) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}
function setExpandedCardId(id) {
  if (_expandedCardId === id) return;
  _expandedCardId = id;
  _emitExpandedChange();
}
function getExpandedCardId() {
  return _expandedCardId;
}
function subscribeExpandedCardId(cb) {
  _expandedListeners.add(cb);
  return () => _expandedListeners.delete(cb);
}
function useIsExpanded(cardId) {
  return useSyncExternalStore(
    subscribeExpandedCardId,
    () => getExpandedCardId() === cardId,
    () => false,
  );
}

/**
 * @param {object} props
 * @param {object} props.composition  composition group + classification + slot info
 * @param {string} props.column       'rejected' | 'proposed' | 'approved'
 * @param {Array}  props.alternatives top-2 alternatives for this slot, each
 *                                    { group_id, stem, combined_score, room_type, analysis }
 * @param {boolean} props.isDragging  true while @hello-pangea drag is active
 * @param {function} props.onSwapAlternative  invoked with (altGroupId) when an alt is tapped
 * @param {function} [props.registerCardObserver]  Wave 10.3: parent-supplied
 *   IntersectionObserver registration. Receives the outer card DOM node and
 *   returns a teardown fn. Optional — when absent (e.g. tests, manual mode)
 *   the card renders normally without per-row review timing.
 * @param {function} [props.onAltsDrawerOpen]  Wave 10.3: invoked the first
 *   time the editor expands the alternatives drawer for this card. Wired to
 *   the swimlane's seenAltsBySlotId tracking so analytics can distinguish
 *   "drawer rendered" from "drawer actively viewed".
 */
export default function ShortlistingCard({
  composition,
  column,
  alternatives = [],
  isDragging = false,
  onSwapAlternative,
  registerCardObserver,
  onAltsDrawerOpen,
}) {
  const [altsExpanded, setAltsExpanded] = useState(false);
  // W11.6.2 P3 #2: which alt is "expanded in place" inside the tray.
  // First click on a thumb sets this; second click commits the swap.
  const [activeAltGroupId, setActiveAltGroupId] = useState(null);

  const c = composition || {};
  const cls = c.classification || {};
  const slot = c.slot || null; // { slot_id, phase, rank } when shortlisted
  const roundId = c.round_id || null;
  const cardId = c.id || null;
  const stem = c.delivery_reference_stem || c.best_bracket_stem || null;

  const whyExpanded = useIsExpanded(cardId);

  // Wave 10.3 P1-16: register the outer card div with the swimlane's shared
  // IntersectionObserver. The observer records the timestamp of the first
  // viewport entry per group_id; the swimlane's drag handler subtracts that
  // to compute review_duration_seconds. Re-register if the parent rotates
  // its registerCardObserver callback (rare; covers HMR + round-switch).
  const cardRef = useRef(null);
  useEffect(() => {
    if (!registerCardObserver || !cardRef.current) return undefined;
    const teardown = registerCardObserver(cardRef.current);
    return typeof teardown === "function" ? teardown : undefined;
  }, [registerCardObserver, c.id]);

  // ── W11.6.2 P1-20: data fetches for the "Why?" panel ────────────────────
  // Round-level fetches with TanStack Query — keys MATCH the swimlane's
  // existing query keys so the cache deduplicates. The swimlane fetches
  // these on mount; cards opening Why? hit cache, not network.
  //
  // Reads only. Stage 4 already wrote ai_proposed_analysis into
  // shortlisting_overrides during persistSlotDecisions; we do not mutate.
  const overridesQuery = useQuery({
    queryKey: ["shortlisting_overrides", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingOverride.filter(
        { round_id: roundId },
        "created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId && whyExpanded),
    staleTime: 15_000,
  });

  // Stage 4 corrections — used to surface the Stage 4 cross-comparison reason
  // as the "rejection reason" when present. Spec note: brief asks for
  // field='clutter' specifically, but production data on the test round has
  // field='room_type'/'vantage'. We surface ANY stage_4_overrides row for the
  // stem because the rationale is the editor-facing artifact regardless of
  // which Stage 1 field Stage 4 corrected.
  // No entity registered for shortlisting_stage4_overrides — use raw supabase
  // (same pattern as ShapeDEngineBanner). Round-keyed so cards on the same
  // round share the cache hit.
  const stage4OverridesQuery = useQuery({
    queryKey: ["shortlisting_stage4_overrides", roundId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_stage4_overrides")
        .select("stem, field, stage_1_value, stage_4_value, reason")
        .eq("round_id", roundId);
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: Boolean(roundId && whyExpanded),
    staleTime: 30_000,
  });

  // shortlisting_rounds.dedup_groups (Stage 4 cross-image dedup output) —
  // surfaces "Near-duplicate of <stem>" when the card's stem appears under
  // another stem's cluster. We pull just the dedup_groups column so the
  // payload stays tiny.
  const roundQuery = useQuery({
    queryKey: ["shortlisting_round_dedup_groups", roundId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_rounds")
        .select("dedup_groups")
        .eq("id", roundId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data || null;
    },
    enabled: Boolean(roundId && whyExpanded),
    staleTime: 30_000,
  });

  // composition_groups for the round — keyed identically to the swimlane's
  // own groups query so we hit the cache rather than re-fetch. Used by the
  // alternatives tray (W11.6.2 P3 #2) to look up dropbox_preview_path for
  // each alt: the swimlane decorates alts with {group_id, stem, score,
  // analysis} but doesn't include preview path. Resolving here keeps the
  // swimlane file untouched.
  const groupsQuery = useQuery({
    queryKey: ["composition_groups", roundId],
    queryFn: async () => {
      const rows = await api.entities.CompositionGroup.filter(
        { round_id: roundId },
        "group_index",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId && altsExpanded),
    staleTime: 15_000,
  });
  const groupById = (() => {
    const m = new Map();
    for (const g of groupsQuery.data || []) m.set(g.id, g);
    return m;
  })();


  // Resolve Stage 4 winner rationale for this card's slot. Match by
  // (round_id, ai_proposed_group_id == cardId) on the human_action='ai_
  // proposed' row, OR by ai_proposed_slot_id when cardId might have been
  // swapped out (we still want to render the slot's rationale in that case).
  // Most cards in PROPOSED have the direct-id match; APPROVED post-swap might
  // not, so we fall back to slot_id.
  const stage4SlotRationale = (() => {
    const rows = overridesQuery.data || [];
    if (!rows.length) return null;
    // Direct match: this card was Stage 4's winner for some slot.
    const direct = rows.find(
      (ov) =>
        ov.human_action === "ai_proposed" && ov.ai_proposed_group_id === cardId,
    );
    if (direct?.ai_proposed_analysis) return direct.ai_proposed_analysis;
    // Fallback for APPROVED-via-swap: the override row in this column is
    // human_action='swapped' with human_selected_group_id===cardId. The
    // RATIONALE we want is still the original Stage 4 winner's rationale
    // (i.e. WHY Stage 4 picked the OTHER one) — useful for audit.
    if (slot?.slot_id) {
      const slotRow = rows.find(
        (ov) =>
          ov.human_action === "ai_proposed" &&
          ov.ai_proposed_slot_id === slot.slot_id,
      );
      if (slotRow?.ai_proposed_analysis) return slotRow.ai_proposed_analysis;
    }
    return null;
  })();

  // Stage 4 rejection-correction reason (room_type/vantage/etc.) for THIS stem.
  const stage4OverrideForStem = (() => {
    const rows = stage4OverridesQuery.data || [];
    if (!rows.length || !stem) return null;
    return rows.find((r) => r.stem === stem) || null;
  })();

  // dedup_groups membership — when the stem appears under another stem's
  // cluster, surface "Near-duplicate of <other_stem>". The first stem in
  // each group_label cluster is treated as the canonical winner; subsequent
  // stems are the near-duplicates. We're conservative here: only surface
  // if the stem is NOT first in its group.
  const dedupNearOf = (() => {
    if (!stem) return null;
    // roundQuery.data shape: { dedup_groups: [...] } from the .select.
    const groups = roundQuery.data?.dedup_groups;
    if (!Array.isArray(groups)) return null;
    for (const g of groups) {
      const stems = Array.isArray(g?.image_stems) ? g.image_stems : [];
      const idx = stems.indexOf(stem);
      if (idx > 0) {
        return stems[0]; // canonical winner = first stem in the cluster
      }
    }
    return null;
  })();

  const filename = stem || "—";
  const roomType = humanRoomType(cls.room_type);
  const tScore = cls.technical_score;
  const lScore = cls.lighting_score;
  const compScore = cls.composition_score;
  const aScore = cls.aesthetic_score;
  const avgScore =
    cls.combined_score != null
      ? cls.combined_score
      : tScore != null && lScore != null && compScore != null && aScore != null
        ? (Number(tScore) + Number(lScore) + Number(compScore) + Number(aScore)) / 4
        : null;

  const previewPath = c.dropbox_preview_path;

  const toggleWhy = (e) => {
    e.stopPropagation();
    if (!cardId) return;
    setExpandedCardId(whyExpanded ? null : cardId);
  };

  return (
    <Card
      ref={cardRef}
      data-group-id={c.id}
      className={cn(
        "rounded-md border bg-card overflow-hidden transition-shadow",
        isDragging && "ring-2 ring-primary/60 shadow-lg",
        column === "approved" && "border-emerald-300 dark:border-emerald-800",
        column === "rejected" && "border-red-200 dark:border-red-900",
      )}
    >
      {/* Thumbnail — W11.6.2: 3:2 (Canon R5 native is 6240x4160 = 1.5).
          aspect-[4/3] cropped vertical edges, destroying the compositional
          fidelity that Stage 1 spent 1,700 chars analysing. */}
      <div className="relative">
        <DroneThumbnail
          dropboxPath={previewPath}
          mode="thumb"
          alt={filename}
          aspectRatio="aspect-[3/2]"
          overlay={
            <>
              {column === "approved" && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-emerald-600 text-white pointer-events-none">
                  Approved
                </span>
              )}
              {column === "rejected" && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-red-600 text-white pointer-events-none">
                  Rejected
                </span>
              )}
              {column === "proposed" && slot?.slot_id && (
                <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-amber-500 text-white pointer-events-none">
                  Proposed
                </span>
              )}
            </>
          }
        />
      </div>

      {/* Body */}
      <div className="p-2 space-y-1.5">
        {/* Filename + room type */}
        <div className="space-y-0.5">
          <div
            className="text-[11px] font-mono truncate text-foreground"
            title={filename}
          >
            {shortFilename(filename)}
          </div>
          <div className="text-[10px] text-muted-foreground truncate">
            {roomType}
          </div>
        </div>

        {/* Slot badge */}
        {slot?.slot_id && (
          <div className="flex items-center gap-1 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                "text-[9px] h-4 px-1.5 font-medium",
                column === "approved"
                  ? "border-emerald-400 text-emerald-700 dark:text-emerald-300"
                  : "border-amber-400 text-amber-700 dark:text-amber-300",
              )}
            >
              {/* Audit defect #50: Phase 3 (AI free recommendations) used to
                  render the raw fallback string "ai_recommended" — confusing
                  for editors. Map to a human label. Other slot IDs render
                  as-is (they're meaningful identifiers like
                  exterior_front_hero). */}
              {slot.slot_id === "ai_recommended" ? "Phase 3 — AI rec" : slot.slot_id}
            </Badge>
            {slot.phase != null && slot.slot_id !== "ai_recommended" && (
              <span className="text-[9px] text-muted-foreground">
                phase {slot.phase}
              </span>
            )}
          </div>
        )}

        {/* 4-dim scores */}
        <div className="flex items-center gap-1.5 flex-wrap text-[10px] font-mono text-muted-foreground">
          <span>C={formatScore(compScore)}</span>
          <span>L={formatScore(lScore)}</span>
          <span>T={formatScore(tScore)}</span>
          <span>A={formatScore(aScore)}</span>
          <span className="font-semibold text-foreground">
            avg={formatScore(avgScore)}
          </span>
        </div>

        {/* Flags */}
        {cls.flag_for_retouching && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-amber-400 text-amber-700 dark:text-amber-300">
            <Sparkles className="h-2.5 w-2.5 mr-1" />
            Retouch
          </Badge>
        )}
        {cls.is_near_duplicate_candidate && column !== "approved" && (
          <Badge variant="outline" className="text-[9px] h-4 px-1 border-orange-400 text-orange-700 dark:text-orange-300">
            Near-dup
          </Badge>
        )}

        {/* W11.6.2 P1-20 — "Why?" expander trigger. The full prose stack
            (Stage 1 + Stage 4 + rejection reason) renders inside the panel
            below; the trigger itself stays compact so dense lanes don't
            sprawl. Only one card's panel is open at a time (singleton store
            above) — clicking another card auto-collapses this one. */}
        {(cls.analysis || stage4SlotRationale || stage4OverrideForStem || dedupNearOf) && (
          <button
            type="button"
            onClick={toggleWhy}
            className={cn(
              "flex items-center gap-1 text-[10px] focus:outline-none rounded-sm px-1 -mx-1",
              "text-primary hover:underline",
              whyExpanded && "bg-primary/5",
            )}
            aria-expanded={whyExpanded}
            aria-label="Show reasoning for this card"
          >
            <HelpCircle className="h-3 w-3" />
            <span>Why?</span>
            {whyExpanded ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </button>
        )}

        {/* W11.6.2 P1-20 — inline reasoning panel.
            Renders BELOW the metadata, not as a modal, so mobile reviewers
            can scroll the lane normally without losing card context. */}
        {whyExpanded && (
          <div
            className="border-t pt-2 mt-1 space-y-2 text-[10px] leading-snug"
            // Click inside the panel must not bubble up to the draggable
            // (otherwise selecting analysis text triggers a phantom drag).
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Stage 1 prose — verbatim Gemini analysis (~1,000-1,700 chars).
                whitespace-pre-wrap so paragraph breaks survive. */}
            {cls.analysis ? (
              <div>
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Stage 1 — composition analysis
                </div>
                <p className="text-muted-foreground whitespace-pre-wrap">
                  {cls.analysis}
                </p>
              </div>
            ) : null}

            {/* Stage 4 slot rationale — only meaningful when the card is in
                AI PROPOSED or HUMAN APPROVED. For REJECTED cards this is
                empty (rejected cards weren't picked by Stage 4). */}
            {stage4SlotRationale && column !== "rejected" ? (
              <div>
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Stage 4 — slot rationale
                  {slot?.slot_id ? (
                    <span className="font-mono font-normal ml-1 text-muted-foreground">
                      [{slot.slot_id}]
                    </span>
                  ) : null}
                </div>
                <p className="text-muted-foreground whitespace-pre-wrap">
                  {stage4SlotRationale}
                </p>
              </div>
            ) : null}

            {/* Rejection reason — Stage 4 cross-comparison override OR
                near-dup of another stem. Brief mentions field='clutter' but
                production rounds use field='room_type', 'vantage', etc;
                surface ANY stage_4_override for the stem because the
                editor-facing rationale is what matters. */}
            {(stage4OverrideForStem || dedupNearOf) && (
              <div>
                <div className="font-semibold text-foreground text-[10px] uppercase tracking-wide mb-0.5">
                  Stage 4 — correction / near-dup
                </div>
                {stage4OverrideForStem ? (
                  <p className="text-muted-foreground whitespace-pre-wrap">
                    <span className="font-mono text-[9px] text-foreground">
                      [{stage4OverrideForStem.field}: {stage4OverrideForStem.stage_1_value} → {stage4OverrideForStem.stage_4_value}]
                    </span>{" "}
                    {stage4OverrideForStem.reason}
                  </p>
                ) : null}
                {dedupNearOf ? (
                  <p className="text-muted-foreground">
                    Near-duplicate of{" "}
                    <span className="font-mono text-foreground">
                      {dedupNearOf}
                    </span>
                  </p>
                ) : null}
              </div>
            )}

            {/* Loading hint — keeps the panel from looking empty during the
                first fetch on a card that hasn't been opened yet. */}
            {(overridesQuery.isLoading ||
              stage4OverridesQuery.isLoading ||
              roundQuery.isLoading) &&
            !cls.analysis ? (
              <div className="text-muted-foreground italic">Loading reasoning…</div>
            ) : null}
          </div>
        )}

        {/* Alternatives tray — W11.6.2 P3 #2 collapsed-card design.
            Each alt: 96px square thumb + 60-char rationale badge below.
            Tooltip on hover surfaces full rationale + score. Click expands
            the alt to full card size in place (transition); a SECOND click
            commits the swap. The two-step protects against accidental
            slot reassignment when the editor is just inspecting alts.
            Only on proposed/approved cards with alts. */}
        {alternatives.length > 0 && column !== "rejected" && (
          <div className="border-t pt-1.5 mt-1">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setAltsExpanded((prev) => {
                  const next = !prev;
                  // Wave 10.3 P1-16: notify the swimlane that the editor is
                  // opening the drawer for this slot. The swimlane's
                  // seenAltsBySlotId ref tracks this so the override payload
                  // can flag alternative_offered_drawer_seen=TRUE on the
                  // resulting drag. Fire-once-per-open: only on the closed→
                  // open transition (next=true).
                  if (next && onAltsDrawerOpen && slot?.slot_id) {
                    onAltsDrawerOpen(slot.slot_id);
                  }
                  // Collapse any in-place alt expansion when the tray closes.
                  if (!next) setActiveAltGroupId(null);
                  return next;
                });
              }}
              className="flex items-center gap-1 text-[10px] text-primary hover:underline focus:outline-none"
            >
              {altsExpanded ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {alternatives.length} alternative{alternatives.length === 1 ? "" : "s"}
            </button>
            {altsExpanded && (
              <TooltipProvider delayDuration={150}>
                <div
                  className="mt-1.5 grid grid-cols-2 gap-1.5"
                  // Click inside the tray must not bubble up to the
                  // draggable wrapper (otherwise selecting the alt
                  // triggers a phantom drag start).
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {alternatives.map((alt) => {
                    const isActive = activeAltGroupId === alt.group_id;
                    const altStem = alt.stem || alt.delivery_reference_stem || "—";
                    const rationale = alt.analysis || "";
                    // Cache hit: same query key as the swimlane already uses.
                    const altGroup = groupById.get(alt.group_id) || null;
                    const altPreviewPath = altGroup?.dropbox_preview_path || null;
                    return (
                      <Tooltip key={alt.group_id}>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (!isActive) {
                                // First click → preview in place.
                                setActiveAltGroupId(alt.group_id);
                              } else if (onSwapAlternative) {
                                // Second click on the active alt → commit swap.
                                onSwapAlternative(alt.group_id);
                              }
                            }}
                            className={cn(
                              "rounded-sm border bg-muted/30 hover:bg-muted/50 transition-all overflow-hidden text-left",
                              "focus:outline-none focus:ring-2 focus:ring-primary/40",
                              isActive && "col-span-2 border-primary bg-primary/5 ring-2 ring-primary/40",
                            )}
                            title={
                              isActive
                                ? "Click again to swap into this slot"
                                : "Click to preview, click again to swap"
                            }
                          >
                            <DroneThumbnail
                              dropboxPath={altPreviewPath}
                              mode="thumb"
                              aspectRatio={
                                isActive ? "aspect-[3/2]" : "aspect-square"
                              }
                              alt={altStem}
                            />
                            <div className="p-1 space-y-0.5">
                              <div className="font-mono text-[9px] truncate">
                                {shortFilename(altStem, 18)}
                              </div>
                              {/* Spec asks for "max 60 chars truncated".
                                  Anything longer goes into the tooltip. */}
                              {rationale ? (
                                <div className="text-[8px] text-muted-foreground line-clamp-2 leading-tight">
                                  {truncate(rationale, 60)}
                                </div>
                              ) : null}
                              <div className="text-[8px] font-mono text-muted-foreground">
                                avg={formatScore(alt.combined_score)}
                              </div>
                            </div>
                          </button>
                        </TooltipTrigger>
                        {(rationale || alt.combined_score != null) && (
                          <TooltipContent
                            side="top"
                            className="max-w-[280px] text-[11px]"
                          >
                            <div className="font-mono text-[10px] mb-1">
                              {altStem} · avg={formatScore(alt.combined_score)}
                            </div>
                            {rationale ? (
                              <div className="leading-snug whitespace-pre-wrap">
                                {rationale}
                              </div>
                            ) : (
                              <div className="italic opacity-70">
                                No rationale available.
                              </div>
                            )}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    );
                  })}
                </div>
              </TooltipProvider>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

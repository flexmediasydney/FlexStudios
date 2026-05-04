/**
 * ShortlistingSwimlane — Wave 6 Phase 6 SHORTLIST + W11.6.1 operator UX.
 *
 * The 3-column swimlane review UI. Per spec §20:
 *   ┌──────────────────┬──────────────────┬──────────────────┐
 *   │    REJECTED       │  AI PROPOSED      │  HUMAN APPROVED  │
 *   │    ~25% width     │  ~50% width       │  ~25% width      │
 *   └──────────────────┴──────────────────┴──────────────────┘
 *
 * Initial column assignment per composition_group:
 *   AI PROPOSED if there's a pass2_slot_assigned (rank=1) event OR a
 *               pass2_phase3_recommendation event for this group_id
 *   REJECTED   otherwise (everything else: explicit near-dups + soft rejects)
 *   HUMAN APPROVED starts empty
 *
 * Apply overrides on top:
 *   approved_as_proposed → move from PROPOSED to APPROVED
 *   added_from_rejects   → move from REJECTED to APPROVED
 *   removed              → move from PROPOSED to REJECTED
 *   swapped              → ai_proposed_group_id moves to REJECTED;
 *                          human_selected_group_id moves to APPROVED
 *
 * Drag handler:
 *   1. Optimistic local-state update (move card)
 *   2. Compute override event payload
 *   3. POST to shortlisting-overrides edge function
 *   4. On error: revert + toast
 *
 * Top of swimlane (W11.6.1):
 *   - SwimlaneToolbar      — sort/filter/preview-size/group/timer
 *   - SwimlaneSlotCounter  — Phase 1/2/3 filled-vs-expected banner
 *   - Round metadata strip — status, ceiling, package_type, started_at
 *   - Lock & Reorganize    — calls shortlist-lock
 *
 * DnD library: @hello-pangea/dnd (already used in KanbanBoard).
 */
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
  useRef,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { api, supabase } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Lock,
  Loader2,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ShortlistingCard from "./ShortlistingCard";
import ShortlistingLightbox from "./ShortlistingLightbox";
import LockProgressDialog from "./LockProgressDialog";
import SignalAttributionModal from "./SignalAttributionModal";
import ShapeDEngineBanner from "./ShapeDEngineBanner";
import DispatcherPanel from "./DispatcherPanel";
import Stage4CorrectionsLane from "./Stage4CorrectionsLane";
import SwimlaneToolbar, {
  SwimlaneSlotCounter,
  useSwimlaneElapsedTimer,
} from "./SwimlaneToolbar";
import EditorialQuotaPanel from "./EditorialQuotaPanel";
import SwimlaneGridView from "./SwimlaneGridView";
import { useSwimlaneSettings, PREVIEW_SIZES } from "@/hooks/useSwimlaneSettings";
import {
  PHASE_OF_SLOT,
  SLOT_DISPLAY_NAMES,
  slotImportanceKey,
} from "@/lib/swimlaneSlots";
import { useAuth } from "@/lib/AuthContext";

// W11.6.20 density-grid: helper to resolve the minmax(<px>) floor for the
// CSS grid that lays out cards inside each bucket. The toolbar's SM/MD/LG
// toggle now drives DENSITY (cards-per-row) — not just thumbnail size —
// because the original behaviour left huge horizontal dead-space when SM
// was selected. See PREVIEW_SIZES.gridMinPx for the per-size floors.
//
// Exported for unit tests so we can assert the px floor without mounting
// the full swimlane (which has 10+ data dependencies).
export function previewGridMinPx(previewSize) {
  return PREVIEW_SIZES[previewSize]?.gridMinPx ?? PREVIEW_SIZES.md.gridMinPx;
}

export function previewGridStyle(previewSize) {
  // `auto-fill` packs as many columns as fit the lane width; `minmax` lets
  // each column flex to fill remaining space so a row of 3 cards in an MD
  // lane spreads evenly instead of clumping at the left. The ~1fr cap is
  // intentional: cards never grow indefinitely, but they DO fill the row
  // when there are fewer than the lane can hold.
  return {
    display: "grid",
    gridTemplateColumns: `repeat(auto-fill, minmax(${previewGridMinPx(previewSize)}px, 1fr))`,
  };
}

/**
 * W11.6.22c — pure helper: collect distinct slot_ids referenced by an array
 * of shortlisting_overrides rows. The lightbox Position panel needs the
 * matching shortlisting_slot_position_preferences for these slot_ids; the
 * swimlane uses this to drive a TanStack Query that filters by slot_id IN (...).
 *
 * Output is sorted so a re-render with the same set produces a stable query
 * key (cache-hit on identical rounds; re-fetch when an alt swap introduces a
 * new slot_id).
 *
 * Exported for unit tests so the slot-set extraction can be asserted without
 * mounting the swimlane.
 */
export function extractSlotIdsForPositionPrefs(overrideRows) {
  if (!Array.isArray(overrideRows)) return [];
  const set = new Set();
  for (const ov of overrideRows) {
    // A swap row carries TWO slot_ids — the original AI-picked slot AND the
    // human-selected target. We collect both so the position-prefs fetch
    // covers both sides of the swap (the lightbox might surface either as
    // the active slot decision depending on which override action lands
    // first in the resolution priority chain).
    if (ov?.ai_proposed_slot_id) set.add(ov.ai_proposed_slot_id);
    if (ov?.human_selected_slot_id) set.add(ov.human_selected_slot_id);
  }
  return [...set].sort();
}

/**
 * W11.6.22c — pure helper: build a (slot_id, position_index) → criteria
 * lookup Map from a list of shortlisting_slot_position_preferences rows.
 * Skips rows missing slot_id or position_index. Returns an empty Map when
 * input is empty/null (graceful — the lightbox renders just position_index
 * + filled_via without criteria when the map yields nothing).
 *
 * Exported for unit tests + future swimlane-adjacent surfaces (e.g. an
 * analytics page) that need the same lookup shape.
 */
export function buildPositionCriteriaMap(positionPrefs) {
  const m = new Map();
  if (!Array.isArray(positionPrefs)) return m;
  for (const p of positionPrefs) {
    if (!p?.slot_id || p?.position_index == null) continue;
    m.set(`${p.slot_id}:${p.position_index}`, {
      display_label: p.display_label,
      preferred_composition_type: p.preferred_composition_type,
      preferred_zone_focus: p.preferred_zone_focus,
      preferred_space_type: p.preferred_space_type,
      preferred_lighting_state: p.preferred_lighting_state,
      preferred_image_type: p.preferred_image_type,
      preferred_signal_emphasis: p.preferred_signal_emphasis,
      is_required: p.is_required,
      ai_backfill_on_gap: p.ai_backfill_on_gap,
    });
  }
  return m;
}

/**
 * W11.6.22c — pure helper: resolve the position fields for a slot decision.
 * Looks up the matching criteria from the position-criteria map and returns
 * the shape the lightbox Position panel reads:
 *   { position_index, position_filled_via, position_label, position_criteria }
 *
 * Returns all-nulls when slot_id or position_index is missing (legacy
 * ai_decides slots — the lightbox panel hides itself in that case).
 *
 * Exported for unit tests so the lightbox-criteria join can be asserted at
 * function level rather than only at the rendered DOM level.
 */
export function resolvePositionFields(positionCriteriaMap, slotId, positionIndex, positionFilledVia) {
  if (slotId == null || positionIndex == null) {
    return {
      position_index: null,
      position_filled_via: null,
      position_label: null,
      position_criteria: null,
    };
  }
  const criteria = positionCriteriaMap?.get
    ? positionCriteriaMap.get(`${slotId}:${positionIndex}`) || null
    : null;
  return {
    position_index: typeof positionIndex === "number" ? positionIndex : null,
    position_filled_via:
      positionFilledVia === "curated_match" || positionFilledVia === "ai_backfill"
        ? positionFilledVia
        : null,
    position_label: criteria?.display_label || null,
    position_criteria: criteria
      ? (() => {
          const { display_label, ...rest } = criteria;
          void display_label;
          return rest;
        })()
      : null,
  };
}

// Column definitions
const COLUMNS = [
  {
    key: "rejected",
    label: "REJECTED",
    headerTone:
      "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  },
  {
    key: "proposed",
    label: "AI PROPOSED",
    headerTone:
      "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  },
  {
    key: "approved",
    label: "HUMAN APPROVED",
    headerTone:
      "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300",
  },
];

// human_action enum mapping based on (fromColumn -> toColumn)
// Burst 4 J1: monotonic client-side sequence counter to disambiguate the
// server-side ordering of two override events POSTed within milliseconds of
// each other. Network jitter can flip arrival order from emit order; the
// sequence number resolves it. Module-level state is fine — same browser
// tab, same reviewer session, monotonic for the lifetime of the page load.
let _clientSeq = 0;
function nextClientSequence() {
  return ++_clientSeq;
}

/**
 * Wave 10.1 (W10.1) — humanise a canonical camera_source slug into a user-
 * friendly label for the secondary-camera banner. Pure function, no DB lookup.
 * Falls back gracefully on unknown prefixes so a fleet expansion doesn't
 * require a code change before the banner reads correctly.
 *
 * Bootstrap mapping (ordered — first match wins):
 *   canon-eos-r5:*       → "Canon EOS R5"
 *   canon-eos-r6m2:*     → "Canon EOS R6 Mark II"
 *   canon-eos-r6:*       → "Canon EOS R6"
 *   apple:iphone-* / iphone-* → "iPhone <model>" with title-cased rest
 *   any other            → derive from prefix before ":"
 */
function humaniseCameraSource(slug) {
  if (!slug || typeof slug !== "string") return "Unknown camera";
  // Drop the serial portion for display — operators don't care which body
  // it was, just which model.
  const modelPart = slug.split(":")[0] || slug;

  // Order matters: r6m2 BEFORE r6 so the more specific prefix wins.
  if (modelPart.startsWith("canon-eos-r5")) return "Canon EOS R5";
  if (modelPart.startsWith("canon-eos-r6m2")) return "Canon EOS R6 Mark II";
  if (modelPart.startsWith("canon-eos-r6")) return "Canon EOS R6";
  if (modelPart.startsWith("iphone-") || modelPart.startsWith("apple-iphone-")) {
    const rest = modelPart.replace(/^apple-/, "").replace(/^iphone-/, "");
    if (!rest) return "iPhone";
    // "14-pro" → "14 Pro"
    const titled = rest
      .split("-")
      .map((tok) =>
        tok.length === 0 ? "" : tok[0].toUpperCase() + tok.slice(1),
      )
      .join(" ");
    return `iPhone ${titled}`.trim();
  }
  // Fallback: title-case the first hyphen-separated word and call it good.
  const head = modelPart.split("-")[0] || modelPart;
  return head ? head[0].toUpperCase() + head.slice(1) : "Unknown camera";
}

/**
 * W11.6.1 — comparator factory for the swimlane toolbar's sort dropdown.
 *
 * Operates on decorated composition rows of the shape:
 *   { id, group_index, slot: { slot_id, phase } | null,
 *     classification: { combined_score, ... } | null,
 *     primary_file_stem | rep_filename | ... }
 *
 * Falls back to group_index → id whenever the primary key is missing so the
 * sort is total (no React reconciliation churn from unstable orderings).
 */
function buildSwimlaneComparator(sortKey) {
  const tieBreak = (a, b) => {
    const gi = (a.group_index ?? 0) - (b.group_index ?? 0);
    if (gi !== 0) return gi;
    return String(a.id || "").localeCompare(String(b.id || ""));
  };
  switch (sortKey) {
    case "filename": {
      return (a, b) => {
        const an = (a.primary_file_stem || a.rep_filename || a.id || "").toLowerCase();
        const bn = (b.primary_file_stem || b.rep_filename || b.id || "").toLowerCase();
        const c = an.localeCompare(bn);
        return c !== 0 ? c : tieBreak(a, b);
      };
    }
    case "combined_score": {
      // Descending — highest score first.
      return (a, b) => {
        const as = a.classification?.combined_score ?? -Infinity;
        const bs = b.classification?.combined_score ?? -Infinity;
        if (bs !== as) return bs - as;
        return tieBreak(a, b);
      };
    }
    case "group_index": {
      return (a, b) => tieBreak(a, b);
    }
    case "slot_importance":
    default: {
      // Phase asc → canonical-slot order → score desc → group_index/id.
      return (a, b) => {
        const ap = a.slot?.phase ?? 9;
        const bp = b.slot?.phase ?? 9;
        if (ap !== bp) return ap - bp;
        const ai = slotImportanceKey(a.slot?.slot_id);
        const bi = slotImportanceKey(b.slot?.slot_id);
        if (ai !== bi) return ai - bi;
        const as = a.classification?.combined_score ?? -Infinity;
        const bs = b.classification?.combined_score ?? -Infinity;
        if (bs !== as) return bs - as;
        return tieBreak(a, b);
      };
    }
  }
}

function deriveHumanAction(fromColumn, toColumn) {
  if (fromColumn === toColumn) return null;
  if (fromColumn === "proposed" && toColumn === "approved")
    return "approved_as_proposed";
  if (fromColumn === "proposed" && toColumn === "rejected") return "removed";
  if (fromColumn === "rejected" && toColumn === "approved")
    return "added_from_rejects";
  if (fromColumn === "approved" && toColumn === "rejected") return "removed";
  // 2026-05-04: returning to PROPOSED is now an affirmative undo of the
  // operator's prior approve/reject — emits 'reverted_to_ai_proposed'
  // which the fold treats as "card sits in proposed" AND the AI training
  // pipeline treats as a NEUTRAL signal (operator agreed with the AI
  // after exploring alternatives — distinct from 'removed' which IS a
  // negative signal).  Without this action, dragging back to PROPOSED
  // appeared to do nothing because the prior approve_as_proposed row
  // was still in the DB and re-asserted "card is approved" on refetch.
  if (fromColumn === "approved" && toColumn === "proposed")
    return "reverted_to_ai_proposed";
  if (fromColumn === "rejected" && toColumn === "proposed")
    return "reverted_to_ai_proposed";
  return null;
}

export default function ShortlistingSwimlane({
  roundId,
  round,
  projectId,
  project,
}) {
  const queryClient = useQueryClient();

  // W11.6.1 — operator UX state (sort / filter / preview-size / group / timer).
  // The auth user drives the per-user persistence keys. While auth is still
  // bootstrapping, `userId` is undefined and the hook falls back to defaults
  // — once auth lands, a re-render reads the persisted choice from
  // localStorage. Keys are intentionally per-user so two operators sharing a
  // browser don't stomp on each other's preferences.
  const { user } = useAuth();
  const userId = user?.id;
  const {
    sort,
    setSort,
    previewSize,
    setPreviewSize,
    groupBySlot,
    setGroupBySlot,
    filter,
    setFilter,
    searchQuery, // W11.6.16
    setSearchQuery, // W11.6.16
  } = useSwimlaneSettings({ userId, roundId });

  // Track when the reviewer landed on this page so we can compute review_duration_seconds.
  // Phase 7 follow-up: reset on round switch — if the parent reuses a single
  // component instance (no key change) across rounds, the timer would otherwise
  // measure cumulative dwell time across rounds, which corrupts the override
  // telemetry that Phase 8's learning loop will consume.
  //
  // Wave 10.3 P1-16: this page-level ref now serves as the FALLBACK for the
  // per-card IntersectionObserver timer below. When a card never enters the
  // viewport (rare — e.g. user drags from a search-filtered list, or when the
  // browser lacks IntersectionObserver), we fall back to the page-level
  // timestamp. The primary signal is the per-row dwell time.
  const reviewStartRef = useRef(Date.now());
  useEffect(() => {
    reviewStartRef.current = Date.now();
  }, [roundId]);

  // Wave 10.3 P1-16 — per-card review timer. Map keyed by composition_group
  // id; the IntersectionObserver below records the timestamp of first
  // viewport entry, and onDragEnd / handleSwapAlternative subtract that to
  // get the actual time-on-row. Reset on round switch so the timer doesn't
  // carry stale entries across rounds.
  const reviewStartByGroupIdRef = useRef(new Map());
  useEffect(() => {
    reviewStartByGroupIdRef.current = new Map();
  }, [roundId]);

  // Single shared IntersectionObserver — ~150 cards is well within the
  // observer's perf budget. Each ShortlistingCard registers/unregisters its
  // outer ref via the registerCardObserver callback. When a card crosses
  // the 50% visibility threshold and we don't yet have a start time, we
  // record `now` for that group_id. The first crossing wins; subsequent
  // crossings are no-ops (the editor's review session for the row started
  // when the card first appeared, not on each rescroll).
  const cardObserverRef = useRef(null);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    if (!("IntersectionObserver" in window)) return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const groupId = entry.target.getAttribute("data-group-id");
          if (!groupId) continue;
          const map = reviewStartByGroupIdRef.current;
          if (!map.has(groupId)) map.set(groupId, Date.now());
        }
      },
      { threshold: 0.5, rootMargin: "0px" },
    );
    cardObserverRef.current = observer;
    return () => {
      observer.disconnect();
      cardObserverRef.current = null;
    };
  }, [roundId]);

  // Stable callback the cards call to register themselves with the observer.
  // Returns a teardown function (unobserve) that the card uses on unmount.
  const registerCardObserver = useCallback((node) => {
    const observer = cardObserverRef.current;
    if (!observer || !node) return () => {};
    observer.observe(node);
    return () => {
      try {
        observer.unobserve(node);
      } catch {
        // Observer may have already disconnected on round switch — ignore.
      }
    };
  }, []);

  // Compute per-row review duration. Falls back to the page-level timer if
  // the card never entered the viewport (e.g. dragged from off-screen via
  // a hotkey, or browser lacks IntersectionObserver).
  const computeReviewDurationSeconds = useCallback((groupId) => {
    if (groupId) {
      const startMs = reviewStartByGroupIdRef.current.get(groupId);
      if (typeof startMs === "number") {
        return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      }
    }
    return Math.max(
      0,
      Math.floor((Date.now() - reviewStartRef.current) / 1000),
    );
  }, []);

  // Wave 10.3 P1-16 — drawer-state tracking. Set of slot_ids the editor has
  // opened the alternatives drawer for during this review session. We use a
  // ref (not state) because:
  //   1. Reads happen in the drag/swap handlers, not in render — so no
  //      re-render is needed when the set updates.
  //   2. The override payload reads `seenAltsBySlotId.has(slotId)` directly
  //      at drag-end; using state would risk a stale closure.
  // Reset on round switch so a stale "seen" set from round N doesn't taint
  // round N+1.
  const seenAltsBySlotIdRef = useRef(new Set());
  useEffect(() => {
    seenAltsBySlotIdRef.current = new Set();
  }, [roundId]);

  const handleAltsDrawerOpen = useCallback((slotId) => {
    if (!slotId) return;
    seenAltsBySlotIdRef.current.add(slotId);
  }, []);

  // Wave 10.3 P1-16 — SignalAttributionModal state. Shown after `removed`
  // and `swapped` overrides; the override row was already inserted, the
  // modal collects the primary_signal_overridden value and patches it via
  // shortlisting-overrides.annotate. Non-blocking: dismissal leaves the
  // signal NULL.
  const [signalModalState, setSignalModalState] = useState({
    open: false,
    overrideId: null,
    actionLabel: null,
  });

  // W11.6.20 swimlane-lightbox: track which bucket + which index is open.
  // Bucket key is one of "rejected" | "proposed" | "approved"; null means
  // closed. The lightbox itself reads `columnItems[bucketKey]` and uses
  // `index` as the initial position; ←/→ nav within the bucket happens
  // inside the lightbox component, so we don't need to plumb prev/next
  // handlers from here. We DO want to refresh `index` on open so the
  // initial card matches what the operator clicked.
  const [lightboxState, setLightboxState] = useState({
    bucket: null,
    index: 0,
    // 2026-05-04: grid-view lightbox cycles within a single room across
    // all three buckets (rejected → proposed → approved order).  The
    // grid passes an ordered list of group_ids; lightboxItemsMemo
    // enriches them using the same pipeline as the bucket path.
    orderedGroupIds: null,
    bucketLabel: null,
  });
  const closeLightbox = useCallback(() => {
    setLightboxState((prev) => ({
      ...prev,
      bucket: null,
      orderedGroupIds: null,
    }));
  }, []);
  const openLightbox = useCallback((bucket, index) => {
    setLightboxState({
      bucket,
      index,
      orderedGroupIds: null,
      bucketLabel: null,
    });
  }, []);
  // Grid-mode entrypoint: opens the lightbox over a custom ordered
  // list of group_ids (typically a room's cards in [rejected, proposed,
  // approved] order so prev/next compares alternatives WITHIN the room).
  const openLightboxOrdered = useCallback((orderedGroupIds, index, bucketLabel) => {
    setLightboxState({
      bucket: null,
      index,
      orderedGroupIds,
      bucketLabel: bucketLabel || null,
    });
  }, []);

  // QC-iter2-W7 F-C-011: lightboxItemsMemo originally lived here but
  // referenced `columnItems` in its dep array, which is declared ~550 lines
  // later in the same component scope. ESM `const` is in TDZ until the
  // declaration line executes, so reading it from this earlier hook (under
  // minification: `[P.bucket, te]` where `te === columnItems`) threw
  // "Cannot access 'te' before initialization" on every render whenever the
  // swimlane mounted with rounds present. Empty-round projects never hit it
  // because ProjectShortlistingTab does not mount the swimlane at all in the
  // empty-state branch. Moved the memo definition to immediately AFTER
  // columnItems below (search "F-C-011 (relocated)"). This block intentionally
  // left as a marker for future refactors so we don't recreate the cycle.

  const closeSignalModal = useCallback(() => {
    setSignalModalState((prev) => ({ ...prev, open: false }));
  }, []);

  const submitSignalAttribution = useCallback(
    async (signalValue) => {
      const overrideId = signalModalState.overrideId;
      if (!overrideId) return;
      try {
        const resp = await api.functions.invoke("shortlisting-overrides", {
          annotate: {
            override_id: overrideId,
            primary_signal_overridden: signalValue,
          },
        });
        const result = resp?.data ?? resp ?? {};
        if (result?.ok === false) {
          throw new Error(result?.error || "Annotate failed");
        }
        // Refresh so the analytics page (and any in-flight queries) see the
        // patched signal. Non-fatal if it fails — the modal already closed.
        await queryClient.invalidateQueries({
          queryKey: ["shortlisting_overrides", roundId],
        });
        toast.success("Signal recorded");
      } catch (err) {
        console.error("[ShortlistingSwimlane] annotate failed:", err);
        toast.error(err?.message || "Could not save signal");
      }
    },
    [signalModalState.overrideId, queryClient, roundId],
  );

  // ── Data fetches ────────────────────────────────────────────────────────
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
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const classificationsQuery = useQuery({
    queryKey: ["composition_classifications", roundId],
    queryFn: async () => {
      const rows = await api.entities.CompositionClassification.filter(
        { round_id: roundId },
        null,
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  const slotEventsQuery = useQuery({
    queryKey: ["shortlisting_events_slots", roundId],
    queryFn: async () => {
      const rows = await api.entities.ShortlistingEvent.filter(
        {
          round_id: roundId,
          event_type: { $in: ["pass2_slot_assigned", "pass2_phase3_recommendation"] },
        },
        "created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

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
    enabled: Boolean(roundId),
    staleTime: 15_000,
  });

  // Load the operator-editable editorial policy so the grid view can
  // sort hero rooms first (kitchen, master_bedroom, etc).  Stale-time
  // is generous since the policy rarely changes mid-session.
  const policyQuery = useQuery({
    queryKey: ["shortlisting_engine_policy_for_swimlane"],
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_engine_policy")
        .select("policy")
        .eq("id", 1)
        .maybeSingle();
      if (error) throw error;
      return data?.policy || null;
    },
  });
  const heroRoomsOrder = useMemo(
    () =>
      Array.isArray(policyQuery.data?.common_residential_rooms)
        ? policyQuery.data.common_residential_rooms
        : [],
    [policyQuery.data],
  );

  // Mig 453+454 — load shortlisting_space_instances for the round so the
  // lightbox detail panel + grid view can render human-readable instance
  // labels (display_label, instance_index, distinctive_features) instead
  // of bare UUIDs.  Empty for legacy rounds that haven't run
  // detect_instances; the lightbox falls back to the raw id in that case.
  const spaceInstancesQuery = useQuery({
    queryKey: ["shortlisting_space_instances", roundId],
    enabled: Boolean(roundId),
    staleTime: 15_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shortlisting_space_instances")
        .select(
          "id, space_type, instance_index, display_label, display_label_source, distinctive_features, member_group_count, cluster_confidence, representative_group_id",
        )
        .eq("round_id", roundId);
      if (error) throw error;
      return Array.isArray(data) ? data : [];
    },
  });

  // W11.6.22c — position-criteria fetch. Pulls
  // shortlisting_slot_position_preferences for every slot referenced by this
  // round's overrides (post-W11.6.22b position-aware decisions). The lightbox's
  // Position panel reads slot.position_criteria to render the curated label /
  // composition / zone / lighting / signal-emphasis list. We fetch lazily —
  // only after the overrides query has resolved — so a round with zero
  // curated_positions slots makes ZERO requests (the in-clause is empty).
  // Keyed on the sorted slot_ids so a re-render with the same set hits the
  // cache, but a slot getting added (e.g. operator picks an alt) re-fetches.
  const slotIdsForPositionPrefs = useMemo(
    () => extractSlotIdsForPositionPrefs(overridesQuery.data || []),
    [overridesQuery.data],
  );

  const positionPrefsQuery = useQuery({
    queryKey: [
      "shortlisting_slot_position_preferences",
      roundId,
      slotIdsForPositionPrefs.join("|"),
    ],
    queryFn: async () => {
      if (slotIdsForPositionPrefs.length === 0) return [];
      const rows = await api.entities.ShortlistingSlotPositionPreference.filter(
        { slot_id: { $in: slotIdsForPositionPrefs } },
        "position_index",
        2000,
      );
      return rows || [];
    },
    // Fire only once we know which slot_ids are in play. Round still loads
    // even if this query never runs (no curated_positions slots → empty set).
    enabled: Boolean(roundId) && slotIdsForPositionPrefs.length > 0,
    staleTime: 60_000,
  });

  const isLoading =
    groupsQuery.isLoading ||
    classificationsQuery.isLoading ||
    slotEventsQuery.isLoading ||
    overridesQuery.isLoading;
  const queryError =
    groupsQuery.error ||
    classificationsQuery.error ||
    slotEventsQuery.error ||
    overridesQuery.error;

  const groups = groupsQuery.data || [];
  const classifications = classificationsQuery.data || [];
  const slotEvents = slotEventsQuery.data || [];
  const overrides = overridesQuery.data || [];
  const positionPrefs = positionPrefsQuery.data || [];

  // W11.6.22c — (slot_id, position_index) → criteria lookup. Built once per
  // positionPrefs change. Empty Map when the round has no curated_positions
  // slots (graceful: lightbox falls back to showing just position_index +
  // filled_via without criteria — the W11.6.22b panel handles that branch).
  const positionCriteriaMap = useMemo(
    () => buildPositionCriteriaMap(positionPrefs),
    [positionPrefs],
  );

  // ── Build columns from data ─────────────────────────────────────────────
  // Per-group classification lookup
  const classByGroupId = useMemo(() => {
    const m = new Map();
    for (const c of classifications) m.set(c.group_id, c);
    return m;
  }, [classifications]);

  // Per-group slot info: { slot_id, phase, rank, position_index?,
  // position_filled_via?, position_label?, position_criteria? }.
  //
  // W11.6.1-hotfix-2 BUG #2: Shape D rounds don't emit pass2_slot_assigned
  // events — the canonical (slot_id, group_id) pairs live on
  // shortlisting_overrides ai_proposed rows. Pre-Shape-D rounds wrote pass2
  // events. We read BOTH so legacy + Shape D rounds populate the same map
  // shape, and the AI PROPOSED column header / sub-grouping renders the
  // correct slot label instead of "Unassigned".
  //
  // W11.6.22c: pull position_index + position_filled_via from override rows
  // (curated_positions slots) AND attach the matching criteria from the
  // positionCriteriaMap so the lightbox's Position panel can render the
  // curated label / composition / zone / lighting / signal-emphasis list
  // without a separate plumbing step at the lightbox boundary.
  //
  // Resolution priority (most recent wins on hybrid rounds):
  //   1. shortlisting_overrides.ai_proposed (Shape D primary)
  //   2. shortlisting_overrides.swapped/added_from_rejects/approved_as_proposed
  //      — re-binds slot to the human-picked group via human_selected_*
  //   3. shortlisting_events pass2_slot_assigned rank=1 (legacy)
  //   4. shortlisting_events pass2_phase3_recommendation (legacy)
  const slotByGroupId = useMemo(() => {
    const m = new Map();

    // PASS 1 — Shape D ai_proposed rows (PRIMARY for Shape D rounds).
    for (const ov of overrides) {
      if (ov.human_action !== "ai_proposed") continue;
      const groupId = ov.ai_proposed_group_id;
      const slotId = ov.ai_proposed_slot_id;
      if (!groupId || !slotId) continue;
      if (m.has(groupId)) continue;

      // Mig 465 — parse the editorial envelope stashed on
      // ai_proposed_analysis when the round ran on the editorial engine.
      // The string is a JSON object with shape { editorial: { ... } } or
      // a plain prose rationale on legacy rounds.  We try JSON first and
      // fall back to treating the value as the rationale text.
      let editorial = null;
      let analysisText = null;
      const rawAnalysis = ov.ai_proposed_analysis;
      if (typeof rawAnalysis === "string" && rawAnalysis.length > 0) {
        try {
          const parsed = JSON.parse(rawAnalysis);
          if (parsed && typeof parsed === "object" && parsed.editorial) {
            editorial = parsed.editorial;
            analysisText = parsed.editorial.rationale || null;
          } else {
            analysisText = rawAnalysis;
          }
        } catch {
          analysisText = rawAnalysis;
        }
      }

      m.set(groupId, {
        slot_id: slotId,
        phase: PHASE_OF_SLOT[slotId] ?? null,
        rank: 1,
        ai_proposed_score: typeof ov.ai_proposed_score === "number" ? ov.ai_proposed_score : null,
        slot_fit_score: typeof ov.slot_fit_score === "number" ? ov.slot_fit_score : null,
        rationale: analysisText,
        editorial,
        ...resolvePositionFields(
          positionCriteriaMap,
          slotId,
          ov.position_index ?? null,
          ov.position_filled_via ?? null,
        ),
      });
    }

    // PASS 2 — Shape D operator override actions.
    for (const ov of overrides) {
      if (
        ov.human_action !== "swapped" &&
        ov.human_action !== "added_from_rejects" &&
        ov.human_action !== "approved_as_proposed"
      ) {
        continue;
      }
      const slotId = ov.human_selected_slot_id ?? ov.ai_proposed_slot_id;
      const groupId = ov.human_selected_group_id ?? ov.ai_proposed_group_id;
      if (!groupId || !slotId) continue;
      if (m.has(groupId)) continue;
      m.set(groupId, {
        slot_id: slotId,
        phase: PHASE_OF_SLOT[slotId] ?? null,
        rank: 1,
        ...resolvePositionFields(
          positionCriteriaMap,
          slotId,
          ov.position_index ?? null,
          ov.position_filled_via ?? null,
        ),
      });
    }

    // PASS 3 — legacy pass2 events (pre-Shape-D fallback).
    for (const ev of slotEvents) {
      if (!ev.group_id) continue;
      const p = ev.payload || {};
      if (ev.event_type === "pass2_phase3_recommendation") {
        if (!m.has(ev.group_id)) {
          m.set(ev.group_id, {
            slot_id: p.slot_id || "ai_recommended",
            phase: 3,
            rank: p.rank || 1,
          });
        }
      } else if (ev.event_type === "pass2_slot_assigned") {
        const rank = p.rank;
        // Only the rank=1 winner determines the group's primary slot.
        if (rank === 1 && !m.has(ev.group_id)) {
          m.set(ev.group_id, {
            slot_id: p.slot_id,
            phase: p.phase,
            rank: 1,
          });
        }
      }
    }
    return m;
  }, [overrides, slotEvents, positionCriteriaMap]);

  // Alternatives map: slot_id -> [{ group_id, stem, combined_score, room_type, analysis }]
  // From pass2_slot_assigned events with rank in (2, 3).
  const altsBySlotId = useMemo(() => {
    const m = new Map();
    for (const ev of slotEvents) {
      if (ev.event_type !== "pass2_slot_assigned") continue;
      const p = ev.payload || {};
      const rank = p.rank;
      if (rank == null || rank === 1) continue;
      const slotId = p.slot_id;
      if (!slotId) continue;
      if (!m.has(slotId)) m.set(slotId, []);
      const cls = classByGroupId.get(ev.group_id);
      m.get(slotId).push({
        group_id: ev.group_id,
        stem: p.stem,
        rank,
        combined_score: cls?.combined_score ?? null,
        analysis: cls?.analysis ?? null,
      });
    }
    // Sort by rank (2 before 3)
    for (const arr of m.values()) {
      arr.sort((a, b) => (a.rank || 99) - (b.rank || 99));
    }
    return m;
  }, [slotEvents, classByGroupId]);

  // Wave 10.1 (W10.1) — secondary-camera bucket summary for the banner.
  // Counts files (not groups) per source so the operator sees "12 iPhone
  // images" rather than "12 iPhone groups" — same number for singletons but
  // clearer phrasing.
  const secondaryBuckets = useMemo(() => {
    const m = new Map();
    for (const g of groups) {
      if (!g.is_secondary_camera) continue;
      const key = g.camera_source || "unknown";
      const fileCount = Number(g.file_count) || 1;
      m.set(key, (m.get(key) || 0) + fileCount);
    }
    return [...m.entries()].map(([source, count]) => ({ source, count }));
  }, [groups]);

  // Per-round dismissal of the banner. Persist in localStorage so refreshing
  // the page doesn't bring it back; keyed by round so dismissing in one
  // round doesn't dismiss it for another.
  const bannerDismissKey = `shortlisting:secondaryBanner:dismissed:${roundId}`;
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(bannerDismissKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    // When switching rounds, re-read the persisted state for the new round.
    if (typeof window === "undefined") return;
    try {
      setBannerDismissed(window.localStorage.getItem(bannerDismissKey) === "1");
    } catch {
      setBannerDismissed(false);
    }
  }, [bannerDismissKey]);
  const dismissBanner = useCallback(() => {
    setBannerDismissed(true);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(bannerDismissKey, "1");
    } catch {
      /* ignore quota or private-mode errors */
    }
  }, [bannerDismissKey]);

  // Initial AI shortlist set + classification-based rejection set.
  //
  // W11.6.1-hotfix-2 BUG #1+#2: pre-seed PROPOSED with Shape D ai_proposed
  // override rows. Without this seeding, every group lands in REJECTED on
  // a Shape D round (legacy slotEvents are empty), and the override-
  // application loop below re-routes them to PROPOSED. Seeding here keeps
  // the data flow honest — `initialColumns` is referenced in places that
  // don't always re-apply overrides (future analytics derivations).
  const initialColumns = useMemo(() => {
    const proposed = new Set();
    // Legacy pass2 events (pre-Shape-D rounds).
    for (const ev of slotEvents) {
      if (!ev.group_id) continue;
      if (ev.event_type === "pass2_phase3_recommendation") {
        proposed.add(ev.group_id);
      } else if (ev.event_type === "pass2_slot_assigned") {
        const rank = ev.payload?.rank;
        if (rank === 1 || rank === undefined) proposed.add(ev.group_id);
      }
    }
    // Shape D ai_proposed override rows.
    for (const ov of overrides) {
      if (ov.human_action !== "ai_proposed") continue;
      if (ov.ai_proposed_group_id) proposed.add(ov.ai_proposed_group_id);
    }
    const rejected = new Set();
    for (const g of groups) {
      if (proposed.has(g.id)) continue;
      rejected.add(g.id);
    }
    return { proposed, rejected, approved: new Set() };
  }, [slotEvents, overrides, groups]);

  // Apply overrides on top of initial assignment, in chronological order.
  // Local override state (for pending optimistic moves before server acks).
  // QC-iter2-W7 F-C-019: cap pending optimistic overrides. Each in-flight
  // override is held here until the server-side row lands and the refetch
  // replaces it. If the network is slow or the operator is unusually fast
  // (or stuck in a retry loop), the array can grow unbounded and slow the
  // computedColumns memo. Capping at 20 lets the optimistic UI keep up with
  // typical reviewer pace (one drag every few seconds) but prevents runaway.
  const PENDING_OVERRIDE_CAP = 20;
  const [pendingOverrides, setPendingOverrides] = useState([]);
  const pendingCatchingUp = pendingOverrides.length >= PENDING_OVERRIDE_CAP;

  const computedColumns = useMemo(() => {
    const proposed = new Set(initialColumns.proposed);
    const rejected = new Set(initialColumns.rejected);
    const approved = new Set();

    // Burst 12 J5: apply overrides in the SAME order the server (shortlist-
    // lock) uses, otherwise the UI and server can diverge on rapid contradict-
    // ory drags. Server orders by client_sequence ASC NULLS LAST, then
    // created_at ASC. We replicate that here. Pending (unsubmitted) overrides
    // sit AFTER server overrides — they're the latest user intent and have no
    // server timestamp yet.
    const ordered = [...overrides].slice().sort((a, b) => {
      const sa = a.client_sequence;
      const sb = b.client_sequence;
      // Both have client_sequence → numeric compare.
      if (sa != null && sb != null) return sa - sb;
      // One is null → null sorts LAST (matches Postgres NULLS LAST behaviour).
      if (sa == null && sb != null) return 1;
      if (sa != null && sb == null) return -1;
      // Both null → fall back to created_at.
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return ta - tb;
    });
    const allOverrides = [...ordered, ...pendingOverrides];
    for (const ov of allOverrides) {
      const aiId = ov.ai_proposed_group_id;
      const humanId = ov.human_selected_group_id;
      switch (ov.human_action) {
        case "ai_proposed":
          // 2026-05-04 BUG FIX — these rows are seed data (Stage 4
          // writes one per slot pick) and are ALREADY accounted for by
          // initialColumns above.  Re-applying them here was the bug
          // that made operator drags appear to revert: ai_proposed rows
          // have client_sequence=null (NULLS LAST in the sort), so they
          // got applied AFTER all operator overrides and re-asserted
          // "card belongs in proposed", clobbering approved/rejected
          // moves the operator just made.  Skip them — they're seed
          // state, not operator actions.
          break;
        case "reverted_to_ai_proposed":
          // 2026-05-04: operator dragged a card BACK to PROPOSED after
          // a prior approve/reject — explicitly undoing their decision.
          // The card returns to its seed state; AI training treats this
          // as neutral (distinct from 'removed' which IS negative).
          // We re-assert "card is in proposed" by removing it from
          // approved/rejected and adding it to proposed.  The aiId is
          // the original Stage 4 group_id for this card; humanId is
          // null because the operator isn't picking a different image
          // — they're just undoing.
          if (aiId) {
            rejected.delete(aiId);
            approved.delete(aiId);
            proposed.add(aiId);
          }
          break;
        case "approved_as_proposed":
          if (aiId) {
            proposed.delete(aiId);
            rejected.delete(aiId);
            approved.add(aiId);
          }
          break;
        case "added_from_rejects":
          if (humanId) {
            rejected.delete(humanId);
            proposed.delete(humanId);
            approved.add(humanId);
          }
          break;
        case "removed":
          if (aiId) {
            proposed.delete(aiId);
            approved.delete(aiId);
            rejected.add(aiId);
          }
          break;
        case "swapped":
          if (aiId) {
            approved.delete(aiId);
            proposed.delete(aiId);
            rejected.add(aiId);
          }
          if (humanId) {
            rejected.delete(humanId);
            proposed.delete(humanId);
            approved.add(humanId);
          }
          break;
      }
    }
    return { proposed, rejected, approved };
  }, [initialColumns, overrides, pendingOverrides]);

  // W11.6.1 — distinct slot_ids and room_types for the toolbar's filter
  // dropdown. We expose only values that actually appear in this round so
  // the operator never picks a filter that yields zero cards.
  const availableSlotIds = useMemo(() => {
    const set = new Set();
    for (const slotInfo of slotByGroupId.values()) {
      if (slotInfo?.slot_id) set.add(slotInfo.slot_id);
    }
    return [...set].sort((a, b) => slotImportanceKey(a) - slotImportanceKey(b));
  }, [slotByGroupId]);

  // mig 439: derive the filter taxonomy as `space_type ?? room_type`. The
  // engine emits both since W11.6.13 (space_type/zone_focus is the orthogonal
  // canonical pair); room_type stays as a denormalised filter handle for
  // legacy rows. The first non-null wins so newer rows show under their
  // canonical space_type label.
  const availableRoomTypes = useMemo(() => {
    const set = new Set();
    for (const c of classifications) {
      const display = c?.space_type ?? c?.room_type;
      if (display) set.add(display);
    }
    return [...set].sort();
  }, [classifications]);

  // W11.6.16 — distinct iter-5 filter values present on this round, so the
  // toolbar's filter dropdown only shows axes that yield at least one card
  // (matches the existing pattern for slot/room).
  const availableShotIntents = useMemo(() => {
    const set = new Set();
    for (const c of classifications) {
      if (c?.shot_intent) set.add(c.shot_intent);
    }
    return [...set].sort();
  }, [classifications]);
  const availableAppealSignals = useMemo(() => {
    const set = new Set();
    for (const c of classifications) {
      if (Array.isArray(c?.appeal_signals)) {
        for (const v of c.appeal_signals) if (v) set.add(v);
      }
    }
    return [...set].sort();
  }, [classifications]);
  const availableConcernSignals = useMemo(() => {
    const set = new Set();
    for (const c of classifications) {
      if (Array.isArray(c?.concern_signals)) {
        for (const v of c.concern_signals) if (v) set.add(v);
      }
    }
    return [...set].sort();
  }, [classifications]);

  // W11.6.1 — sub-feature 4 input. Set of slot_ids actively counted as
  // filled (cards in PROPOSED + APPROVED columns). Phase 3 sentinel is
  // counted via the SwimlaneSlotCounter component itself.
  const proposedSlotIds = useMemo(() => {
    const s = new Set();
    for (const groupId of computedColumns.proposed) {
      const slotInfo = slotByGroupId.get(groupId);
      if (slotInfo?.slot_id) s.add(slotInfo.slot_id);
    }
    for (const groupId of computedColumns.approved) {
      const slotInfo = slotByGroupId.get(groupId);
      if (slotInfo?.slot_id) s.add(slotInfo.slot_id);
    }
    return s;
  }, [computedColumns, slotByGroupId]);

  // Build column-keyed arrays of composition objects, decorated for the card.
  // W11.6.1 — sort + filter applied here so all three columns reflect the
  // toolbar state. Filtering hides cards (they remain in DB / overrides) but
  // do NOT show in the rendered columns; counters in the column headers
  // show post-filter counts so the operator sees "1/12 visible" semantics
  // implicitly.
  const columnItems = useMemo(() => {
    const out = { rejected: [], proposed: [], approved: [] };
    const slotFilterActive = filter.slotIds.size > 0;
    const roomFilterActive = filter.roomTypes.size > 0;
    // W11.6.16 — iter-5 filter axes. Each is independent and AND-combined
    // with the existing slot/room filters; within an axis (e.g. appeal_signals)
    // we use any-of (Set.intersection) for the marketing-signal taxonomy.
    const intentSet = filter.shotIntents instanceof Set ? filter.shotIntents : new Set();
    const appealSet = filter.appealSignals instanceof Set ? filter.appealSignals : new Set();
    const concernSet = filter.concernSignals instanceof Set ? filter.concernSignals : new Set();
    const intentFilterActive = intentSet.size > 0;
    const appealFilterActive = appealSet.size > 0;
    const concernFilterActive = concernSet.size > 0;
    const requiresHumanReviewFilterActive = filter.requiresHumanReview === true;
    // Free-text search — case-insensitive substring match against
    // embedding_anchor_text + searchable_keywords (joined). Empty string =
    // disabled. Trim+lowercase so "  Federation  " matches "federation".
    const queryNorm = typeof searchQuery === "string" ? searchQuery.trim().toLowerCase() : "";
    const searchActive = queryNorm.length > 0;
    for (const g of groups) {
      const cls = classByGroupId.get(g.id) || null;
      const slotInfo = slotByGroupId.get(g.id) || null;
      // Filter — applied BEFORE column dispatch so all 3 columns share the
      // same visibility rule. A card with no slot can never satisfy a slot
      // filter (treated as "doesn't match").
      if (slotFilterActive) {
        if (!slotInfo?.slot_id || !filter.slotIds.has(slotInfo.slot_id)) {
          continue;
        }
      }
      if (roomFilterActive) {
        // mig 439: filter against `space_type ?? room_type` to mirror the
        // availableRoomTypes derivation above.
        const displayRoomType = cls?.space_type ?? cls?.room_type;
        if (!displayRoomType || !filter.roomTypes.has(displayRoomType)) {
          continue;
        }
      }
      // W11.6.16 — iter-5 filters
      if (intentFilterActive) {
        if (!cls?.shot_intent || !intentSet.has(cls.shot_intent)) {
          continue;
        }
      }
      if (appealFilterActive) {
        const a = Array.isArray(cls?.appeal_signals) ? cls.appeal_signals : [];
        if (!a.some((v) => appealSet.has(v))) continue;
      }
      if (concernFilterActive) {
        const c = Array.isArray(cls?.concern_signals) ? cls.concern_signals : [];
        if (!c.some((v) => concernSet.has(v))) continue;
      }
      if (requiresHumanReviewFilterActive) {
        if (cls?.requires_human_review !== true) continue;
      }
      if (searchActive) {
        // Match against embedding_anchor_text + searchable_keywords[]
        // (joined into one searchable haystack, lowercased once per card).
        const anchor = typeof cls?.embedding_anchor_text === "string"
          ? cls.embedding_anchor_text.toLowerCase()
          : "";
        const keywords = Array.isArray(cls?.searchable_keywords)
          ? cls.searchable_keywords.join(" ").toLowerCase()
          : "";
        if (!anchor.includes(queryNorm) && !keywords.includes(queryNorm)) {
          continue;
        }
      }
      const decorated = {
        ...g,
        classification: cls,
        slot: slotInfo,
      };
      if (computedColumns.approved.has(g.id)) out.approved.push(decorated);
      else if (computedColumns.proposed.has(g.id)) out.proposed.push(decorated);
      else out.rejected.push(decorated);
    }
    // Comparator factory — same comparator drives all three columns so a
    // dragged card lands in the column at a stable position.
    const cmp = buildSwimlaneComparator(sort);
    out.proposed.sort(cmp);
    out.approved.sort(cmp);
    // REJECTED retains its group_index ordering by default — operators scan
    // it sequentially and the group_index is the natural shoot order. Only
    // explicit non-default sorts override it.
    if (sort === "slot_importance") {
      out.rejected.sort((a, b) => (a.group_index ?? 0) - (b.group_index ?? 0));
    } else {
      out.rejected.sort(cmp);
    }
    return out;
  }, [groups, classByGroupId, slotByGroupId, computedColumns, sort, filter, searchQuery]);

  // QC-iter2-W7 F-C-011 (relocated): hoist the lightboxItems mapping into a
  // memo keyed on the active bucket. Previously the mapping ran inside an
  // IIFE on every swimlane render even when the lightbox was closed (the
  // IIFE was guarded but its captured closure re-allocated bucketItems.map(...)
  // on each re-render once open). Memo eliminates the re-allocation churn.
  // MUST live AFTER `columnItems` is declared above — this hook reads it from
  // the dep array and ESM `const` is in TDZ until the declaration line runs.
  // Build a lookup map of space_instance rows keyed by id so the lightbox
  // can render human-readable instance labels without an extra fetch.
  const spaceInstancesById = useMemo(() => {
    const m = {};
    for (const row of spaceInstancesQuery.data || []) {
      if (row?.id) m[row.id] = row;
    }
    return m;
  }, [spaceInstancesQuery.data]);

  const lightboxItemsMemo = useMemo(() => {
    // Helper: enrich a column-items row into the lightbox shape.
    // Hoisted so both the bucket path AND the ordered-list path
    // (grid-view room cycling) emit the same enriched shape.
    const enrich = (it) => ({
      id: it.id,
      dropbox_path: it.dropbox_preview_path,
      filename:
        it.delivery_reference_stem ||
        it.best_bracket_stem ||
        it.rep_filename ||
        it.id,
      observed_objects: Array.isArray(it.classification?.observed_objects)
        ? it.classification.observed_objects
        : [],
      signal_scores: it.classification?.signal_scores || null,
      slot_decision: it.slot || null,
      voice_tier: it.classification?.voice_tier || null,
      master_listing: it.classification?.master_listing || null,
      classification: it.classification || null,
      editorial_envelope: it.slot?.editorial || null,
      group_metadata: {
        group_index: it.group_index ?? null,
        file_count: it.file_count ?? null,
        files_in_group: it.files_in_group ?? null,
        best_bracket_stem: it.best_bracket_stem ?? null,
        delivery_reference_stem: it.delivery_reference_stem ?? null,
        selected_bracket_luminance: it.selected_bracket_luminance ?? null,
        all_bracket_luminances: it.all_bracket_luminances ?? null,
        is_micro_adjustment_split: it.is_micro_adjustment_split ?? null,
        camera_source: it.camera_source ?? null,
        is_secondary_camera: it.is_secondary_camera ?? null,
        synthetic_finals_match_stem: it.synthetic_finals_match_stem ?? null,
        space_instance_id: it.space_instance_id ?? null,
        space_instance_confidence: it.space_instance_confidence ?? null,
      },
      space_instances_by_id: spaceInstancesById,
    });

    // 2026-05-04 — grid-view ordered-list path.  The grid passes the
    // room's cards in [rejected, proposed, approved] order so prev/next
    // navigates WITHIN the room (compare alternatives for one position)
    // instead of bouncing across rooms.  The ids are looked up against
    // a flat index built from columnItems below.
    if (Array.isArray(lightboxState.orderedGroupIds) && lightboxState.orderedGroupIds.length > 0) {
      const flat = [
        ...(columnItems.rejected || []),
        ...(columnItems.proposed || []),
        ...(columnItems.approved || []),
      ];
      const byId = new Map(flat.map((it) => [it.id, it]));
      return lightboxState.orderedGroupIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map(enrich);
    }

    const bucket = lightboxState.bucket;
    if (!bucket) return null;
    const bucketItems = columnItems[bucket] || [];
    if (bucketItems.length === 0) return null;
    return bucketItems.map((it) => ({
      id: it.id,
      dropbox_path: it.dropbox_preview_path,
      filename:
        it.delivery_reference_stem ||
        it.best_bracket_stem ||
        it.rep_filename ||
        it.id,
      observed_objects: Array.isArray(it.classification?.observed_objects)
        ? it.classification.observed_objects
        : [],
      signal_scores: it.classification?.signal_scores || null,
      slot_decision: it.slot || null,
      voice_tier: it.classification?.voice_tier || null,
      master_listing: it.classification?.master_listing || null,
      classification: it.classification || null,
      // Mig 465 — surface the editorial envelope (parsed off
      // ai_proposed_analysis) and group metadata so the lightbox detail
      // panel can render every engine decision (quota_bucket, role_label,
      // editorial_score, principles_applied) + group context (file_count,
      // bracket info, camera_source, secondary-camera flag, etc.).
      editorial_envelope: it.slot?.editorial || null,
      group_metadata: {
        group_index: it.group_index ?? null,
        file_count: it.file_count ?? null,
        files_in_group: it.files_in_group ?? null,
        best_bracket_stem: it.best_bracket_stem ?? null,
        delivery_reference_stem: it.delivery_reference_stem ?? null,
        selected_bracket_luminance: it.selected_bracket_luminance ?? null,
        all_bracket_luminances: it.all_bracket_luminances ?? null,
        is_micro_adjustment_split: it.is_micro_adjustment_split ?? null,
        camera_source: it.camera_source ?? null,
        is_secondary_camera: it.is_secondary_camera ?? null,
        synthetic_finals_match_stem: it.synthetic_finals_match_stem ?? null,
        space_instance_id: it.space_instance_id ?? null,
        space_instance_confidence: it.space_instance_confidence ?? null,
      },
      // Mig 453+454: pass the space_instances index so the lightbox can
      // render human-readable instance labels (display_label,
      // instance_index, distinctive_features) instead of bare UUIDs.
      space_instances_by_id: spaceInstancesById,
    }));
  }, [
    lightboxState.bucket,
    lightboxState.orderedGroupIds,
    columnItems,
    spaceInstancesById,
  ]);

  // W11.6.1 — group-by-slot grouping for the AI PROPOSED column. Keyed by
  // slot_id; a card with no slot lands under a synthetic "no slot" bucket
  // so nothing falls off the rendered list. Order matches the canonical
  // slot importance so Phase 1 hero slots lead.
  const proposedGroupedBySlot = useMemo(() => {
    if (!groupBySlot) return null;
    const bySlot = new Map();
    for (const item of columnItems.proposed) {
      const slotId = item.slot?.slot_id || "__no_slot__";
      if (!bySlot.has(slotId)) bySlot.set(slotId, []);
      bySlot.get(slotId).push(item);
    }
    const orderedSlots = [...bySlot.keys()].sort((a, b) => {
      // Pin "no slot" bucket to the end.
      if (a === "__no_slot__" && b !== "__no_slot__") return 1;
      if (b === "__no_slot__" && a !== "__no_slot__") return -1;
      return slotImportanceKey(a) - slotImportanceKey(b);
    });
    return orderedSlots.map((slotId) => ({
      slotId,
      label:
        slotId === "__no_slot__"
          ? "Unassigned"
          : SLOT_DISPLAY_NAMES[slotId] || slotId,
      phase: slotId === "__no_slot__" ? null : PHASE_OF_SLOT[slotId] ?? null,
      items: bySlot.get(slotId),
    }));
  }, [groupBySlot, columnItems.proposed]);

  // ── Override capture ────────────────────────────────────────────────────
  // Send to shortlisting-overrides edge function. Supports batching but for
  // simplicity each drag fires its own request — typical reviewer pace is
  // one drag every few seconds.
  const sendOverride = useCallback(
    async (event) => {
      try {
        const resp = await api.functions.invoke("shortlisting-overrides", {
          events: [event],
        });
        const result = resp?.data ?? resp ?? {};
        if (result?.ok === false) {
          throw new Error(result?.error || "Override capture failed");
        }
        // Burst 12 U2: AWAIT the refetch so the caller can clear its pending
        // entry only AFTER the server-side row is in cache. Without await, we
        // had a gap between "pending removed" and "server data lands" where
        // the override briefly disappeared from the UI — visible as a card
        // flickering back to its previous column for 100-300ms.
        await queryClient.invalidateQueries({
          queryKey: ["shortlisting_overrides", roundId],
        });
        // Wave 10.3 P1-16: surface the inserted override id so the caller
        // can open the SignalAttributionModal to annotate the row. The
        // edge fn returns ids[0] for single-event POSTs.
        const insertedId = Array.isArray(result?.ids) ? result.ids[0] : null;
        return { ok: true, overrideId: insertedId || null };
      } catch (err) {
        console.error("[ShortlistingSwimlane] sendOverride failed:", err);
        toast.error(err?.message || "Override capture failed");
        return { ok: false, overrideId: null };
      }
    },
    [queryClient, roundId],
  );

  // Drag handler from @hello-pangea/dnd
  const onDragEnd = useCallback(
    async (result) => {
      const { source, destination, draggableId } = result;
      if (!destination) return;
      if (
        source.droppableId === destination.droppableId &&
        source.index === destination.index
      )
        return;

      // Mig 2026-05-04 grid view — droppableIds in the grid mode are
      // compound: `${bucketKey}__${roomKey}__${instKey}`.  Strip the
      // suffix so the bucket-keyed action logic below stays unchanged.
      // Lane view droppableIds are plain bucket keys ("rejected", etc.)
      // and survive the split unchanged.
      const fromColumn = source.droppableId.split("__")[0];
      const toColumn = destination.droppableId.split("__")[0];
      console.log(
        `[swimlane] onDragEnd source=${source.droppableId} dest=${destination.droppableId} ` +
          `→ fromColumn=${fromColumn} toColumn=${toColumn} draggable=${draggableId}`,
      );
      const action = deriveHumanAction(fromColumn, toColumn);
      if (!action) {
        console.log(
          `[swimlane] onDragEnd: no action for fromColumn=${fromColumn} toColumn=${toColumn} (same-bucket move)`,
        );
        return;
      }

      const groupId = draggableId;
      const composition = groups.find((g) => g.id === groupId);
      if (!composition) return;
      const cls = classByGroupId.get(groupId);
      const slot = slotByGroupId.get(groupId);

      // Wave 10.3 P1-16: per-card timer (IntersectionObserver) replaces the
      // page-level cumulative timer for this row. Fallback to page-level if
      // the card never entered viewport (rare).
      const reviewSecs = computeReviewDurationSeconds(groupId);

      // Build payload — distinguish approved-from-rejects (humanId) vs
      // approved-as-proposed (aiId).
      const isFromRejects =
        action === "added_from_rejects" || fromColumn === "rejected";
      const slotId = slot?.slot_id || null;
      // Wave 10.3 P1-16: derive the two-part offered/seen pair.
      //   alternative_offered    — TRUE if the slot has alts in cache OR the
      //                            editor has opened the drawer for it. The
      //                            former preserves backwards-compat with the
      //                            legacy field semantics; the latter covers
      //                            the case where Pass 2 emitted alts but the
      //                            classification cache hasn't loaded yet.
      //   alternative_offered_drawer_seen — TRUE only when the editor opened
      //                                     the drawer in this session.
      const slotHasAlts = !!slotId && (altsBySlotId.get(slotId) || []).length > 0;
      const drawerSeen = !!slotId && seenAltsBySlotIdRef.current.has(slotId);
      const event = {
        project_id: projectId,
        round_id: roundId,
        ai_proposed_group_id: isFromRejects ? null : groupId,
        ai_proposed_slot_id: slotId,
        ai_proposed_score: cls?.combined_score ?? null,
        human_action: action,
        human_selected_group_id: isFromRejects ? groupId : null,
        human_selected_slot_id: isFromRejects ? null : slotId,
        slot_group_id: slotId,
        review_duration_seconds: reviewSecs,
        alternative_offered: slotHasAlts || drawerSeen,
        alternative_offered_drawer_seen: drawerSeen,
        alternative_selected: false, // dragging isn't selecting an alt
        // Burst 4 J1: client_sequence is a monotonic counter so server-side
        // ordering is independent of network arrival jitter. shortlist-lock
        // (and any future override consumers) prefers client_sequence over
        // created_at when both are present. Falls back gracefully on legacy
        // events that pre-date this field.
        client_sequence: nextClientSequence(),
      };

      // Optimistic update — append to pendingOverrides immediately. Use a
      // unique pendingId so concurrent drags don't step on each other when
      // we drop the pending entry on success/failure.
      // F-C-019: drop the OLDEST entry once we hit the cap so the array is
      // bounded; the dropped entry's server row will still apply when the
      // refetch lands (it just stops contributing optimistic visuals).
      const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPendingOverrides((prev) => {
        const next = [
          ...prev,
          {
            ai_proposed_group_id: event.ai_proposed_group_id,
            human_selected_group_id: event.human_selected_group_id,
            human_action: event.human_action,
            created_at: new Date().toISOString(),
            _pending: true,
            _pendingId: pendingId,
          },
        ];
        return next.length > PENDING_OVERRIDE_CAP
          ? next.slice(next.length - PENDING_OVERRIDE_CAP)
          : next;
      });

      const sendResult = await sendOverride(event);
      // Drop only this pending entry — leave any other in-flight pendings alone.
      setPendingOverrides((prev) =>
        prev.filter((p) => p._pendingId !== pendingId),
      );
      // On failure, the user sees an error toast (sendOverride emitted it)
      // and the optimistic move is reverted by dropping the pending entry.
      // On success, the server-side refetch will replace this entry with the
      // canonical row (no duplication because we filtered by _pendingId).

      // Wave 10.3 P1-16: open the SignalAttributionModal for `removed` and
      // `swapped` actions — these are the cases where the editor disagreed
      // with Pass 2's choice and we want to capture which signal drove it.
      // `approved_as_proposed` and `added_from_rejects` don't need an
      // attribution prompt (the former is a confirmation, the latter
      // typically reflects coverage rather than a quality signal).
      if (
        sendResult.ok &&
        sendResult.overrideId &&
        (action === "removed" || action === "swapped")
      ) {
        setSignalModalState({
          open: true,
          overrideId: sendResult.overrideId,
          actionLabel: action,
        });
      }
    },
    [
      groups,
      classByGroupId,
      slotByGroupId,
      altsBySlotId,
      projectId,
      roundId,
      sendOverride,
      computeReviewDurationSeconds,
    ],
  );

  // Swap-via-alt-tray: same as a drag (proposed/approved gets swapped)
  const handleSwapAlternative = useCallback(
    async (winnerGroupId, altGroupId) => {
      const winnerSlot = slotByGroupId.get(winnerGroupId);
      // Wave 10.3 P1-16: per-card timer for the winner row (the row whose
      // drawer the editor opened to pick the alt).
      const reviewSecs = computeReviewDurationSeconds(winnerGroupId);
      const winnerCls = classByGroupId.get(winnerGroupId);
      const slotId = winnerSlot?.slot_id || null;
      // Selecting an alt definitionally means the drawer was open — even if
      // the seenAltsBySlotIdRef somehow missed the open transition (e.g. a
      // shortcut-driven swap), the swap action itself proves visibility.
      // Mark it eagerly so any subsequent drag on this slot also reflects
      // drawer_seen=TRUE.
      if (slotId) seenAltsBySlotIdRef.current.add(slotId);
      const event = {
        project_id: projectId,
        round_id: roundId,
        ai_proposed_group_id: winnerGroupId,
        ai_proposed_slot_id: slotId,
        ai_proposed_score: winnerCls?.combined_score ?? null,
        human_action: "swapped",
        human_selected_group_id: altGroupId,
        human_selected_slot_id: slotId,
        slot_group_id: slotId,
        review_duration_seconds: reviewSecs,
        alternative_offered: true,
        alternative_offered_drawer_seen: true,
        alternative_selected: true,
        client_sequence: nextClientSequence(), // J1
      };

      const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPendingOverrides((prev) => {
        const next = [
          ...prev,
          {
            ai_proposed_group_id: winnerGroupId,
            human_selected_group_id: altGroupId,
            human_action: "swapped",
            created_at: new Date().toISOString(),
            _pending: true,
            _pendingId: pendingId,
          },
        ];
        return next.length > PENDING_OVERRIDE_CAP
          ? next.slice(next.length - PENDING_OVERRIDE_CAP)
          : next;
      });

      const sendResult = await sendOverride(event);
      setPendingOverrides((prev) =>
        prev.filter((p) => p._pendingId !== pendingId),
      );
      // Burst 4 J2 fix: previous toast said "original moved to Rejected" but
      // no file movement happens until Lock. Toast now reflects that the
      // record is registered, not the move.
      if (sendResult.ok) {
        toast.success("Swap recorded — files will move on Lock");
        // Wave 10.3 P1-16: open SignalAttributionModal so the editor can
        // optionally annotate WHY they preferred the alt over Pass 2's
        // choice. Non-blocking — modal sits beside the toast.
        if (sendResult.overrideId) {
          setSignalModalState({
            open: true,
            overrideId: sendResult.overrideId,
            actionLabel: "swapped",
          });
        }
      }
    },
    [
      classByGroupId,
      slotByGroupId,
      projectId,
      roundId,
      sendOverride,
      computeReviewDurationSeconds,
    ],
  );

  // ── Lock & Reorganize ───────────────────────────────────────────────────
  // Wave 7 P0-1: the lock fn now submits a Dropbox /files/move_batch_v2 async
  // job and returns immediately with status='in_progress' + progress_id. We
  // open the LockProgressDialog which polls shortlist-lock-status for live
  // progress. The old per-file synchronous response shape (ok+partial+errors)
  // is gone — terminal state lives in shortlisting_lock_progress.
  const [isLocking, setIsLocking] = useState(false);
  const [confirmLockOpen, setConfirmLockOpen] = useState(false);
  const [progressDialogOpen, setProgressDialogOpen] = useState(false);
  const [lockInitialResponse, setLockInitialResponse] = useState(null);
  const lockShortlist = useCallback(async () => {
    if (!roundId) return;
    setIsLocking(true);
    try {
      const resp = await api.functions.invoke("shortlist-lock", {
        round_id: roundId,
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) {
        throw new Error(result?.error || "Lock failed");
      }
      // Three returnable shapes from shortlist-lock:
      //   1. status='in_progress' (HTTP 202) — async batch in flight, dialog
      //      will poll shortlist-lock-status until terminal
      //   2. status='complete'   (HTTP 200) — zero-work or sync-complete fast
      //      path; dialog opens directly to "done"
      //   3. already_locked: true — round was already locked; dialog opens to
      //      done with the cached counts
      setLockInitialResponse(result);
      setProgressDialogOpen(true);
      setConfirmLockOpen(false);
      // For the immediate-complete cases, refresh swimlane queries now so the
      // operator sees the locked banner without waiting on the dialog.
      if (result?.status === "complete" || result?.already_locked) {
        queryClient.invalidateQueries({
          queryKey: ["shortlisting_rounds", projectId],
        });
        const moved = result?.moved || {};
        const total = (moved.approved || 0) + (moved.rejected || 0);
        toast.success(
          total > 0
            ? `Shortlist locked — moved ${total} file(s).`
            : "Shortlist locked.",
        );
      }
    } catch (err) {
      console.error("[ShortlistingSwimlane] lockShortlist failed:", err);
      toast.error(err?.message || "Lock failed");
    } finally {
      setIsLocking(false);
    }
  }, [roundId, projectId, queryClient]);

  // ── Loading / error states ──────────────────────────────────────────────
  if (isLoading) {
    return (
      <Card>
        <CardContent className="p-6">
          <div className="space-y-2 animate-pulse">
            <div className="h-8 bg-muted rounded w-1/3" />
            <div className="h-64 bg-muted rounded" />
          </div>
        </CardContent>
      </Card>
    );
  }
  if (queryError) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="font-medium">Failed to load swimlane data</p>
          <p className="text-xs mt-0.5">
            {queryError.message || "Unknown error"}
          </p>
        </div>
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="p-10 text-center text-sm text-muted-foreground">
          No compositions yet for this round. Wait for Pass 0 to enumerate
          RAWs.
        </CardContent>
      </Card>
    );
  }

  // ── Round metadata + coverage ──────────────────────────────────────────
  // Wave 7 P1-11: drop the hardcoded `|| 24` Gold fallback. round.package_ceiling
  // is denormalized onto every round at creation time (shortlisting-ingest →
  // PACKAGE_CEILING_DEFAULTS) so it should always be present for real rounds.
  // If it's somehow missing, we render "—" rather than silently lying about
  // a ceiling. Per Joseph's architectural correction (2026-04-27), packages
  // must NEVER be hardcoded in the frontend.
  const ceiling = round?.package_ceiling ?? null;
  const total = groups.length;
  const approvedCount = columnItems.approved.length;
  const proposedCount = columnItems.proposed.length;
  const rejectedCount = columnItems.rejected.length;
  const isLocked = round?.status === "locked" || round?.status === "delivered";
  // Burst 16 AA1/AA2: lock the UI while the engine is still mid-pipeline.
  // status='processing' means Pass 0/1/2 are still running. During that
  // window, slotEvents may be empty (Pass 2 hasn't fired yet), so EVERY
  // group renders in REJECTED — and the user could drag freely + click
  // Lock prematurely on garbage state. status='proposed' is the correct
  // gate for human review; 'pending' is even earlier (round just created).
  const isProcessing =
    round?.status === "processing" || round?.status === "pending";
  const isReadOnly = isLocked || isProcessing;

  return (
    <div className="space-y-3">
      {/* Wave 11.7.7 — Shape D engine controls + audit banner.
          Renders only when the round is shape_d_* OR has an engine_run_audit
          row; legacy two-pass rounds keep the original UI clean. */}
      <ShapeDEngineBanner round={round} projectId={projectId} />

      {/* W11.6 Wave 2B — Dispatcher visibility panel.
          Live countdown to the next cron tick + active jobs for the round +
          recent terminal rows + Shape D timeline mini-viz. master_admin gets
          a "Force run now" button per pending job. Sits below the engine
          banner so the operator sees both engine state and dispatcher state
          before the swimlane itself. */}
      <DispatcherPanel projectId={projectId} roundId={round?.id} />

      {/* W11.6.1 — operator UX toolbar: sort / filter / preview-size /
          group-by-slot / live elapsed timer. Sits ABOVE the round
          metadata strip per Joseph's Round 2 review (P3 #3, #5, #6, #7,
          #9). Persistence lives in `useSwimlaneSettings`. */}
      <SwimlaneToolbarController
        sort={sort}
        onSortChange={setSort}
        filter={filter}
        onFilterChange={setFilter}
        previewSize={previewSize}
        onPreviewSizeChange={setPreviewSize}
        groupBySlot={groupBySlot}
        onGroupBySlotChange={setGroupBySlot}
        availableSlotIds={availableSlotIds}
        availableRoomTypes={availableRoomTypes}
        availableShotIntents={availableShotIntents}
        availableAppealSignals={availableAppealSignals}
        availableConcernSignals={availableConcernSignals}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
        roundId={roundId}
        isProcessing={isProcessing}
      />

      {/* Mig 465 — engine recipe + per-quota_bucket fill panel. Replaces
          the legacy Phase 1/2/3 slot-lattice counter for rounds where the
          editorial engine ran (post-mig 465). Falls back to the legacy
          counter inline when no editorial event exists. */}
      <EditorialQuotaPanel
        roundId={round?.id}
        packageType={round?.package_type}
        proposedSlotIds={proposedSlotIds}
        packageCeiling={ceiling}
      />

      {/* Round metadata strip */}
      <Card>
        <CardContent className="p-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <div>
              <div className="text-xs text-muted-foreground">Round</div>
              <div className="text-sm font-medium">
                #{round?.round_number ?? "—"}
                {round?.package_type ? (
                  <span className="text-muted-foreground font-normal">
                    {" · "}
                    {round.package_type}
                  </span>
                ) : null}
              </div>
            </div>
            <div className="border-l h-8" />
            <div>
              <div className="text-xs text-muted-foreground">Approved</div>
              <div className="text-sm font-medium tabular-nums">
                {approvedCount} / {ceiling ?? "—"} max
              </div>
            </div>
            <div className="border-l h-8" />
            <div>
              <div className="text-xs text-muted-foreground">Proposed</div>
              <div className="text-sm font-medium tabular-nums">
                {proposedCount}
              </div>
            </div>
            <div className="border-l h-8" />
            <div>
              <div className="text-xs text-muted-foreground">Total</div>
              <div className="text-sm font-medium tabular-nums">{total}</div>
            </div>
            {round?.started_at && (
              <>
                <div className="border-l h-8" />
                <div>
                  <div className="text-xs text-muted-foreground">Started</div>
                  <div
                    className="text-sm font-medium"
                    title={format(new Date(round.started_at), "d MMM yyyy, h:mm a")}
                  >
                    {format(new Date(round.started_at), "d MMM, h:mm a")}
                  </div>
                </div>
              </>
            )}
          </div>
          <Button
            variant={isLocked ? "outline" : "default"}
            size="sm"
            onClick={() => setConfirmLockOpen(true)}
            disabled={isLocking || isLocked || isProcessing || approvedCount === 0}
            title={
              isLocked
                ? "Round already locked"
                : isProcessing
                  ? "Engine is still running — wait for status='proposed' before locking"
                  : approvedCount === 0
                    ? "Add at least one composition to Approved before locking"
                    : "Lock the shortlist and move RAWs in Dropbox"
            }
          >
            {isLocking ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : isLocked ? (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            ) : (
              <Lock className="h-4 w-4 mr-2" />
            )}
            {isLocked ? "Locked" : "Lock & Reorganize"}
          </Button>
        </CardContent>
      </Card>

      {/* Coverage notes (if any) */}
      {/* Audit defect #39: render only when notes are substantive (>=20 chars).
          Sonnet sometimes emits a single-word placeholder like "OK" that
          rendered as a near-empty blue panel; suppressed below the threshold. */}
      {typeof round?.coverage_notes === "string" &&
        round.coverage_notes.trim().length >= 20 && (
          <Card className="border-blue-200 dark:border-blue-900">
            <CardContent className="p-3 text-xs text-muted-foreground">
              <div className="font-medium text-foreground mb-1">
                Coverage notes
              </div>
              <p className="leading-snug whitespace-pre-line">
                {round.coverage_notes}
              </p>
            </CardContent>
          </Card>
        )}

      {/* Wave 10.1 (W10.1) — secondary-camera banner. Shown when the round
          contains files from a non-primary camera_source (e.g. iPhone BTS,
          junior photographer's R6). Per-round dismissal persisted in
          localStorage so reviewing across rounds doesn't surface the same
          notice repeatedly. Amber tone matches W7.4's audit-status banner
          pattern (informational, no action required). */}
      {!bannerDismissed && secondaryBuckets.length > 0 && (
        <div className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
          <div className="flex-1 leading-relaxed">
            <div className="font-medium mb-0.5">
              Multi-camera shoot detected
            </div>
            <div>
              {secondaryBuckets
                .map(
                  ({ source, count }) =>
                    `${count} ${humaniseCameraSource(source)} image${count !== 1 ? "s" : ""}`,
                )
                .join(" and ")}{" "}
              treated as singletons (not bracket-merged). They still compete
              for shortlist slots on quality alone.
            </div>
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            className="text-amber-700 dark:text-amber-300 hover:text-amber-900 dark:hover:text-amber-100 flex-shrink-0"
            title="Dismiss for this round"
            aria-label="Dismiss multi-camera notice"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Burst 16 AA2: in-progress banner so the swimlane doesn't look empty/
          stuck while the engine is mid-pipeline. Hidden once the round
          transitions to 'proposed'. */}
      {isProcessing && (
        <div className="rounded-md border border-blue-200 dark:border-blue-900 bg-blue-50 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-700 dark:text-blue-200 flex items-center gap-2">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            Engine is still running for this round (status=
            <code className="text-[10px] font-mono">{round?.status}</code>).
            Drag &amp; drop and Lock are disabled until the AI finishes proposing
            the shortlist.
          </span>
        </div>
      )}

      {/* QC-iter2-W7 F-C-019: surface when optimistic overrides are running
          past the cap. Operator-visible explanation that older drag actions
          are still queued server-side; the optimistic visuals just stop
          stacking so the column compute stays snappy. */}
      {pendingCatchingUp && (
        <div
          className="rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2"
          data-testid="swimlane-pending-catching-up"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>
            Catching up… {pendingOverrides.length} edits queued for the server.
            Slowing or hiding optimistic moves until the queue drains.
          </span>
        </div>
      )}

      {/* Mig 465+grid — when the operator picks "Grid view" the legacy
          3-column lane is replaced by a 2D grid (rows = space_type, sub-
          rows = space_instance, cols = Rejected / AI Proposed / Human
          Approved).  Both views share the SAME DragDropContext +
          onDragEnd handler so drag/drop, override capture, alts drawer,
          and AI training-data emissions are identical between modes —
          the grid is just a different visual layout over the same
          interaction surface. */}
      <DragDropContext onDragEnd={onDragEnd}>
        {groupBySlot ? (
          <SwimlaneGridView
            columnItems={columnItems}
            spaceInstancesById={spaceInstancesById}
            heroRoomsOrder={heroRoomsOrder}
            density={previewSize}
            isLocked={isReadOnly}
            onSwapAlternative={handleSwapAlternative}
            altsBySlotId={altsBySlotId}
            classByGroupId={classByGroupId}
            registerCardObserver={registerCardObserver}
            onAltsDrawerOpen={handleAltsDrawerOpen}
            onCardImageClick={(bucketKey, item, roomContext) => {
              // 2026-05-04: in grid mode the lightbox cycles WITHIN
              // the current room across all 3 buckets, in lane order
              // (rejected → proposed → approved).  SwimlaneGridView
              // passes the room's instance as `roomContext` so we can
              // assemble the ordered list here.
              if (
                roomContext &&
                Array.isArray(roomContext.rejected) &&
                Array.isArray(roomContext.proposed) &&
                Array.isArray(roomContext.approved)
              ) {
                const ordered = [
                  ...roomContext.rejected,
                  ...roomContext.proposed,
                  ...roomContext.approved,
                ];
                const orderedIds = ordered.map((it) => it.id);
                const idx = orderedIds.indexOf(item.id);
                if (idx >= 0) {
                  openLightboxOrdered(
                    orderedIds,
                    idx,
                    roomContext.label || null,
                  );
                  return;
                }
              }
              // Fallback: bucket-scoped (same behaviour as lane view).
              const arr = columnItems[bucketKey] || [];
              const idx = arr.findIndex((x) => x.id === item.id);
              if (idx >= 0) openLightbox(bucketKey, idx);
            }}
          />
        ) : (
          /* 3-column swimlane (default).
             QC-iter2-W7 F-C-007: md breakpoint splits into 2 columns
             (proposed spans full row, rejected/approved share row 2) so
             tablet-portrait and small-laptop windows aren't stuck on the
             mobile single-column stack.  lg+ keeps the canonical
             1fr_2fr_1fr layout. */
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-[1fr_2fr_1fr] gap-3">
            {COLUMNS.map((col) => {
              const items = columnItems[col.key] || [];
              return (
                <SwimlaneColumn
                  key={col.key}
                  column={col}
                  items={items}
                  grouped={null}
                  isLocked={isReadOnly}
                  onSwapAlternative={handleSwapAlternative}
                  altsBySlotId={altsBySlotId}
                  classByGroupId={classByGroupId}
                  registerCardObserver={registerCardObserver}
                  onAltsDrawerOpen={handleAltsDrawerOpen}
                  previewSize={previewSize}
                  onCardImageClick={(idx) => openLightbox(col.key, idx)}
                />
              );
            })}
          </div>
        )}
      </DragDropContext>

      {/* W11.6.x — Stage 4 visual corrections lane (in-context replacement
          for the buggy standalone /Stage4Overrides page). Shows ONLY this
          round's pending Stage 4 corrections so the operator can review
          alongside the 3-column swimlane. Cross-round bulk review still
          available via the link in the lane header. */}
      <Stage4CorrectionsLane roundId={roundId} />

      {/* Confirm Lock dialog */}
      <Dialog open={confirmLockOpen} onOpenChange={setConfirmLockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lock & reorganize shortlist?</DialogTitle>
            <DialogDescription>
              This moves <strong>{approvedCount}</strong> approved composition
              {approvedCount === 1 ? "" : "s"} into{" "}
              <code className="text-[11px]">Photos/Raws/Final Shortlist/</code>{" "}
              and <strong>{rejectedCount}</strong> rejected
              {rejectedCount === 1 ? "" : "s"} into{" "}
              <code className="text-[11px]">Photos/Raws/Rejected/</code>. The
              round status becomes <strong>locked</strong>. This cannot be
              undone (but you can manually move files back in Dropbox).
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmLockOpen(false)}
              disabled={isLocking}
            >
              Cancel
            </Button>
            <Button onClick={lockShortlist} disabled={isLocking}>
              {isLocking && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Lock & Reorganize
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Live progress dialog (Wave 7 P0-1) */}
      <LockProgressDialog
        open={progressDialogOpen}
        onOpenChange={setProgressDialogOpen}
        roundId={roundId}
        projectId={projectId}
        initialResponse={lockInitialResponse}
      />

      {/* Wave 10.3 P1-16 — non-blocking signal-attribution prompt after a
          `removed` or `swapped` override. Patches primary_signal_overridden
          via the shortlisting-overrides.annotate path. */}
      <SignalAttributionModal
        open={signalModalState.open}
        onOpenChange={(open) =>
          open
            ? setSignalModalState((prev) => ({ ...prev, open: true }))
            : closeSignalModal()
        }
        overrideId={signalModalState.overrideId}
        actionLabel={signalModalState.actionLabel}
        onSubmit={submitSignalAttribution}
      />

      {/* W11.6.20 — swimlane lightbox. Mounts only when bucket !== null so
          there's zero overhead when closed. Items are derived from the
          column-keyed `columnItems` map, normalised to the lightbox's item
          shape (filename + dropbox_path + observed_objects + signal_scores
          + slot_decision + classification). The lightbox handles its own
          ←/→ keyboard nav, prev/next buttons, swipe — no plumbing needed
          from here. */}
      {(lightboxState.bucket || (lightboxState.orderedGroupIds && lightboxState.orderedGroupIds.length > 0)) && lightboxItemsMemo && (() => {
        const COLUMN_LABEL = {
          rejected: "REJECTED",
          proposed: "AI PROPOSED",
          approved: "HUMAN APPROVED",
        };
        const bucket = lightboxState.bucket;
        // 2026-05-04: in grid mode the lightbox cycles through a
        // room-scoped ordered list, so the header label is the room
        // name instead of a single bucket name.
        const label = lightboxState.bucketLabel
          ? lightboxState.bucketLabel
          : COLUMN_LABEL[bucket] || bucket;
        return (
          <ShortlistingLightbox
            items={lightboxItemsMemo}
            initialIndex={lightboxState.index}
            bucketLabel={label}
            allClassificationsInRound={classifications}
            onClose={closeLightbox}
          />
        );
      })()}
    </div>
  );
}

/**
 * SwimlaneToolbarController — thin shim that joins the elapsed-timer hook to
 * the toolbar component so the parent doesn't need to know about polling.
 * The hook returns a string label or null; the toolbar simply renders it.
 *
 * Kept as a dedicated component so the elapsed-timer hook only fires while
 * the round is actively processing — when the round is locked / proposed,
 * the hook is gated by `isActive` and never enqueues a polling query.
 */
function SwimlaneToolbarController({
  sort,
  onSortChange,
  filter,
  onFilterChange,
  previewSize,
  onPreviewSizeChange,
  groupBySlot,
  onGroupBySlotChange,
  availableSlotIds,
  availableRoomTypes,
  // W11.6.16
  availableShotIntents = [],
  availableAppealSignals = [],
  availableConcernSignals = [],
  searchQuery,
  onSearchQueryChange,
  roundId,
  isProcessing,
}) {
  const timerLabel = useSwimlaneElapsedTimer({
    roundId,
    isActive: !!isProcessing,
  });
  return (
    <SwimlaneToolbar
      sort={sort}
      onSortChange={onSortChange}
      filter={filter}
      onFilterChange={onFilterChange}
      previewSize={previewSize}
      onPreviewSizeChange={onPreviewSizeChange}
      groupBySlot={groupBySlot}
      onGroupBySlotChange={onGroupBySlotChange}
      availableSlotIds={availableSlotIds}
      availableRoomTypes={availableRoomTypes}
      availableShotIntents={availableShotIntents}
      availableAppealSignals={availableAppealSignals}
      availableConcernSignals={availableConcernSignals}
      searchQuery={searchQuery}
      onSearchQueryChange={onSearchQueryChange}
      timerLabel={timerLabel}
    />
  );
}

// ── Column ────────────────────────────────────────────────────────────────
function SwimlaneColumn({
  column,
  items,
  grouped,
  isLocked,
  onSwapAlternative,
  altsBySlotId,
  classByGroupId,
  registerCardObserver,
  onAltsDrawerOpen,
  previewSize,
  onCardImageClick,
}) {
  return (
    <Droppable droppableId={column.key} isDropDisabled={isLocked}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.droppableProps}
          className={cn(
            "rounded-md border-2 bg-card transition-colors",
            snapshot.isDraggingOver && "ring-2 ring-primary/60 border-primary/40",
          )}
        >
          <div
            className={cn(
              "px-2 py-1.5 text-xs font-semibold flex items-center justify-between rounded-t-sm",
              column.headerTone,
            )}
          >
            <span className="uppercase tracking-wide">{column.label}</span>
            <span className="tabular-nums">{items.length}</span>
          </div>
          {/* W11.6.20 density-grid: bucket body is now a CSS grid driven by
              previewSize. SM packs ~5–6 cards/row, MD ~3–4, LG ~2–3 — the
              `auto-fill` math collapses to 1 column on narrow viewports so
              mobile layout is unchanged. The grouped-by-slot path falls
              back to a vertical stack of sub-lanes (each sub-lane is its
              OWN grid). DnD is unaffected: @hello-pangea/dnd treats the
              grid container the same as a flex container — grid items
              are draggable, grid cells are valid drop targets. */}
          <div
            className="p-2 min-h-[200px] max-h-[70vh] overflow-y-auto"
            data-testid={`swimlane-bucket-${column.key}`}
            data-preview-size={previewSize}
            style={!grouped && items.length > 0 ? { ...previewGridStyle(previewSize), gap: "0.5rem" } : undefined}
          >
            {items.length === 0 ? (
              <div className="text-center py-6 text-[11px] text-muted-foreground">
                {snapshot.isDraggingOver
                  ? "Drop here"
                  : column.key === "approved"
                    ? "Drag from Proposed or Rejected"
                    : "Empty"}
              </div>
            ) : grouped ? (
              <SwimlaneGroupedList
                grouped={grouped}
                column={column}
                isLocked={isLocked}
                onSwapAlternative={onSwapAlternative}
                altsBySlotId={altsBySlotId}
                classByGroupId={classByGroupId}
                registerCardObserver={registerCardObserver}
                onAltsDrawerOpen={onAltsDrawerOpen}
                previewSize={previewSize}
                onCardImageClick={onCardImageClick}
              />
            ) : (
              items.map((item, index) => (
                <SwimlaneCardRenderer
                  key={item.id}
                  item={item}
                  index={index}
                  column={column}
                  isLocked={isLocked}
                  onSwapAlternative={onSwapAlternative}
                  altsBySlotId={altsBySlotId}
                  classByGroupId={classByGroupId}
                  registerCardObserver={registerCardObserver}
                  onAltsDrawerOpen={onAltsDrawerOpen}
                  previewSize={previewSize}
                  onCardImageClick={onCardImageClick}
                />
              ))
            )}
            {provided.placeholder}
          </div>
        </div>
      )}
    </Droppable>
  );
}

/**
 * W11.6.1 sub-feature 5 — group-by-slot list. Renders each slot as a
 * collapsible sub-row inside the AI PROPOSED column. Each sub-row carries
 * `data-slot-id` so W11.6.3's slot-aware lightbox can read the active
 * slot context via DOM traversal — that's the integration handshake.
 *
 * Drag indices are preserved across the whole flat-list (the @hello-pangea
 * Draggable index is still 0..N-1 — the visual grouping doesn't need to
 * partition the DnD index).
 */
function SwimlaneGroupedList({
  grouped,
  column,
  isLocked,
  onSwapAlternative,
  altsBySlotId,
  classByGroupId,
  registerCardObserver,
  onAltsDrawerOpen,
  previewSize,
  onCardImageClick,
}) {
  // Track per-slot expansion locally — collapsed by default per spec, so the
  // operator sees a compact stack of slot headers and expands the ones they
  // care about.
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (slotId) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(slotId)) next.delete(slotId);
      else next.add(slotId);
      return next;
    });

  let runningIndex = 0;
  return (
    <div className="space-y-1">
      {grouped.map((subLane) => {
        const isOpen = expanded.has(subLane.slotId);
        const startIndex = runningIndex;
        runningIndex += subLane.items.length;
        return (
          <div
            key={subLane.slotId}
            data-slot-id={subLane.slotId}
            className="rounded-sm border bg-background"
          >
            <button
              type="button"
              onClick={() => toggle(subLane.slotId)}
              aria-expanded={isOpen}
              data-testid={`swimlane-sublane-toggle-${subLane.slotId}`}
              className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-medium hover:bg-muted/50 rounded-sm"
            >
              <span className="flex items-center gap-1">
                {isOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <span>{subLane.label}</span>
                {subLane.phase != null && (
                  <span className="ml-1 text-muted-foreground">
                    P{subLane.phase}
                  </span>
                )}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {subLane.items.length}
              </span>
            </button>
            {isOpen && (
              // W11.6.20 density-grid: each expanded sub-lane is its own
              // grid so the sub-lane respects the same density semantics
              // as a top-level bucket. The sub-lane is narrower (it's
              // nested inside PROPOSED) so SM/MD/LG produce fewer
              // cards-per-row than the top-level case — that's correct;
              // auto-fill adapts to the available width.
              <div
                className="p-1"
                data-preview-size={previewSize}
                style={{ ...previewGridStyle(previewSize), gap: "0.25rem" }}
              >
                {subLane.items.map((item, i) => (
                  <SwimlaneCardRenderer
                    key={item.id}
                    item={item}
                    index={startIndex + i}
                    column={column}
                    isLocked={isLocked}
                    onSwapAlternative={onSwapAlternative}
                    altsBySlotId={altsBySlotId}
                    classByGroupId={classByGroupId}
                    registerCardObserver={registerCardObserver}
                    onAltsDrawerOpen={onAltsDrawerOpen}
                    previewSize={previewSize}
                    onCardImageClick={onCardImageClick}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Renders a single Draggable card. Extracted so both the flat list and the
 * grouped sub-lanes share the same DnD wiring. `previewSize` is forwarded
 * to the card via a wrapping div (CSS custom property) so we don't need
 * to teach `ShortlistingCard` about the toolbar — that file is owned by
 * W11.6.2 and we don't touch it here.
 */
export function SwimlaneCardRenderer({
  item,
  index,
  column,
  isLocked,
  onSwapAlternative,
  altsBySlotId,
  registerCardObserver,
  onAltsDrawerOpen,
  previewSize,
  onCardImageClick,
}) {
  const slotId = item.slot?.slot_id;
  const altsRaw = slotId ? altsBySlotId.get(slotId) || [] : [];
  // Show top 2 alts, decorated for ShortlistingCard.
  const alternatives = altsRaw.slice(0, 2).map((alt) => ({
    group_id: alt.group_id,
    stem: alt.stem,
    combined_score: alt.combined_score,
    analysis: alt.analysis,
  }));
  // Map preview size to a CSS variable on the wrapping div. The card adapts
  // via existing object-cover styles; the variable is exposed in case a
  // future polish pass wants to read it inside the card. Per the spec only
  // the wrapping size changes — we don't reach into the W11.6.2-owned card.
  const sizePx =
    previewSize === "sm" ? 96 : previewSize === "lg" ? 256 : 192;
  return (
    <Draggable
      key={item.id}
      draggableId={item.id}
      index={index}
      isDragDisabled={isLocked}
    >
      {(dragProvided, dragSnapshot) => (
        <div
          ref={dragProvided.innerRef}
          {...dragProvided.draggableProps}
          {...dragProvided.dragHandleProps}
          className={cn(
            !isLocked && "cursor-grab active:cursor-grabbing",
          )}
          style={{
            ...dragProvided.draggableProps.style,
            "--swimlane-preview-px": `${sizePx}px`,
          }}
          data-preview-size={previewSize}
          data-slot-id={slotId || undefined}
        >
          <ShortlistingCard
            composition={item}
            column={column.key}
            alternatives={alternatives}
            isDragging={dragSnapshot.isDragging}
            onSwapAlternative={
              column.key !== "rejected"
                ? (altGroupId) => onSwapAlternative(item.id, altGroupId)
                : null
            }
            registerCardObserver={registerCardObserver}
            onAltsDrawerOpen={onAltsDrawerOpen}
            previewSize={previewSize}
            onImageClick={
              onCardImageClick
                ? () => onCardImageClick(index)
                : undefined
            }
          />
        </div>
      )}
    </Draggable>
  );
}

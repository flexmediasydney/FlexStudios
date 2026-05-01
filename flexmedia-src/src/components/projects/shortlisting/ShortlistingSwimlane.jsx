/**
 * ShortlistingSwimlane — Wave 6 Phase 6 SHORTLIST
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
 * Top of swimlane:
 *   - Lock & Reorganize button (calls shortlist-lock)
 *   - Round metadata (status, ceiling, package_type, started_at)
 *   - Coverage summary
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
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
  X,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ShortlistingCard from "./ShortlistingCard";
import LockProgressDialog from "./LockProgressDialog";
import SignalAttributionModal from "./SignalAttributionModal";
import ShapeDEngineBanner from "./ShapeDEngineBanner";
import DispatcherPanel from "./DispatcherPanel";

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

function deriveHumanAction(fromColumn, toColumn) {
  if (fromColumn === toColumn) return null;
  if (fromColumn === "proposed" && toColumn === "approved")
    return "approved_as_proposed";
  if (fromColumn === "proposed" && toColumn === "rejected") return "removed";
  if (fromColumn === "rejected" && toColumn === "approved")
    return "added_from_rejects";
  if (fromColumn === "approved" && toColumn === "rejected") return "removed";
  // Burst 4 J6/J7 fix: returning to PROPOSED column means "I haven't decided
  // yet" — not an affirmative approve/reject. Recording these as
  // approved_as_proposed / added_from_rejects (the prior behaviour) inverts
  // user intent and biases training data toward the wrong direction.
  // We emit no event — the optimistic UI move stands but no override row is
  // persisted, so on refetch the card returns to its server-derived column.
  if (fromColumn === "approved" && toColumn === "proposed") return null;
  if (fromColumn === "rejected" && toColumn === "proposed") return null;
  return null;
}

export default function ShortlistingSwimlane({
  roundId,
  round,
  projectId,
  project,
}) {
  const queryClient = useQueryClient();

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

  // ── Build columns from data ─────────────────────────────────────────────
  // Per-group classification lookup
  const classByGroupId = useMemo(() => {
    const m = new Map();
    for (const c of classifications) m.set(c.group_id, c);
    return m;
  }, [classifications]);

  // Per-group slot info from pass2 events: { slot_id, phase, rank }
  const slotByGroupId = useMemo(() => {
    const m = new Map();
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
  }, [slotEvents]);

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

  // Initial AI shortlist set + classification-based rejection set
  const initialColumns = useMemo(() => {
    const proposed = new Set();
    for (const ev of slotEvents) {
      if (!ev.group_id) continue;
      if (ev.event_type === "pass2_phase3_recommendation") {
        proposed.add(ev.group_id);
      } else if (ev.event_type === "pass2_slot_assigned") {
        const rank = ev.payload?.rank;
        if (rank === 1 || rank === undefined) proposed.add(ev.group_id);
      }
    }
    const rejected = new Set();
    for (const g of groups) {
      if (proposed.has(g.id)) continue;
      rejected.add(g.id);
    }
    return { proposed, rejected, approved: new Set() };
  }, [slotEvents, groups]);

  // Apply overrides on top of initial assignment, in chronological order.
  // Local override state (for pending optimistic moves before server acks).
  const [pendingOverrides, setPendingOverrides] = useState([]);

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
          // W11.7.1 (2026-05-01): Stage 4 writes shortlisting_overrides rows
          // with human_action='ai_proposed' so the swimlane has a
          // first-class data source for the AI's slot picks. The card
          // belongs in the PROPOSED column — same as if no override row
          // existed at all. Idempotent: ensure it's in proposed and not
          // already in approved/rejected from a stale state.
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

  // Build column-keyed arrays of composition objects, decorated for the card.
  const columnItems = useMemo(() => {
    const out = { rejected: [], proposed: [], approved: [] };
    for (const g of groups) {
      const decorated = {
        ...g,
        classification: classByGroupId.get(g.id) || null,
        slot: slotByGroupId.get(g.id) || null,
      };
      if (computedColumns.approved.has(g.id)) out.approved.push(decorated);
      else if (computedColumns.proposed.has(g.id)) out.proposed.push(decorated);
      else out.rejected.push(decorated);
    }
    // Stable sort: approved first by slot-phase, proposed by slot-phase,
    // rejected by group_index.
    const slotKey = (d) =>
      d.slot
        ? `${(d.slot.phase ?? 9)}-${d.slot.slot_id || "z"}`
        : "z-" + (d.group_index ?? 999);
    out.proposed.sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    out.approved.sort((a, b) => slotKey(a).localeCompare(slotKey(b)));
    out.rejected.sort((a, b) => (a.group_index ?? 0) - (b.group_index ?? 0));
    return out;
  }, [groups, classByGroupId, slotByGroupId, computedColumns]);

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

      const fromColumn = source.droppableId;
      const toColumn = destination.droppableId;
      const action = deriveHumanAction(fromColumn, toColumn);
      if (!action) return;

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
      const pendingId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setPendingOverrides((prev) => [
        ...prev,
        {
          ai_proposed_group_id: event.ai_proposed_group_id,
          human_selected_group_id: event.human_selected_group_id,
          human_action: event.human_action,
          created_at: new Date().toISOString(),
          _pending: true,
          _pendingId: pendingId,
        },
      ]);

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
      setPendingOverrides((prev) => [
        ...prev,
        {
          ai_proposed_group_id: winnerGroupId,
          human_selected_group_id: altGroupId,
          human_action: "swapped",
          created_at: new Date().toISOString(),
          _pending: true,
          _pendingId: pendingId,
        },
      ]);

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

      {/* 3-column swimlane */}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_2fr_1fr] gap-3">
          {COLUMNS.map((col) => {
            const items = columnItems[col.key] || [];
            return (
              <SwimlaneColumn
                key={col.key}
                column={col}
                items={items}
                isLocked={isReadOnly}
                onSwapAlternative={handleSwapAlternative}
                altsBySlotId={altsBySlotId}
                classByGroupId={classByGroupId}
                registerCardObserver={registerCardObserver}
                onAltsDrawerOpen={handleAltsDrawerOpen}
              />
            );
          })}
        </div>
      </DragDropContext>

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
    </div>
  );
}

// ── Column ────────────────────────────────────────────────────────────────
function SwimlaneColumn({
  column,
  items,
  isLocked,
  onSwapAlternative,
  altsBySlotId,
  classByGroupId,
  registerCardObserver,
  onAltsDrawerOpen,
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
          <div className="p-2 space-y-2 min-h-[200px] max-h-[70vh] overflow-y-auto">
            {items.length === 0 ? (
              <div className="text-center py-6 text-[11px] text-muted-foreground">
                {snapshot.isDraggingOver
                  ? "Drop here"
                  : column.key === "approved"
                    ? "Drag from Proposed or Rejected"
                    : "Empty"}
              </div>
            ) : (
              items.map((item, index) => {
                const slotId = item.slot?.slot_id;
                const altsRaw = slotId ? altsBySlotId.get(slotId) || [] : [];
                // Show top 2 alts, decorated for ShortlistingCard.
                const alternatives = altsRaw.slice(0, 2).map((alt) => ({
                  group_id: alt.group_id,
                  stem: alt.stem,
                  combined_score: alt.combined_score,
                  analysis: alt.analysis,
                }));
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
                      >
                        <ShortlistingCard
                          composition={item}
                          column={column.key}
                          alternatives={alternatives}
                          isDragging={dragSnapshot.isDragging}
                          onSwapAlternative={
                            column.key !== "rejected"
                              ? (altGroupId) =>
                                  onSwapAlternative(item.id, altGroupId)
                              : null
                          }
                          registerCardObserver={registerCardObserver}
                          onAltsDrawerOpen={onAltsDrawerOpen}
                        />
                      </div>
                    )}
                  </Draggable>
                );
              })
            )}
            {provided.placeholder}
          </div>
        </div>
      )}
    </Droppable>
  );
}

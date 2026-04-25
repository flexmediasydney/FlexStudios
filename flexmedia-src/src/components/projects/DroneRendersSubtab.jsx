/**
 * DroneRendersSubtab — Drone Phase 2 Stream K (curate-then-edit-then-render)
 *
 * The 5-column swimlane for one drone shoot:
 *
 *   ┌ RAW PROPOSED ─┬ RAW ACCEPTED ─┬ AI PROPOSED ─┬ ADJUSTMENTS ─┬ FINAL ─┐
 *   │ shots         │ shots         │ renders       │ renders       │ renders│
 *   │ accept/reject │ send-back     │ Edit/Approve  │ Approve/Back  │ Down…  │
 *   └───────────────┴───────────────┴───────────────┴───────────────┴────────┘
 *
 * Shot columns (Raw Proposed / Raw Accepted) are derived from
 * `drone_shots.lifecycle_state` (raw_proposed | raw_accepted | rejected |
 * sfm_only — migration 242). SfM-only nadirs never appear here.
 *
 * Render columns (AI Proposed / Adjustments / Final) are derived from
 * `drone_renders.column_state` (proposed | adjustments | final | rejected),
 * unchanged from the prior version.
 *
 * Header actions:
 *   • "Lock shortlist" — orchestrator-built `drone-shortlist-lock` Edge Fn.
 *     Visible only when there's at least one Raw Accepted AND at least one
 *     Raw Proposed remaining to triage.
 *   • "Re-analyse edited folder" — re-runs `drone-render` to wipe & regenerate
 *     AI Proposed cards from the team's post-prod edits. Visible after lock
 *     (Raw Proposed empty) once anything was accepted.
 *   • "Show rejected (N)" — popover listing rejected raw shots with Restore.
 *
 * Card thumbnail: Raw Proposed / Raw Accepted prefer the AI preview render
 * (drone_renders.column_state='preview') and fall back to the raw shot.
 *
 * Props: { shoot, projectId }
 *
 * Actions:
 *   RAW          → no action (auto-progressed by render worker)
 *   PROPOSED     → "Edit in Pin Editor" — disabled in v1 (Wave 3 Stream L
 *                  will build /projects/[id]/drones/[shoot]/edit/[shot]).
 *                  Tooltip explains.
 *   ADJUSTMENTS  → "Approve" — calls drone-render-approve Edge Function with
 *                  target_state='final'.
 *   ANY          → "Reject" — calls drone-render-approve with target_state='rejected'.
 *   FINAL        → "Download" — links to dropbox_path (resolved via shared link
 *                  if available; otherwise opens dropbox.com path).
 *
 * Realtime: subscribes to DroneRender (filtered by shoot's shots).
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Pencil,
  Check,
  ChevronRight,
  ChevronLeft,
  RotateCcw,
  X,
  Download,
  Loader2,
  AlertCircle,
  Layers,
  Sparkles,
  Lock,
  RefreshCw,
  ThumbsDown,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/auth/PermissionGuard";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import DroneLightbox from "@/components/drone/DroneLightbox";
import { enqueueFetch } from "@/utils/mediaPerf";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY || "";

// Direct-fetch helper for one-shot downloads. Bypasses SHARED_THUMB_CACHE
// because (a) downloads pull a fresh full-resolution copy each time and
// (b) we revoke the blob URL ~1s after triggering the save, so caching it
// would corrupt the cache for any other consumer that read the same key.
async function _downloadProxyBlob(path) {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/getDeliveryMediaFeed`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SUPABASE_ANON}`,
      },
      body: JSON.stringify({ action: "proxy", file_path: path }),
    },
  );
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  return res.blob();
}

// Below this viewport width the 5-column swimlane truncates headers to
// "RAW PROP / RAW ACCE / AI PROP / ADJUS / FINA" and squeezes cards under
// 90px wide — unusable on iPad-landscape (1456×840). Collapse to a single
// column with a stage selector instead. Threshold is 1500px so a typical
// 13" laptop in split-screen / Safari with sidebar still gets the full grid.
const COMPACT_BREAKPOINT_PX = 1500;

function useIsCompactSwimlane() {
  const [compact, setCompact] = useState(() =>
    typeof window !== "undefined" && window.innerWidth < COMPACT_BREAKPOINT_PX,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => {
      setCompact(window.innerWidth < COMPACT_BREAKPOINT_PX);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return compact;
}

const COLUMNS = [
  { key: "raw_proposed", label: "Raw Proposed", tone: "border-slate-300 dark:border-slate-700" },
  { key: "raw_accepted", label: "Raw Accepted", tone: "border-amber-300 dark:border-amber-800" },
  { key: "proposed",     label: "AI Proposed",  tone: "border-purple-300 dark:border-purple-800" },
  { key: "adjustments",  label: "Adjustments",  tone: "border-indigo-300 dark:border-indigo-800" },
  { key: "final",        label: "Final",        tone: "border-emerald-300 dark:border-emerald-800" },
];

const COLUMN_HEADER_TONE = {
  raw_proposed: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  raw_accepted: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  proposed:     "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  adjustments:  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  final:        "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

// Shot columns (Raw Proposed / Raw Accepted) render shot cards instead of
// render cards. Used to switch the column body branch and to suppress drag.
const SHOT_COLUMNS = new Set(["raw_proposed", "raw_accepted"]);

// Mirrors ALLOWED_TRANSITIONS in drone-render-approve. RAW is not a real
// column_state (RAW shows shots without renders), so it can't be a drag source
// or target. Drops onto the same column are no-ops.
const VALID_DROP_TARGETS = {
  proposed:    new Set(["adjustments", "rejected"]),
  adjustments: new Set(["proposed", "final", "rejected"]),
  final:       new Set(["adjustments", "rejected"]),
  // 'rejected' restores via dedicated button — not via drag (no destination column).
};

// Mirror of DroneShotsSubtab.ROLE_LABEL — kept duplicated rather than shared
// because the swimlane uses these in tight inline JSX where importing a
// 6-entry map would be more friction than benefit. Update both when adding
// a new shot_role.
const SHOT_ROLE_LABEL = {
  nadir_grid: "Nadir grid",
  nadir_hero: "Nadir hero",
  orbital: "Orbital",
  oblique_hero: "Oblique hero",
  building_hero: "Building hero",
  ground_level: "Ground",
  unclassified: "Unclassified",
};

// projectId threads through to RenderCard so the Edit-Pin link can build a
// /DronePinEditor URL.
export default function DroneRendersSubtab({ shoot, projectId }) {
  const queryClient = useQueryClient();
  const shootId = shoot?.id;
  const { isManagerOrAbove } = usePermissions();

  // Confirmation dialog state for reject (destructive)
  const [confirmReject, setConfirmReject] = useState(null); // { render }
  // Lightbox state — stores { columnKey, index, itemId } so the viewer can
  // flick through items in that column without leaving the page. itemId is
  // tracked so we can detect when the currently-viewed item disappears from
  // the column (e.g. operator approved a render in another tab) and close
  // the lightbox with a toast (QC3 #15) rather than silently jump to a
  // different image at the same index.
  const [lightbox, setLightbox] = useState(null); // { columnKey, index, itemId }
  // Drag state — tracks which render is mid-drag so we can highlight valid
  // drop targets and ignore invalid drops without a network round-trip.
  const [dragRender, setDragRender] = useState(null); // { id, fromColumn }

  // iPad-landscape (1456px) collapses the 5-column grid into a single column
  // with a stage selector — at that width headers were truncating to
  // "RAW PROP / RAW ACCE / AI PROP / ADJUS / FINA" and cards squeezed under
  // 90px wide. Default to the first column with content so opening the tab
  // doesn't land on an empty stage.
  const isCompact = useIsCompactSwimlane();
  const [activeColumnKey, setActiveColumnKey] = useState(COLUMNS[0].key);

  // ── Fetch shots (needed for the RAW column) ─────────────────────────────────
  const shotsKey = ["drone_shots_for_renders", shootId];
  const shotsQuery = useQuery({
    queryKey: shotsKey,
    queryFn: () =>
      api.entities.DroneShot.filter({ shoot_id: shootId }, "dji_index", 2000),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  // ── Fetch renders (any column_state) ───────────────────────────────────────
  // Renders FK to shots, not directly to shoots — pull all renders, then
  // filter client-side by membership in this shoot's shot ids. RLS will
  // already restrict the response to renders the user can see.
  const rendersKey = ["drone_renders", shootId];
  const rendersQuery = useQuery({
    queryKey: rendersKey,
    queryFn: async () => {
      const shots = shotsQuery.data || [];
      if (shots.length === 0) return [];
      const shotIds = shots.map((s) => s.id);
      const rows = await api.entities.DroneRender.filter(
        { shot_id: { $in: shotIds } },
        "-created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(shootId) && shotsQuery.isSuccess && (shotsQuery.data?.length || 0) > 0,
    staleTime: 15_000,
  });

  // Realtime: invalidate renders on any insert/update/delete for our shots.
  // We re-subscribe whenever the shot set changes (#69) so newly-ingested
  // shots are not silently filtered out. The current api wrapper does not
  // expose Supabase's server-side `filter` channel option (#68), so we keep
  // a defensive client-side `shotIdSet.has` filter while resubscribing — the
  // resubscribe is keyed off `shotsQuery.data?.length` so adding a shot
  // tears down the stale subscription and starts a fresh one with the
  // up-to-date set rather than capturing the closure's stale set.
  //
  // (QC3 #2) Throttle invalidations to a 2s window — bursts of 30 inserts
  // during ingest used to trigger 30 refetches; now they coalesce into one
  // immediate fire + one trailing fire at window-end. Pattern copied from
  // DroneCommandCenter `throttledInvalidate`.
  const shotIdsSignature = useMemo(() => {
    const ids = (shotsQuery.data || []).map((s) => s.id);
    ids.sort();
    return ids.join(",");
  }, [shotsQuery.data]);

  const INVALIDATE_WINDOW_MS = 2000;
  const invalidateThrottleRef = useRef(new Map()); // keyStr → { last, timeout }
  const throttledInvalidate = useCallback(
    (keyArr) => {
      const keyStr = JSON.stringify(keyArr);
      const map = invalidateThrottleRef.current;
      const now = Date.now();
      const entry = map.get(keyStr) || { last: 0, timeout: null };
      const elapsed = now - entry.last;
      if (elapsed >= INVALIDATE_WINDOW_MS) {
        if (entry.timeout) {
          clearTimeout(entry.timeout);
          entry.timeout = null;
        }
        entry.last = now;
        map.set(keyStr, entry);
        queryClient.invalidateQueries({ queryKey: keyArr });
      } else if (!entry.timeout) {
        const remaining = INVALIDATE_WINDOW_MS - elapsed;
        entry.timeout = setTimeout(() => {
          entry.last = Date.now();
          entry.timeout = null;
          map.set(keyStr, entry);
          queryClient.invalidateQueries({ queryKey: keyArr });
        }, remaining);
        map.set(keyStr, entry);
      }
    },
    [queryClient],
  );

  // Cleanup any pending throttle timers on unmount so trailing invalidates
  // don't fire against an unmounted query client.
  useEffect(() => {
    return () => {
      const map = invalidateThrottleRef.current;
      for (const [, entry] of map) {
        if (entry.timeout) clearTimeout(entry.timeout);
      }
      map.clear();
    };
  }, []);

  useEffect(() => {
    if (!shootId) return;
    if (!shotIdsSignature) return; // wait for shotsQuery to resolve with ids
    const shotIdSet = new Set(shotIdsSignature.split(","));
    if (shotIdSet.size === 0) return;
    let active = true;

    const unsubscribe = api.entities.DroneRender.subscribe((evt) => {
      if (!active) return;
      // (QC3 #1) DELETE events have evt.data === null — the previous
      // `if (evt.data?.shot_id && !set.has(...))` short-circuited to false on
      // deletes, so EVERY drone_render delete app-wide invalidated this
      // shoot's queries. Flip the guard so we only proceed when shot_id is
      // present AND in our set.
      if (!evt.data?.shot_id || !shotIdSet.has(evt.data.shot_id)) return;
      throttledInvalidate(["drone_renders", shootId]);
    });

    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[DroneRendersSubtab] DroneRender unsubscribe failed:", e);
      }
    };
  }, [shootId, shotIdsSignature, throttledInvalidate]);

  // Realtime: DroneShot updates (lifecycle_state changes from accept/reject/
  // restore actions, and inserts/updates from upstream ingest). Filter by
  // shoot_id client-side; the api wrapper does not expose Supabase's server
  // filter option (mirrors the DroneRender pattern above).
  //
  // (QC3 #1) Same DELETE-event guard fix as above — for deletes evt.data is
  // null and the prior short-circuit fail-opened the shoot_id check.
  useEffect(() => {
    if (!shootId) return;
    let active = true;
    const unsubscribe = api.entities.DroneShot.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.shoot_id || evt.data.shoot_id !== shootId) return;
      throttledInvalidate(["drone_shots_for_renders", shootId]);
    });
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[DroneRendersSubtab] DroneShot unsubscribe failed:", e);
      }
    };
  }, [shootId, throttledInvalidate]);

  const shots = shotsQuery.data || [];
  const renders = rendersQuery.data || [];

  // Index shots by id for card display
  const shotsById = useMemo(() => {
    const m = new Map();
    for (const s of shots) m.set(s.id, s);
    return m;
  }, [shots]);

  // Group renders by column_state, then by shot_id within each column. With
  // multi-variant rendering, multiple `drone_renders` rows can exist for one
  // (shot, column_state) pair (one per output_variant). The UI shows ONE
  // card per shot per column with a variant selector — primary variant is
  // the most-recently-created within the group.
  //
  // The new shot-level columns (raw_proposed / raw_accepted / shot_rejected)
  // are derived from `drone_shots.lifecycle_state` (added in migration 242):
  //   raw_proposed | raw_accepted | rejected | sfm_only.
  // SfM-only shots (nadir grid) never appear in the swimlane.
  //
  // (QC3 #4) Optimistic overlays: `optimisticRenderColumns` and
  // `optimisticShotStates` move cards into their target column visually
  // before the server confirms — drag-drop feels instant instead of
  // "stuck for 600ms then jumps". The overlay is cleared on server success
  // (the realtime refetch then carries the authoritative truth) or on
  // failure (rollback shows the card back in the source column).
  const grouped = useMemo(() => {
    const cols = {
      preview: new Map(),
      proposed: new Map(),
      adjustments: new Map(),
      final: new Map(),
      rejected: new Map(),
    };

    // Renders arrive newest-first (-created_at) so the first row encountered
    // for each shot in a bucket is the primary variant.
    for (const r of renders) {
      // Apply optimistic column override if this render is mid-transition.
      // We DON'T mutate r — just route it into the target bucket. preview
      // renders are skipped from the overlay (they're internal, not
      // operator-driven). Same for r.column_state === overlay (no-op).
      const overlayState = optimisticRenderColumns[r.id];
      const col =
        overlayState && r.column_state !== "preview"
          ? overlayState
          : (r.column_state || "proposed");
      const bucket = cols[col];
      if (!bucket) continue;
      if (!bucket.has(r.shot_id)) bucket.set(r.shot_id, []);
      bucket.get(r.shot_id).push(r);
    }

    const toGroups = (m) =>
      Array.from(m.values()).map((variants) => ({
        shot_id: variants[0].shot_id,
        variants,
      }));

    // Shot columns: filter by lifecycle_state. Older rows that pre-date
    // migration 242 may have a NULL lifecycle_state — surface those as
    // raw_proposed so they're visible (the operator can act on them).
    // (QC3 #4) optimisticShotStates wins over the persisted value so a
    // pending Accept/Reject moves the card immediately.
    const effectiveLifecycle = (s) =>
      optimisticShotStates[s.id] ||
      s.lifecycle_state ||
      "raw_proposed";

    const rawProposed = shots.filter((s) => effectiveLifecycle(s) === "raw_proposed");
    const rawAccepted = shots.filter((s) => effectiveLifecycle(s) === "raw_accepted");
    const shotRejected = shots.filter((s) => effectiveLifecycle(s) === "rejected");

    return {
      raw_proposed: rawProposed,
      raw_accepted: rawAccepted,
      shot_rejected: shotRejected,
      preview: cols.preview, // Map<shot_id, variants> for thumbnail lookup
      proposed: toGroups(cols.proposed),
      adjustments: toGroups(cols.adjustments),
      final: toGroups(cols.final),
      rejected: toGroups(cols.rejected),
    };
  }, [renders, shots, optimisticRenderColumns, optimisticShotStates]);

  // Map from shot_id → preview render's dropbox_path (newest variant). Used
  // by Raw Proposed / Raw Accepted cards to show the AI preview when one
  // exists; falls back to the raw shot's dropbox_path otherwise.
  const previewPathByShotId = useMemo(() => {
    const m = new Map();
    for (const [shotId, variants] of grouped.preview) {
      const top = variants[0];
      if (top?.dropbox_path) m.set(shotId, top.dropbox_path);
    }
    return m;
  }, [grouped.preview]);

  // Map from shot_id → preview render's id (newest variant). Used by the
  // "Edit pins" button on Raw Proposed / Raw Accepted cards so the Pin
  // Editor opens against the AI-preview render image when one exists.
  // The Pin Editor falls back to the raw shot path when ?render= is absent
  // or doesn't resolve.
  const previewRenderIdByShotId = useMemo(() => {
    const m = new Map();
    for (const [shotId, variants] of grouped.preview) {
      const top = variants[0];
      if (top?.id) m.set(shotId, top.id);
    }
    return m;
  }, [grouped.preview]);

  // Per-column ordered list of lightbox items. Built once and indexed by the
  // column key so a click on any card can resolve to (columnKey, index) and
  // open DroneLightbox at that position. Items only include cards with a
  // resolvable dropbox_path — anything without a path won't open the lightbox.
  const lightboxItemsByColumn = useMemo(() => {
    const out = {};
    // Shot columns: walk the shots array preserving display order, prefer the
    // AI-preview path (what the operator triages on), fall back to raw.
    const shotColumnItems = (shots) =>
      shots
        .map((s) => {
          const path = previewPathByShotId.get(s.id) || s.dropbox_path || null;
          if (!path) return null;
          return {
            id: s.id,
            dropbox_path: path,
            filename: s.filename || null,
            shot_role: SHOT_ROLE_LABEL[s.shot_role] || s.shot_role || null,
            ai_recommended: Boolean(s.is_ai_recommended),
            status: null,
          };
        })
        .filter(Boolean);

    // Render columns: items[].variants is sorted newest-first. Use the first
    // (primary) variant for the lightbox payload — the swimlane card itself
    // shows that primary thumbnail by default; multi-variant selection only
    // affects download/transition targets, not the visible preview.
    const renderColumnItems = (groups, columnKey) =>
      groups
        .map((g) => {
          const r = g.variants?.[0];
          const path = r?.dropbox_path;
          if (!path) return null;
          const shot = shotsById.get(g.shot_id);
          return {
            id: r.id,
            dropbox_path: path,
            filename: shot?.filename || r.kind || null,
            shot_role: SHOT_ROLE_LABEL[shot?.shot_role] || shot?.shot_role || null,
            ai_recommended: Boolean(shot?.is_ai_recommended),
            status:
              columnKey === "proposed"
                ? "AI Proposed"
                : columnKey === "adjustments"
                ? "Adjustments"
                : columnKey === "final"
                ? "Final"
                : null,
          };
        })
        .filter(Boolean);

    out.raw_proposed = shotColumnItems(grouped.raw_proposed);
    out.raw_accepted = shotColumnItems(grouped.raw_accepted);
    out.proposed = renderColumnItems(grouped.proposed, "proposed");
    out.adjustments = renderColumnItems(grouped.adjustments, "adjustments");
    out.final = renderColumnItems(grouped.final, "final");
    out.rejected = renderColumnItems(grouped.rejected, "rejected").map((it) => ({
      ...it,
      status: "Rejected",
    }));
    return out;
  }, [grouped, shotsById, previewPathByShotId]);

  // ── Transition action (generalised) ───────────────────────────────────────
  // pendingAction map values are short verbs the buttons read to render their
  // spinners ('approving' | 'rejecting' | 'moving' | 'restoring').
  const [pendingAction, setPendingAction] = useState({});

  // (QC3 #4) Optimistic transitions for renders. Keyed by render id; value is
  // the target column_state. Applied as a derived view layer on top of the
  // server data so a drag-drop moves the card visually IMMEDIATELY rather
  // than waiting ~600ms for the realtime event. Cleared on successful server
  // confirmation OR on rollback (server failure).
  const [optimisticRenderColumns, setOptimisticRenderColumns] = useState({});

  // (QC3 #4) Same pattern for shot lifecycle flips. Keyed by shot id; value
  // is the target lifecycle_state.
  const [optimisticShotStates, setOptimisticShotStates] = useState({});

  const TOAST_FOR_TARGET = {
    proposed:    "Sent back to Proposed",
    adjustments: "Moved to Adjustments",
    final:       "Approved → Final",
    rejected:    "Rejected",
    restore:     "Restored from Rejected",
  };
  const VERB_FOR_TARGET = {
    proposed:    "moving",
    adjustments: "moving",
    final:       "approving",
    rejected:    "rejecting",
    restore:     "restoring",
  };

  const callTransition = useCallback(
    async (renderId, targetState) => {
      setPendingAction((p) => ({ ...p, [renderId]: VERB_FOR_TARGET[targetState] || "moving" }));
      // Optimistic: immediately reflect the new column. 'restore' is special —
      // we don't know the destination column until the server resolves it
      // from the event log, so skip the optimistic write for that case.
      if (targetState !== "restore") {
        setOptimisticRenderColumns((p) => ({ ...p, [renderId]: targetState }));
      }
      try {
        const data = await api.functions.invoke("drone-render-approve", {
          render_id: renderId,
          target_state: targetState,
        });
        if (!data?.success) {
          throw new Error(data?.error || `Failed to ${targetState}`);
        }
        toast.success(TOAST_FOR_TARGET[targetState] || `Moved to ${targetState}`);
        queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
        // Clear the optimistic mark on success — the realtime event +
        // refetch will deliver the authoritative state. (We don't clear
        // before invalidate because the refetch is async; the optimistic
        // overlay lets the card stay in the new column until the server
        // data catches up.)
        setOptimisticRenderColumns((p) => {
          const next = { ...p };
          delete next[renderId];
          return next;
        });
      } catch (err) {
        // Rollback the optimistic move so the card flips back to its source
        // column and the operator sees the failure clearly.
        setOptimisticRenderColumns((p) => {
          const next = { ...p };
          delete next[renderId];
          return next;
        });
        toast.error(err?.message || "Action failed");
      } finally {
        setPendingAction((p) => {
          const next = { ...p };
          delete next[renderId];
          return next;
        });
      }
    },
    [queryClient, shootId],
  );

  // ── Shot lifecycle_state mutation ─────────────────────────────────────────
  // Used by Raw Proposed / Raw Accepted card actions and the rejected popover
  // restore. We track per-shot pending state in `pendingShotAction` so a
  // sluggish flip doesn't make the entire column feel stuck.
  //
  // (QC3 #5) Routes through the `drone-shot-lifecycle` Edge Function instead
  // of writing `drone_shots.lifecycle_state` directly via PostgREST. The
  // Edge Function emits a `drone_events` audit row and enforces role gates
  // server-side; direct updates skipped both. Physical Dropbox folder moves
  // are still triggered by the explicit "Lock shortlist" button, NOT by
  // each individual flip — per-click moves would thrash the file path.
  const [pendingShotAction, setPendingShotAction] = useState({});

  const mutateShotLifecycle = useCallback(
    async (shotId, nextState, label) => {
      setPendingShotAction((p) => ({ ...p, [shotId]: nextState }));
      // (QC3 #4) Optimistic: immediately move the card to the destination
      // column so the operator sees instant feedback. Rolled back on error.
      setOptimisticShotStates((p) => ({ ...p, [shotId]: nextState }));
      try {
        const resp = await api.functions.invoke("drone-shot-lifecycle", {
          shot_id: shotId,
          target: nextState,
        });
        // api.functions.invoke wraps the body as { data: serverBody } in
        // some paths; accept either shape.
        const result = resp?.data ?? resp ?? {};
        if (result?.success === false) {
          throw new Error(result?.error || `Failed to move to ${nextState}`);
        }
        toast.success(label || `Moved to ${nextState}`);
        queryClient.invalidateQueries({ queryKey: ["drone_shots_for_renders", shootId] });
        setOptimisticShotStates((p) => {
          const next = { ...p };
          delete next[shotId];
          return next;
        });
      } catch (err) {
        // Rollback so the card flips back to its source column.
        setOptimisticShotStates((p) => {
          const next = { ...p };
          delete next[shotId];
          return next;
        });
        toast.error(err?.message || "Action failed");
      } finally {
        setPendingShotAction((p) => {
          const next = { ...p };
          delete next[shotId];
          return next;
        });
      }
    },
    [queryClient, shootId],
  );

  // ── Lock shortlist ────────────────────────────────────────────────────────
  // Calls the orchestrator-built `drone-shortlist-lock` Edge Function. Surfaces
  // outcomes as toasts so the operator never sees a silent click.
  //
  // Response-shape fix: api.functions.invoke wraps the server body as
  // `{ data: serverBody }`. The previous code read `data?.success` directly
  // on the wrapper (always undefined), so the explicit-failure throw never
  // fired AND a partial-failure with errors[] populated would still show a
  // green "Shortlist locked" toast. Now we unwrap once, accept either shape
  // for forward-compat, and expose partial errors honestly.
  const [isLocking, setIsLocking] = useState(false);
  const lockShortlist = useCallback(async () => {
    if (!shootId) return;
    setIsLocking(true);
    try {
      const resp = await api.functions.invoke("drone-shortlist-lock", {
        shoot_id: shootId,
      });
      // Be defensive: some callers used to read the wrapper directly.
      const result = resp?.data ?? resp ?? {};
      if (result?.success === false) {
        throw new Error(result?.error || "Lock failed");
      }
      // Partial-failure path: server returns success=true but errors[] non-
      // empty. Surface that as a warning so the operator knows to follow up
      // (e.g. one file couldn't be moved because Dropbox webhook hadn't
      // synced its path yet).
      const errs = Array.isArray(result?.errors) ? result.errors : [];
      const moved = result?.moved || {};
      const movedTotal =
        (moved.accepted || 0) + (moved.rejected || 0) + (moved.sfm_only || 0);
      if (errs.length > 0) {
        toast.warning(
          `Shortlist locked with ${errs.length} error${errs.length === 1 ? "" : "s"} — moved ${movedTotal} file${movedTotal === 1 ? "" : "s"}. See console for details.`,
        );
        console.warn("[DroneRendersSubtab] lockShortlist partial errors:", errs);
      } else {
        toast.success(
          movedTotal > 0
            ? `Shortlist locked — moved ${movedTotal} file${movedTotal === 1 ? "" : "s"} into Final Shortlist / Rejected / Others.`
            : "Shortlist locked.",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["drone_shots_for_renders", shootId] });
      queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
    } catch (err) {
      console.error("[DroneRendersSubtab] lockShortlist failed:", err);
      toast.error(err?.message || "Lock shortlist failed");
    } finally {
      setIsLocking(false);
    }
  }, [shootId, queryClient]);

  // ── Lightbox safety: close on item-removed (QC3 #15, #16) ────────────────
  // If the operator is staring at index 7 of 'proposed' and an Approve action
  // (in this tab or another) transitions that render OUT of the column, the
  // lightbox would silently jump to a different item at the same index.
  // Detect "the itemId I was viewing is no longer in the column" and close
  // the lightbox with a brief toast so the operator isn't confused.
  useEffect(() => {
    if (!lightbox || !lightbox.itemId) return;
    const items = lightboxItemsByColumn[lightbox.columnKey] || [];
    if (items.length === 0) {
      // Whole column emptied — close silently (probably a fresh load or the
      // operator drained the column themselves).
      setLightbox(null);
      return;
    }
    const stillThere = items.some((it) => it.id === lightbox.itemId);
    if (!stillThere) {
      const colLabel =
        COLUMNS.find((c) => c.key === lightbox.columnKey)?.label ||
        lightbox.columnKey;
      toast.info(`Item moved out of ${colLabel}`);
      setLightbox(null);
    }
  }, [lightbox, lightboxItemsByColumn]);

  // ── Re-analyse edited folder ──────────────────────────────────────────────
  // After the team uploads to Editors/Edited Post Production/, re-running the
  // renderer wipes & regenerates the AI Proposed cards from those edits.
  const [isReanalysing, setIsReanalysing] = useState(false);
  const reanalyseEdited = useCallback(async () => {
    if (!shootId) return;
    setIsReanalysing(true);
    try {
      const data = await api.functions.invoke("drone-render", {
        shoot_id: shootId,
        kind: "poi_plus_boundary",
        reason: "reanalyse",
      });
      if (data?.success === false) {
        throw new Error(data?.error || "Re-analyse failed");
      }
      toast.success("Re-analysing edited folder — new renders will appear shortly.");
      queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
    } catch (err) {
      toast.error(err?.message || "Re-analyse failed");
    } finally {
      setIsReanalysing(false);
    }
  }, [shootId, queryClient]);

  // ── Stale-render detection (migration 244) ────────────────────────────────
  // Calls the `drone_renders_stale_against_theme` RPC for the current shoot
  // and returns one row per operator-facing render with is_stale flagged when
  // the underlying theme has been edited since the render was produced. Used
  // by RenderCard to amber-badge stale cards and by the header to surface a
  // "Re-render all stale (N)" affordance. Refetched on a 30s stale window so
  // theme edits in another tab become visible without manual refresh.
  const staleQ = useQuery({
    queryKey: ["drone_renders_stale", shootId],
    queryFn: () => api.rpc("drone_renders_stale_against_theme", { p_shoot_id: shootId }),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });
  const staleByRenderId = useMemo(() => {
    const m = new Map();
    for (const r of staleQ.data || []) m.set(r.render_id, r);
    return m;
  }, [staleQ.data]);
  const staleRenderIds = useMemo(
    () => (staleQ.data || []).filter((r) => r.is_stale).map((r) => r.render_id),
    [staleQ.data],
  );

  // ── Re-render with current theme (per shot OR for all stale) ─────────────
  // Calls drone-render with wipe_existing=true so the prior 'proposed' row
  // for the matched shot(s) is cleared before the fresh render lands. We
  // invalidate both renders + stale queries so the badge disappears and the
  // new card appears once the dispatcher picks it up.
  //
  // Per-card path: pass shot_id to scope the wipe + re-render to one shot.
  // Header path: omit shot_id so the whole shoot's stale renders are
  // re-generated. Either way kind is poi_plus_boundary (the default lane).
  const [pendingRerenderShotId, setPendingRerenderShotId] = useState(null);
  const [isRerenderingAll, setIsRerenderingAll] = useState(false);

  const reRenderShot = useCallback(
    async (shotId) => {
      if (!shootId || !shotId) return;
      setPendingRerenderShotId(shotId);
      try {
        const data = await api.functions.invoke("drone-render", {
          shoot_id: shootId,
          shot_id: shotId,
          kind: "poi_plus_boundary",
          wipe_existing: true,
          reason: "stale_theme_rerender",
        });
        if (data?.success === false) {
          throw new Error(data?.error || "Re-render failed");
        }
        toast.success("Re-rendering with current theme — new render will appear shortly.");
        queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
        queryClient.invalidateQueries({ queryKey: ["drone_renders_stale", shootId] });
      } catch (err) {
        toast.error(err?.message || "Re-render failed");
      } finally {
        setPendingRerenderShotId(null);
      }
    },
    [shootId, queryClient],
  );

  const reRenderAllStale = useCallback(async () => {
    if (!shootId) return;
    setIsRerenderingAll(true);
    try {
      const data = await api.functions.invoke("drone-render", {
        shoot_id: shootId,
        kind: "poi_plus_boundary",
        wipe_existing: true,
        reason: "stale_theme_rerender_all",
      });
      if (data?.success === false) {
        throw new Error(data?.error || "Re-render failed");
      }
      toast.success("Re-rendering all stale cards — they'll refresh once the worker completes.");
      queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
      queryClient.invalidateQueries({ queryKey: ["drone_renders_stale", shootId] });
    } catch (err) {
      toast.error(err?.message || "Re-render failed");
    } finally {
      setIsRerenderingAll(false);
    }
  }, [shootId, queryClient]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (shotsQuery.isLoading || rendersQuery.isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-2 animate-pulse">
        {COLUMNS.map((c) => (
          <div key={c.key} className="space-y-2">
            <div className="h-8 bg-muted rounded" />
            <div className="h-24 bg-muted rounded" />
            <div className="h-24 bg-muted rounded" />
          </div>
        ))}
      </div>
    );
  }

  const error = shotsQuery.error || rendersQuery.error;
  if (error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="font-medium">Failed to load renders</p>
          <p className="text-xs mt-0.5">{error.message || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  if (shots.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          No shots indexed yet — renders will appear once shots arrive.
        </CardContent>
      </Card>
    );
  }

  // (QC3 #16) sfm_only-only shoots: a shoot with only nadir_grid frames
  // (used for camera alignment) ends up with every shot's lifecycle_state
  // set to 'sfm_only' — those are filtered out of every column. The
  // operator would otherwise see a "rendered" page with NOTHING and no
  // header buttons. Surface a clear explanation instead.
  const allShotsAreSfmOnly =
    shots.length > 0 &&
    shots.every((s) => s.lifecycle_state === "sfm_only");
  if (allShotsAreSfmOnly) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground/80 mb-1">
            All shots in this shoot are SfM-only.
          </p>
          <p className="text-xs">
            Nadir-grid frames are used for camera alignment, not delivery —
            they don't appear in the swimlane. If you expected operator-
            facing renders, check that the shoot has hero / orbital /
            oblique frames in its source folder.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Header-button visibility:
  //   Lock shortlist → at least one Raw Accepted AND at least one Raw Proposed
  //                    still pending decision (locking would be premature
  //                    otherwise, but also pointless if nothing's left to lock).
  //   Re-analyse     → no Raw Proposed remaining (curation done) AND there are
  //                    edited files to re-analyse. The "edited files exist"
  //                    check is delegated to the function (it'll return a
  //                    polite error if there's nothing to do); we surface the
  //                    button as soon as curation is closed out.
  const hasRawProposed = grouped.raw_proposed.length > 0;
  const hasRawAccepted = grouped.raw_accepted.length > 0;
  const showLockBtn = isManagerOrAbove && hasRawAccepted && hasRawProposed;
  const showReanalyseBtn = isManagerOrAbove && !hasRawProposed && hasRawAccepted;
  const rejectedShotCount = grouped.shot_rejected.length;
  const staleCount = staleRenderIds.length;
  const showRerenderAllBtn = isManagerOrAbove && staleCount > 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        {/* Header actions: Lock shortlist / Re-analyse / Re-render stale / Show rejected */}
        {(showLockBtn || showReanalyseBtn || showRerenderAllBtn || rejectedShotCount > 0) && (
          <div className="flex items-center gap-2 flex-wrap">
            {showLockBtn && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="default"
                    className="h-7 text-xs"
                    onClick={lockShortlist}
                    disabled={isLocking}
                  >
                    {isLocking ? (
                      <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                    ) : (
                      <Lock className="h-3 w-3 mr-1.5" />
                    )}
                    Lock shortlist
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Move accepted files to Final Shortlist, rejected to Rejected, SfM nadirs to Others.
                  After this, the team can drop edited files into Editors/Edited Post Production/.
                </TooltipContent>
              </Tooltip>
            )}
            {showReanalyseBtn && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={reanalyseEdited}
                    disabled={isReanalysing}
                  >
                    {isReanalysing ? (
                      <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1.5" />
                    )}
                    Re-analyse edited folder
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Wipe and regenerate AI Proposed renders from the post-production edits in
                  Editors/Edited Post Production/.
                </TooltipContent>
              </Tooltip>
            )}
            {showRerenderAllBtn && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/40"
                    onClick={reRenderAllStale}
                    disabled={isRerenderingAll}
                  >
                    {isRerenderingAll ? (
                      <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3 mr-1.5" />
                    )}
                    Re-render all stale ({staleCount})
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  The drone theme has been edited since these renders were produced. Click to
                  wipe the stale Proposed cards and regenerate them with the current theme.
                </TooltipContent>
              </Tooltip>
            )}
            {rejectedShotCount > 0 && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="ghost" className="h-7 text-xs">
                    <ThumbsDown className="h-3 w-3 mr-1.5" />
                    Show rejected ({rejectedShotCount})
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-2" align="start">
                  <div className="text-xs font-semibold mb-2 px-1">
                    Rejected raws
                  </div>
                  <div className="max-h-72 overflow-y-auto space-y-1">
                    {grouped.shot_rejected.map((shot) => {
                      const pendingState = pendingShotAction[shot.id];
                      return (
                        <div
                          key={shot.id}
                          className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-muted/60"
                        >
                          <div className="min-w-0">
                            <div className="text-[11px] font-medium truncate">
                              {shot.filename || "—"}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {shot.dji_index != null ? `#${shot.dji_index}` : ""}
                              {shot.shot_role ? ` · ${SHOT_ROLE_LABEL[shot.shot_role] || shot.shot_role}` : ""}
                            </div>
                          </div>
                          {isManagerOrAbove && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-6 text-[10px] px-2 flex-shrink-0"
                              onClick={() =>
                                mutateShotLifecycle(shot.id, "raw_proposed", "Restored")
                              }
                              disabled={Boolean(pendingState)}
                            >
                              {pendingState === "raw_proposed" ? (
                                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                              ) : (
                                <RotateCcw className="h-2.5 w-2.5 mr-1" />
                              )}
                              Restore
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        )}

        {/* Pipeline columns
            ≥1500px: 5-column grid (existing layout).
            <1500px (iPad landscape, narrow laptop split): single column with
            a stage selector at top so cards stay readable instead of being
            squeezed under 90px wide. */}
        {(() => {
          const renderColumn = (col) => (
            <PipelineColumn
              key={col.key}
              column={col}
              items={grouped[col.key] || []}
              isShotColumn={SHOT_COLUMNS.has(col.key)}
              shotsById={shotsById}
              previewPathByShotId={previewPathByShotId}
              previewRenderIdByShotId={previewRenderIdByShotId}
              projectId={projectId}
              shootId={shootId}
              canEdit={isManagerOrAbove}
              pendingAction={pendingAction}
              pendingShotAction={pendingShotAction}
              onTransition={callTransition}
              onMutateShot={mutateShotLifecycle}
              onConfirmReject={(render) => setConfirmReject({ render })}
              onPreview={({ columnKey, itemId }) => {
                const items = lightboxItemsByColumn[columnKey] || [];
                const idx = items.findIndex((it) => it.id === itemId);
                if (idx >= 0) setLightbox({ columnKey, index: idx, itemId });
              }}
              dragRender={dragRender}
              setDragRender={setDragRender}
              staleByRenderId={staleByRenderId}
              onReRenderShot={reRenderShot}
              pendingRerenderShotId={pendingRerenderShotId}
              isCompact={isCompact}
            />
          );

          if (isCompact) {
            const activeCol =
              COLUMNS.find((c) => c.key === activeColumnKey) || COLUMNS[0];
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold flex-shrink-0">
                    Stage
                  </span>
                  <Select
                    value={activeColumnKey}
                    onValueChange={setActiveColumnKey}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {COLUMNS.map((c) => {
                        const items = grouped[c.key] || [];
                        const count = Array.isArray(items)
                          ? items.length
                          : items?.size || 0;
                        return (
                          <SelectItem key={c.key} value={c.key}>
                            {c.label} ({count})
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                </div>
                {renderColumn(activeCol)}
              </div>
            );
          }

          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              {COLUMNS.map(renderColumn)}
            </div>
          );
        })()}

        {/* Rejected drawer (collapsed list under the columns) */}
        {grouped.rejected.length > 0 && (
          <Card>
            <CardContent className="p-3">
              <div className="flex items-center gap-2 mb-2">
                <X className="h-3.5 w-3.5 text-muted-foreground" />
                <h3 className="text-xs font-semibold">
                  Rejected ({grouped.rejected.length})
                </h3>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                {grouped.rejected.map((g) => (
                  <RenderCard
                    key={`rejected-${g.shot_id}`}
                    variants={g.variants}
                    shot={shotsById.get(g.shot_id)}
                    column="rejected"
                    projectId={projectId}
                    shootId={shootId}
                    canEdit={isManagerOrAbove}
                    pendingAction={pendingAction}
                    onTransition={callTransition}
                    onConfirmReject={() => {}}
                    onPreview={({ itemId }) => {
                      const items = lightboxItemsByColumn.rejected || [];
                      const idx = items.findIndex((it) => it.id === itemId);
                      if (idx >= 0) setLightbox({ columnKey: "rejected", index: idx, itemId });
                    }}
                    staleByRenderId={staleByRenderId}
                    onReRenderShot={reRenderShot}
                    pendingRerenderShotId={pendingRerenderShotId}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Lightbox — flick through items in the active column without leaving
          the page. Per-column item lists are precomputed in
          lightboxItemsByColumn so we just hand off (items, initialIndex). */}
      {lightbox && (lightboxItemsByColumn[lightbox.columnKey] || []).length > 0 && (
        <DroneLightbox
          items={lightboxItemsByColumn[lightbox.columnKey]}
          initialIndex={Math.min(
            lightbox.index,
            lightboxItemsByColumn[lightbox.columnKey].length - 1,
          )}
          groupLabel={
            COLUMNS.find((c) => c.key === lightbox.columnKey)?.label ||
            (lightbox.columnKey === "rejected" ? "Rejected" : "")
          }
          onClose={() => setLightbox(null)}
        />
      )}

      {/* Reject confirm dialog */}
      <Dialog
        open={Boolean(confirmReject)}
        onOpenChange={(o) => !o && setConfirmReject(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reject this render?</DialogTitle>
            <DialogDescription>
              The render moves to the Rejected list. You can restore it back
              to its previous column from there if it was rejected by mistake.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmReject(null)}
              disabled={Boolean(pendingAction[confirmReject?.render?.id])}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                const id = confirmReject?.render?.id;
                if (!id) return;
                setConfirmReject(null);
                await callTransition(id, "rejected");
              }}
              disabled={Boolean(pendingAction[confirmReject?.render?.id])}
            >
              {pendingAction[confirmReject?.render?.id] === "rejecting" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <X className="h-4 w-4 mr-2" />
              )}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

// ── PipelineColumn ───────────────────────────────────────────────────────────
function PipelineColumn({
  column,
  items,
  isShotColumn,
  shotsById,
  previewPathByShotId,
  previewRenderIdByShotId,
  projectId,
  shootId,
  canEdit,
  pendingAction,
  pendingShotAction,
  onTransition,
  onMutateShot,
  onConfirmReject,
  onPreview,
  dragRender,
  setDragRender,
  staleByRenderId,
  onReRenderShot,
  pendingRerenderShotId,
  // Compact mode (single-column layout on iPad-landscape) — give the column
  // more vertical room since it's the only one on screen.
  isCompact = false,
}) {
  // A column is a valid drop target only if there's an active drag from a
  // different column AND the transition (fromCol → thisCol) is allowed by the
  // backend's transition rules. Shot columns (Raw Proposed / Raw Accepted)
  // are never drop targets — their cards aren't draggable either, and the
  // render-side transitions don't cross over into the shot lifecycle.
  const validTargets = dragRender ? VALID_DROP_TARGETS[dragRender.fromColumn] : null;
  const isValidDropTarget = Boolean(
    canEdit &&
    dragRender &&
    !isShotColumn &&
    column.key !== dragRender.fromColumn &&
    validTargets?.has(column.key)
  );
  const [isOver, setIsOver] = useState(false);

  const handleDragOver = (e) => {
    if (!isValidDropTarget) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (!isOver) setIsOver(true);
  };
  const handleDragLeave = () => setIsOver(false);
  const handleDrop = (e) => {
    setIsOver(false);
    if (!isValidDropTarget || !dragRender) return;
    e.preventDefault();
    // #70: Guard against rapid drag/drop firing duplicate Edge-Function
    // invocations for the same render. callTransition writes pendingAction[id]
    // for the entire round-trip; bail early if already in flight.
    if (pendingAction[dragRender.id]) {
      setDragRender(null);
      return;
    }
    const target = column.key === "rejected" ? "rejected" : column.key;
    onTransition(dragRender.id, target);
    setDragRender(null);
  };

  const emptyLabel =
    column.key === "raw_proposed"
      ? "No raws to triage"
      : column.key === "raw_accepted"
      ? "Accept raws to stage them here"
      : isOver
      ? "Drop here"
      : "Empty";

  return (
    <div
      className={cn(
        "rounded-md border-2 bg-card transition-colors",
        column.tone,
        isOver && "ring-2 ring-primary/60 border-primary/40",
        dragRender && !isValidDropTarget && !isShotColumn && column.key !== dragRender.fromColumn && "opacity-60",
      )}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        className={cn(
          "px-2 py-1.5 text-xs font-semibold flex items-center justify-between rounded-t-sm",
          COLUMN_HEADER_TONE[column.key],
        )}
      >
        <span className="uppercase tracking-wide">{column.label}</span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      <div
        className={cn(
          "p-2 space-y-2 min-h-[120px] overflow-y-auto",
          // In compact mode the column owns the full viewport — give it room
          // to breathe; in grid mode keep the original cap so rows stay tidy.
          isCompact ? "max-h-[70vh]" : "max-h-[480px]",
        )}
      >
        {items.length === 0 ? (
          <div className="text-center py-6 text-[11px] text-muted-foreground">
            {emptyLabel}
          </div>
        ) : isShotColumn ? (
          // Raw Proposed / Raw Accepted: items are drone_shots rows
          items.map((shot) => (
            <ShotLifecycleCard
              key={shot.id}
              shot={shot}
              column={column.key}
              previewPath={previewPathByShotId.get(shot.id) || null}
              previewRenderId={previewRenderIdByShotId.get(shot.id) || null}
              projectId={projectId}
              shootId={shootId}
              canEdit={canEdit}
              pendingShotAction={pendingShotAction}
              onMutateShot={onMutateShot}
              // Inject columnKey so the parent can resolve the index into
              // the right column's lightbox item list.
              onPreview={({ itemId }) =>
                onPreview && onPreview({ columnKey: column.key, itemId })
              }
            />
          ))
        ) : (
          items.map((g) => (
            <RenderCard
              key={`${column.key}-${g.shot_id}`}
              variants={g.variants}
              shot={shotsById.get(g.shot_id)}
              column={column.key}
              projectId={projectId}
              shootId={shootId}
              canEdit={canEdit}
              pendingAction={pendingAction}
              onTransition={onTransition}
              onConfirmReject={onConfirmReject}
              onPreview={({ itemId }) =>
                onPreview && onPreview({ columnKey: column.key, itemId })
              }
              setDragRender={setDragRender}
              staleByRenderId={staleByRenderId}
              onReRenderShot={onReRenderShot}
              pendingRerenderShotId={pendingRerenderShotId}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── ShotLifecycleCard (Raw Proposed / Raw Accepted) ──────────────────────────
//
// Renders a drone_shot in the curate-then-edit pre-render columns. Shows the
// AI preview render thumbnail when one exists (drone_renders row with
// column_state='preview' for this shot) — falls back to the raw image. The
// thumbnail itself isn't a button (we want the action buttons to dominate UX
// for triage); preview opens via a small "expand" icon if useful later.
function ShotLifecycleCard({
  shot,
  column,
  previewPath,
  previewRenderId,
  projectId,
  shootId,
  canEdit,
  pendingShotAction,
  onMutateShot,
  onPreview,
}) {
  // Prefer the AI preview render path when one exists; this is what the
  // operator should be triaging on (shows the would-be deliverable look).
  // DroneThumbnail's media-proxy fetch will gracefully fall back to the icon
  // placeholder if the preview path is invalid; we additionally fall back to
  // the raw shot path for thumbnail purposes.
  const thumbPath = previewPath || shot?.dropbox_path || null;
  const clickPath = thumbPath;
  const isAccepted = column === "raw_accepted";
  const pendingState = pendingShotAction?.[shot.id];
  const isAiRecommended = Boolean(shot?.is_ai_recommended);

  return (
    <div className="rounded-md border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => {
          if (clickPath && onPreview) {
            onPreview({ itemId: shot.id });
          }
        }}
        disabled={!clickPath}
        className="block w-full text-left disabled:cursor-default hover:opacity-95 transition-opacity"
        aria-label={`Preview ${shot.filename || "shot"}`}
      >
        <DroneThumbnail
          dropboxPath={thumbPath}
          mode="thumb"
          alt={shot.filename || "raw drone shot"}
          aspectRatio="aspect-[4/3]"
          overlay={
            isAiRecommended ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="absolute top-1 right-1 inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-blue-600 text-white pointer-events-auto cursor-help">
                    <Sparkles className="h-2.5 w-2.5" />
                    AI
                    <Check className="h-2.5 w-2.5" />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[200px]">
                  Suggested by AI based on dedup, flight roll, and POI coverage.
                </TooltipContent>
              </Tooltip>
            ) : null
          }
        />
      </button>
      <div className="p-2 space-y-1">
        <div className="text-[11px] font-medium truncate" title={shot.filename}>
          {shot.filename || "—"}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {shot.dji_index != null ? `#${shot.dji_index}` : ""}
          {shot.shot_role ? ` · ${SHOT_ROLE_LABEL[shot.shot_role] || shot.shot_role}` : ""}
        </div>

        {/* Triage actions */}
        {canEdit && (
          <div className="flex items-center gap-1 flex-wrap pt-1">
            {/* Edit pins — opens the Pin Editor against the AI preview render
                when one exists for this shot (the Editor falls back to the raw
                shot path otherwise). World-anchored pins persist across every
                future render of every shot in this shoot, so pre-placing
                during the curate phase is meaningful work. */}
            {projectId && shootId && shot?.id && (
              <Button
                asChild
                variant="outline"
                size="sm"
                className="h-6 text-[10px] px-1.5"
                title="Edit pins on this shot — your changes apply to every future render in this shoot."
              >
                <Link
                  to={createPageUrl(
                    `DronePinEditor?project=${projectId}&shoot=${shootId}&shot=${shot.id}${
                      previewRenderId ? `&render=${previewRenderId}` : ""
                    }`,
                  )}
                >
                  <Pencil className="h-2.5 w-2.5 mr-1" />
                  Edit pins
                </Link>
              </Button>
            )}
            {!isAccepted ? (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() => onMutateShot(shot.id, "raw_accepted", "Accepted")}
                  disabled={Boolean(pendingState)}
                  title="Accept this raw — moves to Raw Accepted"
                >
                  {pendingState === "raw_accepted" ? (
                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  ) : (
                    <Check className="h-2.5 w-2.5 mr-1" />
                  )}
                  Accept
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                  onClick={() => onMutateShot(shot.id, "rejected", "Rejected")}
                  disabled={Boolean(pendingState)}
                  title="Reject this raw"
                >
                  {pendingState === "rejected" ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <X className="h-2.5 w-2.5" />
                  )}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5"
                  onClick={() => onMutateShot(shot.id, "raw_proposed", "Sent back to Proposed")}
                  disabled={Boolean(pendingState)}
                  title="Send back to Raw Proposed"
                >
                  {pendingState === "raw_proposed" ? (
                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  ) : (
                    <ChevronLeft className="h-2.5 w-2.5 mr-1" />
                  )}
                  Send back
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                  onClick={() => onMutateShot(shot.id, "rejected", "Rejected")}
                  disabled={Boolean(pendingState)}
                  title="Reject this raw"
                >
                  {pendingState === "rejected" ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <X className="h-2.5 w-2.5" />
                  )}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── RenderCard (cards in proposed / adjustments / final / rejected) ──────────
//
// Accepts a `variants` array (one or more `drone_renders` rows for the same
// (shot, column_state) pair, sorted newest-first by the parent grouper).
// When >1 variant is present, a small selector swaps the displayed thumbnail,
// download link, and approve/reject target.
function RenderCard({
  variants,
  shot,
  column,
  projectId,
  shootId,
  canEdit,
  pendingAction,
  onTransition,
  onConfirmReject,
  onPreview,
  setDragRender,
  staleByRenderId,
  onReRenderShot,
  pendingRerenderShotId,
}) {
  const orderedVariants = useMemo(() => variants || [], [variants]);
  const [selectedVariantId, setSelectedVariantId] = useState(
    orderedVariants[0]?.id || null,
  );

  // (QC3 #9) If the variant set changes (realtime update), keep the
  // selection valid — but ONLY reset when the previously-selected variant is
  // genuinely no longer in the set. The prior implementation reset on every
  // re-render because `orderedVariants` was a new array reference each parent
  // render and the effect ran every render; if the renderCard stayed mounted
  // through a realtime tick where the parent's grouped data changed, the
  // selection silently flipped back to variants[0]. Now we narrow the
  // dependency to a stable signature (sorted variant ids) so the effect
  // only runs when the underlying ID set actually changes, and we emit a
  // console.warn when we have to reset so debugging post-mortems can spot
  // the cause.
  const variantIdSig = useMemo(
    () => orderedVariants.map((v) => v.id).sort().join(","),
    [orderedVariants],
  );
  useEffect(() => {
    if (!orderedVariants.length) return;
    const stillExists = orderedVariants.some((v) => v.id === selectedVariantId);
    if (!stillExists) {
      // Selection target genuinely vanished (variant deleted, moved column,
      // or this is the first render with no prior selection). Fall back to
      // the primary (newest) variant. Surface a warn so operators noticing
      // a downloaded-wrong-variant complaint have a breadcrumb.
      if (selectedVariantId != null) {
        console.warn(
          "[RenderCard] selected variant",
          selectedVariantId,
          "no longer exists; falling back to",
          orderedVariants[0].id,
        );
      }
      setSelectedVariantId(orderedVariants[0].id);
    }
    // Intentionally narrow deps: only re-run when the set of variant ids
    // actually changes, not when the array reference changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantIdSig]);

  // Hooks must be called before any early return (rules-of-hooks).
  // #71: Replace the dropbox.com/home URL (which respects permissions
  // imperfectly and 404s for users without folder access) with a download
  // through the existing media proxy. We fetch the full-resolution blob via
  // fetchMediaProxy(mode='proxy') and trigger a save with the proper filename.
  const [isDownloading, setIsDownloading] = useState(false);
  const selectedRender =
    orderedVariants.find((v) => v.id === selectedVariantId) ||
    orderedVariants[0] ||
    null;
  const handleDownload = useCallback(async () => {
    const path = selectedRender?.dropbox_path;
    if (!path) return;
    setIsDownloading(true);
    let blobUrl = null;
    try {
      // Direct fetch (bypass SHARED_THUMB_CACHE) so the URL we revoke after
      // triggering the save can't poison shared cache entries used by the
      // swimlane / lightbox / shots subtab.
      const blob = await enqueueFetch(() => _downloadProxyBlob(path));
      if (!blob) {
        toast.error("Download failed — proxy returned no blob");
        return;
      }
      blobUrl = URL.createObjectURL(blob);
      const filename =
        shot?.filename ||
        path.split("/").pop() ||
        `drone-${selectedRender.id}.jpg`;
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Defer revocation slightly so Safari/Firefox have the URL still
      // resolvable when the save dialog opens. 1s is the same window
      // mediaActions.downloadFile uses.
      setTimeout(() => {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          /* ignore */
        }
      }, 1000);
    } catch (err) {
      console.error("[DroneRendersSubtab] download failed:", err);
      toast.error(err?.message || "Download failed");
      if (blobUrl) {
        try {
          URL.revokeObjectURL(blobUrl);
        } catch {
          /* ignore */
        }
      }
    } finally {
      setIsDownloading(false);
    }
  }, [selectedRender?.dropbox_path, selectedRender?.id, shot?.filename]);

  const r = selectedRender;
  if (!r) return null;

  const hasMultiVariant = orderedVariants.length > 1;

  const themeName =
    (r.theme_snapshot && (r.theme_snapshot.name || r.theme_snapshot.theme_name)) ||
    (r.theme_snapshot && r.theme_snapshot.id ? "Theme" : null);
  const poiCount =
    (r.theme_snapshot && Array.isArray(r.theme_snapshot.pois) && r.theme_snapshot.pois.length) ||
    (r.pin_overrides && Array.isArray(r.pin_overrides.pois) && r.pin_overrides.pois.length) ||
    null;

  const action = pendingAction[r.id];
  const isFinal = column === "final";
  const isAdjustments = column === "adjustments";
  const isProposed = column === "proposed";
  const isRejected = column === "rejected";

  // Stale detection (migration 244): the swimlane's
  // drone_renders_stale_against_theme RPC returns one row per operator-facing
  // render with the stamped + current theme version_int. We badge cards where
  // is_stale=TRUE and let managers click "Re-render" to wipe the prior
  // proposed render and regenerate from the current theme. Stale lookup is
  // keyed by the SELECTED variant's id (the swimlane RPC returns a row per
  // render id; multi-variant cards' non-selected variants are still tracked
  // but we only badge based on the visible one). Rejected cards are skipped
  // server-side so .get() returns undefined → no badge, which is correct.
  const stale = staleByRenderId?.get(r.id);
  const isStale = Boolean(stale?.is_stale);
  const isRerendering = pendingRerenderShotId === r.shot_id;

  // Cards in the rejected drawer aren't draggable — they only restore via the
  // dedicated Restore button (drag has no meaningful destination column).
  const isDraggable = canEdit && !isRejected && Boolean(setDragRender);

  return (
    <div
      className={cn(
        "rounded-md border bg-card overflow-hidden hover:border-primary/40 transition-colors",
        isDraggable && "cursor-grab active:cursor-grabbing",
      )}
      draggable={isDraggable}
      onDragStart={(e) => {
        if (!isDraggable) return;
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", r.id); // Firefox needs payload
        setDragRender({ id: r.id, fromColumn: column });
      }}
      onDragEnd={() => setDragRender && setDragRender(null)}
    >
      {/* Thumbnail (lazy via mediaPerf proxy). Click → lightbox preview.
          The lightbox payload is keyed by the primary variant's id; the
          parent's lightboxItemsByColumn memo also keys on that id, so
          (column, primary-variant-id) round-trips cleanly. */}
      <button
        type="button"
        onClick={() => {
          if (r.dropbox_path && onPreview) {
            // r is the currently SELECTED variant; the parent's lightbox item
            // list keys off the primary (newest) variant's id. They match for
            // single-variant cards, and for multi-variant cards the primary
            // is what's shown in the column thumbnail by default.
            const primaryId = orderedVariants[0]?.id || r.id;
            onPreview({ itemId: primaryId });
          }
        }}
        disabled={!r.dropbox_path}
        className="block w-full text-left disabled:cursor-default"
        aria-label={`Preview ${r.kind || "render"}`}
      >
        <DroneThumbnail
          dropboxPath={r.dropbox_path}
          mode="thumb"
          alt={shot?.filename || r.kind || "render preview"}
          aspectRatio="aspect-[4/3]"
          overlay={
            r.kind ? (
              <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-background/80 text-foreground/80 pointer-events-none">
                {r.kind}
              </span>
            ) : null
          }
        />
      </button>

      {/* Body */}
      <div className="p-2 space-y-1">
        <div className="text-[11px] font-medium truncate" title={shot?.filename}>
          {shot?.filename || "—"}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {shot?.dji_index != null ? `#${shot.dji_index}` : ""}
          {themeName ? (
            <>
              {shot?.dji_index != null ? " · " : ""}
              <Layers className="h-2.5 w-2.5 inline mr-0.5" />
              {themeName}
            </>
          ) : null}
        </div>

        {/* Variant selector — only render when >1 variant exists for this card */}
        {hasMultiVariant && (
          <div className="pt-0.5">
            <label className="sr-only" htmlFor={`variant-${r.shot_id}-${column}`}>
              Output variant
            </label>
            <select
              id={`variant-${r.shot_id}-${column}`}
              className="w-full h-6 text-[10px] rounded border border-input bg-background px-1.5 py-0 focus:outline-none focus:ring-1 focus:ring-ring"
              value={selectedVariantId || ""}
              onChange={(e) => setSelectedVariantId(e.target.value)}
              aria-label="Select output variant"
            >
              {orderedVariants.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.output_variant || "default"}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex items-center gap-1 flex-wrap">
          {poiCount != null && (
            <Badge variant="outline" className="text-[9px] h-4 px-1">
              {poiCount} POI
            </Badge>
          )}
          {/* Show variant badge only when single-variant — selector covers multi case */}
          {!hasMultiVariant && r.output_variant && r.output_variant !== "default" && (
            <Badge variant="outline" className="text-[9px] h-4 px-1">
              {r.output_variant}
            </Badge>
          )}
          {r.created_at && (
            <span
              className="text-[9px] text-muted-foreground"
              title={format(new Date(r.created_at), "d MMM yyyy, h:mm a")}
            >
              {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
            </span>
          )}
          {/* Stale-theme badge (migration 244). Surfaces the version skew so
              the operator knows the render is behind the current theme; the
              tooltip explains the next step (Re-render button below). */}
          {isStale && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Badge
                  variant="outline"
                  className="border-amber-400 text-amber-700 bg-amber-50 dark:border-amber-600 dark:text-amber-300 dark:bg-amber-950/40 text-[9px] h-4 px-1 gap-0.5 cursor-help"
                >
                  <RefreshCw className="h-2.5 w-2.5" />
                  theme v{stale.current_theme_version_int} (this v{stale.theme_version_int_at_render})
                </Badge>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                The drone theme has been updated since this render was produced.
                Click "Re-render" to apply the latest styling.
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        {/* Actions — operate on the CURRENTLY SELECTED variant */}
        <div className="flex items-center gap-1 flex-wrap pt-1">
          {/* PROPOSED + ADJUSTMENTS → Edit in Pin Editor (Final/Rejected stay locked) */}
          {(isProposed || isAdjustments) && canEdit && projectId && shootId && r.shot_id && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              title={
                isAdjustments
                  ? "Edit pins on this adjustments render — re-saves into Adjustments"
                  : "Edit pins on this AI-proposed render"
              }
            >
              <Link
                to={createPageUrl(`DronePinEditor?project=${projectId}&shoot=${shootId}&shot=${r.shot_id}&render=${r.id}`)}
              >
                <Pencil className="h-2.5 w-2.5 mr-1" />
                Edit
              </Link>
            </Button>
          )}

          {/* PROPOSED → forward to Adjustments (skip Pin Editor when no edits needed) */}
          {isProposed && canEdit && (
            <Button
              variant="default"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => onTransition(r.id, "adjustments")}
              disabled={Boolean(action)}
              title="Looks good — move to Adjustments for final approval"
            >
              {action === "moving" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <ChevronRight className="h-2.5 w-2.5 mr-1" />
              )}
              Approve
            </Button>
          )}

          {/* ADJUSTMENTS → Approve (to Final) */}
          {isAdjustments && canEdit && (
            <Button
              variant="default"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => onTransition(r.id, "final")}
              disabled={Boolean(action)}
            >
              {action === "approving" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <Check className="h-2.5 w-2.5 mr-1" />
              )}
              Approve
            </Button>
          )}

          {/* ADJUSTMENTS → send back to Proposed */}
          {isAdjustments && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              onClick={() => onTransition(r.id, "proposed")}
              disabled={Boolean(action)}
              title="Send back to Proposed"
            >
              <ChevronLeft className="h-2.5 w-2.5" />
            </Button>
          )}

          {/* FINAL → un-approve back to Adjustments */}
          {isFinal && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              onClick={() => onTransition(r.id, "adjustments")}
              disabled={Boolean(action)}
              title="Un-approve and move back to Adjustments"
            >
              {action === "moving" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <ChevronLeft className="h-2.5 w-2.5" />
              )}
            </Button>
          )}

          {/* REJECTED → Restore (back to where it came from) */}
          {isRejected && canEdit && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => onTransition(r.id, "restore")}
              disabled={Boolean(action)}
              title="Restore to its previous column"
            >
              {action === "restoring" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <RotateCcw className="h-2.5 w-2.5 mr-1" />
              )}
              Restore
            </Button>
          )}

          {/* Reject (any non-rejected, non-final column) */}
          {!isRejected && !isFinal && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
              onClick={() => onConfirmReject(r)}
              disabled={Boolean(action)}
              title="Reject this render"
            >
              {action === "rejecting" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <X className="h-2.5 w-2.5" />
              )}
            </Button>
          )}

          {/* FINAL → Download (via media proxy — see #71) */}
          {isFinal && r.dropbox_path && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={handleDownload}
              disabled={isDownloading}
              title="Download via media proxy"
            >
              {isDownloading ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <Download className="h-2.5 w-2.5 mr-1" />
              )}
              Download
            </Button>
          )}

          {/* Stale-theme per-card re-render (migration 244). Routes through
              drone-render with wipe_existing=true scoped to this shot — the
              prior 'proposed' row is cleared and a fresh render is enqueued
              from the current theme. Hidden in the Rejected drawer (the RPC
              already excludes 'rejected' so isStale won't be true there) but
              we extra-guard with !isRejected for clarity. */}
          {isStale && canEdit && !isRejected && onReRenderShot && r.shot_id && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-2 border-amber-400 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-300 dark:hover:bg-amber-950/40"
              onClick={() => onReRenderShot(r.shot_id)}
              disabled={isRerendering || Boolean(action)}
              title="Re-render this shot with the current theme"
            >
              {isRerendering ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <RefreshCw className="h-2.5 w-2.5 mr-1" />
              )}
              Re-render
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

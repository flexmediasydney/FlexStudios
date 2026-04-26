/**
 * DroneRendersSubtab — Drone Wave 5 P2 (raw-only)
 *
 * Wave 5 P2 S6: this subtab now manages the RAW pipeline only. The 5-column
 * curate-then-edit-then-render swimlane was reduced to a 3-column raw triage.
 * Wave 13 D added a 4th post-editor column (Editor Returned) so the operator
 * can review editor deliveries on the same swimlane:
 *
 *   ┌ RAW POOL ─────────┬ RAW ACCEPTED ─────┬ EDITOR RETURNED ──┬ REJECTED ────────┐
 *   │ shots (untriaged) │ shots (kept)      │ editor delivered  │ shots (dropped)  │
 *   │ Accept / Reject   │ Send back / Reject│ Final / Reject /  │ Restore           │
 *   │                   │                   │ Revert (mgr+)     │                   │
 *   └───────────────────┴───────────────────┴───────────────────┴───────────────────┘
 *
 * Edited renders (proposed / adjustments / final) live in the new
 * DroneEditsSubtab, fed by the Wave 5 P2 edited-pipeline. Pin Editor entry
 * was removed from this raw subtab entirely — it is now per-card on Edited
 * cards only (S4's contract: PinEditor is edited-only).
 *
 * Drag-drop is gone. Each card has explicit buttons for column transitions —
 * mirrors the DroneShotsSubtab card affordance pattern, and avoids the E1/E40
 * React #310 mount crash that previously happened on raw cards mounting Pin
 * Editor entry points.
 *
 * Header actions retained:
 *   • "Lock shortlist" — gates raw triage closed and triggers editor handoff
 *     (downstream: editor uploads to /Drones/Editors/AI Proposed Enriched/,
 *     dropbox-webhook detects + initiates the edited pipeline).
 *   • "Show rejected (N)" — popover listing rejected raws with Restore.
 *   • Theme stamp re-render still surfaces stale renders (raw side).
 *
 * Renders query is filtered to `pipeline='raw'` so edited-pipeline events
 * don't trigger raw-side refetches. Raw rows pre-mig 282 had NULL pipeline
 * and now default to 'raw' (mig 282 sets DEFAULT 'raw' NOT NULL).
 *
 * iPad collapse: below 1024px the 3-column grid becomes a single column with
 * a stage selector (Pool / Accepted / Rejected).
 *
 * Props: { shoot, projectId }
 *
 * Realtime: subscribes to DroneRender (filtered by shoot's shots and
 * pipeline='raw') and DroneShot updates.
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
// QC iter 6 C: confirm dialogs for irreversible editor_returned actions
// (Mark Final / Reject editor delivery — QC iter 5 P1-6).
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Check,
  ChevronLeft,
  RotateCcw,
  X,
  Loader2,
  AlertCircle,
  Sparkles,
  Lock,
  RefreshCw,
  ThumbsDown,
  Pencil,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/auth/PermissionGuard";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import DroneLightbox from "@/components/drone/DroneLightbox";
import DroneSwimlaneLockOverlay from "@/components/drone/DroneSwimlaneLockOverlay";
import DroneStageProgress from "@/components/drone/DroneStageProgress";

// W1-ε iPad collapse: at <1024px the 3-column grid squeezes cards uncomfortably.
// Below this width we collapse to a single column with a stage selector.
const COMPACT_BREAKPOINT_PX = 1024;

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

// Wave 13 D: 4-column swimlane (was 3). The new editor_returned column sits
// between Raw Accepted and Rejected because it represents a forward step
// (post-editor delivery, awaiting operator review). Source: drone_shots
// WHERE lifecycle_state='editor_returned' (mig 324). The column is one-way
// forward — Send to Pool is hidden; Mark Final / Reject / Revert are exposed
// for managers+. Service-role (dropbox-webhook) is the canonical setter for
// the raw_accepted → editor_returned transition (W13 S2).
const COLUMNS = [
  { key: "raw_proposed",    label: "Raw Pool",        tone: "border-slate-300 dark:border-slate-700" },
  { key: "raw_accepted",    label: "Raw Accepted",    tone: "border-amber-300 dark:border-amber-800" },
  { key: "editor_returned", label: "Editor Returned", tone: "border-blue-300 dark:border-blue-800" },
  { key: "rejected",        label: "Rejected",        tone: "border-red-300 dark:border-red-800" },
];

const COLUMN_HEADER_TONE = {
  raw_proposed:    "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  raw_accepted:    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  editor_returned: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  rejected:        "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

// Mirror of DroneShotsSubtab.ROLE_LABEL.
const SHOT_ROLE_LABEL = {
  nadir_grid: "Nadir grid",
  nadir_hero: "Nadir hero",
  orbital: "Orbital",
  oblique_hero: "Oblique hero",
  building_hero: "Building hero",
  ground_level: "Ground",
  unclassified: "Unclassified",
};

// Wave 5 P2 S6: projectId is intentionally not consumed — Pin Editor entry
// was removed (now edited-only on DroneEditsSubtab) and the Re-render Edge
// Function takes shoot_id only. Prefix with _ so the lint rule lets it pass
// while keeping the ProjectDronesTab call signature stable.
//
// Wave 9 S3: pipelineState (from ProjectDronesTab → useDronePipelineState)
// drives the swimlane lock + the in-context compact stage strip. When the
// lock is active, all triage cards become non-interactive behind the
// overlay (architect Section C.4).
export default function DroneRendersSubtab({ shoot, projectId: _projectId, pipelineState = null }) {
  const queryClient = useQueryClient();
  const shootId = shoot?.id;
  const { isManagerOrAbove } = usePermissions();

  // Lightbox state — { columnKey, index, itemId }
  const [lightbox, setLightbox] = useState(null);

  // QC iter 6 C: confirm-dialog state for irreversible editor_returned
  // actions (Mark Final / Reject editor delivery). Per QC iter 5 P1-6 these
  // mutations are one-way → operator should confirm before firing.
  // Shape: { shotId, target: 'final'|'rejected', label, filename } | null
  const [confirmEditorAction, setConfirmEditorAction] = useState(null);

  // iPad collapse: default to first column with content (or just first column).
  const isCompact = useIsCompactSwimlane();
  const [activeColumnKey, setActiveColumnKey] = useState(COLUMNS[0].key);

  // ── Fetch shots ─────────────────────────────────────────────────────────────
  const shotsKey = ["drone_shots_for_renders", shootId];
  const shotsQuery = useQuery({
    queryKey: shotsKey,
    queryFn: () =>
      api.entities.DroneShot.filter({ shoot_id: shootId }, "dji_index", 2000),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  // ── Fetch renders (RAW pipeline only) ───────────────────────────────────────
  // Wave 5 P2 S6: filter to pipeline='raw' so edited-pipeline rows never
  // surface here (they live in DroneEditsSubtab). Mig 282 set the column
  // DEFAULT to 'raw' NOT NULL so legacy NULL rows are now 'raw' on disk.
  const rendersKey = ["drone_renders_raw", shootId];
  const rendersQuery = useQuery({
    queryKey: rendersKey,
    queryFn: async () => {
      const shots = shotsQuery.data || [];
      if (shots.length === 0) return [];
      const shotIds = shots.map((s) => s.id);
      const rows = await api.entities.DroneRender.filter(
        { shot_id: { $in: shotIds }, pipeline: "raw" },
        "-created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(shootId) && shotsQuery.isSuccess && (shotsQuery.data?.length || 0) > 0,
    staleTime: 15_000,
  });

  // (QC3 #2) Throttled invalidate to coalesce realtime bursts.
  const shotIdsSignature = useMemo(() => {
    const ids = (shotsQuery.data || []).map((s) => s.id);
    ids.sort();
    return ids.join(",");
  }, [shotsQuery.data]);

  const INVALIDATE_WINDOW_MS = 2000;
  const invalidateThrottleRef = useRef(new Map());
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

  useEffect(() => {
    return () => {
      const map = invalidateThrottleRef.current;
      for (const [, entry] of map) {
        if (entry.timeout) clearTimeout(entry.timeout);
      }
      map.clear();
    };
  }, []);

  // Realtime: drone_renders for this shoot's shots, raw pipeline only.
  // Wave 5 P2 S6: client-side check on evt.data?.pipeline === 'raw' so
  // edited-pipeline events don't trigger raw refetches. The api.entities
  // wrapper doesn't expose Postgres CDC server-side filters, so we filter
  // in the callback.
  useEffect(() => {
    if (!shootId) return;
    if (!shotIdsSignature) return;
    const shotIdSet = new Set(shotIdsSignature.split(","));
    if (shotIdSet.size === 0) return;
    let active = true;

    const unsubscribe = api.entities.DroneRender.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.shot_id || !shotIdSet.has(evt.data.shot_id)) return;
      // Filter to raw pipeline; treat null pipeline as 'raw' (legacy rows).
      const pipeline = evt.data.pipeline || "raw";
      if (pipeline !== "raw") return;
      throttledInvalidate(["drone_renders_raw", shootId]);
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

  // Realtime: drone_shots updates (lifecycle_state changes, ingest inserts).
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

  // Optimistic shot lifecycle overlays (declared above `grouped`).
  const [optimisticShotStates, setOptimisticShotStates] = useState({});

  // Group shots by lifecycle_state — these are the only columns now.
  // Renders contribute only the AI preview thumbnail (column_state='preview').
  const grouped = useMemo(() => {
    const previewByShot = new Map();
    for (const r of renders) {
      if (r.column_state !== "preview") continue;
      // Renders are sorted -created_at; first hit is newest.
      if (!previewByShot.has(r.shot_id)) previewByShot.set(r.shot_id, r);
    }

    const effectiveLifecycle = (s) =>
      optimisticShotStates[s.id] ||
      s.lifecycle_state ||
      "raw_proposed";

    const rawProposed = shots.filter((s) => effectiveLifecycle(s) === "raw_proposed");
    const rawAccepted = shots.filter((s) => effectiveLifecycle(s) === "raw_accepted");
    // Wave 13 D: editor_returned bucket — populated by dropbox-webhook when
    // an editor's delivery lands in /Drones/Editors/Edited Post Production/.
    const editorReturned = shots.filter((s) => effectiveLifecycle(s) === "editor_returned");
    const shotRejected = shots.filter((s) => effectiveLifecycle(s) === "rejected");

    return {
      raw_proposed: rawProposed,
      raw_accepted: rawAccepted,
      editor_returned: editorReturned,
      rejected: shotRejected,
      previewByShot,
    };
  }, [renders, shots, optimisticShotStates]);

  // Map shot_id → preview render's dropbox_path / id (newest variant).
  const previewPathByShotId = useMemo(() => {
    const m = new Map();
    for (const [shotId, r] of grouped.previewByShot) {
      if (r?.dropbox_path) m.set(shotId, r.dropbox_path);
    }
    return m;
  }, [grouped.previewByShot]);

  // Per-column ordered lightbox items.
  const lightboxItemsByColumn = useMemo(() => {
    const out = {};
    const buildItems = (shotsArr) =>
      shotsArr
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

    out.raw_proposed = buildItems(grouped.raw_proposed);
    out.raw_accepted = buildItems(grouped.raw_accepted);
    out.editor_returned = buildItems(grouped.editor_returned);
    out.rejected = buildItems(grouped.rejected);
    return out;
  }, [grouped, previewPathByShotId]);

  // ── Shot lifecycle mutation ───────────────────────────────────────────────
  const [pendingShotAction, setPendingShotAction] = useState({});

  const mutateShotLifecycle = useCallback(
    async (shotId, nextState, label) => {
      setPendingShotAction((p) => ({ ...p, [shotId]: nextState }));
      setOptimisticShotStates((p) => ({ ...p, [shotId]: nextState }));
      try {
        const resp = await api.functions.invoke("drone-shot-lifecycle", {
          shot_id: shotId,
          target: nextState,
        });
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
  // Wave 5 P2 S6: this is the gate that finalises raw triage and triggers the
  // editors handoff. Downstream: editor uploads land in
  // /Drones/Editors/AI Proposed Enriched/, dropbox-webhook (Task 4) detects
  // those drops + initiates the edited pipeline (poi_fetch + render_edited).
  const [isLocking, setIsLocking] = useState(false);
  const lockShortlist = useCallback(async () => {
    if (!shootId) return;
    setIsLocking(true);
    try {
      const resp = await api.functions.invoke("drone-shortlist-lock", {
        shoot_id: shootId,
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.success === false) {
        throw new Error(result?.error || "Lock failed");
      }
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
            ? `Shortlist locked — moved ${movedTotal} file${movedTotal === 1 ? "" : "s"}. Editors can now drop into AI Proposed Enriched.`
            : "Shortlist locked.",
        );
      }
      queryClient.invalidateQueries({ queryKey: ["drone_shots_for_renders", shootId] });
      queryClient.invalidateQueries({ queryKey: ["drone_renders_raw", shootId] });
    } catch (err) {
      console.error("[DroneRendersSubtab] lockShortlist failed:", err);
      toast.error(err?.message || "Lock shortlist failed");
    } finally {
      setIsLocking(false);
    }
  }, [shootId, queryClient]);

  // Lightbox safety: close on item-removed.
  useEffect(() => {
    if (!lightbox || !lightbox.itemId) return;
    const items = lightboxItemsByColumn[lightbox.columnKey] || [];
    if (items.length === 0) {
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

  // ── Stale-render detection (mig 244) — still raw-side. ────────────────────
  // The RPC returns rows for raw renders that are behind the current theme.
  // Header gets the "Re-render all stale (N)" button when count > 0.
  const staleQ = useQuery({
    queryKey: ["drone_renders_stale", shootId],
    queryFn: () => api.rpc("drone_renders_stale_against_theme", { p_shoot_id: shootId }),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });
  const staleRenderIds = useMemo(
    () => (staleQ.data || []).filter((r) => r.is_stale).map((r) => r.render_id),
    [staleQ.data],
  );

  const [isRerenderingAll, setIsRerenderingAll] = useState(false);
  const reRenderAllStale = useCallback(async () => {
    if (!shootId) return;
    setIsRerenderingAll(true);
    try {
      // QC4 F3 fix: api.functions.invoke wraps response as { data: <body> }
      // (supabaseClient.js:565). data?.success === false was always false (undefined !== false)
      // so server-side {success:false, error:...} replies silently passed as success.
      // Same class as Wave 7's ProjectFilesTab fix.
      const result = await api.functions.invoke("drone-render", {
        shoot_id: shootId,
        kind: "poi_plus_boundary",
        wipe_existing: true,
        reason: "stale_theme_rerender_all",
      });
      const data = result?.data;
      if (data?.success === false) {
        throw new Error(data?.error || "Re-render failed");
      }
      toast.success("Re-rendering all stale cards — they'll refresh once the worker completes.");
      queryClient.invalidateQueries({ queryKey: ["drone_renders_raw", shootId] });
      queryClient.invalidateQueries({ queryKey: ["drone_renders_stale", shootId] });
    } catch (err) {
      toast.error(err?.message || "Re-render failed");
    } finally {
      setIsRerenderingAll(false);
    }
  }, [shootId, queryClient]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (shotsQuery.isLoading || rendersQuery.isLoading) {
    // Wave 13 D: skeleton grid follows the active column count (now 4).
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 animate-pulse">
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

  const hasRawProposed = grouped.raw_proposed.length > 0;
  const hasRawAccepted = grouped.raw_accepted.length > 0;
  // QC3-6 S3 fix: drop hasRawProposed gate — once every shot is accepted (the
  // natural successful case) the operator MUST still be able to lock the
  // shortlist to trigger editor handoff. Previously the button vanished as
  // soon as Pool emptied → workflow dead-end.
  const showLockBtn = isManagerOrAbove && hasRawAccepted;
  const rejectedShotCount = grouped.rejected.length;
  const staleCount = staleRenderIds.length;
  const showRerenderAllBtn = isManagerOrAbove && staleCount > 0;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        {/* Header actions: Lock shortlist / Re-render stale / Show rejected */}
        {(showLockBtn || showRerenderAllBtn || rejectedShotCount > 0) && (
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
                  After this, editors can drop into Editors/AI Proposed Enriched/ to begin the edited pipeline.
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
                  The drone theme has been edited since these raw previews were produced.
                  Click to wipe + regenerate the AI preview thumbnails with the current theme.
                </TooltipContent>
              </Tooltip>
            )}
            {rejectedShotCount > 0 && !isCompact && (
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
                    {grouped.rejected.map((shot) => {
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

        {/* Wave 9 S3: in-context compact stage strip. Sits above the
            columns so the operator sees pipeline progress without leaving
            the swimlane. Renders nothing when pipelineState is null. */}
        {pipelineState && (
          <DroneStageProgress pipelineState={pipelineState} compact />
        )}

        {/* Wave 9 S3: swimlane lock overlay (architect Section C.4).
            Wraps the entire 3-column triage UI. When the pipeline is mid-
            flight (operator_actions_unlocked === false) the overlay
            disables clicks on Accept/Reject/Send back/Restore cards and
            explains the gate. Header buttons (Lock shortlist / Re-render
            stale / Show rejected) remain outside the overlay since they
            are pre-lock or post-lock affordances. */}
        <DroneSwimlaneLockOverlay pipelineState={pipelineState}>
          {/* Pipeline columns
              ≥1024px: 3-column grid.
              <1024px (W1-ε iPad collapse): single column with stage selector. */}
          {(() => {
            const renderColumn = (col) => (
              <PipelineColumn
                key={col.key}
                column={col}
                shots={grouped[col.key] || []}
                previewPathByShotId={previewPathByShotId}
                canEdit={isManagerOrAbove}
                pendingShotAction={pendingShotAction}
                onMutateShot={mutateShotLifecycle}
                onRequestConfirmEditorAction={(payload) => setConfirmEditorAction(payload)}
                onPreview={({ columnKey, itemId }) => {
                  const items = lightboxItemsByColumn[columnKey] || [];
                  const idx = items.findIndex((it) => it.id === itemId);
                  if (idx >= 0) setLightbox({ columnKey, index: idx, itemId });
                }}
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
                          return (
                            <SelectItem key={c.key} value={c.key}>
                              {c.label} ({items.length})
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
              // Wave 13 D: 4 columns at lg+ (was 3). Keep 2 at sm so the
              // editor_returned column doesn't squeeze to unreadable widths
              // on iPad-portrait / smaller laptops.
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {COLUMNS.map(renderColumn)}
              </div>
            );
          })()}
        </DroneSwimlaneLockOverlay>
      </div>

      {/* Lightbox */}
      {lightbox && (lightboxItemsByColumn[lightbox.columnKey] || []).length > 0 && (
        <DroneLightbox
          items={lightboxItemsByColumn[lightbox.columnKey]}
          initialIndex={Math.min(
            lightbox.index,
            lightboxItemsByColumn[lightbox.columnKey].length - 1,
          )}
          groupLabel={
            COLUMNS.find((c) => c.key === lightbox.columnKey)?.label || ""
          }
          onClose={() => setLightbox(null)}
        />
      )}

      {/* QC iter 6 C: confirmation dialog for irreversible editor_returned
          actions (Mark Final / Reject editor delivery). Per QC iter 5 P1-6. */}
      <AlertDialog
        open={Boolean(confirmEditorAction)}
        onOpenChange={(o) => { if (!o) setConfirmEditorAction(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmEditorAction?.target === "final"
                ? "Mark editor delivery as Final?"
                : "Reject editor delivery?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmEditorAction?.target === "final"
                ? "This locks the editor's delivery as the final shot. The operator can revert later via the Revert button if a re-edit is needed."
                : "This rejects the editor's delivery. The shot moves to Rejected. You can restore it later from the Show rejected list."}
              {confirmEditorAction?.filename && (
                <span className="block mt-2 font-mono text-xs">
                  {confirmEditorAction.filename}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const a = confirmEditorAction;
                setConfirmEditorAction(null);
                if (a?.shotId && a?.target) {
                  mutateShotLifecycle(a.shotId, a.target, a.label || `Moved to ${a.target}`);
                }
              }}
            >
              {confirmEditorAction?.target === "final" ? "Mark Final" : "Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

// ── PipelineColumn ───────────────────────────────────────────────────────────
function PipelineColumn({
  column,
  shots,
  previewPathByShotId,
  canEdit,
  pendingShotAction,
  onMutateShot,
  onRequestConfirmEditorAction,
  onPreview,
  isCompact,
}) {
  const emptyLabel =
    column.key === "raw_proposed"
      ? "No raws to triage"
      : column.key === "raw_accepted"
      ? "Accept raws to stage them here"
      : column.key === "editor_returned"
      ? "Editor deliveries land here automatically"
      : "No rejected raws";

  return (
    <div
      className={cn(
        "rounded-md border-2 bg-card",
        column.tone,
      )}
    >
      <div
        className={cn(
          "px-2 py-1.5 text-xs font-semibold flex items-center justify-between rounded-t-sm",
          COLUMN_HEADER_TONE[column.key],
        )}
      >
        <span className="uppercase tracking-wide">{column.label}</span>
        <span className="tabular-nums">{shots.length}</span>
      </div>
      <div
        className={cn(
          "p-2 space-y-2 min-h-[120px] overflow-y-auto",
          isCompact ? "max-h-[70vh]" : "max-h-[480px]",
        )}
      >
        {shots.length === 0 ? (
          <div className="text-center py-6 text-[11px] text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          shots.map((shot) => (
            <ShotLifecycleCard
              key={shot.id}
              shot={shot}
              column={column.key}
              previewPath={previewPathByShotId.get(shot.id) || null}
              canEdit={canEdit}
              pendingShotAction={pendingShotAction}
              onMutateShot={onMutateShot}
              onRequestConfirmEditorAction={onRequestConfirmEditorAction}
              onPreview={({ itemId }) =>
                onPreview && onPreview({ columnKey: column.key, itemId })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── ShotLifecycleCard ────────────────────────────────────────────────────────
//
// Wave 5 P2 S6: Pin Editor entry button was REMOVED. The Pin Editor is now an
// edited-pipeline-only tool (S4's contract). On raw cards the button caused
// an E1/E40 React #310 mount crash because it tried to mount against a raw
// render that may not exist; killing the entry point at the source fixes it.
function ShotLifecycleCard({
  shot,
  column,
  previewPath,
  canEdit,
  pendingShotAction,
  onMutateShot,
  onRequestConfirmEditorAction,
  onPreview,
}) {
  const thumbPath = previewPath || shot?.dropbox_path || null;
  const clickPath = thumbPath;
  const isAccepted = column === "raw_accepted";
  const isRejected = column === "rejected";
  // Wave 13 D: editor_returned column — post-editor delivery awaiting
  // operator review. Send-to-Pool is hidden here (one-way forward state
  // machine: editor_returned → final | rejected | back to raw_accepted via
  // Revert). Mark Final / Reject calls drone-shot-lifecycle with the matching
  // target. Revert to Raw Accepted lets managers send the shot back for
  // re-edit (clears the editor delivery from the column).
  const isEditorReturned = column === "editor_returned";
  const pendingState = pendingShotAction?.[shot.id];
  const isAiRecommended = Boolean(shot?.is_ai_recommended);
  const captureTime = shot?.captured_at
    ? format(new Date(shot.captured_at), "h:mm a")
    : null;

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
                  <span
                    className="absolute top-1 right-1 inline-flex items-center gap-0.5 text-[9px] px-1 py-0.5 rounded bg-blue-600 text-white pointer-events-auto cursor-help focus:outline-none focus:ring-2 focus:ring-blue-300"
                    role="img"
                    tabIndex={0}
                    aria-label="AI recommended — suggested by AI based on dedup, flight roll, and POI coverage"
                  >
                    <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                    AI
                    <Check className="h-2.5 w-2.5" aria-hidden="true" />
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
        <div className="text-[10px] text-muted-foreground truncate">
          {shot.dji_index != null ? `#${shot.dji_index}` : ""}
          {captureTime ? `${shot.dji_index != null ? " · " : ""}${captureTime}` : ""}
          {shot.shot_role ? ` · ${SHOT_ROLE_LABEL[shot.shot_role] || shot.shot_role}` : ""}
        </div>

        {/* Triage actions — explicit buttons (no drag-drop) */}
        {canEdit && (
          <div className="flex items-center gap-1 flex-wrap pt-1">
            {!isAccepted && !isRejected && !isEditorReturned && (
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
            )}
            {isAccepted && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5"
                  onClick={() => onMutateShot(shot.id, "raw_proposed", "Sent back to Pool")}
                  disabled={Boolean(pendingState)}
                  title="Send back to Raw Pool"
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
            {/* Wave 13 D: editor_returned column actions.
                Order: Final (primary forward step) → Reject → Revert (mgr+ only).
                Send-to-Pool is intentionally absent — the swimlane only flows
                forward from editor_returned (mig 324 + drone-shot-lifecycle
                state-machine gating). */}
            {isEditorReturned && (
              <>
                <Button
                  variant="default"
                  size="sm"
                  className="h-6 text-[10px] px-2"
                  onClick={() =>
                    onRequestConfirmEditorAction
                      ? onRequestConfirmEditorAction({
                          shotId: shot.id,
                          target: "final",
                          label: "Marked Final",
                          filename: shot.filename || null,
                        })
                      : onMutateShot(shot.id, "final", "Marked Final")
                  }
                  disabled={Boolean(pendingState)}
                  title="Approve editor delivery — moves to Final"
                >
                  {pendingState === "final" ? (
                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  ) : (
                    <Check className="h-2.5 w-2.5 mr-1" />
                  )}
                  Final
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-[10px] px-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                  onClick={() =>
                    onRequestConfirmEditorAction
                      ? onRequestConfirmEditorAction({
                          shotId: shot.id,
                          target: "rejected",
                          label: "Rejected editor delivery",
                          filename: shot.filename || null,
                        })
                      : onMutateShot(shot.id, "rejected", "Rejected editor delivery")
                  }
                  disabled={Boolean(pendingState)}
                  title="Reject the editor delivery"
                >
                  {pendingState === "rejected" ? (
                    <Loader2 className="h-2.5 w-2.5 animate-spin" />
                  ) : (
                    <X className="h-2.5 w-2.5" />
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-6 text-[10px] px-1.5"
                  onClick={() => onMutateShot(shot.id, "raw_accepted", "Sent back for re-edit")}
                  disabled={Boolean(pendingState)}
                  title="Revert to Raw Accepted — sends back for re-edit"
                >
                  {pendingState === "raw_accepted" ? (
                    <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
                  ) : (
                    <Pencil className="h-2.5 w-2.5 mr-1" />
                  )}
                  Revert
                </Button>
              </>
            )}
            {isRejected && (
              <Button
                variant="outline"
                size="sm"
                className="h-6 text-[10px] px-2"
                onClick={() => onMutateShot(shot.id, "raw_proposed", "Restored")}
                disabled={Boolean(pendingState)}
                title="Restore to Raw Pool"
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
        )}

        {/* Created-at timestamp on accepted/editor_returned/rejected so
            operators can tell stale entries apart without opening details. */}
        {(isAccepted || isRejected || isEditorReturned) && shot?.captured_at && (
          <div className="text-[9px] text-muted-foreground">
            <Badge variant="outline" className="text-[9px] h-4 px-1">
              {formatDistanceToNow(new Date(shot.captured_at), { addSuffix: true })}
            </Badge>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * DroneEditsSubtab — Drone Wave 5 P2 (NEW, edited pipeline)
 *
 * The 3-column edited curation swimlane:
 *
 *   ┌ EDITED POOL ──────────┬ EDITED ADJUSTMENTS ─┬ EDITED FINALS ────┐
 *   │ fresh from editor     │ operator iterating  │ locked deliverables│
 *   │ delivery, AI overlay  │ with Pin / Boundary │                    │
 *   │                       │ Editor              │                    │
 *   └───────────────────────┴─────────────────────┴────────────────────┘
 *
 * Architect plan C.3:
 *   • Filters drone_renders to pipeline='edited'.
 *   • column_state values: pool / adjustments / final / rejected (mig 282).
 *   • No triage gate — every editor delivery is a deliverable; columns track
 *     the curation state.
 *   • Per-card affordances:
 *       - Edit pins → /DronePinEditor?...&pipeline=edited (S4 contract)
 *       - Edit boundary → /DroneBoundaryEditor?... (S5 contract)
 *       - Lock → moves Adjustments → Finals
 *       - Reset to Pool / Reject → mirror raw subtab transition pattern
 *   • Cascade visibility banner — if any drone_jobs exist with kind in
 *     ('render_edited','boundary_save_render_cascade') and status in
 *     ('pending','running') for this project, show a banner at the top.
 *   • Realtime subscribe to drone_renders (pipeline='edited').
 *   • Empty state: "No edited renders yet — waiting for editor delivery to
 *     /Drones/Editors/AI Proposed Enriched/".
 *   • iPad collapse below 1024px → single column with stage selector.
 *
 * Mirrors the visual style of DroneRendersSubtab so operators feel "same
 * swimlane pattern, different pipeline".
 *
 * Props: { shoot, projectId }
 */

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  TooltipProvider,
} from "@/components/ui/tooltip";
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
  Pencil,
  Map as MapIcon,
  Check,
  RotateCcw,
  X,
  Loader2,
  AlertCircle,
  Layers,
  Lock,
  RefreshCw,
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/auth/PermissionGuard";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import DroneLightbox from "@/components/drone/DroneLightbox";

// W1-ε iPad collapse threshold mirrors DroneRendersSubtab.
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

const COLUMNS = [
  { key: "pool",        label: "Edited Pool",        tone: "border-purple-300 dark:border-purple-800" },
  { key: "adjustments", label: "Edited Adjustments", tone: "border-indigo-300 dark:border-indigo-800" },
  { key: "final",       label: "Edited Finals",      tone: "border-emerald-300 dark:border-emerald-800" },
];

const COLUMN_HEADER_TONE = {
  pool:        "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  adjustments: "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  final:       "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const SHOT_ROLE_LABEL = {
  nadir_grid: "Nadir grid",
  nadir_hero: "Nadir hero",
  orbital: "Orbital",
  oblique_hero: "Oblique hero",
  building_hero: "Building hero",
  ground_level: "Ground",
  unclassified: "Unclassified",
};

// Active cascade kinds that should surface the banner.
const ACTIVE_CASCADE_KINDS = ["render_edited", "boundary_save_render_cascade"];
const ACTIVE_CASCADE_STATUSES = ["pending", "running"];
// Banner refresh cadence while a cascade is in flight. Once the count drops
// to zero we stop polling — the realtime drone_renders feed will then carry
// the new finals into the columns.
const CASCADE_POLL_MS = 4000;

export default function DroneEditsSubtab({ shoot, projectId }) {
  const queryClient = useQueryClient();
  const shootId = shoot?.id;
  const { isManagerOrAbove } = usePermissions();

  const [confirmReject, setConfirmReject] = useState(null);
  const [lightbox, setLightbox] = useState(null);

  const isCompact = useIsCompactSwimlane();
  const [activeColumnKey, setActiveColumnKey] = useState(COLUMNS[0].key);

  // ── Fetch shots (for thumbnail metadata + per-card shot_id resolution) ────
  const shotsKey = ["drone_shots_for_renders", shootId];
  const shotsQuery = useQuery({
    queryKey: shotsKey,
    queryFn: () =>
      api.entities.DroneShot.filter({ shoot_id: shootId }, "dji_index", 2000),
    enabled: Boolean(shootId),
    staleTime: 30_000,
  });

  // ── Fetch renders (EDITED pipeline only) ──────────────────────────────────
  const rendersKey = ["drone_renders_edited", shootId];
  const rendersQuery = useQuery({
    queryKey: rendersKey,
    queryFn: async () => {
      const shots = shotsQuery.data || [];
      if (shots.length === 0) return [];
      const shotIds = shots.map((s) => s.id);
      const rows = await api.entities.DroneRender.filter(
        { shot_id: { $in: shotIds }, pipeline: "edited" },
        "-created_at",
        2000,
      );
      return rows || [];
    },
    enabled: Boolean(shootId) && shotsQuery.isSuccess && (shotsQuery.data?.length || 0) > 0,
    staleTime: 15_000,
  });

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

  // Realtime: drone_renders for shoot's shots, EDITED pipeline only.
  useEffect(() => {
    if (!shootId) return;
    if (!shotIdsSignature) return;
    const shotIdSet = new Set(shotIdsSignature.split(","));
    if (shotIdSet.size === 0) return;
    let active = true;

    const unsubscribe = api.entities.DroneRender.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.shot_id || !shotIdSet.has(evt.data.shot_id)) return;
      // Filter to edited pipeline. If pipeline is unknown (legacy), don't
      // surface — raw subtab handles that case.
      if (evt.data.pipeline !== "edited") return;
      throttledInvalidate(["drone_renders_edited", shootId]);
    });

    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[DroneEditsSubtab] DroneRender unsubscribe failed:", e);
      }
    };
  }, [shootId, shotIdsSignature, throttledInvalidate]);

  const shots = shotsQuery.data || [];
  const renders = rendersQuery.data || [];

  const shotsById = useMemo(() => {
    const m = new Map();
    for (const s of shots) m.set(s.id, s);
    return m;
  }, [shots]);

  // Optimistic column overrides for instant transitions.
  const [optimisticRenderColumns, setOptimisticRenderColumns] = useState({});

  const grouped = useMemo(() => {
    const cols = {
      pool: new Map(),
      adjustments: new Map(),
      final: new Map(),
      rejected: new Map(),
    };
    for (const r of renders) {
      const overlayState = optimisticRenderColumns[r.id];
      const col = overlayState || r.column_state || "pool";
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
    return {
      pool: toGroups(cols.pool),
      adjustments: toGroups(cols.adjustments),
      final: toGroups(cols.final),
      rejected: toGroups(cols.rejected),
    };
  }, [renders, optimisticRenderColumns]);

  const lightboxItemsByColumn = useMemo(() => {
    const out = {};
    const buildItems = (groups, columnKey) =>
      groups
        .map((g) => {
          const r = g.variants?.[0];
          if (!r?.dropbox_path) return null;
          const shot = shotsById.get(g.shot_id);
          return {
            id: r.id,
            dropbox_path: r.dropbox_path,
            filename: shot?.filename || r.kind || null,
            shot_role: SHOT_ROLE_LABEL[shot?.shot_role] || shot?.shot_role || null,
            ai_recommended: false,
            status:
              columnKey === "pool"
                ? "Edited Pool"
                : columnKey === "adjustments"
                ? "Adjustments"
                : columnKey === "final"
                ? "Final"
                : "Rejected",
          };
        })
        .filter(Boolean);
    out.pool = buildItems(grouped.pool, "pool");
    out.adjustments = buildItems(grouped.adjustments, "adjustments");
    out.final = buildItems(grouped.final, "final");
    out.rejected = buildItems(grouped.rejected, "rejected");
    return out;
  }, [grouped, shotsById]);

  // ── Transition action ─────────────────────────────────────────────────────
  // Routes through drone-render-approve like the raw side. Same target-state
  // semantics; the function applies the column_state update server-side and
  // emits a drone_events row.
  const [pendingAction, setPendingAction] = useState({});

  const TOAST_FOR_TARGET = {
    pool:        "Reset to Edited Pool",
    adjustments: "Moved to Adjustments",
    final:       "Locked → Finals",
    rejected:    "Rejected",
    restore:     "Restored",
  };
  const VERB_FOR_TARGET = {
    pool:        "moving",
    adjustments: "moving",
    final:       "locking",
    rejected:    "rejecting",
    restore:     "restoring",
  };

  const callTransition = useCallback(
    async (renderId, targetState) => {
      setPendingAction((p) => ({ ...p, [renderId]: VERB_FOR_TARGET[targetState] || "moving" }));
      if (targetState !== "restore") {
        setOptimisticRenderColumns((p) => ({ ...p, [renderId]: targetState }));
      }
      try {
        // QC4 F2 fix: api.functions.invoke wraps response as { data: <body> }
        // (supabaseClient.js:565). Reading data.success directly was always
        // undefined → every successful 200 threw → operators see optimistic UI
        // succeed then rollback then retry. Same class as Wave 7's ProjectFilesTab fix.
        const result = await api.functions.invoke("drone-render-approve", {
          render_id: renderId,
          target_state: targetState,
        });
        const data = result?.data;
        if (!data?.success) {
          throw new Error(data?.error || `Failed to ${targetState}`);
        }
        toast.success(TOAST_FOR_TARGET[targetState] || `Moved to ${targetState}`);
        queryClient.invalidateQueries({ queryKey: ["drone_renders_edited", shootId] });
        setOptimisticRenderColumns((p) => {
          const next = { ...p };
          delete next[renderId];
          return next;
        });
      } catch (err) {
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

  // Lightbox safety
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

  // ── Cascade visibility banner ─────────────────────────────────────────────
  // Polls drone_jobs for active render_edited / boundary_save_render_cascade
  // jobs scoped to this project. While count > 0, banner shows + we re-poll
  // every CASCADE_POLL_MS. Once it drops to zero, polling stops (refetch on
  // tab focus + the realtime renders feed cover later changes).
  const cascadeQ = useQuery({
    queryKey: ["drone_jobs_active_cascade", projectId],
    queryFn: async () => {
      if (!projectId) return [];
      const rows = await api.entities.DroneJob.filter(
        {
          project_id: projectId,
          kind: { $in: ACTIVE_CASCADE_KINDS },
          status: { $in: ACTIVE_CASCADE_STATUSES },
        },
        "-created_at",
        500,
      );
      return rows || [];
    },
    enabled: Boolean(projectId),
    // QC iter 6 C: TanStack v5 passes the QUERY object to refetchInterval, not
    // the data directly (see useDronePipelineState.js:99-103 for the canonical
    // pattern). Reading length on the query object always undefined → polling
    // never engaged → CascadeBanner went stale until next manual interaction.
    refetchInterval: (query) => {
      const data = query?.state?.data;
      return Array.isArray(data) && data.length > 0 ? CASCADE_POLL_MS : false;
    },
    staleTime: 0,
  });
  const activeCascadeCount = (cascadeQ.data || []).length;

  // ── Render ────────────────────────────────────────────────────────────────
  if (shotsQuery.isLoading || rendersQuery.isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 animate-pulse">
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
          <p className="font-medium">Failed to load edited renders</p>
          <p className="text-xs mt-0.5">{error.message || "Unknown error"}</p>
        </div>
      </div>
    );
  }

  const totalEdited =
    grouped.pool.length +
    grouped.adjustments.length +
    grouped.final.length +
    grouped.rejected.length;

  // Empty state — no edited renders yet.
  if (totalEdited === 0) {
    return (
      <div className="space-y-3">
        {activeCascadeCount > 0 && (
          <CascadeBanner count={activeCascadeCount} />
        )}
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            <p className="font-medium text-foreground/80 mb-1">
              No edited renders yet.
            </p>
            <p className="text-xs">
              Waiting for editor delivery to{" "}
              <code className="text-[11px] font-mono">
                /Drones/Editors/AI Proposed Enriched/
              </code>
              . Once files land, the edited pipeline will populate Edited Pool.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        {activeCascadeCount > 0 && (
          <CascadeBanner count={activeCascadeCount} />
        )}

        {/* Pipeline columns
            ≥1024px: 3-column grid.
            <1024px (W1-ε iPad collapse): single column with stage selector. */}
        {(() => {
          const renderColumn = (col) => (
            <PipelineColumn
              key={col.key}
              column={col}
              groups={grouped[col.key] || []}
              shotsById={shotsById}
              projectId={projectId}
              shootId={shootId}
              canEdit={isManagerOrAbove}
              pendingAction={pendingAction}
              onTransition={callTransition}
              onConfirmReject={(render) => setConfirmReject({ render })}
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
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {COLUMNS.map(renderColumn)}
            </div>
          );
        })()}

        {/* Rejected drawer */}
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
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

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

      {/* Wave 14 S4: AlertDialog parity (matches DroneRendersSubtab + DronePipelineBanner).
          Shadcn AlertDialog is the right primitive for irreversible
          confirmations — keyboard focus is trapped, ESC + outside-click route
          through onOpenChange, and the Cancel/Action buttons are
          first-class. Replaces the prior plain Dialog wrap. */}
      <AlertDialog
        open={Boolean(confirmReject)}
        onOpenChange={(o) => { if (!o) setConfirmReject(null); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this edited render?</AlertDialogTitle>
            <AlertDialogDescription>
              The render moves to the Rejected list. You can restore it back
              to its previous column from there if it was rejected by mistake.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={Boolean(pendingAction[confirmReject?.render?.id])}
            >
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
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
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

// ── CascadeBanner ────────────────────────────────────────────────────────────
function CascadeBanner({ count }) {
  return (
    <div className="rounded-md border border-blue-300 dark:border-blue-700 bg-blue-50 dark:bg-blue-950/40 px-3 py-2 flex items-center gap-2">
      <RefreshCw className="h-4 w-4 text-blue-600 dark:text-blue-400 animate-spin flex-shrink-0" />
      <div className="text-xs text-blue-800 dark:text-blue-200">
        Re-rendering {count} edited shot{count === 1 ? "" : "s"}…
        <span className="ml-1 text-blue-600 dark:text-blue-400">
          Cards will refresh automatically.
        </span>
      </div>
    </div>
  );
}

// ── PipelineColumn ───────────────────────────────────────────────────────────
function PipelineColumn({
  column,
  groups,
  shotsById,
  projectId,
  shootId,
  canEdit,
  pendingAction,
  onTransition,
  onConfirmReject,
  onPreview,
  isCompact,
}) {
  const emptyLabel =
    column.key === "pool"
      ? "No edited renders pending review"
      : column.key === "adjustments"
      ? "Move from Pool to iterate"
      : "Lock from Adjustments to finalise";

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
        <span className="tabular-nums">{groups.length}</span>
      </div>
      <div
        className={cn(
          "p-2 space-y-2 min-h-[120px] overflow-y-auto",
          isCompact ? "max-h-[70vh]" : "max-h-[480px]",
        )}
      >
        {groups.length === 0 ? (
          <div className="text-center py-6 text-[11px] text-muted-foreground">
            {emptyLabel}
          </div>
        ) : (
          groups.map((g) => (
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
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── RenderCard (edited side) ─────────────────────────────────────────────────
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
}) {
  const orderedVariants = useMemo(() => variants || [], [variants]);
  const [selectedVariantId, setSelectedVariantId] = useState(
    orderedVariants[0]?.id || null,
  );

  const variantIdSig = useMemo(
    () => orderedVariants.map((v) => v.id).sort().join(","),
    [orderedVariants],
  );
  useEffect(() => {
    if (!orderedVariants.length) return;
    const stillExists = orderedVariants.some((v) => v.id === selectedVariantId);
    if (!stillExists) {
      if (selectedVariantId != null) {
        console.warn(
          "[DroneEditsSubtab.RenderCard] selected variant",
          selectedVariantId,
          "no longer exists; falling back to",
          orderedVariants[0].id,
        );
      }
      setSelectedVariantId(orderedVariants[0].id);
    }
  }, [variantIdSig, orderedVariants, selectedVariantId]);

  const selectedRender =
    orderedVariants.find((v) => v.id === selectedVariantId) ||
    orderedVariants[0] ||
    null;

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
  const isPool = column === "pool";
  const isAdjustments = column === "adjustments";
  const isFinal = column === "final";
  const isRejected = column === "rejected";

  return (
    <div className="rounded-md border bg-card overflow-hidden hover:border-primary/40 transition-colors">
      <button
        type="button"
        onClick={() => {
          if (r.dropbox_path && onPreview) {
            const primaryId = orderedVariants[0]?.id || r.id;
            onPreview({ itemId: primaryId });
          }
        }}
        disabled={!r.dropbox_path}
        className="block w-full text-left disabled:cursor-default"
        aria-label={`Preview ${r.kind || "edited render"}`}
      >
        <DroneThumbnail
          dropboxPath={r.dropbox_path}
          mode="thumb"
          alt={shot?.filename || r.kind || "edited render preview"}
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

        {hasMultiVariant && (
          <div className="pt-0.5">
            <label className="sr-only" htmlFor={`evariant-${r.shot_id}-${column}`}>
              Output variant
            </label>
            <Select
              value={selectedVariantId || ""}
              onValueChange={(v) => setSelectedVariantId(v)}
            >
              <SelectTrigger
                id={`evariant-${r.shot_id}-${column}`}
                className="w-full h-6 text-[10px] px-1.5 py-0"
                aria-label="Select output variant"
              >
                <SelectValue placeholder="default" />
              </SelectTrigger>
              <SelectContent>
                {orderedVariants.map((v) => (
                  <SelectItem
                    key={v.id}
                    value={v.id}
                    className="text-[10px]"
                  >
                    {v.output_variant || "default"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="flex items-center gap-1 flex-wrap">
          {poiCount != null && (
            <Badge variant="outline" className="text-[9px] h-4 px-1">
              {poiCount} POI
            </Badge>
          )}
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
        </div>

        {/* Per-card edited-pipeline actions */}
        <div className="flex items-center gap-1 flex-wrap pt-1">
          {/* Edit pins → DronePinEditor (S4 contract: pipeline=edited) */}
          {(isPool || isAdjustments) && canEdit && projectId && shootId && r.shot_id && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              title="Edit pins on this edited render"
            >
              <Link
                to={createPageUrl(
                  `DronePinEditor?project=${projectId}&shoot=${shootId}&shot=${r.shot_id}&pipeline=edited`,
                )}
              >
                <Pencil className="h-2.5 w-2.5 mr-1" />
                Pins
              </Link>
            </Button>
          )}

          {/* Edit boundary → DroneBoundaryEditor (S5 contract)
              W6 FIX 8 (QC3-8 E2E6): include pipeline=edited so the editor
              page's render filter knows to scope to the Edited pipeline
              (matches the Pins button above + the page wrapper's resolver
              expectation that the edited pipeline is in play). */}
          {(isPool || isAdjustments) && canEdit && projectId && shootId && r.shot_id && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              title="Edit boundary on this edited render"
            >
              <Link
                to={createPageUrl(
                  `DroneBoundaryEditor?project=${projectId}&shoot=${shootId}&shot=${r.shot_id}&pipeline=edited`,
                )}
              >
                <MapIcon className="h-2.5 w-2.5 mr-1" />
                Boundary
              </Link>
            </Button>
          )}

          {/* POOL → move to Adjustments */}
          {isPool && canEdit && (
            <Button
              variant="default"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => onTransition(r.id, "adjustments")}
              disabled={Boolean(action)}
              title="Iterate on this card — move to Adjustments"
            >
              {action === "moving" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <Pencil className="h-2.5 w-2.5 mr-1" />
              )}
              Iterate
            </Button>
          )}

          {/* ADJUSTMENTS → Lock to Finals */}
          {isAdjustments && canEdit && (
            <Button
              variant="default"
              size="sm"
              className="h-6 text-[10px] px-2"
              onClick={() => onTransition(r.id, "final")}
              disabled={Boolean(action)}
              title="Lock as final deliverable"
            >
              {action === "locking" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <Lock className="h-2.5 w-2.5 mr-1" />
              )}
              Lock
            </Button>
          )}

          {/* ADJUSTMENTS / FINAL → Reset to Pool */}
          {(isAdjustments || isFinal) && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              onClick={() => onTransition(r.id, "pool")}
              disabled={Boolean(action)}
              title={isFinal ? "Unlock and send back to Pool" : "Send back to Pool"}
            >
              {action === "moving" ? (
                <Loader2 className="h-2.5 w-2.5 mr-1 animate-spin" />
              ) : (
                <RotateCcw className="h-2.5 w-2.5 mr-1" />
              )}
              Reset
            </Button>
          )}

          {/* REJECTED → Restore */}
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

          {/* Reject (any non-rejected) */}
          {!isRejected && canEdit && (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 text-[10px] px-1.5 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
              onClick={() => onConfirmReject(r)}
              disabled={Boolean(action)}
              title="Reject this edited render"
            >
              {action === "rejecting" ? (
                <Loader2 className="h-2.5 w-2.5 animate-spin" />
              ) : (
                <X className="h-2.5 w-2.5" />
              )}
            </Button>
          )}

          {/* FINAL marker */}
          {isFinal && (
            <Badge
              variant="outline"
              className="text-[9px] h-4 px-1 border-emerald-400 text-emerald-700 bg-emerald-50 dark:border-emerald-700 dark:text-emerald-300 dark:bg-emerald-950/40"
            >
              <Check className="h-2.5 w-2.5 mr-0.5" />
              locked
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * DroneRendersSubtab — Drone Phase 2 Stream K
 *
 * The Raw → Proposed → Adjustments → Final pipeline UI for one drone shoot.
 *
 * Props: { shoot, projectId }
 *
 * Layout (per IMPLEMENTATION_PLAN_V2.md §6.1):
 *   ┌ RAW ──────┬ PROPOSED ────┬ ADJUSTMENTS ──┬ FINAL ────────┐
 *   │ N shots   │ N rendered   │ N in editor   │ N approved    │
 *   │ [cards]   │ [cards]      │ [cards]       │ [cards]        │
 *   └───────────┴──────────────┴────────────────┴────────────────┘
 *
 * Cards = `drone_renders` rows grouped by `column_state`
 *   ('raw' | 'proposed' | 'adjustments' | 'final' | 'rejected').
 * The RAW column is special: it shows shots that don't yet have any render row
 * (since render workers create the first 'proposed' row directly — there's no
 * literal 'raw' state ever stored).
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

import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
} from "lucide-react";
import { createPageUrl } from "@/utils";
import { format, formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/components/auth/PermissionGuard";
import DroneThumbnail from "@/components/drone/DroneThumbnail";
import { SHARED_THUMB_CACHE, enqueueFetch, fetchMediaProxy } from "@/utils/mediaPerf";

const COLUMNS = [
  { key: "raw",          label: "Raw",          tone: "border-slate-300 dark:border-slate-700" },
  { key: "proposed",     label: "Proposed",     tone: "border-purple-300 dark:border-purple-800" },
  { key: "adjustments",  label: "Adjustments",  tone: "border-indigo-300 dark:border-indigo-800" },
  { key: "final",        label: "Final",        tone: "border-emerald-300 dark:border-emerald-800" },
];

const COLUMN_HEADER_TONE = {
  raw:          "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  proposed:     "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
  adjustments:  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300",
  final:        "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

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
  // Lightbox state for thumbnail click-to-preview
  const [preview, setPreview] = useState(null); // { path, label }
  // Drag state — tracks which render is mid-drag so we can highlight valid
  // drop targets and ignore invalid drops without a network round-trip.
  const [dragRender, setDragRender] = useState(null); // { id, fromColumn }

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
  const shotIdsSignature = useMemo(() => {
    const ids = (shotsQuery.data || []).map((s) => s.id);
    ids.sort();
    return ids.join(",");
  }, [shotsQuery.data]);

  useEffect(() => {
    if (!shootId) return;
    if (!shotIdsSignature) return; // wait for shotsQuery to resolve with ids
    const shotIdSet = new Set(shotIdsSignature.split(","));
    if (shotIdSet.size === 0) return;
    let active = true;

    const unsubscribe = api.entities.DroneRender.subscribe((evt) => {
      if (!active) return;
      // For inserts/updates, evt.data exists with shot_id; for deletes, only id.
      if (evt.data?.shot_id && !shotIdSet.has(evt.data.shot_id)) return;
      queryClient.invalidateQueries({ queryKey: ["drone_renders", shootId] });
    });

    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[DroneRendersSubtab] DroneRender unsubscribe failed:", e);
      }
    };
  }, [shootId, shotIdsSignature, queryClient]);

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
  const grouped = useMemo(() => {
    const cols = {
      proposed: new Map(),
      adjustments: new Map(),
      final: new Map(),
      rejected: new Map(),
    };
    const shotsWithRender = new Set();

    // Renders arrive newest-first (-created_at) so the first row encountered
    // for each shot in a bucket is the primary variant.
    for (const r of renders) {
      const col = r.column_state || "proposed";
      const bucket = cols[col];
      if (!bucket) continue;
      if (!bucket.has(r.shot_id)) bucket.set(r.shot_id, []);
      bucket.get(r.shot_id).push(r);
      if (col !== "rejected") shotsWithRender.add(r.shot_id);
    }

    const toGroups = (m) =>
      Array.from(m.values()).map((variants) => ({
        shot_id: variants[0].shot_id,
        variants,
      }));

    return {
      raw: shots.filter((s) => !shotsWithRender.has(s.id)),
      proposed: toGroups(cols.proposed),
      adjustments: toGroups(cols.adjustments),
      final: toGroups(cols.final),
      rejected: toGroups(cols.rejected),
    };
  }, [renders, shots]);

  // ── Transition action (generalised) ───────────────────────────────────────
  // pendingAction map values are short verbs the buttons read to render their
  // spinners ('approving' | 'rejecting' | 'moving' | 'restoring').
  const [pendingAction, setPendingAction] = useState({});

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
      } catch (err) {
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

  // ── Render ────────────────────────────────────────────────────────────────
  if (shotsQuery.isLoading || rendersQuery.isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 animate-pulse">
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

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-3">
        {/* Pipeline columns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {COLUMNS.map((col) => (
            <PipelineColumn
              key={col.key}
              column={col}
              items={grouped[col.key] || []}
              isRaw={col.key === "raw"}
              shotsById={shotsById}
              projectId={projectId}
              shootId={shootId}
              canEdit={isManagerOrAbove}
              pendingAction={pendingAction}
              onTransition={callTransition}
              onConfirmReject={(render) => setConfirmReject({ render })}
              onPreview={(info) => setPreview(info)}
              dragRender={dragRender}
              setDragRender={setDragRender}
            />
          ))}
        </div>

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
                    onPreview={(info) => setPreview(info)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Lightbox preview dialog (full-resolution, lazy-fetched) */}
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(o) => !o && setPreview(null)}
      >
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle className="text-sm truncate">
              {preview?.label || "Preview"}
            </DialogTitle>
          </DialogHeader>
          {preview?.path && (
            <div className="bg-black/80 rounded-md overflow-hidden">
              <DroneThumbnail
                dropboxPath={preview.path}
                mode="proxy"
                alt={preview.label || "drone preview"}
                aspectRatio="aspect-[3/2]"
                className="object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>

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
  isRaw,
  shotsById,
  projectId,
  shootId,
  canEdit,
  pendingAction,
  onTransition,
  onConfirmReject,
  onPreview,
  dragRender,
  setDragRender,
}) {
  // A column is a valid drop target only if there's an active drag from a
  // different column AND the transition (fromCol → thisCol) is allowed by the
  // backend's transition rules.
  const validTargets = dragRender ? VALID_DROP_TARGETS[dragRender.fromColumn] : null;
  const isValidDropTarget = Boolean(
    canEdit &&
    dragRender &&
    !isRaw &&
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

  return (
    <div
      className={cn(
        "rounded-md border-2 bg-card transition-colors",
        column.tone,
        isOver && "ring-2 ring-primary/60 border-primary/40",
        dragRender && !isValidDropTarget && !isRaw && column.key !== dragRender.fromColumn && "opacity-60",
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
      <div className="p-2 space-y-2 min-h-[120px] max-h-[480px] overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-center py-6 text-[11px] text-muted-foreground">
            {isRaw ? "All shots have renders" : isOver ? "Drop here" : "Empty"}
          </div>
        ) : isRaw ? (
          // RAW column: items are shots, not renders
          items.map((shot) => (
            <RawShotCard key={shot.id} shot={shot} onPreview={onPreview} />
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
              onPreview={onPreview}
              setDragRender={setDragRender}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── RawShotCard (in RAW column — no render row yet) ──────────────────────────
function RawShotCard({ shot, onPreview }) {
  const clickable = Boolean(shot?.dropbox_path && onPreview);
  const Tag = clickable ? "button" : "div";
  return (
    <Tag
      type={clickable ? "button" : undefined}
      onClick={clickable ? () => onPreview({ path: shot.dropbox_path, label: shot.filename }) : undefined}
      className={cn(
        "rounded-md border bg-card overflow-hidden w-full text-left",
        clickable && "hover:border-primary/40 transition-colors",
      )}
    >
      <DroneThumbnail
        dropboxPath={shot.dropbox_path}
        mode="thumb"
        alt={shot.filename || "raw drone shot"}
        aspectRatio="aspect-[4/3]"
      />
      <div className="p-2">
        <div className="text-[11px] font-medium truncate" title={shot.filename}>
          {shot.filename || "—"}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {shot.dji_index != null ? `#${shot.dji_index}` : ""}
          {shot.shot_role ? ` · ${SHOT_ROLE_LABEL[shot.shot_role] || shot.shot_role}` : ""}
        </div>
      </div>
    </Tag>
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
}) {
  const orderedVariants = useMemo(() => variants || [], [variants]);
  const [selectedVariantId, setSelectedVariantId] = useState(
    orderedVariants[0]?.id || null,
  );

  // If the variant set changes (realtime update), keep the selection valid.
  useEffect(() => {
    if (!orderedVariants.length) return;
    if (!orderedVariants.find((v) => v.id === selectedVariantId)) {
      setSelectedVariantId(orderedVariants[0].id);
    }
  }, [orderedVariants, selectedVariantId]);

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
    try {
      const blobUrl = await enqueueFetch(() =>
        fetchMediaProxy(SHARED_THUMB_CACHE, path, "proxy"),
      );
      if (!blobUrl) {
        toast.error("Download failed — proxy returned no blob");
        return;
      }
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
    } catch (err) {
      console.error("[DroneRendersSubtab] download failed:", err);
      toast.error(err?.message || "Download failed");
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
      {/* Thumbnail (lazy via mediaPerf proxy). Click → lightbox preview */}
      <button
        type="button"
        onClick={() => {
          if (r.dropbox_path && onPreview) {
            onPreview({ path: r.dropbox_path, label: shot?.filename || r.kind });
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
        </div>

        {/* Actions — operate on the CURRENTLY SELECTED variant */}
        <div className="flex items-center gap-1 flex-wrap pt-1">
          {/* PROPOSED → Edit in Pin Editor (now enabled — wired to /DronePinEditor) */}
          {isProposed && canEdit && projectId && shootId && r.shot_id && (
            <Button
              asChild
              variant="outline"
              size="sm"
              className="h-6 text-[10px] px-1.5"
              title="Open this render in Pin Editor"
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
        </div>
      </div>
    </div>
  );
}

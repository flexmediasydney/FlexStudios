/**
 * ManualShortlistingSwimlane — Wave 7 P1-19 (W7.13)
 *
 * Manual-mode swimlane for project types where AI shortlisting doesn't apply
 * (project_types.shortlisting_supported=false) OR projects with no photo
 * deliverables (computeExpectedFileCount target=0).
 *
 * The engine swimlane (`ShortlistingSwimlane`) renders three columns —
 * REJECTED / AI PROPOSED / HUMAN APPROVED — driven by Pass 0/1/2/3 results.
 * Manual mode strips that down to two columns:
 *
 *   ┌──────────────────────┬──────────────────────┐
 *   │   FILES TO REVIEW    │      APPROVED        │
 *   │   (everything in     │   (operator drag-    │
 *   │    Photos/Raws/      │    drops what they   │
 *   │    Shortlist         │    want delivered)   │
 *   │    Proposed/)        │                      │
 *   └──────────────────────┴──────────────────────┘
 *
 * Lock semantics: same move_batch_v2 flow as engine mode, but the approved
 * set is the operator's drag-result (no slot resolution, no AI scores).
 * Sends `{ mode: 'manual', round_id, approved_stems }` to shortlist-lock.
 *
 * Drag-drop library: matches engine-mode swimlane (@hello-pangea/dnd).
 */
import {
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DragDropContext, Droppable, Draggable } from "@hello-pangea/dnd";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  RefreshCw,
  FileImage,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import LockProgressDialog from "./LockProgressDialog";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip the file extension from a filename. Mirrors the backend
 * `manualModeResolver.stripExtension` so what we send as `approved_stems[]`
 * resolves cleanly server-side.
 */
function stemOf(filename) {
  if (!filename) return "";
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx <= 0) return filename;
  return filename.slice(0, dotIdx);
}

const RAW_EXT_RE = /\.(cr3|cr2|arw|nef|raf|dng)$/i;
const IMAGE_EXT_RE = /\.(jpe?g|png|heic|tif?f|bmp|webp|gif)$/i;

// ── Single file card ─────────────────────────────────────────────────────────

function ManualFileCard({ file, dragHandleProps, draggableProps, innerRef, isDragging }) {
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewError, setPreviewError] = useState(false);

  // Fetch a Dropbox preview URL on mount. Only attempt for image-typed files
  // (Dropbox can't render RAW formats — show a generic icon for those).
  useEffect(() => {
    let active = true;
    const isImage = IMAGE_EXT_RE.test(file.name) && !RAW_EXT_RE.test(file.name);
    if (!isImage) {
      setPreviewError(true);
      return () => {
        active = false;
      };
    }
    api.functions
      .invoke("getDropboxFilePreview", { filePath: file.path })
      .then((resp) => {
        if (!active) return;
        const url = resp?.data?.url || resp?.url || null;
        if (url) setPreviewUrl(url);
        else setPreviewError(true);
      })
      .catch(() => {
        if (active) setPreviewError(true);
      });
    return () => {
      active = false;
    };
  }, [file.path, file.name]);

  return (
    <div
      ref={innerRef}
      {...draggableProps}
      {...dragHandleProps}
      className={cn(
        "rounded-md border bg-card p-2 text-xs select-none",
        "hover:bg-muted/40 transition-colors cursor-grab active:cursor-grabbing",
        isDragging && "shadow-lg ring-2 ring-primary",
      )}
    >
      {/* W11.6.2: Canon R5 native is 3:2 (6240x4160). aspect-video (16:9)
          cropped portrait floorplans + chopped 3:2 landscape. object-contain
          letterboxes mismatched aspects (e.g. portrait floorplans → dark
          bands on the sides) instead of cropping the composition. */}
      <div className="aspect-[3/2] w-full bg-muted rounded mb-1.5 overflow-hidden flex items-center justify-center">
        {previewUrl && !previewError ? (
          <img
            src={previewUrl}
            alt={file.name}
            className="object-contain w-full h-full"
            onError={() => setPreviewError(true)}
            loading="lazy"
          />
        ) : (
          <FileImage className="h-6 w-6 text-muted-foreground/40" />
        )}
      </div>
      <p className="font-mono text-[10px] truncate" title={file.name}>
        {file.name}
      </p>
    </div>
  );
}

// ── Swimlane column ──────────────────────────────────────────────────────────

function Column({ id, label, headerTone, files, locked }) {
  return (
    <div className="flex-1 min-w-0">
      <div
        className={cn(
          "text-[11px] font-bold uppercase tracking-wide px-2 py-1 rounded-t-md flex items-center justify-between",
          headerTone,
        )}
      >
        <span>{label}</span>
        <Badge variant="secondary" className="text-[10px] h-4 px-1.5">
          {files.length}
        </Badge>
      </div>
      <Droppable droppableId={id} isDropDisabled={locked}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "p-2 min-h-[300px] border border-t-0 rounded-b-md space-y-1.5 transition-colors",
              snapshot.isDraggingOver
                ? "bg-primary/5 border-primary"
                : "bg-background",
            )}
          >
            {files.length === 0 && !snapshot.isDraggingOver && (
              <p className="text-[11px] text-muted-foreground text-center py-6 italic">
                {id === "approved"
                  ? "Drag files here to approve"
                  : "No files to review"}
              </p>
            )}
            {files.map((file, idx) => (
              <Draggable
                key={file.path}
                draggableId={file.path}
                index={idx}
                isDragDisabled={locked}
              >
                {(dragProvided, dragSnapshot) => (
                  <ManualFileCard
                    file={file}
                    innerRef={dragProvided.innerRef}
                    draggableProps={dragProvided.draggableProps}
                    dragHandleProps={dragProvided.dragHandleProps}
                    isDragging={dragSnapshot.isDragging}
                  />
                )}
              </Draggable>
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ManualShortlistingSwimlane({
  roundId,
  round,
  projectId,
  project,
}) {
  const queryClient = useQueryClient();

  // ── Resolve the source folder path ──────────────────────────────────────
  // Manual mode lists everything in <root>/Photos/Raws/Shortlist Proposed/.
  const sourceFolderPath = useMemo(() => {
    const root = project?.dropbox_root_path;
    if (!root) return null;
    return `${root.replace(/\/+$/, "")}/Photos/Raws/Shortlist Proposed`;
  }, [project?.dropbox_root_path]);

  // ── List files in source folder via listDropboxFiles ────────────────────
  const filesQuery = useQuery({
    queryKey: ["manual_shortlist_files", projectId, sourceFolderPath],
    queryFn: async () => {
      if (!sourceFolderPath) return [];
      const resp = await api.functions.invoke("listDropboxFiles", {
        path: sourceFolderPath,
      });
      const data = resp?.data ?? resp ?? {};
      const files = Array.isArray(data.files) ? data.files : [];
      return files;
    },
    enabled: Boolean(projectId && sourceFolderPath),
    staleTime: 30_000,
  });

  // ── Local column state — operator drag-drop drives this ─────────────────
  // `toReview` = files in source folder (left column)
  // `approved` = files the operator dragged into the approved column (right)
  const [columnState, setColumnState] = useState({ toReview: [], approved: [] });

  // Hydrate column state from the query result on first load + refetches.
  useEffect(() => {
    if (!filesQuery.data) return;
    setColumnState((prev) => {
      // Preserve the approved set across refetches — the operator's choices
      // shouldn't disappear if they hit Refresh. Match by path.
      const approvedPaths = new Set(prev.approved.map((f) => f.path));
      const fresh = filesQuery.data;
      const approvedFresh = fresh.filter((f) => approvedPaths.has(f.path));
      const toReviewFresh = fresh.filter((f) => !approvedPaths.has(f.path));
      return {
        toReview: toReviewFresh,
        approved: approvedFresh,
      };
    });
  }, [filesQuery.data]);

  const isLocked = round?.status === "locked" || round?.status === "delivered";

  // ── Drag handler ─────────────────────────────────────────────────────────
  const onDragEnd = useCallback(
    (result) => {
      if (!result.destination || isLocked) return;
      const fromCol = result.source.droppableId;
      const toCol = result.destination.droppableId;
      const fromIdx = result.source.index;
      const toIdx = result.destination.index;
      if (fromCol === toCol && fromIdx === toIdx) return;

      setColumnState((prev) => {
        const next = {
          toReview: [...prev.toReview],
          approved: [...prev.approved],
        };
        const [moved] = next[fromCol].splice(fromIdx, 1);
        if (!moved) return prev;
        next[toCol].splice(toIdx, 0, moved);
        return next;
      });
    },
    [isLocked],
  );

  // ── Lock action ──────────────────────────────────────────────────────────
  const [confirmLockOpen, setConfirmLockOpen] = useState(false);
  const [isLocking, setIsLocking] = useState(false);
  const [progressDialogOpen, setProgressDialogOpen] = useState(false);
  const [lockInitialResponse, setLockInitialResponse] = useState(null);

  const approvedStems = useMemo(
    () => columnState.approved.map((f) => stemOf(f.name)).filter(Boolean),
    [columnState.approved],
  );

  const lockShortlist = useCallback(async () => {
    if (!roundId || approvedStems.length === 0) return;
    setIsLocking(true);
    try {
      const resp = await api.functions.invoke("shortlist-lock", {
        round_id: roundId,
        mode: "manual",
        approved_stems: approvedStems,
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false) {
        throw new Error(result?.error || "Lock failed");
      }
      setLockInitialResponse(result);
      setProgressDialogOpen(true);
      setConfirmLockOpen(false);
      if (result?.status === "complete" || result?.already_locked) {
        queryClient.invalidateQueries({
          queryKey: ["shortlisting_rounds", projectId],
        });
        const moved = result?.moved || {};
        toast.success(
          (moved.approved || 0) > 0
            ? `Shortlist locked — moved ${moved.approved} file(s).`
            : "Shortlist locked.",
        );
      }
    } catch (err) {
      console.error("[ManualShortlistingSwimlane] lockShortlist failed:", err);
      toast.error(err?.message || "Lock failed");
    } finally {
      setIsLocking(false);
    }
  }, [roundId, approvedStems, projectId, queryClient]);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["manual_shortlist_files", projectId, sourceFolderPath],
    });
  }, [queryClient, projectId, sourceFolderPath]);

  // ── Loading / error / locked states ──────────────────────────────────────
  if (filesQuery.isLoading) {
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

  if (!sourceFolderPath) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div>
              <p className="font-medium text-foreground">
                Project Dropbox folder not provisioned
              </p>
              <p className="text-xs mt-1">
                Manual-mode shortlisting needs the project's
                <code className="text-[11px] font-mono mx-1">
                  Photos/Raws/Shortlist Proposed/
                </code>
                folder. Provision project folders first.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  if (filesQuery.error) {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-red-700 dark:text-red-300">
          <p className="font-medium">Failed to list source folder</p>
          <p className="text-xs mt-0.5">
            {filesQuery.error.message || "Unknown error"}
          </p>
        </div>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-3" data-testid="manual-shortlisting-swimlane">
      {/* Banner explaining manual mode */}
      <div className="rounded-md border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-3 text-xs">
        <div className="flex items-start gap-2">
          <FileImage className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
          <div className="flex-1">
            <p className="font-semibold text-amber-900 dark:text-amber-200">
              Manual mode
            </p>
            <p className="text-amber-800 dark:text-amber-300 mt-0.5">
              {round?.manual_mode_reason === "project_type_unsupported"
                ? "AI shortlisting is disabled for this project type. Drag files into the Approved column, then hit Lock to move them to Final Shortlist."
                : round?.manual_mode_reason === "no_photo_products"
                  ? "This project has no photo deliverables. The shortlisting subtab still lets you stage files manually if you need to."
                  : "Drag files into the Approved column, then hit Lock to move them to Final Shortlist."}
            </p>
          </div>
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-xs text-muted-foreground">
          {filesQuery.data?.length || 0} file{(filesQuery.data?.length || 0) === 1 ? "" : "s"} in source folder
          {" · "}
          <span className="font-medium text-foreground">
            {columnState.approved.length} approved
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={filesQuery.isFetching}
            data-testid="manual-shortlisting-refresh"
          >
            {filesQuery.isFetching ? (
              <Loader2 className="h-4 w-4 mr-1 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-1" />
            )}
            Refresh
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmLockOpen(true)}
            disabled={
              isLocked || isLocking || columnState.approved.length === 0
            }
            data-testid="manual-shortlisting-lock"
            title={
              isLocked
                ? "Round is already locked"
                : columnState.approved.length === 0
                  ? "Drag at least one file to Approved before locking"
                  : "Lock & move approved files to Final Shortlist"
            }
          >
            {isLocked ? (
              <>
                <CheckCircle2 className="h-4 w-4 mr-1" />
                Locked
              </>
            ) : (
              <>
                <Lock className="h-4 w-4 mr-1" />
                Lock & Reorganize
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Two-column swimlane */}
      <DragDropContext onDragEnd={onDragEnd}>
        <div className="flex gap-3">
          <Column
            id="toReview"
            label="Files to review"
            headerTone="bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200"
            files={columnState.toReview}
            locked={isLocked}
          />
          <Column
            id="approved"
            label="Approved"
            headerTone="bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300"
            files={columnState.approved}
            locked={isLocked}
          />
        </div>
      </DragDropContext>

      {/* Confirm Lock dialog */}
      <Dialog open={confirmLockOpen} onOpenChange={setConfirmLockOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Lock manual shortlist?</DialogTitle>
            <DialogDescription>
              {columnState.approved.length} file(s) will move from
              <code className="text-[11px] font-mono mx-1">
                Photos/Raws/Shortlist Proposed/
              </code>
              to
              <code className="text-[11px] font-mono mx-1">
                Photos/Raws/Final Shortlist/
              </code>
              {". "}
              Files left in the source folder are NOT touched.
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
              {isLocking && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Lock & move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Progress dialog (shared with engine mode — polls shortlist-lock-status) */}
      <LockProgressDialog
        open={progressDialogOpen}
        onOpenChange={setProgressDialogOpen}
        roundId={roundId}
        projectId={projectId}
        initialResponse={lockInitialResponse}
      />
    </div>
  );
}

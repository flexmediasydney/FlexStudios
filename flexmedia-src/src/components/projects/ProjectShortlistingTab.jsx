/**
 * ProjectShortlistingTab — Wave 6 Phase 6 SHORTLIST
 *
 * Top-level tab content for the project detail page's "Shortlisting" tab.
 *
 * Layout (mirrors ProjectDronesTab pattern):
 *   - Top: round selector dropdown + "Run Shortlist Now" button
 *   - Sub-tabs (Tabs primitive): Swimlane | Rounds | Coverage | Retouch
 *                                | Quarantine | Audit
 *   - Each sub-tab is lazy-mounted (component renders on first click)
 *
 * URL state:
 *   ?tab=shortlisting           parent ProjectDetails tab
 *   ?sub=swimlane|rounds|...    active sub-tab here (default: swimlane)
 *   ?round=<round_id>           selected round
 *
 * Data:
 *   - api.entities.ShortlistingRound.filter({ project_id }, '-round_number', 100)
 *   - subscribes for live status updates
 */
import { useEffect, useMemo, useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/supabaseClient";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Image as ImageIcon,
  Loader2,
  AlertCircle,
  RefreshCw,
  Play,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import ShortlistingSwimlane from "./shortlisting/ShortlistingSwimlane";
import ManualShortlistingSwimlane from "./shortlisting/ManualShortlistingSwimlane";
import ShortlistingRoundsList from "./shortlisting/ShortlistingRoundsList";
import ShortlistingCoverageMap from "./shortlisting/ShortlistingCoverageMap";
import ShortlistingRetouchFlags from "./shortlisting/ShortlistingRetouchFlags";
import ShortlistingQuarantine from "./shortlisting/ShortlistingQuarantine";
import ShortlistingAuditLog from "./shortlisting/ShortlistingAuditLog";
import SpaceInstancesPanel from "./shortlisting/audit/SpaceInstancesPanel";
import PendingIngestsWidget from "@/components/settings/shortlisting/PendingIngestsWidget";
import ActiveEngineRunsWidget from "@/components/settings/shortlisting/ActiveEngineRunsWidget";
import { useEntityList } from "@/components/hooks/useEntityData";

// Sub-tab keys
const SUB_TABS = [
  { key: "swimlane", label: "Swimlane" },
  { key: "rounds", label: "Rounds" },
  { key: "coverage", label: "Coverage" },
  { key: "retouch", label: "Retouch" },
  { key: "quarantine", label: "Quarantine" },
  { key: "audit", label: "Audit" },
];
const SUB_TAB_KEYS = new Set(SUB_TABS.map((t) => t.key));

// Round status → tone for the chip beside the round selector
const ROUND_STATUS_TONE = {
  pending: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200",
  processing: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  proposed: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  locked: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  delivered: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  // Wave 7 P1-19 (W7.13): manual-mode rounds (no Pass 0/1/2/3, just operator
  // drag-and-drop). Distinct amber tone so they're visually obvious in the
  // round selector.
  manual: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

const ROUND_STATUS_LABEL = {
  pending: "Pending",
  processing: "Processing",
  proposed: "Proposed",
  locked: "Locked",
  delivered: "Delivered",
  manual: "Manual",
};

// ── URL helpers ───────────────────────────────────────────────────────────
function readSearchParam(name) {
  try {
    return new URLSearchParams(window.location.search).get(name);
  } catch {
    return null;
  }
}
function writeSearchParam(name, value) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (value) params.set(name, value);
    else params.delete(name);
    const search = params.toString();
    const url = `${window.location.pathname}${search ? `?${search}` : ""}`;
    window.history.replaceState(null, "", url);
  } catch {
    /* ignore */
  }
}

// ── Main component ───────────────────────────────────────────────────────
export default function ProjectShortlistingTab({ project }) {
  const queryClient = useQueryClient();
  const projectId = project?.id;

  // Wave 7 P1-19 (W7.13): determine if this project runs in manual mode.
  // Manual mode is set by the project's project_type.shortlisting_supported
  // flag (W7.7 added the column with default true). When false, the swimlane
  // skips the engine-mode AI columns and renders the simpler two-column UI.
  // We don't gate the rounds-list / audit / coverage subtabs on manual mode —
  // those still work for manual rounds (just with mostly-null data).
  const { data: projectTypes = [] } = useEntityList("ProjectType", "order");
  const projectType = useMemo(
    () =>
      projectTypes.find((pt) => pt.id === project?.project_type_id) || null,
    [projectTypes, project?.project_type_id],
  );
  // Default to engine-mode (true) if the project_type lookup hasn't resolved
  // yet OR the project has no project_type_id assigned. Manual mode opts IN —
  // we don't want a transient FK miss to flip a real engine project.
  const isManualMode =
    projectType?.shortlisting_supported === false;

  // URL-driven state
  const [activeSubtab, setActiveSubtab] = useState(() => {
    const t = readSearchParam("sub");
    return t && SUB_TAB_KEYS.has(t) ? t : "swimlane";
  });
  const [selectedRoundId, setSelectedRoundId] = useState(() =>
    readSearchParam("round"),
  );
  const [mountedSubtabs, setMountedSubtabs] = useState(
    () => new Set([activeSubtab]),
  );

  // Persist URL on changes
  useEffect(() => {
    writeSearchParam(
      "sub",
      activeSubtab === "swimlane" ? null : activeSubtab,
    );
  }, [activeSubtab]);
  useEffect(() => {
    writeSearchParam("round", selectedRoundId);
  }, [selectedRoundId]);

  const handleSubtabChange = useCallback((next) => {
    setActiveSubtab(next);
    setMountedSubtabs((prev) => {
      if (prev.has(next)) return prev;
      return new Set([...prev, next]);
    });
  }, []);

  // ── Rounds list ─────────────────────────────────────────────────────────
  const roundsKey = ["shortlisting_rounds", projectId];
  const roundsQuery = useQuery({
    queryKey: roundsKey,
    queryFn: async () => {
      const rows = await api.entities.ShortlistingRound.filter(
        { project_id: projectId },
        "-round_number",
        100,
      );
      return rows || [];
    },
    enabled: Boolean(projectId),
    staleTime: 15_000,
  });

  // Realtime: invalidate on any insert/update for this project's rounds
  useEffect(() => {
    if (!projectId) return;
    let active = true;
    const unsubscribe = api.entities.ShortlistingRound.subscribe((evt) => {
      if (!active) return;
      if (!evt.data?.project_id || evt.data.project_id !== projectId) return;
      queryClient.invalidateQueries({ queryKey: ["shortlisting_rounds", projectId] });
    });
    return () => {
      active = false;
      try {
        if (typeof unsubscribe === "function") unsubscribe();
      } catch (e) {
        console.warn("[ProjectShortlistingTab] ShortlistingRound unsubscribe failed:", e);
      }
    };
  }, [projectId, queryClient]);

  const rounds = roundsQuery.data || [];

  // Auto-select most recent round if none pinned in URL
  const firstRoundId = rounds[0]?.id || null;
  const selectedRoundStillExists =
    selectedRoundId && rounds.some((r) => r.id === selectedRoundId);
  useEffect(() => {
    if (!firstRoundId) return;
    if (!selectedRoundId) {
      setSelectedRoundId(firstRoundId);
      return;
    }
    if (!selectedRoundStillExists) {
      setSelectedRoundId(firstRoundId);
    }
  }, [firstRoundId, selectedRoundId, selectedRoundStillExists]);

  const selectedRound = useMemo(
    () => rounds.find((r) => r.id === selectedRoundId) || null,
    [rounds, selectedRoundId],
  );

  // ── Manual "Run Shortlist Now" ──────────────────────────────────────────
  const [isRunning, setIsRunning] = useState(false);
  const [confirmRunOpen, setConfirmRunOpen] = useState(false);
  // Disable while a round is currently in 'processing' or 'pending'.
  // Wave 7 P1-19 (W7.13): also block if there's an unfinished manual round —
  // the operator should lock or discard it before opening another.
  const hasInflightRound = rounds.some((r) =>
    ["processing", "pending", "manual"].includes(r.status),
  );

  const runShortlistNow = useCallback(async () => {
    // 2026-05-04 — heavy diagnostic logging.  The previous version had a
    // silent `if (!projectId) return;` guard that caused "button does
    // nothing" reports when projectId was unexpectedly null (e.g. parent
    // component deferred its render).  Every code path now logs to the
    // browser console + emits a toast so an operator can diagnose what
    // happened without the dev needing to reproduce.
    const startedAt = Date.now();
    console.info("[ShortlistingTab] runShortlistNow CLICKED", {
      projectId,
      isManualMode,
      hasInflightRound,
      timestamp: new Date().toISOString(),
    });

    if (!projectId) {
      console.error("[ShortlistingTab] runShortlistNow: projectId is missing", { projectId, project });
      toast.error(
        "Cannot run shortlist — project not loaded yet.  Refresh the page and try again.",
      );
      setConfirmRunOpen(false);
      return;
    }

    setIsRunning(true);
    try {
      console.info("[ShortlistingTab] invoking shortlisting-ingest...", {
        project_id: projectId,
        trigger_source: "manual",
      });
      const resp = await api.functions.invoke("shortlisting-ingest", {
        project_id: projectId,
        trigger_source: "manual",
      });
      const elapsedMs = Date.now() - startedAt;
      console.info("[ShortlistingTab] shortlisting-ingest response", {
        elapsedMs,
        status: resp?.status,
        hasData: !!resp?.data,
        hasError: !!resp?.error,
        rawShape: resp ? Object.keys(resp) : null,
      });

      // Supabase JS sometimes returns shape `{ data, error }` and sometimes
      // returns the unwrapped result directly.  Cover both.  Also surface
      // the network-level error from supabase-js if present.
      if (resp?.error) {
        const httpStatus = resp?.status ?? "?";
        throw new Error(
          `Edge function error (HTTP ${httpStatus}): ${resp.error.message || resp.error}`,
        );
      }
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false || result?.success === false) {
        throw new Error(result?.error || result?.message || "Server returned ok=false with no error message");
      }

      console.info("[ShortlistingTab] round started successfully", {
        round_id: result?.round_id,
        round_number: result?.round_number,
        file_count: result?.file_count,
        job_count: Array.isArray(result?.job_ids) ? result.job_ids.length : null,
      });
      toast.success(
        result?.round_number
          ? `Shortlist Round ${result.round_number} started — ${result?.file_count ?? "?"} files queued.`
          : "Shortlist round started.",
      );
      queryClient.invalidateQueries({ queryKey: ["shortlisting_rounds", projectId] });
    } catch (err) {
      // Heavily-instrumented error path so operators can self-diagnose.
      // Log the full err object (not just .message) — supabase-js attaches
      // .context, .name, .stack on different error subtypes that all matter
      // for debugging.
      console.error("[ShortlistingTab] runShortlistNow FAILED", {
        err,
        message: err?.message,
        name: err?.name,
        cause: err?.cause,
        context: err?.context,
        stack: err?.stack,
      });
      const msg = err?.message || String(err) || "Run shortlist failed (no error message)";
      // Use a longer-duration toast for errors so the operator can read it.
      // Default toast is ~3s; errors get 8s.
      toast.error(`Run shortlist failed: ${msg}`, { duration: 8000 });
    } finally {
      setIsRunning(false);
      setConfirmRunOpen(false);
    }
  }, [projectId, project, isManualMode, hasInflightRound, queryClient]);

  const handleRefresh = useCallback(() => {
    if (!projectId) return;
    queryClient.invalidateQueries({ queryKey: ["shortlisting_rounds", projectId] });
  }, [projectId, queryClient]);

  // ── Render ──────────────────────────────────────────────────────────────
  if (!projectId) {
    return (
      <Card>
        <CardContent className="p-6 text-sm text-muted-foreground">
          No project loaded.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            Shortlisting
          </h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            {rounds.length === 0
              ? "No rounds yet"
              : `${rounds.length} round${rounds.length === 1 ? "" : "s"}`}
            {project?.shortlist_status && project.shortlist_status !== "not_started" && (
              <>
                {" · "}
                <span className="font-medium">
                  {project.shortlist_status.replace(/_/g, " ")}
                </span>
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Round selector */}
          {rounds.length > 0 && (
            <Select value={selectedRoundId || ""} onValueChange={setSelectedRoundId}>
              <SelectTrigger className="h-8 w-[260px] text-xs">
                <SelectValue placeholder="Select round" />
              </SelectTrigger>
              <SelectContent>
                {rounds.map((r) => (
                  <SelectItem key={r.id} value={r.id} className="text-xs">
                    Round {r.round_number}
                    {r.package_type ? ` · ${r.package_type}` : ""} ·{" "}
                    {ROUND_STATUS_LABEL[r.status] || r.status}
                    {r.created_at ? ` · ${format(new Date(r.created_at), "d MMM")}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}

          {selectedRound && (
            <Badge
              className={cn(
                "text-[10px] h-5 px-1.5",
                ROUND_STATUS_TONE[selectedRound.status] ||
                  ROUND_STATUS_TONE.pending,
              )}
            >
              {ROUND_STATUS_LABEL[selectedRound.status] || selectedRound.status}
            </Badge>
          )}

          {/* Run Shortlist Now / New Manual Round */}
          {/* Wave 7 P1-19 (W7.13): label + dialog copy adapt to manual mode.
              The same shortlisting-ingest call powers both — ingest detects the
              manual-mode triggers (shortlisting_supported=false OR target=0)
              and returns a synthetic round without enqueuing Pass 0 jobs. */}
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              // 2026-05-04 — log every click so silent failures (button
              // visibly clicked but nothing happens) leave a paper trail
              // in the browser console.
              console.info("[ShortlistingTab] 'Run Shortlist Now' button clicked", {
                projectId,
                isManualMode,
                hasInflightRound,
                isRunning,
                shouldOpenDialog: !hasInflightRound && !isRunning,
              });
              setConfirmRunOpen(true);
            }}
            disabled={hasInflightRound || isRunning}
            title={
              hasInflightRound
                ? "A round is already running — wait for it to complete"
                : isManualMode
                  ? "Open a new manual-mode round for this project"
                  : "Trigger a new shortlist round for this project"
            }
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            {isManualMode ? "New Manual Round" : "Run Shortlist Now"}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={roundsQuery.isFetching}
          >
            {roundsQuery.isFetching ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4 mr-2" />
            )}
            Refresh
          </Button>
        </div>
      </div>

      {/* Error state */}
      {roundsQuery.error && (
        <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
          <div className="text-sm text-red-700 dark:text-red-300">
            <p className="font-medium">Failed to load shortlisting rounds</p>
            <p className="text-xs mt-0.5">
              {roundsQuery.error.message || "Unknown error"}
            </p>
          </div>
        </div>
      )}

      {/* Empty state — no rounds */}
      {!roundsQuery.isLoading && !roundsQuery.error && rounds.length === 0 && (
        <Card>
          <CardContent className="p-10 flex flex-col items-center text-center gap-3">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
              <ImageIcon className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {isManualMode
                  ? "No manual rounds yet"
                  : "No shortlist rounds yet"}
              </p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                {isManualMode ? (
                  <>
                    This project type runs shortlisting in manual mode (no AI).
                    Drop files into{" "}
                    <code className="text-[11px] font-mono">
                      Photos/Raws/Shortlist Proposed/
                    </code>{" "}
                    in Dropbox, then click <strong>New Manual Round</strong>{" "}
                    above to start triaging them.
                  </>
                ) : (
                  <>
                    Upload RAW CR3 photos to{" "}
                    <code className="text-[11px] font-mono">
                      Photos/Raws/Shortlist Proposed/
                    </code>{" "}
                    in Dropbox to trigger an auto-round, or click{" "}
                    <strong>Run Shortlist Now</strong> above.
                  </>
                )}
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Loading skeleton */}
      {roundsQuery.isLoading && (
        <Card>
          <CardContent className="p-6">
            <div className="space-y-2 animate-pulse">
              <div className="h-8 bg-muted rounded w-1/3" />
              <div className="h-48 bg-muted rounded" />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Engine pipeline status — per-project view of pending ingests +
          chain progress. Mounted regardless of round count so operators
          can see the ingest waiting on the 2h Dropbox-debounce even
          before any round exists for the project. */}
      {projectId && (
        <div className="space-y-2" data-testid="project-engine-status">
          <PendingIngestsWidget projectId={projectId} compact />
          <ActiveEngineRunsWidget projectId={projectId} compact />
        </div>
      )}

      {/* Sub-tabs */}
      {rounds.length > 0 && (
        <Tabs
          value={activeSubtab}
          onValueChange={handleSubtabChange}
          className="w-full"
        >
          <div className="overflow-x-auto border-b bg-muted/30">
            <TabsList className="inline-flex w-max min-w-full sm:w-full sm:grid sm:grid-cols-6 h-auto bg-transparent">
              {SUB_TABS.map((t) => (
                <TabsTrigger
                  key={t.key}
                  value={t.key}
                  className="text-xs px-2 py-1.5 whitespace-nowrap data-[state=active]:font-semibold"
                >
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          <TabsContent value="swimlane" className="mt-3">
            {mountedSubtabs.has("swimlane") && selectedRoundId ? (
              isManualMode ? (
                <ManualShortlistingSwimlane
                  roundId={selectedRoundId}
                  round={selectedRound}
                  projectId={projectId}
                  project={project}
                />
              ) : (
                <ShortlistingSwimlane
                  roundId={selectedRoundId}
                  round={selectedRound}
                  projectId={projectId}
                  project={project}
                />
              )
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>

          <TabsContent value="rounds" className="mt-3">
            {mountedSubtabs.has("rounds") ? (
              <ShortlistingRoundsList
                rounds={rounds}
                projectId={projectId}
                onSelectRound={(id) => {
                  setSelectedRoundId(id);
                  handleSubtabChange("swimlane");
                }}
              />
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>

          <TabsContent value="coverage" className="mt-3">
            {mountedSubtabs.has("coverage") && selectedRoundId ? (
              <ShortlistingCoverageMap
                roundId={selectedRoundId}
                round={selectedRound}
              />
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>

          <TabsContent value="retouch" className="mt-3">
            {mountedSubtabs.has("retouch") && selectedRoundId ? (
              <ShortlistingRetouchFlags roundId={selectedRoundId} />
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>

          <TabsContent value="quarantine" className="mt-3">
            {mountedSubtabs.has("quarantine") && selectedRoundId ? (
              <ShortlistingQuarantine roundId={selectedRoundId} />
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>

          <TabsContent value="audit" className="mt-3 space-y-4">
            {mountedSubtabs.has("audit") && selectedRoundId ? (
              <>
                <SpaceInstancesPanel roundId={selectedRoundId} />
                <ShortlistingAuditLog roundId={selectedRoundId} />
              </>
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Confirm "Run Shortlist Now" / "New Manual Round" */}
      <Dialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {isManualMode ? "Open new manual round?" : "Run shortlist now?"}
            </DialogTitle>
            <DialogDescription className="space-y-2">
              {isManualMode ? (
                <>
                  <p>
                    Opens a new <span className="font-medium">manual-mode</span>{" "}
                    round for this project.  No AI passes run — you'll drag
                    files into the Approved column yourself and lock when ready.
                  </p>
                </>
              ) : (
                <>
                  <p>
                    Triggers a new shortlist round for this project.  Pass 0
                    through Pass 3 run end-to-end:
                  </p>
                  <ul className="text-xs ml-4 list-disc space-y-0.5 text-muted-foreground">
                    <li><span className="font-medium">Ingest</span> &mdash; lists CR3 files in Dropbox + pre-bakes CDN links (~30s for 50 files)</li>
                    <li><span className="font-medium">Extract</span> &mdash; Modal pulls each CR3, generates JPEG previews, uploads to Supabase Storage</li>
                    <li><span className="font-medium">Pass 0&ndash;3</span> &mdash; vision API analyses + slot allocation (~1&ndash;2 min)</li>
                  </ul>
                  <p className="text-xs text-muted-foreground">
                    Vision API cost: ~$0.50 per round.
                  </p>
                </>
              )}
              <div className="text-xs bg-muted/50 rounded-md p-2 mt-2">
                <p className="font-medium mb-1">If nothing happens after clicking:</p>
                <ul className="ml-3 list-disc space-y-0.5 text-muted-foreground">
                  <li>Open browser DevTools (F12) and check the Console tab — every step logs there with the <code className="text-[10px]">[ShortlistingTab]</code> prefix</li>
                  <li>Look for a red toast in the top-right; errors stay visible 8 seconds</li>
                  <li>If you see <code className="text-[10px]">Cannot run shortlist — project not loaded yet</code>, hard-refresh the page (Cmd+Shift+R) and retry</li>
                </ul>
              </div>
              <p className="text-xs text-muted-foreground/70">
                Project ID: <code>{projectId || "—"}</code>
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setConfirmRunOpen(false)}
              disabled={isRunning}
            >
              Cancel
            </Button>
            <Button onClick={runShortlistNow} disabled={isRunning || !projectId}>
              {isRunning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {isRunning ? "Starting…" : (isManualMode ? "Open manual round" : "Run shortlist")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SubtabSkeleton() {
  return (
    <div className="space-y-3 animate-pulse">
      <div className="h-8 bg-muted rounded w-1/3" />
      <div className="h-48 bg-muted rounded" />
    </div>
  );
}

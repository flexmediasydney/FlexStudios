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
import ShortlistingRoundsList from "./shortlisting/ShortlistingRoundsList";
import ShortlistingCoverageMap from "./shortlisting/ShortlistingCoverageMap";
import ShortlistingRetouchFlags from "./shortlisting/ShortlistingRetouchFlags";
import ShortlistingQuarantine from "./shortlisting/ShortlistingQuarantine";
import ShortlistingAuditLog from "./shortlisting/ShortlistingAuditLog";

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
};

const ROUND_STATUS_LABEL = {
  pending: "Pending",
  processing: "Processing",
  proposed: "Proposed",
  locked: "Locked",
  delivered: "Delivered",
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
  // Disable while a round is currently in 'processing' or 'pending'
  const hasInflightRound = rounds.some((r) =>
    ["processing", "pending"].includes(r.status),
  );

  const runShortlistNow = useCallback(async () => {
    if (!projectId) return;
    setIsRunning(true);
    try {
      const resp = await api.functions.invoke("shortlisting-ingest", {
        project_id: projectId,
        trigger_source: "manual",
      });
      const result = resp?.data ?? resp ?? {};
      if (result?.ok === false || result?.success === false) {
        throw new Error(result?.error || "Run failed");
      }
      toast.success("Shortlist round started.");
      queryClient.invalidateQueries({ queryKey: ["shortlisting_rounds", projectId] });
    } catch (err) {
      console.error("[ProjectShortlistingTab] runShortlistNow failed:", err);
      toast.error(err?.message || "Run shortlist failed");
    } finally {
      setIsRunning(false);
      setConfirmRunOpen(false);
    }
  }, [projectId, queryClient]);

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

          {/* Run Shortlist Now */}
          <Button
            variant="default"
            size="sm"
            onClick={() => setConfirmRunOpen(true)}
            disabled={hasInflightRound || isRunning}
            title={
              hasInflightRound
                ? "A round is already running — wait for it to complete"
                : "Trigger a new shortlist round for this project"
            }
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Play className="h-4 w-4 mr-2" />
            )}
            Run Shortlist Now
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
              <p className="text-sm font-medium">No shortlist rounds yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-md">
                Upload RAW CR3 photos to{" "}
                <code className="text-[11px] font-mono">
                  Photos/Raws/Shortlist Proposed/
                </code>{" "}
                in Dropbox to trigger an auto-round, or click{" "}
                <strong>Run Shortlist Now</strong> above.
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
              <ShortlistingSwimlane
                roundId={selectedRoundId}
                round={selectedRound}
                projectId={projectId}
                project={project}
              />
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

          <TabsContent value="audit" className="mt-3">
            {mountedSubtabs.has("audit") && selectedRoundId ? (
              <ShortlistingAuditLog roundId={selectedRoundId} />
            ) : (
              <SubtabSkeleton />
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Confirm "Run Shortlist Now" */}
      <Dialog open={confirmRunOpen} onOpenChange={setConfirmRunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run shortlist now?</DialogTitle>
            <DialogDescription>
              This triggers a new shortlist round for this project. Pass 0
              through Pass 3 will run end-to-end and may take 1-2 minutes plus
              vision API cost (~$0.50 per round).
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
            <Button onClick={runShortlistNow} disabled={isRunning}>
              {isRunning && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Run shortlist
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

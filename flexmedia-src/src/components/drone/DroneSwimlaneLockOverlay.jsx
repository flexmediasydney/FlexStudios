/**
 * DroneSwimlaneLockOverlay — Wave 9 S3 (architect Section C.4)
 *
 * Operator-action lock for the drone subtab swimlanes.
 *
 * When the pipeline is mid-flight (any stage before `proposed_ready`), the
 * operator-facing controls (Accept/Reject, Lock shortlist, Send back, etc.)
 * are visually disabled and an overlay explains what's blocking. Once the
 * server flips `pipeline_state.operator_actions_unlocked` to true (at
 * `proposed_ready` plus boundary saved — mig 329), the overlay falls away
 * and `children` becomes interactive again.
 *
 * W14 S1 fix: the previous implementation read currentStage.started_at and
 * computed elapsed-since-started without checking that the stage was
 * actually still running. After all auto-stages completed but the operator
 * hadn't acted yet, current_stage walked back to the most recent completed
 * stage and the overlay flashed e.g. "Currently running drone-render ·
 * 274:38 elapsed" — a fiction. Now we only show "currently running" when
 * an active_jobs entry has status='running' AND its finished_at is null.
 * Otherwise we fall back to the blocking-stage label so operators know
 * what they need to do (e.g. "waiting on Boundary Editor save").
 *
 * Props:
 *   - pipelineState: the {stages, current_stage, operator_actions_unlocked, ...}
 *     object returned by useDronePipelineState (Stream 2). When null/undefined
 *     the overlay treats the lane as UNLOCKED so the page still loads while
 *     the hook resolves.
 *   - children: the swimlane content to render behind the overlay.
 */

import { Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import DroneStageProgress from "@/components/drone/DroneStageProgress";

// Human-readable labels for the blocking-stage fallback when no job is
// actively running. Mirrors DroneStageProgress.DEFAULT_STAGE_ORDER labels.
const STAGE_LABEL = {
  ingest:          "Ingest",
  sfm:             "SfM",
  poi:             "POIs",
  cadastral:       "Cadastral",
  raw_render:      "Raw render",
  boundary_review: "Boundary Editor save",
  operator_triage: "operator triage",
  editor_handoff:  "editor handoff",
  edited_render:   "Edited render",
  edited_curate:   "edited curate",
  final:           "Final render",
  delivered:       "delivery",
};

export default function DroneSwimlaneLockOverlay({ pipelineState, children }) {
  // No state yet (loading / hook hasn't shipped) → render children unlocked.
  // Explicit unlock flag flips the gate.
  const locked = Boolean(pipelineState) && pipelineState.operator_actions_unlocked === false;

  if (!locked) return children;

  const stages = Array.isArray(pipelineState?.stages) ? pipelineState.stages : [];
  const currentStage = stages.find((s) => s?.stage_key === pipelineState?.current_stage) || null;

  // W14 S1: only treat a job as "currently running" when it explicitly has
  // status='running' AND finished_at is null. The previous implementation
  // grabbed activeJobs[0] which the RPC sorts running-first — but if no
  // jobs are running, [0] could be a pending entry, and elapsed was
  // computed from currentStage.started_at without checking the stage was
  // actually still in flight (so completed stages flashed huge elapsed
  // counters).
  const activeJobs = Array.isArray(pipelineState?.active_jobs) ? pipelineState.active_jobs : [];
  const runningJob = activeJobs.find(
    (j) => j?.status === "running" && !j?.finished_at,
  );
  // Stage row counts as running only if its server-side status is 'running'
  // (the RPC computes this from the underlying job_status — e.g. 'running'
  // / 'pending' / 'completed' — so this also masks the completed-stage
  // false-positive even when a stale runningJob slipped through).
  const stageIsRunning = currentStage?.status === "running";

  // What gets shown in the "currently running" line.
  let statusLine;
  if (runningJob && stageIsRunning) {
    const fnName =
      runningJob.function_name ||
      currentStage?.function_name ||
      currentStage?.stage_key ||
      "processing";
    // elapsed only makes sense from a real start. Use the running job's
    // started_at first (authoritative — it's the actual job that's
    // executing), fall back to the stage row.
    const startedAt = runningJob.started_at || currentStage?.started_at;
    const elapsedSec = startedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
      : 0;
    const etaSec =
      typeof currentStage?.eta_ms === "number"
        ? Math.round(currentStage.eta_ms / 1000)
        : typeof currentStage?.eta_seconds_remaining === "number"
        ? currentStage.eta_seconds_remaining
        : null;
    statusLine = (
      <>
        Currently running <span className="font-mono">{fnName}</span>
        {typeof etaSec === "number" && etaSec > 0
          ? ` · ETA ~${Math.ceil(etaSec / 60)} min`
          : ""}
        {elapsedSec > 0
          ? ` · ${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")} elapsed`
          : ""}
      </>
    );
  } else if (currentStage?.stage_key) {
    // No actively-running job — describe what's blocking instead so
    // operators know what action unlocks the swimlane.
    const label =
      STAGE_LABEL[currentStage.stage_key] || currentStage.stage_key;
    statusLine = (
      <>
        Pipeline waiting on: <span className="font-mono">{label}</span>
      </>
    );
  } else {
    // Pipeline hasn't started yet (no current_stage). Generic copy.
    statusLine = "Waiting for pipeline to start";
  }

  return (
    <div className="relative">
      {/* Children behind, non-interactive */}
      <div className="pointer-events-none opacity-40" aria-hidden="true">
        {children}
      </div>

      {/* Overlay */}
      <div
        className="absolute inset-0 flex items-center justify-center bg-background/80 backdrop-blur-sm pointer-events-auto p-4"
        role="status"
        aria-live="polite"
      >
        <Card className="max-w-2xl w-full p-8 text-center space-y-4">
          <div className="flex items-center justify-center gap-2 text-lg font-semibold">
            <Lock className="h-5 w-5" />
            Processing — operator actions unlock at proposed_ready
          </div>
          <div className="text-sm text-muted-foreground">{statusLine}</div>
          <DroneStageProgress pipelineState={pipelineState} compact={false} />
        </Card>
      </div>
    </div>
  );
}

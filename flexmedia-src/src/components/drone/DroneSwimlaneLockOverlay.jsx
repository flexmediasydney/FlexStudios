/**
 * DroneSwimlaneLockOverlay — Wave 9 S3 (architect Section C.4)
 *
 * Operator-action lock for the drone subtab swimlanes.
 *
 * When the pipeline is mid-flight (any stage before `proposed_ready`), the
 * operator-facing controls (Accept/Reject, Lock shortlist, Send back, etc.)
 * are visually disabled and an overlay explains what's blocking. Once the
 * server flips `pipeline_state.operator_actions_unlocked` to true (at
 * `proposed_ready`), the overlay falls away and `children` becomes
 * interactive again.
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

export default function DroneSwimlaneLockOverlay({ pipelineState, children }) {
  // No state yet (loading / hook hasn't shipped) → render children unlocked.
  // Explicit unlock flag flips the gate.
  const locked = Boolean(pipelineState) && pipelineState.operator_actions_unlocked === false;

  if (!locked) return children;

  // S2 RPC shape (architect Section A.2):
  //   stages[].stage_key   — e.g. 'drone-sfm'
  //   stages[].started_at  — ISO timestamp when stage entered running
  //   stages[].eta_ms      — milliseconds remaining (per S1)
  //   active_job.function_name — current edge function name when running
  const stages = Array.isArray(pipelineState?.stages) ? pipelineState.stages : [];
  const currentStage = stages.find((s) => s?.stage_key === pipelineState?.current_stage) || null;
  // Prefer the live active job's function name if available (it's the
  // authoritative "what's executing right now"), fall back to stage_key.
  // QC iter 6 C: RPC exposes active_jobs (plural array, sorted running first
  // per mig 301), not active_job. Pick the first running/pending entry.
  const activeJobs = Array.isArray(pipelineState?.active_jobs) ? pipelineState.active_jobs : [];
  const activeJob = activeJobs[0] || null;
  const fnName =
    activeJob?.function_name ||
    currentStage?.function_name ||
    currentStage?.stage_key ||
    "processing";
  const startedAt = currentStage?.started_at;
  const elapsedSec = startedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000))
    : 0;
  // S2 returns eta_ms (milliseconds). Older drafts used eta_seconds_remaining
  // — keep both readers so a partial S1 deploy doesn't break the overlay.
  const etaSec =
    typeof currentStage?.eta_ms === "number"
      ? Math.round(currentStage.eta_ms / 1000)
      : typeof currentStage?.eta_seconds_remaining === "number"
      ? currentStage.eta_seconds_remaining
      : null;

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
          <div className="text-sm text-muted-foreground">
            Currently running <span className="font-mono">{fnName}</span>
            {typeof etaSec === "number" && etaSec > 0
              ? ` · ETA ~${Math.ceil(etaSec / 60)} min`
              : ""}
            {elapsedSec > 0
              ? ` · ${Math.floor(elapsedSec / 60)}:${String(elapsedSec % 60).padStart(2, "0")} elapsed`
              : ""}
          </div>
          <DroneStageProgress pipelineState={pipelineState} compact={false} />
        </Card>
      </div>
    </div>
  );
}

/**
 * useDronePipelineState — Wave 9 Stream 2 (PLACEHOLDER SHIM)
 *
 * ⚠️ S3 SHIM: this file is a build-passing placeholder that returns no
 * pipeline data. Stream 2 owns this file and will replace it with the real
 * implementation (subscribes to drone_pipeline_state + invokes
 * drone-pipeline-fire / drone-pipeline-rerun edge fns).
 *
 * Returning a null pipelineState means consumers (Banner, Stage strip, lock
 * overlay) render their no-op / pass-through state, so the page keeps
 * loading even before S2 lands.
 *
 * Planned interface (locked with S2):
 *   {
 *     pipelineState: {
 *       current_stage: string,
 *       operator_actions_unlocked: boolean,
 *       active_ingest_job: { id, fires_at, ... } | null,
 *       stages: Array<{
 *         stage_key: string,           // e.g. 'ingest' | 'sfm' | 'render' | ...
 *         function_name: string,       // edge fn name
 *         status: 'pending' | 'running' | 'complete' | 'failed',
 *         started_at: ISO string | null,
 *         eta_seconds_remaining: number | null,
 *       }>,
 *     } | null,
 *     forceFireNow: (jobId: string) => Promise<void>,
 *     rerunStage: (stageKey: string) => Promise<void>,
 *     isFiring: boolean,
 *     isRerunning: boolean,
 *   }
 */

// eslint-disable-next-line no-unused-vars
export function useDronePipelineState(_projectId, _shootId) {
  return {
    pipelineState: null,
    forceFireNow: async () => {},
    rerunStage: async () => {},
    isFiring: false,
    isRerunning: false,
  };
}

export default useDronePipelineState;

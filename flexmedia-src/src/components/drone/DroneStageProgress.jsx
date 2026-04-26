/**
 * DroneStageProgress — Wave 9 Stream 2 (PLACEHOLDER SHIM)
 *
 * ⚠️ S3 SHIM: this file is a build-passing placeholder. Stream 2 owns this
 * file and will replace it with the real stage-progress strip (ingest →
 * sfm → render → proposed → adjustments → final).
 *
 * Planned props (locked with S2):
 *   { pipelineState, compact?: boolean }
 */

export default function DroneStageProgress({ pipelineState, compact: _compact }) {
  if (!pipelineState) return null;
  // No-op shim — when S2 ships, this becomes the real strip.
  return null;
}

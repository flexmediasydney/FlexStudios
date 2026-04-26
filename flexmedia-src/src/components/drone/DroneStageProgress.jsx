/**
 * DroneStageProgress — Wave 9 S2 (W14 S1: 12-stage with boundary_review)
 * ─────────────────────────────────
 * Visual stage stepper with the 12 pipeline stages (architect Section A.1
 * + W14 S1 boundary_review insert).
 *
 * Modes:
 *   compact={false} (default): horizontal chevron pills with stage names + duration/ETA below
 *   compact={true}: single-line pill row, hover tooltips with details
 *
 * Per stage:
 *   completed              → emerald-filled with check
 *   running                → blue-filled with spinner
 *   queued/pending/debouncing → soft blue with spinner
 *   ready                  → slate-filled (operator action ready)
 *   failed/dead_letter     → red-filled with alert
 *   future (no row)        → muted hollow circle
 *
 * Below each pill: 11px gray text "X:XX" duration if complete, "ETA X:XX" if running.
 * Wraps to 2 rows below 768px (the row uses flex-wrap so 12 vs 11 stages
 * is purely a layout-flow concern; no fixed grid columns to bump).
 * Tooltip on hover: function_name (or stage label), job_id, scheduled_for, attempt_count,
 *                  error_message.
 *
 * RPC contract source of truth: supabase/migrations/329_get_drone_pipeline_state_add_boundary_review_stage.sql
 *   stage_key values match exactly: ingest, sfm, poi, cadastral, raw_render,
 *   boundary_review, operator_triage, editor_handoff, edited_render,
 *   edited_curate, final, delivered.
 *   eta is in seconds (eta_seconds_remaining), not ms.
 */

import { useMemo } from 'react';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Check,
  Loader2,
  Lock,
  AlertTriangle,
  Circle,
  ChevronRight,
  Map as MapIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Canonical 12-stage order — matches migration 329 exactly. boundary_review
// (idx 5) was inserted between cadastral and operator_triage in W14 S1 so
// the operator can SEE the boundary save as the next blocking step.
// Each shoot rolls through these; if a stage isn't applicable to a given
// shoot it appears as 'future' and is grey.
const DEFAULT_STAGE_ORDER = [
  { key: 'ingest',          label: 'Ingest',          function_name: 'drone-ingest' },
  { key: 'sfm',             label: 'SfM',             function_name: 'drone-sfm' },
  { key: 'poi',             label: 'POIs',            function_name: 'drone-pois' },
  { key: 'cadastral',       label: 'Cadastral',       function_name: 'drone-cadastral' },
  { key: 'raw_render',      label: 'Raw render',      function_name: 'drone-raw-preview' },
  { key: 'boundary_review', label: 'Boundary',        function_name: null },
  { key: 'operator_triage', label: 'Operator triage', function_name: null },
  { key: 'editor_handoff',  label: 'Editor handoff',  function_name: null },
  { key: 'edited_render',   label: 'Edited render',   function_name: 'drone-render-edited' },
  { key: 'edited_curate',   label: 'Edited curate',   function_name: null },
  { key: 'final',           label: 'Final render',    function_name: 'drone-render' },
  { key: 'delivered',       label: 'Delivered',       function_name: null },
];

// Stage-key → optional icon override for the pill body. Most stages use the
// status-derived icon (check / spinner / lock / alert / circle), but
// boundary_review benefits from a Map glyph so operators can recognise it
// at a glance from across the swimlane.
const STAGE_ICON_OVERRIDE = {
  boundary_review: MapIcon,
};

// ── helpers ────────────────────────────────────────────────────────────────
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function statusStyles(status) {
  switch (status) {
    case 'completed':
      return {
        pill: 'bg-emerald-500 text-white border-emerald-500',
        icon: <Check className="h-3 w-3" aria-hidden="true" />,
        srLabel: 'completed',
      };
    case 'running':
      return {
        pill: 'bg-blue-500 text-white border-blue-500',
        icon: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
        srLabel: 'running',
      };
    case 'queued':
    case 'pending':
    case 'debouncing':
      // Queued / debouncing — same family as running but not yet picked up
      // by the dispatcher.
      return {
        pill: 'bg-blue-100 text-blue-800 border-blue-300',
        icon: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
        srLabel: status,
      };
    case 'ready':
      // Operator-action stages with a green-light status (e.g.
      // operator_triage at proposed_ready). Slate with a subtle highlight.
      return {
        pill: 'bg-slate-700 text-white border-slate-700',
        icon: <Lock className="h-3 w-3" aria-hidden="true" />,
        srLabel: 'ready for operator',
      };
    case 'failed':
    case 'dead_letter':
      return {
        pill: 'bg-red-500 text-white border-red-500',
        icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
        srLabel: status === 'dead_letter' ? 'dead-letter' : 'failed',
      };
    case 'future':
    default:
      return {
        pill: 'bg-transparent text-muted-foreground border-muted-foreground/40',
        icon: <Circle className="h-3 w-3" aria-hidden="true" />,
        srLabel: 'not started',
      };
  }
}

/**
 * @param {object} props
 * @param {object|null} props.pipelineState  — RPC payload from useDronePipelineState
 * @param {boolean} [props.compact=false]
 */
export default function DroneStageProgress({ pipelineState, compact = false }) {
  // Normalise: merge RPC stages (when supplied) with the canonical 11-stage
  // order so the strip always shows the full pipeline. Missing stages render
  // as 'future'. Status defaults to 'future' for unmatched rows.
  const stages = useMemo(() => {
    const byKey = new Map();
    (pipelineState?.stages || []).forEach((s) => {
      if (s && s.stage_key) byKey.set(s.stage_key, s);
    });
    return DEFAULT_STAGE_ORDER.map((meta) => {
      const row = byKey.get(meta.key) || {};
      return {
        ...meta,
        ...row,
        // canonical key wins so a malformed RPC row can't break the layout
        stage_key: meta.key,
        // RPC may omit function_name for rows where there's no underlying job
        function_name: row.function_name || meta.function_name || null,
      };
    });
  }, [pipelineState]);

  // Cold render still shows the full 11-stage strip in 'future' state so the
  // layout doesn't pop in once data arrives.

  return (
    <TooltipProvider delayDuration={150}>
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-1 gap-y-2',
          compact ? 'text-xs' : 'text-sm',
        )}
        role="list"
        aria-label="Drone pipeline stages"
      >
        {stages.map((stage, idx) => {
          const styles = statusStyles(stage.status || 'future');
          const isLast = idx === stages.length - 1;
          const displayName = stage.function_name || stage.label;
          // W14 S1: stage-specific icon override (e.g. Map for
          // boundary_review). Falls back to the status-derived glyph.
          const OverrideIcon = STAGE_ICON_OVERRIDE[stage.key];
          const renderedIcon = OverrideIcon
            ? <OverrideIcon className="h-3 w-3" aria-hidden="true" />
            : styles.icon;

          // Sub-text: duration if complete, ETA if running, blank otherwise.
          // RPC: completed_at + started_at gives duration; eta_seconds_remaining
          // is the ETA in seconds.
          let subText = '';
          if (stage.status === 'completed' && stage.started_at && stage.completed_at) {
            const durMs = new Date(stage.completed_at).getTime() - new Date(stage.started_at).getTime();
            if (durMs > 0) subText = fmtClock(durMs);
          } else if (stage.status === 'running' && Number.isFinite(stage.eta_seconds_remaining) && stage.eta_seconds_remaining > 0) {
            subText = `ETA ${fmtClock(stage.eta_seconds_remaining * 1000)}`;
          } else if (stage.status === 'failed' || stage.status === 'dead_letter') {
            subText = stage.status === 'dead_letter' ? 'dead-letter' : 'failed';
          } else if (stage.status === 'queued' || stage.status === 'pending') {
            subText = 'queued';
          } else if (stage.status === 'debouncing') {
            subText = 'debouncing';
          } else if (stage.status === 'ready') {
            subText = 'ready';
          }

          // Tooltip body — show what we know about the underlying job.
          const tipLines = [];
          const jobId = stage.active_job_id || stage.job_id;
          if (jobId) tipLines.push(`job_id: ${String(jobId).slice(0, 8)}…`);
          if (stage.scheduled_for) {
            try {
              tipLines.push(`scheduled: ${new Date(stage.scheduled_for).toLocaleTimeString()}`);
            } catch { /* invalid date */ }
          }
          if (Number.isFinite(stage.attempt_count) && stage.attempt_count > 0) {
            tipLines.push(`attempt: ${stage.attempt_count}`);
          }
          if (stage.error_message) {
            const truncated = String(stage.error_message).slice(0, 120);
            tipLines.push(`error: ${truncated}`);
          }

          const pill = (
            <div
              role="listitem"
              aria-label={`${displayName}: ${styles.srLabel}`}
              className="flex flex-col items-center min-w-[60px]"
            >
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium whitespace-nowrap',
                  styles.pill,
                  compact && 'px-2 py-0.5 text-[11px]',
                )}
              >
                {renderedIcon}
                {!compact && <span>{stage.label}</span>}
                {compact && <span className="sr-only">{stage.label}</span>}
              </span>
              {!compact && (
                <span
                  className="mt-0.5 text-[11px] leading-none text-muted-foreground"
                  style={{ minHeight: '12px' }}
                >
                  {subText}
                </span>
              )}
            </div>
          );

          return (
            <div key={stage.key} className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger asChild>{pill}</TooltipTrigger>
                <TooltipContent side="bottom" className="text-xs max-w-xs">
                  <div className="font-mono font-semibold">{displayName}</div>
                  {tipLines.map((line, i) => (
                    <div key={i} className="text-muted-foreground">{line}</div>
                  ))}
                </TooltipContent>
              </Tooltip>
              {!isLast && (
                <ChevronRight
                  className="h-3 w-3 shrink-0 text-muted-foreground/40"
                  aria-hidden="true"
                />
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

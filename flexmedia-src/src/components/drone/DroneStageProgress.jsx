/**
 * DroneStageProgress — Wave 9 S2
 * ─────────────────────────────────
 * Visual stage stepper with up to 11 stages (architect Section A.1).
 *
 * Modes:
 *   compact={false} (default): horizontal chevron pills with stage names + duration/ETA below
 *   compact={true}: single-line pill row, hover tooltips with details
 *
 * Per stage:
 *   done                   → emerald-filled with check
 *   running                → blue-filled with spinner
 *   blocked-on-operator    → slate with lock icon
 *   future                 → muted hollow circle
 *   failed                 → red-filled with alert
 *
 * Below each pill: 11px gray text "X:XX" duration if complete, "ETA X:XX" if running.
 * Wraps to 2 rows below 768px.
 * Tooltip on hover: job_id, scheduled_for, attempt_count.
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
} from 'lucide-react';
import { cn } from '@/lib/utils';

// Canonical stage order — matches architect Section A.1 (11 stages).
// Each shoot rolls through these; if a stage isn't applicable to a given
// shoot it appears as 'future' and is grey.
const DEFAULT_STAGE_ORDER = [
  { key: 'drone-ingest',          label: 'Ingest' },
  { key: 'drone-shot-paths',      label: 'Shot paths' },
  { key: 'drone-sfm',             label: 'SfM' },
  { key: 'drone-pois',            label: 'POIs' },
  { key: 'drone-cadastral',       label: 'Cadastral' },
  { key: 'drone-boundary',        label: 'Boundary' },
  { key: 'drone-shortlist',       label: 'Shortlist' },
  { key: 'drone-render',          label: 'Render' },
  { key: 'drone-render-edited',   label: 'Edited' },
  { key: 'drone-render-approve',  label: 'Approve' },
  { key: 'drone-deliver',         label: 'Deliver' },
];

// ── helpers ────────────────────────────────────────────────────────────────
function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function statusStyles(status) {
  switch (status) {
    case 'done':
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
    case 'pending':
      // Treat pending (queued) as a soft blue — same family as running but
      // not yet picked up by dispatcher.
      return {
        pill: 'bg-blue-100 text-blue-800 border-blue-300',
        icon: <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />,
        srLabel: 'pending',
      };
    case 'blocked-on-operator':
      return {
        pill: 'bg-slate-500 text-white border-slate-500',
        icon: <Lock className="h-3 w-3" aria-hidden="true" />,
        srLabel: 'waiting on operator',
      };
    case 'failed':
      return {
        pill: 'bg-red-500 text-white border-red-500',
        icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
        srLabel: 'failed',
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
  // as 'future'.
  const stages = useMemo(() => {
    const byKey = new Map();
    (pipelineState?.stages || []).forEach((s) => {
      if (s && s.stage_key) byKey.set(s.stage_key, s);
    });
    return DEFAULT_STAGE_ORDER.map((meta) => {
      const row = byKey.get(meta.key) || {};
      return { ...meta, ...row, stage_key: meta.key };
    });
  }, [pipelineState]);

  // Cold render still shows the full strip in 'future' state so the layout
  // doesn't pop in once data arrives — return strip whether or not state exists.

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

          // Sub-text: duration if complete, ETA if running, blank otherwise.
          let subText = '';
          if (stage.status === 'done' && Number.isFinite(stage.duration_ms)) {
            subText = fmtMs(stage.duration_ms);
          } else if (stage.status === 'running' && Number.isFinite(stage.eta_ms) && stage.eta_ms > 0) {
            subText = `ETA ${fmtMs(stage.eta_ms)}`;
          } else if (stage.status === 'failed') {
            subText = 'failed';
          } else if (stage.status === 'pending') {
            subText = 'queued';
          }

          // Tooltip body — show what we know about the underlying job.
          const tipLines = [];
          if (stage.job_id) tipLines.push(`job_id: ${String(stage.job_id).slice(0, 8)}…`);
          if (stage.scheduled_for) {
            try {
              tipLines.push(`scheduled: ${new Date(stage.scheduled_for).toLocaleTimeString()}`);
            } catch { /* invalid date */ }
          }
          if (Number.isFinite(stage.attempt_count)) {
            tipLines.push(`attempt: ${stage.attempt_count}`);
          }
          if (stage.error_message) {
            const truncated = String(stage.error_message).slice(0, 120);
            tipLines.push(`error: ${truncated}`);
          }

          const pill = (
            <div
              role="listitem"
              aria-label={`${stage.label}: ${styles.srLabel}`}
              className="flex flex-col items-center min-w-[60px]"
            >
              <span
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-medium whitespace-nowrap',
                  styles.pill,
                  compact && 'px-2 py-0.5 text-[11px]',
                )}
              >
                {styles.icon}
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
              {tipLines.length > 0 ? (
                <Tooltip>
                  <TooltipTrigger asChild>{pill}</TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    <div className="font-semibold">{stage.label}</div>
                    {tipLines.map((line, i) => (
                      <div key={i} className="text-muted-foreground">{line}</div>
                    ))}
                  </TooltipContent>
                </Tooltip>
              ) : (
                pill
              )}
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

/**
 * DronePipelineBanner — Wave 9 S2
 * ─────────────────────────────────
 * Top-of-shoot status banner. Mounted at top of ShootDetail in
 * ProjectDronesTab.jsx (S3 owns mounting).
 *
 * Four states (architect Section C):
 *   1. Active     — current stage running/pending: blue border, ~48px tall card,
 *                   countdown elapsed/ETA, [Force fire now] + [Re-run this stage ▾]
 *   2. Failed     — any stage failed / shoot.status='sfm_failed' / active job in
 *                   dead_letter: red border, error message, [Re-run] + [Open
 *                   Dead Letter Inspector]
 *   3. System down— system.dispatcher_health !== 'ok': amber border, "Dispatcher
 *                   hasn't ticked in 4 min". admin+ sees [Trigger dispatcher manually]
 *   4. Idle       — operator_actions_unlocked=true, no active jobs: returns null
 *
 * Implementation details:
 *   - Uses shadcn Card / Button / Tooltip / DropdownMenu / AlertDialog.
 *   - Force-fire: simple click (no confirmation — low stakes per architect Section D).
 *   - Re-run-stage: opens AlertDialog (typical Modal cost ~$0.01 disclosure).
 *   - Cancel cascade (admin+): two-step (type project name to confirm).
 *
 * Data contract: consumes the full hook from useDronePipelineState — does NOT
 * call api directly so it's trivially mockable for tests via hookOverride.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import {
  Loader2,
  AlertTriangle,
  AlertOctagon,
  Zap,
  RotateCcw,
  ChevronDown,
  ExternalLink,
  Clock,
} from 'lucide-react';
import { useDronePipelineState } from '@/hooks/useDronePipelineState';
import { useAuth } from '@/lib/AuthContext';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';

// ── Stage metadata: human label + Modal cost note (architect Section D) ────
const STAGE_META = {
  'drone-ingest':         { label: 'drone-ingest',         note: 'Dropbox → storage transfer' },
  'drone-shot-paths':     { label: 'drone-shot-paths',     note: 'Reconcile shot paths from Dropbox' },
  'drone-sfm':            { label: 'drone-sfm',            note: 'Modal pycolmap, ~3-5 min typical' },
  'drone-pois':           { label: 'drone-pois',           note: 'OSM POIs lookup' },
  'drone-cadastral':      { label: 'drone-cadastral',      note: 'NSW cadastral boundary fetch' },
  'drone-boundary':       { label: 'drone-boundary',       note: 'Operator-approved boundary' },
  'drone-shortlist':      { label: 'drone-shortlist',      note: 'AI shortlister' },
  'drone-render':         { label: 'drone-render',         note: 'Modal render, ~1-2 min/shot' },
  'drone-render-edited':  { label: 'drone-render-edited',  note: 'Photographer-edited renders' },
  'drone-render-approve': { label: 'drone-render-approve', note: 'Final approval' },
  'drone-deliver':        { label: 'drone-deliver',        note: 'Push to delivery folder' },
};

function stageMeta(key) {
  return STAGE_META[key] || { label: key || 'unknown', note: '' };
}

// ── Format helpers ─────────────────────────────────────────────────────────
function fmtClock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * formatCountdown — architect Section D color-coding.
 * Returns { text, tone } where tone ∈ 'blue'|'gray'|'amber'|'red'.
 */
function formatCountdown(stageRow, now = Date.now()) {
  if (!stageRow) return { text: '', tone: 'gray' };
  const status = stageRow.status;
  if (status === 'failed') return { text: 'failed', tone: 'red' };
  if (status === 'pending') {
    const queued = stageRow.scheduled_for ? new Date(stageRow.scheduled_for).getTime() : null;
    if (queued && queued > now) {
      return { text: `fires in ${fmtClock(queued - now)}`, tone: 'gray' };
    }
    return { text: 'queued — waiting on dispatcher', tone: 'gray' };
  }
  if (status === 'running') {
    const started = stageRow.started_at ? new Date(stageRow.started_at).getTime() : null;
    const elapsedMs = started ? now - started : 0;
    const etaMs = Number.isFinite(stageRow.eta_ms) ? stageRow.eta_ms : null;
    let text = `${fmtClock(Math.max(0, elapsedMs))} elapsed`;
    if (etaMs && etaMs > 0) {
      text += ` · ETA ${fmtClock(etaMs)}`;
    }
    // Slow → amber if elapsed exceeds ETA by >50% (or >10 min absolute when no ETA)
    const slow = (etaMs && elapsedMs > etaMs * 1.5) || (!etaMs && elapsedMs > 10 * 60_000);
    return { text, tone: slow ? 'amber' : 'blue' };
  }
  return { text: '', tone: 'gray' };
}

const TONE_BORDER = {
  blue: 'border-blue-500',
  gray: 'border-slate-300',
  amber: 'border-amber-500',
  red: 'border-red-500',
};

// ── Permissions helper ─────────────────────────────────────────────────────
function isManagerPlus(role) {
  return role === 'manager' || role === 'admin' || role === 'master_admin';
}
function isAdminPlus(role) {
  return role === 'admin' || role === 'master_admin';
}

// ── Re-run dialog ──────────────────────────────────────────────────────────
function RerunStageDialog({ open, onOpenChange, stageKey, onConfirm }) {
  const meta = stageMeta(stageKey);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Re-run {meta.label} for this shoot?</AlertDialogTitle>
          <AlertDialogDescription>
            Will enqueue a fresh {meta.label} job
            {stageKey === 'drone-sfm' || stageKey === 'drone-render'
              ? ' (typical Modal cost ~$0.01)'
              : ''}.
            {meta.note && <span className="block mt-1 text-muted-foreground">{meta.note}</span>}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              onConfirm(stageKey);
              onOpenChange(false);
            }}
          >
            Re-run
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Cancel-cascade dialog (admin+, two-step typed confirmation) ────────────
function CancelCascadeDialog({ open, onOpenChange, projectName, onConfirm }) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);
  const matches = typed.trim() === (projectName || '').trim() && typed.trim().length > 0;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cancel cascade for this project?</AlertDialogTitle>
          <AlertDialogDescription>
            This stops all queued and in-flight drone jobs for this project. In-flight
            Modal compute will continue to bill until it finishes naturally.
            <span className="block mt-2">
              Type <code className="font-mono bg-muted px-1 rounded">{projectName || 'project name'}</code> to confirm:
            </span>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder={projectName || 'project name'}
          className="my-2"
        />
        <AlertDialogFooter>
          <AlertDialogCancel>Keep running</AlertDialogCancel>
          <AlertDialogAction
            disabled={!matches}
            onClick={() => {
              if (!matches) return;
              onConfirm();
              onOpenChange(false);
            }}
            className={cn(!matches && 'opacity-50 cursor-not-allowed')}
          >
            Cancel cascade
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * @param {object} props
 * @param {string} props.projectId
 * @param {string} [props.shootId]
 * @param {string} [props.projectName]   — required for cancel-cascade typed confirm
 * @param {object} [props.pipelineState] — TEST-ONLY: pre-supplied state to bypass the hook
 * @param {object} [props.hookOverride]  — TEST-ONLY: alternate hook bag (forceFireNow, rerunStage, etc.)
 */
export default function DronePipelineBanner({
  projectId,
  shootId,
  projectName,
  pipelineState: pipelineStateProp,
  hookOverride,
}) {
  const { user } = useAuth();
  const role = user?.role || 'photographer';

  // Real hook always called (rules-of-hooks). When pipelineStateProp is
  // provided (tests/storybook), we override the bag below.
  const liveHook = useDronePipelineState(projectId, shootId);
  const hook = hookOverride || liveHook;
  const pipelineState = pipelineStateProp ?? hook.pipelineState;
  const tick = hook.tick ?? 0;
  const { forceFireNow, rerunStage, isFiring, isRerunning } = hook;

  const [rerunDialogStage, setRerunDialogStage] = useState(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  // ── Derive UI state ──────────────────────────────────────────────────────
  // tick is read here so the "elapsed" string updates each second without
  // server round-trips. eslint sees it as unused — that's fine, it's the
  // re-render trigger.
  void tick;

  const derived = useMemo(() => {
    if (!pipelineState) return null;
    const stages = pipelineState.stages || [];
    const currentStageKey = pipelineState.current_stage;
    const currentStage = stages.find((s) => s?.stage_key === currentStageKey);

    const failedStage = stages.find((s) => s?.status === 'failed');
    const sfmFailed = pipelineState.shoot_status === 'sfm_failed';
    const activeJobInDeadLetter =
      pipelineState.active_job?.status === 'dead_letter' ||
      (Number.isFinite(pipelineState.dead_letter_count) && pipelineState.dead_letter_count > 0);

    const dispatcherHealth = pipelineState.system?.dispatcher_health || 'ok';

    const isFailed = Boolean(failedStage || sfmFailed || activeJobInDeadLetter);
    const isSystemDown = dispatcherHealth !== 'ok';
    const isActive =
      currentStage?.status === 'running' || currentStage?.status === 'pending';
    const isIdle =
      Boolean(pipelineState.operator_actions_unlocked) && !isActive && !isFailed && !isSystemDown;

    return {
      currentStage,
      currentStageKey,
      failedStage,
      activeJobInDeadLetter,
      dispatcherHealth,
      lastTickAt: pipelineState.system?.last_tick_at || null,
      isFailed,
      isSystemDown,
      isActive,
      isIdle,
      activeJob: pipelineState.active_job || null,
      stages,
    };
  }, [pipelineState]);

  // ── Manual dispatcher trigger (system down, admin+) ────────────────────
  const triggerDispatcherManually = async () => {
    try {
      const result = await api.functions.invoke('drone-job-dispatcher', {});
      if (result?.data?.error) throw new Error(result.data.error);
      toast.success('Dispatcher triggered');
      hook.refetch?.();
    } catch (e) {
      toast.error(e?.message || 'Dispatcher trigger failed');
    }
  };

  if (!pipelineState) return null;
  if (!derived) return null;
  if (derived.isIdle) return null;

  // ── Render ───────────────────────────────────────────────────────────────
  // Precedence: failed > system_down > active.
  // (Architect doesn't strictly say but failure is the most actionable.)
  if (derived.isFailed) {
    return (
      <FailedBanner
        derived={derived}
        role={role}
        rerunDialogStage={rerunDialogStage}
        setRerunDialogStage={setRerunDialogStage}
        rerunStage={rerunStage}
        isRerunning={isRerunning}
      />
    );
  }
  if (derived.isSystemDown) {
    return (
      <SystemDownBanner
        derived={derived}
        role={role}
        triggerDispatcherManually={triggerDispatcherManually}
      />
    );
  }
  if (derived.isActive) {
    return (
      <ActiveBanner
        derived={derived}
        role={role}
        projectName={projectName}
        forceFireNow={forceFireNow}
        rerunStage={rerunStage}
        isFiring={isFiring}
        isRerunning={isRerunning}
        rerunDialogStage={rerunDialogStage}
        setRerunDialogStage={setRerunDialogStage}
        cancelDialogOpen={cancelDialogOpen}
        setCancelDialogOpen={setCancelDialogOpen}
      />
    );
  }
  // Fallback — shouldn't hit since isIdle short-circuited above, but be safe.
  return null;
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function ActiveBanner({
  derived,
  role,
  projectName,
  forceFireNow,
  rerunStage,
  isFiring,
  isRerunning,
  rerunDialogStage,
  setRerunDialogStage,
  cancelDialogOpen,
  setCancelDialogOpen,
}) {
  const stage = derived.currentStage;
  const meta = stageMeta(derived.currentStageKey);
  const countdown = formatCountdown(stage);
  const canManage = isManagerPlus(role);
  const canCancel = isAdminPlus(role);
  const activeJobId = derived.activeJob?.id;

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="status"
        aria-live="polite"
        aria-label={`Pipeline active: ${meta.label}`}
        className={cn(
          'border-l-4 p-3 flex items-center gap-3 min-h-[48px]',
          TONE_BORDER[countdown.tone] || TONE_BORDER.blue,
        )}
      >
        {/* Left: spinner + stage label */}
        <div className="flex items-center gap-2 shrink-0">
          <Loader2 className="h-4 w-4 animate-spin text-blue-500" aria-hidden="true" />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="font-medium text-sm">
                Running <span className="font-mono">{meta.label}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-xs">
              <div className="font-mono font-semibold">{meta.label}</div>
              {meta.note && <div className="text-muted-foreground">{meta.note}</div>}
              {Number.isFinite(stage?.attempt_count) && (
                <div className="text-muted-foreground">attempt: {stage.attempt_count}</div>
              )}
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Center: countdown */}
        <div className="flex-1 flex items-center justify-center text-sm gap-2">
          <Clock
            className={cn(
              'h-3.5 w-3.5',
              countdown.tone === 'amber' && 'text-amber-500',
              countdown.tone === 'blue' && 'text-blue-500',
              countdown.tone === 'gray' && 'text-muted-foreground',
            )}
            aria-hidden="true"
          />
          <span
            className={cn(
              'font-mono tabular-nums',
              countdown.tone === 'amber' && 'text-amber-700',
              countdown.tone === 'blue' && 'text-blue-700',
              countdown.tone === 'gray' && 'text-muted-foreground',
            )}
          >
            {countdown.text}
          </span>
        </div>

        {/* Right: actions (manager+) */}
        <div className="flex items-center gap-2 shrink-0">
          {canManage && activeJobId && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isFiring}
                  onClick={() => forceFireNow(activeJobId)}
                  aria-label="Force fire job now"
                >
                  <Zap className="h-3.5 w-3.5 mr-1.5" />
                  Force fire now
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-xs">
                Skip the queue and fire this job immediately
              </TooltipContent>
            </Tooltip>
          )}

          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" disabled={isRerunning}>
                  <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                  Re-run this stage
                  <ChevronDown className="h-3 w-3 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Re-run a stage</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {derived.stages
                  .filter((s) => s?.stage_key && s.status !== 'future')
                  .map((s) => (
                    <DropdownMenuItem
                      key={s.stage_key}
                      onClick={() => setRerunDialogStage(s.stage_key)}
                      className="font-mono text-xs"
                    >
                      {s.stage_key}
                    </DropdownMenuItem>
                  ))}
                {canCancel && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={() => setCancelDialogOpen(true)}
                      className="text-red-600 focus:text-red-600"
                    >
                      Cancel cascade…
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </Card>

      <RerunStageDialog
        open={Boolean(rerunDialogStage)}
        onOpenChange={(open) => { if (!open) setRerunDialogStage(null); }}
        stageKey={rerunDialogStage}
        onConfirm={(s) => rerunStage(s)}
      />

      {canCancel && (
        <CancelCascadeDialog
          open={cancelDialogOpen}
          onOpenChange={setCancelDialogOpen}
          projectName={projectName}
          onConfirm={async () => {
            try {
              const result = await api.functions.invoke('drone-cascade-cancel', {
                project_id: derived.activeJob?.project_id || undefined,
              });
              if (result?.data?.error) throw new Error(result.data.error);
              toast.success('Cascade cancelled');
            } catch (e) {
              toast.error(e?.message || 'Cancel cascade failed');
            }
          }}
        />
      )}
    </TooltipProvider>
  );
}

function FailedBanner({
  derived,
  role,
  rerunDialogStage,
  setRerunDialogStage,
  rerunStage,
  isRerunning,
}) {
  const stage = derived.failedStage;
  const meta = stageMeta(stage?.stage_key);
  const errorMessage =
    stage?.error_message ||
    derived.activeJob?.error_message ||
    'Pipeline failed (see Dead Letter Inspector for details)';
  const canManage = isManagerPlus(role);

  return (
    <>
      <Card
        role="alert"
        aria-live="assertive"
        className={cn(
          'border-l-4 p-3 flex flex-col sm:flex-row sm:items-center gap-3',
          TONE_BORDER.red,
        )}
      >
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <AlertOctagon className="h-5 w-5 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <div className="font-medium text-sm text-red-800">
              <span className="font-mono">{meta.label}</span> failed
            </div>
            <div className="text-xs text-red-700 truncate" title={errorMessage}>
              {errorMessage}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && stage?.stage_key && (
            <Button
              size="sm"
              variant="outline"
              disabled={isRerunning}
              onClick={() => setRerunDialogStage(stage.stage_key)}
            >
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
              Re-run
            </Button>
          )}
          <Button asChild size="sm" variant="outline">
            <Link to={createPageUrl('DroneCommandCenter')}>
              <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
              Open Dead Letter Inspector
            </Link>
          </Button>
        </div>
      </Card>

      <RerunStageDialog
        open={Boolean(rerunDialogStage)}
        onOpenChange={(open) => { if (!open) setRerunDialogStage(null); }}
        stageKey={rerunDialogStage}
        onConfirm={(s) => rerunStage(s)}
      />
    </>
  );
}

function SystemDownBanner({ derived, role, triggerDispatcherManually }) {
  const lastTick = derived.lastTickAt
    ? (() => { try { return new Date(derived.lastTickAt).toLocaleTimeString(); } catch { return null; } })()
    : null;
  const canTrigger = isAdminPlus(role);

  return (
    <Card
      role="alert"
      aria-live="polite"
      className={cn(
        'border-l-4 p-3 flex flex-col sm:flex-row sm:items-center gap-3',
        TONE_BORDER.amber,
      )}
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-amber-900">
            Dispatcher hasn't ticked in 4 min — automated steps may be paused.
          </div>
          <div className="text-xs text-amber-700">
            Retry in 1 min or contact admin.
            {lastTick && <span className="ml-1">Last tick: {lastTick}</span>}
          </div>
        </div>
      </div>
      {canTrigger && (
        <Button size="sm" variant="outline" onClick={triggerDispatcherManually}>
          <Zap className="h-3.5 w-3.5 mr-1.5" />
          Trigger dispatcher manually
        </Button>
      )}
    </Card>
  );
}

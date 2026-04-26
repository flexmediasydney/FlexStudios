/**
 * DronePipelineBanner — Wave 9 S2
 * ─────────────────────────────────
 * Top-of-shoot status banner. Mounted at top of ShootDetail in
 * ProjectDronesTab.jsx (S3 owns mounting).
 *
 * Five states (architect Section C + W14 S1 boundary_review_pending):
 *   1. Active     — current stage running/queued/debouncing/pending AND a job
 *                   actually has status='running' in active_jobs: blue (or
 *                   amber if slow) border, ~48px tall card, countdown
 *                   elapsed/ETA, [Force fire now] + [Re-run this stage ▾]
 *   2. Failed     — any stage failed/dead_letter / shoot.status='sfm_failed' /
 *                   active job in dead_letter: red border, error message,
 *                   [Re-run] + [Open Dead Letter Inspector]
 *   3. System down— system.dispatcher_health !== 'ok' (i.e. 'stale' or 'down'):
 *                   amber border, "Dispatcher hasn't ticked in 4 min". admin+
 *                   sees [Trigger dispatcher manually]
 *   4. Boundary   — stages[boundary_review].status === 'ready' (W14 S1):
 *                   slate border, "Cadastral detected — open Boundary Editor
 *                   to confirm and save the property polygon" + Boundary
 *                   Editor link.
 *   5. Idle       — operator_actions_unlocked=true, no active jobs: returns null
 *
 * W14 S1 fix: previously `isActive` triggered on currentStage.status alone
 * (running/queued/debouncing/pending), and the "Currently running drone-render
 * · 274:38 elapsed" line in ActiveBanner read currentStage.started_at without
 * confirming the underlying job was actually still in flight. After all
 * auto-stages completed but the operator hadn't acted yet, current_stage
 * walked back to a completed stage and the banner happily painted a fictional
 * 274-minute counter. isActive now ALSO requires a running entry in
 * active_jobs, and ActiveBanner only computes elapsed when finished_at is
 * null. Together: completed → no banner; truly running → real numbers.
 *
 * Implementation details:
 *   - Uses shadcn Card / Button / Tooltip / DropdownMenu / AlertDialog.
 *   - Force-fire: simple click (no confirmation — low stakes per architect Section D).
 *   - Re-run-stage: opens AlertDialog (typical Modal cost ~$0.01 disclosure).
 *   - Cancel cascade (admin+): two-step (type project name to confirm).
 *
 * Data contract: consumes the full hook from useDronePipelineState — does NOT
 * call api directly so it's trivially mockable for tests via hookOverride.
 *
 * RPC contract source of truth: supabase/migrations/301_drone_pipeline_state_rpc.sql
 *   stage_key values: ingest | sfm | poi | cadastral | raw_render |
 *                     operator_triage | editor_handoff | edited_render |
 *                     edited_curate | final | delivered
 *   stage status:     completed | running | queued | debouncing | pending |
 *                     failed | dead_letter | ready
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
  Map as MapIcon,
} from 'lucide-react';
import { useDronePipelineState } from '@/hooks/useDronePipelineState';
import { useAuth } from '@/lib/AuthContext';
import { api } from '@/api/supabaseClient';
import { toast } from 'sonner';
import { createPageUrl } from '@/utils';
import { cn } from '@/lib/utils';

// ── Stage metadata: human label + Modal cost note (architect Section D) ────
// stage_key values come from migration 329 (W14 S1 12-stage extension).
// We display the function_name (from the stage row) when present, else label.
const STAGE_META = {
  ingest:          { label: 'Ingest',          function_name: 'drone-ingest',        note: 'Dropbox → storage transfer (~30s typical)' },
  sfm:             { label: 'SfM',             function_name: 'drone-sfm',           note: 'Modal pycolmap, ~3-5 min typical' },
  poi:             { label: 'POIs',            function_name: 'drone-pois',          note: 'OSM POIs lookup (~30s)' },
  cadastral:       { label: 'Cadastral',       function_name: 'drone-cadastral',     note: 'NSW cadastral boundary fetch (~15s)' },
  raw_render:      { label: 'Raw render',      function_name: 'drone-raw-preview',   note: 'Modal raw preview render, ~2 min typical' },
  boundary_review: { label: 'Boundary',        function_name: null,                  note: 'Operator reviews + saves the cadastral polygon' },
  operator_triage: { label: 'Operator triage', function_name: null,                  note: 'Waiting on operator shortlist approval' },
  editor_handoff:  { label: 'Editor handoff',  function_name: null,                  note: 'Awaiting photographer-side edit' },
  edited_render:   { label: 'Edited render',   function_name: 'drone-render-edited', note: 'Photographer-edited renders (~90s)' },
  edited_curate:   { label: 'Edited curate',   function_name: null,                  note: 'Operator curates final shortlist' },
  final:           { label: 'Final render',    function_name: 'drone-render',        note: 'Modal final render, ~1-2 min/shot' },
  delivered:       { label: 'Delivered',       function_name: null,                  note: 'Pushed to delivery folder' },
};

// Stages drone-stage-rerun edge fn accepts (per Stream 1 contract:
// supabase/functions/drone-stage-rerun/index.ts:33).
const RERUN_ELIGIBLE_STAGES = new Set([
  'ingest', 'sfm', 'poi', 'cadastral', 'raw_render', 'edited_render',
]);

// Stages that incur a Modal compute cost — disclosure shown in re-run dialog.
const COSTED_STAGES = new Set(['sfm', 'raw_render', 'edited_render']);

function stageMeta(stageRowOrKey) {
  // Accept either the full stage row (preferred — uses function_name from RPC)
  // or just the stage_key string.
  if (stageRowOrKey && typeof stageRowOrKey === 'object') {
    const key = stageRowOrKey.stage_key;
    const fnName = stageRowOrKey.function_name || STAGE_META[key]?.function_name || null;
    const meta = STAGE_META[key] || { label: key || 'unknown', note: '' };
    return { ...meta, function_name: fnName, displayName: fnName || meta.label };
  }
  const key = stageRowOrKey;
  const meta = STAGE_META[key] || { label: key || 'unknown', function_name: null, note: '' };
  return { ...meta, displayName: meta.function_name || meta.label };
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
  if (status === 'failed' || status === 'dead_letter') return { text: 'failed', tone: 'red' };
  if (status === 'debouncing') {
    const fireAt = stageRow.scheduled_for || stageRow.debounced_until;
    const fireMs = fireAt ? new Date(fireAt).getTime() : null;
    if (fireMs && fireMs > now) {
      return { text: `fires in ${fmtClock(fireMs - now)}`, tone: 'gray' };
    }
    return { text: 'debouncing', tone: 'gray' };
  }
  if (status === 'queued' || status === 'pending') {
    return { text: 'queued — waiting on dispatcher', tone: 'gray' };
  }
  if (status === 'running') {
    // W14 S1 guard: if the stage row has a completed_at it isn't actually
    // running anymore — the RPC may briefly hold a 'running' status while
    // the dispatcher catches up, but elapsed should never accumulate
    // against a finished job. Belt-and-braces against the false-positive
    // counter (the parent isActive check is the primary defence).
    if (stageRow.completed_at) return { text: '', tone: 'gray' };
    const started = stageRow.started_at ? new Date(stageRow.started_at).getTime() : null;
    const elapsedMs = started ? Math.max(0, now - started) : 0;
    // RPC returns ETA in seconds — convert to ms for fmtClock.
    const etaSec = Number.isFinite(stageRow.eta_seconds_remaining)
      ? stageRow.eta_seconds_remaining
      : null;
    const etaMs = etaSec !== null ? etaSec * 1000 : null;
    let text = `${fmtClock(elapsedMs)} elapsed`;
    if (etaMs !== null && etaMs > 0) {
      text += ` · ETA ${fmtClock(etaMs)}`;
    }
    // Slow → amber if ETA already 0 and we're still running >1min, or no ETA
    // and elapsed > 10 min.
    const slow =
      (etaMs !== null && etaMs <= 0 && elapsedMs > 60_000) ||
      (etaMs === null && elapsedMs > 10 * 60_000);
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
          <AlertDialogTitle>Re-run {meta.displayName} for this shoot?</AlertDialogTitle>
          <AlertDialogDescription>
            Will enqueue a fresh {meta.displayName} job
            {COSTED_STAGES.has(stageKey) ? ' (typical Modal cost ~$0.01)' : ''}.
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

  // tick is read here so the "elapsed" string updates each second without
  // server round-trips. eslint sees it as unused — that's fine, it's the
  // re-render trigger.
  void tick;

  const derived = useMemo(() => {
    if (!pipelineState) return null;
    const stages = pipelineState.stages || [];
    const currentStageKey = pipelineState.current_stage;
    const currentStage = stages.find((s) => s?.stage_key === currentStageKey);

    const failedStage = stages.find(
      (s) => s?.status === 'failed' || s?.status === 'dead_letter',
    );
    const sfmFailed = pipelineState.shoot_status === 'sfm_failed';

    const activeJobs = pipelineState.active_jobs || [];
    // W14 S1: a job counts as truly running only if status='running' AND
    // finished_at is null. The RPC sometimes leaves a succeeded job in the
    // 24h window of active_jobs — using just status='running' is enough,
    // but the finished_at guard makes the intent explicit and survives any
    // RPC-side window changes.
    const runningJob = activeJobs.find(
      (j) => j?.status === 'running' && !j?.finished_at,
    );
    // Pick the running job first, else the first pending — for force-fire CTA.
    const activeJob =
      runningJob ||
      activeJobs.find((j) => j?.status === 'pending') ||
      null;
    const activeJobInDeadLetter = activeJobs.some((j) => j?.status === 'dead_letter');

    const dispatcherHealth = pipelineState.system?.dispatcher_health || 'ok';
    // RPC values: 'ok' | 'stale' | 'down' — only 'ok' is healthy.
    const isFailed = Boolean(failedStage || sfmFailed || activeJobInDeadLetter);
    const isSystemDown = dispatcherHealth !== 'ok';
    // W14 S1: tighten isActive — currentStage.status alone wasn't enough
    // because current_stage walks back to the most recent completed stage
    // when nothing's queued, and the old check matched 'pending' (which
    // some manual stages report). Require BOTH a current-stage status that
    // could plausibly be running AND an actual running job.
    const stageStatusActive =
      currentStage?.status === 'running' ||
      currentStage?.status === 'queued' ||
      currentStage?.status === 'debouncing';
    const isActive = stageStatusActive && Boolean(runningJob);

    // W14 S1: surface boundary_review when the operator can act on it. The
    // server flips it to 'ready' as soon as cadastral completes and there's
    // no drone_property_boundary row yet (mig 329).
    const boundaryReviewStage = stages.find((s) => s?.stage_key === 'boundary_review');
    const isBoundaryReviewPending = boundaryReviewStage?.status === 'ready';

    const isIdle =
      Boolean(pipelineState.operator_actions_unlocked) &&
      !isActive &&
      !isFailed &&
      !isSystemDown &&
      !isBoundaryReviewPending;

    return {
      currentStage,
      currentStageKey,
      failedStage,
      activeJobInDeadLetter,
      dispatcherHealth,
      lastTickAt:
        pipelineState.system?.dispatcher_last_tick_at ||
        pipelineState.system?.last_tick_at ||
        null,
      secsSinceTick: pipelineState.system?.dispatcher_secs_since_tick ?? null,
      isFailed,
      isSystemDown,
      isActive,
      isBoundaryReviewPending,
      boundaryReviewStage,
      isIdle,
      activeJob,
      runningJob,
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
  // Precedence: failed > system_down > active > boundary_review_pending.
  // Failure is most actionable; system_down blocks every automated step;
  // active is real motion. boundary_review_pending lives below those because
  // it's a steady-state operator-action prompt — the others are transient
  // events the operator can't directly act on.
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
  if (derived.isBoundaryReviewPending) {
    return (
      <BoundaryReviewBanner projectId={projectId} shootId={shootId} />
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
  const meta = stageMeta(stage || derived.currentStageKey);
  const countdown = formatCountdown(stage);
  const canManage = isManagerPlus(role);
  const canCancel = isAdminPlus(role);
  // RPC active_jobs row uses `job_id` (not `id`); stage row uses `active_job_id`.
  const activeJobId = derived.activeJob?.job_id || stage?.active_job_id || null;

  return (
    <TooltipProvider delayDuration={150}>
      <Card
        role="status"
        aria-live="polite"
        aria-label={`Pipeline active: ${meta.displayName}`}
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
                Running <span className="font-mono">{meta.displayName}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs max-w-xs">
              <div className="font-mono font-semibold">{meta.displayName}</div>
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
                  // Only show stages drone-stage-rerun accepts (per Stream 1 contract).
                  .filter((s) => RERUN_ELIGIBLE_STAGES.has(s?.stage_key))
                  .map((s) => {
                    const m = stageMeta(s);
                    return (
                      <DropdownMenuItem
                        key={s.stage_key}
                        onClick={() => setRerunDialogStage(s.stage_key)}
                        className="font-mono text-xs"
                      >
                        {m.displayName}
                      </DropdownMenuItem>
                    );
                  })}
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
            // cancel_drone_cascade RPC was added by Stream 1 in migration 301.
            // It accepts (p_cascade_kind, p_project_id, p_shoot_id) and is
            // admin-gated server-side. We pass 'sfm' as the canonical
            // cascade kind for now — the RPC understands ingest/sfm/render etc.
            try {
              const data = await api.rpc('cancel_drone_cascade', {
                p_cascade_kind: 'sfm',
                p_project_id: derived.activeJob?.project_id || undefined,
                p_shoot_id: undefined,
              });
              const cancelled = data?.cancelled_count ?? 0;
              toast.success(`Cascade cancelled (${cancelled} jobs stopped)`);
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
  const meta = stageMeta(stage || stage?.stage_key);
  const errorMessage =
    stage?.error_message ||
    derived.activeJob?.error_message ||
    'Pipeline failed (see Dead Letter Inspector for details)';
  const canManage = isManagerPlus(role);
  const canRerunThisStage = stage?.stage_key && RERUN_ELIGIBLE_STAGES.has(stage.stage_key);

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
              <span className="font-mono">{meta.displayName}</span> failed
            </div>
            <div className="text-xs text-red-700 truncate" title={errorMessage}>
              {errorMessage}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && canRerunThisStage && (
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

// W14 S1: boundary review banner. Shown when stages[boundary_review].status
// === 'ready' (cadastral done, no drone_property_boundary saved yet). The
// renderer needs the boundary as its geographic filter — without it, pin
// overlays come back empty. mig 329 also gates operator_actions_unlocked
// behind boundary existence, so this banner persists until the operator
// opens DroneBoundaryEditor and clicks Save.
function BoundaryReviewBanner({ projectId, shootId }) {
  const canLink = Boolean(projectId && shootId);
  return (
    <Card
      role="status"
      aria-live="polite"
      className={cn(
        'border-l-4 p-3 flex flex-col sm:flex-row sm:items-center gap-3',
        TONE_BORDER.gray,
      )}
    >
      <div className="flex items-start gap-2 flex-1 min-w-0">
        <MapIcon className="h-5 w-5 text-slate-600 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-sm text-slate-900">
            Cadastral detected — open Boundary Editor to confirm and save the property polygon
          </div>
          <div className="text-xs text-slate-700">
            Until a boundary is saved, the renderer has no geographic filter and pin overlays will be empty. This unlocks the rest of the swimlane.
          </div>
        </div>
      </div>
      {canLink && (
        <Button asChild size="sm" variant="default">
          <Link
            to={createPageUrl(
              `DroneBoundaryEditor?project=${projectId}&shoot=${shootId}&pipeline=raw`,
            )}
          >
            <MapIcon className="h-3.5 w-3.5 mr-1.5" />
            Open Boundary Editor
          </Link>
        </Button>
      )}
    </Card>
  );
}

function SystemDownBanner({ derived, role, triggerDispatcherManually }) {
  const lastTick = derived.lastTickAt
    ? (() => { try { return new Date(derived.lastTickAt).toLocaleTimeString(); } catch { return null; } })()
    : null;
  const minsSince =
    Number.isFinite(derived.secsSinceTick) && derived.secsSinceTick > 0
      ? Math.round(derived.secsSinceTick / 60)
      : null;
  const canTrigger = isAdminPlus(role);
  const isStale = derived.dispatcherHealth === 'stale';

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
            {isStale
              ? `Dispatcher hasn't ticked in ${minsSince ?? '4+'} min — automated steps may be paused.`
              : 'Dispatcher appears down — automated steps are paused.'}
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
